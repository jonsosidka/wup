export type Position = "QB" | "RB" | "WR" | "TE" | "DST" | "K";

export interface Player {
	player: string;
	team?: string;
	position: Position;
	proj_pts: number;
	pos_rank: number;
	overall_rank: number;
}

export interface PlayerWithCalcs extends Player {
	baseline?: number;
	VOR?: number;
	VOR_FLEX?: number;
	delta?: number;
	would_start?: boolean;
	scarcity?: number;
	pos_w?: number;
	bench_w?: number;
	score_base?: number;
	score?: number;
}

export interface RosterConfig {
	slots: Record<string, number>; // includes FLEX
	bench: number;
}

export interface DraftState {
	taken: Record<string, "mine" | "gone">;
	my_roster: Record<string, number>;
	my_roster_names: Record<string, string[]>;
}

export interface RecommendationsWeights {
	w_delta: number;
	w_vor: number;
	w_scarcity: number;
	bench_depth_boost: number;
}


