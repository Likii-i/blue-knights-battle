# MBTI Fighters (v1.3)

Current focus: two ENFP-ish agents + a deadly juggernaut. Decisions are driven by predicted/learned damage (not a rigid "juggernaut scary" rule), with bluffing via hidden opponent HP estimates.

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
