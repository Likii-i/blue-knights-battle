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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
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
  return state.rooms[session.roomCode] ?? null;
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
    mode: "pvp",
    players: { A: null, B: null },
    events: [],
    nextEventId: 1,
    snapshot: null,
    snapshotSeq: 0,
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
      mode: null,
      matchSeed: null,
      players: null,
    };
  }
  return {
    inRoom: true,
    waitingMatch: false,
    seat: session.seat,
    roomCode: room.code,
    started: Boolean(room.started),
    mode: room.mode,
    matchSeed: room.seed >>> 0,
    players: publicPlayers(room),
    opponentJoined: Boolean(room.players.A && room.players.B),
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
        }
        return new Response(null, { status: 204 });
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
          if (ev.seat === session.seat) continue;
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
          mode: room.mode,
          players: publicPlayers(room),
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
        const events = [];
        for (const ev of room.events) {
          if (ev.id <= sinceAction) continue;
          if (ev.seat === session.seat) continue;
          events.push(ev);
        }
        return json({
          ok: true,
          events,
          lastId: room.nextEventId - 1,
          snapshotSeq: room.snapshotSeq,
          snapshot: room.snapshotSeq > sinceSnapshot ? room.snapshot : null,
          started: room.started,
          mode: room.mode,
          players: publicPlayers(room),
        });
      }

      if (method === "POST" && url.pathname === "/api/room/create") {
        const body = await parseJsonBody(request);
        if (!body) return fail(400, "Invalid JSON body");
        const profile = profileFromBody(body);
        const session = createSession(state, profile);
        const room = createRoom(state);
        attachSessionToRoom(session, room, "A");
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
        room.mode = "pvp";
        room.updatedAt = nowMs();
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
        room.mode = "ai";
        room.updatedAt = nowMs();
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
        room.mode = "pvp";
        room.updatedAt = nowMs();
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
        const payload = body.payload && typeof body.payload === "object" ? { ...body.payload } : {};
        if (Number.isFinite(Number(payload.targetTick))) payload.targetTick = Math.max(0, Math.round(Number(payload.targetTick)));
        if (Number.isFinite(Number(payload.clientSeq))) payload.clientSeq = Math.max(0, Math.round(Number(payload.clientSeq)));
        const ev = {
          id: room.nextEventId++,
          seat: session.seat,
          type: String(body.type ?? ""),
          payload,
          at: nowMs(),
        };
        room.events.push(ev);
        if (room.events.length > 800) room.events.shift();
        room.updatedAt = nowMs();
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, id: ev.id });
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
        mutated = true;
        await this.state.storage.put("state", state);
        return json({ ok: true, seq: room.snapshotSeq });
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
