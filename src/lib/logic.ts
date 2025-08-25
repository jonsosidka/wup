import { BENCH_SHARE } from "./constants";
import type {
	Player,
	PlayerWithCalcs,
	RosterConfig,
	RecommendationsWeights,
} from "./types";

export function computeReplacementRanks(
	roster: RosterConfig,
	leagueSize: number
): Record<string, number> {
	const replacement: Record<string, number> = {};
	for (const [pos, slots] of Object.entries(roster.slots)) {
		const starters = leagueSize * slots;
		const benchExtra = Math.round(leagueSize * (BENCH_SHARE[pos] ?? 0.3));
		replacement[pos] = Math.max(1, starters + benchExtra);
	}
	return replacement;
}

export function addVOR(
	players: Player[],
	replacementRank: Record<string, number>,
	leagueSize: number,
	roster: RosterConfig
): PlayerWithCalcs[] {
	const list = players.map((p) => ({ ...p })) as PlayerWithCalcs[];
	const byPos: Record<string, PlayerWithCalcs[]> = {};
	for (const p of list) {
		(byPos[p.position] ??= []).push(p);
	}
	for (const pos of Object.keys(byPos)) {
		byPos[pos].sort((a, b) => b.proj_pts - a.proj_pts);
		const rank = replacementRank[pos] ?? 1;
		const baseline = byPos[pos][Math.min(byPos[pos].length - 1, Math.max(0, rank - 1))]?.proj_pts ?? 0;
		for (const p of byPos[pos]) p.baseline = baseline;
	}
	for (const p of list) {
		p.VOR = (p.proj_pts ?? 0) - (p.baseline ?? 0);
	}
	// FLEX VOR for RB/WR/TE
	const flexPool = list.filter((p) => ["RB", "WR", "TE"].includes(p.position)).sort((a, b) => b.proj_pts - a.proj_pts);
	const flexRank = leagueSize * (roster.slots["FLEX"] ?? 1) + Math.round(leagueSize * 0.8);
	const flexBaseline = flexPool[Math.min(flexPool.length - 1, Math.max(0, flexRank - 1))]?.proj_pts ?? 0;
	for (const p of list) {
		if (["RB", "WR", "TE"].includes(p.position)) {
			p.VOR_FLEX = (p.proj_pts ?? 0) - flexBaseline;
		}
	}
	return list;
}

export function applyTaken(players: PlayerWithCalcs[], taken: Record<string, string>): PlayerWithCalcs[] {
	if (!taken || Object.keys(taken).length === 0) return players;
	const takenSet = new Set(Object.keys(taken));
	return players.filter((p) => !takenSet.has(p.player));
}

export function computeLineupTotal(teamPlayers: Player[], roster: RosterConfig): number {
	if (!teamPlayers.length) return 0;
	const df = [...teamPlayers].sort((a, b) => b.proj_pts - a.proj_pts);
	const selectedIdx = new Set<number>();
	const pick = (pos: string, count: number): number[] => {
		const idxs: number[] = [];
		for (let i = 0; i < df.length && idxs.length < count; i++) {
			if (selectedIdx.has(i)) continue;
			if (df[i].position === pos) idxs.push(i);
		}
		return idxs;
	};
	const chosen: number[] = [];
	for (const pos of ["QB", "TE", "DST", "K"]) {
		const count = roster.slots[pos] ?? 0;
		const idxs = pick(pos, count);
		chosen.push(...idxs);
		idxs.forEach((i) => selectedIdx.add(i));
	}
	const rb = pick("RB", roster.slots["RB"] ?? 0);
	const wr = pick("WR", roster.slots["WR"] ?? 0);
	chosen.push(...rb, ...wr);
	rb.concat(wr).forEach((i) => selectedIdx.add(i));
	const flexCount = roster.slots["FLEX"] ?? 0;
	if (flexCount > 0) {
		for (let i = 0; i < df.length && (chosen.length - rb.length - wr.length) < flexCount; i++) {
			if (selectedIdx.has(i)) continue;
			if (["RB", "WR", "TE"].includes(df[i].position)) {
				chosen.push(i);
				selectedIdx.add(i);
			}
		}
	}
	return chosen.length ? chosen.reduce((sum, i) => sum + (df[i].proj_pts ?? 0), 0) : 0;
}

export function recommend(
	players: PlayerWithCalcs[],
	roster: RosterConfig,
	myTeam: Player[],
	takenCount: number,
	leagueSize: number,
	weights: RecommendationsWeights
): PlayerWithCalcs[] {
	const list = players.map((p) => ({ ...p })) as PlayerWithCalcs[];
	const baselineTotal = computeLineupTotal(myTeam, roster);
	const totalPicks = leagueSize * (Object.values(roster.slots).reduce((a, b) => a + b, 0) + roster.bench);
	const progress = Math.min(1, Math.max(0, totalPicks ? takenCount / totalPicks : 0));
	const posWeight = (pos: string, wouldStart: boolean): number => {
		// Stronger early de-prioritization for onesie positions
		if (pos === "QB") return progress < 0.5 ? 0.5 : progress < 0.75 ? 0.75 : 1.0;
		if (pos === "DST") return progress < 0.9 ? 0.2 : progress < 0.98 ? 0.6 : 1.0;
		if (pos === "K") return progress < 0.95 ? 0.15 : progress < 0.99 ? 0.5 : 1.0;
		return wouldStart ? 1.08 : 1.0;
	};
	const benchMultiplier = (pos: string, wouldStart: boolean): number => {
		if (wouldStart) return 1.0;
		if (["RB", "WR", "TE"].includes(pos)) return 1.0 + (weights.bench_depth_boost ?? 0);
		// Stronger penalty for non-starting onesie positions early
		if (pos === "QB") return progress < 0.7 ? 0.5 : 0.7;
		if (pos === "DST") return progress < 0.9 ? 0.3 : 0.6;
		if (pos === "K") return progress < 0.95 ? 0.2 : 0.5;
		return 0.9;
	};
	// Precompute position sorted lists for scarcity
	const byPos: Record<string, PlayerWithCalcs[]> = {};
	for (const p of list) (byPos[p.position] ??= []).push(p);
	for (const pos of Object.keys(byPos)) byPos[pos].sort((a, b) => b.proj_pts - a.proj_pts);
	const scarcity = (p: PlayerWithCalcs): number => {
		const arr = byPos[p.position] ?? [];
		const idx = arr.findIndex((x) => x.player === p.player);
		if (idx < 0) return 0;
		const nextPool = arr.slice(idx + 1, idx + 4);
		if (nextPool.length === 0) return 0;
		const avgNext = nextPool.reduce((s, x) => s + (x.proj_pts ?? 0), 0) / nextPool.length;
		const drop = (p.proj_pts ?? 0) - avgNext;
		return Math.max(0, drop);
	};
	const candidateDelta = (p: PlayerWithCalcs): number => {
		const candTeam = [...myTeam, p as Player];
		const newTotal = computeLineupTotal(candTeam, roster);
		return newTotal - baselineTotal;
	};
	for (const p of list) {
		p.delta = candidateDelta(p);
		p.would_start = (p.delta ?? 0) > 0.05;
		p.scarcity = scarcity(p);
		const vorComponent = ["RB", "WR", "TE"].includes(p.position) ? (p.VOR_FLEX ?? p.VOR ?? 0) : (p.VOR ?? 0);
		p.pos_w = posWeight(p.position, !!p.would_start);
		p.bench_w = benchMultiplier(p.position, !!p.would_start);
		p.score_base = (weights.w_delta ?? 0.6) * (p.delta ?? 0) + (weights.w_vor ?? 0.3) * vorComponent + (weights.w_scarcity ?? 0.1) * (p.scarcity ?? 0);
		p.score = (p.score_base ?? 0) * (p.pos_w ?? 1) * (p.bench_w ?? 1);
	}
	return list.sort((a, b) =>
		b.score !== a.score
			? (b.score ?? 0) - (a.score ?? 0)
			: (b.score_base ?? 0) - (a.score_base ?? 0)
	);
}


