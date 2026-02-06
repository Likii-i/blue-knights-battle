/* eslint-disable no-console */
// Minimal static server + terminal debug log sink for the browser sim.
// Run: `node dev-server.js` then open http://localhost:5173

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 5173);
const HOST = String(process.env.HOST || "127.0.0.1");
const ROOT = process.cwd();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function safeJoin(root, urlPath) {
  const raw = decodeURIComponent(urlPath);
  const clean = path.normalize(raw).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(root, clean);
  if (!full.startsWith(root)) return null;
  return full;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function fmtP(x) {
  return `${Math.round(x)}`.padStart(4, " ");
}

function fmtF(n, w = 5, d = 2) {
  return (Number.isFinite(n) ? n : 0).toFixed(d).padStart(w, " ");
}

function handleLog(payload) {
  // Expect a small structured payload from the client.
  const t = payload.t ?? 0;
  const intervalMs = payload.intervalMs ?? 0;

  const j = payload.juggernaut ?? {};
  const js = `J mode=${j.mode ?? "?"} tgt=${j.targetId ?? "?"} cd=${fmtF(j.cdLeft, 4, 1)}s pos=(${fmtP(j.x ?? 0)},${fmtP(j.y ?? 0)})`;

  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const as = agents
    .map((a) => {
      const thought = (a.thought ?? "").replace(/\s+/g, " ").slice(0, 60);
      return `${a.id ?? "?"} hp=${String(Math.round(a.hp ?? 0)).padStart(3, " ")} pos=(${fmtP(a.x ?? 0)},${fmtP(a.y ?? 0)}) ` +
        `stam=${String(Math.round(a.stamina ?? 0)).padStart(3, " ")} ` +
        `mode=${a.mode ?? "?"}/${a.posture ?? "?"} commit=${fmtF(a.commitLeft, 4, 1)}s ` +
        `dJ=${fmtF(a.dJ, 5, 0)} dO=${fmtF(a.dO, 5, 0)} ` +
        `pred(selfJ=${fmtF(a.predSelfJ, 3, 0)} selfO=${fmtF(a.predSelfO, 3, 0)} opp=${fmtF(a.predOpp, 3, 0)} routeJ=${fmtF(a.routeRisk, 4, 2)}` +
        ` chase=${a.jugChasingMe ? "Y" : "n"} re=${a.reengageOk ? "Y" : "n"} wrap=${fmtF(a.wrapIntent, 4, 2)}) ` +
        `thought="${thought}"`;
    })
    .join(" | ");

  console.log(`[t=${fmtF(t, 6, 2)} @${intervalMs}ms] ${js} | ${as}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "POST" && url.pathname === "/_debug_log") {
      const body = await readBody(req);
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // ignore
      }

      if (payload) handleLog(payload);

      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Method not allowed");
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = safeJoin(ROOT, pathname);
    if (!full) {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return;
    }

    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Not found");
        return;
      }

      const ext = path.extname(full);
      res.statusCode = 200;
      res.setHeader("content-type", MIME[ext] || "application/octet-stream");
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(full).pipe(res);
    });
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Server error");
    console.error(err);
  }
});

function listenWithFallback(startPort, host) {
  const explicit = Boolean(process.env.PORT);
  let port = startPort;

  function attempt() {
    server.listen(port, host, () => {
      console.log(`Dev server running on http://${host}:${port}`);
      console.log("Terminal logging endpoint: POST /_debug_log");
    });
  }

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      if (explicit) {
        console.error(`Port ${port} is already in use. Set PORT=5174 (or another port).`);
        process.exitCode = 1;
        return;
      }
      if (port < startPort + 10) {
        port += 1;
        attempt();
        return;
      }
      console.error(`No free ports found in range ${startPort}-${startPort + 10}. Set PORT=5174 (or another port).`);
      process.exitCode = 1;
      return;
    }

    if (err && err.code === "EPERM") {
      console.error(
        `Permission denied binding to ${host}:${port}. Try PORT=5174, or check OS/network policies.`,
      );
      process.exitCode = 1;
      return;
    }

    console.error("Server error:", err);
    process.exitCode = 1;
  });

  attempt();
}

listenWithFallback(PORT, HOST);
