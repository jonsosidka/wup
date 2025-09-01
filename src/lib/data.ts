import Papa from "papaparse";
import { DATA_DIR, POSITION_FILES } from "./constants";
import type { Player, Position } from "./types";

async function fetchCsv(path: string): Promise<string> {
	const res = await fetch(path, { cache: "no-store" });
	if (!res.ok) throw new Error(`Failed to fetch ${path}`);
	return await res.text();
}

export async function loadPosition(position: Position): Promise<Player[]> {
	const file = POSITION_FILES[position];
	const text = await fetchCsv(`${DATA_DIR}/${file}`);
	const parsed = Papa.parse(text, { header: true, dynamicTyping: true });
	const rows = Array.isArray(parsed.data) ? (parsed.data as any[]) : [];
	return rows
		.map((row) => {
			const player: Player = {
				player: String(row.player ?? ""),
				team: row.team ? String(row.team) : undefined,
				position,
				proj_pts:
					row.fantasy !== undefined
						? Number(row.fantasy)
						: row.proj_pts !== undefined
						? Number(row.proj_pts)
						: NaN,
				pos_rank:
					row.positionRank !== undefined
						? Number(row.positionRank)
						: row.pos_rank !== undefined
						? Number(row.pos_rank)
						: NaN,
				overall_rank:
					row.overallRank !== undefined
						? Number(row.overallRank)
						: row.overall_rank !== undefined
						? Number(row.overall_rank)
						: NaN,
			};
			return player;
		})
		.filter((p) => p.player && Number.isFinite(p.proj_pts));
}

export async function loadAllPlayers(): Promise<Player[]> {
	const positions: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
	const lists = await Promise.all(positions.map((p) => loadPosition(p)));
	const players = lists.flat();
	// Deduplicate by player+position using max proj
	const key = (p: Player) => `${p.player}|${p.position}`;
	const map = new Map<string, Player>();
	for (const p of players) {
		const k = key(p);
		const cur = map.get(k);
		if (!cur || p.proj_pts > cur.proj_pts) map.set(k, p);
	}
	const deduped = Array.from(map.values());
	// Attempt to load ages from AGES.csv or ages.csv
	try {
		const agesText = await fetchCsv(`${DATA_DIR}/AGES.csv`).catch(() => fetchCsv(`${DATA_DIR}/ages.csv`));
		const parsed = Papa.parse(agesText, { header: true, dynamicTyping: true });
		const rows = Array.isArray(parsed.data) ? (parsed.data as any[]) : [];
		const norm = (s: any) => String(s ?? "").trim();
		const toAge = (v: any) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : undefined;
		};
		// Build name->age map with flexible headers
		const nameKeys = ["player", "PLAYER", "PLAYER NAME", "PLAYER NAME", "name", "Name", "PLAYER NAME"]; // include variants
		const ageKeys = ["age", "AGE"];
		const nameHeader = Object.keys(rows[0] ?? {}).find((k) => nameKeys.includes(String(k))) ?? "player";
		const ageHeader = Object.keys(rows[0] ?? {}).find((k) => ageKeys.includes(String(k))) ?? "age";
		const ageMap = new Map<string, number>();
		for (const r of rows) {
			const nm = norm(r[nameHeader]);
			const age = toAge(r[ageHeader]);
			if (!nm || age === undefined) continue;
			ageMap.set(nm, age);
		}
		for (const p of deduped) {
			const age = ageMap.get(p.player) ?? ageMap.get(p.player.replace(/\s+Sr\.|\s+Jr\.|\s+III|\s+II/g, "").trim());
			if (age !== undefined) (p as any).age = age;
		}
	} catch (e) {
		// ignore ages if not present
	}
	return deduped;
}


