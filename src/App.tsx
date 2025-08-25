import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { DEFAULT_ROSTER, LEAGUE_SIZE } from "./lib/constants";
import { loadAllPlayers } from "./lib/data";
import { addVOR, applyTaken, computeReplacementRanks, recommend } from "./lib/logic";
import type { DraftState, Player, PlayerWithCalcs, RecommendationsWeights, RosterConfig } from "./lib/types";

function App() {
  const [leagueSize, setLeagueSize] = useState<number>(LEAGUE_SIZE);
  const [benchSlots, setBenchSlots] = useState<number>(DEFAULT_ROSTER.bench);
  const [allPlayers, setAllPlayers] = useState<Player[]>([]);
  const [search, setSearch] = useState<string>("");
  const [showPos, setShowPos] = useState<string[]>(["ALL"]);
  const [taken, setTaken] = useState<Record<string, "mine" | "gone">>({});
  const [myRoster, setMyRoster] = useState<Record<string, number>>({ QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BENCH: 0 });
  const [myRosterNames, setMyRosterNames] = useState<Record<string, string[]>>({ QB: [], RB: [], WR: [], TE: [], FLEX: [], DST: [], K: [], BENCH: [] });
  const [weights, setWeights] = useState<RecommendationsWeights>({ w_delta: 0.6, w_vor: 0.3, w_scarcity: 0.1, bench_depth_boost: 0.15 });

  useEffect(() => {
    loadAllPlayers().then(setAllPlayers).catch((e) => console.error(e));
  }, []);

  const roster: RosterConfig = useMemo(() => ({ slots: { ...DEFAULT_ROSTER.slots }, bench: benchSlots }), [benchSlots]);
  const replacementRank = useMemo(() => computeReplacementRanks(roster, leagueSize), [roster, leagueSize]);
  const playersVor: PlayerWithCalcs[] = useMemo(() => addVOR(allPlayers, replacementRank, leagueSize, roster), [allPlayers, replacementRank, leagueSize, roster]);

  const playersAvailable: PlayerWithCalcs[] = useMemo(() => {
    let arr = applyTaken(playersVor, taken);
    if (!(showPos.includes("ALL"))) arr = arr.filter((p) => showPos.includes(p.position));
    if (search.trim()) {
      const s = search.toLowerCase();
      arr = arr.filter((p) => p.player.toLowerCase().includes(s) || (p.team ?? "").toLowerCase().includes(s));
    }
    return arr;
  }, [playersVor, taken, showPos, search]);

  const myNames: string[] = useMemo(() => Array.from(new Set(Object.values(myRosterNames).flat())), [myRosterNames]);
  const myTeam: Player[] = useMemo(() => allPlayers.filter((p) => myNames.includes(p.player)), [allPlayers, myNames]);
  const takenCount = useMemo(() => Object.keys(taken).length, [taken]);
  const ranked = useMemo(() => recommend(playersAvailable, roster, myTeam, takenCount, leagueSize, weights), [playersAvailable, roster, myTeam, takenCount, leagueSize, weights]);

  function onTake(playerName: string, mine: boolean) {
    setTaken((prev) => ({ ...prev, [playerName]: mine ? "mine" : "gone" }));
    if (!mine) return;
    const row = allPlayers.find((p) => p.player === playerName);
    if (!row) return;
    const pos = row.position;
    const canStartPos = (myRoster[pos] ?? 0) < (roster.slots[pos] ?? 0);
    const canFlex = ["RB", "WR", "TE"].includes(pos) && (myRoster.FLEX ?? 0) < (roster.slots.FLEX ?? 0);

    setMyRoster((prev) => {
      const next = { ...prev };
      if (canStartPos) next[pos] = (next[pos] ?? 0) + 1;
      else if (canFlex) next.FLEX = (next.FLEX ?? 0) + 1;
      else next.BENCH = (next.BENCH ?? 0) + 1;
      return next;
    });

    setMyRosterNames((prev) => {
      const next = { ...prev, QB: [...prev.QB], RB: [...prev.RB], WR: [...prev.WR], TE: [...prev.TE], FLEX: [...prev.FLEX], DST: [...prev.DST], K: [...prev.K], BENCH: [...prev.BENCH] };
      if (canStartPos) next[pos].push(playerName);
      else if (canFlex) next.FLEX.push(playerName);
      else next.BENCH.push(playerName);
      return next;
    });
  }

  function undoLastPick() {
    const keys = Object.keys(taken);
    if (keys.length === 0) return;
    const last = keys[keys.length - 1];
    const kind = taken[last];
    const next = { ...taken };
    delete next[last];
    setTaken(next);
    if (kind === "mine") {
      const row = allPlayers.find((p) => p.player === last);
      if (!row) return;
      const pos = row.position;
      const wasInPos = (myRosterNames[pos] ?? []).includes(last);
      const wasInFlex = (myRosterNames.FLEX ?? []).includes(last);
      const wasInBench = (myRosterNames.BENCH ?? []).includes(last);

      setMyRosterNames((prev) => {
        const nextNames = { ...prev, QB: [...prev.QB], RB: [...prev.RB], WR: [...prev.WR], TE: [...prev.TE], FLEX: [...prev.FLEX], DST: [...prev.DST], K: [...prev.K], BENCH: [...prev.BENCH] };
        const removeFrom = (list: string[]) => {
          const idx = list.indexOf(last);
          if (idx >= 0) list.splice(idx, 1);
        };
        if (wasInPos) removeFrom(nextNames[pos]);
        else if (wasInFlex) removeFrom(nextNames.FLEX);
        else if (wasInBench) removeFrom(nextNames.BENCH);
        else removeFrom(nextNames[pos]);
        return nextNames;
      });

      setMyRoster((prev) => {
        const nextCounts = { ...prev };
        if (wasInPos) nextCounts[pos] = Math.max(0, (nextCounts[pos] ?? 0) - 1);
        else if (wasInFlex) nextCounts.FLEX = Math.max(0, (nextCounts.FLEX ?? 0) - 1);
        else if (wasInBench) nextCounts.BENCH = Math.max(0, (nextCounts.BENCH ?? 0) - 1);
        else nextCounts[pos] = Math.max(0, (nextCounts[pos] ?? 0) - 1);
        return nextCounts;
      });
    }
  }

  function downloadState() {
    const state: DraftState = { taken, my_roster: myRoster, my_roster_names: myRosterNames };
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft_state.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadStateFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result ?? "{}"));
        if (obj && typeof obj === "object") {
          setTaken({ ...(obj.taken ?? {}) });
          if (obj.my_roster && typeof obj.my_roster === "object") setMyRoster({ ...obj.my_roster });
          if (obj.my_roster_names && typeof obj.my_roster_names === "object") setMyRosterNames({ ...obj.my_roster_names });
        }
      } catch (e) {
        console.error(e);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="container">
      <header className="header">
        <h1>WUP Draft Assist</h1>
      </header>
      <div className="controls">
        <div className="row">
          <label>
            League size
            <input type="number" value={leagueSize} min={8} max={20} onChange={(e) => setLeagueSize(Number(e.target.value))} />
          </label>
          <label>
            Bench spots
            <input type="number" value={benchSlots} min={0} max={15} onChange={(e) => setBenchSlots(Number(e.target.value))} />
          </label>
          <label>
            Positions
            <select multiple value={showPos} onChange={(e) => setShowPos(Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {["ALL", "QB", "RB", "WR", "TE", "K", "DST"].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Search player/team
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type to filter..." />
          </label>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <h3>My Roster</h3>
          {["QB","RB","WR","TE","FLEX","DST","K"].map((pos) => (
            <div key={pos}>
              <strong>{pos}:</strong> {myRoster[pos] ?? 0}/{(roster.slots as any)[pos] ?? 0} — {(myRosterNames[pos] ?? []).join(", ") || "—"}
            </div>
          ))}
          <div><strong>BENCH:</strong> {myRoster.BENCH ?? 0}/{benchSlots} — {(myRosterNames.BENCH ?? []).join(", ") || "—"}</div>

          <hr />
          <h4>Weights</h4>
          <label>
            ΔTeam weight {weights.w_delta.toFixed(2)}
            <input type="range" min={0} max={1} step={0.05} value={weights.w_delta} onChange={(e) => setWeights({ ...weights, w_delta: Number(e.target.value) })} />
          </label>
          <label>
            VOR weight {weights.w_vor.toFixed(2)}
            <input type="range" min={0} max={1} step={0.05} value={weights.w_vor} onChange={(e) => setWeights({ ...weights, w_vor: Number(e.target.value) })} />
          </label>
          <label>
            Scarcity weight {weights.w_scarcity.toFixed(2)}
            <input type="range" min={0} max={1} step={0.05} value={weights.w_scarcity} onChange={(e) => setWeights({ ...weights, w_scarcity: Number(e.target.value) })} />
          </label>
          <label>
            Bench depth boost {weights.bench_depth_boost.toFixed(2)}
            <input type="range" min={0} max={0.5} step={0.01} value={weights.bench_depth_boost} onChange={(e) => setWeights({ ...weights, bench_depth_boost: Number(e.target.value) })} />
          </label>
          <button onClick={undoLastPick}>Undo last pick</button>

          <hr />
          <h4>Save/Load Draft State</h4>
          <button onClick={downloadState}>Download state.json</button>
          <input type="file" accept="application/json" onChange={(e) => e.target.files && e.target.files[0] && loadStateFromFile(e.target.files[0])} />
        </aside>

        <main className="main">
          <h2>Recommendations</h2>
          <div className="table">
            <div className="row header">
              <div className="cell wide">Player (Pos)</div>
              <div className="cell">Proj</div>
              <div className="cell">VOR</div>
              <div className="cell">ΔTeam</div>
              <div className="cell">My Pick</div>
              <div className="cell">Taken</div>
              <div className="cell">Team</div>
            </div>
            {ranked.slice(0, 60).map((r, i) => (
              <div key={`${r.player}-${i}`} className="row">
                <div className="cell wide">{r.player} ({r.position})</div>
                <div className="cell">{(r.proj_pts ?? 0).toFixed(1)}</div>
                <div className="cell">{(r.VOR ?? 0).toFixed(1)}</div>
                <div className="cell">{(r.delta ?? 0).toFixed(1)}</div>
                <div className="cell"><button onClick={() => onTake(r.player, true)}>✓</button></div>
                <div className="cell"><button onClick={() => onTake(r.player, false)}>x</button></div>
                <div className="cell">{r.team ?? ""}</div>
              </div>
            ))}
          </div>
          <p className="caption">Score = ΔTeam*wΔ + VOR*wV + Scarcity*wS, then weighted by draft-phase and bench depth. Tune sliders in the sidebar.</p>
        </main>
      </div>
    </div>
  );
}

export default App
