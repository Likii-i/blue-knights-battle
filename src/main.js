// MBTI Fighters v1.3
// Two ENFP-ish agents + a deadly juggernaut. Decisions are damage-driven with
// short commit windows, hidden opponent HP estimates (for bluffing), and a
// terminal debug stream via dev-server.js (POST /_debug_log).

const TAU = Math.PI * 2;

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
function normalize(x, y) {
  const len = hypot(x, y);
  if (len < 1e-9) return { x: 0, y: 0, len: 0 };
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
  return min + Math.random() * (max - min);
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

function turnToward(agent, desiredAngle, turnRateRadSec, dt) {
  const diff = angleDiff(agent.heading, desiredAngle);
  const maxStep = Math.max(0, turnRateRadSec) * dt;
  agent.heading = wrapAngle(agent.heading + clamp(diff, -maxStep, maxStep));
}

function randNormal() {
  // Box-Muller transform
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
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
  let r = Math.random() * sum;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i].id;
  }
  return options[options.length - 1]?.id ?? null;
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

function makeWorld(canvas) {
  return {
    canvas,
    ctx: canvas.getContext("2d", { alpha: false }),
    width: 0,
    height: 0,
    time: 0,
    debug: false,
    showHelp: true,
    terminalLog: true,
    logIntervalMs: 500,
    _lastLogAt: 0,
    _logDisabledReason: "",
    juggernaut: null,
    agents: [],
  };
}

function makeAgent(id, world, x, y, color) {
  return {
    id,
    color,
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

    hp: 100,
    maxHp: 100,
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
    scene: {
      id: "RESET", // RESET | DUEL | SCRAMBLE | ESCAPE | FINISH
      until: 0,
      startedAt: 0,
    },
    plan: {
      current: "OPEN_UP",
      next: "-",
      confidence: 0,
      plannedAt: -Infinity,
    },
    nav: {
      target: null, // {x,y} cached for the current commit (prevents per-frame jitter)
      validUntil: 0,
      seed: 0,
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

  const jDist = j ? hypot(j.x - agent.x, j.y - agent.y) : Infinity;
  const jVis = j ? (jDist < 420 && inFov(agent, j.x, j.y)) : false;
  const jAng = j ? angleTo(j.x - agent.x, j.y - agent.y) : 0;
  const jPer =
    j
      ? (!jVis &&
        jDist < perR &&
        Math.abs(angleDiff(agent.heading, jAng)) < (115 * Math.PI) / 180)
      : false;
  const jHear = j ? (!jVis && !jPer && jDist < hearR) : false;
  s.jug.dist = jDist;
  s.jug.visible = jVis;
  s.jug.peripheral = jPer || jHear;
  s.jug.heard = jHear;
  // Only vision/peripheral refresh precise position. "Hearing" keeps you aware but uncertain,
  // which creates a real incentive to look back for confirmation.
  if (jVis || jPer) {
    s.jug.lastSeenAt = now;
    s.jug.lastSeenPos = { x: j.x, y: j.y };
  }

  const age = Math.max(0, now - s.jug.lastSeenAt);
  s.jug.uncertainty = j ? clamp01(age / 3.2) : 0;

  // Belief: if we don't see it, we only have an increasingly-wrong estimate.
  if (!j) {
    s.jug.beliefPos = null;
    s.jug.beliefDist = Infinity;
    s.jug.quality = 0;
  } else if (jVis) {
    s.jug.beliefPos = { x: j.x, y: j.y };
    s.jug.beliefDist = jDist;
    s.jug.quality = 1;
  } else if (jPer && s.jug.lastSeenPos) {
    s.jug.beliefPos = { x: s.jug.lastSeenPos.x, y: s.jug.lastSeenPos.y };
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = 0.75;
  } else if (jHear && s.jug.lastSeenPos) {
    // Heard: position is stale; uncertainty rises quickly.
    const drift = 10 + age * 40;
    const ox = ouStep((s.jug._ox ?? 0), dt, 0.55, drift);
    const oy = ouStep((s.jug._oy ?? 0), dt, 0.55, drift);
    s.jug._ox = ox;
    s.jug._oy = oy;
    s.jug.beliefPos = {
      x: clamp(s.jug.lastSeenPos.x + ox, 0, world.width),
      y: clamp(s.jug.lastSeenPos.y + oy, 0, world.height),
    };
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = 0.38;
  } else if (s.jug.lastSeenPos && age < 4.5) {
    const drift = 14 + age * 55;
    const ox = ouStep((s.jug._ox ?? 0), dt, 0.7, drift);
    const oy = ouStep((s.jug._oy ?? 0), dt, 0.7, drift);
    s.jug._ox = ox;
    s.jug._oy = oy;
    s.jug.beliefPos = {
      x: clamp(s.jug.lastSeenPos.x + ox, 0, world.width),
      y: clamp(s.jug.lastSeenPos.y + oy, 0, world.height),
    };
    s.jug.beliefDist = hypot(agent.x - s.jug.beliefPos.x, agent.y - s.jug.beliefPos.y);
    s.jug.quality = clamp01(0.55 * Math.exp(-age / 2.2));
  } else {
    s.jug.beliefPos = null;
    s.jug.beliefDist = Infinity;
    s.jug.quality = 0;
  }

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

  const meleeReach = 10;
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
  if ((jugWindingForMe || perceivedTell) && dJ < jugHitRange + 70) return true;
  return false;
}

function getAgent(world, id) {
  return world.agents.find((a) => a.id === id) ?? null;
}

function jugPickTarget(world) {
  const j = world.juggernaut;
  const alive = getAliveAgents(world);
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

  if (now >= j.agenda.modeUntil) {
    const r = Math.random();
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
  const speed = winding ? j.speed * 0.45 : j.speed;
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
      const canHear = !canSee && !canPer && dd < hear && Math.random() < 0.35;
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
    if (Math.random() < chance) {
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
  const base = 210 + 160 * lethal;
  const lowHpExtra = 220 * (1 - hpN);
  // v1.3 combat needs more standoff distance to feel like "running away correctly".
  return clamp(base + lowHpExtra, 210, 520);
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
  const meleeReach = 10;
  const hitRange = agent.r + opp.r + meleeReach;
  const d = hypot(candTarget.x - opp.x, candTarget.y - opp.y);
  // Very coarse: if you end up in range, assume moderate chance of being hit soon.
  const p = d < hitRange ? 0.85 : d < hitRange * 1.6 ? 0.35 : 0.08;
  return mean * p;
}

function predictDealDamage(agent, opp, candTarget) {
  if (!opp || opp.hp <= 0) return 0;
  const meleeReach = 10;
  const hitRange = agent.r + opp.r + meleeReach;
  const d = hypot(candTarget.x - opp.x, candTarget.y - opp.y);
  const p = d < hitRange ? 0.9 : d < hitRange * 1.4 ? 0.25 : 0.05;
  return agent.belief.oppDamage.mean * p;
}

function applyDamage(world, victim, source, dmg, knockback, hitstun) {
  const now = world.time;
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

  if (blocking) {
    const t = now - (victim.blockRaisedAt ?? -Infinity);
    let bd = 1.0;
    let bk = 1.0;
    // Strongest if raised shortly before impact.
    if (t < 0.12) {
      bd = 0.35;
      bk = 0.45;
    } else if (t < 0.22) {
      bd = 0.5;
      bk = 0.55;
    } else {
      bd = 0.72;
      bk = 0.75;
    }
    dmgScale *= bd;
    kbScale *= bk;
  }

  const dealt = Math.max(0, dmg * dmgScale);
  victim.hp = Math.max(0, victim.hp - dealt);
  victim.hitstunUntil = Math.max(victim.hitstunUntil, now + hitstun);
  victim.events.gotHitAt = now;
  if (dealt > victim.maxHp * 0.18) victim.events.tookBigHitAt = now;

  const away = normalize(victim.x - source.x, victim.y - source.y);
  victim.vx += away.x * knockback * kbScale;
  victim.vy += away.y * knockback * kbScale;

  // Learning: victim learns exact incoming damage for that source type.
  if (source.kind === "JUG") {
    const rate = victim.hp > 0 ? 0.28 : 0.45;
    victim.belief.jugDamage.mean = learnedEma(victim.belief.jugDamage.mean, dealt, rate);
    victim.belief.jugDamage.var = learnedEma(victim.belief.jugDamage.var, (dealt - victim.belief.jugDamage.mean) ** 2, 0.2);
  } else if (source.kind === "AGENT") {
    victim.belief.oppDamage.mean = learnedEma(victim.belief.oppDamage.mean, dealt, 0.22);
    victim.belief.oppDamage.var = learnedEma(victim.belief.oppDamage.var, (dealt - victim.belief.oppDamage.mean) ** 2, 0.2);
  }

  // Trap learning: getting hit near walls is a "trap spot".
  const c = clearance(world, victim.x, victim.y);
  if (c < 70) {
    upsertSpot(victim.mem.trapSpots, { x: victim.x, y: victim.y, score: (80 - c) * 1.2, lastAt: now }, 95);
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

function pickPosture(agent, tactic) {
  const hpN = clamp01(agent.hp / agent.maxHp);
  let p = "NEUTRAL";
  if (tactic === "ATTACK" || tactic === "PRESSURE" || tactic === "CLASH") p = "AGGRO";
  else if (tactic === "RETREAT_LONG" || tactic === "OPEN_UP" || tactic === "RESET") p = "DEFENSIVE";
  else if (tactic === "BLOCK") p = "DEFENSIVE";

  // Bluff: sometimes act bold while weak.
  if (hpN < 0.35 && Math.random() < 0.35) p = "AGGRO";
  return p;
}

function tacticTarget(world, agent, opp, j, tactic, rng) {
  const now = world.time;
  const r = agent.r;
  const center = { x: world.width * 0.5, y: world.height * 0.5 };
  const toOpp = normalize(opp.x - agent.x, opp.y - agent.y);
  const fighting = tactic === "ATTACK" || tactic === "PRESSURE" || tactic === "CLASH";
  const noticedJug = now - agent.events.jugWindupSeenAt < 0.55 || agent.senses.jug.visible || agent.senses.jug.peripheral;
  const respectJug = !fighting || noticedJug || agent.senses.jug.quality > 0.75;
  const jugPos = j && respectJug
    ? (agent.senses.jug.beliefPos ? agent.senses.jug.beliefPos : { x: j.x, y: j.y })
    : null;
  const awayJ = jugPos ? normalize(agent.x - jugPos.x, agent.y - jugPos.y) : { x: 0, y: 0, len: 0 };
  const hereC = clearance(world, agent.x, agent.y);

  const safeDistJ = desiredSafeDistToJug(agent);
  const dJ = jugPos ? hypot(agent.x - jugPos.x, agent.y - jugPos.y) : Infinity;

  // If we're charging/holding garrison, bias movement toward a pre-chosen open anchor spot.
  const garrisoning = (agent.stance?.chargingTo === "GARRISON") || stanceIsActive(agent, "GARRISON", now);
  if (garrisoning && agent.stance?.anchor) {
    const a = agent.stance.anchor;
    const dist = hypot(a.x - agent.x, a.y - agent.y);
    if (tactic === "RETREAT_LONG" || tactic === "OPEN_UP" || tactic === "RESET") {
      // Travel to anchor, then "hover" there with small recenter bias.
      if (dist > 38) return { x: a.x, y: a.y };
      const aa = angleTo(center.x - agent.x, center.y - agent.y);
      return pickOpenTarget(world, agent, aa, 70, 130, rng);
    }
    if (tactic === "BLOCK") {
      // Hold near anchor while defending.
      if (dist > 32) return { x: a.x, y: a.y };
    }
  }

  if (tactic === "CLASH") {
    // Stay in the same general spot and trade—small sidesteps around the opponent.
    // This is the "fight scene" beat where they don't instantly kite to an edge.
    const rr = 70;
    const side = agent.id === "A" ? 1 : -1;
    const ox = -toOpp.y * side;
    const oy = toOpp.x * side;
    // Blend a bit toward center so we don't drift into corners during repeated exchanges.
    const blend = normalize(ox * 0.85 + (center.x - agent.x) * 0.0009, oy * 0.85 + (center.y - agent.y) * 0.0009);
    const tx = clamp(opp.x + blend.x * rr, r, world.width - r);
    const ty = clamp(opp.y + blend.y * rr, r, world.height - r);
    return { x: tx, y: ty };
  }

  if (tactic === "RESET") {
    const a = angleTo(center.x - agent.x, center.y - agent.y);
    return pickOpenTarget(world, agent, a, 220, 320, rng);
  }

  function pickEscapeLane(distMin, distMax) {
    // Like pickOpenTarget but explicitly rewards *increasing* distance to jug and staying radial.
    const rand = typeof rng === "function" ? rng : Math.random;
    const base = jugPos ? angleTo(awayJ.x, awayJ.y) : angleTo(center.x - agent.x, center.y - agent.y);
    const centerA = angleTo(center.x - agent.x, center.y - agent.y);
    const offsets = [-110, -80, -55, -30, -15, 0, 15, 30, 55, 80, 110];

    const dJ0 = jugPos ? hypot(agent.x - jugPos.x, agent.y - jugPos.y) : 0;
    const c0 = hereC;

    let best = null;
    for (const od of offsets) {
      const a = base + (od * Math.PI) / 180;
      const L = distMin + (distMax - distMin) * rand();
      const cx = clamp(agent.x + Math.cos(a) * L, r, world.width - r);
      const cy = clamp(agent.y + Math.sin(a) * L, r, world.height - r);
      const c = clearance(world, cx, cy);
      const avgC = avgClearanceAlong(world, agent.x, agent.y, cx, cy, 4);

      let score = 0;
      score += c * 2.6 + avgC * 1.6;
      // Prefer recentering if cramped.
      score += clamp01((150 - c0) / 150) * 140 * Math.cos(angleDiff(a, centerA));

      if (jugPos) {
        const dJ = hypot(cx - jugPos.x, cy - jugPos.y);
        const dir = normalize(cx - agent.x, cy - agent.y);
        const radial = dot(dir.x, dir.y, awayJ.x, awayJ.y);
        const tang = Math.abs(cross2(dir.x, dir.y, awayJ.x, awayJ.y));
        score += clamp(dJ - dJ0, -100, 260) * 1.4;
        score -= clamp01(0.15 - radial) * 520;
        score -= clamp01(tang - 0.72) * 260;
      }

      // Strongly avoid ending near walls/corners.
      if (c < 95) score -= (95 - c) * (95 - c) * 0.22;

      const dir = normalize(cx - agent.x, cy - agent.y);
      score -= oscillationPenalty(agent, dir.x, dir.y) * 0.55;

      if (!best || score > best.score) best = { x: cx, y: cy, score };
    }
    return best ?? { x: world.width * 0.5, y: world.height * 0.5 };
  }

  if (tactic === "OPEN_UP") return pickEscapeLane(300, 440);
  if (tactic === "RETREAT_LONG") return pickEscapeLane(360, 520);
  if (tactic === "RETREAT_SHORT") return pickEscapeLane(190, 280);

  if (tactic === "BLOCK") {
    // Slight nudge away from jug if too close; otherwise hold.
    if (j && dJ < safeDistJ * 0.75) {
      const a = angleTo(awayJ.x, awayJ.y);
      return {
        x: clamp(agent.x + Math.cos(a) * 70, r, world.width - r),
        y: clamp(agent.y + Math.sin(a) * 70, r, world.height - r),
      };
    }
    return { x: agent.x, y: agent.y };
  }

  if (tactic === "PRESSURE") {
    // Approach opponent. If we aren't respecting the jug (tunnel vision), don't bake jug-avoidance in.
    const aMul = respectJug ? 0.65 : 0.15;
    const blend = normalize(toOpp.x * 1.0 + awayJ.x * aMul, toOpp.y * 1.0 + awayJ.y * aMul);
    const a = angleTo(blend.x, blend.y);
    return pickOpenTarget(world, agent, a, 160, 260, rng);
  }

  // ATTACK: if safe enough, step into range; else behave like pressure/short retreat.
  const meleeReach = 10;
  const hitRange = agent.r + opp.r + meleeReach;
  const dO = hypot(opp.x - agent.x, opp.y - agent.y);
  const wantClose = dO > hitRange * 0.95;
  const tooCloseToJug = j && dJ < safeDistJ * 0.72;

  if (tooCloseToJug) {
    const base = angleTo(awayJ.x, awayJ.y);
    return pickOpenTarget(world, agent, base, 160, 260, rng);
  }

  if (wantClose) {
    const aMul = respectJug ? 0.35 : 0.1;
    const blend = normalize(toOpp.x * 1.1 + awayJ.x * aMul, toOpp.y * 1.1 + awayJ.y * aMul);
    const a = angleTo(blend.x, blend.y);
    return pickOpenTarget(world, agent, a, 120, 220, rng);
  }

  return { x: agent.x, y: agent.y };
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

  const jugQ = j ? agent.senses.jug.quality : 0;
  const dJ = j ? agent.senses.jug.beliefDist : Infinity;
  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const hereC = clearance(world, agent.x, agent.y);

  const meleeReach = 10;
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
  const oppSeenBeat = agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 240;
  const jugSeenRecently = agent.senses.jug.visible || agent.senses.jug.peripheral || now - agent.senses.jug.lastSeenAt < 0.8;
  const gotHitRecently = now - agent.events.gotHitAt < 0.45;
  const gotJugHitRecently = now - agent.events.gotHitAt < 0.8 && agent.thought.includes("JUG HIT");

  function setScene(id, durMin, durMax) {
    if (agent.scene.id === id && now < agent.scene.until) return;
    agent.scene.id = id;
    agent.scene.startedAt = now;
    agent.scene.until = now + randRange(durMin, durMax);
  }

  if (gotJugHitRecently) setScene("SCRAMBLE", 1.2, 1.9);
  else if (imminentJug && jugSeenRecently) setScene("ESCAPE", 0.9, 1.6);
  else if (finishP > 0.48 && oppSeenBeat && (!j || dJ > safeDistEff * 1.15)) setScene("FINISH", 0.9, 1.6);
  else if (now >= agent.scene.until) {
    if (oppSeenBeat && (!j || dJ > safeDistEff * 1.25)) setScene("DUEL", 1.6, 3.1);
    else setScene("RESET", 0.9, 1.8);
  }

  // Deterministic RNG for this decision: stable candidate targets within the commit.
  const bucket = Math.floor(now * 2); // 500ms buckets
  const seed = (hashSeed(`${agent.id}|${bucket}|${Math.round(agent.hp)}|${agent.tactic}`) ^ 0x9e3779b9) >>> 0;
  const rng = makeRng(seed);

  const candidates = [];
  const scene = agent.scene.id;
  const blockAllowed = isBlockJustified(world, agent, opp, j) && now >= (agent.blockCooldownUntil ?? 0);
  for (const id of TACTICS) {
    // Scene-based option gating to create readable "beats".
    if (scene === "DUEL" && (id === "RETREAT_LONG" || id === "OPEN_UP")) continue;
    if (scene === "SCRAMBLE" && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) continue;
    if (scene === "ESCAPE" && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) continue;
    if (scene === "FINISH" && (id === "RETREAT_LONG" || id === "OPEN_UP")) continue;
    if (scene === "RESET" && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) {
      if (!(agent.senses.opp.visible || agent.senses.opp.peripheral || dO < 220)) continue;
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
    if (id === "BLOCK" && agent.hitstunUntil <= now && !blockAllowed) continue;

    const target = tacticTarget(world, agent, opp, j, id, rng);
    const dir = normalize(target.x - agent.x, target.y - agent.y);

    let predSelfJ = predictJugDamage(now, agent, j, target, 1.1);
    // Reduced juggernaut awareness: if you haven't actually seen it, you underweight its danger.
    const awareMul = clamp(0.25 + jugQ * 0.75, 0.25, 1);
    predSelfJ *= awareMul;
    if ((id === "ATTACK" || id === "PRESSURE") && !(agent.senses.jug.visible || perceivedWindup)) {
      // Tunnel vision while fighting: until you notice the tell/hit, you don't fully respect the jug.
      predSelfJ *= 0.65;
    }
    const predSelfO = predictOppDamage(agent, opp, target);
    const predOpp = predictDealDamage(agent, opp, target);

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

    // If within melee range, ATTACK has extra value.
    if (id === "ATTACK" && dO < hitRange * 1.05) score += 320;
    if (id === "PRESSURE" && dO > hitRange * 1.4) score += 140;
    if (id === "CLASH" && dO < 160) score += 230;

    // Engage bias: if jug is far and the opponent is visible/nearby, humans tend to close.
    const oppSeen = agent.senses?.opp?.visible || agent.senses?.opp?.peripheral || dO < 220;
    const jugFar = !j || dJ > safeDistEff * 1.35;
    if (oppSeen && jugFar) {
      if (id === "PRESSURE" || id === "ATTACK") score += 180;
      if (id === "RETREAT_LONG" || id === "OPEN_UP") score -= 120;
    }

    // Scene flavor.
    if (scene === "DUEL") {
      if (id === "CLASH") score += 160;
      if (id === "RESET") score += 40;
      if ((id === "ATTACK" || id === "PRESSURE" || id === "CLASH") && !perceivedWindup && !gotHitRecently) score += 60;
    } else if (scene === "SCRAMBLE") {
      if (id === "RETREAT_LONG" || id === "OPEN_UP") score += 220;
      if (id === "BLOCK") score += 80;
    } else if (scene === "FINISH") {
      if (id === "ATTACK" || id === "PRESSURE") score += 160;
    }

    // If imminent jug hit, BLOCK is often best.
    if (id === "BLOCK" && imminentJug) score += 260;

    // Stance scoring.
    if ((garrisonActive || garrisonCharging) && (id === "OPEN_UP" || id === "RETREAT_LONG" || id === "RESET")) score += 120;
    if ((garrisonActive || garrisonCharging) && id === "BLOCK") score += imminentJug ? 200 : 110;
    if (assaultActive && (id === "ATTACK" || id === "PRESSURE" || id === "CLASH")) score += 160;

    // Oscillation penalty to stop ping-pong loops.
    score -= oscillationPenalty(agent, dir.x, dir.y);

    score += pinnedBonus;

    candidates.push({ id, score, target, predSelfJ, predSelfO, predOpp });
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
  if (chosen.id === "BLOCK") {
    // BLOCK is a short, reactive commit (prevents multi-second freezing).
    dur = clamp(randRange(0.18, imminentJug ? 0.58 : 0.42), 0.16, 0.65);
  }
  agent.commitUntil = now + dur;
  agent.tactic = chosen.id;
  agent.posture = pickPosture(agent, chosen.id);
  agent.events.lastDecisionAt = now;

  // Cache commit target to prevent per-frame re-sampling jitter.
  agent.nav.target = chosen.target;
  agent.nav.validUntil = agent.commitUntil;
  agent.nav.seed = seed;

  agent.lastEval.predSelfJ = chosen.predSelfJ;
  agent.lastEval.predSelfO = chosen.predSelfO;
  agent.lastEval.predOpp = chosen.predOpp;

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
      ` | next=${agent.plan.next}` +
      (parts.length ? ` | ${parts.join(", ")}` : "") +
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
  if (chosen.id === "ATTACK" && !imminentJug && Math.random() < 0.14 && dO < hitRange * 1.5) {
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
  const dir = normalize(tgt.x - agent.x, tgt.y - agent.y);

  const moveAngle = dir.len > 1e-6 ? wrapAngle(angleTo(dir.x, dir.y)) : agent.heading;
  const gaze = chooseGazeTarget(world, agent, opp, j, moveAngle, dt);

  // Turn-rate limited gaze (prevents snapping / buzzing).
  if (Number.isFinite(gaze.angle)) {
    const turnRate = ((agent.tactic === "ATTACK" ? 200 : 150) * Math.PI) / 180;
    turnToward(agent, gaze.angle, turnRate, dt);
  }

  let speed = agent.maxSpeed;
  const garrisonActive = stanceIsActive(agent, "GARRISON", now);
  const assaultActive = stanceIsActive(agent, "ASSAULT", now);

  if (agent.tactic === "BLOCK") speed *= 0.35;
  if (agent.tactic === "RETREAT_LONG") speed *= 1.05;
  if (agent.tactic === "RETREAT_SHORT") speed *= 0.95;
  if (agent.tactic === "OPEN_UP") speed *= 1.0;
  if (agent.tactic === "RESET") speed *= 0.95;
  if (agent.tactic === "ATTACK") speed *= 0.95;
  if (agent.tactic === "PRESSURE") speed *= 0.9;
  if (agent.tactic === "CLASH") speed *= 0.55;
  if (garrisonActive) speed *= 0.68;
  if (assaultActive) speed *= 1.06;
  // Glancing has a real movement cost (human tradeoff).
  speed *= gaze.speedMul ?? 1;

  // Wall repulsion as a side force. When retreating, push away earlier/stronger so we don't back into corners.
  const retreating =
    agent.tactic === "RETREAT_LONG" || agent.tactic === "RETREAT_SHORT" || agent.tactic === "OPEN_UP";
  const clearN = clamp01((140 - agent.senses.clearance) / 140);
  const repStrength = retreating ? 170 + 220 * clearN : 120 + 80 * clearN;
  const repPad = retreating ? 170 : 110;
  const rep = wallRepulsion(world, agent.x, agent.y, agent.r, repStrength, repPad);

  // If our cached target is dragging us into a corner (clearance collapsing), retarget toward center.
  if (retreating && agent.senses.clearance < 70 && tgt) {
    const tc = clearance(world, tgt.x, tgt.y);
    if (tc < 85) {
      const center = { x: world.width * 0.5, y: world.height * 0.5 };
      agent.nav.target = {
        x: clamp(center.x + (agent.x - center.x) * 0.25, agent.r, world.width - agent.r),
        y: clamp(center.y + (agent.y - center.y) * 0.25, agent.r, world.height - agent.r),
      };
      agent.nav.validUntil = now + 0.35;
    }
  }

  if (dir.len < 1e-6) {
    damp(agent, dt);
  } else {
    // Apply accel penalty by scaling dt inside steerTo (cheaper than threading maxAccel).
    const accelDt = dt * (gaze.accelMul ?? 1);
    steerTo(agent, tgt.x, tgt.y, speed, accelDt, rep.x, rep.y);
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

  // Block effect window: active while tactic is BLOCK (commit-length).
  if (agent.tactic === "BLOCK") agent.blockUntil = Math.max(agent.blockUntil, now + 0.22);

  // Begin an attack windup if we're committing to attack/pressure (unless feinting).
  const wantsAttack = (agent.tactic === "ATTACK" || agent.tactic === "PRESSURE") && now >= agent.feintUntil;
  const meleeReach = 10;
  const hitRange = agent.r + opp.r + meleeReach;
  const dO = hypot(agent.x - opp.x, agent.y - opp.y);
  const preRange = hitRange * 1.25;
  if (
    wantsAttack &&
    now >= agent.atkCdUntil &&
    !(agent.attackWindupUntil > now) &&
    dO <= preRange
  ) {
    let w = randRange(0.12, 0.18);
    if (assaultActive) w *= 0.78;
    if (garrisonActive) w *= 1.12;
    agent.attackWindupUntil = now + w;
    agent.attackWindupTargetId = opp.id;
  }

  return { wantsAttack };
}

function resolveCombat(world, actionsById) {
  const now = world.time;
  const [a, b] = world.agents;
  const j = world.juggernaut;
  if (!a || !b || !j) return;

  // Agent melee (windup -> impact).
  const meleeReach = 10;
  const hitRangeAB = a.r + b.r + meleeReach;

  function resolveMeleeImpact(attacker, victim) {
    if (attacker.hp <= 0 || victim.hp <= 0) return;
    if (!(attacker.attackWindupUntil > 0) || now < attacker.attackWindupUntil) return;
    if (attacker.attackWindupTargetId !== victim.id) return;

    const d = hypot(attacker.x - victim.x, attacker.y - victim.y);
    const dmg = randRange(6, 10);
    if (d <= hitRangeAB) {
      const dealt = applyDamage(
        world,
        victim,
        { kind: "AGENT", x: attacker.x, y: attacker.y },
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
      let cd = randRange(0.65, 0.95);
      if (stanceIsActive(attacker, "ASSAULT", now)) cd *= 0.85;
      if (stanceIsActive(attacker, "GARRISON", now)) cd *= 1.12;
      attacker.atkCdUntil = now + cd;
    } else {
      // Miss still costs time.
      let cd = randRange(0.38, 0.55);
      if (stanceIsActive(attacker, "ASSAULT", now)) cd *= 0.92;
      if (stanceIsActive(attacker, "GARRISON", now)) cd *= 1.1;
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
          { kind: "JUG", x: j.x, y: j.y },
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
        hp: ag.hp,
        x: ag.x,
        y: ag.y,
        mode: ag.tactic, // dev-server prints this as "mode"
        posture: ag.posture,
        stance: {
          id: ag.stance?.id ?? "NEUTRAL",
          chargingTo: ag.stance?.chargingTo ?? null,
          activeLeft: Math.max(0, (ag.stance?.activeUntil ?? 0) - world.time),
          charge: ag.stance?.charge ?? 0,
        },
        blockCdLeft: Math.max(0, (ag.blockCooldownUntil ?? 0) - world.time),
        commitLeft: Math.max(0, ag.commitUntil - world.time),
        dJ: hypot(ag.x - j.x, ag.y - j.y),
        dO: hypot(ag.x - opp.x, ag.y - opp.y),
        predSelfJ: ag.lastEval.predSelfJ,
        predSelfO: ag.lastEval.predSelfO,
        predOpp: ag.lastEval.predOpp,
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

function drawWorld(world) {
  const ctx = world.ctx;
  const w = world.width;
  const h = world.height;
  const [a, b] = world.agents;
  const j = world.juggernaut;

  ctx.fillStyle = "#f6f5f3";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(30, 30, 30, 0.12)";
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
  }

  function drawAgent(agent, losColor) {
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
    if (alpha > 0.05 && agent.thought) {
      const msg = agent.thought.replace(/\s+/g, " ").slice(0, 46);
      ctx.save();
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = `rgba(10,10,10,${(0.12 + 0.62 * alpha).toFixed(3)})`;
      ctx.fillText(msg, agent.x, agent.y - agent.r - 32);
      ctx.restore();
    }
  }

  if (a) drawAgent(a, "rgba(60, 110, 255, 0.045)");
  if (b) drawAgent(b, "rgba(255, 120, 90, 0.040)");

  // HP bars (user-visible truth).
  if (a) drawHpBar(ctx, 18, 22, 220, 12, a.hp / a.maxHp, a.color, `A HP ${Math.round(a.hp)}`);
  if (b) drawHpBar(ctx, w - 18 - 220, 22, 220, 12, b.hp / b.maxHp, b.color, `B HP ${Math.round(b.hp)}`);

  // Debug overlay.
  if (world.debug && a && b && j) {
    ctx.save();
    const lines = [];
    lines.push(`v1.3 | D debug | H help | L terminal log (${world.terminalLog ? "ON" : "OFF"})`);
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
          `dJ=${hypot(ag.x - j.x, ag.y - j.y).toFixed(0)} dO=${hypot(ag.x - opp.x, ag.y - opp.y).toFixed(0)}`,
      );
      lines.push(`  pred: selfJ=${ag.lastEval.predSelfJ.toFixed(1)} selfO=${ag.lastEval.predSelfO.toFixed(1)} deal=${ag.lastEval.predOpp.toFixed(1)}`);
      lines.push(`  scene: ${ag.scene.id} until=${Math.max(0, ag.scene.until - world.time).toFixed(2)}s`);
      lines.push(`  plan: now=${ag.plan.current} next=${ag.plan.next} conf=${ag.plan.confidence.toFixed(2)}`);
      lines.push(`  gaze: ${ag.gaze.mode} glance(urge=${gl.urge.toFixed(2)} act=${glAct.toFixed(2)} cd=${glCd.toFixed(2)})`);
      lines.push(`  stance: ${stanceId} ${stanceCh ? `ch=${stanceCh.toFixed(2)}` : ""}${stanceLeft ? ` act=${stanceLeft.toFixed(2)}s` : ""} blockCd=${blockCd.toFixed(2)}s`);
      lines.push(`  thought: ${ag.thought}`);
      lines.push(`  emotions (pie %): ${slices.map((s) => `${s.id}=${Math.round(s.p * 100)}`).join("  ")}`);
    }

    const boxH = Math.min(h - 20, 16 * (lines.length + 2));
    const boxY = Math.max(14, h - boxH - 14);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(14, boxY, w - 28, boxH);
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

  if (world.showHelp) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(14, 50, 420, 88);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Shift+Click: move juggernaut", 24, 62);
    ctx.fillText("D: toggle debug overlay", 24, 80);
    ctx.fillText("H: toggle help", 24, 98);
    ctx.fillText("L: toggle terminal logging (dev-server.js)", 24, 116);
    ctx.restore();
  }
}

function worldToCanvas(world, clientX, clientY) {
  const rect = world.canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * world.width;
  const y = ((clientY - rect.top) / rect.height) * world.height;
  return { x, y };
}

function setup() {
  const canvas = document.getElementById("world");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing #world canvas");

  const world = makeWorld(canvas);

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssW = Math.floor(window.innerWidth);
    const cssH = Math.floor(window.innerHeight);
    const size = Math.min(cssW, cssH);
    world.width = Math.floor(size * dpr);
    world.height = Math.floor(size * dpr);
    canvas.width = world.width;
    canvas.height = world.height;
  }

  resize();
  window.addEventListener("resize", resize);

  // Spawn two agents in distinct locations (avoid "only one agent" confusion).
  const a = makeAgent("A", world, world.width * 0.30, world.height * 0.62, "#5a83ff");
  const b = makeAgent("B", world, world.width * 0.70, world.height * 0.42, "#ff7a5f");
  world.agents = [a, b];

  // Initial hidden HP beliefs: both assume opponent is near full, uncertain.
  a.belief.opponentHp.mean = 92;
  a.belief.opponentHp.var = 28 * 28;
  b.belief.opponentHp.mean = 92;
  b.belief.opponentHp.var = 28 * 28;

  // Spawn juggernaut away from both.
  world.juggernaut = makeJuggernaut(world, world.width * 0.50, world.height * 0.20);

  canvas.addEventListener("pointerdown", (e) => {
    const p = worldToCanvas(world, e.clientX, e.clientY);
    if (e.shiftKey) {
      world.juggernaut.x = clamp(p.x, world.juggernaut.r, world.width - world.juggernaut.r);
      world.juggernaut.y = clamp(p.y, world.juggernaut.r, world.height - world.juggernaut.r);
      world.juggernaut.atkCdUntil = world.time + 0.25;
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "d" || e.key === "D") world.debug = !world.debug;
    if (e.key === "h" || e.key === "H") world.showHelp = !world.showHelp;
    if (e.key === "l" || e.key === "L") world.terminalLog = !world.terminalLog;
  });

  let last = performance.now();
  function frame(nowMs) {
    const dt = Math.min(0.05, Math.max(0.001, (nowMs - last) / 1000));
    last = nowMs;
    world.time += dt;

    // Update juggernaut.
    updateJuggernaut(world, dt);

    // Perception (gaze-dependent): what each agent can currently see/notice.
    const j = world.juggernaut;
    const [agA, agB] = world.agents;
    if (agA && agB && j) {
      updatePerception(world, agA, agB, j, dt);
      updatePerception(world, agB, agA, j, dt);
    }

    // Stances (garrison/assault): updated continuously, but activation is gated by calm/safety.
    if (agA && agB && j) {
      updateStance(world, agA, agB, j, dt);
      updateStance(world, agB, agA, j, dt);
    }

    // AI decisions (checkpointed).
    if (agA && agB && j) {
      // Reactive interrupts (human-like): re-decide early after key events.
      const meleeReach = 10;
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

      if (world.time >= agA.commitUntil || shouldInterrupt(agA)) decideTactic(world, agA, agB, j);
      if (world.time >= agB.commitUntil || shouldInterrupt(agB)) decideTactic(world, agB, agA, j);
    }

    // Execute + physics.
    const actionsById = Object.create(null);
    if (agA && agB && j) {
      actionsById[agA.id] = executeTactic(world, agA, agB, j, dt);
      actionsById[agB.id] = executeTactic(world, agB, agA, j, dt);
    }

    // Separation after movement.
    if (agA && agB) separate(agA, agB);
    if (agA && j) separateMobileStatic(agA, j);
    if (agB && j) separateMobileStatic(agB, j);

    // Combat resolution.
    resolveCombat(world, actionsById);

    // Emotions (pie chart + debug text).
    if (agA && agB && j) {
      updateEmotions(world, agA, agB, j, dt);
      updateEmotions(world, agB, agA, j, dt);
    }

    // Render.
    drawWorld(world);

    // Terminal log.
    void maybeSendTerminalLog(world);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

setup();
