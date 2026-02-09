# MBTI Fighters (v1.3)

Current focus: MBTI-driven AI duels with hobby abilities, optional online player-vs-player rooms/matchmaking, and a developer sandbox mode.

## Run locally

From this folder:

```sh
npm run dev
```

Then open `http://localhost:5173` in your browser (or `http://<your-lan-ip>:5173` from phones on the same network). This uses `dev-server.js`, which now provides:

- Static serving
- Terminal debug log sink (`POST /_debug_log`)
- In-memory room/matchmaker APIs used by player mode

Static-only fallback (no multiplayer API):

```sh
python3 -m http.server 5173
```

If you use a static-only host, room creation/join will fail with `405` unless you point the game to an API backend.

## Cloudflare Worker backend (free tier)

This repo includes a Worker + Durable Object backend at `cloudflare/worker.mjs`.

1. Install and log in:

```sh
npm i -g wrangler
wrangler login
```

2. Deploy the API:

```sh
npm run cf:deploy
```

3. Note the worker URL (example: `https://mbti-fighters-api.<account>.workers.dev`).
4. Open your frontend using that API:
   - `https://your-frontend-url/?api=https://mbti-fighters-api.<account>.workers.dev`
5. For invite links to point to your frontend domain, set `APP_ORIGIN` in `cloudflare/wrangler.toml` before deploy.

## Modes

- Default: **Player mode** (mobile-friendly)
  - First screen: choose name, MBTI, hobby (plus placeholder look), then Save (locked for that session)
  - Then: room hub with create/join/matchmaker options
  - Create Room / Matchmaker both open a room-style waiting menu with copy-link inside
  - Rooms autostart when second player joins
  - Host can start early vs random AI before a second player joins
- Press `0`: toggle to **Developer mode** (the original sandbox controls)

The selected API base is remembered in `localStorage` (`mbti_api_base`) after opening with `?api=...`.

## Developer Controls

- Tap: command AI A (6s cadence)
- Shift + Click: place/move the juggernaut
- `D`: toggle debug overlay
- `H`: cast AI A hobby ability (player input)
- `A` + `H`: cycle AI A hobby
- `B` + `H`: cycle AI B hobby
- `Shift` + `A` / `Shift` + `B`: cycle MBTI for A/B
- `L`: toggle terminal debug logging
