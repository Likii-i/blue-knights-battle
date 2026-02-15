// MBTI Fighters v1.3
// Two ENFP-ish agents + a deadly juggernaut. Decisions are damage-driven with
// short commit windows, hidden opponent HP estimates (for bluffing), and a
// terminal debug stream via dev-server.js (POST /_debug_log).

const TAU = Math.PI * 2;
const SCREEN_SHAKE_MARGIN_PX = 18;
const NET_SMOOTHNESS_BUDGET = Object.freeze({
  targetInputLatencyMs: 90,
  inputLeadTicks: 5,
  tickRate: 60,
  maxRollbackTicks: 48,
  maxCatchupStepsPerFrame: 10,
  maxLateActionTicks: 18,
  correctionBlendSec: 0.08,
  hardCorrectionPx: 4,
});
const NET_DEBUG_SAMPLE_INTERVAL_SEC = 0.5;
const NET_DEBUG_QUEUE_LIMIT = 180;
const AUTHORITY_FRAME_HORIZON_TICKS = 30;
const NET_ABILITY_EXTRA_LEAD_TICKS = 8;
let API_BASE_URL = "";
let EMBEDDED_API_BASE_URL = "";
let ACTIVE_RANDOM_SOURCE = null;

function random01() {
  const source = ACTIVE_RANDOM_SOURCE;
  if (typeof source === "function") return source();
  return Math.random();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function clamp01(n) {
  return clamp(n, 0, 1);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function hypot(x, y) {
  return Math.hypot(x, y);
}
function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}
function finiteOr(n, fallback = 0) {
  return isFiniteNumber(n) ? n : fallback;
}
function safePoint(p, fallback = null) {
  if (!p) return fallback;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return fallback;
  return { x, y };
}
function normalize(x, y) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return { x: 0, y: 0, len: 0 };
  const len = hypot(x, y);
  if (!isFiniteNumber(len) || len < 1e-9) return { x: 0, y: 0, len: 0 };
  return { x: x / len, y: y / len, len };
}
function dot(ax, ay, bx, by) {
  return ax * bx + ay * by;
}
function angleTo(x, y) {
  return Math.atan2(y, x);
}
function wrapAngle(rad) {
  let a = rad;
  while (a <= -Math.PI) a += TAU;
  while (a > Math.PI) a -= TAU;
  return a;
}
function angleDiff(a, b) {
  return wrapAngle(b - a);
}
function randRange(min, max) {
  return min + random01() * (max - min);
}

function expSmoothing(dt, tau) {
  return 1 - Math.exp(-dt / Math.max(1e-6, tau));
}

function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function hashSeed(str) {
  // Cheap string -> uint32 hash (FNV-1a-ish).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seedU32) {
  // xorshift32
  let s = (seedU32 >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Convert to [0,1)
    return ((s >>> 0) & 0xffffffff) / 0x100000000;
  };
}

function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function seedSimulationRng(world, seed) {
  const rt = world?.runtime;
  if (!rt) return;
  const next = (Number(seed) >>> 0) || 1;
  rt.simRngSeed = next;
  rt.simRngState = next;
}

function nextSimulationRandom(world) {
  const rt = world?.runtime;
  if (!rt) return Math.random();
  let s = (rt.simRngState >>> 0) || 1;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  if (s === 0) s = 1;
  rt.simRngState = s;
  return s / 0x100000000;
}

function isLockstepPvp(world) {
  const rt = world?.runtime;
  return Boolean(
    rt &&
      rt.appMode === "player" &&
      rt.match?.mode === "pvp" &&
      rt.net &&
      rt.net.syncModel === "lockstep" &&
      (rt.playState === "host" || rt.playState === "guest"),
  );
}

function turnToward(agent, desiredAngle, turnRateRadSec, dt) {
  const diff = angleDiff(agent.heading, desiredAngle);
  const maxStep = Math.max(0, turnRateRadSec) * dt;
  agent.heading = wrapAngle(agent.heading + clamp(diff, -maxStep, maxStep));
}

function randNormal() {
  // Box-Muller transform
  let u = 0;
  let v = 0;
  while (u === 0) u = random01();
  while (v === 0) v = random01();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function ouStep(x, dt, tau, sigma) {
  const t = Math.max(1e-6, tau);
  const decay = Math.exp(-dt / t);
  return x * decay + randNormal() * sigma * Math.sqrt(1 - decay * decay);
}

function colorHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixColors(hexA, hexB, t) {
  const a = colorHexToRgb(hexA);
  const b = colorHexToRgb(hexB);
  const r = Math.round(lerp(a.r, b.r, clamp01(t)));
  const g = Math.round(lerp(a.g, b.g, clamp01(t)));
  const bl = Math.round(lerp(a.b, b.b, clamp01(t)));
  return `rgb(${r}, ${g}, ${bl})`;
}

function clearance(world, x, y) {
  return Math.min(x, world.width - x, y, world.height - y);
}

const EMOTIONS = [
  { id: "joy", label: "Joy", color: "#f6c453" },
  { id: "fear", label: "Fear", color: "#6b7fff" },
  { id: "anger", label: "Anger", color: "#ff5a52" },
  { id: "sadness", label: "Sad", color: "#5a7f8a" },
  { id: "curiosity", label: "Curiosity", color: "#48cfae" },
];

function getEmotionPie(agent) {
  let sum = 0;
  for (const e of EMOTIONS) sum += Math.max(0, agent.emotions[e.id] ?? 0);
  const fallback = sum < 1e-6;
  const slices = [];
  for (const e of EMOTIONS) {
    const raw = Math.max(0, agent.emotions[e.id] ?? 0);
    const p = fallback ? (e.id === "curiosity" ? 1 : 0) : raw / sum;
    slices.push({ ...e, p });
  }
  return slices;
}

function avgClearanceAlong(world, ax, ay, bx, by, samples) {
  let sum = 0;
  const n = Math.max(1, samples | 0);
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const x = lerp(ax, bx, t);
    const y = lerp(ay, by, t);
    sum += clearance(world, x, y);
  }
  return sum / n;
}

function chooseSoftmax(options, temperature) {
  // options: [{ id, score }]
  const t = Math.max(0.05, temperature);
  let max = -Infinity;
  for (const o of options) max = Math.max(max, o.score);
  let sum = 0;
  const weights = [];
  for (const o of options) {
    const w = Math.exp((o.score - max) / t);
    weights.push(w);
    sum += w;
  }
  let r = random01() * sum;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i].id;
  }
  return options[options.length - 1]?.id ?? null;
}

function softmaxWeights(options, temperature = 1.0) {
  // options: [{ id, score }]. Returns { [id]: weight } with weights summing to 1.
  const t = Math.max(0.05, temperature);
  let max = -Infinity;
  for (const o of options) max = Math.max(max, o.score);
  let sum = 0;
  const ws = [];
  for (const o of options) {
    const w = Math.exp((o.score - max) / t);
    ws.push({ id: o.id, w });
    sum += w;
  }
  const out = Object.create(null);
  if (sum <= 1e-9) {
    const v = options.length ? 1 / options.length : 0;
    for (const o of options) out[o.id] = v;
    return out;
  }
  for (const it of ws) out[it.id] = it.w / sum;
  return out;
}

function rayRectIntersection(ox, oy, dx, dy, w, h) {
  // Ray: origin + t * dir, t>=0. Return closest hit with world bounds.
  const hits = [];
  if (Math.abs(dx) > 1e-9) {
    let t = (0 - ox) / dx;
    if (t >= 0) {
      const y = oy + t * dy;
      if (y >= 0 && y <= h) hits.push({ t, x: 0, y });
    }
    t = (w - ox) / dx;
    if (t >= 0) {
      const y = oy + t * dy;
      if (y >= 0 && y <= h) hits.push({ t, x: w, y });
    }
  }
  if (Math.abs(dy) > 1e-9) {
    let t = (0 - oy) / dy;
    if (t >= 0) {
      const x = ox + t * dx;
      if (x >= 0 && x <= w) hits.push({ t, x, y: 0 });
    }
    t = (h - oy) / dy;
    if (t >= 0) {
      const x = ox + t * dx;
      if (x >= 0 && x <= w) hits.push({ t, x, y: h });
    }
  }
  if (hits.length === 0) return { x: ox, y: oy };
  hits.sort((a, b) => a.t - b.t);
  return { x: hits[0].x, y: hits[0].y };
}

const TACTICS = Object.freeze([
  "OPEN_UP",
  "RETREAT_LONG",
  "RETREAT_SHORT",
  "PRESSURE",
  "ATTACK",
  "BLOCK",
  "CLASH",
  "RESET",
]);
const MELEE_REACH = 14;

const HOBBY_IDS = Object.freeze([
  "SCIENCE_RESEARCH",
  "DANCE",
  "DRAWING",
  "SINGING",
  "STRING_INSTRUMENT",
  "WIND_INSTRUMENT",
  "BRASS_INSTRUMENT",
  "KEYBOARD_INSTRUMENT",
  "GUITAR_BASS",
  "DRUMS",
  "THEATRE",
  "GYM",
  "SPORTS",
  "COOKING_EATING",
  "ANIMALS",
  "KNITTING_CROCHET",
  "VIDEO_GAMES",
]);

const MBTI_TYPES = Object.freeze([
  "ISTJ", "ISFJ", "INFJ", "INTJ",
  "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP",
  "ESTJ", "ESFJ", "ENFJ", "ENTJ",
]);

const HOBBY_SPECS = Object.freeze({
  SCIENCE_RESEARCH: {
    label: "Science Research",
    short: "SCI",
    primary: { id: "LAB_SAFETY", label: "Lab Safety", kind: "defensive", cooldown: 16 },
    secondary: { id: "COMBUSTION", label: "Combustion", kind: "offensive", cooldown: 15 },
  },
  DANCE: {
    label: "Dance",
    short: "DAN",
    primary: { id: "WALTZ", label: "Waltz", kind: "defensive", cooldown: 14 },
    secondary: { id: "TWIRL", label: "Twirl", kind: "offensive", cooldown: 13 },
  },
  DRAWING: {
    label: "Drawing",
    short: "DRW",
    primary: { id: "DRAW_FIRE", label: "Draw", kind: "neutral", cooldown: 14 },
    secondary: null,
  },
  SINGING: {
    label: "Singing",
    short: "SNG",
    primary: { id: "SING", label: "Sing", kind: "neutral", cooldown: 13 },
    secondary: null,
  },
  STRING_INSTRUMENT: {
    label: "String Instrument",
    short: "STR",
    primary: { id: "ROSIN", label: "Rosin", kind: "defensive", cooldown: 14 },
    secondary: { id: "UGLY_SOUND", label: "Ugly Sound", kind: "offensive", cooldown: 16 },
  },
  WIND_INSTRUMENT: {
    label: "Wind Instrument",
    short: "WND",
    primary: { id: "CIRCULAR_BREATHING", label: "Circular Breathing", kind: "neutral", cooldown: 13 },
    secondary: null,
  },
  BRASS_INSTRUMENT: {
    label: "Brass Instrument",
    short: "BRS",
    primary: { id: "INSTRUMENT_CASE", label: "Instrument Case", kind: "defensive", cooldown: 16 },
    secondary: { id: "LOUD_NOISE", label: "Loud Noise", kind: "offensive", cooldown: 14 },
  },
  KEYBOARD_INSTRUMENT: {
    label: "Keyboard Instrument",
    short: "KEY",
    primary: { id: "KEYBOARD_DEF", label: "Keyboard Def", kind: "defensive", cooldown: 12 },
    secondary: { id: "KEYBOARD_OFF", label: "Keyboard Off", kind: "offensive", cooldown: 12 },
  },
  GUITAR_BASS: {
    label: "Guitar/Bass",
    short: "GTR",
    primary: { id: "SERENADE", label: "Serenade", kind: "defensive", cooldown: 14 },
    secondary: { id: "METAL_CHORD", label: "Metal Chord", kind: "offensive", cooldown: 15 },
  },
  DRUMS: {
    label: "Drums",
    short: "DRM",
    primary: { id: "CRASH_CYMBAL", label: "Crash Cymbal", kind: "neutral", cooldown: 14 },
    secondary: null,
  },
  THEATRE: {
    label: "Theatre",
    short: "THR",
    primary: { id: "BACKSTAGE_BREAK", label: "Backstage Break", kind: "defensive", cooldown: 18 },
    secondary: { id: "ACTING_JUG", label: "Acting", kind: "offensive", cooldown: 17 },
  },
  GYM: {
    label: "Gym",
    short: "GYM",
    primary: { id: "PROGRESSIVE_OVERLOAD", label: "Progressive Overload", kind: "defensive", cooldown: 18 },
    secondary: { id: "PROTEIN_SHAKE", label: "Protein Shake", kind: "offensive", cooldown: 15 },
  },
  SPORTS: {
    label: "Sports",
    short: "SPT",
    primary: { id: "LOCK_IN", label: "Lock In", kind: "neutral", cooldown: 14 },
    secondary: null,
  },
  COOKING_EATING: {
    label: "Cooking/Eating",
    short: "CKG",
    primary: { id: "COOKING", label: "Cooking", kind: "defensive", cooldown: 12 },
    secondary: { id: "FLAMBE", label: "Flambe", kind: "offensive", cooldown: 13 },
  },
  ANIMALS: {
    label: "Animals",
    short: "ANM",
    primary: { id: "CALL_ANIMALS", label: "Call Animals", kind: "neutral", cooldown: 16 },
    secondary: null,
  },
  KNITTING_CROCHET: {
    label: "Knitting/Crochet",
    short: "KNT",
    primary: { id: "KNIT_SWEATER", label: "Knit Sweater", kind: "defensive", cooldown: 12 },
    secondary: null,
  },
  VIDEO_GAMES: {
    label: "Video Games",
    short: "VGM",
    primary: { id: "VIDEO_GAME", label: "Video Game", kind: "neutral", cooldown: 13 },
    secondary: null,
  },
});

function getHobbySpec(hobbyId) {
  return HOBBY_SPECS[hobbyId] ?? HOBBY_SPECS.SCIENCE_RESEARCH;
}

const ABILITY_BY_ID = (() => {
  const out = Object.create(null);
  for (const hobbyId of HOBBY_IDS) {
    const spec = HOBBY_SPECS[hobbyId];
    if (!spec) continue;
    if (spec.primary?.id) out[spec.primary.id] = spec.primary;
    if (spec.secondary?.id) out[spec.secondary.id] = spec.secondary;
  }
  return out;
})();

function getAbilityById(abilityId) {
  if (!abilityId) return null;
  return ABILITY_BY_ID[String(abilityId)] ?? null;
}

function getHobbyShort(hobbyId) {
  return getHobbySpec(hobbyId).short ?? "UNK";
}

function getAgentMbti(agent) {
  const mbti = String(agent?.mbti ?? "").trim().toUpperCase();
  return mbti || "ENFP";
}

function cycleMbti(mbti, dir = 1) {
  const cur = getAgentMbti({ mbti });
  const i = Math.max(0, MBTI_TYPES.indexOf(cur));
  const n = MBTI_TYPES.length;
  const j = ((i + (dir >= 0 ? 1 : -1)) % n + n) % n;
  return MBTI_TYPES[j];
}

function mbtiStyleFromType(mbti) {
  const t = getAgentMbti({ mbti });
  const has = (ch) => t.includes(ch);
  const E = has("E") ? 1 : 0;
  const N = has("N") ? 1 : 0;
  const T = has("T") ? 1 : 0;
  const J = has("J") ? 1 : 0;
  const S = 1 - N;
  const P = 1 - J;
  const I = 1 - E;
  const F = 1 - T;
  let aggression = clamp(0.24 + E * 0.24 + T * 0.2 + P * 0.1 + N * 0.08 - I * 0.05 - F * 0.03, 0.08, 0.95);
  if (t === "ENTJ" || t === "ESTP" || t === "ESTJ") aggression = clamp(aggression + 0.1, 0.08, 0.98);
  if (t === "INFP" || t === "ISFJ" || t === "INFJ") aggression = clamp(aggression - 0.08, 0.05, 0.98);
  const stubbornness = clamp(0.26 + J * 0.22 + T * 0.14 + I * 0.08 + S * 0.08, 0.1, 0.98);
  const blockBias = clamp(0.3 + J * 0.2 + I * 0.14 + S * 0.1 - E * 0.05 + F * 0.04, 0.05, 0.95);
  return {
    riskTolerance: clamp(0.3 + E * 0.14 + N * 0.18 + F * 0.05 + P * 0.13, 0.08, 0.98),
    wrapWhenChased: clamp(0.12 + N * 0.24 + E * 0.11 + P * 0.16, 0.02, 0.98),
    staminaConserve: clamp(0.3 + I * 0.18 + S * 0.13 + J * 0.2, 0.08, 0.98),
    engageBias: clamp(0.24 + E * 0.22 + N * 0.08 + T * 0.08 + P * 0.12, 0.06, 0.98),
    aggression,
    stubbornness,
    blockBias,
  };
}

function applyMbtiProfile(agent, mbti) {
  const next = getAgentMbti({ mbti });
  agent.mbti = next;
  const s = mbtiStyleFromType(next);
  agent.style.riskTolerance = s.riskTolerance;
  agent.style.wrapWhenChased = s.wrapWhenChased;
  agent.style.staminaConserve = s.staminaConserve;
  agent.style.engageBias = s.engageBias;
  agent.style.aggression = s.aggression;
  agent.style.stubbornness = s.stubbornness;
  agent.style.blockBias = s.blockBias;
}

function getAbilitySlot(spec, slot) {
  if (!spec) return null;
  return slot === "secondary" ? spec.secondary : spec.primary;
}

function cycleHobbyId(currentId, dir = 1) {
  const i = Math.max(0, HOBBY_IDS.indexOf(currentId));
  const n = HOBBY_IDS.length;
  const j = ((i + (dir >= 0 ? 1 : -1)) % n + n) % n;
  return HOBBY_IDS[j];
}

function isAgentPhasedOut(agent, now) {
  return Boolean((agent.fx?.backstageUntil ?? 0) > now);
}

function makeWorld(canvas) {
  return {
    canvas,
    ctx: canvas.getContext("2d", { alpha: false }),
    width: 900,
    height: 900,
    viewWidth: 0,
    viewHeight: 0,
    time: 0,
    debug: false,
    showHelp: true,
    terminalLog: true,
    logIntervalMs: 500,
    _lastLogAt: 0,
    _logDisabledReason: "",
    player: {
      controlledId: "A",
      keysDown: new Set(),
      commandCooldown: 6.0,
      nextCommandAt: 0,
      lastTapAt: -Infinity,
      drawFire: null, // { ownerId, until, remaining, points, pointerId, active }
    },
    ability: {
      zones: [], // { kind, ownerId, x, y, r, until, tickAt, dps, color }
      barriers: [], // { ownerId, x, y, r, until }
      summons: [], // { id, ownerId, x, y, vx, vy, r, hp, until, atkCdUntil }
      yarn: [], // { ownerId, x1, y1, x2, y2, until, spent }
      keyboardTasks: [], // { ownerId, mode, x, y, r, keyX, keyY, keyR, until }
      projectiles: [], // { id, ownerId, x, y, vx, vy, r, until, damage, hit }
      markers: [], // lightweight visual placeholders for abilities
    },
    screenShake: {
      amp: 0,
      startAt: 0,
      until: 0,
      phase: random01() * TAU,
    },
    uiState: {
      lastHpUpdateAt: 0,
      hpDisplayA: null,
      hpDisplayB: null,
    },
    runtime: {
      appMode: "player", // player | developer
      profile: null, // { name, mbti, hobby, look }
      profileLocked: false,
      flowScreen: "profile", // profile | hub | room | none
      pendingJoinCode: null,
      pendingQueueJoin: false,
      roomMenuMode: "", // room | matchmaker | ""
      sessionToken: "",
      sessionPollBusy: false,
      sessionPollErrorAt: 0,
      match: null, // { roomCode, seat, role, mode, started, players }
      net: null, // network state; shape depends on sync model
      timers: [],
      playState: "menu", // menu | host | guest
      simTick: 0,
      simAccumulator: 0,
      simStepDt: 1 / NET_SMOOTHNESS_BUDGET.tickRate,
      simRngSeed: 1,
      simRngState: 1,
      roundEnd: {
        active: false,
        winnerId: "",
        winnerName: "",
        message: "",
        showUntil: 0,
        returnAt: 0,
      },
    },
    juggernaut: null,
    agents: [],
  };
}

function makeAgent(id, world, x, y, color) {
  return {
    id,
    playerName: id,
    color,
    mbti: id === "A" ? "ENFP" : "ENTP",
    x,
    y,
    vx: 0,
    vy: 0,
    r: 16,
    heading: -Math.PI / 2, // gaze direction (used for the LOS wedge)
    fov: (120 * Math.PI) / 180,

    maxSpeed: 175,
    maxAccel: 560,
    motor: { desiredVx: 0, desiredVy: 0 },
    stamina: 100,
    maxStamina: 100,

    hp: 100,
    maxHp: 100,
    absorbHp: 0,
    atkCdUntil: 0,
    attackWindupUntil: 0,
    attackWindupTargetId: null,
    blockUntil: 0,
    blockRaisedAt: -Infinity,
    blockCooldownUntil: 0,
    hitstunUntil: 0,
    feintUntil: 0,

    tactic: "OPEN_UP",
    posture: "NEUTRAL", // "AGGRO" | "NEUTRAL" | "DEFENSIVE"
    commitUntil: 0,
    thought: "",
    thoughtSince: 0,
    stance: {
      id: "NEUTRAL", // NEUTRAL | GARRISON | ASSAULT
      chargingTo: null,
      charge: 0, // 0..1
      chargeSince: -Infinity,
      chargeDur: 0,
      activeUntil: 0,
      cooldownUntil: 0,
      anchor: null, // {x,y}
      reason: "",
    },
    hobby: {
      id: id === "A" ? "SCIENCE_RESEARCH" : "DANCE",
      lastSwitchAt: -Infinity,
      castGlobalUntil: 0,
      primaryCooldownUntil: 0,
      secondaryCooldownUntil: 0,
      aiNextThinkAt: 0,
      lastUsed: "",
    },
    fx: {
      damageTakenMul: 1,
      damageTakenUntil: 0,
      damageOutMul: 1,
      damageOutUntil: 0,
      speedMul: 1,
      speedMulUntil: 0,
      attackSpeedMul: 1,
      attackSpeedUntil: 0,
      burnUntil: 0,
      burnTickAt: 0,
      burnDps: 0,
      reduceDamageOutUntil: 0,
      rosinUntil: 0,
      invulnUntil: 0,
      reflectCharges: 0,
      reflectRatio: 0,
      flambedUntil: 0,
      flambedHitUntil: 0,
      loudDefenseSince: -Infinity,
      actingHitsLeft: 0,
      actingUntil: 0,
      backstageUntil: 0,
      backstageReturnX: 0,
      backstageReturnY: 0,
      progressiveStoreUntil: 0,
      progressiveReleaseUntil: 0,
      progressiveStoredDamage: 0,
      lockInUntil: 0,
      sportsScale: 0,
      twirlUntil: 0,
      twirlTickAt: 0,
      twirlStartX: NaN,
      twirlStartY: NaN,
      twirlTargetX: NaN,
      twirlTargetY: NaN,
      twirlHitsByTarget: Object.create(null),
      dancingUntil: 0,
      keyboardTaskId: null,
      animalWaveUntil: 0,
      animalWaveNextAt: 0,
      animalWaveCount: 0,
    },
    scene: {
      id: "RESET", // RESET | DUEL | SCRAMBLE | ESCAPE | FINISH
      until: 0,
      startedAt: 0,
      escapeClearSince: -Infinity,
    },
    style: {
      riskTolerance: 0.55,
      wrapWhenChased: 0.25,
      staminaConserve: 0.45,
      engageBias: 0.55,
      aggression: 0.55,
      stubbornness: 0.5,
      blockBias: 0.5,
    },
    plan: {
      current: "OPEN_UP",
      next: "-",
      confidence: 0,
      plannedAt: -Infinity,
    },
    playerCmd: {
      mode: "NONE", // NONE | REPOSITION | RECOVER | ATTACK
      x: 0,
      y: 0,
      issuedAt: -Infinity,
      until: -Infinity,
      nextAllowedAt: 0,
    },
    nav: {
      target: null, // {x,y} cached for the current commit (prevents per-frame jitter)
      kind: "NONE", // debug label for why this target exists
      objectives: { recover: 0.34, duel: 0.33, bait: 0.33 }, // cached blend for the commit
      validUntil: 0,
      seed: 0,
    },
    avoid: {
      // Smoothed steering offset so obstacle avoidance doesn't buzz around thresholds.
      vx: 0,
      vy: 0,
    },
    senses: {
      opp: { dist: Infinity, visible: false, peripheral: false, lastSeenAt: -Infinity, lastSeenPos: null },
      jug: {
        dist: Infinity,
        visible: false,
        peripheral: false,
        heard: false,
        lastSeenAt: -Infinity,
        lastSeenPos: null,
        uncertainty: 0,
        beliefPos: null, // {x,y} (what planning uses)
        beliefDist: Infinity,
        quality: 0, // 0..1
      },
      clearance: 0,
    },
    gaze: {
      // Decouples "where I look" from "where I move" to enable human-like look-backs.
      mode: "MOVE", // MOVE | OPP | JUG | GLANCE_JUG
      scanOffset: 0,
      socialUntil: 0,
      socialCooldownUntil: 0,
      glance: {
        urge: 0,
        jitter: 0,
        nextGateAt: 0,
        lastAt: -Infinity,
        cooldownUntil: 0,
        activeUntil: 0,
        targetAngle: 0,
        speedMul: 1,
        accelMul: 1,
      },
    },
    events: {
      lastDecisionAt: -Infinity,
      gotHitAt: -Infinity,
      tookBigHitAt: -Infinity,
      jugWindupSeenAt: -Infinity,
      oppThreatAt: -Infinity,
      pinnedSince: -Infinity,
      dealtHitAt: -Infinity,
      dealtDamage: 0,
      engageUntil: -Infinity,
      followUpUntil: -Infinity,
    },
    emotions: {
      joy: 0.12,
      fear: 0.08,
      anger: 0.06,
      sadness: 0.05,
      curiosity: 0.2,
    },

    // Tiny memory to reduce oscillation.
    mem: {
      lastDirs: [], // [{x,y}]
      safeSpots: [],
      trapSpots: [],
      lastSafeAt: -Infinity,
    },

    // Learned damage estimates (EMA).
    belief: {
      opponentHp: { mean: 100, var: 20 * 20, updatedAt: 0 },
      jugDamage: { mean: 26, var: 8 * 8 },
      oppDamage: { mean: 8, var: 3 * 3 },
    },

    lastEval: {
      predSelfJ: 0,
      predSelfO: 0,
      predOpp: 0,
      routeRisk: 0,
      jugChasingMe: false,
      reengageOk: true,
      wrapIntent: 0,
    },
  };
}

function makeJuggernaut(world, x, y) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    r: 26,
    speed: 78,
    speedBoostUntil: 0,
    speedBoostMul: 1,
    stunnedUntil: 0,
    atkCdUntil: 0,
    windupUntil: 0,
    windupTargetId: null,
    attack: {
      rangePad: 6,
      damage: 28,
      knockback: 420,
      cd: 1.0,
      windup: 0.22,
      hitstun: 0.18,
    },
    agenda: {
      mode: "OPPORTUNIST", // OPPORTUNIST | EVEN_UP | BULLY
      targetId: "A",
      modeUntil: 0,
      targetUntil: 0,
    },
  };
}

function inFov(agent, ox, oy) {
  const vx = ox - agent.x;
  const vy = oy - agent.y;
  const n = normalize(vx, vy);
  if (n.len < 1e-6) return true;
  const hx = Math.cos(agent.heading);
  const hy = Math.sin(agent.heading);
  const cosang = dot(hx, hy, n.x, n.y);
  const ang = Math.acos(Math.max(-1, Math.min(1, cosang)));
  return ang <= agent.fov * 0.5;
}

function updatePerception(world, agent, opp, j, dt) {
  const now = world.time;
  const unknownDist = hypot(world.width, world.height) * 1.6;
  if (isAgentPhasedOut(agent, now)) {
    agent.senses.opp.dist = Infinity;
    agent.senses.opp.visible = false;
    agent.senses.opp.peripheral = false;
    agent.senses.jug.dist = Infinity;
    agent.senses.jug.visible = false;
    agent.senses.jug.peripheral = false;
    agent.senses.jug.heard = false;
    agent.senses.jug.beliefPos = null;
    agent.senses.jug.beliefDist = unknownDist;
    agent.senses.jug.quality = 0;
    agent.senses.clearance = 0;
    return;
  }
  const s = agent.senses;
  s.clearance = clearance(world, agent.x, agent.y);

  // Opponent sensing: vision + peripheral.
  const oDist = hypot(opp.x - agent.x, opp.y - agent.y);
  const oVis = oDist < 360 && inFov(agent, opp.x, opp.y);
  // Peripheral isn't "behind you"; it still depends on gaze direction a bit.
  const oAng = angleTo(opp.x - agent.x, opp.y - agent.y);
  const oPer =
    !oVis &&
    oDist < 150 &&
    Math.abs(angleDiff(agent.heading, oAng)) < (110 * Math.PI) / 180;
  s.opp.dist = oDist;
  s.opp.visible = oVis;
  s.opp.peripheral = oPer;
  if (oVis || oPer) {
    s.opp.lastSeenAt = now;
    s.opp.lastSeenPos = { x: opp.x, y: opp.y };
  }

  // Juggernaut sensing: vision + peripheral + "hearing" (very coarse).
  const fighting = agent.tactic === "ATTACK" || agent.tactic === "PRESSURE" || agent.tactic === "CLASH";
  const perR = fighting ? 110 : 170;
  const hearR = fighting ? 210 : 320;

  const jDistRaw = j ? hypot(j.x - agent.x, j.y - agent.y) : Infinity;
  const jDist = isFiniteNumber(jDistRaw) ? jDistRaw : Infinity;
  const jContact = j ? (jDist < j.r + agent.r + 10) : false;
  const jNearBody = j ? (jDist < j.r + agent.r + 86) : false;
  const jVis = j ? (jDist < 420 && inFov(agent, j.x, j.y)) : false;
  const jAng = j && isFiniteNumber(j.x) && isFiniteNumber(j.y) ? angleTo(j.x - agent.x, j.y - agent.y) : 0;
  const jPer =
    j
      ? (!jVis &&
        jDist < perR &&
        Math.abs(angleDiff(agent.heading, jAng)) < (115 * Math.PI) / 180)
      : false;
  const jHear = j ? (!jVis && !jPer && jDist < hearR) : false;
  s.jug.dist = jDist;
  s.jug.visible = jVis || jContact;
  s.jug.peripheral = jPer || jHear || jNearBody;
  s.jug.heard = jHear;
  // Only vision/peripheral refresh precise position. "Hearing" keeps you aware but uncertain,
  // which creates a real incentive to look back for confirmation.
  // Very close range acts like tactile/proprioception: you can't "lose" a collider you're brushing against.
  if (jVis || jPer || jNearBody) {
    s.jug.lastSeenAt = now;
    s.jug.lastSeenPos = safePoint({ x: j.x, y: j.y }, s.jug.lastSeenPos);
  }

  const safeLastSeenAt = isFiniteNumber(s.jug.lastSeenAt) ? s.jug.lastSeenAt : -Infinity;
  const age = Math.max(0, now - safeLastSeenAt);
  s.jug.uncertainty = j ? clamp01(age / 3.2) : 0;

  // Belief: if we don't see it, we only have an increasingly-wrong estimate.
  if (!j) {
    s.jug.beliefPos = null;
    s.jug.beliefDist = unknownDist;
    s.jug.quality = 0;
  } else if (jVis || jContact) {
    s.jug.beliefPos = safePoint({ x: j.x, y: j.y }, null);
    s.jug.beliefDist = jDist;
    s.jug.quality = 1;
  } else if (jNearBody) {
    s.jug.beliefPos = safePoint({ x: j.x, y: j.y }, null);
    s.jug.beliefDist = jDist;
    s.jug.quality = 0.9;
  } else if (jPer && safePoint(s.jug.lastSeenPos)) {
    s.jug.beliefPos = safePoint(s.jug.lastSeenPos);
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = 0.75;
  } else if (jHear && safePoint(s.jug.lastSeenPos)) {
    // Heard: position is stale; uncertainty rises quickly.
    const drift = 10 + age * 40;
    const ox = finiteOr(ouStep(finiteOr(s.jug._ox, 0), dt, 0.55, drift), 0);
    const oy = finiteOr(ouStep(finiteOr(s.jug._oy, 0), dt, 0.55, drift), 0);
    s.jug._ox = ox;
    s.jug._oy = oy;
    const lastSeen = safePoint(s.jug.lastSeenPos);
    s.jug.beliefPos = {
      x: clamp(lastSeen.x + ox, 0, world.width),
      y: clamp(lastSeen.y + oy, 0, world.height),
    };
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = 0.38;
  } else if (safePoint(s.jug.lastSeenPos) && age < 4.5) {
    const drift = 14 + age * 55;
    const ox = finiteOr(ouStep(finiteOr(s.jug._ox, 0), dt, 0.7, drift), 0);
    const oy = finiteOr(ouStep(finiteOr(s.jug._oy, 0), dt, 0.7, drift), 0);
    s.jug._ox = ox;
    s.jug._oy = oy;
    const lastSeen = safePoint(s.jug.lastSeenPos);
    s.jug.beliefPos = {
      x: clamp(lastSeen.x + ox, 0, world.width),
      y: clamp(lastSeen.y + oy, 0, world.height),
    };
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = clamp01(0.55 * Math.exp(-age / 2.2));
  } else {
    s.jug.beliefPos = null;
    s.jug.beliefDist = unknownDist;
    s.jug.quality = 0;
  }

  if (!safePoint(s.jug.beliefPos, null)) {
    s.jug.beliefPos = null;
    s.jug.beliefDist = unknownDist;
    s.jug.quality = 0;
  } else if (!isFiniteNumber(s.jug.beliefDist)) {
    const bp = s.jug.beliefPos;
    const d = hypot(agent.x - bp.x, agent.y - bp.y);
    s.jug.beliefDist = isFiniteNumber(d) ? d : Infinity;
  }
  s.jug.quality = clamp01(finiteOr(s.jug.quality, 0));

  // Smooth scan wander (small, non-scripted).
  const retreating =
    agent.tactic === "RETREAT_LONG" || agent.tactic === "RETREAT_SHORT" || agent.tactic === "OPEN_UP";
  const pursued = j && (s.jug.beliefDist < desiredSafeDistToJug(agent) * 1.2 || (j.windupUntil > now && s.jug.quality > 0.6));

  // When pursued, humans don't "scan left/right" constantly; they lock in.
  const scanSigma = pursued || retreating ? 0.0 : 0.22;
  agent.gaze.scanOffset = ouStep(agent.gaze.scanOffset, dt, 0.95, scanSigma);
  agent.gaze.scanOffset = clamp(agent.gaze.scanOffset, -0.35, 0.35);
  if (pursued || retreating) {
    // Actively decay scan toward forward for stability during chase.
    agent.gaze.scanOffset = lerp(agent.gaze.scanOffset, 0, expSmoothing(dt, 0.22));
  }

  agent.gaze.glance.jitter = ouStep(agent.gaze.glance.jitter, dt, 0.9, 0.10);
}

function getAliveAgents(world) {
  return world.agents.filter((a) => a.hp > 0);
}

function stanceIsActive(agent, id, now) {
  return agent.stance?.id === id && now < (agent.stance.activeUntil ?? 0);
}

function endStance(agent, now, cooldownMin, cooldownMax, reason) {
  if (!agent.stance) return;
  agent.stance.id = "NEUTRAL";
  agent.stance.chargingTo = null;
  agent.stance.charge = 0;
  agent.stance.chargeSince = -Infinity;
  agent.stance.chargeDur = 0;
  agent.stance.activeUntil = 0;
  agent.stance.anchor = null;
  agent.stance.reason = reason ?? "";
  agent.stance.cooldownUntil = Math.max(agent.stance.cooldownUntil ?? 0, now + randRange(cooldownMin, cooldownMax));
}

function chooseFortifyAnchor(world, agent, opp, j, rng) {
  const rand = typeof rng === "function" ? rng : Math.random;
  const r = agent.r;
  const center = { x: world.width * 0.5, y: world.height * 0.5 };
  const awayOpp = normalize(agent.x - opp.x, agent.y - opp.y);
  const jugPos = agent.senses?.jug?.beliefPos ?? (j ? { x: j.x, y: j.y } : null);
  const awayJug = jugPos ? normalize(agent.x - jugPos.x, agent.y - jugPos.y) : { x: 0, y: 0, len: 0 };
  const baseDir = normalize(awayOpp.x * 0.65 + awayJug.x * 0.85 + (center.x - agent.x) * 0.0012, awayOpp.y * 0.65 + awayJug.y * 0.85 + (center.y - agent.y) * 0.0012);
  const baseA = baseDir.len > 1e-6 ? angleTo(baseDir.x, baseDir.y) : angleTo(center.x - agent.x, center.y - agent.y);

  const offsets = [-110, -80, -55, -30, -15, 0, 15, 30, 55, 80, 110];
  let best = null;
  for (const od of offsets) {
    const a = baseA + (od * Math.PI) / 180;
    const L = 160 + (260 - 160) * rand();
    const x = clamp(agent.x + Math.cos(a) * L, r, world.width - r);
    const y = clamp(agent.y + Math.sin(a) * L, r, world.height - r);
    const c = clearance(world, x, y);
    const avgC = avgClearanceAlong(world, agent.x, agent.y, x, y, 4);

    let score = 0;
    score += c * 3.0 + avgC * 1.6;
    // Avoid corners, aggressively.
    if (c < 110) score -= (110 - c) * (110 - c) * 0.26;
    // Prefer "behind us" w.r.t. the threats.
    score += awayJug.len > 0 ? dot(Math.cos(a), Math.sin(a), awayJug.x, awayJug.y) * 220 : 0;
    score += awayOpp.len > 0 ? dot(Math.cos(a), Math.sin(a), awayOpp.x, awayOpp.y) * 120 : 0;

    if (!best || score > best.score) best = { x, y, score };
  }
  return best ? { x: best.x, y: best.y } : { x: center.x, y: center.y };
}

function updateStance(world, agent, opp, j, dt) {
  const now = world.time;
  if (!agent.stance) return;
  if (agent.hp <= 0) return;
  if (isAgentPhasedOut(agent, now)) return;

  const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
  const dO = agent.senses?.opp?.dist ?? hypot(agent.x - opp.x, agent.y - opp.y);
  const dJ = j ? (agent.senses?.jug?.beliefDist ?? hypot(agent.x - j.x, agent.y - j.y)) : Infinity;
  const jugQ = agent.senses?.jug?.quality ?? 0;
  const safeDist = j ? desiredSafeDistToJug(agent) : 260;
  const clear = agent.senses?.clearance ?? clearance(world, agent.x, agent.y);
  const speed = hypot(agent.vx, agent.vy);
  const finishP = estimateFinishProb(agent, opp);

  const calm =
    agent.emotions.fear < 0.32 &&
    now - agent.events.gotHitAt > 1.0 &&
    now - agent.events.tookBigHitAt > 1.2 &&
    speed < 70 &&
    agent.hitstunUntil <= now;

  const safeFromJug = !j || dJ > safeDist * 1.32 || jugQ < 0.22;
  const safeFromOpp = dO > 260 || (!agent.senses.opp.visible && !agent.senses.opp.peripheral);
  const threatenedNow =
    (j && dJ < safeDist * 1.05 && jugQ > 0.35) ||
    now - agent.events.jugWindupSeenAt < 0.45 ||
    now - agent.events.oppThreatAt < 0.35;

  // Expire active stance.
  if (agent.stance.id !== "NEUTRAL" && now >= (agent.stance.activeUntil ?? 0)) {
    endStance(agent, now, 3.5, 6.5, "expired");
  }

  // Cancel garrison if danger closes in.
  if (stanceIsActive(agent, "GARRISON", now) && threatenedNow) {
    endStance(agent, now, 4.0, 7.5, "threatened");
  }

  // Charging update.
  if (agent.stance.chargingTo) {
    const want =
      agent.stance.chargingTo === "GARRISON"
        ? calm && hpN < 0.46 && safeFromJug && safeFromOpp && clear > 118 && !threatenedNow
        : calm && hpN > 0.35 && finishP > 0.52 && safeFromJug && (agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 240) && !threatenedNow;

    if (want) {
      agent.stance.charge = clamp01(agent.stance.charge + dt / Math.max(1e-6, agent.stance.chargeDur));
    } else {
      agent.stance.charge = clamp01(agent.stance.charge - (dt * 1.2) / Math.max(1e-6, agent.stance.chargeDur));
      if (agent.stance.charge <= 0.01) {
        agent.stance.chargingTo = null;
        agent.stance.anchor = null;
        agent.stance.reason = "charge cancelled";
      }
    }

    if (agent.stance.charge >= 1.0) {
      const id = agent.stance.chargingTo;
      agent.stance.id = id;
      agent.stance.chargingTo = null;
      agent.stance.charge = 0;
      agent.stance.chargeSince = -Infinity;
      agent.stance.chargeDur = 0;
      agent.stance.activeUntil =
        now + (id === "GARRISON" ? randRange(2.4, 4.2) : randRange(1.2, 2.2));
      agent.stance.reason = id === "GARRISON" ? "fortify" : "push";
      setThought(agent, `${agent.thought} | stance ${id} active`, now);
    }
  }

  // Start charging a stance (rare, deliberate).
  if (agent.stance.id === "NEUTRAL" && !agent.stance.chargingTo && now >= (agent.stance.cooldownUntil ?? 0)) {
    const wantGarrison = calm && hpN < 0.40 && safeFromJug && safeFromOpp && clear > 120 && !threatenedNow;
    const wantAssault = calm && hpN > 0.36 && finishP > 0.58 && safeFromJug && (agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 240) && !threatenedNow;

    // Prioritize survival stance if low HP; otherwise opportunistic assault.
    const startId = wantGarrison ? "GARRISON" : wantAssault ? "ASSAULT" : null;
    if (startId) {
      agent.stance.chargingTo = startId;
      agent.stance.charge = 0;
      agent.stance.chargeSince = now;
      agent.stance.chargeDur = startId === "GARRISON" ? randRange(0.9, 1.55) : randRange(0.55, 1.0);
      // Pick a stable anchor in open space so "fortify" doesn't mean "hide in corner".
      const bucket = Math.floor(now * 1.5);
      const seed = (hashSeed(`stance|${agent.id}|${bucket}|${Math.round(agent.hp)}`) ^ 0x7f4a7c15) >>> 0;
      const rng = makeRng(seed);
      agent.stance.anchor = chooseFortifyAnchor(world, agent, opp, j, rng);
      agent.stance.reason = `charging ${startId.toLowerCase()}`;
      setThought(agent, `${agent.thought} | charge ${startId.toLowerCase()}`, now);
    }
  }
}

function isBlockJustified(world, agent, opp, j) {
  const now = world.time;
  const oDist = agent.senses?.opp?.dist ?? hypot(agent.x - opp.x, agent.y - opp.y);
  const oSeen = agent.senses?.opp?.visible || agent.senses?.opp?.peripheral;

  const meleeReach = MELEE_REACH;
  const hitRange = agent.r + opp.r + meleeReach;

  const oppWinding = opp.attackWindupUntil > now && opp.attackWindupTargetId === agent.id;
  const oppCloseThreat = oSeen && oDist < hitRange * 1.35 && (oppWinding || (opp.tactic === "ATTACK" || opp.tactic === "PRESSURE") && oDist < hitRange * 1.05);

  if (oppCloseThreat) return true;

  if (!j) return false;
  const dJ = agent.senses?.jug?.beliefDist ?? hypot(agent.x - j.x, agent.y - j.y);
  const jugHitRange = agent.r + j.r + j.attack.rangePad;
  const perceivedTell = now - agent.events.jugWindupSeenAt < 0.45;
  const jugWindingForMe = agent.senses?.jug?.visible && j.windupUntil > now && j.windupTargetId === agent.id;

  // Don't omnisciently block: require a tell/visibility, and be within a plausible danger band.
  if ((jugWindingForMe || perceivedTell) && dJ < jugHitRange + 42) return true;
  return false;
}

function getAgent(world, id) {
  return world.agents.find((a) => a.id === id) ?? null;
}

function jugPickTarget(world) {
  const j = world.juggernaut;
  let alive = getAliveAgents(world).filter((a) => !isAgentPhasedOut(a, world.time));
  if (!alive.length) alive = getAliveAgents(world);
  if (!alive.length) return null;

  if (j.agenda.mode === "OPPORTUNIST") {
    let best = alive[0];
    let bestD = Infinity;
    for (const a of alive) {
      const d = hypot(a.x - j.x, a.y - j.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  if (j.agenda.mode === "EVEN_UP") {
    // Chase higher HP to keep the match closer.
    let best = alive[0];
    for (const a of alive) if (a.hp > best.hp) best = a;
    return best;
  }

  // BULLY: chase lower HP.
  let best = alive[0];
  for (const a of alive) if (a.hp < best.hp) best = a;
  return best;
}

function updateJuggernaut(world, dt) {
  const now = world.time;
  const j = world.juggernaut;
  if (!j) return;

  if (now < (j.stunnedUntil ?? 0)) {
    j.vx *= Math.exp(-dt * 16);
    j.vy *= Math.exp(-dt * 16);
    j.windupUntil = 0;
    j.windupTargetId = null;
    return;
  }

  if (now >= j.agenda.modeUntil) {
    const r = random01();
    j.agenda.mode = r < 0.5 ? "OPPORTUNIST" : r < 0.75 ? "EVEN_UP" : "BULLY";
    j.agenda.modeUntil = now + randRange(8, 14);
    j.agenda.targetUntil = 0; // force re-pick
  }

  if (now >= j.agenda.targetUntil) {
    const t = jugPickTarget(world);
    j.agenda.targetId = t ? t.id : j.agenda.targetId;
    j.agenda.targetUntil = now + randRange(2.5, 5.5);
  }

  const target = getAgent(world, j.agenda.targetId) ?? jugPickTarget(world);
  if (!target || target.hp <= 0) return;

  // Chase.
  const to = normalize(target.x - j.x, target.y - j.y);
  const winding = j.windupUntil > now;
  let speed = winding ? j.speed * 0.45 : j.speed;
  if (now < (j.speedBoostUntil ?? 0)) speed *= j.speedBoostMul ?? 1;
  j.vx = to.x * speed;
  j.vy = to.y * speed;
  j.x += j.vx * dt;
  j.y += j.vy * dt;
  j.x = clamp(j.x, j.r, world.width - j.r);
  j.y = clamp(j.y, j.r, world.height - j.r);

  // Start a windup "tell" when in range and cooldown is ready.
  const hitRange = j.r + target.r + j.attack.rangePad;
  const d = hypot(target.x - j.x, target.y - j.y);
  if (now >= j.atkCdUntil && !(j.windupUntil > now) && d <= hitRange) {
    j.windupUntil = now + j.attack.windup;
    j.windupTargetId = target.id;
    // Perceived only if the agent is actually attending/close enough (reduces omniscience).
    for (const ag of world.agents) {
      if (ag.hp <= 0) continue;
      const dd = hypot(ag.x - j.x, ag.y - j.y);
      const fighting = ag.tactic === "ATTACK" || ag.tactic === "PRESSURE" || ag.tactic === "CLASH";
      const per = fighting ? 95 : 160;
      const hear = fighting ? 140 : 240;
      const canSee = dd < 420 && inFov(ag, j.x, j.y);
      const ang = angleTo(j.x - ag.x, j.y - ag.y);
      const canPer = !canSee && dd < per && Math.abs(angleDiff(ag.heading, ang)) < (105 * Math.PI) / 180;
      const canHear = !canSee && !canPer && dd < hear && random01() < 0.35;
      if (canSee || canPer || canHear) ag.events.jugWindupSeenAt = now;
    }
  }
}

function wallRepulsion(world, x, y, r, strength, pad = 110) {
  // Smoothly push away from walls to avoid corner-cowering loops.
  const p = pad;
  const left = x - r;
  const right = world.width - (x + r);
  const top = y - r;
  const bottom = world.height - (y + r);

  let fx = 0;
  let fy = 0;
  if (left < p) fx += (p - left) / p;
  if (right < p) fx -= (p - right) / p;
  if (top < p) fy += (p - top) / p;
  if (bottom < p) fy -= (p - bottom) / p;

  const n = normalize(fx, fy);
  return { x: n.x * strength, y: n.y * strength };
}

function lineCircleClosestDist(ax, ay, bx, by, cx, cy) {
  // Closest distance from point C to segment AB.
  const abx = bx - ax;
  const aby = by - ay;
  const acx = cx - ax;
  const acy = cy - ay;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 > 1e-6 ? clamp((acx * abx + acy * aby) / ab2, 0, 1) : 0;
  const px = ax + abx * t;
  const py = ay + aby * t;
  return hypot(cx - px, cy - py);
}

function jugRouteRisk(world, agent, j, target) {
  // 0..1 scalar for how much the straight-line route runs through the jug's keep-out band.
  // Used in planning/scoring so the agent chooses "go around" or "don't go there" up front.
  if (!j || !target) return { risk: 0, detourCost: 0 };
  const s = agent.senses?.jug;
  const q = s?.quality ?? 0;
  const jugPos = s?.beliefPos ?? (q > 0.6 ? { x: j.x, y: j.y } : null);
  if (!jugPos) return { risk: 0, detourCost: 0 };

  const keepOut = j.r + agent.r + j.attack.rangePad + 30;
  const band = keepOut * 1.35;
  const d = lineCircleClosestDist(agent.x, agent.y, target.x, target.y, jugPos.x, jugPos.y);

  let risk = clamp01((band - d) / Math.max(1e-6, band));

  // Extra penalty if jug is between me and the target along the segment.
  const abx = target.x - agent.x;
  const aby = target.y - agent.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 > 1e-6) {
    const t = clamp(((jugPos.x - agent.x) * abx + (jugPos.y - agent.y) * aby) / ab2, 0, 1);
    const px = agent.x + abx * t;
    const py = agent.y + aby * t;
    const dd = hypot(jugPos.x - px, jugPos.y - py);
    if (t > 0.12 && t < 0.88 && dd < keepOut * 1.05) risk = Math.min(1, risk + 0.55);
  }

  // Lower awareness => less accurate routing fear (but still some).
  const awareMul = clamp(0.25 + q * 0.75, 0.25, 1.0);
  risk *= awareMul;

  // Detouring costs stamina: higher risk implies heavier detour.
  const detourCost = (6 + 18 * risk) * (0.6 + 0.4 * awareMul);
  return { risk: clamp01(risk), detourCost };
}

function jugAvoidance(world, agent, j, target, dt, opts) {
  // Light obstacle avoidance that steers around the juggernaut instead of running through it.
  // Uses *belief* position to avoid omniscience; scales with awareness/quality.
  if (!j || !target) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  const preferRadial = Boolean(opts?.preferRadial);
  const wrapAllowed = Boolean(opts?.wrapAllowed);
  const s = agent.senses?.jug;
  const q = s?.quality ?? 0;
  const jugPos = s?.beliefPos ?? (q > 0.6 ? { x: j.x, y: j.y } : null);
  if (!jugPos) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };

  // Only apply when moving *toward* something (mostly an issue on attack/pressure transitions).
  const toT = normalize(target.x - agent.x, target.y - agent.y);
  if (toT.len < 1e-6) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };

  const a = { x: agent.x, y: agent.y };
  const b = { x: agent.x + toT.x * 320, y: agent.y + toT.y * 320 }; // lookahead segment
  const d = lineCircleClosestDist(a.x, a.y, b.x, b.y, jugPos.x, jugPos.y);

  const threatPad = 16 + (agent.emotions.fear > 0.35 ? 22 : 0);
  const rad = j.r + agent.r + j.attack.rangePad + threatPad;
  if (d >= rad) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };

  const intensity = clamp01((rad - d) / rad);

  // Decide which side to pass on: prefer open clearance.
  const perp = { x: -toT.y, y: toT.x };
  const rel = normalize(jugPos.x - agent.x, jugPos.y - agent.y);
  const baseSign = cross2(toT.x, toT.y, rel.x, rel.y) > 0 ? -1 : 1;
  const testL = {
    x: clamp(agent.x + toT.x * 140 + perp.x * baseSign * 120, agent.r, world.width - agent.r),
    y: clamp(agent.y + toT.y * 140 + perp.y * baseSign * 120, agent.r, world.height - agent.r),
  };
  const testR = {
    x: clamp(agent.x + toT.x * 140 - perp.x * baseSign * 120, agent.r, world.width - agent.r),
    y: clamp(agent.y + toT.y * 140 - perp.y * baseSign * 120, agent.r, world.height - agent.r),
  };
  const cL = clearance(world, testL.x, testL.y);
  const cR = clearance(world, testR.x, testR.y);
  const sign = cR > cL + 10 ? -baseSign : baseSign;

  // Stamina gates the *strength* of detouring so it isn't "free".
  const stamN = clamp01((agent.stamina ?? 0) / 24);
  const stamMul = lerp(0.45, 1.0, stamN);
  const awareMul = clamp(0.25 + q * 0.75, 0.25, 1.0);
  const mul = stamMul * awareMul;

  // Combine tangential steer (go around) with a radial nudge (don't clip).
  const away = normalize(agent.x - jugPos.x, agent.y - jugPos.y);
  const steerMag = (70 + 120 * intensity) * mul;
  // When being chased, we bias away-from-jug unless we explicitly "allow wrap" (style + stamina + situation).
  const tangMul = preferRadial ? 0.15 : wrapAllowed ? 1.0 : 0.35;
  const awayMul = preferRadial ? 1.15 : wrapAllowed ? 0.55 : 1.0;
  const vx = perp.x * sign * steerMag * tangMul + away.x * steerMag * awayMul;
  const vy = perp.y * sign * steerMag * tangMul + away.y * steerMag * awayMul;

  // Stamina cost: detouring is expensive (esp. at higher intensity).
  const costPerSec = (9 + 18 * intensity) * (0.55 + 0.45 * awareMul) * (preferRadial ? 0.8 : 1.0);
  return { vx, vy, intensity, costPerSec };
}

function opponentAvoidance(world, agent, opp, target, dt, opts) {
  // Local steering so we "go around" the other agent instead of beelining through them.
  if (!opp || opp.hp <= 0 || !target) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  const preferTangential = Boolean(opts?.preferTangential);
  const allowClose = Boolean(opts?.allowClose);

  const toT = normalize(target.x - agent.x, target.y - agent.y);
  if (toT.len < 1e-6) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };

  const a = { x: agent.x, y: agent.y };
  const b = { x: agent.x + toT.x * 260, y: agent.y + toT.y * 260 };
  const d = lineCircleClosestDist(a.x, a.y, b.x, b.y, opp.x, opp.y);

  const threatWindup = opp.attackWindupUntil > world.time && opp.attackWindupTargetId === agent.id;
  const pad = (allowClose ? 6 : 18) + (threatWindup ? 22 : 0);
  const rad = agent.r + opp.r + pad;
  if (d >= rad) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  if (allowClose && d < agent.r + opp.r + 10 && !threatWindup) return { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };

  const intensity = clamp01((rad - d) / rad);

  const perp = { x: -toT.y, y: toT.x };
  const rel = normalize(opp.x - agent.x, opp.y - agent.y);
  const baseSign = cross2(toT.x, toT.y, rel.x, rel.y) > 0 ? -1 : 1;
  const testL = {
    x: clamp(agent.x + toT.x * 120 + perp.x * baseSign * 110, agent.r, world.width - agent.r),
    y: clamp(agent.y + toT.y * 120 + perp.y * baseSign * 110, agent.r, world.height - agent.r),
  };
  const testR = {
    x: clamp(agent.x + toT.x * 120 - perp.x * baseSign * 110, agent.r, world.width - agent.r),
    y: clamp(agent.y + toT.y * 120 - perp.y * baseSign * 110, agent.r, world.height - agent.r),
  };
  const cL = clearance(world, testL.x, testL.y);
  const cR = clearance(world, testR.x, testR.y);
  const sign = cR > cL + 8 ? -baseSign : baseSign;

  const away = normalize(agent.x - opp.x, agent.y - opp.y);
  const steerMag = (60 + 120 * intensity) * (preferTangential ? 1.12 : 1.0);
  const tangMul = preferTangential ? 0.95 : (allowClose ? 0.18 : 0.55);
  const awayMul = preferTangential ? 0.55 : (allowClose ? 0.16 : 1.05);
  const vx = perp.x * sign * steerMag * tangMul + away.x * steerMag * awayMul;
  const vy = perp.y * sign * steerMag * tangMul + away.y * steerMag * awayMul;

  // Footwork cost is small vs jug detours, but not free.
  const costPerSec = (2.5 + 6.0 * intensity) * (preferTangential ? 1.15 : 1.0);
  return { vx, vy, intensity, costPerSec };
}

function chooseGlance(world, agent, opp, j) {
  const now = world.time;
  const g = agent.gaze.glance;
  if (!j) return;

  const retreating = agent.tactic === "RETREAT_LONG" || agent.tactic === "RETREAT_SHORT" || agent.tactic === "OPEN_UP";
  if (!retreating) return;

  // Only decide at gates (prevents flip-flopping).
  if (now < g.nextGateAt) return;
  g.nextGateAt = now + randRange(0.10, 0.22);

  if (now < g.cooldownUntil) return;
  if (g.activeUntil > now) return;

  const timeInCommit = Math.max(0, now - agent.events.lastDecisionAt);
  const startedSprint = timeInCommit < 0.55 ? 1 : 0;
  const clearanceHere = agent.senses.clearance;

  // Urge rises with uncertainty and time since last glance, but drops if it's costly now.
  const since = Math.max(0, now - g.lastAt);
  const uncertainty = agent.senses.jug.uncertainty;
  const jDist = agent.senses.jug.beliefDist;
  const safeDist = desiredSafeDistToJug(agent);
  const tooClose = clamp01((safeDist * 0.8 - jDist) / (safeDist * 0.8));
  const nearWall = clamp01((120 - clearanceHere) / 120);

  let urge =
    0.12 +
    0.75 * uncertainty +
    0.18 * clamp01(since / 2.2) +
    0.22 * clamp01((safeDist - jDist) / safeDist);

  // Human-like cost terms.
  urge -= startedSprint * 0.35; // still less likely immediately, but not "never"
  urge -= nearWall * 0.35;
  urge -= tooClose * 0.55; // if too close, keep running; don't risk glance

  // If opponent is very close, avoid glancing (fight awareness).
  const oDist = agent.senses.opp.dist;
  if (oDist < 110) urge -= 0.35;

  g.urge = clamp01(urge);

  const baseThresh = 0.58 - agent.emotions.fear * 0.22;
  const thresh = clamp(baseThresh + g.jitter * 0.35, 0.25, 0.85);
  if (g.urge < thresh) return;

  // Determine "where I think the jug is" (belief > last seen > fallback).
  let tx = j.x;
  let ty = j.y;
  if (agent.senses.jug.beliefPos) {
    tx = agent.senses.jug.beliefPos.x;
    ty = agent.senses.jug.beliefPos.y;
  } else if (agent.senses.jug.lastSeenPos) {
    tx = agent.senses.jug.lastSeenPos.x;
    ty = agent.senses.jug.lastSeenPos.y;
  }
  g.targetAngle = angleTo(tx - agent.x, ty - agent.y);

  // Duration: enough to swing gaze toward the jug (not a fixed cadence).
  const turnRate = ((agent.emotions.fear > 0.35 ? 260 : 210) * Math.PI) / 180;
  const need = Math.max(0, Math.abs(angleDiff(agent.heading, g.targetAngle)) - agent.fov * 0.45);
  const dur = clamp(0.12 + need / Math.max(1e-6, turnRate), 0.14, agent.emotions.fear > 0.55 ? 0.28 : 0.36);
  g.activeUntil = now + dur;
  g.lastAt = now;

  // During the glance, running is slightly worse (selling the tradeoff).
  g.speedMul = lerp(0.82, 0.93, 1 - agent.emotions.fear);
  g.accelMul = lerp(0.78, 0.95, 1 - agent.emotions.fear);

  // Cooldown: jittered and state-dependent (avoids scripted cadence).
  g.cooldownUntil = now + randRange(0.40, 1.25) * lerp(1.05, 0.75, agent.emotions.fear);

  agent.gaze.mode = "GLANCE_JUG";
  agent.thought = `${agent.thought} | glance (urge=${g.urge.toFixed(2)} cost=${startedSprint ? "sprint" : nearWall > 0.4 ? "wall" : "ok"})`;
}

function chooseGazeTarget(world, agent, opp, j, moveAngle, dt) {
  const now = world.time;
  const g = agent.gaze.glance;

  // Possibly start a glance (decision-gated).
  chooseGlance(world, agent, opp, j);

  // Active glance wins.
  if (g.activeUntil > now) {
    agent.gaze.mode = "GLANCE_JUG";
    return { angle: g.targetAngle, speedMul: g.speedMul, accelMul: g.accelMul };
  }

  // While blocking, don't "scan": lock gaze to the most relevant threat.
  if (agent.tactic === "BLOCK") {
    const oSeen = agent.senses.opp.visible || agent.senses.opp.peripheral;
    const oDist = agent.senses.opp.dist;
    if (oSeen && oDist < 220) {
      agent.gaze.mode = "OPP";
      return { angle: angleTo(opp.x - agent.x, opp.y - agent.y), speedMul: 1, accelMul: 1 };
    }
    if (j && ((agent.senses.jug.visible && j.windupUntil > now) || now - agent.events.jugWindupSeenAt < 0.55)) {
      agent.gaze.mode = "JUG";
      const jp = agent.senses.jug.beliefPos ?? { x: j.x, y: j.y };
      return { angle: angleTo(jp.x - agent.x, jp.y - agent.y), speedMul: 1, accelMul: 1 };
    }
    agent.gaze.mode = "MOVE";
    const a = Number.isFinite(moveAngle) ? moveAngle : agent.heading;
    return { angle: a, speedMul: 1, accelMul: 1 };
  }

  // ENFP-ish social curiosity: occasionally look at the other agent when it's safe.
  const safeToSocial = !j || agent.senses.jug.beliefDist > desiredSafeDistToJug(agent) * 1.25 || agent.senses.jug.quality < 0.35;
  if (safeToSocial && now >= agent.gaze.socialCooldownUntil && now - agent.events.gotHitAt > 0.4) {
    const chance = 0.12 + agent.emotions.curiosity * 0.18;
    if (random01() < chance) {
      agent.gaze.socialUntil = now + randRange(0.22, 0.62);
      agent.gaze.socialCooldownUntil = now + randRange(1.0, 2.4);
    }
  }

  if (agent.gaze.socialUntil > now && agent.senses.opp.dist < 520) {
    agent.gaze.mode = "OPP";
    return { angle: angleTo(opp.x - agent.x, opp.y - agent.y), speedMul: 1, accelMul: 1 };
  }

  // If we noticed the opponent in peripheral vision, snap gaze to them briefly (human reflex).
  if (agent.senses.opp.peripheral && now - agent.senses.opp.lastSeenAt < 0.35 && (!j || agent.senses.jug.dist > 220)) {
    agent.gaze.mode = "OPP";
    return { angle: angleTo(opp.x - agent.x, opp.y - agent.y), speedMul: 1, accelMul: 1 };
  }

  // When attacking/pressuring, look at the opponent (humanly readable).
  if (agent.tactic === "ATTACK" || agent.tactic === "PRESSURE") {
    agent.gaze.mode = "OPP";
    return { angle: angleTo(opp.x - agent.x, opp.y - agent.y), speedMul: 1, accelMul: 1 };
  }

  // If jug is winding up and we can actually tell (or just saw the tell), look at it.
  if (j && ((agent.senses.jug.visible && j.windupUntil > now) || now - agent.events.jugWindupSeenAt < 0.45)) {
    agent.gaze.mode = "JUG";
    const jp = agent.senses.jug.beliefPos ?? { x: j.x, y: j.y };
    return { angle: angleTo(jp.x - agent.x, jp.y - agent.y), speedMul: 1, accelMul: 1 };
  }

  // Otherwise: look where we move, with a gentle scan wander so it doesn't feel robotic.
  agent.gaze.mode = "MOVE";
  const a = Number.isFinite(moveAngle) ? moveAngle : agent.heading;
  const pursued =
    j && agent.senses.jug.beliefDist < desiredSafeDistToJug(agent) * 1.15 && agent.senses.jug.quality > 0.3;
  return { angle: pursued ? a : wrapAngle(a + agent.gaze.scanOffset), speedMul: 1, accelMul: 1 };
}

function steerTo(agent, tx, ty, speed, dt, extraFx = 0, extraFy = 0) {
  const to = normalize(tx - agent.x, ty - agent.y);
  const desiredVx = to.x * speed + extraFx;
  const desiredVy = to.y * speed + extraFy;

  // A bit of motor lag keeps motion from looking perfectly robotic.
  const lagA = expSmoothing(dt, 0.08);
  agent.motor.desiredVx = lerp(agent.motor.desiredVx, desiredVx, lagA);
  agent.motor.desiredVy = lerp(agent.motor.desiredVy, desiredVy, lagA);

  const ax = agent.motor.desiredVx - agent.vx;
  const ay = agent.motor.desiredVy - agent.vy;
  const an = normalize(ax, ay);

  const maxDv = agent.maxAccel * dt;
  const dv = Math.min(maxDv, an.len);
  agent.vx += an.x * dv;
  agent.vy += an.y * dv;
}

function damp(agent, dt, strength = 5.0) {
  const d = Math.exp(-dt * strength);
  agent.vx *= d;
  agent.vy *= d;
  agent.motor.desiredVx *= d;
  agent.motor.desiredVy *= d;
}

function separate(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const d = hypot(dx, dy);
  const minD = a.r + b.r;
  if (d < 1e-6 || d >= minD) return;
  const n = normalize(dx, dy);
  const push = (minD - d) * 0.5;
  a.x += n.x * push;
  a.y += n.y * push;
  b.x -= n.x * push;
  b.y -= n.y * push;
}

function separateMobileStatic(mobile, wall) {
  // Push only the mobile entity away (juggernaut shouldn't be shoved around).
  const dx = mobile.x - wall.x;
  const dy = mobile.y - wall.y;
  const d = hypot(dx, dy);
  const minD = mobile.r + wall.r;
  if (d < 1e-6 || d >= minD) return;
  const n = normalize(dx, dy);
  const push = minD - d;
  mobile.x += n.x * push;
  mobile.y += n.y * push;

  // Add a small tangential slide impulse on contact so entities don't repeatedly "thrust into" the same normal.
  const tang = { x: -n.y, y: n.x };
  const tangDir = dot(mobile.vx, mobile.vy, tang.x, tang.y) >= 0 ? 1 : -1;
  const slide = Math.max(20, hypot(mobile.vx, mobile.vy) * 0.24);
  mobile.vx = lerp(mobile.vx, tang.x * tangDir * slide, 0.18);
  mobile.vy = lerp(mobile.vy, tang.y * tangDir * slide, 0.18);
}

function upsertSpot(list, spot, mergeDist) {
  const md = mergeDist ?? 85;
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = hypot(list[i].x - spot.x, list[i].y - spot.y);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  if (bestI >= 0 && bestD < md) {
    const s = list[bestI];
    const w = clamp01(spot.score / Math.max(1e-6, s.score + spot.score));
    s.x = lerp(s.x, spot.x, w);
    s.y = lerp(s.y, spot.y, w);
    s.score = Math.max(s.score, spot.score);
    s.lastAt = spot.lastAt;
  } else {
    list.push({ ...spot });
  }
  list.sort((a, b) => b.score - a.score);
  while (list.length > 10) list.pop();
}

function escapeInfluenceFromSpots(agent, candX, candY, dirX, dirY) {
  let safeBonus = 0;
  let trapPenalty = 0;

  for (let i = 0; i < Math.min(6, agent.mem.safeSpots.length); i++) {
    const sp = agent.mem.safeSpots[i];
    const dx = sp.x - agent.x;
    const dy = sp.y - agent.y;
    const d = hypot(dx, dy);
    const n = normalize(dx, dy);
    const align = dot(dirX, dirY, n.x, n.y);
    if (align < 0.2) continue;
    safeBonus += sp.score * Math.exp(-d / 240) * align * 0.45;
  }

  for (let i = 0; i < Math.min(6, agent.mem.trapSpots.length); i++) {
    const sp = agent.mem.trapSpots[i];
    const dx = sp.x - candX;
    const dy = sp.y - candY;
    const d = hypot(dx, dy);
    trapPenalty += sp.score * Math.exp(-d / 190) * 0.6;
  }

  return { safeBonus, trapPenalty };
}

function pickOpenTarget(world, agent, baseAngle, distMin, distMax, rng) {
  // Sample around baseAngle and pick the most open target (plus safe/trap memory).
  const rand = typeof rng === "function" ? rng : Math.random;
  const r = agent.r;
  const offsets = [-90, -60, -35, -15, 0, 15, 35, 60, 90];
  let best = null;
  for (const od of offsets) {
    const a = baseAngle + (od * Math.PI) / 180;
    const L = distMin + (distMax - distMin) * rand();
    const cx = clamp(agent.x + Math.cos(a) * L, r, world.width - r);
    const cy = clamp(agent.y + Math.sin(a) * L, r, world.height - r);
    const c = clearance(world, cx, cy);
    const avgC = avgClearanceAlong(world, agent.x, agent.y, cx, cy, 4);
    const dir = normalize(cx - agent.x, cy - agent.y);
    const { safeBonus, trapPenalty } = escapeInfluenceFromSpots(agent, cx, cy, dir.x, dir.y);

    // Prefer opening up; avoid huge reversals unless needed.
    let score = 0;
    score += c * 2.8 + avgC * 1.7;
    score += safeBonus;
    score -= trapPenalty;
    score -= Math.abs(angleDiff(agent.heading, a)) * 9;

    if (!best || score > best.score) best = { x: cx, y: cy, score };
  }
  return best ?? { x: world.width * 0.5, y: world.height * 0.5 };
}

function learnedEma(mean, obs, rate) {
  const a = clamp01(rate);
  return mean * (1 - a) + obs * a;
}

function estimateFinishProb(agent, opp) {
  // Probability opponent is low enough to be finished soon (belief-only).
  const b = agent.belief.opponentHp;
  const mean = b.mean;
  const std = Math.sqrt(Math.max(1e-6, b.var));
  const thresh = 18;
  // Rough normal CDF approximation via logistic.
  const z = (thresh - mean) / Math.max(1e-6, std);
  return 1 / (1 + Math.exp(-1.7 * z));
}

function desiredSafeDistToJug(agent) {
  const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
  const dmg = Math.max(1, agent.belief.jugDamage.mean);
  const lethal = clamp01((dmg / agent.maxHp) * 3.6);
  const base = 150 + 100 * lethal;
  const lowHpExtra = 110 * (1 - hpN);
  return clamp(base + lowHpExtra, 150, 380);
}

function predictJugDamage(nowTime, agent, j, candTarget, horizonSec) {
  if (!j) return 0;
  const meanDmg = agent.belief.jugDamage.mean;
  const hitRange = agent.r + j.r + j.attack.rangePad;
  const dNow = hypot(agent.x - j.x, agent.y - j.y);
  const dNext = hypot(candTarget.x - j.x, candTarget.y - j.y);

  // Approximate time-to-contact vs time-to-swing with a windup "tell".
  const safeDist = desiredSafeDistToJug(agent);
  const closeNow = clamp01((safeDist - dNow) / safeDist);
  const closeNext = clamp01((safeDist - dNext) / safeDist);

  const dMin = Math.min(dNow, dNext);
  const relSpeed = Math.max(1e-6, j.speed);
  const timeToContact = Math.max(0, (dMin - hitRange) / relSpeed);

  let timeToSwing = Math.max(0, j.atkCdUntil - nowTime) + j.attack.windup;
  if (j.windupUntil > nowTime) timeToSwing = Math.max(0, j.windupUntil - nowTime);

  // If already in range and cd ready, assume the tell starts immediately.
  if (dNow <= hitRange && nowTime >= j.atkCdUntil && !(j.windupUntil > nowTime)) timeToSwing = j.attack.windup * 0.8;

  const inHorizon = timeToContact <= horizonSec ? 1 : 0;
  const swingInHorizon = timeToSwing <= horizonSec ? 1 : 0;

  // Overlap: contact near the swing time is the high-danger band.
  const timing = Math.abs(timeToContact - timeToSwing);
  const timingRisk = clamp01(1 - timing / 0.42);

  const p = clamp01(
    0.05 +
      0.65 * Math.max(closeNow, closeNext) +
      0.55 * timingRisk * inHorizon * swingInHorizon,
  );
  return meanDmg * p;
}

function predictOppDamage(agent, opp, candTarget) {
  if (!opp || opp.hp <= 0) return 0;
  const mean = agent.belief.oppDamage.mean;
  const meleeReach = MELEE_REACH;
  const hitRange = agent.r + opp.r + meleeReach;
  const d = hypot(candTarget.x - opp.x, candTarget.y - opp.y);
  // Very coarse: if you end up in range, assume moderate chance of being hit soon.
  const p = d < hitRange ? 0.85 : d < hitRange * 1.6 ? 0.35 : 0.08;
  return mean * p;
}

function predictDealDamage(agent, opp, candTarget) {
  if (!opp || opp.hp <= 0) return 0;
  const meleeReach = MELEE_REACH;
  const hitRange = agent.r + opp.r + meleeReach;
  const d = hypot(candTarget.x - opp.x, candTarget.y - opp.y);
  const p = d < hitRange ? 0.9 : d < hitRange * 1.4 ? 0.25 : 0.05;
  return agent.belief.oppDamage.mean * p;
}

function getOpponentAgent(world, agent) {
  for (const other of world.agents) {
    if (other.id !== agent.id) return other;
  }
  return null;
}

function isTwirlRushActive(agent, now) {
  return Boolean(agent?.fx && now < (agent.fx.twirlUntil ?? 0));
}

function getAgentSpeedMul(agent, now) {
  let mul = 1;
  if (agent.fx && now < (agent.fx.speedMulUntil ?? 0)) mul *= agent.fx.speedMul ?? 1;
  if (agent.fx && now < (agent.fx.rosinUntil ?? 0)) mul *= 0.5;
  if (agent.fx && now < (agent.fx.lockInUntil ?? 0)) mul *= 1.2;
  if (agent.fx && now < (agent.fx.actingUntil ?? 0) && (agent.fx.actingHitsLeft ?? 0) > 0) mul *= 1.2;
  const sport = clamp(agent.fx?.sportsScale ?? 0, 0, 0.35);
  mul *= 1 + sport;
  return mul;
}

function getAgentAttackSpeedMul(agent, now) {
  let mul = 1;
  if (agent.fx && now < (agent.fx.attackSpeedUntil ?? 0)) mul *= agent.fx.attackSpeedMul ?? 1;
  if (agent.fx && now < (agent.fx.rosinUntil ?? 0)) mul *= 0.5;
  if (agent.fx && now < (agent.fx.lockInUntil ?? 0)) mul *= 1.16;
  if (agent.fx && now < (agent.fx.actingUntil ?? 0) && (agent.fx.actingHitsLeft ?? 0) > 0) mul *= 1.14;
  const sport = clamp(agent.fx?.sportsScale ?? 0, 0, 0.35);
  mul *= 1 + sport * 0.7;
  if (agent.hobby?.id === "KNITTING_CROCHET") mul *= 0.66;
  return mul;
}

function getAgentDamageOutMul(agent, now) {
  let mul = 1;
  if (agent.fx && now < (agent.fx.damageOutUntil ?? 0)) mul *= agent.fx.damageOutMul ?? 1;
  if (agent.fx && now < (agent.fx.reduceDamageOutUntil ?? 0)) mul *= 0.5;
  if (agent.fx && now < (agent.fx.lockInUntil ?? 0)) mul *= 1.15;
  if (agent.fx && now < (agent.fx.actingUntil ?? 0) && (agent.fx.actingHitsLeft ?? 0) > 0) mul *= 1.35;
  const sport = clamp(agent.fx?.sportsScale ?? 0, 0, 0.35);
  mul *= 1 + sport * 0.6;
  if (agent.hobby?.id === "KNITTING_CROCHET") mul *= 1.45;
  return mul;
}

function getAgentDamageTakenMul(agent, now) {
  let mul = 1;
  if (agent.fx && now < (agent.fx.damageTakenUntil ?? 0)) mul *= agent.fx.damageTakenMul ?? 1;
  if (agent.fx && now < (agent.fx.rosinUntil ?? 0)) mul *= 0.7;
  const sport = clamp(agent.fx?.sportsScale ?? 0, 0, 0.35);
  mul *= 1 - sport * 0.18;
  return clamp(mul, 0.1, 2);
}

function isAgentInvulnerable(agent, now) {
  if (!agent) return false;
  if (isAgentPhasedOut(agent, now)) return true;
  return now < (agent.fx?.invulnUntil ?? 0) || now < (agent.fx?.progressiveStoreUntil ?? 0);
}

function abilityMarker(world, x, y, color = "rgba(255, 140, 80, 0.45)", life = 0.75, radius = 34, label = "", kind = "GENERIC") {
  world.ability.markers.push({
    x,
    y,
    color,
    startAt: world.time,
    until: world.time + life,
    radius,
    label,
    kind,
  });
}

function applyAgentHeal(agent, amount) {
  const heal = Math.max(0, amount);
  agent.hp = clamp(agent.hp + heal, 0, agent.maxHp);
}

function applyAgentAbsorb(agent, amount) {
  agent.absorbHp = clamp((agent.absorbHp ?? 0) + Math.max(0, amount), 0, 999);
}

function applyAbilityDamageToAgent(world, target, source, amount, knockback = 0, hitstun = 0.08) {
  if (!target || target.hp <= 0) return 0;
  const src = source ?? { kind: "ABILITY", id: null, x: target.x, y: target.y };
  return applyDamage(world, target, src, amount, knockback, hitstun);
}

function applyStunToAgent(agent, until) {
  if (!agent) return;
  agent.hitstunUntil = Math.max(agent.hitstunUntil ?? 0, until);
}

function applyStunToJug(world, duration) {
  const j = world.juggernaut;
  if (!j) return;
  j.stunnedUntil = Math.max(j.stunnedUntil ?? 0, world.time + Math.max(0, duration));
}

function applyDamage(world, victim, source, dmg, knockback, hitstun) {
  const now = world.time;
  if (!victim || victim.hp <= 0) return 0;
  if (isAgentPhasedOut(victim, now)) return 0;

  const fx = victim.fx ?? {};
  if (now < (fx.progressiveStoreUntil ?? 0)) {
    fx.progressiveStoredDamage = (fx.progressiveStoredDamage ?? 0) + Math.max(0, dmg);
    return 0;
  }
  if (isAgentInvulnerable(victim, now)) return 0;

  const blocking = now < victim.blockUntil;
  let dmgScale = 1.0;
  let kbScale = 1.0;

  // Stance effects: fortify reduces damage/knockback; assault is riskier.
  if (victim.stance?.id === "GARRISON") {
    dmgScale *= 0.82;
    kbScale *= 0.72;
  } else if (victim.stance?.id === "ASSAULT") {
    dmgScale *= 1.05;
  }
  dmgScale *= getAgentDamageTakenMul(victim, now);

  if (blocking) {
    const t = now - (victim.blockRaisedAt ?? -Infinity);
    let bd = 1.0;
    let bk = 1.0;
    // Strongest if raised shortly before impact.
    if (t < 0.12) {
      bd = 0.52;
      bk = 0.58;
    } else if (t < 0.22) {
      bd = 0.62;
      bk = 0.66;
    } else {
      bd = 0.8;
      bk = 0.82;
    }
    if (source?.kind === "JUG") {
      bd = clamp(bd + 0.14, 0.2, 0.95);
      bk = clamp(bk + 0.18, 0.2, 0.98);
    }
    dmgScale *= bd;
    kbScale *= bk;
  }

  const preAbsorb = Math.max(0, dmg * dmgScale);
  const absorb = Math.min(victim.absorbHp ?? 0, preAbsorb);
  let dealt = preAbsorb - absorb;
  if (absorb > 0) {
    victim.absorbHp -= absorb;
    if (source?.kind === "JUG") dealt += absorb * 0.38;
  }
  if (source?.kind === "JUG") {
    const minChip = dmg * (blocking ? 0.22 : 0.1);
    dealt = Math.max(dealt, minChip);
  }
  victim.hp = Math.max(0, victim.hp - dealt);
  if (dealt > 0) {
    victim.hitstunUntil = Math.max(victim.hitstunUntil, now + hitstun);
    victim.events.gotHitAt = now;
    if (dealt > victim.maxHp * 0.18) victim.events.tookBigHitAt = now;
  }

  const away = normalize(victim.x - source.x, victim.y - source.y);
  if (dealt > 0 || absorb > 0) {
    victim.vx += away.x * knockback * kbScale;
    victim.vy += away.y * knockback * kbScale;
  }

  // Learning: victim learns exact incoming damage for that source type.
  if (source.kind === "JUG") {
    const rate = victim.hp > 0 ? 0.28 : 0.45;
    victim.belief.jugDamage.mean = learnedEma(victim.belief.jugDamage.mean, dealt, rate);
    victim.belief.jugDamage.var = learnedEma(victim.belief.jugDamage.var, (dealt - victim.belief.jugDamage.mean) ** 2, 0.2);
  } else if (source.kind === "AGENT") {
    victim.belief.oppDamage.mean = learnedEma(victim.belief.oppDamage.mean, dealt, 0.22);
    victim.belief.oppDamage.var = learnedEma(victim.belief.oppDamage.var, (dealt - victim.belief.oppDamage.mean) ** 2, 0.2);
    victim.events.oppThreatAt = now;
    victim.events.engageUntil = Math.max(victim.events.engageUntil ?? -Infinity, now + randRange(1.1, 1.9));
  }

  // Trap learning: getting hit near walls is a "trap spot".
  const c = clearance(world, victim.x, victim.y);
  if (c < 70) {
    upsertSpot(victim.mem.trapSpots, { x: victim.x, y: victim.y, score: (80 - c) * 1.2, lastAt: now }, 95);
  }

  // Wind instrument reflect.
  if (dealt > 0 && source.kind === "AGENT" && victim.fx && victim.fx.reflectCharges > 0 && source.id) {
    const srcAg = getAgent(world, source.id);
    if (srcAg && srcAg.hp > 0) {
      victim.fx.reflectCharges = Math.max(0, victim.fx.reflectCharges - 1);
      const reflect = dealt * clamp(victim.fx.reflectRatio ?? 1, 0, 2);
      applyDamage(
        world,
        srcAg,
        { kind: "REFLECT", id: victim.id, x: victim.x, y: victim.y },
        reflect,
        120,
        0.06,
      );
      setThought(victim, `${victim.thought} | reflect`, now);
    }
  }

  // Flambe on-hit burn.
  if (dealt > 0 && source.kind === "AGENT" && source.id) {
    const srcAg = getAgent(world, source.id);
    if (srcAg && now < (srcAg.fx?.flambedUntil ?? 0)) {
      victim.fx.burnUntil = Math.max(victim.fx.burnUntil ?? 0, now + 5);
      victim.fx.burnDps = Math.max(victim.fx.burnDps ?? 0, 0.9);
      victim.fx.burnTickAt = Math.min(victim.fx.burnTickAt ?? now, now + 0.2);
    }
  }

  // Theatre acting form ends after taking two real hits.
  if (dealt > 0 && victim.fx && victim.fx.actingHitsLeft > 0) {
    victim.fx.actingHitsLeft -= 1;
    if (victim.fx.actingHitsLeft <= 0) {
      victim.fx.actingUntil = now;
      setThought(victim, `${victim.thought} | acting ends`, now);
    }
  }

  return dealt;
}

function updateOpponentHpBelief(observer, opponent, observedDamage, now) {
  // Keep it uncertain/noisy: AIs don't know exact HP.
  const b = observer.belief.opponentHp;
  const noise = randRange(0.85, 1.25);
  const delta = observedDamage * noise;
  b.mean = clamp(b.mean - delta, 0, opponent.maxHp);
  b.var = clamp(b.var + observedDamage * 3.0, 30, 80 * 80);
  b.updatedAt = now;
}

function setThought(agent, msg, now) {
  agent.thought = msg;
  if (Number.isFinite(now)) agent.thoughtSince = now;
}

function updateEmotions(world, agent, opp, j, dt) {
  // Simple, readable affect model:
  // - fear: jug proximity + jug windup + big hit aftershocks
  // - anger: being hit + opponent threat proximity
  // - joy: recent hit dealt + advantage moments
  // - sadness: low HP + taking damage
  // - curiosity: safe/open moments + distance from threats
  const now = world.time;
  const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));

  const dJ = j ? agent.senses.jug.beliefDist : Infinity;
  const safeDist = j ? desiredSafeDistToJug(agent) : 260;
  const jugProx = j ? clamp01((safeDist - dJ) / safeDist) : 0;
  const jugWind = now - agent.events.jugWindupSeenAt < 0.6 ? 1 : 0;

  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const oppProx = clamp01((120 - dO) / 120);
  const oppThreat = now - agent.events.oppThreatAt < 0.55 ? 1 : 0;

  const hitShock = clamp01(1 - (now - agent.events.gotHitAt) / 1.4);
  const bigShock = clamp01(1 - (now - agent.events.tookBigHitAt) / 2.2);
  const joyBurst = clamp01(1 - (now - agent.events.dealtHitAt) / 1.1) * clamp01(agent.events.dealtDamage / 12);

  const c = clearance(world, agent.x, agent.y);
  const open = clamp01((c - 70) / 180);
  const safeMoment = clamp01(open * (1 - jugProx) * (1 - oppProx));

  const fearT = clamp01(0.05 + jugProx * 0.9 + jugWind * 0.55 + bigShock * 0.35);
  const angerT = clamp01(0.05 + hitShock * 0.6 + oppThreat * 0.35 + oppProx * 0.25);
  const joyT = clamp01(0.08 + joyBurst * 0.95 + safeMoment * 0.35 - fearT * 0.25);
  const sadT = clamp01(0.04 + (1 - hpN) * 0.65 + hitShock * 0.25);
  const curT = clamp01(0.08 + safeMoment * 0.65 - fearT * 0.45 - angerT * 0.15);

  const tau = 0.35; // faster than v1.2; combat is more volatile
  const a = expSmoothing(dt, tau);
  agent.emotions.joy = lerp(agent.emotions.joy, joyT, a);
  agent.emotions.fear = lerp(agent.emotions.fear, fearT, a);
  agent.emotions.anger = lerp(agent.emotions.anger, angerT, a);
  agent.emotions.sadness = lerp(agent.emotions.sadness, sadT, a);
  agent.emotions.curiosity = lerp(agent.emotions.curiosity, curT, a);
}

function distPointSeg(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const vv = vx * vx + vy * vy;
  const t = vv > 1e-9 ? clamp((wx * vx + wy * vy) / vv, 0, 1) : 0;
  const cx = x1 + vx * t;
  const cy = y1 + vy * t;
  return hypot(px - cx, py - cy);
}

function chooseAbilitySlot(world, agent, opp, manual = false) {
  const spec = getHobbySpec(agent.hobby?.id);
  const primary = getAbilitySlot(spec, "primary");
  const secondary = getAbilitySlot(spec, "secondary");
  if (!secondary) return "primary";

  const now = world.time;
  const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
  const dO = opp ? hypot(agent.x - opp.x, agent.y - opp.y) : Infinity;
  const threatened = now - (agent.events?.jugWindupSeenAt ?? -Infinity) < 0.5;
  const lowHp = hpN < 0.55;
  const closeFight = dO < 210;

  if (manual) {
    if (primary.kind === "defensive" && (lowHp || threatened)) return "primary";
    if (secondary.kind === "offensive" && closeFight) return "secondary";
    if (primary.kind === "neutral") return "primary";
    if (!lowHp && secondary.kind === "offensive") return "secondary";
    return "primary";
  }

  if (primary.kind === "defensive" && (lowHp || threatened)) return "primary";
  if (secondary.kind === "offensive" && (closeFight || (opp && opp.hp < opp.maxHp * 0.45))) return "secondary";
  if (primary.kind === "neutral" && random01() < 0.58) return "primary";
  if (secondary.kind === "offensive" && random01() < 0.42) return "secondary";
  return secondary ? "secondary" : "primary";
}

function canUseAbilitySlot(world, agent, slotName) {
  const now = world.time;
  if (!agent || agent.hp <= 0) return false;
  if (isAgentPhasedOut(agent, now)) return false;
  if (now < (agent.hobby?.castGlobalUntil ?? 0)) return false;
  const cdUntil =
    slotName === "secondary"
      ? (agent.hobby?.secondaryCooldownUntil ?? 0)
      : (agent.hobby?.primaryCooldownUntil ?? 0);
  return now >= cdUntil;
}

function setAbilityCooldown(world, agent, slotName, ability) {
  const now = world.time;
  const cd = Math.max(0.25, ability?.cooldown ?? 12);
  if (slotName === "secondary") agent.hobby.secondaryCooldownUntil = now + cd;
  else agent.hobby.primaryCooldownUntil = now + cd;
  agent.hobby.castGlobalUntil = now + 0.32;
}

function addKeyboardTask(world, agent, mode) {
  const now = world.time;
  const r = 94;
  const taskX = clamp(agent.x + randRange(-180, 180), r, world.width - r);
  const taskY = clamp(agent.y + randRange(-180, 180), r, world.height - r);
  const keyX = clamp(taskX + randRange(-56, 56), 24, world.width - 24);
  const keyY = clamp(taskY + randRange(-56, 56), 24, world.height - 24);
  const task = {
    id: `${agent.id}|${mode}|${Math.floor(now * 1000)}|${Math.floor(randRange(0, 10000))}`,
    ownerId: agent.id,
    mode,
    x: taskX,
    y: taskY,
    r,
    keyX,
    keyY,
    keyR: 20,
    until: now + 16,
  };
  world.ability.keyboardTasks.push(task);
  agent.fx.keyboardTaskId = task.id;
  abilityMarker(world, taskX, taskY, mode === "heal" ? "rgba(100,190,120,0.35)" : "rgba(250,120,90,0.35)", 1.2, 44, "KBD");
}

function getKeyboardTaskForAgent(world, agent) {
  if (!agent) return null;
  const now = world.time;
  const wantedId = agent.fx?.keyboardTaskId;
  for (const task of world.ability.keyboardTasks) {
    if (task.ownerId !== agent.id) continue;
    if (now >= task.until) continue;
    if (!wantedId || task.id === wantedId) return task;
  }
  return null;
}

function finalizePlayerDrawFire(world, reason = "done") {
  const draw = world?.player?.drawFire;
  if (!draw) return false;
  const now = world.time;
  const points = Array.isArray(draw.points) ? draw.points : [];
  if (points.length >= 2) {
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const segLen = hypot(p1.x - p0.x, p1.y - p0.y);
      if (segLen < 2) continue;
      world.ability.zones.push({
        kind: "DRAW_FIRE_TRAIL",
        ownerId: draw.ownerId ?? world.player.controlledId ?? "A",
        x1: p0.x,
        y1: p0.y,
        x2: p1.x,
        y2: p1.y,
        r: 14,
        startAt: now,
        until: now + 6,
        tickAt: now,
        dps: 3.2,
        color: "rgba(255,120,80,0.30)",
      });
    }
    const center = points[Math.floor(points.length * 0.5)];
    if (center) abilityMarker(world, center.x, center.y, "rgba(255,150,90,0.45)", 1.05, 42, reason === "timeout" ? "IGNITE" : "DRAW");
  }
  world.player.drawFire = null;
  return points.length >= 2;
}

function beginPlayerDrawFire(world, agent) {
  const now = world.time;
  world.player.drawFire = {
    ownerId: agent.id,
    until: now + 2.0,
    remaining: 600,
    points: [],
    pointerId: null,
    active: false,
  };
}

function appendPlayerDrawPoint(world, pointerId, x, y, beginStroke = false) {
  const draw = world?.player?.drawFire;
  if (!draw) return false;
  if (world.time >= draw.until || draw.remaining <= 0) {
    finalizePlayerDrawFire(world, "timeout");
    return false;
  }
  const px = clamp(x, 0, world.width);
  const py = clamp(y, 0, world.height);
  if (beginStroke) {
    draw.points = [{ x: px, y: py }];
    draw.pointerId = pointerId;
    draw.active = true;
    return true;
  }
  if (!draw.active || draw.pointerId !== pointerId) return false;
  const last = draw.points[draw.points.length - 1];
  if (!last) {
    draw.points.push({ x: px, y: py });
    return true;
  }
  let dx = px - last.x;
  let dy = py - last.y;
  let segLen = hypot(dx, dy);
  if (segLen < 0.75) return true;
  let nx = px;
  let ny = py;
  if (segLen > draw.remaining) {
    const t = draw.remaining / Math.max(1e-6, segLen);
    nx = lerp(last.x, px, t);
    ny = lerp(last.y, py, t);
    dx = nx - last.x;
    dy = ny - last.y;
    segLen = hypot(dx, dy);
  }
  draw.points.push({ x: nx, y: ny });
  draw.remaining = Math.max(0, draw.remaining - segLen);
  if (draw.remaining <= 0.25) finalizePlayerDrawFire(world, "max");
  return true;
}

function castHobbyAbilityById(world, agent, opp, abilityId) {
  const now = world.time;
  const j = world.juggernaut;
  const enemies = world.agents.filter((ag) => ag.id !== agent.id && ag.hp > 0 && !isAgentPhasedOut(ag, now));
  const closestEnemy = enemies[0] ?? null;
  const dEnemy = closestEnemy ? hypot(agent.x - closestEnemy.x, agent.y - closestEnemy.y) : Infinity;

  if (abilityId === "LAB_SAFETY") {
    agent.fx.damageTakenMul = 0.2;
    agent.fx.damageTakenUntil = Math.max(agent.fx.damageTakenUntil ?? 0, now + 3);
    abilityMarker(world, agent.x, agent.y, "rgba(120,190,255,0.48)", 0.8, 36, "LAB");
    return true;
  }

  if (abilityId === "COMBUSTION") {
    const r = 180;
    for (const e of enemies) {
      if (hypot(e.x - agent.x, e.y - agent.y) <= r) applyAbilityDamageToAgent(world, e, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, 7, 220, 0.14);
    }
    if (j && hypot(j.x - agent.x, j.y - agent.y) <= r) applyStunToJug(world, 0.35);
    applyStunToAgent(agent, now + 1.0);
    addCameraShake(world, 8, 0.28);
    abilityMarker(world, agent.x, agent.y, "rgba(255,110,70,0.58)", 0.9, r * 0.45, "BOOM", "SOUND");
    return true;
  }

  if (abilityId === "WALTZ") {
    let danced = false;
    if (closestEnemy && dEnemy < 210) {
      applyStunToAgent(closestEnemy, now + 1.0);
      danced = true;
    } else if (j && hypot(j.x - agent.x, j.y - agent.y) < 210) {
      applyStunToJug(world, 1.0);
      danced = true;
    }
    if (!danced) return false;
    applyStunToAgent(agent, now + 1.0);
    if (agent.hp < agent.maxHp * 0.5) applyAgentHeal(agent, 6);
    abilityMarker(world, agent.x, agent.y, "rgba(190,120,240,0.5)", 0.9, 54, "WALTZ");
    return true;
  }

  if (abilityId === "TWIRL") {
    agent.fx.twirlUntil = Math.max(agent.fx.twirlUntil ?? 0, now + 1.2);
    agent.fx.twirlTickAt = now + 0.02;
    agent.fx.twirlHitsByTarget = Object.create(null);
    agent.fx.twirlStartX = agent.x;
    agent.fx.twirlStartY = agent.y;
    if (opp && opp.hp > 0 && !isAgentPhasedOut(opp, now)) {
      const toOpp = normalize(opp.x - agent.x, opp.y - agent.y);
      const overshoot = 120;
      const tx = opp.x + toOpp.x * overshoot;
      const ty = opp.y + toOpp.y * overshoot;
      agent.fx.twirlTargetX = clamp(tx, agent.r, world.width - agent.r);
      agent.fx.twirlTargetY = clamp(ty, agent.r, world.height - agent.r);
    } else {
      const fallbackDist = 220;
      agent.fx.twirlTargetX = clamp(agent.x + Math.cos(agent.heading) * fallbackDist, agent.r, world.width - agent.r);
      agent.fx.twirlTargetY = clamp(agent.y + Math.sin(agent.heading) * fallbackDist, agent.r, world.height - agent.r);
    }
    agent.fx.speedMul = Math.max(agent.fx.speedMul ?? 1, 1.65);
    agent.fx.speedMulUntil = Math.max(agent.fx.speedMulUntil ?? 0, now + 1.2);
    abilityMarker(world, agent.x, agent.y, "rgba(240,140,220,0.45)", 1.0, 44, "TWL");
    return true;
  }

  if (abilityId === "DRAW_FIRE") {
    const isPlayer = agent.id === (world.player?.controlledId ?? "A");
    applyStunToAgent(agent, now + 2.0);
    if (isPlayer) {
      beginPlayerDrawFire(world, agent);
      abilityMarker(world, agent.x, agent.y, "rgba(255,160,90,0.4)", 1.25, 42, "DRAW");
    } else {
      world.ability.zones.push({
        kind: "DRAW_FIRE",
        ownerId: agent.id,
        x: agent.x,
        y: agent.y,
        r: 88,
        startAt: now + 2,
        until: now + 5,
        tickAt: now + 2,
        dps: 3,
        color: "rgba(255,120,80,0.28)",
      });
      abilityMarker(world, agent.x, agent.y, "rgba(255,160,90,0.4)", 1.2, 42, "DRAW");
    }
    return true;
  }

  if (abilityId === "SING") {
    const good = random01() < 0.5;
    if (good) {
      applyAgentHeal(agent, 7);
      for (const e of enemies) applyStunToAgent(e, now + 0.8);
      if (j && hypot(j.x - agent.x, j.y - agent.y) < 220) applyStunToJug(world, 0.4);
      abilityMarker(world, agent.x, agent.y, "rgba(120,220,255,0.4)", 0.9, 64, "SING");
    } else {
      for (const ag of world.agents) {
        const dmg = ag.id === agent.id ? 3.5 : 7;
        applyAbilityDamageToAgent(world, ag, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, dmg, 120, 0.2);
      }
      for (const e of enemies) applyStunToAgent(e, now + 0.5);
      applyStunToJug(world, 0.35);
      abilityMarker(world, agent.x, agent.y, "rgba(255,90,90,0.45)", 0.9, 66, "CRACK");
    }
    return true;
  }

  if (abilityId === "ROSIN") {
    if (!closestEnemy) return false;
    closestEnemy.fx.rosinUntil = Math.max(closestEnemy.fx.rosinUntil ?? 0, now + 5);
    closestEnemy.attackWindupUntil = 0;
    closestEnemy.attackWindupTargetId = null;
    abilityMarker(world, closestEnemy.x, closestEnemy.y, "rgba(240,220,120,0.45)", 0.9, 36, "ROSIN");
    return true;
  }

  if (abilityId === "UGLY_SOUND") {
    for (const ag of world.agents) {
      applyAbilityDamageToAgent(world, ag, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, 3, 80, 0.2);
      applyStunToAgent(ag, now + 0.5);
    }
    applyStunToJug(world, 0.5);
    addCameraShake(world, 10, 0.34);
    abilityMarker(world, agent.x, agent.y, "rgba(180,180,255,0.45)", 0.9, 78, "NOISE", "SOUND");
    return true;
  }

  if (abilityId === "CIRCULAR_BREATHING") {
    agent.fx.reflectCharges = Math.max(agent.fx.reflectCharges ?? 0, 2);
    agent.fx.reflectRatio = 1;
    abilityMarker(world, agent.x, agent.y, "rgba(120,210,190,0.45)", 0.9, 34, "REFL");
    return true;
  }

  if (abilityId === "INSTRUMENT_CASE") {
    const bx = clamp(agent.x + Math.cos(agent.heading) * 56, 34, world.width - 34);
    const by = clamp(agent.y + Math.sin(agent.heading) * 56, 34, world.height - 34);
    world.ability.barriers.push({ ownerId: agent.id, x: bx, y: by, r: 42, until: now + 3 });
    abilityMarker(world, bx, by, "rgba(120,130,150,0.45)", 0.9, 38, "CASE");
    return true;
  }

  if (abilityId === "LOUD_NOISE") {
    const r = 170;
    for (const e of enemies) {
      if (hypot(e.x - agent.x, e.y - agent.y) <= r) {
        applyAbilityDamageToAgent(world, e, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, 5, 2150, 0.16);
      }
    }
    if (j && hypot(j.x - agent.x, j.y - agent.y) <= r) applyStunToJug(world, 0.35);
    addCameraShake(world, 14, 0.42);
    abilityMarker(world, agent.x, agent.y, "rgba(255,180,90,0.46)", 0.95, 70, "LOUD", "SOUND");
    return true;
  }

  if (abilityId === "KEYBOARD_DEF") {
    addKeyboardTask(world, agent, "heal");
    return true;
  }

  if (abilityId === "KEYBOARD_OFF") {
    addKeyboardTask(world, agent, "damage");
    return true;
  }

  if (abilityId === "SERENADE") {
    for (const e of enemies) e.fx.reduceDamageOutUntil = Math.max(e.fx.reduceDamageOutUntil ?? 0, now + 3);
    abilityMarker(world, agent.x, agent.y, "rgba(120,180,255,0.36)", 1.0, 70, "SERA");
    return true;
  }

  if (abilityId === "METAL_CHORD") {
    for (const e of enemies) {
      applyAbilityDamageToAgent(world, e, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, 1.8, 690, 0.14);
      const c = clearance(world, e.x, e.y);
      if (c < e.r + 10) applyAbilityDamageToAgent(world, e, { kind: "ABILITY", id: agent.id, x: agent.x, y: agent.y }, 7, 0, 0.1);
    }
    addCameraShake(world, 11, 0.32);
    abilityMarker(world, agent.x, agent.y, "rgba(240,120,120,0.4)", 0.9, 74, "METAL", "SOUND");
    return true;
  }

  if (abilityId === "CRASH_CYMBAL") {
    if (!j || !closestEnemy) return false;
    j.agenda.targetId = closestEnemy.id;
    j.agenda.targetUntil = Math.max(j.agenda.targetUntil ?? 0, now + 7);
    j.agenda.modeUntil = Math.max(j.agenda.modeUntil ?? 0, now + 4);
    j.speedBoostUntil = Math.max(j.speedBoostUntil ?? 0, now + 7);
    j.speedBoostMul = Math.max(j.speedBoostMul ?? 1, 1.38);
    addCameraShake(world, 6, 0.2);
    abilityMarker(world, j.x, j.y, "rgba(255,220,100,0.45)", 0.9, 54, "CRASH", "SOUND");
    return true;
  }

  if (abilityId === "BACKSTAGE_BREAK") {
    if (isAgentPhasedOut(agent, now)) return false;
    agent.fx.backstageUntil = now + 3;
    agent.fx.backstageReturnX = agent.x;
    agent.fx.backstageReturnY = agent.y;
    agent.x = -220;
    agent.y = -220;
    agent.vx = 0;
    agent.vy = 0;
    abilityMarker(world, clamp(agent.fx.backstageReturnX, 20, world.width - 20), clamp(agent.fx.backstageReturnY, 20, world.height - 20), "rgba(210,160,255,0.35)", 1.0, 40, "EXIT");
    return true;
  }

  if (abilityId === "ACTING_JUG") {
    agent.fx.actingHitsLeft = 2;
    agent.fx.actingUntil = now + 12;
    abilityMarker(world, agent.x, agent.y, "rgba(255,120,120,0.45)", 1.0, 46, "ACT");
    return true;
  }

  if (abilityId === "PROGRESSIVE_OVERLOAD") {
    agent.fx.progressiveStoredDamage = 0;
    agent.fx.progressiveStoreUntil = now + 3;
    agent.fx.progressiveReleaseUntil = now + 6;
    agent.fx.invulnUntil = now + 3;
    abilityMarker(world, agent.x, agent.y, "rgba(150,220,160,0.48)", 1.0, 52, "PO");
    return true;
  }

  if (abilityId === "PROTEIN_SHAKE") {
    agent.fx.damageOutMul = Math.max(agent.fx.damageOutMul ?? 1, 1.45);
    agent.fx.damageOutUntil = Math.max(agent.fx.damageOutUntil ?? 0, now + 7);
    abilityMarker(world, agent.x, agent.y, "rgba(180,255,140,0.42)", 0.95, 40, "PRO");
    return true;
  }

  if (abilityId === "LOCK_IN") {
    agent.fx.lockInUntil = Math.max(agent.fx.lockInUntil ?? 0, now + 6);
    abilityMarker(world, agent.x, agent.y, "rgba(255,240,120,0.45)", 0.95, 40, "LOCK");
    return true;
  }

  if (abilityId === "COOKING") {
    if (random01() < 0.7) applyAgentHeal(agent, 5);
    else {
      const pick = Math.floor(randRange(0, 3));
      if (pick === 0) {
        agent.fx.damageOutMul = Math.max(agent.fx.damageOutMul ?? 1, 1.1);
        agent.fx.damageOutUntil = Math.max(agent.fx.damageOutUntil ?? 0, now + 5);
      } else if (pick === 1) {
        agent.fx.speedMul = Math.max(agent.fx.speedMul ?? 1, 1.1);
        agent.fx.speedMulUntil = Math.max(agent.fx.speedMulUntil ?? 0, now + 5);
      } else {
        agent.fx.attackSpeedMul = Math.max(agent.fx.attackSpeedMul ?? 1, 1.1);
        agent.fx.attackSpeedUntil = Math.max(agent.fx.attackSpeedUntil ?? 0, now + 5);
      }
    }
    abilityMarker(world, agent.x, agent.y, "rgba(255,190,120,0.42)", 0.9, 40, "COOK");
    return true;
  }

  if (abilityId === "FLAMBE") {
    agent.fx.flambedUntil = Math.max(agent.fx.flambedUntil ?? 0, now + 5);
    abilityMarker(world, agent.x, agent.y, "rgba(255,120,70,0.46)", 0.9, 42, "FLM");
    return true;
  }

  if (abilityId === "CALL_ANIMALS") {
    agent.fx.animalWaveUntil = Math.max(agent.fx.animalWaveUntil ?? 0, now + 2.5);
    agent.fx.animalWaveNextAt = now;
    agent.fx.animalWaveCount = 0;
    abilityMarker(world, agent.x, agent.y, "rgba(150,210,140,0.44)", 0.95, 52, "PETS");
    return true;
  }

  if (abilityId === "KNIT_SWEATER") {
    applyAgentAbsorb(agent, 5);
    abilityMarker(world, agent.x, agent.y, "rgba(220,180,255,0.4)", 0.9, 36, "KNIT");
    return true;
  }

  if (abilityId === "VIDEO_GAME") {
    if (random01() < 0.5) {
      if (closestEnemy) {
        const toEnemy = normalize(closestEnemy.x - agent.x, closestEnemy.y - agent.y);
        const speed = 650;
        world.ability.projectiles.push({
          id: `pc|${agent.id}|${Math.floor(now * 1000)}|${Math.floor(randRange(100, 999))}`,
          ownerId: agent.id,
          targetId: closestEnemy.id,
          x: agent.x,
          y: agent.y,
          vx: toEnemy.x * speed,
          vy: toEnemy.y * speed,
          r: 12,
          until: now + 1.1,
          damage: 5,
          hit: false,
        });
      }
      abilityMarker(world, agent.x, agent.y, "rgba(255,120,120,0.44)", 0.9, 42, "RAGE");
    } else {
      agent.fx.speedMul = Math.max(agent.fx.speedMul ?? 1, 1.5);
      agent.fx.speedMulUntil = Math.max(agent.fx.speedMulUntil ?? 0, now + 3);
      agent.fx.attackSpeedMul = Math.max(agent.fx.attackSpeedMul ?? 1, 1.5);
      agent.fx.attackSpeedUntil = Math.max(agent.fx.attackSpeedUntil ?? 0, now + 3);
      abilityMarker(world, agent.x, agent.y, "rgba(120,220,255,0.44)", 0.9, 42, "WIN");
    }
    return true;
  }

  return false;
}

function tryCastHobbyAbility(world, agent, slotName = null, manual = false) {
  if (!agent) return false;
  const opp = getOpponentAgent(world, agent);
  const spec = getHobbySpec(agent.hobby?.id);
  const chosenSlot = slotName ?? chooseAbilitySlot(world, agent, opp, manual);
  if (!canUseAbilitySlot(world, agent, chosenSlot)) return false;
  const ability = getAbilitySlot(spec, chosenSlot);
  if (!ability) return false;
  const ok = castHobbyAbilityById(world, agent, opp, ability.id);
  if (!ok) return false;
  setAbilityCooldown(world, agent, chosenSlot, ability);
  agent.hobby.lastUsed = ability.id;
  setThought(agent, `${agent.thought} | ${ability.label}`, world.time);
  return true;
}

function switchAgentHobby(world, agent, dir = 1) {
  if (!agent) return;
  const now = world.time;
  agent.hobby.id = cycleHobbyId(agent.hobby.id, dir);
  agent.hobby.lastSwitchAt = now;
  agent.hobby.castGlobalUntil = Math.max(agent.hobby.castGlobalUntil ?? 0, now + 0.15);
  setThought(agent, `${agent.thought} | hobby ${getHobbyShort(agent.hobby.id)}`, now);
}

function switchAgentMbti(world, agent, dir = 1) {
  if (!agent) return;
  const now = world.time;
  const next = cycleMbti(agent.mbti, dir);
  applyMbtiProfile(agent, next);
  setThought(agent, `${agent.thought} | mbti ${next}`, now);
}

function getActivePlayerCommand(agent, now) {
  if (!agent?.playerCmd) return null;
  return now < (agent.playerCmd.until ?? -Infinity) ? agent.playerCmd : null;
}

function assignPlayerCommand(world, agent, x, y, opts = null) {
  if (!agent) return false;
  const options = opts ?? {};
  const now = world.time;
  const nextAllowedAt = agent.playerCmd?.nextAllowedAt ?? 0;
  if (!options.ignoreCooldown && now < nextAllowedAt) return false;
  const opp = getOpponentAgent(world, agent);
  const j = world.juggernaut;
  const dTapOpp = opp ? hypot(x - opp.x, y - opp.y) : Infinity;
  const dTapJug = j ? hypot(x - j.x, y - j.y) : Infinity;
  const dSelfOpp = opp ? hypot(agent.x - opp.x, agent.y - opp.y) : Infinity;
  const lowSelf = agent.hp < agent.maxHp * 0.5;
  const lowOpp = opp ? opp.hp < opp.maxHp * 0.5 : false;

  let mode = "REPOSITION";
  if (dTapOpp < 95 || (lowOpp && dSelfOpp < 330)) mode = "ATTACK";
  else if (lowSelf && dTapOpp > 150 && dTapJug > 140) mode = "RECOVER";

  agent.playerCmd.mode = mode;
  agent.playerCmd.x = clamp(x, agent.r, world.width - agent.r);
  agent.playerCmd.y = clamp(y, agent.r, world.height - agent.r);
  agent.playerCmd.issuedAt = now;
  agent.playerCmd.until = now + (mode === "ATTACK" ? 4.4 : 3.8);
  agent.playerCmd.nextAllowedAt = now + (world.player.commandCooldown ?? 6);
  world.player.lastTapAt = now;
  if (agent.id === (world.player?.controlledId ?? "A")) {
    world.player.nextCommandAt = agent.playerCmd.nextAllowedAt;
  }
  setThought(agent, `${agent.thought} | player ${mode.toLowerCase()}`, now);
  return true;
}

function updateAbilitySystems(world, dt, phase = "full") {
  const now = world.time;
  const j = world.juggernaut;
  if (world.player?.drawFire && now >= (world.player.drawFire.until ?? 0)) {
    finalizePlayerDrawFire(world, "timeout");
  }

  for (const ag of world.agents) {
    if (!ag.fx) continue;

    // Sports passive ramps non-health stats over time.
    ag.fx.sportsScale = ag.hobby?.id === "SPORTS" ? clamp(now / 180, 0, 0.35) : 0;

    // Theatre backstage return.
    if (ag.fx.backstageUntil > now) {
      ag.vx = 0;
      ag.vy = 0;
    } else if (
      ag.fx.backstageUntil > 0 &&
      ag.x < -100 &&
      Number.isFinite(ag.fx.backstageReturnX) &&
      Number.isFinite(ag.fx.backstageReturnY)
    ) {
      ag.x = clamp(ag.fx.backstageReturnX, ag.r, world.width - ag.r);
      ag.y = clamp(ag.fx.backstageReturnY, ag.r, world.height - ag.r);
      applyAgentAbsorb(ag, 10);
      ag.fx.backstageUntil = 0;
      ag.fx.backstageReturnX = NaN;
      ag.fx.backstageReturnY = NaN;
      abilityMarker(world, ag.x, ag.y, "rgba(200,160,255,0.35)", 0.9, 44, "RETURN");
    }

    if (phase !== "pre") {
      // Progressive overload release.
      if (ag.fx.progressiveReleaseUntil > ag.fx.progressiveStoreUntil && now > ag.fx.progressiveStoreUntil && now < ag.fx.progressiveReleaseUntil) {
        const remain = Math.max(0.02, ag.fx.progressiveReleaseUntil - now);
        const chunk = Math.min(ag.fx.progressiveStoredDamage, (ag.fx.progressiveStoredDamage / remain) * dt);
        if (chunk > 0) {
          let spill = chunk;
          const absorb = Math.min(ag.absorbHp ?? 0, spill);
          ag.absorbHp -= absorb;
          spill -= absorb;
          ag.hp = Math.max(0, ag.hp - spill);
          ag.fx.progressiveStoredDamage = Math.max(0, ag.fx.progressiveStoredDamage - chunk);
        }
      } else if (now >= ag.fx.progressiveReleaseUntil) {
        ag.fx.progressiveStoreUntil = 0;
        ag.fx.progressiveReleaseUntil = 0;
        ag.fx.progressiveStoredDamage = 0;
      }

      // Burn ticks.
      if (now < (ag.fx.burnUntil ?? 0) && now >= (ag.fx.burnTickAt ?? 0) && ag.hp > 0) {
        const dmg = Math.max(0, (ag.fx.burnDps ?? 0.8) * 0.5);
        applyAbilityDamageToAgent(world, ag, { kind: "BURN", id: null, x: ag.x, y: ag.y }, dmg, 0, 0.05);
        ag.fx.burnTickAt = now + 0.5;
      }

      // Dance twirl repeated hit pulses.
      if (now < (ag.fx.twirlUntil ?? 0) && now >= (ag.fx.twirlTickAt ?? 0)) {
        const startX = Number.isFinite(ag.fx.twirlStartX) ? ag.fx.twirlStartX : ag.x;
        const startY = Number.isFinite(ag.fx.twirlStartY) ? ag.fx.twirlStartY : ag.y;
        const traveled = hypot(ag.x - startX, ag.y - startY);
        const armed = traveled >= 70;
        for (const e of world.agents) {
          if (e.id === ag.id || e.hp <= 0 || isAgentPhasedOut(e, now)) continue;
          if (!armed) continue;
          const lastHitAt = ag.fx.twirlHitsByTarget?.[e.id] ?? -Infinity;
          if (now - lastHitAt < 0.45) continue;
          if (hypot(e.x - ag.x, e.y - ag.y) <= ag.r + e.r + 26) {
            applyAbilityDamageToAgent(world, e, { kind: "ABILITY", id: ag.id, x: ag.x, y: ag.y }, 3, 120, 0.08);
            ag.fx.twirlHitsByTarget[e.id] = now;
          }
        }
        if (j && hypot(j.x - ag.x, j.y - ag.y) <= j.r + ag.r + 16) applyStunToJug(world, 0.12);
        ag.fx.twirlTickAt = now + 0.2;
      }

      // Knitting passive yarn trail.
      if (ag.hobby?.id === "KNITTING_CROCHET" && ag.hp > 0 && !isAgentPhasedOut(ag, now)) {
        const lx = Number.isFinite(ag.fx.yarnLastX) ? ag.fx.yarnLastX : ag.x;
        const ly = Number.isFinite(ag.fx.yarnLastY) ? ag.fx.yarnLastY : ag.y;
        const d = hypot(ag.x - lx, ag.y - ly);
        if (d > 26) {
          world.ability.yarn.push({
            ownerId: ag.id,
            x1: lx,
            y1: ly,
            x2: ag.x,
            y2: ag.y,
            until: now + 8,
            spent: false,
          });
          ag.fx.yarnLastX = ag.x;
          ag.fx.yarnLastY = ag.y;
        } else if (!Number.isFinite(ag.fx.yarnLastX)) {
          ag.fx.yarnLastX = ag.x;
          ag.fx.yarnLastY = ag.y;
        }
      }
    }
  }

  if (phase === "pre") {
    // Animal hobby wave spawner: 1 pet every 0.5s for 2.5s.
    for (const ag of world.agents) {
      if (!ag?.fx) continue;
      const waveUntil = ag.fx.animalWaveUntil ?? 0;
      if (now >= waveUntil) continue;
      while (now >= (ag.fx.animalWaveNextAt ?? Infinity) && (ag.fx.animalWaveNextAt ?? Infinity) <= waveUntil) {
        const spawnIndex = (ag.fx.animalWaveCount ?? 0) + 1;
        const ang = randRange(0, TAU);
        world.ability.summons.push({
          id: `pet|${ag.id}|${Math.floor(now * 1000)}|${spawnIndex}`,
          ownerId: ag.id,
          x: clamp(ag.x + Math.cos(ang) * randRange(20, 54), 12, world.width - 12),
          y: clamp(ag.y + Math.sin(ang) * randRange(20, 54), 12, world.height - 12),
          vx: 0,
          vy: 0,
          r: 9,
          hp: 5,
          until: now + 12,
          atkCdUntil: 0,
        });
        ag.fx.animalWaveCount = spawnIndex;
        ag.fx.animalWaveNextAt = (ag.fx.animalWaveNextAt ?? now) + 0.5;
      }
      if ((ag.fx.animalWaveNextAt ?? Infinity) > waveUntil) {
        ag.fx.animalWaveUntil = 0;
      }
    }
    world.ability.markers = world.ability.markers.filter((m) => now < m.until);
    return;
  }

  // Fire/ability zones.
  for (const z of world.ability.zones) {
    if (now >= z.until || now < (z.startAt ?? -Infinity) || now < (z.tickAt ?? 0)) continue;
    const tickLen = 0.35;
    const isDrawFire = z.kind === "DRAW_FIRE" || z.kind === "DRAW_FIRE_TRAIL";
    for (const ag of world.agents) {
      if (ag.hp <= 0 || isAgentPhasedOut(ag, now)) continue;
      const inside =
        z.kind === "DRAW_FIRE_TRAIL"
          ? distPointSeg(ag.x, ag.y, z.x1, z.y1, z.x2, z.y2) <= z.r + ag.r * 0.5
          : hypot(ag.x - z.x, ag.y - z.y) <= z.r + ag.r * 0.5;
      if (inside) {
        if (isDrawFire) {
          const burnDur = 3;
          const burnDps = 5 / burnDur;
          ag.fx.burnUntil = Math.max(ag.fx.burnUntil ?? 0, now + burnDur);
          ag.fx.burnDps = Math.max(ag.fx.burnDps ?? 0, burnDps);
          if (now >= (ag.fx.burnTickAt ?? 0)) ag.fx.burnTickAt = now + 0.5;
        } else {
          const dmg = Math.max(0.35, (z.dps ?? 2.2) * tickLen);
          const sx = z.kind === "DRAW_FIRE_TRAIL" ? (z.x1 + z.x2) * 0.5 : z.x;
          const sy = z.kind === "DRAW_FIRE_TRAIL" ? (z.y1 + z.y2) * 0.5 : z.y;
          applyAbilityDamageToAgent(world, ag, { kind: "ABILITY", id: z.ownerId, x: sx, y: sy }, dmg, 35, 0.04);
        }
      }
    }
    if (j) {
      const hitsJ =
        z.kind === "DRAW_FIRE_TRAIL"
          ? distPointSeg(j.x, j.y, z.x1, z.y1, z.x2, z.y2) <= z.r + j.r * 0.4
          : hypot(j.x - z.x, j.y - z.y) <= z.r + j.r * 0.4;
      if (hitsJ) applyStunToJug(world, 0.05);
    }
    z.tickAt = now + tickLen;
  }
  world.ability.zones = world.ability.zones.filter((z) => now < z.until);

  // Barriers.
  world.ability.barriers = world.ability.barriers.filter((b) => now < b.until);
  for (const b of world.ability.barriers) {
    for (const ag of world.agents) {
      if (ag.hp <= 0 || isAgentPhasedOut(ag, now)) continue;
      if (isTwirlRushActive(ag, now)) continue;
      separateMobileStatic(ag, { x: b.x, y: b.y, r: b.r });
    }
    if (j) separateMobileStatic(j, { x: b.x, y: b.y, r: b.r + 4 });
  }

  // Keyboard tasks.
  for (const task of world.ability.keyboardTasks) {
    if (now >= task.until) continue;
    const owner = getAgent(world, task.ownerId);
    if (!owner || owner.hp <= 0 || isAgentPhasedOut(owner, now)) continue;
    if (hypot(owner.x - task.keyX, owner.y - task.keyY) <= owner.r + task.keyR) {
      if (task.mode === "heal") {
        applyAgentHeal(owner, 7);
      } else {
        const opp = getOpponentAgent(world, owner);
        if (opp && opp.hp > 0) applyAbilityDamageToAgent(world, opp, { kind: "ABILITY", id: owner.id, x: owner.x, y: owner.y }, 7, 180, 0.1);
      }
      task.until = now - 0.001;
      owner.fx.keyboardTaskId = null;
      abilityMarker(world, task.keyX, task.keyY, "rgba(255,255,160,0.45)", 0.85, 30, "KEY");
    }
  }
  world.ability.keyboardTasks = world.ability.keyboardTasks.filter((k) => now < k.until);

  // Animal summons.
  for (const pet of world.ability.summons) {
    if (now >= pet.until || pet.hp <= 0) continue;
    const owner = getAgent(world, pet.ownerId);
    const enemies = world.agents.filter((ag) => ag.id !== pet.ownerId && ag.hp > 0 && !isAgentPhasedOut(ag, now));
    const target = enemies[0] ?? null;
    if (!owner || !target) continue;

    const to = normalize(target.x - pet.x, target.y - pet.y);
    const speed = 135;
    pet.vx = to.x * speed;
    pet.vy = to.y * speed;
    pet.x = clamp(pet.x + pet.vx * dt, pet.r, world.width - pet.r);
    pet.y = clamp(pet.y + pet.vy * dt, pet.r, world.height - pet.r);

    const d = hypot(target.x - pet.x, target.y - pet.y);
    if (d <= target.r + pet.r + 4 && now >= (pet.atkCdUntil ?? 0)) {
      applyAbilityDamageToAgent(world, target, { kind: "ABILITY", id: pet.ownerId, x: pet.x, y: pet.y }, 1, 95, 0.06);
      pet.hp = 0;
      pet.until = now - 0.001;
      abilityMarker(world, pet.x, pet.y, "rgba(170,220,150,0.38)", 0.65, 18, "PET");
    }
  }
  world.ability.summons = world.ability.summons.filter((p) => now < p.until && p.hp > 0);

  // Video game thrown computer projectile.
  for (const proj of world.ability.projectiles) {
    if (proj.hit || now >= proj.until) continue;
    proj.x = clamp(proj.x + proj.vx * dt, proj.r, world.width - proj.r);
    proj.y = clamp(proj.y + proj.vy * dt, proj.r, world.height - proj.r);
    for (const ag of world.agents) {
      if (ag.id === proj.ownerId || ag.hp <= 0 || isAgentPhasedOut(ag, now)) continue;
      if (hypot(ag.x - proj.x, ag.y - proj.y) > ag.r + proj.r + 3) continue;
      applyAbilityDamageToAgent(
        world,
        ag,
        { kind: "ABILITY", id: proj.ownerId, x: proj.x, y: proj.y },
        proj.damage ?? 5,
        260,
        0.12,
      );
      proj.hit = true;
      abilityMarker(world, proj.x, proj.y, "rgba(255,160,140,0.5)", 0.7, 34, "HIT");
      break;
    }
  }
  world.ability.projectiles = world.ability.projectiles.filter((p) => !p.hit && now < p.until);

  // Yarn traps.
  for (const seg of world.ability.yarn) {
    if (seg.spent || now >= seg.until) continue;
    for (const ag of world.agents) {
      if (ag.id === seg.ownerId || ag.hp <= 0 || isAgentPhasedOut(ag, now)) continue;
      const d = distPointSeg(ag.x, ag.y, seg.x1, seg.y1, seg.x2, seg.y2);
      if (d <= ag.r + 2) {
        applyStunToAgent(ag, now + 0.55);
        seg.spent = true;
        abilityMarker(world, ag.x, ag.y, "rgba(220,180,255,0.44)", 0.7, 28, "TRIP");
      }
    }
  }
  world.ability.yarn = world.ability.yarn.filter((s) => now < s.until && !s.spent);

  world.ability.markers = world.ability.markers.filter((m) => now < m.until);
}

function maybeAutoCastHobbyAbility(world, agent) {
  if (!agent || agent.hp <= 0) return;
  if (world.runtime?.appMode === "player" && world.runtime?.match?.mode === "pvp") return;
  if (agent.id === (world.player?.controlledId ?? "A")) return;
  const now = world.time;
  if (now < (agent.hobby?.aiNextThinkAt ?? 0)) return;
  agent.hobby.aiNextThinkAt = now + randRange(0.55, 1.2);
  if (isAgentPhasedOut(agent, now)) return;
  const opp = getOpponentAgent(world, agent);
  if (!opp || opp.hp <= 0) return;

  function shouldAutoUse(abilityId) {
    const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
    const dO = hypot(agent.x - opp.x, agent.y - opp.y);
    const dJ = world.juggernaut ? hypot(agent.x - world.juggernaut.x, agent.y - world.juggernaut.y) : Infinity;
    const threatened = now - (agent.events?.jugWindupSeenAt ?? -Infinity) < 0.55 || dJ < desiredSafeDistToJug(agent) * 0.95;
    if (abilityId === "LAB_SAFETY") return hpN < 0.75 || threatened;
    if (abilityId === "COMBUSTION") return dO < 180;
    if (abilityId === "WALTZ") return dO < 205 || dJ < 190;
    if (abilityId === "TWIRL") return dO < 210;
    if (abilityId === "DRAW_FIRE") return dO < 280;
    if (abilityId === "SING") return dO < 240;
    if (abilityId === "ROSIN") return dO < 250;
    if (abilityId === "UGLY_SOUND") return dO < 220 || threatened;
    if (abilityId === "CIRCULAR_BREATHING") return threatened || dO < 150;
    if (abilityId === "INSTRUMENT_CASE") return threatened || dO < 220;
    if (abilityId === "LOUD_NOISE") return dO < 175;
    if (abilityId === "KEYBOARD_DEF") return hpN < 0.78;
    if (abilityId === "KEYBOARD_OFF") return dO < 260;
    if (abilityId === "SERENADE") return dO < 260;
    if (abilityId === "METAL_CHORD") return dO < 180;
    if (abilityId === "CRASH_CYMBAL") return threatened;
    if (abilityId === "BACKSTAGE_BREAK") return hpN < 0.45;
    if (abilityId === "ACTING_JUG") return dO < 240;
    if (abilityId === "PROGRESSIVE_OVERLOAD") return hpN < 0.52 || threatened;
    if (abilityId === "PROTEIN_SHAKE") return dO < 260;
    if (abilityId === "LOCK_IN") return dO < 300;
    if (abilityId === "COOKING") return hpN < 0.92;
    if (abilityId === "FLAMBE") return dO < 220;
    if (abilityId === "CALL_ANIMALS") return dO < 320;
    if (abilityId === "KNIT_SWEATER") return hpN < 0.9 || (agent.absorbHp ?? 0) < 2;
    if (abilityId === "VIDEO_GAME") return dO < 300;
    return false;
  }

  const spec = getHobbySpec(agent.hobby?.id);
  const preferred = chooseAbilitySlot(world, agent, opp, false);
  const order = preferred === "secondary" ? ["secondary", "primary"] : ["primary", "secondary"];
  for (const slot of order) {
    const ability = getAbilitySlot(spec, slot);
    if (!ability) continue;
    if (!canUseAbilitySlot(world, agent, slot)) continue;
    if (!shouldAutoUse(ability.id)) continue;
    if (tryCastHobbyAbility(world, agent, slot, false)) break;
  }
}

function pickPosture(agent, tactic) {
  const hpN = clamp01(agent.hp / agent.maxHp);
  let p = "NEUTRAL";
  if (tactic === "ATTACK" || tactic === "PRESSURE" || tactic === "CLASH") p = "AGGRO";
  else if (tactic === "RETREAT_LONG" || tactic === "OPEN_UP") p = "DEFENSIVE";
  else if (tactic === "RESET") p = "NEUTRAL";
  else if (tactic === "BLOCK") p = "DEFENSIVE";

  // Bluff: sometimes act bold while weak.
  if (hpN < 0.35 && random01() < 0.35) p = "AGGRO";
  return p;
}

function randNormalFromRng(rng) {
  // Box-Muller transform, but with a caller-provided rng() so decisions can be deterministic.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function opponentRouteRisk(agent, opp, target) {
  // 0..1 scalar for how much the straight-line route threads through the opponent.
  // Used to avoid "pathing through" the other agent and relying on separation to resolve it.
  if (!opp || !target) return { risk: 0 };
  const keepOut = agent.r + opp.r + 18;
  const band = keepOut * 1.45;
  const d = lineCircleClosestDist(agent.x, agent.y, target.x, target.y, opp.x, opp.y);
  let risk = clamp01((band - d) / Math.max(1e-6, band));

  // Extra if opponent is between us and the target.
  const abx = target.x - agent.x;
  const aby = target.y - agent.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 > 1e-6) {
    const t = clamp(((opp.x - agent.x) * abx + (opp.y - agent.y) * aby) / ab2, 0, 1);
    const px = agent.x + abx * t;
    const py = agent.y + aby * t;
    const dd = hypot(opp.x - px, opp.y - py);
    if (t > 0.12 && t < 0.88 && dd < keepOut * 1.05) risk = Math.min(1, risk + 0.45);
  }

  return { risk: clamp01(risk) };
}

function computeObjectiveWeights(world, agent, opp, j, ctx = null) {
  const now = ctx?.now ?? world.time;
  const hpN = ctx?.hpN ?? clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
  const stamN =
    ctx?.stamN ??
    clamp01((agent.stamina ?? 0) / Math.max(1e-6, agent.maxStamina));
  const fear = ctx?.fear ?? clamp01(agent.emotions?.fear ?? 0);
  const jugQ = ctx?.jugQ ?? (j ? agent.senses.jug.quality : 0);
  const dJ = ctx?.dJ ?? (j ? agent.senses.jug.beliefDist : Infinity);

  const safeDistJ = ctx?.safeDistJ ?? (j ? desiredSafeDistToJug(agent) : 260);
  const safeDistEff = ctx?.safeDistEff ?? safeDistJ * lerp(0.55, 1.0, jugQ);
  const jugClose = j && Number.isFinite(dJ) ? clamp01((safeDistEff - dJ) / Math.max(1e-6, safeDistEff)) : 0;

  const dO = ctx?.dO ?? hypot(agent.x - opp.x, agent.y - opp.y);
  const clearanceHere = ctx?.clearanceHere ?? (agent.senses?.clearance ?? clearance(world, agent.x, agent.y));
  const finishP = ctx?.finishP ?? estimateFinishProb(agent, opp);
  const oppSeen = ctx?.oppSeen ?? (agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 220);
  const engageMomentum =
    ctx?.engageMomentum ??
    clamp01(Math.max(0, (agent.events?.engageUntil ?? -Infinity) - now) / 2.2);

  const jugChasingMe =
    ctx?.jugChasingMe ??
    Boolean(
      j &&
        j.agenda?.targetId === agent.id &&
        (agent.senses.jug.quality > 0.25 ||
          agent.senses.jug.peripheral ||
          agent.senses.jug.heard ||
          now - agent.senses.jug.lastSeenAt < 1.2),
    );

  const sceneId = ctx?.sceneId ?? agent.scene?.id ?? "RESET";
  const garrisonActive = ctx?.garrisonActive ?? stanceIsActive(agent, "GARRISON", now);
  const garrisonCharging = ctx?.garrisonCharging ?? agent.stance?.chargingTo === "GARRISON";
  const assaultActive = ctx?.assaultActive ?? stanceIsActive(agent, "ASSAULT", now);
  const aggression = clamp01(agent.style?.aggression ?? (agent.style?.engageBias ?? 0.55));
  const stubbornness = clamp01(agent.style?.stubbornness ?? 0.5);
  const blockBias = clamp01(agent.style?.blockBias ?? 0.5);

  let recoverScore =
    1.8 * (1 - stamN) +
    1.35 * (1 - hpN) +
    1.1 * fear +
    2.0 * jugClose +
    1.2 * (jugChasingMe ? 1 : 0) +
    0.9 * clamp01((100 - clearanceHere) / 100) -
    0.8 * finishP;

  let duelScore =
    1.4 * (agent.style?.engageBias ?? 0.55) +
    1.2 * stamN +
    1.1 * (1 - fear) +
    0.9 * (oppSeen ? 1 : 0) +
    0.8 * (j && dJ > safeDistEff * 1.35 ? 1 : 0) +
    1.0 * finishP -
    1.2 * jugClose -
    0.6 * (1 - hpN);

  let baitScore =
    1.2 * (agent.style?.wrapWhenChased ?? 0.25) +
    1.0 * (agent.style?.riskTolerance ?? 0.5) +
    0.8 * (j ? 1 : 0) +
    0.9 * (oppSeen ? 1 : 0) +
    0.7 * stamN +
    0.5 * finishP -
    1.0 * jugClose * (jugChasingMe ? 1 : 0);

  recoverScore += 0.9 * (1 - aggression) + 0.45 * blockBias + 0.18 * (1 - stubbornness);
  duelScore += 1.35 * aggression + 0.75 * stubbornness - 0.42 * blockBias;
  baitScore += 0.6 * aggression + 0.34 * (agent.style?.riskTolerance ?? 0.5);

  const jugSafeForDuel = !j || dJ > safeDistEff * 1.18;
  if (oppSeen && jugSafeForDuel) {
    duelScore += 0.9;
    recoverScore -= 0.35;
  }
  if (oppSeen && dO < 260 && (!j || jugClose < 0.28)) {
    duelScore += 1.15;
    recoverScore -= 0.6;
  }
  if (oppSeen && dO < 220 && (!j || jugClose < 0.35)) {
    duelScore += 0.95;
    recoverScore -= 0.85;
  }
  if (dO < 160 && (!j || jugClose < 0.22)) {
    duelScore += 0.9;
    baitScore += 0.25;
  }
  if (engageMomentum > 0 && (!j || jugClose < 0.35)) {
    duelScore += 1.1 * engageMomentum;
    baitScore += 0.45 * engageMomentum;
    recoverScore -= 0.95 * engageMomentum;
  }
  if (j && oppSeen && jugSafeForDuel && dO < 360) baitScore += 1.25;
  if (j && oppSeen && dO > 130 && dO < 320 && dJ > safeDistEff * 1.08) baitScore += 0.55;
  if (j && dJ < safeDistEff * 0.9) baitScore -= 1.1;

  // Scene priors.
  if (sceneId === "ESCAPE") {
    recoverScore += 1.2;
    duelScore -= 0.8;
    baitScore -= 0.4;
  } else if (sceneId === "SCRAMBLE") {
    recoverScore += 0.9;
    duelScore -= 0.7;
    baitScore -= 0.2;
  } else if (sceneId === "DUEL") {
    duelScore += 1.35;
    recoverScore -= 0.75;
    baitScore += 0.1;
  } else if (sceneId === "FINISH") {
    duelScore += 1.0;
    baitScore += 0.4;
    recoverScore -= 0.6;
  } else if (sceneId === "RESET") {
    recoverScore += 0.12;
    duelScore += 0.38;
    baitScore -= 0.08;
  }

  // Stance priors.
  if (garrisonActive || garrisonCharging) {
    recoverScore += 0.8;
    duelScore -= 0.2;
  }
  if (assaultActive) {
    duelScore += 0.5;
    recoverScore -= 0.4;
    baitScore += 0.2;
  }

  const ws = softmaxWeights(
    [
      { id: "recover", score: recoverScore },
      { id: "duel", score: duelScore },
      { id: "bait", score: baitScore },
    ],
    1.0,
  );
  return { recover: ws.recover ?? 0.33, duel: ws.duel ?? 0.33, bait: ws.bait ?? 0.33 };
}

function planGoalForTactic(world, agent, opp, j, tactic, ctx, weights, rng) {
  const now = ctx.now;
  const center = { x: world.width * 0.5, y: world.height * 0.5 };

  const fighting = tactic === "ATTACK" || tactic === "PRESSURE" || tactic === "CLASH";
  const noticedJug =
    now - agent.events.jugWindupSeenAt < 0.55 ||
    agent.senses.jug.visible ||
    agent.senses.jug.peripheral;
  const realJDist = j ? hypot(agent.x - j.x, agent.y - j.y) : Infinity;
  const closeJug = j && realJDist < j.r + agent.r + 120;
  const respectJug =
    closeJug ||
    (ctx.dJ < ctx.safeDistEff * 1.05) ||
    !fighting ||
    noticedJug ||
    (ctx.jugQ ?? 0) > 0.75;
  const jugPos = j && respectJug ? (agent.senses.jug.beliefPos ?? { x: j.x, y: j.y }) : null;

  const cands = [];
  const r = agent.r;

  function pushCand(x, y, kind) {
    cands.push({
      x: clamp(x, r, world.width - r),
      y: clamp(y, r, world.height - r),
      kind,
    });
  }

  function pushFromAgentArc(kind, baseAngle, offsetsDeg, distMin, distMax) {
    for (const od of offsetsDeg) {
      const a = baseAngle + (od * Math.PI) / 180;
      const L = distMin + (distMax - distMin) * rng();
      pushCand(agent.x + Math.cos(a) * L, agent.y + Math.sin(a) * L, kind);
    }
  }

  function pushAroundOpp(kind, baseAngle, offsetsDeg, radMin, radMax) {
    for (const od of offsetsDeg) {
      const a = baseAngle + (od * Math.PI) / 180;
      const L = radMin + (radMax - radMin) * rng();
      pushCand(opp.x + Math.cos(a) * L, opp.y + Math.sin(a) * L, kind);
    }
  }

  function pushSafeMemory() {
    const n = Math.min(4, agent.mem.safeSpots.length);
    for (let i = 0; i < n; i++) {
      const sp = agent.mem.safeSpots[i];
      const jx = randNormalFromRng(rng) * 35;
      const jy = randNormalFromRng(rng) * 35;
      pushCand(sp.x + jx, sp.y + jy, "SAFE_MEMORY");
    }
  }

  function pushCenterOpen() {
    const base = angleTo(center.x - agent.x, center.y - agent.y);
    pushFromAgentArc("CENTER", base, [-60, -30, -15, 0, 15, 30, 60], 140, 260);
  }

  function pushEscapeLaneFor(tac) {
    const jugChasingMe = ctx.jugChasingMe;
    const panicked = (agent.emotions?.fear ?? 0) > 0.6;
    const offsets = jugChasingMe || panicked
      ? [-55, -35, -22, -12, 0, 12, 22, 35, 55]
      : [-110, -80, -55, -30, -15, 0, 15, 30, 55, 80, 110];

    const awayA = jugPos
      ? angleTo(agent.x - jugPos.x, agent.y - jugPos.y)
      : angleTo(center.x - agent.x, center.y - agent.y);

    let distMin = 180;
    let distMax = 300;
    if (tac === "OPEN_UP") { distMin = 300; distMax = 460; }
    else if (tac === "RETREAT_LONG") { distMin = 340; distMax = 540; }
    else if (tac === "RETREAT_SHORT") { distMin = 180; distMax = 300; }
    else if (tac === "RESET") { distMin = 220; distMax = 340; }
    else { distMin = 140; distMax = 260; }

    pushFromAgentArc("ESCAPE_LANE", awayA, offsets, distMin, distMax);
  }

  function pushBaitLine() {
    if (jugPos) {
      const toJug = normalize(jugPos.x - opp.x, jugPos.y - opp.y);
      for (let i = 0; i < 10; i++) {
        const L = 160 + 160 * rng();
        const bx = opp.x + toJug.x * L;
        const by = opp.y + toJug.y * L;
        const away = normalize(bx - jugPos.x, by - jugPos.y);
        const push = 90 + 70 * rng();
        const x = bx + away.x * push;
        const y = by + away.y * push;
        if (clearance(world, x, y) >= 90) pushCand(x, y, "BAIT_LINE");
      }
    } else {
      // No jug belief: sample "awkward but not suicidal" open-ish edge bands.
      for (let i = 0; i < 16 && cands.length < 60; i++) {
        const x = r + rng() * (world.width - 2 * r);
        const y = r + rng() * (world.height - 2 * r);
        const c = clearance(world, x, y);
        if (c >= 95 && c <= 140) pushCand(x, y, "BAIT_LINE");
      }
    }
  }

  // Stance anchor candidate: movement can deliberately travel to an "open fortify" point.
  const garrisoning =
    (agent.stance?.chargingTo === "GARRISON") || stanceIsActive(agent, "GARRISON", now);
  if (garrisoning && agent.stance?.anchor) {
    pushCand(agent.stance.anchor.x, agent.stance.anchor.y, "STANCE_ANCHOR");
  }

  // Tactic-specific candidate sets.
  if (tactic === "BLOCK") {
    pushCand(agent.x, agent.y, "HOLD");
    if (jugPos && ctx.dJ < ctx.safeDistEff * 0.9) pushEscapeLaneFor("RETREAT_SHORT");
    if (weights.recover > 0.35) pushCenterOpen();
  } else if (tactic === "OPEN_UP" || tactic === "RETREAT_LONG" || tactic === "RETREAT_SHORT") {
    pushEscapeLaneFor(tactic);
    pushSafeMemory();
    pushCenterOpen();
    if (weights.bait > 0.18 && (ctx.oppSeen || ctx.dO < 360)) pushBaitLine();
    if (tactic === "RETREAT_SHORT" && (weights.duel > 0.25 || ctx.sceneId === "DUEL")) {
      const base = jugPos
        ? angleTo(opp.x - jugPos.x, opp.y - jugPos.y)
        : angleTo(center.x - opp.x, center.y - opp.y);
      pushAroundOpp("DUEL_RING", base, [-120, -80, -45, -20, 0, 20, 45, 80, 120], 150, 240);
    }
  } else if (tactic === "RESET") {
    pushCenterOpen();
    pushSafeMemory();
    if (ctx.jugChasingMe || weights.recover > 0.4) pushEscapeLaneFor("RESET");
    if (weights.bait > 0.28 && ctx.oppSeen) pushBaitLine();
  } else if (tactic === "PRESSURE") {
    const base = jugPos
      ? angleTo(opp.x - jugPos.x, opp.y - jugPos.y)
      : angleTo(center.x - opp.x, center.y - opp.y);
    pushAroundOpp("DUEL_RING", base, [-150, -110, -75, -40, -20, 0, 20, 40, 75, 110, 150], 120, 210);
    pushCenterOpen();
    if (weights.bait > 0.26) pushBaitLine();
  } else if (tactic === "ATTACK") {
    const base = jugPos
      ? angleTo(opp.x - jugPos.x, opp.y - jugPos.y)
      : angleTo(agent.x - opp.x, agent.y - opp.y);
    // Include true close-range points so ATTACK can actually commit into exchanges.
    pushAroundOpp("DUEL_RING", base, [-150, -110, -75, -40, -20, 0, 20, 40, 75, 110, 150], 36, 140);
    // Wider approach points still exist to avoid simplistic head-on beelines.
    pushAroundOpp("ATTACK_LANE", base, [-90, -55, -25, 25, 55, 90], 120, 220);
    if (weights.bait > 0.2) pushBaitLine();
  } else if (tactic === "CLASH") {
    const base = jugPos
      ? angleTo(opp.x - jugPos.x, opp.y - jugPos.y)
      : angleTo(agent.x - opp.x, agent.y - opp.y);
    pushAroundOpp("DUEL_RING", base, [-135, -90, -45, 0, 45, 90, 135], 34, 90);
    // Micro sidesteps for readable circling.
    pushAroundOpp("DUEL_RING", base, [-70, 70], 70, 120);
  }

  if (!cands.length) pushCand(center.x, center.y, "CENTER");

  function scoreCand(cand) {
    const dir = normalize(cand.x - agent.x, cand.y - agent.y);
    const moveDist = hypot(cand.x - agent.x, cand.y - agent.y);
    const c = clearance(world, cand.x, cand.y);
    const avgC = avgClearanceAlong(world, agent.x, agent.y, cand.x, cand.y, 4);
    const { safeBonus, trapPenalty } = escapeInfluenceFromSpots(agent, cand.x, cand.y, dir.x, dir.y);

    const route = jugRouteRisk(world, agent, j, cand);
    const oppRoute = opponentRouteRisk(agent, opp, cand);

    const awareMul = clamp(0.25 + (ctx.jugQ ?? 0) * 0.75, 0.25, 1);
    let predSelfJ = predictJugDamage(now, agent, j, cand, 1.1) * awareMul;
    if ((tactic === "ATTACK" || tactic === "PRESSURE") && !(agent.senses.jug.visible || ctx.perceivedWindup)) predSelfJ *= 0.65;
    const predSelfO = predictOppDamage(agent, opp, cand);

    const hpN = ctx.hpN;
    const jugLethal = clamp01((agent.belief.jugDamage.mean / agent.maxHp) * 4.0);
    const survivalW = 1.0 + (1 - hpN) * 1.8 + jugLethal * 1.2;

    let score = 0;
    score += c * 1.8 + avgC * 1.2;
    score += safeBonus - trapPenalty;
    if (c < 90) score -= (90 - c) * (90 - c) * 0.12;
    score -= route.risk * 520;
    score -= oppRoute.risk * 280;
    score -= moveDist * 0.22;
    score -= oscillationPenalty(agent, dir.x, dir.y) * 0.45;

    score -= predSelfJ * survivalW * 1.6;
    score -= predSelfO * survivalW * 0.9;

    const stamW = (1 - ctx.stamN) * (0.6 + 0.6 * (agent.style?.staminaConserve ?? 0.45));
    score -= route.detourCost * 0.65 * stamW;

    const dOp = hypot(cand.x - opp.x, cand.y - opp.y);
    const dJp = jugPos ? hypot(cand.x - jugPos.x, cand.y - jugPos.y) : Infinity;

    // Recover objective: get open, jug-safe, and not over-sprint when low stamina.
    let recover = 0;
    if (Number.isFinite(dJp)) recover += 220 * clamp01((dJp - ctx.safeDistEff) / 240);
    recover += 180 * clamp01((dOp - 240) / 260);
    recover += c * 0.6;
    recover -= moveDist * (0.18 + 0.42 * (1 - ctx.stamN));

    // Duel objective: stay in a readable distance band and on a safe side.
    const duelDist = clamp(90 + 70 * (agent.style?.engageBias ?? 0.55), 90, 165);
    let duel = 0;
    duel -= Math.abs(dOp - duelDist) * 1.35;
    duel += c * 0.55;
    duel += Number.isFinite(dJp) ? 160 * clamp01((dJp - ctx.safeDistEff) / 200) : 40;
    if (dOp < 56 && tactic !== "ATTACK" && tactic !== "CLASH") duel -= 180;

    const meleeReach = MELEE_REACH;
    const hitRange = agent.r + opp.r + meleeReach;
    if (tactic === "ATTACK") {
      if (dOp <= hitRange * 1.1) duel += 280;
      else if (dOp <= hitRange * 1.45) duel += 140;
    } else if (tactic === "CLASH") {
      if (dOp <= hitRange * 1.15) duel += 180;
    }

    // Bait objective: tempt opponent into worse jug routes while staying jug-safe.
    let bait = 0;
    const baitIdeal = 220;
    bait -= Math.abs(dOp - baitIdeal) * 0.9;
    bait += c * 0.25;
    if (j && jugPos) {
      const oppKeepOut = j.r + opp.r + j.attack.rangePad + 24;
      const oppBand = oppKeepOut * 1.35;
      const oppPathDist = lineCircleClosestDist(opp.x, opp.y, cand.x, cand.y, jugPos.x, jugPos.y);
      const oppRouteToCand = clamp01((oppBand - oppPathDist) / Math.max(1e-6, oppBand));
      bait += (oppRouteToCand - route.risk) * 760;
      const oppDNow = hypot(opp.x - j.x, opp.y - j.y);
      bait += 240 * clamp01((dJp - oppDNow) / 220);
      if (dOp < 110) bait -= 120;
      if (dJp < ctx.safeDistEff * 0.95) bait -= 900;
    }

    // Kind nudges for stability/readability.
    if (cand.kind === "SAFE_MEMORY") score += 90 * weights.recover;
    if (cand.kind === "STANCE_ANCHOR") score += 220 * weights.recover;
    if (cand.kind === "ESCAPE_LANE") score += 90 * weights.recover;
    if (cand.kind === "DUEL_RING") score += 80 * weights.duel;
    if (cand.kind === "ATTACK_LANE") score += 60 * weights.duel;
    if (cand.kind === "BAIT_LINE") score += 180 * weights.bait;

    score += weights.recover * recover + weights.duel * duel + weights.bait * bait;

    return { score, predSelfJ, predSelfO, routeRisk: route.risk, detourCost: route.detourCost, kind: cand.kind };
  }

  let best = null;
  for (const c of cands) {
    const s = scoreCand(c);
    if (!best || s.score > best.score) best = { x: c.x, y: c.y, ...s };
  }

  return best ?? { x: center.x, y: center.y, score: 0, predSelfJ: 0, predSelfO: 0, routeRisk: 0, detourCost: 0, kind: "CENTER" };
}

function tacticTarget(world, agent, opp, j, tactic, rng) {
  // Backward-compatible wrapper used by executeTactic() when the cached commit target expires.
  const now = world.time;
  const jugQ = j ? agent.senses.jug.quality : 0;
  const dJ = j ? agent.senses.jug.beliefDist : Infinity;
  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const safeDistJ = desiredSafeDistToJug(agent);
  const safeDistEff = safeDistJ * lerp(0.55, 1.0, jugQ);
  const hpN = clamp01(agent.hp / Math.max(1e-6, agent.maxHp));
  const stamN = clamp01((agent.stamina ?? 0) / Math.max(1e-6, agent.maxStamina));
  const perceivedWindup = now - agent.events.jugWindupSeenAt < 0.4;
  const jugChasingMe =
    j &&
    j.agenda?.targetId === agent.id &&
    (agent.senses.jug.quality > 0.25 || agent.senses.jug.peripheral || agent.senses.jug.heard || now - agent.senses.jug.lastSeenAt < 1.2);

  const ctx = {
    now,
    jugQ,
    dJ,
    dO,
    safeDistJ,
    safeDistEff,
    hpN,
    stamN,
    fear: clamp01(agent.emotions?.fear ?? 0),
    finishP: estimateFinishProb(agent, opp),
    clearanceHere: agent.senses?.clearance ?? clearance(world, agent.x, agent.y),
    oppSeen: agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 220,
    jugChasingMe: Boolean(jugChasingMe),
    perceivedWindup,
    sceneId: agent.scene?.id ?? "RESET",
    garrisonActive: stanceIsActive(agent, "GARRISON", now),
    garrisonCharging: agent.stance?.chargingTo === "GARRISON",
    assaultActive: stanceIsActive(agent, "ASSAULT", now),
  };

  const weights = agent.nav?.objectives ?? computeObjectiveWeights(world, agent, opp, j, ctx);
  const goal = planGoalForTactic(world, agent, opp, j, tactic, ctx, weights, typeof rng === "function" ? rng : Math.random);
  return { x: goal.x, y: goal.y };
}

function oscillationPenalty(agent, dirX, dirY) {
  const dirs = agent.mem.lastDirs;
  if (dirs.length < 2) return 0;
  const d1 = dirs[dirs.length - 1];
  const d2 = dirs[dirs.length - 2];
  const a = dot(dirX, dirY, d1.x, d1.y);
  const b = dot(dirX, dirY, d2.x, d2.y);
  // Penalize flip-flopping (going opposite of recent headings).
  const flip = clamp01((-a + -b) * 0.5);
  return flip * 220;
}

function decideTactic(world, agent, opp, j) {
  const now = world.time;
  if (agent.hp <= 0) return;
  if (isAgentPhasedOut(agent, now)) return;

  const keyboardTask = getKeyboardTaskForAgent(world, agent);
  if (keyboardTask) {
    agent.tactic = "RESET";
    agent.posture = "NEUTRAL";
    agent.commitUntil = now + 0.55;
    agent.events.lastDecisionAt = now;
    agent.nav.target = { x: keyboardTask.keyX, y: keyboardTask.keyY };
    agent.nav.kind = "KEYBOARD_TASK";
    agent.nav.objectives = { recover: 0.85, duel: 0.08, bait: 0.07 };
    agent.nav.validUntil = now + 0.55;
    setThought(agent, `Keyboard task priority (${keyboardTask.mode})`, now);
    return;
  }

  const playerCmd = agent.id === (world.player?.controlledId ?? "A") ? getActivePlayerCommand(agent, now) : null;
  if (playerCmd) {
    const dO = hypot(agent.x - opp.x, agent.y - opp.y);
    const nearTarget = hypot(agent.x - playerCmd.x, agent.y - playerCmd.y) < 26;
    if (playerCmd.mode === "ATTACK") {
      agent.tactic = dO < agent.r + opp.r + MELEE_REACH * 1.6 ? "ATTACK" : "PRESSURE";
      agent.posture = "AGGRO";
      agent.nav.target = { x: opp.x, y: opp.y };
      agent.nav.kind = "PLAYER_ATTACK";
    } else if (playerCmd.mode === "RECOVER") {
      agent.tactic = "OPEN_UP";
      agent.posture = "DEFENSIVE";
      agent.nav.target = { x: playerCmd.x, y: playerCmd.y };
      agent.nav.kind = "PLAYER_RECOVER";
    } else {
      agent.tactic = "RESET";
      agent.posture = "NEUTRAL";
      agent.nav.target = { x: playerCmd.x, y: playerCmd.y };
      agent.nav.kind = "PLAYER_REPOSITION";
    }
    agent.commitUntil = now + 0.45;
    agent.events.lastDecisionAt = now;
    agent.nav.objectives = playerCmd.mode === "ATTACK"
      ? { recover: 0.12, duel: 0.7, bait: 0.18 }
      : playerCmd.mode === "RECOVER"
        ? { recover: 0.86, duel: 0.08, bait: 0.06 }
        : { recover: 0.42, duel: 0.44, bait: 0.14 };
    agent.nav.validUntil = now + 0.45;
    if (nearTarget && playerCmd.mode !== "ATTACK") {
      agent.playerCmd.until = now - 0.001;
      setThought(agent, `Player ${playerCmd.mode.toLowerCase()} complete`, now);
    }
    return;
  }

  const jugQ = j ? agent.senses.jug.quality : 0;
  const dJ = j ? agent.senses.jug.beliefDist : Infinity;
  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const hereC = clearance(world, agent.x, agent.y);

  const meleeReach = MELEE_REACH;
  const hitRange = agent.r + opp.r + meleeReach;
  const jugHitRange = j ? agent.r + j.r + j.attack.rangePad : Infinity;
  const safeDistJ = desiredSafeDistToJug(agent);
  // If the agent hasn't actually seen the jug recently, it "underestimates" spacing (less omniscient).
  const safeDistEff = safeDistJ * lerp(0.55, 1.0, jugQ);
  const hpN = clamp01(agent.hp / agent.maxHp);
  const garrisonActive = stanceIsActive(agent, "GARRISON", now);
  const assaultActive = stanceIsActive(agent, "ASSAULT", now);
  const garrisonCharging = agent.stance?.chargingTo === "GARRISON";

  const perceivedWindup = now - agent.events.jugWindupSeenAt < 0.4;
  const imminentJug =
    j &&
    (
      // Only treat the tell as actionable if it was perceived.
      (perceivedWindup && dJ < jugHitRange + 34) ||
      // If we can see the jug and it is winding up for us, also treat as imminent.
      (agent.senses.jug.visible && j.windupUntil > now && j.windupTargetId === agent.id && dJ < jugHitRange + 46)
    );

  const finishP = estimateFinishProb(agent, opp);

  // Scene control: choreograph longer-lived "beats" that feel human.
  const oppSeenBeat = agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 320;
  const jugSeenRecently = agent.senses.jug.visible || agent.senses.jug.peripheral || now - agent.senses.jug.lastSeenAt < 0.8;
  const gotHitRecently = now - agent.events.gotHitAt < 0.45;
  const gotJugHitRecently = now - agent.events.gotHitAt < 0.8 && agent.thought.includes("JUG HIT");
  const jugChasingMe =
    j &&
    j.agenda?.targetId === agent.id &&
    (agent.senses.jug.quality > 0.25 || agent.senses.jug.peripheral || agent.senses.jug.heard || now - agent.senses.jug.lastSeenAt < 1.2);
  const tellRecent = now - agent.events.jugWindupSeenAt < 0.55;
  const engageMomentum = clamp01(Math.max(0, (agent.events.engageUntil ?? -Infinity) - now) / 2.2);
  const followUpMomentum = clamp01(Math.max(0, (agent.events.followUpUntil ?? -Infinity) - now) / 1.2);
  const jugSafeForEngage = !j || (!jugChasingMe && dJ > safeDistEff * 1.08 && !tellRecent);

  function setScene(id, durMin, durMax) {
    if (agent.scene.id === id && now < agent.scene.until) return;
    agent.scene.id = id;
    agent.scene.startedAt = now;
    agent.scene.until = now + randRange(durMin, durMax);
  }

  // Distance-based escape holding (prevents "timer ends -> reengage -> run into jug/wrap").
  const escapeTooClose = j && jugChasingMe && dJ < safeDistEff * 1.0;
  const clearFromJug = !j || (dJ > safeDistEff * 1.1 && !tellRecent);
  if (clearFromJug) {
    if (!Number.isFinite(agent.scene.escapeClearSince)) agent.scene.escapeClearSince = now;
  } else {
    agent.scene.escapeClearSince = -Infinity;
  }
  const escapeClearLongEnough = Number.isFinite(agent.scene.escapeClearSince) && now - agent.scene.escapeClearSince > 0.6;
  const escapeHold = j && (escapeTooClose || tellRecent || gotJugHitRecently);

  if (gotJugHitRecently) {
    agent.scene.escapeClearSince = -Infinity;
    setScene("SCRAMBLE", 1.2, 1.9);
  } else if (escapeHold || (agent.scene.id === "ESCAPE" && !escapeClearLongEnough) || (agent.scene.id === "SCRAMBLE" && !escapeClearLongEnough)) {
    // Stay in ESCAPE until we're genuinely clear for a bit.
    if (agent.scene.id !== "ESCAPE") agent.scene.escapeClearSince = -Infinity;
    setScene("ESCAPE", 0.9, 1.6);
  } else if (imminentJug && jugSeenRecently) {
    agent.scene.escapeClearSince = -Infinity;
    setScene("ESCAPE", 0.9, 1.6);
  } else if ((engageMomentum > 0.2 || followUpMomentum > 0.15) && oppSeenBeat && jugSafeForEngage) {
    setScene("DUEL", 1.3, 2.4);
  } else if (finishP > 0.48 && oppSeenBeat && (!j || (!jugChasingMe && dJ > safeDistEff * 1.15))) {
    setScene("FINISH", 0.9, 1.6);
  } else if (now >= agent.scene.until) {
    if ((engageMomentum > 0.15 && oppSeenBeat && jugSafeForEngage) || (oppSeenBeat && (!j || (!jugChasingMe && dJ > safeDistEff * 1.12)))) {
      setScene("DUEL", 1.6, 3.1);
    }
    else setScene("RESET", 0.9, 1.8);
  }

  const stamN0 = clamp01((agent.stamina ?? 0) / Math.max(1e-6, agent.maxStamina));
  const ctx = {
    now,
    jugQ,
    dJ,
    dO,
    safeDistJ,
    safeDistEff,
    hpN,
    stamN: stamN0,
    fear: clamp01(agent.emotions?.fear ?? 0),
    finishP,
    clearanceHere: hereC,
    oppSeen: agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 220,
    jugChasingMe: Boolean(jugChasingMe),
    perceivedWindup,
    engageMomentum,
    followUpMomentum,
    sceneId: agent.scene.id,
    garrisonActive,
    garrisonCharging,
    assaultActive,
  };
  const objectives = computeObjectiveWeights(world, agent, opp, j, ctx);
  // Cache for executeTactic and for target refreshes mid-commit.
  agent.nav.objectives = objectives;
  const wR = objectives.recover;
  const wD = objectives.duel;
  const wB = objectives.bait;
  const style = agent.style ?? { riskTolerance: 0.5, wrapWhenChased: 0.25, staminaConserve: 0.5, engageBias: 0.5, aggression: 0.5, stubbornness: 0.5, blockBias: 0.5 };
  const aggression = clamp01(style.aggression ?? style.engageBias ?? 0.5);
  const stubbornness = clamp01(style.stubbornness ?? 0.5);
  const blockBias = clamp01(style.blockBias ?? 0.5);

  // Deterministic RNG for this decision: stable candidate targets within the commit.
  const bucket = Math.floor(now * 2); // 500ms buckets
  const seed = (hashSeed(`${agent.id}|${bucket}|${Math.round(agent.hp)}|${agent.tactic}`) ^ 0x9e3779b9) >>> 0;

  const candidates = [];
  const scene = agent.scene.id;
  const blockAllowed = isBlockJustified(world, agent, opp, j) && now >= (agent.blockCooldownUntil ?? 0);
  for (const id of TACTICS) {
    const oppImminent =
      opp.attackWindupUntil > now &&
      opp.attackWindupTargetId === agent.id &&
      dO < hitRange * 1.9;
    // Scene-based option gating to create readable "beats".
    if (scene === "DUEL" && (id === "RETREAT_LONG" || id === "OPEN_UP")) continue;
    if (scene === "SCRAMBLE" && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) continue;
    if (scene === "ESCAPE" && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) continue;
    if (scene === "FINISH" && (id === "RETREAT_LONG" || id === "OPEN_UP")) continue;
    if (scene === "RESET") {
      const oppSeen = agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 300;
      const recentEngage = engageMomentum > 0.2 && dO < 320;
      const jugFarForEngage = !j || dJ > safeDistEff * 1.2;
      if ((id === "ATTACK" || id === "CLASH") && !oppSeen && !recentEngage) continue;
      if (id === "PRESSURE" && !oppSeen && !recentEngage && !jugFarForEngage) continue;
    }

    // Guardrails: when truly in danger, avoid aggressive commits.
    if (imminentJug && (id === "ATTACK" || id === "PRESSURE")) continue;
    if (agent.hitstunUntil > now && id !== "BLOCK") continue;

    // Stance gating: garrison reduces "random aggression" while fortifying; assault reduces turtling.
    if ((garrisonActive || garrisonCharging) && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) {
      if (!(agent.senses.opp.visible || agent.senses.opp.peripheral) || dO > hitRange * 1.15) continue;
    }
    if (assaultActive && (id === "RETREAT_LONG" || id === "OPEN_UP" || id === "RESET")) {
      if (!imminentJug && dO < 260) continue;
    }

    // BLOCK must be justified (reactive), otherwise it causes "idle freezing".
    if (id === "BLOCK" && agent.hitstunUntil <= now && (!blockAllowed || (!imminentJug && !oppImminent))) continue;

    const goalSeed = (seed ^ hashSeed(`goal|${id}`)) >>> 0;
    const goalRng = makeRng(goalSeed);
    const goal = planGoalForTactic(world, agent, opp, j, id, ctx, objectives, goalRng);

    const target = { x: goal.x, y: goal.y };
    const dir = normalize(target.x - agent.x, target.y - agent.y);

    let predSelfJ = goal.predSelfJ;
    const predSelfO = goal.predSelfO;
    const predOpp = predictDealDamage(agent, opp, target);

    // Route planning: penalize targets that require threading through/near the jug.
    // This is what makes "run away -> re-engage" choose an approach lane around the jug instead of beelining into it.
    const route = { risk: goal.routeRisk ?? 0, detourCost: goal.detourCost ?? 0 };
    const meanDmg = agent.belief.jugDamage.mean;
    predSelfJ += meanDmg * route.risk * 0.55 * (jugChasingMe ? 1.25 : 1.0);

    const c = clearance(world, target.x, target.y);
    const avgC = avgClearanceAlong(world, agent.x, agent.y, target.x, target.y, 4);

    // Survival dominates as HP drops and juggernaut damage rises.
    const jugLethal = clamp01((agent.belief.jugDamage.mean / agent.maxHp) * 4.0);
    const survivalWeight = 1.1 + (1 - hpN) * 2.0 + jugLethal * 1.4;
    const winWeight = 0.85 + finishP * 1.25;

    // If we're pinned (low clearance), strongly favor opening up / reset.
    const pinned = hereC < 85 && dJ < safeDistEff * 0.95;
    const pinnedBonus = pinned && (id === "OPEN_UP" || id === "RESET" || id === "RETREAT_LONG") ? 280 : 0;

    let score = 0;
    score -= predSelfJ * survivalWeight * 1.6;
    score -= predSelfO * survivalWeight * 0.9;
    score += predOpp * winWeight * 1.0;

    // Space preference (avoid corners).
    score += c * 1.6 + avgC * 1.2;
    if (c < 80) score -= (80 - c) * (80 - c) * 0.08;

    // Detours are tiring: if you're low stamina, prefer plans that don't require wrapping around the jug.
    const stamN = clamp01((agent.stamina ?? 0) / Math.max(1e-6, agent.maxStamina));
    score -= route.detourCost * (1 - stamN) * 0.65;

    // Objective alignment bonus: the movement system is goal-driven, so tactics should follow the current intent blend.
    if (id === "OPEN_UP" || id === "RETREAT_LONG" || id === "RESET") score += 220 * wR + 90 * wB - 170 * wD;
    else if (id === "RETREAT_SHORT") score += 160 * wR + 170 * wB - 80 * wD;
    else if (id === "PRESSURE") score += 220 * wD + 170 * wB - 80 * wR;
    else if (id === "ATTACK") score += 300 * wD - 90 * wR;
    else if (id === "CLASH") score += 250 * wD - 60 * wR;
    else if (id === "BLOCK") score += 70 * wR + 70 * wD;

    const aggrDelta = aggression - 0.5;
    const stubbornDelta = stubbornness - 0.5;
    const blockDelta = blockBias - 0.5;
    if (id === "ATTACK") score += aggrDelta * 620 + stubbornDelta * 220;
    if (id === "PRESSURE") score += aggrDelta * 520 + stubbornDelta * 160;
    if (id === "CLASH") score += aggrDelta * 440 + stubbornDelta * 130;
    if (id === "RETREAT_LONG" || id === "OPEN_UP" || id === "RESET") score -= aggrDelta * 380 + stubbornDelta * 150;
    if (id === "RETREAT_SHORT") score -= aggrDelta * 220;
    if (id === "BLOCK") score += blockDelta * 250 - aggrDelta * 140;

    // When the jug is actively pursuing me, don't let the agent "escape by wrapping around".
    // Wrapping becomes an explicit, personality-weighted choice that's usually avoided unless payoff is high.
    const doingCloseWork = id === "ATTACK" || id === "PRESSURE" || id === "CLASH";
    const reengageOk = !jugChasingMe || dJ > safeDistEff * 1.25;
    let wrapIntent = 0;
    if (jugChasingMe && doingCloseWork) {
      const baitDrive = clamp(0.25 + wB * 0.75, 0.25, 1.0);
      const wrapDrive =
        (style.wrapWhenChased ?? 0.25) *
        (0.25 + 0.75 * stamN) *
        (0.55 + 0.45 * finishP) *
        (0.6 + 0.4 * (style.riskTolerance ?? 0.5)) *
        baitDrive;
      wrapIntent = clamp01(wrapDrive - route.risk * 0.7 - clamp01(predSelfJ / Math.max(1e-6, meanDmg)) * 0.25);

      // If not actually clear yet, strongly discourage re-engaging, regardless of "wrap temptation".
      if (!reengageOk) score -= 900 * clamp01(1.1 - stamN);

      // Penalize high-risk routes unless the agent explicitly "wants" to wrap (personality + stamina + finish window).
      if (route.risk > 0.18 && wrapIntent < 0.38) {
        score -= (0.38 - wrapIntent) * route.risk * 1400;
      }
    }

    // Anti-orbit constraint: discourage tangential movement around the jug when close.
    if (j && dir.len > 1e-6) {
      const awayJ = normalize(agent.x - j.x, agent.y - j.y);
      const radial = dot(dir.x, dir.y, awayJ.x, awayJ.y); // +1 = directly away
      const tangential = Math.abs(cross2(dir.x, dir.y, awayJ.x, awayJ.y)); // 0 = radial, 1 = tangential
      const closeF = clamp01((safeDistEff * 1.15 - dJ) / (safeDistEff * 1.15));
      score -= closeF * clamp01(0.22 - radial) * 520;
      score -= closeF * clamp01(tangential - 0.68) * 380;

      // Escape-lane bonus: increase clearance AND increase distance to jug.
      const dJt = hypot(target.x - j.x, target.y - j.y);
      const dd = clamp(dJt - dJ, -120, 220);
      const dc = clamp(c - hereC, -120, 220);
      if (dd > 0 && dc > 0) score += closeF * (dd * 0.9 + dc * 1.2);

      // Hard "standoff" preference: when retreating, penalize targets that don't open a real gap.
      const wantsFar = id === "RETREAT_LONG" || id === "OPEN_UP";
      const desired = safeDistEff + (wantsFar ? 160 : 60);
      const shortfall = clamp01((desired - dJt) / Math.max(1e-6, desired));
      score -= shortfall * shortfall * (wantsFar ? 1350 : 720);
    }

    // Don't hang out close to the jug unless winning is imminent.
    if (j) {
      const closeness = clamp01((safeDistEff - dJ) / safeDistEff);
      score -= closeness * closeness * 520 * (1 - finishP);
      if ((id === "ATTACK" || id === "PRESSURE") && closeness > 0.15 && finishP < 0.2) score -= 240;
      if ((id === "RETREAT_LONG" || id === "OPEN_UP") && closeness > 0.2) score += 220;
    }
    if ((!j || dJ > safeDistEff * 0.95) && dO < 220) {
      if (id === "RETREAT_SHORT") score -= 180;
      if (id === "OPEN_UP") score -= 120;
    }

    // If within melee range, ATTACK has extra value.
    if (id === "ATTACK" && dO < hitRange * 1.05) score += 320;
    if (id === "PRESSURE" && dO > hitRange * 1.2) score += 165;
    if (id === "CLASH" && dO < 160) score += 230;
    if ((!j || dJ > safeDistEff * 1.25) && (agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 200)) {
      if (id === "ATTACK" && dO < hitRange * 2.2) score += 320;
      if (id === "PRESSURE" && dO < hitRange * 2.8) score += 210;
      if (id === "CLASH" && dO < hitRange * 1.8) score += 170;
      if (id === "RETREAT_SHORT" || id === "RESET") score -= 180;
    }

    // Engage bias: if jug is far and the opponent is visible/nearby, humans tend to close.
    const oppSeen = agent.senses?.opp?.visible || agent.senses?.opp?.peripheral || dO < 220;
    const jugFar = !j || dJ > safeDistEff * 1.2;
    if (oppSeen && jugFar) {
      const eb = (agent.style?.engageBias ?? 0.55);
      if (id === "PRESSURE" || id === "ATTACK") score += 170 + 150 * eb;
      if (id === "CLASH") score += 90 + 100 * eb;
      if (id === "RETREAT_LONG" || id === "OPEN_UP") score -= 130 + 90 * eb;
    } else if (jugFar) {
      if (id === "PRESSURE") score += 190;
      if (id === "ATTACK" && dO < 280) score += 120;
      if (id === "RETREAT_LONG" || id === "OPEN_UP" || id === "RESET") score -= 220;
    }

    // Scene flavor.
    if (scene === "DUEL") {
      if (id === "CLASH") score += 220;
      if (id === "RESET") score -= 140;
      if (id === "RETREAT_SHORT") score -= 80;
      if ((id === "ATTACK" || id === "PRESSURE" || id === "CLASH") && !perceivedWindup && !gotHitRecently) score += 120;
    } else if (scene === "SCRAMBLE") {
      if (id === "RETREAT_LONG" || id === "OPEN_UP") score += 220;
      if (id === "BLOCK") score += 80;
    } else if (scene === "FINISH") {
      if (id === "ATTACK" || id === "PRESSURE" || id === "CLASH") score += 210;
    }

    if (jugFar && dO < 260) {
      if (id === "ATTACK") score += 240;
      if (id === "CLASH") score += 170;
      if (id === "PRESSURE") score += 120;
      if (id === "RETREAT_LONG" || id === "OPEN_UP" || id === "RESET") score -= 280;
    }

    // If imminent jug hit, BLOCK is often best.
    if (id === "BLOCK" && imminentJug) score += 260;
    if (id === "BLOCK" && !imminentJug && !oppImminent) score -= 180;

    // Stance scoring.
    if ((garrisonActive || garrisonCharging) && (id === "OPEN_UP" || id === "RETREAT_LONG" || id === "RESET")) score += 120;
    if ((garrisonActive || garrisonCharging) && id === "BLOCK") score += imminentJug ? 200 : 110;
    if (assaultActive && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) score += 160;

    if (engageMomentum > 0 && jugSafeForEngage) {
      if (id === "ATTACK" || id === "PRESSURE" || id === "CLASH") score += 240 * engageMomentum;
      if (id === "RESET" || id === "OPEN_UP" || id === "RETREAT_LONG") score -= 260 * engageMomentum;
      if (id === "BLOCK" && !imminentJug && dO < hitRange * 1.9) score -= 220 * engageMomentum;
    }
    if (followUpMomentum > 0 && jugSafeForEngage) {
      if (id === "ATTACK" || id === "PRESSURE") score += 330 * followUpMomentum;
      if (id === "CLASH") score += 180 * followUpMomentum;
      if (id === "RESET" || id === "OPEN_UP" || id === "RETREAT_SHORT" || id === "RETREAT_LONG") {
        score -= 260 * followUpMomentum;
      }
      if (id === "BLOCK" && !imminentJug && !oppImminent) score -= 240 * followUpMomentum;
    }

    const currentlyDefensive =
      agent.tactic === "OPEN_UP" ||
      agent.tactic === "RESET" ||
      agent.tactic === "RETREAT_SHORT" ||
      agent.tactic === "RETREAT_LONG";
    if (currentlyDefensive && jugSafeForEngage && dO < 320) {
      if (id === agent.tactic) score -= 140;
      if (id === "ATTACK" || id === "PRESSURE" || id === "CLASH") score += 130;
    }

    // Oscillation penalty to stop ping-pong loops.
    score -= oscillationPenalty(agent, dir.x, dir.y);

    score += pinnedBonus;

    candidates.push({
      id,
      score,
      target,
      goalKind: goal.kind ?? "NONE",
      predSelfJ,
      predSelfO,
      predOpp,
      routeRisk: route.risk,
      wrapIntent,
      reengageOk: !jugChasingMe || dJ > safeDistEff * 1.25,
    });
  }

  const temperature = 0.22 + 0.28 * (0.35 + 0.65 * (1 - hpN));
  const chosenId = chooseSoftmax(candidates.map((c) => ({ id: c.id, score: c.score })), temperature);
  const chosen = candidates.find((c) => c.id === chosenId) ?? candidates[0];
  if (!chosen) return;

  // Plan visibility: record the top alternatives as "what I'm likely to do next".
  const ranked = [...candidates].sort((x, y) => y.score - x.score);
  const best = ranked[0];
  const second = ranked[1] ?? ranked[0];
  agent.plan.current = chosen.id;
  agent.plan.next = (best.id !== chosen.id ? best.id : second.id) ?? "-";
  agent.plan.plannedAt = now;
  // Confidence: gap between #1 and #2 mapped to 0..1.
  const gap = (best?.score ?? 0) - (second?.score ?? (best?.score ?? 0));
  agent.plan.confidence = clamp01(0.5 + gap / 600);

  // Commit: longer when calm; shorter when under pressure.
  const pressure = clamp01((safeDistEff - dJ) / safeDistEff);
  let dur = clamp(randRange(0.55, 1.25) * lerp(1.05, 0.75, pressure), 0.45, 1.35);
  const prev = agent.tactic;
  dur *= lerp(0.84, 1.2, stubbornness);
  if (chosen.id === "ATTACK" || chosen.id === "PRESSURE" || chosen.id === "CLASH") dur *= lerp(0.9, 1.24, aggression);
  if (chosen.id === "RETREAT_LONG" || chosen.id === "OPEN_UP") dur *= lerp(1.14, 0.84, aggression);
  dur = clamp(dur, 0.34, 1.75);
  if (chosen.id === "BLOCK") {
    // BLOCK is a short, reactive commit (prevents multi-second freezing).
    dur = clamp(randRange(0.16, imminentJug ? 0.5 : 0.38) * lerp(0.86, 1.2, blockBias), 0.14, 0.72);
  }
  agent.commitUntil = now + dur;
  agent.tactic = chosen.id;
  agent.posture = pickPosture(agent, chosen.id);
  agent.events.lastDecisionAt = now;

  // Cache commit target to prevent per-frame re-sampling jitter.
  agent.nav.target = { x: chosen.target.x, y: chosen.target.y };
  agent.nav.kind = chosen.goalKind ?? "NONE";
  agent.nav.objectives = objectives;
  agent.nav.validUntil = agent.commitUntil;
  agent.nav.seed = seed;

  agent.lastEval.predSelfJ = chosen.predSelfJ;
  agent.lastEval.predSelfO = chosen.predSelfO;
  agent.lastEval.predOpp = chosen.predOpp;
  agent.lastEval.routeRisk = chosen.routeRisk ?? 0;
  agent.lastEval.jugChasingMe = Boolean(jugChasingMe);
  agent.lastEval.reengageOk = chosen.reengageOk ?? (!jugChasingMe || dJ > safeDistEff * 1.25);
  agent.lastEval.wrapIntent = chosen.wrapIntent ?? 0;

  // Save dir memory (for oscillation penalty).
  const dir = normalize(chosen.target.x - agent.x, chosen.target.y - agent.y);
  if (dir.len > 1e-6) {
    agent.mem.lastDirs.push({ x: dir.x, y: dir.y });
    while (agent.mem.lastDirs.length > 3) agent.mem.lastDirs.shift();
  }

  // Thought string (debug).
  const parts = [];
  if (imminentJug) parts.push("imminent jug hit");
  if (finishP > 0.35) parts.push(`finish p=${finishP.toFixed(2)}`);
  if (hereC < 90) parts.push(`clearance=${Math.round(hereC)}`);
  setThought(
    agent,
    `Pick ${chosen.id} (${agent.posture}) | dJ=${Math.round(dJ)} dO=${Math.round(dO)} ` +
      `predJ=${chosen.predSelfJ.toFixed(1)} predO=${chosen.predSelfO.toFixed(1)} deal=${chosen.predOpp.toFixed(1)}` +
      ` routeJ=${(chosen.routeRisk ?? 0).toFixed(2)}` +
      ` | next=${agent.plan.next}` +
      ` | obj R/D/B=${wR.toFixed(2)}/${wD.toFixed(2)}/${wB.toFixed(2)} goal=${chosen.goalKind ?? "?"}` +
      (parts.length ? ` | ${parts.join(", ")}` : "") +
      (jugChasingMe ? ` | chased${agent.lastEval.reengageOk ? "" : ":hold"} wrap=${(agent.lastEval.wrapIntent ?? 0).toFixed(2)}` : "") +
      (garrisonActive ? " | stance=garrison" : assaultActive ? " | stance=assault" : ""),
    now,
  );

  // Block timing: strongest when raised before impact.
  if (chosen.id === "BLOCK") {
    // Treat each BLOCK commit as a real "raise" (not a multi-second hold).
    agent.blockRaisedAt = now;
    agent.blockUntil = Math.max(agent.blockUntil, now + 0.34);
    // Cooldown prevents oscillatory "block spam" and forces a follow-up action.
    let cd = randRange(0.55, 1.2);
    if (garrisonActive) cd *= 0.55;
    if (assaultActive) cd *= 1.1;
    agent.blockCooldownUntil = Math.max(agent.blockCooldownUntil ?? 0, now + cd);
  }

  // ENFP-ish feint: occasionally delay the attack briefly (not under immediate jug threat).
  agent.feintUntil = 0;
  if (chosen.id === "ATTACK" && !imminentJug && random01() < 0.14 && dO < hitRange * 1.5) {
    agent.feintUntil = now + randRange(0.14, 0.22);
    agent.thought = `${agent.thought} | feint`;
    agent.thoughtSince = now;
  }
}

function executeTactic(world, agent, opp, j, dt) {
  const now = world.time;
  if (agent.hp <= 0) {
    damp(agent, dt);
    return { wantsAttack: false };
  }

  if (isAgentPhasedOut(agent, now)) {
    agent.vx = 0;
    agent.vy = 0;
    return { wantsAttack: false };
  }

  if (isTwirlRushActive(agent, now)) {
    const tx = Number.isFinite(agent.fx?.twirlTargetX) ? agent.fx.twirlTargetX : agent.x;
    const ty = Number.isFinite(agent.fx?.twirlTargetY) ? agent.fx.twirlTargetY : agent.y;
    const toTwirl = normalize(tx - agent.x, ty - agent.y);
    const twirlSpeed = agent.maxSpeed * 2.05 * Math.max(0.65, getAgentSpeedMul(agent, now));
    agent.vx = toTwirl.x * twirlSpeed;
    agent.vy = toTwirl.y * twirlSpeed;
    agent.x = clamp(agent.x + agent.vx * dt, agent.r, world.width - agent.r);
    agent.y = clamp(agent.y + agent.vy * dt, agent.r, world.height - agent.r);
    if (toTwirl.len > 1e-6) agent.heading = wrapAngle(angleTo(toTwirl.x, toTwirl.y));
    if (hypot(agent.x - tx, agent.y - ty) <= agent.r + 10) {
      agent.fx.twirlUntil = now - 0.001;
      agent.fx.twirlTargetX = NaN;
      agent.fx.twirlTargetY = NaN;
      agent.fx.twirlStartX = NaN;
      agent.fx.twirlStartY = NaN;
      agent.vx = 0;
      agent.vy = 0;
      agent.motor.desiredVx = 0;
      agent.motor.desiredVy = 0;
    }
    return { wantsAttack: false };
  }

  // Hitstun: mostly lose control, but still slide.
  if (now < agent.hitstunUntil) {
    agent.vx *= 0.92;
    agent.vy *= 0.92;
    agent.x += agent.vx * dt;
    agent.y += agent.vy * dt;
    agent.x = clamp(agent.x, agent.r, world.width - agent.r);
    agent.y = clamp(agent.y, agent.r, world.height - agent.r);
    return { wantsAttack: false };
  }

  // Use the cached commit target (prevents per-frame jitter).
  let tgt = agent.nav.target;
  if (!tgt || now >= agent.nav.validUntil) {
    const rng = makeRng((agent.nav.seed ^ 0x85ebca6b) >>> 0);
    tgt = tacticTarget(world, agent, opp, j, agent.tactic, rng);
    agent.nav.target = tgt;
    agent.nav.validUntil = now + 0.25;
  }
  let dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
  const keyboardTask = getKeyboardTaskForAgent(world, agent);
  const keyboardFocused = Boolean(keyboardTask);
  const playerCmd = agent.id === (world.player?.controlledId ?? "A") ? getActivePlayerCommand(agent, now) : null;
  const playerFocused = Boolean(playerCmd) && !keyboardFocused;
  if (keyboardFocused) {
    tgt = { x: keyboardTask.keyX, y: keyboardTask.keyY };
    dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
    agent.nav.target = tgt;
    agent.nav.kind = "KEYBOARD_TASK";
    agent.nav.validUntil = now + 0.25;
  }
  if (playerFocused) {
    if (playerCmd.mode === "ATTACK") tgt = { x: opp.x, y: opp.y };
    else tgt = { x: playerCmd.x, y: playerCmd.y };
    dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
    agent.nav.target = tgt;
    agent.nav.kind = playerCmd.mode === "ATTACK" ? "PLAYER_ATTACK" : playerCmd.mode === "RECOVER" ? "PLAYER_RECOVER" : "PLAYER_REPOSITION";
    agent.nav.validUntil = now + 0.2;
  }

  const moveAngle = dir.len > 1e-6 ? wrapAngle(angleTo(dir.x, dir.y)) : agent.heading;
  const gaze = chooseGazeTarget(world, agent, opp, j, moveAngle, dt);

  // Turn-rate limited gaze (prevents snapping / buzzing).
  if (Number.isFinite(gaze.angle)) {
    const turnRate = ((agent.tactic === "ATTACK" ? 200 : 150) * Math.PI) / 180;
    turnToward(agent, gaze.angle, turnRate, dt);
  }

  let speed = agent.maxSpeed;
  const windupActive = agent.attackWindupUntil > now && agent.attackWindupTargetId === opp.id;
  const garrisonActive = stanceIsActive(agent, "GARRISON", now);
  const assaultActive = stanceIsActive(agent, "ASSAULT", now);

  if (agent.tactic === "BLOCK") speed *= 0.35;
  if (agent.tactic === "RETREAT_LONG") speed *= 1.05;
  if (agent.tactic === "RETREAT_SHORT") speed *= 0.95;
  if (agent.tactic === "OPEN_UP") speed *= 1.0;
  if (agent.tactic === "RESET") speed *= 0.95;
  if (agent.tactic === "ATTACK") speed *= 1.06;
  if (agent.tactic === "PRESSURE") speed *= 0.96;
  if (agent.tactic === "CLASH") speed *= 0.72;
  if (garrisonActive) speed *= 0.68;
  if (assaultActive) speed *= 1.06;
  if (windupActive) speed *= 1.12;
  if (keyboardFocused) speed *= 1.28;
  if (playerFocused) speed *= playerCmd.mode === "ATTACK" ? 1.16 : 1.1;
  speed *= getAgentSpeedMul(agent, now);
  // Glancing has a real movement cost (human tradeoff).
  speed *= gaze.speedMul ?? 1;

  const objectives = agent.nav.objectives ?? { recover: 0.34, duel: 0.33, bait: 0.33 };
  const jugQ = j ? agent.senses.jug.quality : 0;
  const dJ = j ? agent.senses.jug.beliefDist : Infinity;
  const safeDistEff = (j ? desiredSafeDistToJug(agent) : 260) * lerp(0.55, 1.0, jugQ);
  const threatenedNow = Boolean(j && (dJ < safeDistEff * 0.95 || now - agent.events.jugWindupSeenAt < 0.45));
  const threatened = Boolean(j && dJ < safeDistEff * 1.0);
  const stamN = clamp01((agent.stamina ?? 0) / Math.max(1e-6, agent.maxStamina));

  // Recovery intent: when actually safe, slow down and stop over-sprinting so stamina can come back.
  if (!threatenedNow) {
    speed *= lerp(1.0, 0.72, objectives.recover ?? 0);
    if (stamN < 0.35) speed *= 0.92;
  }

  if (windupActive && !threatenedNow) {
    tgt = { x: opp.x, y: opp.y };
    dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
  }

  // Wall repulsion as a side force. When retreating, push away earlier/stronger so we don't back into corners.
  const retreating =
    agent.tactic === "RETREAT_LONG" || agent.tactic === "RETREAT_SHORT" || agent.tactic === "OPEN_UP";
  const clearN = clamp01((140 - agent.senses.clearance) / 140);
  const repStrength = retreating ? 170 + 220 * clearN : 120 + 80 * clearN;
  const repPad = retreating ? 170 : 110;
  const rep = wallRepulsion(world, agent.x, agent.y, agent.r, repStrength, repPad);

  // Juggernaut avoidance: steer around instead of pathing through it (costs stamina).
  let avoidV = { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  const doingCloseWork = agent.tactic === "ATTACK" || agent.tactic === "PRESSURE" || agent.tactic === "CLASH";
  const jugChasingMe =
    j &&
    j.agenda?.targetId === agent.id &&
    (agent.senses.jug.quality > 0.25 || agent.senses.jug.peripheral || agent.senses.jug.heard || now - agent.senses.jug.lastSeenAt < 1.2);
  const baitW = objectives.bait ?? 0;
  const wrapAllowedNow = Boolean(
    jugChasingMe &&
      baitW > 0.55 &&
      (agent.lastEval?.wrapIntent ?? 0) > 0.4 &&
      stamN > 0.6 &&
      (agent.lastEval?.reengageOk ?? true),
  );

  // Jug avoidance.
  let jugAvoidV = { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  if (doingCloseWork || agent.tactic === "RESET" || threatened) {
    const preferRadial = Boolean(
      threatenedNow ||
        (objectives.recover ?? 0) > 0.45 ||
        (jugChasingMe && baitW < 0.35),
    );
    jugAvoidV = jugAvoidance(world, agent, j, tgt, dt, { preferRadial, wrapAllowed: wrapAllowedNow && !preferRadial });
  }

  // Opponent avoidance / orbiting footwork (adds curved maneuvering in duels).
  const meleeReachMove = MELEE_REACH;
  const hitRangeMove = agent.r + opp.r + meleeReachMove;
  const dOMove = hypot(agent.x - opp.x, agent.y - opp.y);
  const engageWindow = doingCloseWork && !threatenedNow && dOMove < hitRangeMove * 3.2;
  if ((engageWindow || windupActive) && !threatenedNow) {
    tgt = { x: opp.x, y: opp.y };
    dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
    speed *= 1.08;
  }
  const attackCommitted = agent.tactic === "ATTACK" && dOMove < hitRangeMove * 1.35;
  const allowCloseToOpp =
    doingCloseWork &&
    (attackCommitted || dOMove < hitRangeMove * 2.2 || hypot(tgt.x - opp.x, tgt.y - opp.y) < (agent.r + opp.r + 40) * 1.4);
  const preferTangential =
    !threatenedNow &&
    !attackCommitted &&
    ((objectives.duel ?? 0) > 0.42 || baitW > 0.55);
  const pressureCommit = agent.tactic === "PRESSURE" && dOMove < hitRangeMove * 1.9;
  const oppAvoidV =
    (windupActive || engageWindow || attackCommitted || pressureCommit) && !threatenedNow
      ? { vx: 0, vy: 0, intensity: 0, costPerSec: 0 }
      : opponentAvoidance(world, agent, opp, tgt, dt, { preferTangential, allowClose: allowCloseToOpp });

  let orbitV = { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  if (!threatenedNow && !engageWindow && !windupActive && dOMove < 300 && agent.tactic !== "ATTACK" && dOMove > hitRangeMove * 0.95) {
    const orbitI = clamp01((300 - dOMove) / 300) * clamp01((objectives.duel ?? 0) * 1.15 + baitW * 0.65);
    if (orbitI > 0.01) {
      const toOpp = normalize(opp.x - agent.x, opp.y - agent.y);
      const side = ((agent.nav.seed >>> 0) & 1) ? 1 : -1;
      const tang = { x: -toOpp.y * side, y: toOpp.x * side };
      const mag = (35 + 95 * (objectives.duel ?? 0) + 55 * baitW) * orbitI;
      orbitV = { vx: tang.x * mag, vy: tang.y * mag, intensity: orbitI, costPerSec: 1.5 + 2.5 * orbitI };
    }
  }

  // Contact/bump response: if we brush the jug, force a strong radial/tangential slide so we don't "push a wall".
  let jugBumpV = { vx: 0, vy: 0, intensity: 0, costPerSec: 0 };
  if (j) {
    const dJReal = hypot(agent.x - j.x, agent.y - j.y);
    const minD = agent.r + j.r;
    const bumpPad = minD + 54;
    if (dJReal < bumpPad) {
      const away = normalize(agent.x - j.x, agent.y - j.y);
      const bumpI = clamp01((bumpPad - dJReal) / Math.max(1e-6, bumpPad - minD));
      const side = ((agent.nav.seed >>> 1) & 1) ? 1 : -1;
      const tang = { x: -away.y * side, y: away.x * side };
      const awayMag = (180 + 280 * bumpI) * (threatenedNow ? 1.0 : 0.85);
      const tangMag = 55 + 95 * bumpI;
      jugBumpV = {
        vx: away.x * awayMag + tang.x * tangMag,
        vy: away.y * awayMag + tang.y * tangMag,
        intensity: bumpI,
        costPerSec: 2.0 + 5.5 * bumpI,
      };
    }
  }

  avoidV = {
    vx: jugAvoidV.vx + oppAvoidV.vx + orbitV.vx + jugBumpV.vx,
    vy: jugAvoidV.vy + oppAvoidV.vy + orbitV.vy + jugBumpV.vy,
    intensity: Math.max(jugAvoidV.intensity ?? 0, oppAvoidV.intensity ?? 0, orbitV.intensity ?? 0, jugBumpV.intensity ?? 0),
    costPerSec: (jugAvoidV.costPerSec ?? 0) + (oppAvoidV.costPerSec ?? 0) + (orbitV.costPerSec ?? 0) + (jugBumpV.costPerSec ?? 0),
  };
  const avoidA = expSmoothing(dt, 0.12);
  agent.avoid.vx = lerp(agent.avoid.vx, avoidV.vx, avoidA);
  agent.avoid.vy = lerp(agent.avoid.vy, avoidV.vy, avoidA);

  // If our cached target is dragging us into a corner (clearance collapsing), retarget toward center.
  if (retreating && agent.senses.clearance < 70 && tgt) {
    const tc = clearance(world, tgt.x, tgt.y);
    if (tc < 85) {
      const center = { x: world.width * 0.5, y: world.height * 0.5 };
      const nt = {
        x: clamp(center.x + (agent.x - center.x) * 0.25, agent.r, world.width - agent.r),
        y: clamp(center.y + (agent.y - center.y) * 0.25, agent.r, world.height - agent.r),
      };
      agent.nav.target = nt;
      agent.nav.validUntil = now + 0.35;
      tgt = nt;
      dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
    }
  }

  // Hover/loiter: if we've reached a recover-oriented goal and we're safe, avoid sprinting in place.
  if (dir.len < 34 && (objectives.recover ?? 0) > 0.55 && !threatenedNow) {
    speed *= 0.65;
    if (dir.len < 18) speed *= 0.35;

    const cHere = agent.senses?.clearance ?? clearance(world, agent.x, agent.y);
    if (cHere < 125) {
      const center = { x: world.width * 0.5, y: world.height * 0.5 };
      const away = j ? normalize(agent.x - j.x, agent.y - j.y) : normalize(center.x - agent.x, center.y - agent.y);
      const base = angleTo(away.x + (center.x - agent.x) * 0.0012, away.y + (center.y - agent.y) * 0.0012);
      const bucket = Math.floor(now * 3);
      const hrng = makeRng((agent.nav.seed ^ hashSeed(`hover|${agent.id}|${bucket}`)) >>> 0);
      const off = (hrng() - 0.5) * 0.9;
      const L = 20 + 14 * hrng();
      const nt = {
        x: clamp(agent.x + Math.cos(base + off) * L, agent.r, world.width - agent.r),
        y: clamp(agent.y + Math.sin(base + off) * L, agent.r, world.height - agent.r),
      };
      agent.nav.target = nt;
      agent.nav.validUntil = now + 0.35;
      tgt = nt;
      dir = normalize(tgt.x - agent.x, tgt.y - agent.y);
    }
  }

  // Apply accel penalty by scaling dt inside steerTo (cheaper than threading maxAccel).
  const accelDt = dt * (gaze.accelMul ?? 1);
  if (dir.len < 1e-6) {
    // Still honor wall + avoidance forces (prevents "block and freeze into wall" issues).
    steerTo(agent, agent.x, agent.y, 0, accelDt, rep.x + agent.avoid.vx, rep.y + agent.avoid.vy);
  } else {
    steerTo(agent, tgt.x, tgt.y, speed, accelDt, rep.x + agent.avoid.vx, rep.y + agent.avoid.vy);
  }

  // Clamp speed.
  const v = normalize(agent.vx, agent.vy);
  const vmax = agent.maxSpeed * 1.15;
  if (v.len > vmax) {
    agent.vx = v.x * vmax;
    agent.vy = v.y * vmax;
  }

  agent.x += agent.vx * dt;
  agent.y += agent.vy * dt;
  agent.x = clamp(agent.x, agent.r, world.width - agent.r);
  agent.y = clamp(agent.y, agent.r, world.height - agent.r);

  // Stamina model: sprinting + detouring around the jug costs; recovery happens when calmer/slow.
  {
    const vN = clamp01(hypot(agent.vx, agent.vy) / Math.max(1e-6, agent.maxSpeed));
    const fear = agent.emotions?.fear ?? 0;
    const calmN = clamp01(1 - fear);
    const regen = (9 + 8 * calmN) * (vN < 0.35 ? 1.0 : 0.55);
    const baseDrain = (3.5 + 7.5 * vN) * (fear > 0.55 ? 1.15 : 1.0);
    const avoidDrain = (avoidV.costPerSec ?? 0);
    const stanceDrain = garrisonActive ? 0.6 : assaultActive ? 1.1 : 0;
    const delta = (regen - (baseDrain + avoidDrain + stanceDrain)) * dt;
    agent.stamina = clamp(agent.stamina + delta, 0, agent.maxStamina);
  }

  // Block effect window: active while tactic is BLOCK (commit-length).
  if (agent.tactic === "BLOCK") agent.blockUntil = Math.max(agent.blockUntil, now + 0.22);

  // Begin an attack windup if we're committing to attack/pressure (unless feinting).
  const meleeReach = MELEE_REACH;
  const hitRange = agent.r + opp.r + meleeReach;
  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const opportunisticJab =
    !threatenedNow &&
    agent.tactic !== "BLOCK" &&
    dO <= hitRange * 1.9 &&
    (
      (objectives.duel ?? 0) > 0.18 ||
      agent.scene?.id === "DUEL" ||
      agent.scene?.id === "FINISH"
    );
  const wantsAttack =
    (((agent.tactic === "ATTACK" || agent.tactic === "PRESSURE" || agent.tactic === "CLASH") && now >= agent.feintUntil) ||
      opportunisticJab) &&
    !keyboardFocused &&
    !(playerFocused && playerCmd.mode !== "ATTACK");
  const rosinLocked = now < (agent.fx?.rosinUntil ?? 0);
  if (rosinLocked) {
    agent.attackWindupUntil = 0;
    agent.attackWindupTargetId = null;
  }
  const preRange =
    agent.tactic === "ATTACK"
      ? hitRange * 2.8
      : agent.tactic === "PRESSURE"
        ? hitRange * 2.5
        : agent.tactic === "CLASH"
          ? hitRange * 2.2
          : hitRange * 1.5;
  if (
    wantsAttack &&
    !rosinLocked &&
    now >= agent.atkCdUntil &&
    !(agent.attackWindupUntil > now) &&
    dO <= preRange
  ) {
    let w = randRange(0.07, 0.12);
    if (opportunisticJab && agent.tactic !== "ATTACK" && agent.tactic !== "PRESSURE") w *= 0.88;
    if (assaultActive) w *= 0.78;
    if (garrisonActive) w *= 1.12;
    const atkSpeedMul = Math.max(0.35, getAgentAttackSpeedMul(agent, now));
    w /= atkSpeedMul;
    agent.attackWindupUntil = now + w;
    agent.attackWindupTargetId = opp.id;
    agent.events.engageUntil = Math.max(agent.events.engageUntil ?? -Infinity, now + 1.1);
  }

  return { wantsAttack: wantsAttack && !rosinLocked };
}

function resolveCombat(world, actionsById) {
  const now = world.time;
  const [a, b] = world.agents;
  const j = world.juggernaut;
  if (!a || !b || !j) return;

  // Agent melee (windup -> impact).
  const meleeReach = MELEE_REACH;
  const hitRangeAB = a.r + b.r + meleeReach;

  function resolveMeleeImpact(attacker, victim) {
    if (attacker.hp <= 0 || victim.hp <= 0) return;
    if (isAgentPhasedOut(attacker, now) || isAgentPhasedOut(victim, now)) return;
    if (now < (attacker.fx?.rosinUntil ?? 0)) return;
    if (!(attacker.attackWindupUntil > 0) || now < attacker.attackWindupUntil) return;
    if (attacker.attackWindupTargetId !== victim.id) return;

    const d = hypot(attacker.x - victim.x, attacker.y - victim.y);
    const strikeRange =
      hitRangeAB +
      (attacker.tactic === "ATTACK" ? 28 : attacker.tactic === "CLASH" ? 22 : 16);
    const baseDmg = randRange(8, 12);
    const dmg = baseDmg * getAgentDamageOutMul(attacker, now);
    if (d <= strikeRange) {
      const dealt = applyDamage(
        world,
        victim,
        { kind: "AGENT", id: attacker.id, x: attacker.x, y: attacker.y },
        dmg,
        240,
        0.14,
      );
      updateOpponentHpBelief(attacker, victim, dealt, now);
      victim.belief.oppDamage.mean = learnedEma(victim.belief.oppDamage.mean, dealt, 0.15);
      attacker.thought = `${attacker.thought} | HIT ${victim.id} for ${Math.round(dealt)}`;
      attacker.thoughtSince = now;
      attacker.events.dealtHitAt = now;
      attacker.events.dealtDamage = dealt;
      attacker.events.engageUntil = Math.max(attacker.events.engageUntil ?? -Infinity, now + randRange(1.5, 2.5));
      victim.events.engageUntil = Math.max(victim.events.engageUntil ?? -Infinity, now + randRange(1.0, 1.8));
      attacker.events.followUpUntil = Math.max(attacker.events.followUpUntil ?? -Infinity, now + randRange(0.8, 1.35));
      victim.events.followUpUntil = Math.max(victim.events.followUpUntil ?? -Infinity, now + randRange(0.45, 0.85));
      let cd = randRange(0.42, 0.70);
      if (stanceIsActive(attacker, "ASSAULT", now)) cd *= 0.85;
      if (stanceIsActive(attacker, "GARRISON", now)) cd *= 1.12;
      const atkSpeedMul = Math.max(0.35, getAgentAttackSpeedMul(attacker, now));
      cd /= atkSpeedMul;
      attacker.atkCdUntil = now + cd;
    } else {
      // Miss still costs time.
      let cd = randRange(0.28, 0.42);
      if (stanceIsActive(attacker, "ASSAULT", now)) cd *= 0.92;
      if (stanceIsActive(attacker, "GARRISON", now)) cd *= 1.1;
      const atkSpeedMul = Math.max(0.35, getAgentAttackSpeedMul(attacker, now));
      cd /= atkSpeedMul;
      attacker.atkCdUntil = now + cd;
    }

    attacker.attackWindupUntil = 0;
    attacker.attackWindupTargetId = null;
  }

  resolveMeleeImpact(a, b);
  resolveMeleeImpact(b, a);

  // Juggernaut hit (very deadly): windup -> impact.
  if (j.windupUntil > 0 && now >= j.windupUntil) {
    const target = getAgent(world, j.windupTargetId ?? j.agenda.targetId) ?? jugPickTarget(world);
    if (target && target.hp > 0) {
      const hitRangeJ = j.r + target.r + j.attack.rangePad;
      const d = hypot(target.x - j.x, target.y - j.y);
      if (d <= hitRangeJ) {
        const dmg = randRange(j.attack.damage * 0.9, j.attack.damage * 1.15);
        const dealt = applyDamage(
          world,
          target,
          { kind: "JUG", id: "JUG", x: j.x, y: j.y },
          dmg,
          j.attack.knockback,
          j.attack.hitstun,
        );
        for (const obs of world.agents) {
          if (obs.id === target.id) continue;
          obs.belief.jugDamage.mean = learnedEma(obs.belief.jugDamage.mean, dealt * randRange(0.85, 1.2), 0.18);
        }
        target.thought = `${target.thought} | JUG HIT ${Math.round(dealt)}`;
        target.thoughtSince = now;
      }
    }
    // Whether hit or miss, consume swing.
    j.atkCdUntil = now + j.attack.cd;
    j.windupUntil = 0;
    j.windupTargetId = null;
  }

  // If someone has been safe in open space for a while, record a safe spot.
  for (const ag of world.agents) {
    if (ag.hp <= 0) continue;
    const c = clearance(world, ag.x, ag.y);
    const dJ = hypot(ag.x - j.x, ag.y - j.y);
    const safeDist = desiredSafeDistToJug(ag);
    const safeNow = dJ > safeDist * 1.15 && c > 120;
    if (safeNow) {
      if (ag.mem.lastSafeAt < 0) ag.mem.lastSafeAt = now;
      if (now - ag.mem.lastSafeAt > 1.2) {
        const score = c * 0.9 + clamp(dJ - safeDist, 0, 220) * 0.4;
        upsertSpot(ag.mem.safeSpots, { x: ag.x, y: ag.y, score, lastAt: now }, 95);
        ag.mem.lastSafeAt = now + 999; // rate limit
      }
    } else if (ag.mem.lastSafeAt > -Infinity) {
      ag.mem.lastSafeAt = now;
    }
  }
}

async function maybeSendTerminalLog(world) {
  if (!world.terminalLog) return;
  const nowMs = performance.now();
  if (nowMs - world._lastLogAt < world.logIntervalMs) return;
  world._lastLogAt = nowMs;

  const j = world.juggernaut;
  const a = world.agents[0];
  const b = world.agents[1];
  if (!j || !a || !b) return;

  const payload = {
    t: world.time,
    intervalMs: world.logIntervalMs,
    juggernaut: {
      mode: j.agenda.mode,
      targetId: j.agenda.targetId,
      cdLeft: Math.max(0, j.atkCdUntil - world.time),
      x: j.x,
      y: j.y,
    },
    agents: world.agents.map((ag) => {
      const opp = ag.id === a.id ? b : a;
      return {
        id: ag.id,
        mbti: getAgentMbti(ag),
        hp: ag.hp,
        stamina: ag.stamina,
        x: ag.x,
        y: ag.y,
        mode: ag.tactic, // dev-server prints this as "mode"
        hobby: ag.hobby?.id ?? "",
        posture: ag.posture,
        stance: {
          id: ag.stance?.id ?? "NEUTRAL",
          chargingTo: ag.stance?.chargingTo ?? null,
          activeLeft: Math.max(0, (ag.stance?.activeUntil ?? 0) - world.time),
          charge: ag.stance?.charge ?? 0,
        },
        blockCdLeft: Math.max(0, (ag.blockCooldownUntil ?? 0) - world.time),
        hobbyPrimaryCdLeft: Math.max(0, (ag.hobby?.primaryCooldownUntil ?? 0) - world.time),
        hobbySecondaryCdLeft: Math.max(0, (ag.hobby?.secondaryCooldownUntil ?? 0) - world.time),
        commitLeft: Math.max(0, ag.commitUntil - world.time),
        dJ: hypot(ag.x - j.x, ag.y - j.y),
        dO: hypot(ag.x - opp.x, ag.y - opp.y),
        predSelfJ: ag.lastEval.predSelfJ,
        predSelfO: ag.lastEval.predSelfO,
        predOpp: ag.lastEval.predOpp,
        routeRisk: ag.lastEval.routeRisk,
        jugChasingMe: Boolean(ag.lastEval.jugChasingMe),
        reengageOk: Boolean(ag.lastEval.reengageOk),
        wrapIntent: ag.lastEval.wrapIntent,
        thought: ag.thought,
      };
    }),
  };

  try {
    const res = await fetch("/_debug_log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!res.ok) {
      world.terminalLog = false;
      world._logDisabledReason = "POST /_debug_log unsupported (run npm run dev)";
    }
  } catch (err) {
    world.terminalLog = false;
    world._logDisabledReason = "POST /_debug_log failed (use dev-server.js)";
    // eslint-disable-next-line no-console
    console.warn("Terminal logging disabled:", err);
  }
}

function roundNet(n, digits = 2) {
  const v = finiteOr(Number(n), 0);
  const p = Math.pow(10, Math.max(0, Math.round(digits)));
  return Math.round(v * p) / p;
}

function enqueueNetDebugLog(world, kind, data = {}) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || !net.token || net.debugDisabled) return false;
  if (!Array.isArray(net.debugQueue)) net.debugQueue = [];
  net.debugQueue.push({
    kind: String(kind || "sync"),
    data: data && typeof data === "object" ? { ...data } : {},
    localAt: performance.now() * 0.001,
  });
  if (net.debugQueue.length > NET_DEBUG_QUEUE_LIMIT) net.debugQueue.shift();
  return true;
}

function buildNetDebugSample(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net) return {};
  return {
    roomCode: net.roomCode ?? null,
    seat: net.seat ?? null,
    mode: net.mode ?? null,
    simTick: Math.round(finiteOr(rt.simTick, 0)),
    simTime: roundNet(world.time, 3),
    simAccumulator: roundNet(rt.simAccumulator, 4),
    pendingEvents: Array.isArray(net.pendingEvents) ? net.pendingEvents.length : 0,
    timelineTicks: net.timeline instanceof Map ? net.timeline.size : 0,
    historyTicks: net.history instanceof Map ? net.history.size : 0,
    rollbackTick: isFiniteNumber(net.rollbackTick) ? Math.round(net.rollbackTick) : null,
    rollbackCount: Math.round(finiteOr(net.rollbackCount, 0)),
    lateActionCount: Math.round(finiteOr(net.lateActionCount, 0)),
    correctionCount: Math.round(finiteOr(net.correctionCount, 0)),
    actionSince: Math.round(finiteOr(net.actionSince, 0)),
    snapshotSince: Math.round(finiteOr(net.snapshotSince, 0)),
    outbox: Array.isArray(net.actionOutbox) ? net.actionOutbox.length : 0,
    snapshotQueue: Array.isArray(net.snapshotQueue) ? net.snapshotQueue.length : 0,
    agents: world.agents.map((ag) => ({
      id: ag.id,
      x: roundNet(ag.x, 2),
      y: roundNet(ag.y, 2),
      hp: roundNet(ag.hp, 2),
      absorb: roundNet(ag.absorbHp ?? 0, 2),
    })),
    juggernaut: world.juggernaut
      ? {
          x: roundNet(world.juggernaut.x, 2),
          y: roundNet(world.juggernaut.y, 2),
          mode: world.juggernaut.agenda?.mode ?? "",
          targetId: world.juggernaut.agenda?.targetId ?? "",
        }
      : null,
  };
}

function maybeQueueNetDebugSample(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.match?.mode !== "pvp" || net.debugDisabled) return;
  const nowWall = performance.now() * 0.001;
  if (nowWall < finiteOr(net.nextDiagAt, 0)) return;
  net.nextDiagAt = nowWall + NET_DEBUG_SAMPLE_INTERVAL_SEC;
  enqueueNetDebugLog(world, "diag", buildNetDebugSample(world));
}

function flushNetDebugQueue(world) {
  const net = world.runtime?.net;
  if (!net || net.syncModel !== "lockstep" || net.debugDisabled) return;
  if (!Array.isArray(net.debugQueue) || net.debugQueue.length === 0) return;
  if (net.debugPostBusy) return;
  const next = net.debugQueue.shift();
  if (!next) return;
  net.debugPostBusy = true;
  const payload = {
    token: net.token,
    source: "client",
    kind: next.kind,
    data: {
      ...(next.data ?? {}),
      localAt: roundNet(next.localAt, 4),
      sendAt: roundNet(performance.now() * 0.001, 4),
    },
  };
  fetch(resolveApiUrl("/api/debug/log"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  })
    .then((res) => {
      if (res.ok) {
        net.debugFailCount = 0;
        return;
      }
      net.debugFailCount = Math.max(0, Math.round(finiteOr(net.debugFailCount, 0))) + 1;
      if (res.status === 404 || res.status === 405 || net.debugFailCount >= 8) net.debugDisabled = true;
    })
    .catch(() => {
      net.debugFailCount = Math.max(0, Math.round(finiteOr(net.debugFailCount, 0))) + 1;
      if (net.debugFailCount >= 8) net.debugDisabled = true;
    })
    .finally(() => {
      net.debugPostBusy = false;
    });
}

function netDebugHudText(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return "";
  const pending = Array.isArray(net.pendingEvents) ? net.pendingEvents.length : 0;
  const outbox = Array.isArray(net.actionOutbox) ? net.actionOutbox.length : 0;
  const timeline = net.timeline instanceof Map ? net.timeline.size : 0;
  return `T${Math.round(finiteOr(rt.simTick, 0))} Q${pending}/${timeline} O${outbox} RB${Math.round(finiteOr(net.rollbackCount, 0))} HC${Math.round(finiteOr(net.correctionCount, 0))}`;
}

function drawHpBar(ctx, x, y, w, h, frac, color, label) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.10)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp01(frac), h);
  ctx.strokeStyle = "rgba(0,0,0,0.22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, x, y - 4);
  ctx.restore();
}

function abilityHudText(agent, now) {
  const spec = getHobbySpec(agent.hobby?.id);
  const pCd = Math.max(0, (agent.hobby?.primaryCooldownUntil ?? 0) - now);
  const sCd = Math.max(0, (agent.hobby?.secondaryCooldownUntil ?? 0) - now);
  const pTxt = pCd <= 0 ? "P:ready" : `P:${pCd.toFixed(1)}s`;
  let text = `${spec.label} | ${pTxt}`;
  if (spec.secondary) {
    const sTxt = sCd <= 0 ? "S:ready" : `S:${sCd.toFixed(1)}s`;
    text += ` ${sTxt}`;
  }
  return text;
}

function playerCommandHudText(world, agent, now) {
  if (!world?.player || !agent || agent.id !== (world.player.controlledId ?? "A")) return "";
  const cmd = getActivePlayerCommand(agent, now);
  if (cmd) return `Tap cmd: ${cmd.mode.toLowerCase()} ${(cmd.until - now).toFixed(1)}s`;
  const left = Math.max(0, (agent.playerCmd?.nextAllowedAt ?? world.player.nextCommandAt ?? 0) - now);
  return left <= 0 ? "Tap ready" : `Tap in ${left.toFixed(1)}s`;
}

function formatCooldownShort(sec) {
  const s = Math.max(0, sec);
  return s <= 0 ? "Ready" : `${s.toFixed(1)}s`;
}

function setBtnKindClass(btn, kind) {
  if (!btn) return;
  btn.classList.remove("kind-defensive", "kind-offensive", "kind-neutral");
  if (kind === "defensive") btn.classList.add("kind-defensive");
  else if (kind === "offensive") btn.classList.add("kind-offensive");
  else btn.classList.add("kind-neutral");
}

function updateUi(world) {
  const ui = world.ui;
  if (!ui) return;
  const now = world.time;
  const uiState = world.uiState ?? (world.uiState = { lastHpUpdateAt: now, hpDisplayA: null, hpDisplayB: null });
  const a = getAgent(world, "A");
  const b = getAgent(world, "B");
  const playerAgent = getAgent(world, world.player?.controlledId ?? "A");
  const playerMatchUi = world.runtime?.appMode === "player" && world.runtime?.match?.started;

  function agentTopLine(ag) {
    if (!ag) return "";
    if (playerMatchUi) return ag.playerName ?? ag.id;
    const mbti = getAgentMbti(ag);
    const hobby = getHobbySpec(ag.hobby?.id).label;
    return `${ag.id} ${mbti} · ${hobby}`;
  }

  function agentMidLine(ag) {
    if (!ag) return "";
    const pCd = Math.max(0, (ag.hobby?.primaryCooldownUntil ?? 0) - now);
    const sCd = Math.max(0, (ag.hobby?.secondaryCooldownUntil ?? 0) - now);
    const spec = getHobbySpec(ag.hobby?.id);
    const pPart = `P ${formatCooldownShort(pCd)}`;
    const sPart = spec.secondary ? ` · S ${formatCooldownShort(sCd)}` : "";
    return `${pPart}${sPart}`;
  }

  function agentThoughtLine(ag) {
    if (!ag) return "";
    if (playerMatchUi) return "";
    const t = String(ag.thought ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    return t.slice(0, 88);
  }

  function hpBarFill(ag) {
    if (!ag) return 0;
    return clamp01((ag.hp + (ag.absorbHp ?? 0) * 0.5) / Math.max(1e-6, ag.maxHp));
  }

  const dtHp = clamp(now - (uiState.lastHpUpdateAt ?? now), 0, 0.2);
  uiState.lastHpUpdateAt = now;
  const hpTargetA = hpBarFill(a);
  const hpTargetB = hpBarFill(b);
  if (!isFiniteNumber(uiState.hpDisplayA)) uiState.hpDisplayA = hpTargetA;
  if (!isFiniteNumber(uiState.hpDisplayB)) uiState.hpDisplayB = hpTargetB;
  const hpLerpA = 1 - Math.exp(-dtHp * 10);
  uiState.hpDisplayA = a && a.hp <= 0 ? hpTargetA : lerp(uiState.hpDisplayA, hpTargetA, hpLerpA);
  uiState.hpDisplayB = b && b.hp <= 0 ? hpTargetB : lerp(uiState.hpDisplayB, hpTargetB, hpLerpA);

  if (ui.statusATop) ui.statusATop.textContent = agentTopLine(a);
  if (ui.statusAMid) ui.statusAMid.textContent = agentMidLine(a);
  if (ui.statusAThought) ui.statusAThought.textContent = agentThoughtLine(a);
  if (ui.statusBTop) ui.statusBTop.textContent = agentTopLine(b);
  if (ui.statusBMid) ui.statusBMid.textContent = agentMidLine(b);
  if (ui.statusBThought) ui.statusBThought.textContent = agentThoughtLine(b);
  if (ui.statusPlayer) {
    const baseText = playerCommandHudText(world, playerAgent, now);
    const netText = world.debug ? netDebugHudText(world) : "";
    ui.statusPlayer.textContent = netText ? `${baseText} | ${netText}` : baseText;
  }
  if (ui.statusAHp) ui.statusAHp.style.width = `${(clamp01(uiState.hpDisplayA) * 100).toFixed(1)}%`;
  if (ui.statusBHp) ui.statusBHp.style.width = `${(clamp01(uiState.hpDisplayB) * 100).toFixed(1)}%`;

  // Ability buttons represent the player-controlled agent's slots.
  if (playerAgent && ui.btnP && ui.btnPName && ui.btnPSub && ui.btnS && ui.btnSName && ui.btnSSub) {
    const menuLocked = world.runtime?.appMode === "player" && !world.runtime?.match?.started;
    const spec = getHobbySpec(playerAgent.hobby?.id);
    const p = spec.primary;
    const s = spec.secondary;

    ui.btnPName.textContent = p?.label ?? "Primary";
    ui.btnPSub.textContent = menuLocked ? "Locked" : formatCooldownShort(Math.max(0, (playerAgent.hobby?.primaryCooldownUntil ?? 0) - now));
    setBtnKindClass(ui.btnP, p?.kind ?? "neutral");
    ui.btnP.disabled = menuLocked || !p || !canUseAbilitySlot(world, playerAgent, "primary");

    if (!s) {
      ui.btnS.style.display = "none";
    } else {
      ui.btnS.style.display = "";
      ui.btnSName.textContent = s.label ?? "Secondary";
      ui.btnSSub.textContent = menuLocked ? "Locked" : formatCooldownShort(Math.max(0, (playerAgent.hobby?.secondaryCooldownUntil ?? 0) - now));
      setBtnKindClass(ui.btnS, s.kind ?? "neutral");
      ui.btnS.disabled = menuLocked || !canUseAbilitySlot(world, playerAgent, "secondary");
    }
  }
}

function getViewSize(world) {
  const vw = world.viewWidth > 0 ? world.viewWidth : world.width;
  const vh = world.viewHeight > 0 ? world.viewHeight : world.height;
  return { vw, vh };
}

function getStaticViewTransform(world) {
  const { vw, vh } = getViewSize(world);
  const overscan = SCREEN_SHAKE_MARGIN_PX * 2;
  const scale = Math.min(
    (vw + overscan) / Math.max(1, world.width),
    (vh + overscan) / Math.max(1, world.height),
  );
  const drawW = world.width * scale;
  const drawH = world.height * scale;
  const ox = (vw - drawW) * 0.5;
  const oy = (vh - drawH) * 0.5;
  return { scale: Math.max(0.0001, scale), ox, oy };
}

function getScreenShakeOffset(world) {
  const shake = world?.screenShake;
  const now = world?.time ?? 0;
  if (!shake || now >= (shake.until ?? 0) || (shake.amp ?? 0) <= 0) return { x: 0, y: 0 };
  const total = Math.max(0.0001, (shake.until ?? 0) - (shake.startAt ?? now));
  const leftN = clamp01(((shake.until ?? now) - now) / total);
  const amp = Math.min(SCREEN_SHAKE_MARGIN_PX, (shake.amp ?? 0) * leftN * leftN);
  const phase = shake.phase ?? 0;
  return {
    x: Math.sin(now * 87 + phase) * amp,
    y: Math.cos(now * 103 + phase * 1.7) * amp * 0.86,
  };
}

function addCameraShake(world, amplitude = 8, duration = 0.25) {
  if (!world?.screenShake) return;
  const now = world.time;
  const shake = world.screenShake;
  const remain = Math.max(0, (shake.until ?? 0) - now);
  const total = Math.max(0.0001, (shake.until ?? now) - (shake.startAt ?? now));
  const carry = (shake.amp ?? 0) * (remain / total);
  shake.amp = Math.min(SCREEN_SHAKE_MARGIN_PX, Math.max(carry, amplitude));
  shake.startAt = now;
  shake.until = now + Math.max(0.06, duration);
  shake.phase = (shake.phase ?? 0) + 0.9;
}

function drawWorld(world) {
  const ctx = world.ctx;
  const w = world.width;
  const h = world.height;
  const { vw, vh } = getViewSize(world);
  const view = getStaticViewTransform(world);
  const shake = getScreenShakeOffset(world);
  const [a, b] = world.agents;
  const j = world.juggernaut;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#e9e7e3";
  ctx.fillRect(0, 0, vw, vh);

  ctx.save();
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox + shake.x, view.oy + shake.y);

  ctx.fillStyle = "#f6f5f3";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(30, 30, 30, 0.16)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  // Juggernaut.
  if (j) {
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, TAU);
    ctx.fillStyle = "#3b2230";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,90,82,0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();
    if (world.time < (j.speedBoostUntil ?? 0)) {
      ctx.beginPath();
      ctx.arc(j.x, j.y, j.r + 8, 0, TAU);
      ctx.strokeStyle = "rgba(255,210,100,0.7)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  // Ability placeholders.
  for (const seg of world.ability.yarn) {
    const alpha = clamp01((seg.until - world.time) / 8);
    ctx.save();
    ctx.strokeStyle = `rgba(190,150,240,${(0.22 + alpha * 0.35).toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.restore();
  }

  for (const z of world.ability.zones) {
    const active = world.time >= (z.startAt ?? 0);
    if (z.kind === "DRAW_FIRE_TRAIL") {
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = active ? "rgba(255,120,70,0.78)" : "rgba(255,120,70,0.36)";
      ctx.lineWidth = Math.max(6, (z.r ?? 12) * 1.2);
      ctx.beginPath();
      ctx.moveTo(z.x1, z.y1);
      ctx.lineTo(z.x2, z.y2);
      ctx.stroke();
      ctx.strokeStyle = active ? "rgba(255,210,120,0.7)" : "rgba(255,210,120,0.3)";
      ctx.lineWidth = Math.max(2, z.r * 0.34);
      ctx.beginPath();
      ctx.moveTo(z.x1, z.y1);
      ctx.lineTo(z.x2, z.y2);
      ctx.stroke();
      ctx.restore();
    } else {
      const alpha = active ? 0.22 : 0.1;
      ctx.save();
      ctx.fillStyle = z.color ?? `rgba(255,120,90,${alpha})`;
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = active ? "rgba(255,110,90,0.55)" : "rgba(255,110,90,0.28)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  const draw = world.player?.drawFire;
  if (draw && world.time < (draw.until ?? 0)) {
    const pts = Array.isArray(draw.points) ? draw.points : [];
    if (pts.length > 1) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(250,140,80,0.72)";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,228,150,0.65)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const b of world.ability.barriers) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fillStyle = "rgba(90,110,140,0.25)";
    ctx.fill();
    ctx.strokeStyle = "rgba(90,110,140,0.6)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  for (const task of world.ability.keyboardTasks) {
    ctx.save();
    ctx.strokeStyle = task.mode === "heal" ? "rgba(110,200,120,0.8)" : "rgba(250,130,90,0.8)";
    ctx.fillStyle = task.mode === "heal" ? "rgba(110,200,120,0.18)" : "rgba(250,130,90,0.18)";
    ctx.lineWidth = 3;
    ctx.fillRect(task.x - task.r, task.y - task.r * 0.45, task.r * 2, task.r * 0.9);
    ctx.strokeRect(task.x - task.r, task.y - task.r * 0.45, task.r * 2, task.r * 0.9);
    ctx.beginPath();
    ctx.arc(task.keyX, task.keyY, task.keyR, 0, TAU);
    ctx.fillStyle = "rgba(255,255,120,0.48)";
    ctx.fill();
    ctx.strokeStyle = "rgba(20,20,20,0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  for (const pet of world.ability.summons) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pet.x, pet.y, pet.r, 0, TAU);
    ctx.fillStyle = "rgba(120,190,120,0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(20,20,20,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  for (const proj of world.ability.projectiles) {
    ctx.save();
    ctx.translate(proj.x, proj.y);
    ctx.rotate(Math.atan2(proj.vy ?? 0, proj.vx ?? 1));
    ctx.fillStyle = "rgba(58,62,78,0.92)";
    ctx.fillRect(-10, -7, 18, 14);
    ctx.fillStyle = "rgba(165,225,255,0.82)";
    ctx.fillRect(-8, -5, 10, 10);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-10, -7, 18, 14);
    ctx.restore();
  }

  for (const m of world.ability.markers) {
    const life = Math.max(0.001, (m.until ?? world.time) - (m.startAt ?? world.time));
    const ageN = clamp01((world.time - (m.startAt ?? world.time)) / life);
    const t = 1 - ageN;
    ctx.save();
    ctx.globalAlpha = clamp(0.08 + t * 0.78, 0.06, 0.9);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.radius ?? 28, 0, TAU);
    ctx.strokeStyle = m.color ?? "rgba(255,160,90,0.4)";
    ctx.lineWidth = 1.5 + t * 1.5;
    ctx.stroke();
    if (m.kind === "SOUND" || m.label === "LOUD" || m.label === "NOISE" || m.label === "METAL") {
      for (let i = 0; i < 3; i++) {
        const pr = (m.radius ?? 28) + (i + ageN) * 18;
        ctx.beginPath();
        ctx.arc(m.x, m.y, pr, 0, TAU);
        ctx.strokeStyle = m.color ?? "rgba(255,190,120,0.35)";
        ctx.globalAlpha = clamp(0.04 + (1 - ageN) * 0.22, 0.03, 0.26);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(m.x, m.y, (m.radius ?? 28) * (0.4 + 0.25 * (1 - ageN)), 0, TAU);
      ctx.fillStyle = m.color ?? "rgba(255,160,90,0.25)";
      ctx.globalAlpha = clamp(0.05 + t * 0.22, 0.03, 0.28);
      ctx.fill();
    }
    if (m.label) {
      ctx.fillStyle = "rgba(20,20,20,0.75)";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(m.label, m.x, m.y);
    }
    ctx.restore();
  }

  function drawAgent(agent, losColor) {
    if (isAgentPhasedOut(agent, world.time)) return;
    // LOS wedge (kept subtle).
    const half = agent.fov * 0.5;
    const a1 = agent.heading - half;
    const a2 = agent.heading + half;
    const p1 = rayRectIntersection(agent.x, agent.y, Math.cos(a1), Math.sin(a1), w, h);
    const p2 = rayRectIntersection(agent.x, agent.y, Math.cos(a2), Math.sin(a2), w, h);
    // Draw as two rays to the wall (not a filled triangle).
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = losColor.replace("0.040", "0.14").replace("0.045", "0.14");
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Tiny arc at the agent to show the view angle without filling the whole wedge.
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r + 18, a1, a2);
    ctx.strokeStyle = "rgba(60, 80, 110, 0.08)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Body: emotion pie (v1.2 style).
    const slices = getEmotionPie(agent);
    let start = -Math.PI / 2;
    for (const s of slices) {
      const end = start + s.p * TAU;
      if (s.p > 1e-4) {
        ctx.beginPath();
        ctx.moveTo(agent.x, agent.y);
        ctx.arc(agent.x, agent.y, agent.r, start, end);
        ctx.closePath();
        ctx.fillStyle = s.color;
        ctx.fill();
      }
      start = end;
    }

    // Inner outline uses agent identity color.
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r, 0, TAU);
    ctx.strokeStyle = mixColors("#101010", agent.color, 0.55);
    ctx.lineWidth = 3;
    ctx.stroke();

    // Posture ring.
    const ring =
      agent.posture === "AGGRO"
        ? "rgba(255,90,82,0.55)"
        : agent.posture === "DEFENSIVE"
          ? "rgba(70,110,255,0.55)"
          : "rgba(20,20,20,0.22)";
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r + 6, 0, TAU);
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Heading notch.
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(agent.x + Math.cos(agent.heading) * (agent.r + 10), agent.y + Math.sin(agent.heading) * (agent.r + 10));
    ctx.strokeStyle = "rgba(16,16,16,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label.
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const scene = agent.scene?.id ? agent.scene.id.toLowerCase() : "";
    ctx.fillText(`${agent.id}${scene ? ` (${scene})` : ""}`, agent.x, agent.y - agent.r - 14);

    // Thought label above the agent (recent thought, fades with age).
    const age = Math.max(0, world.time - (agent.thoughtSince ?? 0));
    const alpha = clamp01(1 - age / 2.6);
    const showThoughtBubble = !(world.runtime?.appMode === "player" && world.runtime?.match?.started);
    if (showThoughtBubble && alpha > 0.05 && agent.thought) {
      const msg = agent.thought.replace(/\s+/g, " ").slice(0, 46);
      ctx.save();
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = `rgba(10,10,10,${(0.12 + 0.62 * alpha).toFixed(3)})`;
      ctx.fillText(msg, agent.x, agent.y - agent.r - 32);
      ctx.restore();
    }

    // Current movement goal marker.
    if (world.debug && agent.nav?.target) {
      const t = agent.nav.target;
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = agent.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x - 7, t.y);
      ctx.lineTo(t.x + 7, t.y);
      ctx.moveTo(t.x, t.y - 7);
      ctx.lineTo(t.x, t.y + 7);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (a) drawAgent(a, "rgba(60, 110, 255, 0.045)");
  if (b) drawAgent(b, "rgba(255, 120, 90, 0.040)");

  ctx.restore();

  const roundEnd = world.runtime?.roundEnd;
  if (roundEnd?.active && world.runtime?.appMode === "player") {
    const msg = roundEnd.message || "Match Over";
    const sub = "Returning to menu...";
    ctx.save();
    ctx.fillStyle = "rgba(14, 14, 20, 0.46)";
    ctx.fillRect(0, 0, vw, vh);
    const panelW = Math.min(vw - 36, 380);
    const panelH = 112;
    const px = (vw - panelW) * 0.5;
    const py = (vh - panelH) * 0.42;
    ctx.fillStyle = "rgba(248,248,252,0.94)";
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 2;
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeRect(px, py, panelW, panelH);
    ctx.fillStyle = "rgba(22,24,40,0.92)";
    ctx.font = "700 28px 'Avenir Next', 'Trebuchet MS', 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, px + panelW * 0.5, py + 44);
    ctx.font = "600 16px 'Avenir Next', 'Trebuchet MS', 'Helvetica Neue', Arial, sans-serif";
    ctx.fillStyle = "rgba(34,36,56,0.74)";
    ctx.fillText(sub, px + panelW * 0.5, py + 82);
    ctx.restore();
  }

  // Debug overlay.
  if (world.runtime?.appMode === "developer" && world.debug && a && b && j) {
    ctx.save();
    const lines = [];
    lines.push(`v1.3 | H cast | A+H,B+H hobby | Shift+A/B MBTI | D debug | K help | L log (${world.terminalLog ? "ON" : "OFF"})`);
    if (!world.terminalLog && world._logDisabledReason) lines.push(`log: ${world._logDisabledReason}`);
    lines.push(
      `J: mode=${j.agenda.mode} tgt=${j.agenda.targetId} cd=${Math.max(0, j.atkCdUntil - world.time).toFixed(2)}s`,
    );
    for (const ag of world.agents) {
      const opp = ag.id === "A" ? b : a;
      const slices = getEmotionPie(ag);
      const gl = ag.gaze.glance;
      const glAct = Math.max(0, gl.activeUntil - world.time);
      const glCd = Math.max(0, gl.cooldownUntil - world.time);
      const stanceId = ag.stance?.chargingTo ? `charge->${ag.stance.chargingTo}` : ag.stance?.id ?? "NEUTRAL";
      const stanceLeft = Math.max(0, (ag.stance?.activeUntil ?? 0) - world.time);
      const stanceCh = ag.stance?.chargingTo ? (ag.stance.charge ?? 0) : 0;
      const blockCd = Math.max(0, (ag.blockCooldownUntil ?? 0) - world.time);
      lines.push(
        `${ag.id}: hp=${Math.round(ag.hp)} tactic=${ag.tactic} posture=${ag.posture} commit=${Math.max(0, ag.commitUntil - world.time).toFixed(2)}s ` +
          `oppHp~${ag.belief.opponentHp.mean.toFixed(0)}±${Math.sqrt(ag.belief.opponentHp.var).toFixed(0)} ` +
          `jugDmg~${ag.belief.jugDamage.mean.toFixed(1)} oppDmg~${ag.belief.oppDamage.mean.toFixed(1)} ` +
          `stam=${Math.round(ag.stamina ?? 0)} ` +
          `dJ=${hypot(ag.x - j.x, ag.y - j.y).toFixed(0)} dO=${hypot(ag.x - opp.x, ag.y - opp.y).toFixed(0)}`,
      );
      lines.push(
        `  pred: selfJ=${ag.lastEval.predSelfJ.toFixed(1)} selfO=${ag.lastEval.predSelfO.toFixed(1)} deal=${ag.lastEval.predOpp.toFixed(1)} ` +
          `routeJ=${(ag.lastEval.routeRisk ?? 0).toFixed(2)} chase=${ag.lastEval.jugChasingMe ? "Y" : "n"} re=${ag.lastEval.reengageOk ? "Y" : "n"} wrap=${(ag.lastEval.wrapIntent ?? 0).toFixed(2)}`,
      );
      lines.push(`  scene: ${ag.scene.id} until=${Math.max(0, ag.scene.until - world.time).toFixed(2)}s`);
      lines.push(`  plan: now=${ag.plan.current} next=${ag.plan.next} conf=${ag.plan.confidence.toFixed(2)}`);
      {
        const obj = ag.nav?.objectives ?? { recover: 0, duel: 0, bait: 0 };
        lines.push(
          `  nav: goal=${ag.nav?.kind ?? "NONE"} obj R/D/B=${(obj.recover ?? 0).toFixed(2)}/${(obj.duel ?? 0).toFixed(2)}/${(obj.bait ?? 0).toFixed(2)}`,
        );
      }
      lines.push(
        `  hobby: ${getHobbySpec(ag.hobby?.id).label} pCd=${Math.max(0, (ag.hobby?.primaryCooldownUntil ?? 0) - world.time).toFixed(2)} ` +
          `sCd=${Math.max(0, (ag.hobby?.secondaryCooldownUntil ?? 0) - world.time).toFixed(2)} absorb=${Math.round(ag.absorbHp ?? 0)}`,
      );
      lines.push(`  gaze: ${ag.gaze.mode} glance(urge=${gl.urge.toFixed(2)} act=${glAct.toFixed(2)} cd=${glCd.toFixed(2)})`);
      lines.push(`  stance: ${stanceId} ${stanceCh ? `ch=${stanceCh.toFixed(2)}` : ""}${stanceLeft ? ` act=${stanceLeft.toFixed(2)}s` : ""} blockCd=${blockCd.toFixed(2)}s`);
      lines.push(`  thought: ${ag.thought}`);
      lines.push(`  emotions (pie %): ${slices.map((s) => `${s.id}=${Math.round(s.p * 100)}`).join("  ")}`);
    }

    const boxH = Math.min(vh - 20, 16 * (lines.length + 2));
    const boxY = Math.max(14, vh - boxH - 14);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(14, boxY, vw - 28, boxH);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    let y = boxY + 10;
    for (const line of lines) {
      ctx.fillText(line, 24, y);
      y += 16;
    }
    ctx.restore();
  }

  // Help overlay removed (UI now lives outside the canvas).
}

function worldToCanvas(world, clientX, clientY) {
  const rect = world.canvas.getBoundingClientRect();
  const { vw, vh } = getViewSize(world);
  const sx = ((clientX - rect.left) / rect.width) * vw;
  const sy = ((clientY - rect.top) / rect.height) * vh;
  const view = getStaticViewTransform(world);
  const shake = getScreenShakeOffset(world);
  const inv = 1 / Math.max(0.0001, view.scale);
  return {
    x: (sx - view.ox - shake.x) * inv,
    y: (sy - view.oy - shake.y) * inv,
  };
}

function setupViewportCssHeight() {
  const root = document.documentElement;
  if (!root?.style) return;
  function apply() {
    const vvh = window.visualViewport?.height ?? window.innerHeight;
    root.style.setProperty("--app-vh", `${Math.max(1, Math.floor(vvh))}px`);
  }
  apply();
  window.addEventListener("resize", apply, { passive: true });
  window.addEventListener("orientationchange", apply, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", apply, { passive: true });
    window.visualViewport.addEventListener("scroll", apply, { passive: true });
  }
}

function randomPick(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(random01() * list.length)] ?? null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeApiBase(urlLike) {
  const raw = String(urlLike ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.pathname = u.pathname.replace(/\/+$/, "");
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function readEmbeddedApiBaseUrl() {
  try {
    const el = globalThis.document?.querySelector?.('meta[name="mbti-api-base"]');
    const content = String(el?.getAttribute?.("content") ?? "").trim();
    return normalizeApiBase(content);
  } catch {
    return "";
  }
}

function setApiBaseUrl(nextBase, { persist = true } = {}) {
  API_BASE_URL = normalizeApiBase(nextBase);
  if (!persist) return API_BASE_URL;
  try {
    if (API_BASE_URL) localStorage.setItem("mbti_api_base", API_BASE_URL);
    else localStorage.removeItem("mbti_api_base");
  } catch {
    // Ignore storage failures (private mode, disabled storage, etc.).
  }
  return API_BASE_URL;
}

function getApiBaseUrl() {
  return API_BASE_URL || "";
}

function resolveApiUrl(path) {
  const rawPath = String(path ?? "");
  if (!rawPath) return rawPath;
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  const base = getApiBaseUrl();
  if (!base) return rawPath;
  try {
    return new URL(rawPath, `${base}/`).toString();
  } catch {
    return rawPath;
  }
}

function buildDevApiFallbackBases() {
  const out = [];
  const seen = new Set();
  function add(raw) {
    const normalized = normalizeApiBase(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  }
  const host = String(globalThis.location?.hostname ?? "").trim();
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    add(`http://${host}:5173`);
  }
  add("http://localhost:5173");
  add("http://127.0.0.1:5173");
  add("http://localhost:8787");
  add("http://127.0.0.1:8787");
  return out;
}

async function apiRequest(path, method = "GET", body = null) {
  const init = { method, headers: {} };
  if (body != null) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const rawPath = String(path ?? "");
  const apiBase = getApiBaseUrl();
  const url = resolveApiUrl(path);
  const pageOrigin = String(globalThis.location?.origin ?? "");

  async function fetchJson(endpointUrl) {
    let response;
    try {
      response = await fetch(endpointUrl, init);
    } catch {
      return { ok: false, networkError: true, endpointUrl, response: null, payload: null };
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { ok: response.ok && Boolean(payload?.ok), networkError: false, endpointUrl, response, payload };
  }

  function canTrySameOriginFallback() {
    if (!rawPath.startsWith("/api/")) return false;
    if (!apiBase) return false;
    try {
      const baseOrigin = new URL(apiBase).origin;
      return pageOrigin && baseOrigin !== pageOrigin;
    } catch {
      return true;
    }
  }

  const primary = await fetchJson(url);
  if (primary.ok) return primary.payload;

  if (canTrySameOriginFallback()) {
    const fallback = await fetchJson(rawPath);
    if (fallback.ok) {
      if (pageOrigin) setApiBaseUrl(pageOrigin, { persist: true });
      return fallback.payload;
    }
    const fallbackRes = fallback.response;
    if (!fallback.networkError && fallbackRes && fallbackRes.status === 405 && rawPath.startsWith("/api/")) {
      const devBases = buildDevApiFallbackBases();
      for (const devBase of devBases) {
        let endpointUrl = "";
        try {
          endpointUrl = new URL(rawPath, `${devBase}/`).toString();
        } catch {
          endpointUrl = "";
        }
        if (!endpointUrl) continue;
        const probe = await fetchJson(endpointUrl);
        if (!probe.ok) continue;
        setApiBaseUrl(devBase, { persist: true });
        return probe.payload;
      }
      throw new Error("Request failed (405). This host is static-only. Run `npm run dev` in this repo or open via `?api=https://<worker>.workers.dev`.");
    }
  }

  if (primary.networkError) {
    const endpointHint = apiBase || "same-origin /api";
    throw new Error(`Network error. Multiplayer API unreachable at ${endpointHint}.`);
  }
  if (primary.response && !primary.response.ok && primary.response.status === 405 && !apiBase && rawPath.startsWith("/api/")) {
    throw new Error("Request failed (405). This host is static-only. Run `npm run dev` in this repo or open via `?api=https://<worker>.workers.dev`.");
  }
  if (!primary.ok) {
    const msg = primary.payload?.error ?? `Request failed (${primary.response?.status ?? 0})`;
    throw new Error(msg);
  }
  return primary.payload;
}

function sanitizeName(name) {
  const raw = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "Player";
  return raw.slice(0, 22);
}

function sanitizeMbti(mbti) {
  const val = String(mbti ?? "ENFP").trim().toUpperCase();
  return MBTI_TYPES.includes(val) ? val : "ENFP";
}

function sanitizeHobby(hobby) {
  const val = String(hobby ?? "SCIENCE_RESEARCH").trim().toUpperCase();
  return HOBBY_SPECS[val] ? val : "SCIENCE_RESEARCH";
}

function sanitizeLook(look) {
  const val = String(look ?? "CLASSIC").trim().toUpperCase();
  if (val === "SWIFT" || val === "HEAVY") return val;
  return "CLASSIC";
}

function clearRuntimeTimers(world) {
  const rt = world.runtime;
  const timers = Array.isArray(rt?.timers) ? rt.timers : [];
  for (const id of timers) clearInterval(id);
  rt.timers = [];
}

function addRuntimeTimer(world, timerId) {
  if (!world.runtime.timers) world.runtime.timers = [];
  world.runtime.timers.push(timerId);
}

function setFlowError(world, message = "") {
  const el = world.ui?.flowError;
  if (!el) return;
  el.textContent = String(message ?? "");
}

function setFlowScreen(world, screen) {
  const ui = world.ui;
  const rt = world.runtime;
  rt.flowScreen = screen;
  if (ui.flowProfile) ui.flowProfile.hidden = screen !== "profile";
  if (ui.flowHub) ui.flowHub.hidden = screen !== "hub";
  if (ui.flowRoom) ui.flowRoom.hidden = screen !== "room";
}

function setFlowOverlayHidden(world, hidden) {
  const overlay = world.ui?.flowOverlay;
  if (!overlay) return;
  overlay.classList.toggle("hidden", Boolean(hidden));
}

function applyProfileToAgent(agent, profile, fallbackName = null) {
  if (!agent || !profile) return;
  const mbti = getAgentMbti({ mbti: profile.mbti });
  const hobbyId = HOBBY_SPECS[profile.hobby] ? profile.hobby : "SCIENCE_RESEARCH";
  agent.playerName = String(profile.name || fallbackName || agent.id).slice(0, 22);
  applyMbtiProfile(agent, mbti);
  agent.hobby.id = hobbyId;
}

function buildShareUrl(queryKey, queryValue) {
  let url;
  try {
    url = new URL(globalThis.location?.href ?? "http://localhost/");
  } catch {
    return "";
  }
  url.search = "";
  if (queryKey && queryValue) url.searchParams.set(queryKey, queryValue);
  const apiBase = getApiBaseUrl();
  if (apiBase) {
    const isEmbeddedDefault = EMBEDDED_API_BASE_URL && apiBase === EMBEDDED_API_BASE_URL;
    try {
      const apiOrigin = new URL(apiBase).origin;
      if (!isEmbeddedDefault && apiOrigin && apiOrigin !== url.origin) {
        url.searchParams.set("api", apiBase);
      }
    } catch {
      // Ignore invalid API base formats.
    }
  }
  return url.toString();
}

function openRoomMenu(world, opts = {}) {
  const ui = world.ui;
  const rt = world.runtime;
  rt.roomMenuMode = opts.mode === "matchmaker" ? "matchmaker" : "room";
  setFlowScreen(world, "room");
  if (ui.flowRoomTitle) ui.flowRoomTitle.textContent = String(opts.title ?? "Room");
  if (ui.flowRoomStatus) ui.flowRoomStatus.textContent = String(opts.status ?? "");
  if (ui.flowRoomCodeText) ui.flowRoomCodeText.textContent = String(opts.codeText ?? "");

  const shareLink = String(opts.link ?? "");
  if (ui.flowCopyLink) {
    ui.flowCopyLink.dataset.link = shareLink;
    ui.flowCopyLink.hidden = !shareLink;
  }
  if (ui.flowStartAi) ui.flowStartAi.hidden = !Boolean(opts.allowStartAi);
  if (ui.flowRoomCancel) ui.flowRoomCancel.hidden = !Boolean(opts.showCancel);
  if (ui.flowBack) ui.flowBack.hidden = Boolean(opts.hideBack);
}

function returnToMainMenu(world) {
  const rt = world.runtime;
  rt.match = null;
  rt.net = null;
  rt.playState = "menu";
  rt.sessionToken = "";
  rt.roomMenuMode = "";
  rt.pendingJoinCode = null;
  rt.pendingQueueJoin = false;
  clearRuntimeTimers(world);
  setFlowOverlayHidden(world, false);
  setFlowScreen(world, rt.profileLocked ? "hub" : "profile");
}

function updateRoundEndFlow(world) {
  const rt = world.runtime;
  const now = world.time;
  const end = rt.roundEnd;
  if (rt.appMode !== "player" || !rt.match?.started) {
    if (end.active) end.active = false;
    return;
  }

  const a = getAgent(world, "A");
  const b = getAgent(world, "B");
  if (!a || !b) return;

  if (!end.active) {
    const aAlive = a.hp > 0;
    const bAlive = b.hp > 0;
    if (aAlive && bAlive) return;

    let winnerId = "";
    let winnerName = "";
    let message = "Draw";
    if (aAlive && !bAlive) {
      winnerId = "A";
      winnerName = a.playerName || "A";
      message = `${winnerName} Wins`;
    } else if (bAlive && !aAlive) {
      winnerId = "B";
      winnerName = b.playerName || "B";
      message = `${winnerName} Wins`;
    }
    end.active = true;
    end.winnerId = winnerId;
    end.winnerName = winnerName;
    end.message = message;
    end.showUntil = now + 2.2;
    end.returnAt = now + 2.4;
    return;
  }

  if (now >= end.returnAt) {
    end.active = false;
    returnToMainMenu(world);
  }
}

function resetWorldForMatch(world, players, mode) {
  const a = makeAgent("A", world, world.width * 0.30, world.height * 0.62, "#5a83ff");
  const b = makeAgent("B", world, world.width * 0.70, world.height * 0.42, "#ff7a5f");
  world.agents = [a, b];
  world.juggernaut = makeJuggernaut(world, world.width * 0.50, world.height * 0.20);
  world.ability = {
    zones: [],
    barriers: [],
    summons: [],
    yarn: [],
    keyboardTasks: [],
    projectiles: [],
    markers: [],
  };
  world.screenShake = {
    amp: 0,
    startAt: 0,
    until: 0,
    phase: random01() * TAU,
  };
  world.time = 0;
  world.runtime.simTick = 0;
  world.runtime.simAccumulator = 0;
  if (players?.A) applyProfileToAgent(a, players.A, "A");
  if (players?.B) applyProfileToAgent(b, players.B, mode === "ai" ? "CPU" : "B");
  else if (mode === "ai") {
    applyProfileToAgent(
      b,
      {
        name: "CPU",
        mbti: randomPick(MBTI_TYPES) ?? "ENTP",
        hobby: randomPick(HOBBY_IDS) ?? "DANCE",
      },
      "CPU",
    );
  }
  a.playerCmd.nextAllowedAt = 0;
  b.playerCmd.nextAllowedAt = 0;
  world.player.nextCommandAt = 0;
  seedSimulationRng(world, world.runtime?.match?.seed ?? hashSeed(`match|${players?.A?.name ?? "A"}|${players?.B?.name ?? "B"}`));
  if (world.runtime?.roundEnd) {
    world.runtime.roundEnd.active = false;
    world.runtime.roundEnd.winnerId = "";
    world.runtime.roundEnd.winnerName = "";
    world.runtime.roundEnd.message = "";
    world.runtime.roundEnd.showUntil = 0;
    world.runtime.roundEnd.returnAt = 0;
  }
}

function buildNetSnapshot(world) {
  function serializeAgentForNet(ag) {
    return {
      id: ag.id,
      playerName: ag.playerName,
      color: ag.color,
      mbti: ag.mbti,
      x: ag.x,
      y: ag.y,
      vx: ag.vx,
      vy: ag.vy,
      r: ag.r,
      heading: ag.heading,
      fov: ag.fov,
      hp: ag.hp,
      maxHp: ag.maxHp,
      absorbHp: ag.absorbHp ?? 0,
      posture: ag.posture ?? "NEUTRAL",
      thought: ag.thought ?? "",
      thoughtSince: ag.thoughtSince ?? 0,
      scene: { id: ag.scene?.id ?? "RESET" },
      tactic: ag.tactic ?? "RESET",
      atkCdUntil: ag.atkCdUntil ?? 0,
      attackWindupUntil: ag.attackWindupUntil ?? 0,
      attackWindupTargetId: ag.attackWindupTargetId ?? null,
      hobby: {
        id: ag.hobby?.id ?? "SCIENCE_RESEARCH",
        castGlobalUntil: ag.hobby?.castGlobalUntil ?? 0,
        primaryCooldownUntil: ag.hobby?.primaryCooldownUntil ?? 0,
        secondaryCooldownUntil: ag.hobby?.secondaryCooldownUntil ?? 0,
      },
      fx: cloneJson(ag.fx ?? {}),
      playerCmd: {
        nextAllowedAt: ag.playerCmd?.nextAllowedAt ?? 0,
      },
    };
  }

  function serializeJugForNet(j) {
    if (!j) return null;
    return {
      x: j.x,
      y: j.y,
      r: j.r,
      speedBoostUntil: j.speedBoostUntil ?? 0,
      windupUntil: j.windupUntil ?? 0,
      windupTargetId: j.windupTargetId ?? null,
      atkCdUntil: j.atkCdUntil ?? 0,
    };
  }

  function serializeAbilityForNet(ability) {
    return {
      zones: cloneJson(ability?.zones ?? []),
      barriers: cloneJson(ability?.barriers ?? []),
      summons: cloneJson(ability?.summons ?? []),
      yarn: cloneJson(ability?.yarn ?? []),
      keyboardTasks: cloneJson(ability?.keyboardTasks ?? []),
      projectiles: cloneJson(ability?.projectiles ?? []),
      markers: cloneJson(ability?.markers ?? []),
    };
  }

  return {
    t: world.time,
    tick: finiteOr(world.runtime?.simTick, 0),
    simRngSeed: finiteOr(world.runtime?.simRngSeed, 1),
    simRngState: finiteOr(world.runtime?.simRngState, 1),
    agents: world.agents.map((ag) => serializeAgentForNet(ag)),
    juggernaut: serializeJugForNet(world.juggernaut),
    ability: serializeAbilityForNet(world.ability),
    screenShake: cloneJson(world.screenShake),
    roundEnd: cloneJson(world.runtime?.roundEnd ?? null),
  };
}

function applyNetSnapshot(world, snap) {
  if (!snap) return;
  if (isFiniteNumber(snap.t)) world.time = snap.t;
  if (isFiniteNumber(snap.tick)) world.runtime.simTick = Math.max(0, Math.round(snap.tick));
  if (isFiniteNumber(snap.simRngSeed)) world.runtime.simRngSeed = (Math.round(snap.simRngSeed) >>> 0) || 1;
  if (isFiniteNumber(snap.simRngState)) world.runtime.simRngState = (Math.round(snap.simRngState) >>> 0) || 1;
  if (Array.isArray(snap.agents)) {
    const existingById = new Map(world.agents.map((ag) => [ag.id, ag]));
    world.agents = snap.agents.map((sag) => {
      const ag = existingById.get(sag.id) || makeAgent(sag.id || "A", world, sag.x ?? 0, sag.y ?? 0, sag.color ?? "#5a83ff");
      ag.playerName = sag.playerName ?? ag.playerName;
      ag.color = sag.color ?? ag.color;
      if (sag.mbti && sag.mbti !== ag.mbti) applyMbtiProfile(ag, sag.mbti);
      else ag.mbti = sag.mbti ?? ag.mbti;
      ag.x = finiteOr(sag.x, ag.x);
      ag.y = finiteOr(sag.y, ag.y);
      ag.vx = finiteOr(sag.vx, ag.vx);
      ag.vy = finiteOr(sag.vy, ag.vy);
      ag.r = finiteOr(sag.r, ag.r);
      ag.heading = finiteOr(sag.heading, ag.heading);
      ag.fov = finiteOr(sag.fov, ag.fov);
      ag.hp = finiteOr(sag.hp, ag.hp);
      ag.maxHp = finiteOr(sag.maxHp, ag.maxHp);
      ag.absorbHp = finiteOr(sag.absorbHp, ag.absorbHp ?? 0);
      ag.posture = sag.posture ?? ag.posture;
      ag.thought = sag.thought ?? "";
      ag.thoughtSince = finiteOr(sag.thoughtSince, ag.thoughtSince ?? 0);
      ag.scene = { ...(ag.scene ?? {}), ...(sag.scene ?? {}) };
      ag.tactic = sag.tactic ?? ag.tactic;
      ag.atkCdUntil = finiteOr(sag.atkCdUntil, ag.atkCdUntil ?? 0);
      ag.attackWindupUntil = finiteOr(sag.attackWindupUntil, ag.attackWindupUntil ?? 0);
      ag.attackWindupTargetId = sag.attackWindupTargetId ?? null;
      ag.hobby = { ...(ag.hobby ?? {}), ...(sag.hobby ?? {}) };
      ag.fx = { ...(ag.fx ?? {}), ...(sag.fx ?? {}) };
      ag.playerCmd = { ...(ag.playerCmd ?? {}), ...(sag.playerCmd ?? {}) };
      return ag;
    });
  }
  if (snap.juggernaut) world.juggernaut = { ...(world.juggernaut ?? {}), ...(snap.juggernaut ?? {}) };
  if (snap.ability) {
    world.ability = {
      zones: Array.isArray(snap.ability.zones) ? snap.ability.zones : [],
      barriers: Array.isArray(snap.ability.barriers) ? snap.ability.barriers : [],
      summons: Array.isArray(snap.ability.summons) ? snap.ability.summons : [],
      yarn: Array.isArray(snap.ability.yarn) ? snap.ability.yarn : [],
      keyboardTasks: Array.isArray(snap.ability.keyboardTasks) ? snap.ability.keyboardTasks : [],
      projectiles: Array.isArray(snap.ability.projectiles) ? snap.ability.projectiles : [],
      markers: Array.isArray(snap.ability.markers) ? snap.ability.markers : [],
    };
  }
  if (snap.screenShake) world.screenShake = snap.screenShake;
  if (snap.roundEnd) {
    const src = snap.roundEnd;
    world.runtime.roundEnd = {
      active: Boolean(src.active),
      winnerId: src.winnerId === "A" || src.winnerId === "B" ? src.winnerId : "",
      winnerName: String(src.winnerName ?? ""),
      message: String(src.message ?? ""),
      showUntil: finiteOr(src.showUntil, 0),
      returnAt: finiteOr(src.returnAt, 0),
    };
  }
}

function lerpAngleValue(a, b, t) {
  const aa = finiteOr(a, 0);
  const bb = finiteOr(b, aa);
  return wrapAngle(aa + angleDiff(aa, bb) * clamp01(t));
}

function interpolateNetSnapshots(snapA, snapB, alpha) {
  const t = clamp01(alpha);
  const a = snapA ?? snapB;
  const b = snapB ?? snapA;
  if (!a || !b) return null;
  const aAgents = new Map((a.agents ?? []).map((ag) => [ag.id, ag]));
  const outAgents = [];
  for (const bg of b.agents ?? []) {
    const ag = aAgents.get(bg.id) ?? bg;
    outAgents.push({
      ...bg,
      x: lerp(finiteOr(ag.x, bg.x), finiteOr(bg.x, ag.x), t),
      y: lerp(finiteOr(ag.y, bg.y), finiteOr(bg.y, ag.y), t),
      vx: lerp(finiteOr(ag.vx, bg.vx), finiteOr(bg.vx, ag.vx), t),
      vy: lerp(finiteOr(ag.vy, bg.vy), finiteOr(bg.vy, ag.vy), t),
      heading: lerpAngleValue(ag.heading, bg.heading, t),
      hp: lerp(finiteOr(ag.hp, bg.hp), finiteOr(bg.hp, ag.hp), t),
      absorbHp: lerp(finiteOr(ag.absorbHp, bg.absorbHp), finiteOr(bg.absorbHp, ag.absorbHp), t),
      atkCdUntil: lerp(finiteOr(ag.atkCdUntil, bg.atkCdUntil), finiteOr(bg.atkCdUntil, ag.atkCdUntil), t),
      attackWindupUntil: lerp(
        finiteOr(ag.attackWindupUntil, bg.attackWindupUntil),
        finiteOr(bg.attackWindupUntil, ag.attackWindupUntil),
        t,
      ),
    });
  }
  const ja = a.juggernaut ?? b.juggernaut ?? null;
  const jb = b.juggernaut ?? a.juggernaut ?? null;
  const outJug = ja && jb
    ? {
        ...jb,
        x: lerp(finiteOr(ja.x, jb.x), finiteOr(jb.x, ja.x), t),
        y: lerp(finiteOr(ja.y, jb.y), finiteOr(jb.y, ja.y), t),
        windupUntil: lerp(finiteOr(ja.windupUntil, jb.windupUntil), finiteOr(jb.windupUntil, ja.windupUntil), t),
        atkCdUntil: lerp(finiteOr(ja.atkCdUntil, jb.atkCdUntil), finiteOr(jb.atkCdUntil, ja.atkCdUntil), t),
      }
    : jb;
  return {
    t: lerp(finiteOr(a.t, b.t), finiteOr(b.t, a.t), t),
    agents: outAgents,
    juggernaut: outJug,
    ability: b.ability ?? a.ability,
    screenShake: b.screenShake ?? a.screenShake,
    roundEnd: b.roundEnd ?? a.roundEnd,
  };
}

function updateGuestNetView(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || rt.playState !== "guest") return false;
  const queue = net.snapshotQueue;
  if (!Array.isArray(queue) || queue.length === 0) return false;

  const nowWall = performance.now() * 0.001;
  const renderDelay = Math.max(0.02, finiteOr(net.renderDelaySec, 0.11));
  const renderAt = nowWall - renderDelay;

  while (queue.length >= 3 && finiteOr(queue[1]?.recvAt, 0) <= renderAt) queue.shift();

  if (queue.length >= 2) {
    const prev = queue[0];
    const next = queue[1];
    const span = Math.max(0.0001, finiteOr(next.recvAt, 0) - finiteOr(prev.recvAt, 0));
    const alpha = clamp01((renderAt - finiteOr(prev.recvAt, 0)) / span);
    const interp = interpolateNetSnapshots(prev.snapshot, next.snapshot, alpha);
    if (interp) {
      applyNetSnapshot(world, interp);
      net.lastRenderedSeq = Math.max(finiteOr(prev.seq, 0), finiteOr(next.seq, 0));
      return true;
    }
  }

  const latest = queue[queue.length - 1];
  if (!latest?.snapshot) return false;
  applyNetSnapshot(world, latest.snapshot);
  net.lastRenderedSeq = Math.max(net.lastRenderedSeq ?? 0, finiteOr(latest.seq, 0));

  // Small dead-reckoning window when we only have one snapshot.
  const age = Math.max(0, nowWall - finiteOr(latest.recvAt, nowWall));
  const extrap = Math.min(age, 0.18);
  if (extrap > 0.0001) {
    for (const ag of world.agents) {
      ag.x = clamp(ag.x + finiteOr(ag.vx, 0) * extrap, ag.r, world.width - ag.r);
      ag.y = clamp(ag.y + finiteOr(ag.vy, 0) * extrap, ag.r, world.height - ag.r);
    }
  }
  return true;
}

function applyIncomingAction(world, seat, ev) {
  const agent = getAgent(world, seat);
  if (!agent || agent.hp <= 0) return;
  if (ev.type === "tap") {
    const x = finiteOr(ev.payload?.x, agent.x);
    const y = finiteOr(ev.payload?.y, agent.y);
    // Network actions are authoritative for intent; never reject due local cooldown drift.
    assignPlayerCommand(world, agent, x, y, { ignoreCooldown: true });
    enqueueNetDebugLog(world, "event_apply", {
      seat,
      eventType: "tap",
      targetTick: isFiniteNumber(ev?.payload?.targetTick) ? Math.round(ev.payload.targetTick) : null,
      x: roundNet(x, 2),
      y: roundNet(y, 2),
    });
    return;
  }
  if (ev.type === "abilityPrimary") {
    const explicitAbility = getAbilityById(ev?.payload?.abilityId);
    const spec = getHobbySpec(agent.hobby?.id);
    const ability = explicitAbility ?? getAbilitySlot(spec, "primary");
    if (!ability) return;
    const casted = castHobbyAbilityById(world, agent, getOpponentAgent(world, agent), ability.id);
    if (casted) {
      setAbilityCooldown(world, agent, "primary", ability);
      agent.hobby.lastUsed = ability.id;
    }
    enqueueNetDebugLog(world, "event_apply", {
      seat,
      eventType: "abilityPrimary",
      abilityId: ability.id,
      casted,
      targetTick: isFiniteNumber(ev?.payload?.targetTick) ? Math.round(ev.payload.targetTick) : null,
    });
    return;
  }
  if (ev.type === "abilitySecondary") {
    const explicitAbility = getAbilityById(ev?.payload?.abilityId);
    const spec = getHobbySpec(agent.hobby?.id);
    const ability = explicitAbility ?? getAbilitySlot(spec, "secondary");
    if (!ability) return;
    const casted = castHobbyAbilityById(world, agent, getOpponentAgent(world, agent), ability.id);
    if (casted) {
      setAbilityCooldown(world, agent, "secondary", ability);
      agent.hobby.lastUsed = ability.id;
    }
    enqueueNetDebugLog(world, "event_apply", {
      seat,
      eventType: "abilitySecondary",
      abilityId: ability.id,
      casted,
      targetTick: isFiniteNumber(ev?.payload?.targetTick) ? Math.round(ev.payload.targetTick) : null,
    });
  }
}

function applyRemoteRoomEnd(world, endState) {
  if (!endState || !endState.ended) return false;
  const rt = world.runtime;
  const end = rt?.roundEnd;
  if (!end) return false;
  const winnerId = endState.winnerId === "B" ? "B" : endState.winnerId === "A" ? "A" : "";
  let winnerName = String(endState.winnerName ?? "").trim();
  if (!winnerName && winnerId) {
    winnerName = getAgent(world, winnerId)?.playerName || winnerId;
  }
  const message = String(endState.message ?? (winnerName ? `${winnerName} Wins` : "Draw")).trim() || "Draw";
  const changed = !end.active || end.winnerId !== winnerId || end.message !== message;
  end.active = true;
  end.winnerId = winnerId;
  end.winnerName = winnerName;
  end.message = message;
  end.showUntil = Math.max(finiteOr(end.showUntil, 0), world.time + 2.2);
  end.returnAt = Math.max(finiteOr(end.returnAt, 0), world.time + 2.4);
  return changed;
}

function ingestAuthoritativeFrames(world, frames) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || !Array.isArray(frames) || frames.length === 0) return 0;
  if (!(net.authoritativeFrames instanceof Map)) net.authoritativeFrames = new Map();
  let added = 0;
  for (const item of frames) {
    if (!item || typeof item !== "object") continue;
    const frame = item.frame ?? item.snapshot ?? null;
    const tick = Math.max(0, Math.round(finiteOr(item.tick ?? frame?.tick, -1)));
    const seq = Math.max(0, Math.round(finiteOr(item.seq, 0)));
    if (!frame || tick < 0) continue;
    const existing = net.authoritativeFrames.get(tick);
    if (existing && finiteOr(existing.seq, 0) >= seq) continue;
    net.authoritativeFrames.set(tick, { seq, frame });
    added += 1;
  }
  const keepMinTick = Math.max(0, finiteOr(rt.simTick, 0) - Math.max(48, net.maxRollbackTicks + 8));
  const keepMaxTick = Math.max(keepMinTick + 1, finiteOr(rt.simTick, 0) + Math.max(40, net.authorityHorizonTicks * 3));
  for (const [tick] of net.authoritativeFrames) {
    if (tick < keepMinTick || tick > keepMaxTick) net.authoritativeFrames.delete(tick);
  }
  return added;
}

async function sendRoomAction(world, type, payload) {
  const rt = world.runtime;
  const net = rt.net;
  if (!net?.token) return false;
  try {
    await apiRequest("/api/room/action", "POST", {
      token: net.token,
      type,
      payload: {
        ...(payload ?? {}),
        clientSentAt: performance.now() * 0.001,
        clientGameTime: world.time,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function enqueueRoomAction(world, type, payload, options = null) {
  const net = world.runtime?.net;
  if (!net) return false;
  if (!Array.isArray(net.actionOutbox)) net.actionOutbox = [];
  const entry = {
    type: String(type ?? ""),
    payload: deepClone(payload ?? {}),
    tries: 0,
    nextTryAt: 0,
  };
  if (options?.priority) net.actionOutbox.unshift(entry);
  else net.actionOutbox.push(entry);
  return true;
}

function flushRoomActionOutbox(world) {
  const net = world.runtime?.net;
  if (!net || !Array.isArray(net.actionOutbox) || net.actionOutbox.length === 0) return;
  if (net.actionOutboxBusy) return;
  const next = net.actionOutbox[0];
  const nowWall = performance.now() * 0.001;
  if (nowWall < finiteOr(next?.nextTryAt, 0)) return;
  net.actionOutboxBusy = true;
  void sendRoomAction(world, next.type, next.payload)
    .then((ok) => {
      if (ok) {
        net.actionOutbox.shift();
        return;
      }
      next.tries = Math.max(0, Math.round(finiteOr(next.tries, 0))) + 1;
      next.nextTryAt = nowWall + Math.min(0.5, 0.06 * Math.pow(1.5, next.tries));
    })
    .catch(() => {
      next.tries = Math.max(0, Math.round(finiteOr(next.tries, 0))) + 1;
      next.nextTryAt = nowWall + Math.min(0.5, 0.06 * Math.pow(1.5, next.tries));
    })
    .finally(() => {
      net.actionOutboxBusy = false;
    });
}

function maybeSyncRoundEnd(world) {
  const rt = world.runtime;
  const net = rt?.net;
  const end = rt?.roundEnd;
  if (!net || !end || !end.active) return;
  if (rt.match?.mode !== "pvp" || net.seat !== "A" || !net.token) return;
  if (net.endSyncWinnerId === end.winnerId && net.endSyncSent) return;
  const nowWall = performance.now() * 0.001;
  if (nowWall < finiteOr(net.nextEndSyncAt, 0)) return;
  net.nextEndSyncAt = nowWall + 0.35;
  void apiRequest("/api/room/end", "POST", {
    token: net.token,
    winnerId: end.winnerId,
    winnerName: end.winnerName,
    message: end.message,
  })
    .then(() => {
      net.endSyncSent = true;
      net.endSyncWinnerId = end.winnerId;
    })
    .catch(() => {
      // Keep retrying while round-end is active.
    });
}

function maybeUpdateNetStartBarrier(world, startAtMsRaw, serverNowMsRaw = null) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return;
  if (rt.simTick > 0 || world.time > 0.0001) return;
  const startAtMs = Number(startAtMsRaw);
  if (!isFiniteNumber(startAtMs) || startAtMs <= 0) return;
  const serverNowMs = isFiniteNumber(Number(serverNowMsRaw)) ? Number(serverNowMsRaw) : Date.now();
  const delayMs = Math.max(0, startAtMs - serverNowMs);
  const nextPerf = performance.now() * 0.001 + delayMs * 0.001;
  if (!isFiniteNumber(net.startAtPerfSec) || nextPerf > net.startAtPerfSec) {
    net.startAtPerfSec = nextPerf;
  }
}

function normalizeActionTick(net, tick, fallbackTick) {
  const base = isFiniteNumber(tick) ? tick : fallbackTick;
  const rounded = Math.max(0, Math.round(finiteOr(base, 0)));
  if (!net) return rounded;
  const maxAhead = Math.max(2, net.inputLeadTicks + 8);
  const maxBehind = Math.max(2, net.maxRollbackTicks + 2);
  const lo = Math.max(0, finiteOr(net.localTick, 0) - maxBehind);
  const hi = Math.max(lo, finiteOr(net.localTick, 0) + maxAhead);
  return clamp(rounded, lo, hi);
}

function mapReceivedActionTick(world, ev) {
  const rt = world.runtime;
  const net = rt?.net;
  const senderTickRaw = ev?.payload?.targetTick;
  if (!net) return finiteOr(senderTickRaw, rt?.simTick ?? 0);
  // In lockstep, targetTick is authoritative simulation time; remapping by
  // local offsets causes early/late execution and timeline divergence.
  return normalizeActionTick(net, senderTickRaw, finiteOr(rt.simTick, 0));
}

function lockstepInputKey(ev, tick) {
  const seat = ev?.seat === "B" ? "B" : "A";
  const payload = ev?.payload ?? {};
  const clientSeq = isFiniteNumber(payload.clientSeq) ? Math.round(payload.clientSeq) : null;
  if (clientSeq !== null) return `${seat}|${clientSeq}`;
  const fallbackId = isFiniteNumber(ev?.id) ? Math.round(ev.id) : String(ev?.id ?? "");
  return `${seat}|${fallbackId}|${String(ev?.type ?? "")}`;
}

function queueLockstepInput(world, ev, explicitTick = null) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return false;

  const fallbackTick = finiteOr(rt.simTick, 0) + Math.max(1, finiteOr(net.inputLeadTicks, 2));
  let tick = normalizeActionTick(net, explicitTick ?? ev?.payload?.targetTick, fallbackTick);
  const key = lockstepInputKey(ev, tick);
  if (net.seenInputKeys.has(key)) return false;
  net.seenInputKeys.add(key);
  if (net.seenInputKeys.size > 1200) net.seenInputKeys.clear();

  const nowWall = performance.now() * 0.001;
  if (tick < rt.simTick) {
    const delta = rt.simTick - tick;
    if (delta > Math.max(1, finiteOr(net.maxRollbackTicks, NET_SMOOTHNESS_BUDGET.maxRollbackTicks))) {
      tick = rt.simTick;
      net.lateActionCount = (net.lateActionCount ?? 0) + 1;
      enqueueNetDebugLog(world, "input_late_clamped", {
        seat: ev?.seat ?? "",
        eventType: String(ev?.type ?? ""),
        localTick: Math.round(finiteOr(rt.simTick, 0)),
        incomingTick: Math.round(finiteOr(explicitTick ?? ev?.payload?.targetTick, tick)),
      });
    } else {
      if (nowWall - finiteOr(net.rollbackWindowStart, 0) > 1) {
        net.rollbackWindowStart = nowWall;
        net.rollbackCount = 0;
      }
      if ((net.rollbackCount ?? 0) >= 5) {
        tick = rt.simTick;
        enqueueNetDebugLog(world, "rollback_throttled", {
          seat: ev?.seat ?? "",
          eventType: String(ev?.type ?? ""),
          localTick: Math.round(finiteOr(rt.simTick, 0)),
        });
      } else {
        net.rollbackTick = net.rollbackTick === null ? tick : Math.min(net.rollbackTick, tick);
        net.rollbackCount = (net.rollbackCount ?? 0) + 1;
        enqueueNetDebugLog(world, "rollback_queued", {
          seat: ev?.seat ?? "",
          eventType: String(ev?.type ?? ""),
          rollbackTick: Math.round(finiteOr(net.rollbackTick, tick)),
          localTick: Math.round(finiteOr(rt.simTick, 0)),
        });
      }
    }
  }

  const stamped = {
    id: ev?.id ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    seat: ev?.seat === "B" ? "B" : "A",
    type: String(ev?.type ?? ""),
    payload: { ...(ev?.payload ?? {}), targetTick: tick },
    at: finiteOr(ev?.at, performance.now() * 0.001),
    tick,
  };
  const existing = net.timeline.get(tick) ?? [];
  existing.push(stamped);
  existing.sort((a, b) => {
    const seatCmp = String(a.seat).localeCompare(String(b.seat));
    if (seatCmp !== 0) return seatCmp;
    const seqA = finiteOr(a.payload?.clientSeq, Number.MAX_SAFE_INTEGER);
    const seqB = finiteOr(b.payload?.clientSeq, Number.MAX_SAFE_INTEGER);
    if (seqA !== seqB) return seqA - seqB;
    const idA = finiteOr(a.id, Number.MAX_SAFE_INTEGER);
    const idB = finiteOr(b.id, Number.MAX_SAFE_INTEGER);
    return idA - idB;
  });
  net.timeline.set(tick, existing);
  return true;
}

function ingestPendingLockstepInputs(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return;
  const pending = Array.isArray(net.pendingEvents) ? net.pendingEvents.splice(0) : [];
  const localSeat = net.seat === "B" ? "B" : "A";
  for (const ev of pending) {
    if (!ev || !ev.seat) continue;
    const evSeat = ev.seat === "B" ? "B" : "A";
    if (evSeat === localSeat && isFiniteNumber(ev?.payload?.clientSeq)) {
      net.lastAckedInputSeq = Math.max(
        Math.round(finiteOr(net.lastAckedInputSeq, 0)),
        Math.max(0, Math.round(finiteOr(ev.payload.clientSeq, 0))),
      );
    }
    const mappedTick = mapReceivedActionTick(world, ev);
    const queued = queueLockstepInput(world, ev, mappedTick);
    if (queued) {
      enqueueNetDebugLog(world, "event_ingest", {
        eventId: isFiniteNumber(ev.id) ? Math.round(ev.id) : null,
        seat: ev.seat,
        eventType: String(ev.type ?? ""),
        mappedTick: Math.round(finiteOr(mappedTick, 0)),
        localTick: Math.round(finiteOr(rt.simTick, 0)),
      });
    }
  }
}

function applyLockstepInputsForTick(world, tick) {
  const net = world.runtime?.net;
  if (!net || net.syncModel !== "lockstep") return;
  const events = net.timeline.get(tick);
  if (!Array.isArray(events) || events.length === 0) return;
  for (const ev of events) {
    applyIncomingAction(world, ev.seat, ev);
  }
}

function captureLockstepState(world, tick) {
  return {
    tick,
    time: world.time,
    simRngState: world.runtime.simRngState >>> 0,
    simRngSeed: world.runtime.simRngSeed >>> 0,
    agents: deepClone(world.agents),
    juggernaut: deepClone(world.juggernaut),
    ability: deepClone(world.ability),
    screenShake: deepClone(world.screenShake),
    roundEnd: deepClone(world.runtime.roundEnd),
  };
}

function buildLockstepStateFromNetSnapshot(world, snap) {
  const rt = world.runtime;
  return {
    tick: Math.max(0, Math.round(finiteOr(snap?.tick, rt?.simTick ?? 0))),
    time: finiteOr(snap?.t, world.time),
    simRngState: (Math.round(finiteOr(snap?.simRngState, rt?.simRngState ?? 1)) >>> 0) || 1,
    simRngSeed: (Math.round(finiteOr(snap?.simRngSeed, rt?.simRngSeed ?? 1)) >>> 0) || 1,
    agents: deepClone(Array.isArray(snap?.agents) ? snap.agents : world.agents),
    juggernaut: deepClone(snap?.juggernaut ?? world.juggernaut),
    ability: deepClone(snap?.ability ?? world.ability),
    screenShake: deepClone(snap?.screenShake ?? world.screenShake),
    roundEnd: deepClone(snap?.roundEnd ?? world.runtime?.roundEnd),
  };
}

function restoreLockstepState(world, snap) {
  if (!snap) return false;
  world.time = finiteOr(snap.time, world.time);
  world.runtime.simTick = Math.max(0, Math.round(finiteOr(snap.tick, world.runtime.simTick)));
  world.runtime.simRngSeed = (finiteOr(snap.simRngSeed, world.runtime.simRngSeed) >>> 0) || 1;
  world.runtime.simRngState = (finiteOr(snap.simRngState, world.runtime.simRngState) >>> 0) || 1;
  world.agents = deepClone(snap.agents ?? world.agents);
  world.juggernaut = deepClone(snap.juggernaut ?? world.juggernaut);
  world.ability = deepClone(snap.ability ?? world.ability);
  world.screenShake = deepClone(snap.screenShake ?? world.screenShake);
  world.runtime.roundEnd = deepClone(snap.roundEnd ?? world.runtime.roundEnd);
  return true;
}

function pruneLockstepBuffers(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return;
  const minTick = Math.max(0, rt.simTick - Math.max(32, net.maxRollbackTicks + 6));
  for (const [tick] of net.timeline) {
    if (tick < minTick) net.timeline.delete(tick);
  }
  for (const [tick] of net.history) {
    if (tick < minTick) net.history.delete(tick);
  }
}

function runLockstepRollback(world, endTickExclusive) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep") return false;
  const requested = net.rollbackTick;
  if (!isFiniteNumber(requested)) return false;
  net.rollbackTick = null;

  const floorTick = Math.max(0, endTickExclusive - Math.max(1, finiteOr(net.maxRollbackTicks, NET_SMOOTHNESS_BUDGET.maxRollbackTicks)));
  const startTick = Math.max(floorTick, Math.round(requested));
  const snap = net.history.get(startTick);
  if (!snap) return false;
  if (!restoreLockstepState(world, snap)) return false;
  enqueueNetDebugLog(world, "rollback_run", {
    startTick,
    endTickExclusive: Math.round(finiteOr(endTickExclusive, 0)),
  });

  let replayTick = startTick;
  while (replayTick < endTickExclusive) {
    net.history.set(replayTick, captureLockstepState(world, replayTick));
    world.time += net.stepDt;
    const previousRandomSource = ACTIVE_RANDOM_SOURCE;
    ACTIVE_RANDOM_SOURCE = () => nextSimulationRandom(world);
    try {
      applyLockstepInputsForTick(world, replayTick);
      simulateGameplayStep(world, net.stepDt);
    } finally {
      ACTIVE_RANDOM_SOURCE = previousRandomSource;
    }
    updateRoundEndFlow(world);
    replayTick += 1;
    rt.simTick = replayTick;
  }
  return true;
}

function maybeLockstepHardResync(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.playState !== "guest") return false;
  const queue = Array.isArray(net.snapshotQueue) ? net.snapshotQueue : null;
  if (!queue || queue.length === 0) return false;
  const latest = queue[queue.length - 1];
  if (!latest?.snapshot || finiteOr(latest.seq, 0) <= finiteOr(net.lastRenderedSeq, 0)) return false;
  net.lastRenderedSeq = finiteOr(latest.seq, net.lastRenderedSeq ?? 0);

  const snap = latest.snapshot;
  const snapshotTick = Math.max(0, Math.round(finiteOr(snap.tick, rt.simTick)));
  const localTick = Math.max(0, Math.round(finiteOr(rt.simTick, 0)));
  const localSeat = net.seat === "B" ? "B" : "A";
  const pendingLocalInput = Math.round(finiteOr(net.lastLocalInputSeq, 0)) > Math.round(finiteOr(net.lastAckedInputSeq, 0));
  const localInputAge = performance.now() * 0.001 - finiteOr(net.lastLocalInputAt, -Infinity);
  const protectLocalInput = pendingLocalInput && localInputAge < Math.max(0.15, finiteOr(net.localInputProtectSec, 0.45));

  let compareAgents = world.agents;
  let compareEnd = world.runtime?.roundEnd ?? {};
  if (snapshotTick < localTick) {
    const localAtSnapshotTick = net.history.get(snapshotTick);
    if (!localAtSnapshotTick?.agents) {
      enqueueNetDebugLog(world, "snapshot_skip_nohistory", {
        snapshotTick,
        localTick,
        historySize: net.history instanceof Map ? net.history.size : 0,
      });
      return false;
    }
    compareAgents = localAtSnapshotTick.agents;
    compareEnd = localAtSnapshotTick.roundEnd ?? compareEnd;
  } else if (snapshotTick > localTick + 2) {
    enqueueNetDebugLog(world, "snapshot_skip_future", { snapshotTick, localTick });
    return false;
  }

  const criticalMismatch = (() => {
    const snapAgents = new Map((snap.agents ?? []).map((ag) => [ag.id, ag]));
    for (const ag of compareAgents) {
      const sag = snapAgents.get(ag.id);
      if (!sag) continue;
      const protectAgent = protectLocalInput && ag.id === localSeat;
      const hpThreshold = protectAgent ? 4 : 0.75;
      const absorbThreshold = protectAgent ? 4 : 0.75;
      if (Math.abs(finiteOr(sag.hp, ag.hp) - ag.hp) > hpThreshold) return true;
      if (Math.abs(finiteOr(sag.absorbHp, ag.absorbHp ?? 0) - finiteOr(ag.absorbHp, 0)) > absorbThreshold) return true;
      if (protectAgent) continue;
      const sagHobby = sag.hobby ?? {};
      const agHobby = ag.hobby ?? {};
      if (Math.abs(finiteOr(sagHobby.primaryCooldownUntil, agHobby.primaryCooldownUntil) - finiteOr(agHobby.primaryCooldownUntil, 0)) > 0.2) return true;
      if (Math.abs(finiteOr(sagHobby.secondaryCooldownUntil, agHobby.secondaryCooldownUntil) - finiteOr(agHobby.secondaryCooldownUntil, 0)) > 0.2) return true;
      if (Math.abs(finiteOr(sagHobby.castGlobalUntil, agHobby.castGlobalUntil) - finiteOr(agHobby.castGlobalUntil, 0)) > 0.2) return true;
    }
    const snapEnd = snap.roundEnd ?? {};
    if (Boolean(snapEnd.active) !== Boolean(compareEnd.active)) return true;
    if (Boolean(snapEnd.active) && String(snapEnd.winnerId ?? "") !== String(compareEnd.winnerId ?? "")) return true;
    return false;
  })();
  const snapAgents = new Map((snap.agents ?? []).map((ag) => [ag.id, ag]));
  let maxErr = 0;
  for (const ag of compareAgents) {
    const s = snapAgents.get(ag.id);
    if (!s) continue;
    const err = hypot(finiteOr(s.x, ag.x) - ag.x, finiteOr(s.y, ag.y) - ag.y);
    if (err > maxErr) maxErr = err;
  }
  if (!criticalMismatch && maxErr <= Math.max(2, finiteOr(net.hardCorrectionPx, NET_SMOOTHNESS_BUDGET.hardCorrectionPx))) return false;
  const nowWall = performance.now() * 0.001;
  if (!criticalMismatch && nowWall - finiteOr(net.lastCorrectionAt, 0) < 0.8) return false;
  if (criticalMismatch && nowWall - finiteOr(net.lastCorrectionAt, 0) < 0.15) return false;
  const snapTick = snapshotTick;
  const localTickBefore = localTick;
  const snapState = buildLockstepStateFromNetSnapshot(world, snap);
  let replayed = false;
  if (snapState.tick <= localTickBefore) {
    const floorTick = Math.max(0, localTickBefore - Math.max(1, finiteOr(net.maxRollbackTicks, NET_SMOOTHNESS_BUDGET.maxRollbackTicks)));
    if (snapState.tick >= floorTick && restoreLockstepState(world, snapState)) {
      let replayTick = snapState.tick;
      while (replayTick < localTickBefore) {
        net.history.set(replayTick, captureLockstepState(world, replayTick));
        world.time += net.stepDt;
        const previousRandomSource = ACTIVE_RANDOM_SOURCE;
        ACTIVE_RANDOM_SOURCE = () => nextSimulationRandom(world);
        try {
          applyLockstepInputsForTick(world, replayTick);
          simulateGameplayStep(world, net.stepDt);
        } finally {
          ACTIVE_RANDOM_SOURCE = previousRandomSource;
        }
        updateRoundEndFlow(world);
        replayTick += 1;
        rt.simTick = replayTick;
      }
      replayed = true;
    }
  }
  if (!replayed) {
    applyNetSnapshot(world, snap);
  }
  net.lastCorrectionAt = nowWall;
  net.correctionCount = (net.correctionCount ?? 0) + 1;
  net.localTick = rt.simTick;
  rt.simAccumulator = 0;
  net.rollbackTick = null;
  if (replayed) pruneLockstepBuffers(world);
  else net.history.clear();
  enqueueNetDebugLog(world, "hard_resync", {
    criticalMismatch: Boolean(criticalMismatch),
    protectLocalInput: Boolean(protectLocalInput),
    maxErr: roundNet(maxErr, 2),
    snapTick,
    localTickBefore,
    replayed,
  });
  return true;
}

function maybeApplyAuthoritativeFrameAssist(world) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.playState !== "guest") return false;
  if (!(net.authoritativeFrames instanceof Map)) return false;
  const nowWall = performance.now() * 0.001;
  const localSeat = net.seat === "B" ? "B" : "A";
  const pendingLocalInput = Math.round(finiteOr(net.lastLocalInputSeq, 0)) > Math.round(finiteOr(net.lastAckedInputSeq, 0));
  const localInputAge = nowWall - finiteOr(net.lastLocalInputAt, -Infinity);
  const protectLocalInput = pendingLocalInput && localInputAge < Math.max(0.15, finiteOr(net.localInputProtectSec, 0.45));
  const tick = Math.max(0, Math.round(finiteOr(rt.simTick, 0)));
  const rec = net.authoritativeFrames.get(tick);
  if (!rec?.frame) return false;
  const snap = rec.frame;
  const snapAgents = new Map((snap.agents ?? []).map((ag) => [ag.id, ag]));
  let maxErr = 0;
  for (const ag of world.agents) {
    const s = snapAgents.get(ag.id);
    if (!s) continue;
    const protectAgent = protectLocalInput && ag.id === localSeat;
    const dx = finiteOr(s.x, ag.x) - ag.x;
    const dy = finiteOr(s.y, ag.y) - ag.y;
    const err = hypot(dx, dy);
    if (err > maxErr) maxErr = err;
    const softSnapPx = Math.max(8, finiteOr(net.authoritySoftSnapPx, 22));
    if (err > softSnapPx * (protectAgent ? 2.5 : 1)) {
      ag.x = finiteOr(s.x, ag.x);
      ag.y = finiteOr(s.y, ag.y);
    } else if (err > 0.01) {
      const baseBlend = clamp01(finiteOr(net.authorityBlend, 0.35));
      const blend = protectAgent ? Math.min(0.14, Math.max(0.04, baseBlend * 0.4)) : baseBlend;
      ag.x = lerp(ag.x, finiteOr(s.x, ag.x), blend);
      ag.y = lerp(ag.y, finiteOr(s.y, ag.y), blend);
    }
    if (!protectAgent || err > softSnapPx * 1.2) {
      ag.vx = finiteOr(s.vx, ag.vx);
      ag.vy = finiteOr(s.vy, ag.vy);
      ag.heading = finiteOr(s.heading, ag.heading);
    }
    const hpTarget = finiteOr(s.hp, ag.hp);
    const hpDelta = hpTarget - ag.hp;
    if (Math.abs(hpDelta) > 0.01) {
      if (Math.abs(hpDelta) > (protectAgent ? 6 : 3)) ag.hp = hpTarget;
      else ag.hp = lerp(ag.hp, hpTarget, protectAgent ? 0.12 : 0.35);
    }
    const absorbTarget = finiteOr(s.absorbHp, ag.absorbHp ?? 0);
    const absorbDelta = absorbTarget - finiteOr(ag.absorbHp, 0);
    if (Math.abs(absorbDelta) > 0.01) {
      if (Math.abs(absorbDelta) > (protectAgent ? 6 : 3)) ag.absorbHp = absorbTarget;
      else ag.absorbHp = lerp(finiteOr(ag.absorbHp, 0), absorbTarget, protectAgent ? 0.12 : 0.35);
    }
    if (s.hobby && typeof s.hobby === "object" && !protectAgent) ag.hobby = { ...(ag.hobby ?? {}), ...s.hobby };
  }
  if (snap.juggernaut && world.juggernaut) {
    const j = world.juggernaut;
    const sj = snap.juggernaut;
    const jErr = hypot(finiteOr(sj.x, j.x) - j.x, finiteOr(sj.y, j.y) - j.y);
    maxErr = Math.max(maxErr, jErr);
    if (jErr > Math.max(8, finiteOr(net.authoritySoftSnapPx, 22))) {
      j.x = finiteOr(sj.x, j.x);
      j.y = finiteOr(sj.y, j.y);
    } else if (jErr > 0.01) {
      const blend = clamp01(finiteOr(net.authorityBlend, 0.35));
      j.x = lerp(j.x, finiteOr(sj.x, j.x), blend);
      j.y = lerp(j.y, finiteOr(sj.y, j.y), blend);
    }
    j.vx = finiteOr(sj.vx, j.vx);
    j.vy = finiteOr(sj.vy, j.vy);
    if (sj.agenda && typeof sj.agenda === "object") j.agenda = { ...(j.agenda ?? {}), ...sj.agenda };
  }
  // Ability entities are mostly deterministic from lockstep inputs.
  // Accept authoritative ability snapshots only when local input is settled.
  if (!protectLocalInput && snap.ability && typeof snap.ability === "object") {
    world.ability = {
      zones: Array.isArray(snap.ability.zones) ? deepClone(snap.ability.zones) : [],
      barriers: Array.isArray(snap.ability.barriers) ? deepClone(snap.ability.barriers) : [],
      summons: Array.isArray(snap.ability.summons) ? deepClone(snap.ability.summons) : [],
      yarn: Array.isArray(snap.ability.yarn) ? deepClone(snap.ability.yarn) : [],
      keyboardTasks: Array.isArray(snap.ability.keyboardTasks) ? deepClone(snap.ability.keyboardTasks) : [],
      projectiles: Array.isArray(snap.ability.projectiles) ? deepClone(snap.ability.projectiles) : [],
      markers: Array.isArray(snap.ability.markers) ? deepClone(snap.ability.markers) : [],
    };
  }
  if (snap.roundEnd && typeof snap.roundEnd === "object") {
    world.runtime.roundEnd = deepClone(snap.roundEnd);
  }
  if (maxErr > Math.max(3, finiteOr(net.hardCorrectionPx, 4))) {
    enqueueNetDebugLog(world, "authority_assist", {
      tick,
      maxErr: roundNet(maxErr, 2),
      seq: Math.round(finiteOr(rec.seq, 0)),
    });
  }
  return true;
}

function forceLockstepSnapshotResync(world, reason = "resume") {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.playState !== "guest") return false;
  let source = "snapshot";
  let sourceSeq = 0;
  let sourceSnap = null;
  if (net.authoritativeFrames instanceof Map && net.authoritativeFrames.size > 0) {
    let best = null;
    for (const rec of net.authoritativeFrames.values()) {
      if (!rec?.frame) continue;
      if (!best || finiteOr(rec.seq, 0) > finiteOr(best.seq, 0)) best = rec;
    }
    if (best?.frame) {
      source = "frame";
      sourceSeq = Math.max(0, Math.round(finiteOr(best.seq, 0)));
      sourceSnap = best.frame;
    }
  }
  if (!sourceSnap) {
    const queue = Array.isArray(net.snapshotQueue) ? net.snapshotQueue : null;
    if (!queue || queue.length === 0) return false;
    const latest = queue[queue.length - 1];
    if (!latest?.snapshot) return false;
    sourceSeq = Math.max(0, Math.round(finiteOr(latest.seq, 0)));
    sourceSnap = latest.snapshot;
  }
  const snapState = buildLockstepStateFromNetSnapshot(world, sourceSnap);
  if (!restoreLockstepState(world, snapState)) return false;
  rt.simAccumulator = 0;
  net.localTick = rt.simTick;
  net.rollbackTick = null;
  const keepFromTick = Math.max(0, Math.round(finiteOr(rt.simTick, 0)) - 2);
  for (const [tick] of net.history) {
    if (tick < keepFromTick) net.history.delete(tick);
  }
  for (const [tick] of net.timeline) {
    if (tick < keepFromTick) net.timeline.delete(tick);
  }
  if (source === "snapshot") {
    net.lastRenderedSeq = Math.max(finiteOr(net.lastRenderedSeq, 0), sourceSeq);
  }
  enqueueNetDebugLog(world, "force_resync", {
    reason: String(reason || "resume"),
    source,
    tick: Math.round(finiteOr(rt.simTick, 0)),
    sourceSeq,
  });
  return true;
}

function scheduleLocalLockstepAction(world, type, payload, options = null) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.match?.mode !== "pvp") return false;
  const seat = net.seat === "B" ? "B" : "A";
  const extraLeadTicks = Math.max(0, Math.round(finiteOr(options?.extraLeadTicks, 0)));
  const targetTick = normalizeActionTick(net, rt.simTick + net.inputLeadTicks + extraLeadTicks, rt.simTick + 1);
  const clientSeq = Math.max(1, Math.round(net.localInputSeq ?? 1));
  net.localInputSeq = clientSeq + 1;
  const localEvent = {
    id: `local-${seat}-${clientSeq}`,
    seat,
    type,
    payload: {
      ...(payload ?? {}),
      targetTick,
      clientSeq,
    },
    at: performance.now() * 0.001,
  };
  net.lastLocalInputAt = performance.now() * 0.001;
  net.lastLocalInputSeq = clientSeq;
  queueLockstepInput(world, localEvent, targetTick);
  const priority = type === "abilityPrimary" || type === "abilitySecondary";
  enqueueRoomAction(world, type, localEvent.payload, { priority });
  flushRoomActionOutbox(world);
  enqueueNetDebugLog(world, "local_input", {
    seat,
    eventType: type,
    extraLeadTicks,
    targetTick: Math.round(finiteOr(targetTick, 0)),
    clientSeq: clientSeq,
  });
  return true;
}

function buildAuthoritativeFutureFrames(world, count = AUTHORITY_FRAME_HORIZON_TICKS) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || net.syncModel !== "lockstep" || rt.playState !== "host") return [];
  const horizon = Math.max(1, Math.min(120, Math.round(finiteOr(count, AUTHORITY_FRAME_HORIZON_TICKS))));
  const baseTick = Math.max(0, Math.round(finiteOr(rt.simTick, 0)));
  const baseSnap = captureLockstepState(world, baseTick);
  const savedAccumulator = finiteOr(rt.simAccumulator, 0);
  const savedLocalTick = finiteOr(net.localTick, 0);
  const savedRollbackTick = isFiniteNumber(net.rollbackTick) ? net.rollbackTick : null;
  const frames = [];
  let replayTick = baseTick;
  try {
    while (frames.length < horizon) {
      world.time += net.stepDt;
      const previousRandomSource = ACTIVE_RANDOM_SOURCE;
      ACTIVE_RANDOM_SOURCE = () => nextSimulationRandom(world);
      try {
        applyLockstepInputsForTick(world, replayTick);
        simulateGameplayStep(world, net.stepDt);
      } finally {
        ACTIVE_RANDOM_SOURCE = previousRandomSource;
      }
      updateRoundEndFlow(world);
      replayTick += 1;
      rt.simTick = replayTick;
      net.localTick = replayTick;
      frames.push({
        tick: replayTick,
        frame: buildNetSnapshot(world),
      });
    }
  } finally {
    restoreLockstepState(world, baseSnap);
    rt.simTick = baseTick;
    net.localTick = savedLocalTick;
    net.rollbackTick = savedRollbackTick;
    rt.simAccumulator = savedAccumulator;
  }
  return frames;
}

async function pollSession(world) {
  const rt = world.runtime;
  if (!rt.sessionToken || rt.sessionPollBusy) return;
  rt.sessionPollBusy = true;
  try {
    const res = await apiRequest(`/api/session?token=${encodeURIComponent(rt.sessionToken)}`, "GET");
    const state = res.state ?? {};
    if (state.inRoom && state.started) {
      await startMatchFromState(world, state, res.serverNowMs);
      return;
    }
    if (state.inRoom) {
      const joined = state.opponentJoined ? "2/2 players joined" : "Waiting for opponent...";
      openRoomMenu(world, {
        mode: "room",
        title: "Room Lobby",
        status: `${joined}`,
        codeText: state.roomCode ? `Code ${state.roomCode}` : "",
        link: state.roomCode ? buildShareUrl("room", state.roomCode) : "",
        allowStartAi: state.seat === "A" && !state.opponentJoined,
        showCancel: false,
      });
      return;
    }
    if (state.waitingMatch) {
      openRoomMenu(world, {
        mode: "matchmaker",
        title: "Matchmaker Queue",
        status: "Waiting for another player...",
        codeText: "Auto pairing",
        link: buildShareUrl("queue", "1"),
        allowStartAi: false,
        showCancel: true,
        hideBack: true,
      });
      return;
    }
    if (rt.flowScreen === "room" && rt.roomMenuMode === "matchmaker") {
      clearRuntimeTimers(world);
      rt.roomMenuMode = "";
      setFlowScreen(world, "hub");
    }
  } catch (err) {
    rt.sessionPollErrorAt = performance.now();
    const msg = err?.message ?? "Session poll failed";
    setFlowError(world, msg);
    if (rt.flowScreen === "room" && world.ui?.flowRoomStatus) world.ui.flowRoomStatus.textContent = msg;
  } finally {
    rt.sessionPollBusy = false;
  }
}

function startSessionPolling(world, intervalMs = 700) {
  clearRuntimeTimers(world);
  pollSession(world);
  addRuntimeTimer(
    world,
    setInterval(() => {
      void pollSession(world);
    }, Math.max(300, intervalMs)),
  );
}

function startActionPullTimer(world, intervalMs) {
  const net = world.runtime?.net;
  if (!net) return;
  net.actionPullBusy = false;
  addRuntimeTimer(
    world,
    setInterval(async () => {
      if (net.actionPullBusy) return;
      net.actionPullBusy = true;
      try {
        const res = await apiRequest(
          `/api/room/actions?token=${encodeURIComponent(net.token)}&since=${encodeURIComponent(net.actionSince ?? 0)}`,
          "GET",
        );
        const events = Array.isArray(res.events) ? res.events : [];
        if (isFiniteNumber(res.lastId)) net.actionSince = Math.max(net.actionSince ?? 0, res.lastId);
        for (const ev of events) net.pendingEvents.push(ev);
      } catch {
        // Keep trying.
      } finally {
        net.actionPullBusy = false;
      }
    }, Math.max(20, intervalMs)),
  );
}

async function pullRoomBundleOnce(world, reason = "timer", forceResync = false) {
  const rt = world.runtime;
  const net = rt?.net;
  if (!net || !net.token) return false;
  if (net.bundlePullBusy) return false;
  net.bundlePullBusy = true;
  try {
    const res = await apiRequest(
      `/api/room/bundle?token=${encodeURIComponent(net.token)}&sinceAction=${encodeURIComponent(net.actionSince ?? 0)}&sinceSnapshot=${encodeURIComponent(net.snapshotSince ?? 0)}&sinceFrame=${encodeURIComponent(net.frameSince ?? 0)}`,
      "GET",
    );
    maybeUpdateNetStartBarrier(world, res.startAtMs, res.serverNowMs);
    const events = Array.isArray(res.events) ? res.events : [];
    if (isFiniteNumber(res.lastId)) net.actionSince = Math.max(net.actionSince ?? 0, res.lastId);
    for (const ev of events) net.pendingEvents.push(ev);
    if (isFiniteNumber(res.snapshotSeq)) net.snapshotSince = Math.max(net.snapshotSince ?? 0, res.snapshotSeq);
    if (isFiniteNumber(res.frameSeq)) net.frameSince = Math.max(net.frameSince ?? 0, res.frameSeq);
    const authorityFrames = Array.isArray(res.frames) ? res.frames : [];
    const addedFrames = ingestAuthoritativeFrames(world, authorityFrames);
    if (res.snapshot && isFiniteNumber(res.snapshotSeq)) {
      net.snapshotQueue.push({
        seq: res.snapshotSeq,
        recvAt: performance.now() * 0.001,
        snapshot: res.snapshot,
      });
      if (net.snapshotQueue.length > 6) net.snapshotQueue.shift();
    }
    if (res.endState?.ended) applyRemoteRoomEnd(world, res.endState);
    const pendingResume = Boolean(net.resumeResyncPending);
    const wantsResync = Boolean(forceResync || pendingResume);
    const needsFreshFrame = Boolean(net.resumeResyncNeedFreshFrame);
    const baselineFrameSeq = Math.max(0, Math.round(finiteOr(net.resumeResyncBaselineFrameSeq, 0)));
    const frameSeqNow = Math.max(0, Math.round(finiteOr(res.frameSeq, net.frameSince ?? 0)));
    const hasFreshFrame = frameSeqNow > baselineFrameSeq;
    const shouldResync = wantsResync && (!needsFreshFrame || hasFreshFrame);
    if (shouldResync) {
      const applied = forceLockstepSnapshotResync(world, reason);
      if (applied) {
        net.resumeResyncPending = false;
        net.resumeResyncNeedFreshFrame = false;
        net.resumeResyncBaselineFrameSeq = frameSeqNow;
      } else {
        net.resumeResyncPending = true;
      }
    } else if (wantsResync) {
      net.resumeResyncPending = true;
    }
    if (events.length > 0 || res.snapshot || res.endState?.ended || addedFrames > 0 || shouldResync) {
      enqueueNetDebugLog(world, "bundle_pull", {
        reason: String(reason || "timer"),
        events: events.length,
        snapshotSeq: isFiniteNumber(res.snapshotSeq) ? Math.round(res.snapshotSeq) : null,
        hasSnapshot: Boolean(res.snapshot),
        ended: Boolean(res.endState?.ended),
        frames: addedFrames,
        forceResync: Boolean(shouldResync),
        wantsResync: Boolean(wantsResync),
        needsFreshFrame: Boolean(needsFreshFrame),
        hasFreshFrame: Boolean(hasFreshFrame),
        baselineFrameSeq,
        frameSeqNow,
      });
    }
    return true;
  } catch {
    if (forceResync) net.resumeResyncPending = true;
    return false;
  } finally {
    net.bundlePullBusy = false;
  }
}

function startBundlePullTimer(world, intervalMs) {
  const net = world.runtime?.net;
  if (!net) return;
  net.bundlePullBusy = false;
  if (!Array.isArray(net.snapshotQueue)) net.snapshotQueue = [];
  addRuntimeTimer(
    world,
    setInterval(async () => {
      flushRoomActionOutbox(world);
      maybeSyncRoundEnd(world);
      await pullRoomBundleOnce(world, "timer", false);
    }, Math.max(20, intervalMs)),
  );
}

function startFrameBatchPushTimer(world, intervalMs) {
  const net = world.runtime?.net;
  if (!net) return;
  net.framePushBusy = false;
  addRuntimeTimer(
    world,
    setInterval(async () => {
      if (net.framePushBusy) return;
      if (world.runtime?.match?.mode !== "pvp" || world.runtime?.playState !== "host") return;
      if (isFiniteNumber(net.startAtPerfSec) && performance.now() * 0.001 < net.startAtPerfSec) return;
      net.framePushBusy = true;
      try {
        const frames = buildAuthoritativeFutureFrames(world, net.authorityHorizonTicks);
        if (!Array.isArray(frames) || frames.length === 0) return;
        const batchSeq = Math.max(1, Math.round(finiteOr(net.frameBatchSeq, 1)));
        net.frameBatchSeq = batchSeq + 1;
        const res = await apiRequest("/api/room/frame-batch", "POST", {
          token: net.token,
          batchSeq,
          fromTick: frames[0]?.tick ?? (world.runtime?.simTick ?? 0) + 1,
          frames,
        });
        if (isFiniteNumber(res.frameSeq)) net.frameSince = Math.max(net.frameSince ?? 0, res.frameSeq);
        enqueueNetDebugLog(world, "frame_batch_push", {
          batchSeq,
          frames: frames.length,
          fromTick: Math.round(finiteOr(frames[0]?.tick, 0)),
          toTick: Math.round(finiteOr(frames[frames.length - 1]?.tick, 0)),
        });
      } catch {
        // Keep trying.
      } finally {
        net.framePushBusy = false;
      }
    }, Math.max(35, intervalMs)),
  );
}

function startSnapshotPushTimer(world, intervalMs) {
  const net = world.runtime?.net;
  if (!net) return;
  net.snapshotPushBusy = false;
  addRuntimeTimer(
    world,
    setInterval(async () => {
      if (net.snapshotPushBusy) return;
      net.snapshotPushBusy = true;
      try {
        await apiRequest("/api/room/snapshot", "POST", {
          token: net.token,
          snapshot: buildNetSnapshot(world),
        });
      } catch {
        // Keep trying.
      } finally {
        net.snapshotPushBusy = false;
      }
    }, Math.max(80, intervalMs)),
  );
}

function startSnapshotPullTimer(world, intervalMs) {
  const net = world.runtime?.net;
  if (!net) return;
  net.snapshotPullBusy = false;
  if (!Array.isArray(net.snapshotQueue)) net.snapshotQueue = [];
  addRuntimeTimer(
    world,
    setInterval(async () => {
      if (net.snapshotPullBusy) return;
      net.snapshotPullBusy = true;
      try {
        const res = await apiRequest(
          `/api/room/snapshot?token=${encodeURIComponent(net.token)}&since=${encodeURIComponent(net.snapshotSince ?? 0)}`,
          "GET",
        );
        if (isFiniteNumber(res.seq)) net.snapshotSince = Math.max(net.snapshotSince ?? 0, res.seq);
        if (res.snapshot && isFiniteNumber(res.seq)) {
          net.snapshotQueue.push({
            seq: res.seq,
            recvAt: performance.now() * 0.001,
            snapshot: res.snapshot,
          });
          if (net.snapshotQueue.length > 6) net.snapshotQueue.shift();
        }
      } catch {
        // Keep trying.
      } finally {
        net.snapshotPullBusy = false;
      }
    }, Math.max(80, intervalMs)),
  );
}

function startHostNetworkTimers(world) {
  const net = world.runtime.net;
  if (!net) return;
  if (net.syncModel === "lockstep") {
    startBundlePullTimer(world, 28);
    startFrameBatchPushTimer(world, 80);
    // Low-frequency authoritative checkpoints for recovery only.
    startSnapshotPushTimer(world, 180);
  } else {
    startActionPullTimer(world, 55);
    startSnapshotPushTimer(world, 90);
  }
}

function startGuestNetworkTimers(world) {
  const net = world.runtime.net;
  if (!net) return;
  if (net.syncModel === "lockstep") {
    startBundlePullTimer(world, 28);
    return;
  }
  net.renderDelaySec = Math.max(0.08, finiteOr(net.renderDelaySec, 0.11));
  startSnapshotPullTimer(world, 70);
}

async function startMatchFromState(world, state, serverNowMs = null) {
  const rt = world.runtime;
  const seat = state.seat === "B" ? "B" : "A";
  const role = seat === "A" ? "host" : "guest";
  const mode = state.mode === "ai" ? "ai" : "pvp";
  const matchSeed = (Number(state.matchSeed) >>> 0) || hashSeed(`${state.roomCode ?? "local"}|${seat}|${Date.now()}`);
  const startAtMs = finiteOr(Number(state.startAtMs), 0);
  const serverNow = isFiniteNumber(Number(serverNowMs)) ? Number(serverNowMs) : Date.now();
  const startDelayMs = Math.max(0, startAtMs - serverNow);
  const startAtPerfSec = performance.now() * 0.001 + startDelayMs * 0.001;
  rt.match = {
    roomCode: state.roomCode,
    seat,
    role,
    mode,
    started: true,
    seed: matchSeed,
    startAtMs,
    players: state.players ?? {},
  };
  rt.playState = role === "guest" ? "guest" : "host";
  rt.roomMenuMode = "";
  rt.pendingJoinCode = null;
  rt.pendingQueueJoin = false;
  world.player.controlledId = seat;
  resetWorldForMatch(world, state.players ?? {}, mode);
  world.debug = false;
  world.terminalLog = rt.appMode === "developer";
  setFlowOverlayHidden(world, true);
  clearRuntimeTimers(world);

  rt.net = {
    token: rt.sessionToken,
    roomCode: state.roomCode,
    seat,
    role,
    mode,
    syncModel: mode === "pvp" ? "lockstep" : "none",
    tickRate: NET_SMOOTHNESS_BUDGET.tickRate,
    stepDt: 1 / NET_SMOOTHNESS_BUDGET.tickRate,
    inputLeadTicks: NET_SMOOTHNESS_BUDGET.inputLeadTicks,
    maxRollbackTicks: NET_SMOOTHNESS_BUDGET.maxRollbackTicks,
    maxCatchupSteps: NET_SMOOTHNESS_BUDGET.maxCatchupStepsPerFrame,
    hardCorrectionPx: NET_SMOOTHNESS_BUDGET.hardCorrectionPx,
    correctionBlendSec: NET_SMOOTHNESS_BUDGET.correctionBlendSec,
    actionSince: 0,
    snapshotSince: 0,
    frameSince: 0,
    pendingEvents: [],
    timeline: new Map(),
    history: new Map(),
    authoritativeFrames: new Map(),
    rollbackTick: null,
    localTick: 0,
    localInputSeq: 1,
    lastLocalInputAt: -Infinity,
    lastLocalInputSeq: 0,
    lastAckedInputSeq: 0,
    localInputProtectSec: 0.45,
    resumeResyncPending: false,
    resumeResyncNeedFreshFrame: false,
    resumeResyncBaselineFrameSeq: 0,
    resumeResyncCooldownUntil: 0,
    backgroundResumeNeeded: false,
    seenInputKeys: new Set(),
    remoteTickOffset: { A: 0, B: 0 },
    remoteTickOffsetInit: { A: false, B: false },
    lateActionCount: 0,
    rollbackCount: 0,
    rollbackWindowStart: 0,
    correctionCount: 0,
    lastCorrectionAt: 0,
    snapshotQueue: [],
    renderDelaySec: 0.11,
    lastRenderedSeq: 0,
    startAtPerfSec,
    actionOutbox: [],
    actionOutboxBusy: false,
    endSyncSent: false,
    endSyncWinnerId: "",
    nextEndSyncAt: 0,
    authorityHorizonTicks: AUTHORITY_FRAME_HORIZON_TICKS,
    authoritySoftSnapPx: 22,
    authorityBlend: 0.35,
    frameBatchSeq: 1,
    framePushBusy: false,
    debugQueue: [],
    debugPostBusy: false,
    debugFailCount: 0,
    debugDisabled: false,
    nextDiagAt: 0,
  };
  rt.simStepDt = rt.net.stepDt;

  if (mode === "pvp") {
    if (role === "host") startHostNetworkTimers(world);
    else startGuestNetworkTimers(world);
    enqueueNetDebugLog(world, "match_start", {
      role,
      seat,
      mode,
      startAtMs: finiteOr(startAtMs, 0),
      startDelayMs: roundNet(startDelayMs, 1),
      serverNowMs: finiteOr(serverNow, 0),
    });
    flushNetDebugQueue(world);
  } else {
    rt.net = null;
  }
}

function initFlowUi(world) {
  const ui = world.ui;
  const rt = world.runtime;
  if (typeof document?.createElement !== "function") {
    // Headless/test environment without DOM form elements.
    rt.appMode = "developer";
    rt.playState = "host";
    setFlowOverlayHidden(world, true);
    world.terminalLog = true;
    return;
  }

  function fillSelect(selectEl, values, labelOf) {
    if (!selectEl || typeof selectEl !== "object" || typeof selectEl.appendChild !== "function") return;
    selectEl.innerHTML = "";
    for (const val of values) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = labelOf(val);
      selectEl.appendChild(opt);
    }
  }

  fillSelect(ui.flowMbti, MBTI_TYPES, (v) => v);
  fillSelect(ui.flowHobby, HOBBY_IDS, (v) => getHobbySpec(v).label);
  if (ui.flowMbti) ui.flowMbti.value = "ENFP";
  if (ui.flowHobby) ui.flowHobby.value = "SCIENCE_RESEARCH";
  if (ui.flowLook) ui.flowLook.value = "CLASSIC";

  function bindFlowPress(element, handler) {
    if (!element) return;
    let lastPointerAt = -Infinity;
    element.addEventListener("pointerup", (event) => {
      lastPointerAt = performance.now();
      event.preventDefault();
      void handler(event);
    });
    element.addEventListener("click", (event) => {
      if (performance.now() - lastPointerAt < 350) {
        event.preventDefault();
        return;
      }
      void handler(event);
    });
  }

  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const apiFromUrl = params.get("api");
  EMBEDDED_API_BASE_URL = readEmbeddedApiBaseUrl();
  let storedApiBase = "";
  try {
    storedApiBase = localStorage.getItem("mbti_api_base") || "";
  } catch {
    storedApiBase = "";
  }
  if (apiFromUrl) setApiBaseUrl(apiFromUrl, { persist: true });
  else if (storedApiBase) setApiBaseUrl(storedApiBase, { persist: false });
  else setApiBaseUrl(EMBEDDED_API_BASE_URL, { persist: false });

  const roomFromUrl = params.get("room");
  if (roomFromUrl) rt.pendingJoinCode = String(roomFromUrl).toUpperCase();
  const queueFromUrl = params.get("queue");
  rt.pendingQueueJoin = queueFromUrl === "1";

  setFlowOverlayHidden(world, false);
  setFlowScreen(world, "profile");
  if (ui.flowStartAi) ui.flowStartAi.hidden = true;

  function flowErrorMessage(err, fallback) {
    const raw = String(err?.message ?? fallback ?? "Request failed");
    const endpoint = getApiBaseUrl() || "same-origin /api";
    if (/failed to fetch|networkerror|load failed/i.test(raw)) {
      return `Multiplayer server unavailable at ${endpoint}. Run \`npm run dev\` or pass \`?api=https://<worker>.workers.dev\`.`;
    }
    return raw;
  }

  async function onCreateRoom() {
    if (!rt.profileLocked || !rt.profile) return;
    setFlowError(world, "");
    try {
      const res = await apiRequest("/api/room/create", "POST", rt.profile);
      rt.sessionToken = res.token;
      openRoomMenu(world, {
        mode: "room",
        title: "Room Lobby",
        status: "Waiting for opponent...",
        codeText: res.roomCode ? `Code ${res.roomCode}` : "",
        link: res.joinUrl || buildShareUrl("room", res.roomCode),
        allowStartAi: true,
        showCancel: false,
      });
      startSessionPolling(world, 700);
    } catch (err) {
      setFlowError(world, flowErrorMessage(err, "Failed to create room"));
    }
  }

  async function onJoinRoom() {
    if (!rt.profileLocked || !rt.profile) return;
    const code = String(ui.flowRoomCode?.value ?? rt.pendingJoinCode ?? "").trim().toUpperCase();
    if (!code) {
      setFlowError(world, "Enter a room code");
      return;
    }
    setFlowError(world, "");
    try {
      const res = await apiRequest("/api/room/join", "POST", { ...rt.profile, roomCode: code });
      rt.sessionToken = res.token;
      if (res.state?.started) {
        await startMatchFromState(world, res.state, res.serverNowMs);
      } else {
        openRoomMenu(world, {
          mode: "room",
          title: "Room Lobby",
          status: "Waiting for host to start...",
          codeText: code ? `Code ${code}` : "",
          link: buildShareUrl("room", code),
          allowStartAi: false,
          showCancel: false,
        });
        startSessionPolling(world, 700);
      }
    } catch (err) {
      setFlowError(world, flowErrorMessage(err, "Failed to join room"));
    }
  }

  async function onMatchmaker() {
    if (!rt.profileLocked || !rt.profile) return;
    setFlowError(world, "");
    try {
      const res = await apiRequest("/api/matchmaker/join", "POST", rt.profile);
      rt.sessionToken = res.token;
      if (res.waiting) {
        openRoomMenu(world, {
          mode: "matchmaker",
          title: "Matchmaker Queue",
          status: "Waiting for another player...",
          codeText: "Auto pairing",
          link: buildShareUrl("queue", "1"),
          allowStartAi: false,
          showCancel: true,
          hideBack: true,
        });
        startSessionPolling(world, 700);
      } else {
        await startMatchFromState(world, res.state, res.serverNowMs);
      }
    } catch (err) {
      setFlowError(world, flowErrorMessage(err, "Matchmaker failed"));
    }
  }

  async function onLeaveQueue() {
    if (rt.sessionToken && rt.roomMenuMode === "matchmaker") {
      try {
        await apiRequest("/api/matchmaker/cancel", "POST", { token: rt.sessionToken });
      } catch {
        // Continue back to hub even if cancel fails.
      }
    }
    rt.sessionToken = "";
    rt.roomMenuMode = "";
    clearRuntimeTimers(world);
    setFlowScreen(world, "hub");
  }

  async function onCopyLink() {
    const link = String(ui.flowCopyLink?.dataset?.link ?? "");
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setFlowError(world, "Invite link copied");
    } catch {
      setFlowError(world, link);
    }
  }

  async function onStartAi() {
    if (!rt.sessionToken) return;
    setFlowError(world, "");
    try {
      const res = await apiRequest("/api/room/start-ai", "POST", { token: rt.sessionToken });
      await startMatchFromState(world, res.state, res.serverNowMs);
    } catch (err) {
      setFlowError(world, flowErrorMessage(err, "Could not start AI mode"));
    }
  }

  function onBack() {
    rt.roomMenuMode = "";
    clearRuntimeTimers(world);
    setFlowScreen(world, "hub");
  }

  bindFlowPress(ui.flowSave, () => {
    const name = sanitizeName(ui.flowName?.value ?? "");
    const mbti = sanitizeMbti(ui.flowMbti?.value ?? "ENFP");
    const hobby = sanitizeHobby(ui.flowHobby?.value ?? "SCIENCE_RESEARCH");
    const look = sanitizeLook(ui.flowLook?.value ?? "CLASSIC");
    rt.profile = { name, mbti, hobby, look };
    rt.profileLocked = true;
    if (ui.flowName) ui.flowName.disabled = true;
    if (ui.flowMbti) ui.flowMbti.disabled = true;
    if (ui.flowHobby) ui.flowHobby.disabled = true;
    if (ui.flowLook) ui.flowLook.disabled = true;
    if (ui.flowSave) ui.flowSave.disabled = true;
    setFlowError(world, "");
    setFlowScreen(world, "hub");
    if (rt.pendingJoinCode && ui.flowRoomCode) {
      ui.flowRoomCode.value = rt.pendingJoinCode;
      void onJoinRoom();
      return;
    }
    if (rt.pendingQueueJoin) {
      void onMatchmaker();
    }
  });

  bindFlowPress(ui.flowCreateRoom, onCreateRoom);
  bindFlowPress(ui.flowJoinRoom, onJoinRoom);
  bindFlowPress(ui.flowMatchmaker, onMatchmaker);
  bindFlowPress(ui.flowRoomCancel, onLeaveQueue);
  bindFlowPress(ui.flowCopyLink, onCopyLink);
  bindFlowPress(ui.flowStartAi, onStartAi);
  bindFlowPress(ui.flowBack, onBack);

  ui.flowRoomCode?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void onJoinRoom();
    }
  });
}

function toggleAppMode(world) {
  const rt = world.runtime;
  rt.appMode = rt.appMode === "developer" ? "player" : "developer";
  if (rt.appMode === "developer") {
    setFlowOverlayHidden(world, true);
    clearRuntimeTimers(world);
    rt.playState = "host";
    rt.match = null;
    rt.net = null;
    world.terminalLog = true;
    world.player.controlledId = "A";
    resetWorldForMatch(
      world,
      {
        A: { name: "A", mbti: "ENFP", hobby: "SCIENCE_RESEARCH" },
        B: { name: "B", mbti: "ENTP", hobby: "DANCE" },
      },
      "ai",
    );
    return;
  }

  world.debug = false;
  world.terminalLog = false;
  if (rt.match?.started) {
    setFlowOverlayHidden(world, true);
    if (rt.match.mode === "pvp") {
      if (rt.match.role === "host") startHostNetworkTimers(world);
      else startGuestNetworkTimers(world);
    }
    return;
  }
  setFlowOverlayHidden(world, false);
  setFlowScreen(world, rt.profileLocked ? "hub" : "profile");
  if (rt.sessionToken && !rt.match?.started) startSessionPolling(world, 700);
}

function simulateGameplayStep(world, dt) {
  // Ability timers/passives that affect intent and execution.
  updateAbilitySystems(world, dt, "pre");

  // Update juggernaut.
  updateJuggernaut(world, dt);

  // Perception (gaze-dependent): what each agent can currently see/notice.
  const j = world.juggernaut;
  const [agA, agB] = world.agents;
  if (agA && agB && j) {
    updatePerception(world, agA, agB, j, dt);
    updatePerception(world, agB, agA, j, dt);
  }

  // Non-player AI can cast strategically.
  if (agA && agB) {
    maybeAutoCastHobbyAbility(world, agA);
    maybeAutoCastHobbyAbility(world, agB);
  }

  // Stances (garrison/assault): updated continuously, but activation is gated by calm/safety.
  if (agA && agB && j) {
    updateStance(world, agA, agB, j, dt);
    updateStance(world, agB, agA, j, dt);
  }

  // AI decisions (checkpointed).
  if (agA && agB && j) {
    const meleeReach = MELEE_REACH;
    const hitRangeAB = agA.r + agB.r + meleeReach;
    const reactionMin = 0.14;

    function updateInterrupts(agent, opp) {
      const dO = hypot(agent.x - opp.x, agent.y - opp.y);
      const oppSeen = agent.senses.opp.visible || agent.senses.opp.peripheral || world.time - agent.senses.opp.lastSeenAt < 0.25;
      if (oppSeen && opp.attackWindupUntil > world.time && opp.attackWindupTargetId === agent.id && dO <= hitRangeAB * 1.4) {
        agent.events.oppThreatAt = world.time;
      }

      const c = clearance(world, agent.x, agent.y);
      const dJ = hypot(agent.x - j.x, agent.y - j.y);
      const safeDist = desiredSafeDistToJug(agent);
      const speed = hypot(agent.vx, agent.vy);
      const pinnedNow = c < 70 && dJ < safeDist * 0.95 && speed < 38;
      if (pinnedNow) {
        if (agent.events.pinnedSince < 0) agent.events.pinnedSince = world.time;
      } else {
        agent.events.pinnedSince = -Infinity;
      }
    }

    function shouldInterrupt(agent) {
      const ld = agent.events.lastDecisionAt;
      if (!(world.time - ld > reactionMin)) return false;
      if (agent.events.gotHitAt > ld) return true;
      if (agent.events.tookBigHitAt > ld) return true;
      if (agent.events.jugWindupSeenAt > ld) return true;
      if (agent.events.oppThreatAt > ld) return true;
      if (agent.events.pinnedSince > ld && world.time - agent.events.pinnedSince > 0.22) return true;
      return false;
    }

    updateInterrupts(agA, agB);
    updateInterrupts(agB, agA);

    if (!isAgentPhasedOut(agA, world.time) && (world.time >= agA.commitUntil || shouldInterrupt(agA))) decideTactic(world, agA, agB, j);
    if (!isAgentPhasedOut(agB, world.time) && (world.time >= agB.commitUntil || shouldInterrupt(agB))) decideTactic(world, agB, agA, j);
  }

  // Execute + physics.
  const actionsById = Object.create(null);
  if (agA && agB && j) {
    actionsById[agA.id] = executeTactic(world, agA, agB, j, dt);
    actionsById[agB.id] = executeTactic(world, agB, agA, j, dt);
  }

  // Separation after movement.
  const twirlA = agA ? isTwirlRushActive(agA, world.time) : false;
  const twirlB = agB ? isTwirlRushActive(agB, world.time) : false;
  if (agA && agB && !(twirlA || twirlB)) separate(agA, agB);
  if (agA && j && !twirlA) separateMobileStatic(agA, j);
  if (agB && j && !twirlB) separateMobileStatic(agB, j);

  // Combat resolution.
  resolveCombat(world, actionsById);

  // Ability entities/effects that depend on latest positions.
  updateAbilitySystems(world, dt, "post");

  // Emotions (pie chart + debug text).
  if (agA && agB && j) {
    updateEmotions(world, agA, agB, j, dt);
    updateEmotions(world, agB, agA, j, dt);
  }
}

function setup() {
  setupViewportCssHeight();
  const canvas = document.getElementById("world");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing #world canvas");

  const world = makeWorld(canvas);
  world.ui = {
    btnP: document.getElementById("ability-primary"),
    btnS: document.getElementById("ability-secondary"),
    btnPName: document.getElementById("ability-primary-name"),
    btnPSub: document.getElementById("ability-primary-sub"),
    btnSName: document.getElementById("ability-secondary-name"),
    btnSSub: document.getElementById("ability-secondary-sub"),
    statusATop: document.getElementById("status-a-top"),
    statusAHp: document.getElementById("status-a-hp"),
    statusAMid: document.getElementById("status-a-mid"),
    statusAThought: document.getElementById("status-a-thought"),
    statusBTop: document.getElementById("status-b-top"),
    statusBHp: document.getElementById("status-b-hp"),
    statusBMid: document.getElementById("status-b-mid"),
    statusBThought: document.getElementById("status-b-thought"),
    statusPlayer: document.getElementById("status-player"),
    flowOverlay: document.getElementById("flow-overlay"),
    flowProfile: document.getElementById("flow-profile"),
    flowHub: document.getElementById("flow-hub"),
    flowRoom: document.getElementById("flow-room"),
    flowError: document.getElementById("flow-error"),
    flowName: document.getElementById("flow-name"),
    flowMbti: document.getElementById("flow-mbti"),
    flowHobby: document.getElementById("flow-hobby"),
    flowLook: document.getElementById("flow-look"),
    flowSave: document.getElementById("flow-save"),
    flowCreateRoom: document.getElementById("flow-create-room"),
    flowRoomCode: document.getElementById("flow-room-code"),
    flowJoinRoom: document.getElementById("flow-join-room"),
    flowMatchmaker: document.getElementById("flow-matchmaker"),
    flowRoomTitle: document.getElementById("flow-room-title"),
    flowRoomStatus: document.getElementById("flow-room-status"),
    flowRoomCodeText: document.getElementById("flow-room-code-text"),
    flowCopyLink: document.getElementById("flow-copy-link"),
    flowRoomCancel: document.getElementById("flow-room-cancel"),
    flowStartAi: document.getElementById("flow-start-ai"),
    flowBack: document.getElementById("flow-back"),
  };
  const screenEl = canvas.parentElement;
  if (globalThis.__SIM_HOOK__ && typeof globalThis.__SIM_HOOK__.onWorld === "function") {
    try {
      globalThis.__SIM_HOOK__.onWorld(world);
    } catch {
      // Keep runtime resilient if the hook throws.
    }
  }

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = (screenEl ?? canvas).getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    world.viewWidth = canvas.width;
    world.viewHeight = canvas.height;
  }

  resize();
  window.addEventListener("resize", resize);

  // Spawn two agents in distinct locations (avoid "only one agent" confusion).
  const a = makeAgent("A", world, world.width * 0.30, world.height * 0.62, "#5a83ff");
  const b = makeAgent("B", world, world.width * 0.70, world.height * 0.42, "#ff7a5f");
  applyMbtiProfile(a, a.mbti);
  applyMbtiProfile(b, b.mbti);
  world.agents = [a, b];

  // Initial hidden HP beliefs: both assume opponent is near full, uncertain.
  a.belief.opponentHp.mean = 92;
  a.belief.opponentHp.var = 28 * 28;
  b.belief.opponentHp.mean = 92;
  b.belief.opponentHp.var = 28 * 28;

  // Spawn juggernaut away from both.
  world.juggernaut = makeJuggernaut(world, world.width * 0.50, world.height * 0.20);

  world.terminalLog = false;
  initFlowUi(world);

  const rt = world.runtime;

  function inPlayerMode() {
    return rt.appMode === "player";
  }

  function inActivePlayerMatch() {
    return inPlayerMode() && rt.match?.started && (rt.playState === "host" || rt.playState === "guest");
  }

  function usesLockstepNet() {
    return inPlayerMode() && rt.match?.mode === "pvp" && isLockstepPvp(world);
  }

  async function triggerAbility(slotName) {
    const controlledId = world.player.controlledId ?? "A";
    const agent = getAgent(world, controlledId);
    if (!agent) return;
    const slotKey = slotName === "secondary" ? "secondary" : "primary";
    const eventType = slotKey === "secondary" ? "abilitySecondary" : "abilityPrimary";
    const hobbySpec = getHobbySpec(agent.hobby?.id);
    const chosenAbility = getAbilitySlot(hobbySpec, slotKey);
    const abilityPayload = chosenAbility?.id ? { abilityId: chosenAbility.id } : {};
    if (usesLockstepNet()) {
      scheduleLocalLockstepAction(world, eventType, abilityPayload, { extraLeadTicks: NET_ABILITY_EXTRA_LEAD_TICKS });
      return;
    }
    if (inPlayerMode() && rt.match?.mode === "pvp" && rt.playState === "guest") {
      // Snapshot fallback for legacy guest sync path.
      tryCastHobbyAbility(world, agent, slotName, true);
      await sendRoomAction(world, eventType, abilityPayload);
      return;
    }
    tryCastHobbyAbility(world, agent, slotName, true);
  }

  async function submitTapCommand(x, y) {
    const controlledId = world.player.controlledId ?? "A";
    const agent = getAgent(world, controlledId);
    if (!agent) return;
    if (usesLockstepNet()) {
      scheduleLocalLockstepAction(world, "tap", { x, y });
      return;
    }
    if (inPlayerMode() && rt.match?.mode === "pvp" && rt.playState === "guest") {
      // Snapshot fallback for legacy guest sync path.
      assignPlayerCommand(world, agent, x, y);
      await sendRoomAction(world, "tap", { x, y });
      return;
    }
    assignPlayerCommand(world, agent, x, y);
  }

  // Ability buttons for player-controlled agent (A by default).
  if (world.ui?.btnP) {
    world.ui.btnP.addEventListener("click", () => {
      void triggerAbility("primary");
    });
  }
  if (world.ui?.btnS) {
    world.ui.btnS.addEventListener("click", () => {
      void triggerAbility("secondary");
    });
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (inPlayerMode() && !inActivePlayerMatch()) return;
    const p = worldToCanvas(world, e.clientX, e.clientY);
    if (rt.appMode === "developer" && e.shiftKey) {
      world.juggernaut.x = clamp(p.x, world.juggernaut.r, world.width - world.juggernaut.r);
      world.juggernaut.y = clamp(p.y, world.juggernaut.r, world.height - world.juggernaut.r);
      world.juggernaut.atkCdUntil = world.time + 0.25;
    } else {
      if (appendPlayerDrawPoint(world, e.pointerId, p.x, p.y, true)) {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // Ignore capture failures on unsupported devices.
        }
        return;
      }
      void submitTapCommand(p.x, p.y);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!world.player?.drawFire) return;
    const p = worldToCanvas(world, e.clientX, e.clientY);
    appendPlayerDrawPoint(world, e.pointerId, p.x, p.y, false);
  });

  function endDrawPointer(pointerId) {
    const draw = world.player?.drawFire;
    if (!draw) return;
    if (draw.pointerId !== pointerId) return;
    finalizePlayerDrawFire(world, "release");
  }

  canvas.addEventListener("pointerup", (e) => {
    endDrawPointer(e.pointerId);
  });
  canvas.addEventListener("pointercancel", (e) => {
    endDrawPointer(e.pointerId);
  });

  window.addEventListener("keydown", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    world.player.keysDown.add(key);

    if (!e.repeat && key === "0") {
      toggleAppMode(world);
      e.preventDefault();
      return;
    }

    if (rt.appMode === "player") {
      if (key === "h") {
        if (e.repeat) return;
        const slot = e.shiftKey ? "secondary" : "primary";
        void triggerAbility(slot);
        e.preventDefault();
      }
      return;
    }

    if (!e.repeat && e.shiftKey && (key === "a" || key === "b")) {
      const ag = getAgent(world, key.toUpperCase());
      if (ag) switchAgentMbti(world, ag, 1);
      e.preventDefault();
      return;
    }

    if (key === "h") {
      if (e.repeat) return;
      const hasA = world.player.keysDown.has("a");
      const hasB = world.player.keysDown.has("b");
      const agA = getAgent(world, "A");
      const agB = getAgent(world, "B");
      if (hasA && !hasB) {
        switchAgentHobby(world, agA, 1);
      } else if (hasB && !hasA) {
        switchAgentHobby(world, agB, 1);
      } else if (hasA && hasB) {
        switchAgentHobby(world, agA, 1);
        switchAgentHobby(world, agB, 1);
      } else {
        const playerAgent = getAgent(world, world.player.controlledId ?? "A");
        if (playerAgent) {
          const spec = getHobbySpec(playerAgent.hobby?.id);
          const wantsSecondary = Boolean(e.shiftKey && spec.secondary);
          void triggerAbility(wantsSecondary ? "secondary" : "primary");
        }
      }
      e.preventDefault();
      return;
    }

    if (key === "d") world.debug = !world.debug;
    if (key === "k" || key === "?") world.showHelp = !world.showHelp;
    if (key === "l") world.terminalLog = !world.terminalLog;
  });
  window.addEventListener("keyup", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    world.player.keysDown.delete(key);
  });
  window.addEventListener("blur", () => {
    world.player.keysDown.clear();
  });
  function requestResumeResync(reason) {
    if (!isLockstepPvp(world)) return;
    const rt = world.runtime;
    const net = rt?.net;
    if (!net || rt.playState !== "guest") return;
    const nowWall = performance.now() * 0.001;
    if (nowWall < finiteOr(net.resumeResyncCooldownUntil, 0)) return;
    net.resumeResyncCooldownUntil = nowWall + 0.25;
    rt.simAccumulator = 0;
    net.resumeResyncPending = true;
    net.resumeResyncNeedFreshFrame = true;
    net.resumeResyncBaselineFrameSeq = Math.max(0, Math.round(finiteOr(net.frameSince, 0)));
    if (!net.bundlePullBusy) void pullRoomBundleOnce(world, reason, true);
  }
  document.addEventListener("visibilitychange", () => {
    const net = world.runtime?.net;
    if (document.visibilityState === "hidden") {
      if (net && world.runtime?.playState === "guest") net.backgroundResumeNeeded = true;
      return;
    }
    if (document.visibilityState === "visible" && net?.backgroundResumeNeeded) {
      net.backgroundResumeNeeded = false;
      requestResumeResync("visibility");
    }
  });
  window.addEventListener("focus", () => {
    const net = world.runtime?.net;
    if (net?.backgroundResumeNeeded) {
      net.backgroundResumeNeeded = false;
      requestResumeResync("focus");
    }
  });
  window.addEventListener("pageshow", () => {
    const net = world.runtime?.net;
    if (net?.backgroundResumeNeeded) {
      net.backgroundResumeNeeded = false;
      requestResumeResync("pageshow");
    }
  });

  let last = performance.now();
  function frame(nowMs) {
    const dt = Math.min(0.05, Math.max(0.001, (nowMs - last) / 1000));
    last = nowMs;
    try {
      if (rt.appMode === "player" && rt.playState === "menu") {
        updateUi(world);
        drawWorld(world);
        requestAnimationFrame(frame);
        return;
      }

      if (rt.appMode === "player" && rt.playState === "guest" && !isLockstepPvp(world)) {
        updateGuestNetView(world);
        updateUi(world);
        drawWorld(world);
        requestAnimationFrame(frame);
        return;
      }

      if (rt.appMode === "player" && rt.roundEnd?.active) {
        world.time += dt;
        maybeSyncRoundEnd(world);
        updateRoundEndFlow(world);
        updateUi(world);
        drawWorld(world);
        requestAnimationFrame(frame);
        return;
      }

      if (isLockstepPvp(world)) {
        const net = rt.net;
        const nowPerfSec = performance.now() * 0.001;
        if (isFiniteNumber(net.startAtPerfSec) && nowPerfSec < net.startAtPerfSec) {
          ingestPendingLockstepInputs(world);
          updateUi(world);
          drawWorld(world);
          requestAnimationFrame(frame);
          return;
        }
        net.localTick = rt.simTick;
        ingestPendingLockstepInputs(world);
        maybeLockstepHardResync(world);
        if (isFiniteNumber(net.rollbackTick)) runLockstepRollback(world, rt.simTick);
        net.localTick = rt.simTick;
        rt.simAccumulator = Math.min(
          rt.simAccumulator + dt,
          net.stepDt * Math.max(2, finiteOr(net.maxCatchupSteps, NET_SMOOTHNESS_BUDGET.maxCatchupStepsPerFrame) * 2),
        );
        let steps = 0;
        while (rt.simAccumulator >= net.stepDt && steps < net.maxCatchupSteps) {
          net.history.set(rt.simTick, captureLockstepState(world, rt.simTick));
          world.time += net.stepDt;
          const previousRandomSource = ACTIVE_RANDOM_SOURCE;
          ACTIVE_RANDOM_SOURCE = () => nextSimulationRandom(world);
          try {
            applyLockstepInputsForTick(world, rt.simTick);
            simulateGameplayStep(world, net.stepDt);
          } finally {
            ACTIVE_RANDOM_SOURCE = previousRandomSource;
          }
          updateRoundEndFlow(world);
          rt.simTick += 1;
          net.localTick = rt.simTick;
          rt.simAccumulator -= net.stepDt;
          steps += 1;
        }
        maybeApplyAuthoritativeFrameAssist(world);
        pruneLockstepBuffers(world);
      } else {
        world.time += dt;
        updateRoundEndFlow(world);
        if (rt.appMode === "player" && rt.playState === "host" && rt.net?.mode === "pvp") {
          const events = rt.net.pendingEvents.splice(0);
          for (const ev of events) {
            if (!ev || !ev.seat) continue;
            applyIncomingAction(world, ev.seat, ev);
          }
        }
        simulateGameplayStep(world, dt);
      }

      if (globalThis.__SIM_HOOK__ && typeof globalThis.__SIM_HOOK__.onFrame === "function") {
        try {
          globalThis.__SIM_HOOK__.onFrame(world, dt);
        } catch {
          // Keep runtime resilient if the hook throws.
        }
      }

      updateUi(world);

      maybeQueueNetDebugSample(world);
      flushNetDebugQueue(world);

      // Render.
      drawWorld(world);

      // Terminal log.
      void maybeSendTerminalLog(world);

      requestAnimationFrame(frame);
    } catch (err) {
      console.error("Frame loop error (recovered):", err);
      try {
        const net = world.runtime?.net;
        if (isLockstepPvp(world) && world.runtime?.playState === "guest" && net) {
          net.resumeResyncPending = true;
          net.resumeResyncNeedFreshFrame = true;
          net.resumeResyncBaselineFrameSeq = Math.max(0, Math.round(finiteOr(net.frameSince, 0)));
          if (!net.bundlePullBusy) void pullRoomBundleOnce(world, "frame_error", true);
        }
      } catch {
        // Keep UI alive even if recovery scheduling fails.
      }
      updateUi(world);
      drawWorld(world);
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

setup();
