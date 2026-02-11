/* eslint-disable no-console */
// Static server + debug log sink + lightweight in-memory room/matchmaking APIs.
// Run: `node dev-server.js` then open http://localhost:5173

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const HOST = String(process.env.HOST || "0.0.0.0");
const ROOT = process.cwd();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

const rooms = new Map(); // roomCode -> room
const sessions = new Map(); // token -> session
const matchQueue = []; // session tokens waiting for matchmaker
const debugRing = []; // recent sync/debug diagnostics
let nextDebugId = 1;
const MAX_DEBUG_RING = 6000;

function nowMs() {
  return Date.now();
}

function pushDebug(entry) {
  const record = {
    id: nextDebugId++,
    at: nowMs(),
    ...entry,
  };
  debugRing.push(record);
  while (debugRing.length > MAX_DEBUG_RING) debugRing.shift();
  return record;
}

function sanitizeName(name) {
  const raw = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "Player";
  return raw.slice(0, 22);
}

function sanitizeMbti(mbti) {
  return String(mbti ?? "ENFP").trim().toUpperCase().slice(0, 4) || "ENFP";
}

function sanitizeHobby(hobby) {
  return String(hobby ?? "SCIENCE_RESEARCH").trim().toUpperCase().slice(0, 40) || "SCIENCE_RESEARCH";
}

function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 64; attempt++) {
    let out = "";
    for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(out)) return out;
  }
  return randomToken(4).toUpperCase();
}

function profileFromBody(body) {
  return {
    name: sanitizeName(body?.name),
    mbti: sanitizeMbti(body?.mbti),
    hobby: sanitizeHobby(body?.hobby),
  };
}

function createSession(profile) {
  const token = randomToken(16);
  const ts = nowMs();
  const session = {
    token,
    name: profile.name,
    mbti: profile.mbti,
    hobby: profile.hobby,
    roomCode: null,
    seat: null,
    waitingMatch: false,
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(token, session);
  return session;
}

function getRoomForSession(session) {
  if (!session?.roomCode) return null;
  const room = rooms.get(session.roomCode) ?? null;
  if (!room) return null;
  if (!Array.isArray(room.events)) room.events = [];
  if (!Number.isFinite(Number(room.nextEventId))) room.nextEventId = 1;
  if (!room.actionDedupe || typeof room.actionDedupe !== "object") room.actionDedupe = {};
  if (!Array.isArray(room.actionDedupeOrder)) room.actionDedupeOrder = [];
  if (!Number.isFinite(Number(room.snapshotSeq))) room.snapshotSeq = 0;
  if (!("snapshot" in room)) room.snapshot = null;
  if (!Number.isFinite(Number(room.frameSeq))) room.frameSeq = 0;
  if (!Array.isArray(room.frames)) room.frames = [];
  if (!room.endState || typeof room.endState !== "object") {
    room.endState = { ended: false, winnerId: "", winnerName: "", message: "", at: 0 };
  }
  return room;
}

function createRoom() {
  const code = createRoomCode();
  const ts = nowMs();
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const room = {
    code,
    seed,
    createdAt: ts,
    updatedAt: ts,
    started: false,
    startAtMs: 0,
    mode: "pvp", // pvp | ai
    players: { A: null, B: null }, // { token, name, mbti, hobby }
    events: [], // { id, seat, type, payload, at }
    nextEventId: 1,
    actionDedupe: {},
    actionDedupeOrder: [],
    snapshot: null,
    snapshotSeq: 0,
    frameSeq: 0,
    frames: [], // { seq, tick, frame, at, seat, batchSeq }
    endState: {
      ended: false,
      winnerId: "",
      winnerName: "",
      message: "",
      at: 0,
    },
  };
  rooms.set(code, room);
  return room;
}

function attachSessionToRoom(session, room, seat) {
  room.players[seat] = {
    token: session.token,
    name: session.name,
    mbti: session.mbti,
    hobby: session.hobby,
  };
  room.updatedAt = nowMs();
  session.roomCode = room.code;
  session.seat = seat;
  session.waitingMatch = false;
  session.updatedAt = nowMs();
}

function publicPlayers(room) {
  return {
    A: room.players.A ? { name: room.players.A.name, mbti: room.players.A.mbti, hobby: room.players.A.hobby } : null,
    B: room.players.B ? { name: room.players.B.name, mbti: room.players.B.mbti, hobby: room.players.B.hobby } : null,
  };
}

function sessionState(session) {
  const room = getRoomForSession(session);
  if (!room) {
    return {
      inRoom: false,
      waitingMatch: Boolean(session.waitingMatch),
      seat: null,
      roomCode: null,
      started: false,
      startAtMs: null,
      mode: null,
      matchSeed: null,
      players: null,
      endState: null,
    };
  }
  return {
    inRoom: true,
    waitingMatch: false,
    seat: session.seat,
    roomCode: room.code,
    started: Boolean(room.started),
    startAtMs: Number.isFinite(Number(room.startAtMs)) ? Number(room.startAtMs) : null,
    mode: room.mode,
    matchSeed: room.seed >>> 0,
    players: publicPlayers(room),
    opponentJoined: Boolean(room.players.A && room.players.B),
    endState: room.endState ?? null,
  };
}

function clearInvalidQueueTokens() {
  for (let i = matchQueue.length - 1; i >= 0; i--) {
    const token = matchQueue[i];
    const s = sessions.get(token);
    if (!s || !s.waitingMatch || s.roomCode) matchQueue.splice(i, 1);
  }
}

function popMatchmakerCandidate(excludeToken) {
  clearInvalidQueueTokens();
  while (matchQueue.length) {
    const token = matchQueue.shift();
    if (token === excludeToken) continue;
    const s = sessions.get(token);
    if (!s || !s.waitingMatch || s.roomCode) continue;
    return s;
  }
  return null;
}

function sendJson(res, statusCode, payload) {
  const out = payload && typeof payload === "object" ? { ...payload } : payload;
  if (out && typeof out === "object" && !("serverNowMs" in out)) out.serverNowMs = nowMs();
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(out));
}

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

async function parseJsonBody(req, res) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return null;
  }
}

function getSessionFromToken(token) {
  if (!token) return null;
  return sessions.get(String(token)) ?? null;
}

function handleApiGet(req, res, url) {
  if (url.pathname === "/api/session") {
    const token = url.searchParams.get("token");
    const session = getSessionFromToken(token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    session.updatedAt = nowMs();
    return sendJson(res, 200, { ok: true, token: session.token, state: sessionState(session) });
  }

  if (url.pathname === "/api/room/actions") {
    const token = url.searchParams.get("token");
    const since = Number(url.searchParams.get("since") || 0);
    const session = getSessionFromToken(token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    const out = [];
    for (const ev of room.events) {
      if (ev.id <= since) continue;
      out.push(ev);
    }
    return sendJson(res, 200, { ok: true, events: out, lastId: room.nextEventId - 1 });
  }

  if (url.pathname === "/api/room/snapshot") {
    const token = url.searchParams.get("token");
    const since = Number(url.searchParams.get("since") || 0);
    const session = getSessionFromToken(token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    const payload = {
      ok: true,
      seq: room.snapshotSeq,
      started: room.started,
      startAtMs: room.startAtMs ?? 0,
      mode: room.mode,
      players: publicPlayers(room),
      endState: room.endState ?? null,
      snapshot: room.snapshotSeq > since ? room.snapshot : null,
    };
    return sendJson(res, 200, payload);
  }

  if (url.pathname === "/api/room/bundle") {
    const token = url.searchParams.get("token");
    const sinceAction = Number(url.searchParams.get("sinceAction") || 0);
    const sinceSnapshot = Number(url.searchParams.get("sinceSnapshot") || 0);
    const sinceFrame = Number(url.searchParams.get("sinceFrame") || 0);
    const session = getSessionFromToken(token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    const events = [];
    for (const ev of room.events) {
      if (ev.id <= sinceAction) continue;
      events.push(ev);
    }
    const frames = [];
    for (const rec of room.frames || []) {
      if ((rec?.seq ?? 0) <= sinceFrame) continue;
      frames.push({
        seq: rec.seq ?? 0,
        tick: rec.tick ?? 0,
        frame: rec.frame ?? null,
        at: rec.at ?? 0,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      events,
      lastId: room.nextEventId - 1,
      snapshotSeq: room.snapshotSeq,
      snapshot: room.snapshotSeq > sinceSnapshot ? room.snapshot : null,
      frameSeq: room.frameSeq ?? 0,
      frames,
      started: room.started,
      startAtMs: room.startAtMs ?? 0,
      mode: room.mode,
      players: publicPlayers(room),
      endState: room.endState ?? null,
    });
  }

  if (url.pathname === "/api/debug/log") {
    const token = url.searchParams.get("token");
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
    let roomCode = String(url.searchParams.get("roomCode") || "").trim().toUpperCase();
    if (!roomCode && token) {
      const session = getSessionFromToken(token);
      if (session?.roomCode) roomCode = session.roomCode;
    }
    const seatFilter = String(url.searchParams.get("seat") || "").trim().toUpperCase();
    const sourceFilter = String(url.searchParams.get("source") || "").trim().toLowerCase();
    const kindFilter = String(url.searchParams.get("kind") || "").trim().toLowerCase();
    let out = debugRing.filter((item) => item.id > since);
    if (roomCode) out = out.filter((item) => item.roomCode === roomCode);
    if (seatFilter === "A" || seatFilter === "B") out = out.filter((item) => item.seat === seatFilter);
    if (sourceFilter) out = out.filter((item) => String(item.source || "").toLowerCase() === sourceFilter);
    if (kindFilter) out = out.filter((item) => String(item.kind || "").toLowerCase() === kindFilter);
    if (out.length > limit) out = out.slice(-limit);
    return sendJson(res, 200, {
      ok: true,
      logs: out,
      lastId: nextDebugId - 1,
      roomCode: roomCode || null,
    });
  }

  return false;
}

async function handleApiPost(req, res, url) {
  if (url.pathname === "/_debug_log") {
    const payload = await parseJsonBody(req, res);
    if (!payload) return true;
    handleLog(payload);
    pushDebug({
      source: "legacy_terminal",
      kind: "terminal",
      roomCode: String(payload.roomCode || "").trim().toUpperCase() || null,
      seat: payload.seat === "B" ? "B" : payload.seat === "A" ? "A" : null,
      data: payload,
    });
    sendJson(res, 204, { ok: true });
    return true;
  }

  if (url.pathname === "/api/debug/log") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const token = body.token ? String(body.token) : "";
    const session = token ? getSessionFromToken(token) : null;
    const roomCode = session?.roomCode || String(body.roomCode || "").trim().toUpperCase() || null;
    const seat = session?.seat || (body.seat === "B" ? "B" : body.seat === "A" ? "A" : null);
    const source = String(body.source || "client");
    const kind = String(body.kind || "sync");
    const data = body.data && typeof body.data === "object" ? body.data : {};
    const rec = pushDebug({ roomCode, seat, source, kind, data });
    return sendJson(res, 200, { ok: true, id: rec.id });
  }

  if (url.pathname === "/api/room/create") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const profile = profileFromBody(body);
    const session = createSession(profile);
    const room = createRoom();
    attachSessionToRoom(session, room, "A");
    const hostHeader = req.headers.host ? String(req.headers.host) : `${HOST}:${PORT}`;
    const joinUrl = `http://${hostHeader}/?room=${encodeURIComponent(room.code)}`;
    return sendJson(res, 200, {
      ok: true,
      token: session.token,
      roomCode: room.code,
      seat: "A",
      joinUrl,
      state: sessionState(session),
    });
  }

  if (url.pathname === "/api/room/join") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const roomCode = String(body.roomCode ?? "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return sendJson(res, 404, { ok: false, error: "Room not found" });
    if (room.players.B) return sendJson(res, 409, { ok: false, error: "Room is full" });

    const profile = profileFromBody(body);
    const session = createSession(profile);
    attachSessionToRoom(session, room, "B");
    room.started = true;
    room.startAtMs = nowMs() + 2200;
    room.mode = "pvp";
    room.updatedAt = nowMs();
    return sendJson(res, 200, {
      ok: true,
      token: session.token,
      roomCode: room.code,
      seat: "B",
      state: sessionState(session),
    });
  }

  if (url.pathname === "/api/room/start-ai") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    if (session.seat !== "A") return sendJson(res, 403, { ok: false, error: "Only room host can start AI mode" });
    if (room.players.B) return sendJson(res, 409, { ok: false, error: "Cannot start AI mode after second player joined" });
    room.started = true;
    room.startAtMs = nowMs() + 350;
    room.mode = "ai";
    room.updatedAt = nowMs();
    return sendJson(res, 200, { ok: true, state: sessionState(session) });
  }

  if (url.pathname === "/api/matchmaker/join") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const profile = profileFromBody(body);
    const session = createSession(profile);
    session.waitingMatch = true;
    session.updatedAt = nowMs();

    const opponent = popMatchmakerCandidate(session.token);
    if (!opponent) {
      matchQueue.push(session.token);
      return sendJson(res, 200, { ok: true, token: session.token, waiting: true, state: sessionState(session) });
    }

    const room = createRoom();
    attachSessionToRoom(opponent, room, "A");
    attachSessionToRoom(session, room, "B");
    room.started = true;
    room.startAtMs = nowMs() + 2200;
    room.mode = "pvp";
    room.updatedAt = nowMs();
    return sendJson(res, 200, { ok: true, token: session.token, waiting: false, state: sessionState(session) });
  }

  if (url.pathname === "/api/matchmaker/cancel") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    session.waitingMatch = false;
    session.updatedAt = nowMs();
    clearInvalidQueueTokens();
    return sendJson(res, 200, { ok: true, state: sessionState(session) });
  }

  if (url.pathname === "/api/room/action") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    if (!room.started) return sendJson(res, 409, { ok: false, error: "Room has not started yet" });
    if (room.endState?.ended) return sendJson(res, 409, { ok: false, error: "Match already ended" });
    if (!room.actionDedupe || typeof room.actionDedupe !== "object") room.actionDedupe = {};
    if (!Array.isArray(room.actionDedupeOrder)) room.actionDedupeOrder = [];

    const payload = body.payload && typeof body.payload === "object" ? { ...body.payload } : {};
    if (Number.isFinite(Number(payload.targetTick))) payload.targetTick = Math.max(0, Math.round(Number(payload.targetTick)));
    if (Number.isFinite(Number(payload.clientSeq))) payload.clientSeq = Math.max(0, Math.round(Number(payload.clientSeq)));
    if (Number.isFinite(Number(payload.clientSeq))) {
      const dedupeKey = `${session.seat}:${Math.max(0, Math.round(Number(payload.clientSeq)))}`;
      const existingId = room.actionDedupe?.[dedupeKey];
      if (Number.isFinite(existingId)) {
        pushDebug({
          roomCode: room.code,
          seat: session.seat,
          source: "server",
          kind: "input_duplicate",
          data: { eventId: existingId, type: String(body.type ?? ""), targetTick: payload.targetTick ?? null, clientSeq: payload.clientSeq ?? null },
        });
        return sendJson(res, 200, { ok: true, id: existingId, duplicate: true });
      }
    }
    const ev = {
      id: room.nextEventId++,
      seat: session.seat,
      type: String(body.type ?? ""),
      payload,
      at: nowMs(),
    };
    room.events.push(ev);
    if (room.events.length > 800) room.events.shift();
    if (Number.isFinite(Number(payload.clientSeq))) {
      const dedupeKey = `${session.seat}:${Math.max(0, Math.round(Number(payload.clientSeq)))}`;
      room.actionDedupe[dedupeKey] = ev.id;
      room.actionDedupeOrder.push(dedupeKey);
      while (room.actionDedupeOrder.length > 2400) {
        const drop = room.actionDedupeOrder.shift();
        if (drop) delete room.actionDedupe[drop];
      }
    }
    room.updatedAt = nowMs();
    pushDebug({
      roomCode: room.code,
      seat: session.seat,
      source: "server",
      kind: "input_accept",
      data: { eventId: ev.id, type: ev.type, targetTick: ev.payload?.targetTick ?? null, clientSeq: ev.payload?.clientSeq ?? null, backlog: room.events.length },
    });
    return sendJson(res, 200, { ok: true, id: ev.id });
  }

  if (url.pathname === "/api/room/end") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    if (!room.started) return sendJson(res, 409, { ok: false, error: "Room has not started yet" });
    if (session.seat !== "A") return sendJson(res, 403, { ok: false, error: "Only seat A can publish round end" });
    const winnerId = body.winnerId === "B" ? "B" : body.winnerId === "A" ? "A" : "";
    room.endState = {
      ended: true,
      winnerId,
      winnerName: String(body.winnerName ?? ""),
      message: String(body.message ?? ""),
      at: nowMs(),
    };
    room.updatedAt = nowMs();
    pushDebug({
      roomCode: room.code,
      seat: session.seat,
      source: "server",
      kind: "round_end",
      data: { winnerId: room.endState.winnerId, winnerName: room.endState.winnerName, message: room.endState.message },
    });
    return sendJson(res, 200, { ok: true, endState: room.endState });
  }

  if (url.pathname === "/api/room/snapshot") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    if (session.seat !== "A") return sendJson(res, 403, { ok: false, error: "Only seat A can publish snapshots" });

    room.snapshot = body.snapshot ?? null;
    room.snapshotSeq += 1;
    room.updatedAt = nowMs();
    pushDebug({
      roomCode: room.code,
      seat: session.seat,
      source: "server",
      kind: "snapshot_publish",
      data: { seq: room.snapshotSeq, tick: room.snapshot?.tick ?? null, t: room.snapshot?.t ?? null },
    });
    return sendJson(res, 200, { ok: true, seq: room.snapshotSeq });
  }

  if (url.pathname === "/api/room/frame-batch") {
    const body = await parseJsonBody(req, res);
    if (!body) return true;
    const session = getSessionFromToken(body.token);
    if (!session) return sendJson(res, 404, { ok: false, error: "Unknown session token" });
    const room = getRoomForSession(session);
    if (!room) return sendJson(res, 404, { ok: false, error: "Session is not in a room" });
    if (!room.started) return sendJson(res, 409, { ok: false, error: "Room has not started yet" });
    if (session.seat !== "A") return sendJson(res, 403, { ok: false, error: "Only seat A can publish frame batches" });
    const framesIn = Array.isArray(body.frames) ? body.frames : [];
    const accepted = [];
    for (const item of framesIn) {
      const frame = item?.frame ?? item;
      const tickRaw = item?.tick ?? frame?.tick;
      if (!Number.isFinite(Number(tickRaw)) || !frame || typeof frame !== "object") continue;
      const tick = Math.max(0, Math.round(Number(tickRaw)));
      room.frameSeq = Math.max(0, Math.round(Number(room.frameSeq || 0))) + 1;
      accepted.push({
        seq: room.frameSeq,
        tick,
        frame,
        at: nowMs(),
        seat: session.seat,
        batchSeq: Number.isFinite(Number(body.batchSeq)) ? Math.round(Number(body.batchSeq)) : 0,
      });
    }
    if (accepted.length > 0) {
      room.frames.push(...accepted);
      while (room.frames.length > 5000) room.frames.shift();
      room.updatedAt = nowMs();
      pushDebug({
        roomCode: room.code,
        seat: session.seat,
        source: "server",
        kind: "frame_batch_accept",
        data: {
          count: accepted.length,
          fromTick: accepted[0]?.tick ?? null,
          toTick: accepted[accepted.length - 1]?.tick ?? null,
          batchSeq: accepted[accepted.length - 1]?.batchSeq ?? 0,
        },
      });
    }
    return sendJson(res, 200, { ok: true, accepted: accepted.length, frameSeq: room.frameSeq ?? 0 });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      const handled = handleApiGet(req, res, url);
      if (handled !== false) return;
      return sendJson(res, 404, { ok: false, error: "Unknown API route" });
    }

    if (req.method === "POST") {
      const handled = await handleApiPost(req, res, url);
      if (handled !== false) return;
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "Unknown API route" });
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
      console.log("Endpoints: POST /_debug_log, /api/*");
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
      console.error(`Permission denied binding to ${host}:${port}. Try PORT=5174, or check OS/network policies.`);
      process.exitCode = 1;
      return;
    }

    console.error("Server error:", err);
    process.exitCode = 1;
  });

  attempt();
}

listenWithFallback(PORT, HOST);
