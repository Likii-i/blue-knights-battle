# MBTI Fighters (v1.3)

Current focus: two MBTI-driven agents + a deadly juggernaut. Decisions are driven by predicted/learned damage (not a rigid "juggernaut scary" rule), with bluffing via hidden opponent HP estimates and per-type adaptive biasing.

## Run locally

From this folder:

```sh
npm run dev
```

Then open `http://127.0.0.1:5173` in your browser. This uses `dev-server.js`, which also prints terminal debug logs from the sim.

Fallback (no terminal logs):

```sh
python3 -m http.server 5173
```

## Controls

- Shift + Click: place/move the juggernaut
- `D`: toggle debug overlay
- `H`: toggle help overlay
- `L`: toggle terminal debug logging
- `A`: cycle AI A MBTI
- `B`: cycle AI B MBTI

## Headless checks

- Baseline check:
  - `npm run sim:check`
- Trace one matchup:
  - `npm run sim:trace -- --a=ENFP --b=INTJ`
- Run a full MBTI matrix sweep (prints weak pairs for tuning):
  - `npm run sim:check -- --matrix --frames=1800 --seeds=11,29`
