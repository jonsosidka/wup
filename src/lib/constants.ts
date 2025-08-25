import type { Position, RosterConfig } from "./types";

export const DATA_DIR = "/data"; // served from public
export const LEAGUE_SIZE = 14;

export const ROSTER_SLOTS: Record<string, number> = {
	QB: 1,
	RB: 2,
	WR: 2,
	TE: 1,
	FLEX: 1,
	DST: 1,
	K: 1,
};

export const BENCH_SLOTS = 7;

export const POSITION_FILES: Record<Position, string> = {
	QB: "QB.csv",
	RB: "RB.csv",
	WR: "WR.csv",
	TE: "TE.csv",
	K: "K.csv",
	DST: "DST.csv",
};

export const BENCH_SHARE: Record<string, number> = {
	QB: 0.3,
	RB: 1.5,
	WR: 1.5,
	TE: 0.4,
	DST: 0.2,
	K: 0.2,
};

export const DEFAULT_ROSTER: RosterConfig = {
	slots: ROSTER_SLOTS,
	bench: BENCH_SLOTS,
};


