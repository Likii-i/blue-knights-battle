const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function nowMs() {
  return Date.now();
}

function randomToken(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
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

function defaultState() {
  return {
    rooms: {},
    sessions: {},
    matchQueue: [],
  };
}

const MAX_DEBUG_RING = 6000;

function json(payload, status = 200) {
  const out = payload && typeof payload === "object" ? { ...payload } : payload;
  if (out && typeof out === "object" && !("serverNowMs" in out)) out.serverNowMs = nowMs();
  return new Response(JSON.stringify(out), { status, headers: JSON_HEADERS });
}

function normalizeCorsOrigins(env) {
  const raw = String(env?.CORS_ORIGIN ?? "*").trim();
  if (!raw || raw === "*") return ["*"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const allowed = normalizeCorsOrigins(env);
  const origin = request.headers.get("origin") || "";
  let allowOrigin = "*";
  if (allowed[0] !== "*") {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request, env);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function parseJsonBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function profileFromBody(body) {
  return {
    name: sanitizeName(body?.name),
    mbti: sanitizeMbti(body?.mbti),
    hobby: sanitizeHobby(body?.hobby),
  };
}

function createSession(state, profile) {
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
  state.sessions[token] = session;
  return session;
}

function getSessionFromToken(state, token) {
  if (!token) return null;
  return state.sessions[String(token)] ?? null;
}

function getRoomForSession(state, session) {
  if (!session?.roomCode) return null;
  const room = state.rooms[session.roomCode] ?? null;
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

function createRoomCode(state) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 64; attempt++) {
    let out = "";
    for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!state.rooms[out]) return out;
  }
  return randomToken(4).toUpperCase();
}

function createRoom(state) {
  const code = createRoomCode(state);
  const ts = nowMs();
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const room = {
    code,
    seed,
    createdAt: ts,
    updatedAt: ts,
    started: false,
    startAtMs: 0,
    mode: "pvp",
    players: { A: null, B: null },
    events: [],
    nextEventId: 1,
    actionDedupe: {},
    actionDedupeOrder: [],
    snapshot: null,
    snapshotSeq: 0,
    frameSeq: 0,
    frames: [],
    endState: {
      ended: false,
      winnerId: "",
      winnerName: "",
      message: "",
      at: 0,
    },
  };
  state.rooms[code] = room;
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

function sessionState(state, session) {
  const room = getRoomForSession(state, session);
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

function clearInvalidQueueTokens(state) {
  const next = [];
  for (const token of state.matchQueue) {
    const s = state.sessions[token];
    if (!s || !s.waitingMatch || s.roomCode) continue;
    next.push(token);
  }
  state.matchQueue = next;
}

function popMatchmakerCandidate(state, excludeToken) {
  clearInvalidQueueTokens(state);
  while (state.matchQueue.length) {
    const token = state.matchQueue.shift();
    if (token === excludeToken) continue;
    const s = state.sessions[token];
    if (!s || !s.waitingMatch || s.roomCode) continue;
    return s;
  }
  return null;
}

function buildJoinUrl(request, env, roomCode) {
  const reqUrl = new URL(request.url);
  const apiOrigin = reqUrl.origin;
  let appOriginHint = "";
  try {
    const originHeader = String(request.headers.get("origin") || "").trim();
    if (/^https?:\/\//i.test(originHeader)) appOriginHint = originHeader;
  } catch {
    appOriginHint = "";
  }
  let appUrl = null;
  try {
    if (env.APP_ORIGIN) {
      appUrl = new URL(env.APP_ORIGIN);
    } else if (appOriginHint) {
      appUrl = new URL(appOriginHint);
    } else {
      appUrl = new URL(reqUrl.origin);
    }
  } catch {
    appUrl = new URL(reqUrl.origin);
  }
  appUrl.search = "";
  appUrl.hash = "";
  appUrl.searchParams.set("room", roomCode);
  if (appUrl.origin !== apiOrigin) {
    appUrl.searchParams.set("api", apiOrigin);
  }
  return appUrl.toString();
}

export class GameStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.debugRing = [];
    this.nextDebugId = 1;
  }

  pushDebug(entry) {
    const record = {
      id: this.nextDebugId++,
      at: nowMs(),
      ...entry,
    };
    this.debugRing.push(record);
    while (this.debugRing.length > MAX_DEBUG_RING) this.debugRing.shift();
    return record;
  }

  async fetch(request) {
    const env = this.env;
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    const response = await this.state.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      const state = (await this.state.storage.get("state")) || defaultState();
      const method = request.method.toUpperCase();
      let mutated = false;

      const fail = (status, error) => json({ ok: false, error }, status);

      if (method === "POST" && url.pathname === "/_debug_log") {
        const payload = await parseJsonBody(request);
        if (payload && typeof payload === "object") {
          const t = Number(payload.t ?? 0).toFixed(2);
          console.log(`[debug t=${t}]`, payload);
          this.pushDebug({
            source: "legacy_terminal",
            kind: "terminal",
            roomCode: String(payload.roomCode || "").trim().toUpperCase() || null,
            seat: payload.seat === "B" ? "B" : payload.seat === "A" ? "A" : null,
            data: payload,
          });
        }
        return new Response(null, { status: 204 });
      }

      if (method === "GET" && url.pathname === "/api/debug/log") {
        const token = url.searchParams.get("token");
        const since = Number(url.searchParams.get("since") || 0);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
        let roomCode = String(url.searchParams.get("roomCode") || "").trim().toUpperCase();
        if (!roomCode && token) {
          const session = getSessionFromToken(state, token);
          if (session?.roomCode) roomCode = session.roomCode;
        }
        const seatFilter = String(url.searchParams.get("seat") || "").trim().toUpperCase();
        const sourceFilter = String(url.searchParams.get("source") || "").trim().toLowerCase();
        const kindFilter = String(url.searchParams.get("kind") || "").trim().toLowerCase();
        let out = this.debugRing.filter((item) => item.id > since);
        if (roomCode) out = out.filter((item) => item.roomCode === roomCode);
        if (seatFilter === "A" || seatFilter === "B") out = out.filter((item) => item.seat === seatFilter);
        if (sourceFilter) out = out.filter((item) => String(item.source || "").toLowerCase() === sourceFilter);
        if (kindFilter) out = out.filter((item) => String(item.kind || "").toLowerCase() === kindFilter);
        if (out.length > limit) out = out.slice(-limit);
        return json({
          ok: true,
          logs: out,
          lastId: this.nextDebugId - 1,
          roomCode: roomCode || null,
        });
      }

      if (method === "POST" && url.pathname === "/api/debug/log") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const token = body.token ? String(body.token) : "";
        const session = token ? getSessionFromToken(state, token) : null;
        const roomCode = session?.roomCode || String(body.roomCode || "").trim().toUpperCase() || null;
        const seat = session?.seat || (body.seat === "B" ? "B" : body.seat === "A" ? "A" : null);
        const source = String(body.source || "client");
        const kind = String(body.kind || "sync");
        const data = body.data && typeof body.data === "object" ? body.data : {};
        const rec = this.pushDebug({ roomCode, seat, source, kind, data });
        return json({ ok: true, id: rec.id });
      }

      if (method === "GET" && url.pathname === "/api/session") {
        const session = getSessionFromToken(state, url.searchParams.get("token"));
        if (!session) return fail(404, "Unknown session token");
        session.updatedAt = nowMs();
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, token: session.token, state: sessionState(state, session) });
      }

      if (method === "GET" && url.pathname === "/api/room/actions") {
        const session = getSessionFromToken(state, url.searchParams.get("token"));
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        const since = Number(url.searchParams.get("since") || 0);
        const events = [];
        for (const ev of room.events) {
          if (ev.id <= since) continue;
          events.push(ev);
        }
        return json({ ok: true, events, lastId: room.nextEventId - 1 });
      }

      if (method === "GET" && url.pathname === "/api/room/snapshot") {
        const session = getSessionFromToken(state, url.searchParams.get("token"));
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        const since = Number(url.searchParams.get("since") || 0);
        return json({
          ok: true,
          seq: room.snapshotSeq,
          started: room.started,
          startAtMs: room.startAtMs ?? 0,
          mode: room.mode,
          players: publicPlayers(room),
          endState: room.endState ?? null,
          snapshot: room.snapshotSeq > since ? room.snapshot : null,
        });
      }

      if (method === "GET" && url.pathname === "/api/room/bundle") {
        const session = getSessionFromToken(state, url.searchParams.get("token"));
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        const sinceAction = Number(url.searchParams.get("sinceAction") || 0);
        const sinceSnapshot = Number(url.searchParams.get("sinceSnapshot") || 0);
        const sinceFrame = Number(url.searchParams.get("sinceFrame") || 0);
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
        return json({
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

      if (method === "POST" && url.pathname === "/api/room/create") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const profile = profileFromBody(body);
        const session = createSession(state, profile);
        const room = createRoom(state);
        attachSessionToRoom(session, room, "A");
        this.pushDebug({
          roomCode: room.code,
          seat: "A",
          source: "server",
          kind: "room_create",
          data: { host: profile.name, roomCode: room.code },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({
          ok: true,
          token: session.token,
          roomCode: room.code,
          seat: "A",
          joinUrl: buildJoinUrl(request, env, room.code),
          state: sessionState(state, session),
        });
      }

      if (method === "POST" && url.pathname === "/api/room/join") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const roomCode = String(body.roomCode ?? "").trim().toUpperCase();
        const room = state.rooms[roomCode];
        if (!room) return fail(404, "Room not found");
        if (room.players.B) return fail(409, "Room is full");
        const profile = profileFromBody(body);
        const session = createSession(state, profile);
        attachSessionToRoom(session, room, "B");
        room.started = true;
        room.startAtMs = nowMs() + 2200;
        room.mode = "pvp";
        room.updatedAt = nowMs();
        this.pushDebug({
          roomCode: room.code,
          seat: "B",
          source: "server",
          kind: "room_join_start",
          data: { startAtMs: room.startAtMs, mode: room.mode },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({
          ok: true,
          token: session.token,
          roomCode: room.code,
          seat: "B",
          state: sessionState(state, session),
        });
      }

      if (method === "POST" && url.pathname === "/api/room/start-ai") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        if (session.seat !== "A") return fail(403, "Only room host can start AI mode");
        if (room.players.B) return fail(409, "Cannot start AI mode after second player joined");
        room.started = true;
        room.startAtMs = nowMs() + 350;
        room.mode = "ai";
        room.updatedAt = nowMs();
        this.pushDebug({
          roomCode: room.code,
          seat: session.seat,
          source: "server",
          kind: "start_ai",
          data: { startAtMs: room.startAtMs, mode: room.mode },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, state: sessionState(state, session) });
      }

      if (method === "POST" && url.pathname === "/api/matchmaker/join") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const profile = profileFromBody(body);
        const session = createSession(state, profile);
        session.waitingMatch = true;
        session.updatedAt = nowMs();
        const opponent = popMatchmakerCandidate(state, session.token);
        if (!opponent) {
          state.matchQueue.push(session.token);
          mutated = true;
          await this.state.storage.put("state", state);
          return json({ ok: true, token: session.token, waiting: true, state: sessionState(state, session) });
        }
        const room = createRoom(state);
        attachSessionToRoom(opponent, room, "A");
        attachSessionToRoom(session, room, "B");
        room.started = true;
        room.startAtMs = nowMs() + 2200;
        room.mode = "pvp";
        room.updatedAt = nowMs();
        this.pushDebug({
          roomCode: room.code,
          seat: "B",
          source: "server",
          kind: "matchmaker_start",
          data: { startAtMs: room.startAtMs, mode: room.mode },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, token: session.token, waiting: false, state: sessionState(state, session) });
      }

      if (method === "POST" && url.pathname === "/api/matchmaker/cancel") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        session.waitingMatch = false;
        session.updatedAt = nowMs();
        clearInvalidQueueTokens(state);
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, state: sessionState(state, session) });
      }

      if (method === "POST" && url.pathname === "/api/room/action") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        if (!room.started) return fail(409, "Room has not started yet");
        if (room.endState?.ended) return fail(409, "Match already ended");
        if (!room.actionDedupe || typeof room.actionDedupe !== "object") room.actionDedupe = {};
        if (!Array.isArray(room.actionDedupeOrder)) room.actionDedupeOrder = [];
        const payload = body.payload && typeof body.payload === "object" ? { ...body.payload } : {};
        if (Number.isFinite(Number(payload.targetTick))) payload.targetTick = Math.max(0, Math.round(Number(payload.targetTick)));
        if (Number.isFinite(Number(payload.clientSeq))) payload.clientSeq = Math.max(0, Math.round(Number(payload.clientSeq)));
        if (Number.isFinite(Number(payload.clientSeq))) {
          const dedupeKey = `${session.seat}:${Math.max(0, Math.round(Number(payload.clientSeq)))}`;
          const existingId = room.actionDedupe?.[dedupeKey];
          if (Number.isFinite(existingId)) {
            this.pushDebug({
              roomCode: room.code,
              seat: session.seat,
              source: "server",
              kind: "input_duplicate",
              data: { eventId: existingId, type: String(body.type ?? ""), targetTick: payload.targetTick ?? null, clientSeq: payload.clientSeq ?? null },
            });
            return json({ ok: true, id: existingId, duplicate: true });
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
        this.pushDebug({
          roomCode: room.code,
          seat: session.seat,
          source: "server",
          kind: "input_accept",
          data: { eventId: ev.id, type: ev.type, targetTick: ev.payload?.targetTick ?? null, clientSeq: ev.payload?.clientSeq ?? null, backlog: room.events.length },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, id: ev.id });
      }

      if (method === "POST" && url.pathname === "/api/room/end") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        if (!room.started) return fail(409, "Room has not started yet");
        if (session.seat !== "A") return fail(403, "Only seat A can publish round end");
        const winnerId = body.winnerId === "B" ? "B" : body.winnerId === "A" ? "A" : "";
        room.endState = {
          ended: true,
          winnerId,
          winnerName: String(body.winnerName ?? ""),
          message: String(body.message ?? ""),
          at: nowMs(),
        };
        room.updatedAt = nowMs();
        this.pushDebug({
          roomCode: room.code,
          seat: session.seat,
          source: "server",
          kind: "round_end",
          data: { winnerId: room.endState.winnerId, winnerName: room.endState.winnerName, message: room.endState.message },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, endState: room.endState });
      }

      if (method === "POST" && url.pathname === "/api/room/snapshot") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        if (session.seat !== "A") return fail(403, "Only seat A can publish snapshots");
        room.snapshot = body.snapshot ?? null;
        room.snapshotSeq += 1;
        room.updatedAt = nowMs();
        this.pushDebug({
          roomCode: room.code,
          seat: session.seat,
          source: "server",
          kind: "snapshot_publish",
          data: { seq: room.snapshotSeq, tick: room.snapshot?.tick ?? null, t: room.snapshot?.t ?? null },
        });
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, seq: room.snapshotSeq });
      }

      if (method === "POST" && url.pathname === "/api/room/frame-batch") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const session = getSessionFromToken(state, body.token);
        if (!session) return fail(404, "Unknown session token");
        const room = getRoomForSession(state, session);
        if (!room) return fail(404, "Session is not in a room");
        if (!room.started) return fail(409, "Room has not started yet");
        if (session.seat !== "A") return fail(403, "Only seat A can publish frame batches");
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
          this.pushDebug({
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
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, accepted: accepted.length, frameSeq: room.frameSeq ?? 0 });
      }

      if (url.pathname.startsWith("/api/")) return fail(404, "Unknown API route");
      if (method !== "GET" && method !== "HEAD") return fail(405, "Method not allowed");
      return json({ ok: true, service: "mbti-fighters-api", time: nowMs(), mutated });
    });

    return withCors(response, request, env);
  }
}

export default {
  async fetch(request, env) {
    const id = env.GAME_STATE.idFromName("global");
    const stub = env.GAME_STATE.get(id);
    return stub.fetch(request);
  },
};
