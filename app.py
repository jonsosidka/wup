import streamlit as st
import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import Dict, List
import json

DATA_DIR = "data"
LEAGUE_SIZE = 14

# Roster config
ROSTER_SLOTS = {
	"QB": 1,
	"RB": 2,
	"WR": 2,
	"TE": 1,
	"FLEX": 1,  # RB/WR/TE
	"DST": 1,
	"K": 1,
}
BENCH_SLOTS = 7

POSITION_FILES = {
	"QB": "QB.csv",
	"RB": "RB.csv",
	"WR": "WR.csv",
	"TE": "TE.csv",
	"K": "K.csv",
	"DST": "DST.csv",
}

@st.cache_data(show_spinner=False)
def load_position_df(position: str) -> pd.DataFrame:
	path = f"{DATA_DIR}/{POSITION_FILES[position]}"
	df = pd.read_csv(path)
	df = df.copy()
	df["position"] = position
	# Standardize available fantasy points column
	if "fantasy" in df.columns:
		df.rename(columns={"fantasy": "proj_pts"}, inplace=True)
	else:
		# Some tables may have different names, but per provided CSVs they use fantasy
		df["proj_pts"] = np.nan
	# Normalize player column name
	if "player" not in df.columns:
		raise ValueError(f"Expected 'player' column in {position} CSV")
	# Rank columns
	if "positionRank" in df.columns:
		df.rename(columns={"positionRank": "pos_rank"}, inplace=True)
	else:
		df["pos_rank"] = np.arange(1, len(df) + 1)
	if "overallRank" in df.columns:
		df.rename(columns={"overallRank": "overall_rank"}, inplace=True)
	else:
		df["overall_rank"] = np.arange(1, len(df) + 1)
	# Keep only relevant columns to keep memory small
	keep_cols = [
		"player","team","position","proj_pts","pos_rank","overall_rank"
	]
	for c in keep_cols:
		if c not in df.columns:
			df[c] = np.nan
	return df[keep_cols]

@st.cache_data(show_spinner=False)
def load_all_players() -> pd.DataFrame:
	frames: List[pd.DataFrame] = []
	for pos in POSITION_FILES.keys():
		frames.append(load_position_df(pos))
	players = pd.concat(frames, ignore_index=True)
	# Remove rows with missing names or projections
	players = players[players["player"].notna()].reset_index(drop=True)
	players["proj_pts"] = pd.to_numeric(players["proj_pts"], errors="coerce")
	players = players[players["proj_pts"].notna()].reset_index(drop=True)
	# Deduplicate by player+position (choose max proj)
	players = (
		players.sort_values(["player","position","proj_pts"], ascending=[True, True, False])
				.drop_duplicates(subset=["player","position"], keep="first")
				.reset_index(drop=True)
	)
	return players

# Replacement-level per position for VOR
# For starting slots across league: starters = teams * slots
# Replacement rank ~ starters + bench share; we use a heuristic bench share per position
BENCH_SHARE = {"QB": 0.3, "RB": 1.5, "WR": 1.5, "TE": 0.4, "DST": 0.2, "K": 0.2}

@dataclass
class Roster:
	slots: Dict[str, int]
	bench: int


def compute_replacement_ranks(roster: Roster, league_size: int) -> Dict[str, int]:
	replacement: Dict[str, int] = {}
	for pos, slots in roster.slots.items():
		starters = league_size * slots
		bench_extra = int(round(league_size * BENCH_SHARE.get(pos, 0.3)))
		replacement[pos] = max(1, starters + bench_extra)
	return replacement


def add_vor(players: pd.DataFrame, replacement_rank: Dict[str, int], league_size: int, roster: Roster) -> pd.DataFrame:
	players = players.copy()
	# Compute baseline per position as projected points of replacement-ranked player
	baselines: Dict[str, float] = {}
	for pos, rank in replacement_rank.items():
		pos_df = players[players["position"] == pos].sort_values("proj_pts", ascending=False)
		if len(pos_df) >= rank:
			baselines[pos] = pos_df.iloc[rank - 1]["proj_pts"]
		elif len(pos_df) > 0:
			baselines[pos] = pos_df.iloc[-1]["proj_pts"]
		else:
			baselines[pos] = 0.0
	players["baseline"] = players["position"].map(baselines)
	players["VOR"] = players["proj_pts"] - players["baseline"]
	# For FLEX eligibility pool (RB/WR/TE), compute VOR against FLEX baseline too
	flex_pool = players[players["position"].isin(["RB","WR","TE"])].copy()
	flex_rank = league_size * roster.slots.get("FLEX", 1) + int(round(league_size * 0.8))
	flex_pool = flex_pool.sort_values("proj_pts", ascending=False)
	flex_baseline = flex_pool.iloc[min(len(flex_pool) - 1, max(0, flex_rank - 1))]["proj_pts"] if len(flex_pool) else 0.0
	players["VOR_FLEX"] = np.where(
		players["position"].isin(["RB","WR","TE"]),
		players["proj_pts"] - flex_baseline,
		np.nan,
	)
	return players


def apply_taken(players: pd.DataFrame, taken: Dict[str, str]) -> pd.DataFrame:
	if not taken:
		return players
	mask = players["player"].isin(taken.keys())
	return players.loc[~mask].reset_index(drop=True)


def compute_lineup_total(team_players: pd.DataFrame, roster: Roster) -> float:
	if team_players.empty:
		return 0.0
	df = team_players.copy()
	df = df.sort_values("proj_pts", ascending=False).reset_index()
	selected_idx: set = set()
	def pick(pos: str, count: int) -> List[int]:
		cands = df[(df["position"] == pos) & (~df.index.isin(selected_idx))]
		return list(cands.head(count).index)
	# Pick fixed slots
	chosen: List[int] = []
	for pos, count in ( ("QB", roster.slots.get("QB",0)), ("TE", roster.slots.get("TE",0)), ("DST", roster.slots.get("DST",0)), ("K", roster.slots.get("K",0)) ):
		idxs = pick(pos, count)
		chosen.extend(idxs)
		selected_idx.update(idxs)
	# RBs and WRs starters
	rb_idxs = pick("RB", roster.slots.get("RB",0))
	wr_idxs = pick("WR", roster.slots.get("WR",0))
	chosen.extend(rb_idxs + wr_idxs)
	selected_idx.update(rb_idxs + wr_idxs)
	# FLEX from remaining RB/WR/TE
	flex_pool = df[(df["position"].isin(["RB","WR","TE"])) & (~df.index.isin(selected_idx))]
	flex_count = roster.slots.get("FLEX", 0)
	if flex_count > 0 and not flex_pool.empty:
		flex_idxs = list(flex_pool.head(flex_count).index)
		chosen.extend(flex_idxs)
		selected_idx.update(flex_idxs)
	return float(df.loc[chosen, "proj_pts"].sum()) if chosen else 0.0


def recommend(players: pd.DataFrame, my_roster_counts: Dict[str, int], roster: Roster, my_team_df: pd.DataFrame, taken_count: int, league_size: int, w_delta: float, w_vor: float, w_scarcity: float, bench_depth_boost: float) -> pd.DataFrame:
	"""Rank players with optimizations for in-browser performance.

	- Vectorize scarcity across positions.
	- Compute delta/would_start only for a top-K candidate subset.
	"""
	players = players.copy()
	baseline_total = compute_lineup_total(my_team_df, roster)
	# Draft progress 0..1 based on approximate total picks
	total_picks = league_size * (sum(roster.slots.values()) + roster.bench)
	progress = min(1.0, max(0.0, taken_count / max(1, total_picks)))

	# VOR component first (cheap)
	vor_component = np.where(
		players["position"].isin(["RB","WR","TE"]),
		players["VOR_FLEX"].fillna(players["VOR"]).fillna(0.0),
		players["VOR"].fillna(0.0),
	)

	# Vectorized scarcity: drop to average of next 3 within each position
	players = players.sort_values(["position", "proj_pts"], ascending=[True, False]).reset_index(drop=True)
	lead1 = players.groupby("position")["proj_pts"].shift(-1)
	lead2 = players.groupby("position")["proj_pts"].shift(-2)
	lead3 = players.groupby("position")["proj_pts"].shift(-3)
	avg_next = pd.concat([lead1, lead2, lead3], axis=1).mean(axis=1, skipna=True)
	players["scarcity"] = np.maximum(0.0, players["proj_pts"] - avg_next.fillna(players["proj_pts"]))

	# Pre-score without delta to select candidate subset
	pre_score = (w_vor * vor_component) + (w_scarcity * players["scarcity"]) + (0.0 * players["proj_pts"])  # keep structure for clarity
	CANDIDATE_K = 120
	cand_idx = np.argsort(-pre_score.values)[:min(CANDIDATE_K, len(players))]
	cand_mask = np.zeros(len(players), dtype=bool)
	cand_mask[cand_idx] = True

	# Compute delta and would_start only for candidates
	players["delta"] = 0.0
	players["would_start"] = False
	if w_delta > 0.0 and np.any(cand_mask):
		cand_rows = players.loc[cand_mask]
		def candidate_delta(row: pd.Series) -> float:
			cand_df = pd.concat([my_team_df, row.to_frame().T], ignore_index=True)
			new_total = compute_lineup_total(cand_df, roster)
			return new_total - baseline_total
		cand_delta = cand_rows.apply(candidate_delta, axis=1)
		players.loc[cand_rows.index, "delta"] = cand_delta.values
		players.loc[cand_rows.index, "would_start"] = cand_delta.values > 0.05

	# Vectorized weights
	pos = players["position"].astype(str)
	qb_w = 0.8 if progress < 0.4 else (0.9 if progress < 0.7 else 1.0)
	dst_w = 0.3 if progress < 0.75 else (0.8 if progress < 0.9 else 1.0)
	k_w = 0.2 if progress < 0.85 else (0.6 if progress < 0.95 else 1.0)
	pos_w = np.where(pos == "QB", qb_w, 1.0)
	pos_w = np.where(pos == "DST", dst_w, pos_w)
	pos_w = np.where(pos == "K", k_w, pos_w)
	pos_w = pos_w * np.where(players["would_start"], 1.05, 1.0)
	players["pos_w"] = pos_w

	bench_w = np.where(
		players["would_start"],
		1.0,
		np.where(
			pos.isin(["RB", "WR", "TE"]),
			1.0 + bench_depth_boost,
			np.where(pos == "QB", 0.85, np.where(pos == "DST", 0.7, np.where(pos == "K", 0.6, 0.9)))
		),
	)
	players["bench_w"] = bench_w

	players["score_base"] = w_delta * players["delta"] + w_vor * vor_component + w_scarcity * players["scarcity"]
	players["score"] = players["score_base"] * players["pos_w"] * players["bench_w"]
	return players.sort_values(["score", "score_base", "delta", "VOR", "proj_pts"], ascending=False)


def init_state():
	if "taken" not in st.session_state:
		st.session_state.taken = {}  # name -> "mine" or "gone"
	if "my_roster" not in st.session_state:
		st.session_state.my_roster = {pos: 0 for pos in ROSTER_SLOTS.keys()}
		st.session_state.my_roster["BENCH"] = 0
	if "my_roster_names" not in st.session_state:
		st.session_state.my_roster_names = {pos: [] for pos in ROSTER_SLOTS.keys()}
		st.session_state.my_roster_names["BENCH"] = []


# Build page
st.set_page_config(page_title="WUP Draft Assist", layout="wide")
init_state()

st.title("WUP Draft Assist")

# Load data
try:
	all_players = load_all_players()
except Exception as e:
	st.error(f"Failed to load CSVs from {DATA_DIR}: {e}")
	st.stop()

# Controls
col1, col2, col3, col4 = st.columns([2,1,1,1])
with col1:
	league_size = st.number_input("League size", value=LEAGUE_SIZE, min_value=8, max_value=20, step=1)
with col2:
	bench_slots = st.number_input("Bench spots", value=BENCH_SLOTS, min_value=0, max_value=15, step=1)
with col3:
	show_pos = st.multiselect("Positions", ["ALL"] + list(POSITION_FILES.keys()), default=["ALL"]) or ["ALL"]
with col4:
	search = st.text_input("Search player/team", key="search", placeholder="Type to filter...")

# Roster config (static per prompt)
roster = Roster(slots=ROSTER_SLOTS, bench=bench_slots)

# Compute VORs with current league config
replacement_rank = compute_replacement_ranks(roster, league_size)

# Add VOR and FLEX VOR
players_vor = add_vor(all_players, replacement_rank, league_size, roster)

# Filter out taken players
players_available = apply_taken(players_vor, st.session_state.taken)

# Filter UI
if "ALL" not in show_pos:
	players_available = players_available[players_available["position"].isin(show_pos)]
if search:
	s = search.lower()
	players_available = players_available[
		players_available["player"].str.lower().str.contains(s) |
		players_available["team"].fillna("").str.lower().str.contains(s)
	]

# Build my team df from picked names
my_names: List[str] = []
for key, lst in st.session_state.my_roster_names.items():
	if isinstance(lst, list):
		my_names.extend(lst)
my_names = list(dict.fromkeys(my_names))
my_team_df = all_players[all_players["player"].isin(my_names)].copy()

taken_count = len(st.session_state.taken)

# Sidebar: roster tracking, weights, and persistence
with st.sidebar:
	st.header("My Roster")
	for pos in ["QB","RB","WR","TE","FLEX","DST","K"]:
		have = st.session_state.my_roster.get(pos, 0)
		need = roster.slots.get(pos, 0)
		names = st.session_state.my_roster_names.get(pos, [])
		names_str = ", ".join(names) if names else "—"
		st.write(f"{pos}: {have}/{need} — {names_str}")
	bench_names = st.session_state.my_roster_names.get("BENCH", [])
	bench_names_str = ", ".join(bench_names) if bench_names else "—"
	st.write(f"BENCH: {st.session_state.my_roster.get('BENCH', 0)}/{bench_slots} — {bench_names_str}")

	st.divider()
	st.subheader("Weights")
	w_delta = st.slider("ΔTeam weight", 0.0, 1.0, 0.6, 0.05)
	w_vor = st.slider("VOR weight", 0.0, 1.0, 0.3, 0.05)
	w_scarcity = st.slider("Scarcity weight", 0.0, 1.0, 0.1, 0.05)
	bench_depth_boost = st.slider("Bench depth boost (RB/WR/TE)", 0.0, 0.5, 0.15, 0.01)

	if st.button("Undo last pick"):
		if st.session_state.taken:
			last = list(st.session_state.taken.keys())[-1]
			kind = st.session_state.taken.pop(last)
			if kind == "mine":
				# Deduct from roster counts and names using player position or lists
				row = all_players[all_players["player"] == last]
				if len(row):
					pos = row.iloc[0]["position"]
					# Try to remove from its list (pos -> FLEX -> BENCH)
					removed = False
					if last in st.session_state.my_roster_names.get(pos, []):
						st.session_state.my_roster_names[pos].remove(last)
						if st.session_state.my_roster.get(pos, 0) > 0:
							st.session_state.my_roster[pos] -= 1
						removed = True
					elif last in st.session_state.my_roster_names.get("FLEX", []):
						st.session_state.my_roster_names["FLEX"].remove(last)
						if st.session_state.my_roster.get("FLEX", 0) > 0:
							st.session_state.my_roster["FLEX"] -= 1
						removed = True
					elif last in st.session_state.my_roster_names.get("BENCH", []):
						st.session_state.my_roster_names["BENCH"].remove(last)
						if st.session_state.my_roster.get("BENCH", 0) > 0:
							st.session_state.my_roster["BENCH"] -= 1
						removed = True
					# If somehow not found, fall back to decrement position
					if not removed and st.session_state.my_roster.get(pos, 0) > 0:
						st.session_state.my_roster[pos] -= 1

	st.divider()
	st.subheader("Save/Load Draft State")
	state = {
		"taken": st.session_state.taken,
		"my_roster": st.session_state.my_roster,
		"my_roster_names": st.session_state.my_roster_names,
	}
	state_json = json.dumps(state)
	st.download_button("Download state.json", data=state_json, file_name="draft_state.json", mime="application/json")
	upload = st.file_uploader("Upload state.json", type=["json"])
	if upload is not None:
		try:
			loaded = json.load(upload)
			if isinstance(loaded, dict):
				st.session_state.taken = dict(loaded.get("taken", {}))
				mr = loaded.get("my_roster", {})
				if isinstance(mr, dict):
					st.session_state.my_roster = mr
				mrn = loaded.get("my_roster_names", {})
				if isinstance(mrn, dict):
					st.session_state.my_roster_names = mrn
				st.success("Draft state loaded.")
		except Exception as e:
			st.error(f"Failed to load state: {e}")

# Recommendations
ranked = recommend(players_available, st.session_state.my_roster, roster, my_team_df, taken_count, league_size, w_delta, w_vor, w_scarcity, bench_depth_boost)

# Display table with actions
st.subheader("Recommendations")

def on_take(player_name: str, mine: bool):
	st.session_state.taken[player_name] = "mine" if mine else "gone"
	if mine:
		row = all_players[all_players["player"] == player_name]
		if len(row):
			pos = row.iloc[0]["position"]
			# Place into starting slot if available else bench (FLEX handled by user later)
			if st.session_state.my_roster.get(pos, 0) < roster.slots.get(pos, 0):
				st.session_state.my_roster[pos] += 1
				st.session_state.my_roster_names[pos].append(player_name)
			elif pos in ("RB","WR","TE") and st.session_state.my_roster.get("FLEX", 0) < roster.slots.get("FLEX", 0):
				st.session_state.my_roster["FLEX"] += 1
				st.session_state.my_roster_names["FLEX"].append(player_name)
			else:
				st.session_state.my_roster["BENCH"] += 1
				st.session_state.my_roster_names["BENCH"].append(player_name)

# Show top N
TOP_N = 60
view = ranked.head(TOP_N).reset_index(drop=True)

# Build action columns
action_cols = st.columns([3,1,1,1,2,2,2])
action_cols[0].write("Player (Pos)")
action_cols[1].write("Proj")
action_cols[2].write("VOR")
action_cols[3].write("ΔTeam")
action_cols[4].write("My Pick")
action_cols[5].write("Taken")
action_cols[6].write("Team")

for i, row in view.iterrows():
	cols = st.columns([3,1,1,1,2,2,2])
	cols[0].write(f"{row['player']} ({row['position']})")
	cols[1].write(f"{row['proj_pts']:.1f}")
	cols[2].write(f"{row['VOR']:.1f}")
	cols[3].write(f"{row['delta']:.1f}")
	if cols[4].button("✓", key=f"mine_{i}"):
		on_take(row["player"], mine=True)
	if cols[5].button("x", key=f"gone_{i}"):
		on_take(row["player"], mine=False)
	cols[6].write(row.get("team", ""))

st.caption("Score = ΔTeam*wΔ + VOR*wV + Scarcity*wS, then weighted by draft-phase and bench depth. Tune sliders in the sidebar.")
