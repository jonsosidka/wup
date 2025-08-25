## WUP Draft Assist

A Streamlit app to assist a 14-team fantasy draft using your CSV projections. It tracks picks (yours and others), and recommends optimal picks factoring positional scarcity (VOR) and your current roster needs for the weekly lineup: QB, RB, RB, WR, WR, TE, FLEX (RB/WR/TE), DEF, K, plus 7 bench spots.

### Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Run

```bash
streamlit run app.py
```

### Data
Place CSVs under `data/`: `QB.csv`, `RB.csv`, `WR.csv`, `TE.csv`, `K.csv`, `DST.csv`.

### Notes
- Recommendations blend Value Over Replacement (by position and flex pool) with your roster fill status.
- You can mark players as Taken (x) or My Pick (check), with undo.
