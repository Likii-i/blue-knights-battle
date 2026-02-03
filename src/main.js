// v1.1: single ENFP-ish agent with committed intents, adaptive forward planning, mixed emotions,
// and pressure-induced mistakes in a blank square world.

const TAU = Math.PI * 2;

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function expSmoothing(dt, tau) {
  // Converts a time constant into a dt-based smoothing factor.
  return 1 - Math.exp(-dt / Math.max(1e-6, tau));
}

function hypot(x, y) {
  return Math.hypot(x, y);
}

function normalize(x, y) {
  const h = hypot(x, y);
  if (h < 1e-9) return { x: 0, y: 0, len: 0 };
  return { x: x / h, y: y / h, len: h };
}

function angleTo(x, y) {
  return Math.atan2(y, x);
}

function wrapAngle(rad) {
  // Wrap to [-pi, pi]
  let a = rad;
  while (a <= -Math.PI) a += TAU;
  while (a > Math.PI) a -= TAU;
  return a;
}

function angleDiff(a, b) {
  // Signed shortest difference a->b
  return wrapAngle(b - a);
}

function dot(ax, ay, bx, by) {
  return ax * bx + ay * by;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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
  // Ornstein-Uhlenbeck process step for temporally-coherent noise.
  const t = Math.max(1e-6, tau);
  const decay = Math.exp(-dt / t);
  return x * decay + randNormal() * sigma * Math.sqrt(1 - decay * decay);
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
  // Returns the closest intersection point of a ray with the world rectangle.
  // Ray: origin + t * dir, t>=0
  const hits = [];

  // x = 0
  if (Math.abs(dx) > 1e-9) {
    let t = (0 - ox) / dx;
    if (t >= 0) {
      const y = oy + t * dy;
      if (y >= 0 && y <= h) hits.push({ t, x: 0, y });
    }
    // x = w
    t = (w - ox) / dx;
    if (t >= 0) {
      const y = oy + t * dy;
      if (y >= 0 && y <= h) hits.push({ t, x: w, y });
    }
  }

  // y = 0
  if (Math.abs(dy) > 1e-9) {
    let t = (0 - oy) / dy;
    if (t >= 0) {
      const x = ox + t * dx;
      if (x >= 0 && x <= w) hits.push({ t, x, y: 0 });
    }
    // y = h
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

function colorHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixColors(hexA, hexB, t) {
  const a = colorHexToRgb(hexA);
  const b = colorHexToRgb(hexB);
  const r = Math.round(lerp(a.r, b.r, t));
  const g = Math.round(lerp(a.g, b.g, t));
  const bch = Math.round(lerp(a.b, b.b, t));
  return `rgb(${r}, ${g}, ${bch})`;
}

const EMOTIONS = [
  { id: "joy", label: "Joy", color: "#f6c453" },
  { id: "fear", label: "Fear", color: "#6b7fff" },
  { id: "anger", label: "Anger", color: "#ff5a52" },
  { id: "sadness", label: "Sad", color: "#5a7f8a" },
  { id: "curiosity", label: "Curiosity", color: "#48cfae" },
];

const ENFP_PROFILE = Object.freeze({
  name: "ENFP",
  // 0..1 temperament sliders (tunable; later, MBTI presets map here)
  riskTolerance: 0.65,
  noveltySeeking: 0.88,
  persistence: 0.38,
  impulsivity: 0.78,
  optimism: 0.82,
  sociability: 0.86,
  emotionalReactivity: 0.72,
});

function makeWorld(canvas) {
  const w = {
    canvas,
    ctx: canvas.getContext("2d", { alpha: false }),
    width: 0,
    height: 0,
    time: 0,
    debug: false,
    showHelp: true,
    fruit: null, // { x, y, r }
    threat: null, // { x, y, r, speed }
  };
  return w;
}

function makeAgent(world) {
  const a = {
    x: world.width * 0.5,
    y: world.height * 0.55,
    vx: 0,
    vy: 0,
    r: 18,
    heading: -Math.PI / 2,
    maxSpeed: 160,
    maxAccel: 520,
    fov: (72 * Math.PI) / 180,
    mode: "AI", // "AI" | "MANUAL"
    profile: ENFP_PROFILE,

    // Drives / needs (0..1)
    energy: 0.75,
    boredom: 0.35,
    stress: 0.0,

    // Context / cognition
    arousal: {
      state: "CALM", // "CALM" | "ALERT" | "PANICKED"
      changedAt: 0,
      pursuitConfidence: 0, // 0..1 "am I still being pursued?"
    },
    decisionQuality: 0.85, // 0..1 planning + execution quality

    // Emotions (0..1)
    emotions: {
      joy: 0.2,
      fear: 0.05,
      anger: 0.02,
      sadness: 0.05,
      curiosity: 0.25,
    },

    // Perception + belief (belief is what planning uses; can be wrong under pressure)
    sensors: {
      fruit: { visible: false, aware: false, known: false, dist: Infinity },
      threat: {
        visible: false,
        peripheral: false,
        heard: false,
        aware: false,
        dist: Infinity,
        prox: 0, // 0..1
      },
      uncertainty: 0, // 0..1 (mostly threat-location uncertainty)
      events: {
        fruitAppeared: false,
        fruitLost: false,
        fruitSeen: false,
        threatAppeared: false,
        threatLost: false,
        threatSeen: false,
        threatProxJump: false,
        ateFruit: false,
      },
      _prev: {
        fruitExists: false,
        threatExists: false,
        fruitVisible: false,
        fruitKnown: false,
        threatVisible: false,
        threatAware: false,
        threatProx: 0,
      },
    },
    belief: {
      fruit: { x: 0, y: 0, ox: 0, oy: 0, quality: 0 },
      threat: { x: 0, y: 0, ox: 0, oy: 0, quality: 0, dist: Infinity },
    },

    // Perception memory + learning memory
    seen: { fruit: false, threat: false }, // convenience mirror for rendering/debug
    memory: {
      fruitPos: null, // {x,y}
      fruitSeenAt: -Infinity,
      threatPos: null,
      threatSeenAt: -Infinity,
      lastAteAt: -Infinity,
      lastStartledAt: -Infinity,
      strategyStats: Object.create(null),
      recentOutcomes: [],
    },

    // Long-horizon intent + future plan queue
    intent: {
      id: "SPAWN", // "ESCAPE" | "FORAGE" | "EXPLORE" | "RECOVER" | "CHECK_BEHIND"
      sub: "",
      enteredAt: 0,
      commitUntil: 0,
      contextKey: "",
      waypoint: null,
      safeSince: -Infinity,
      checkUntil: 0,
      start: {
        energy: 0,
        boredom: 0,
        stress: 0,
        maxThreatProx: 0,
      },
      flags: {
        ateFruit: false,
      },
    },
    plan: {
      currentIntent: null,
      nextIntents: [],
      depthChosen: 0,
      planConfidence: 0,
      plannedAt: -Infinity,
      nextPlanCheckpointAt: 0,
      contextKey: "",
    },

    // Gaze decoupled from movement (heading is the gaze)
    gaze: {
      targetAngle: -Math.PI / 2,
      lookBackUntil: 0,
      nextLookBackAt: 0,
      lookBackTargetAngle: 0,
    },

    // Motor command smoothing (reaction delay)
    motor: {
      desiredVx: 0,
      desiredVy: 0,
    },

    // Mistake model (pressure -> belief noise + execution slips)
    errorModel: {
      belief: { posNoisePx: 0, staleBonusSec: 0 },
      exec: {
        motorLagTau: 0.12,
        speedScale: 1,
        accelScale: 1,
        turnScale: 1,
        slipUntil: 0,
        slipKind: null, // "HESITATE" | "OVERSTEER" | "UNDERSTEER"
      },
    },
  };

  a.gaze.targetAngle = a.heading;

  return a;
}

function worldToCanvas(world, clientX, clientY) {
  const rect = world.canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * world.width;
  const y = ((clientY - rect.top) / rect.height) * world.height;
  return { x, y };
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

function resetFrameEvents(agent) {
  // Per-frame event flags (used to gate replanning without frame-by-frame twitchiness).
  const e = agent.sensors.events;
  for (const k of Object.keys(e)) e[k] = false;
}

function updateSensors(world, agent) {
  const now = world.time;
  const s = agent.sensors;
  const prev = s._prev;

  // Fruit sensing: primarily vision, with a small "smell" radius so click-to-place remains readable.
  const fruit = world.fruit;
  const fruitExists = Boolean(fruit);
  const fruitSmell = 130;
  const fruitMemory = 10 + agent.errorModel.belief.staleBonusSec;

  let fruitVisible = false;
  let fruitAware = false;
  let fruitDist = Infinity;
  if (fruitExists) {
    fruitDist = hypot(fruit.x - agent.x, fruit.y - agent.y);
    fruitVisible = inFov(agent, fruit.x, fruit.y);
    fruitAware = fruitVisible || fruitDist < fruitSmell;
    if (fruitAware) {
      agent.memory.fruitPos = { x: fruit.x, y: fruit.y };
      agent.memory.fruitSeenAt = now;
    }
  }

  const fruitKnown =
    fruitAware ||
    (agent.memory.fruitPos && now - agent.memory.fruitSeenAt < fruitMemory);

  // Threat sensing: vision + peripheral + hearing.
  const threat = world.threat;
  const threatExists = Boolean(threat);
  const peripheral = 120;
  const hearing = 240;
  const threatMemory = 3.0 + agent.errorModel.belief.staleBonusSec;

  let threatVisible = false;
  let threatDist = Infinity;
  let threatPeripheral = false;
  let threatHeard = false;
  if (threatExists) {
    threatDist = hypot(threat.x - agent.x, threat.y - agent.y);
    threatVisible = inFov(agent, threat.x, threat.y);
    threatPeripheral = threatDist < peripheral;
    threatHeard = !threatVisible && threatDist < hearing;
    if (threatVisible || threatPeripheral || threatHeard) {
      agent.memory.threatPos = { x: threat.x, y: threat.y };
      agent.memory.threatSeenAt = now;
    }
  }

  const threatAware =
    threatVisible ||
    threatPeripheral ||
    threatHeard ||
    (agent.memory.threatPos && now - agent.memory.threatSeenAt < threatMemory);

  // Threat proximity (0..1)
  let threatProx = 0;
  if (threatExists && threatAware) {
    const danger = 320;
    threatProx = clamp01((danger - threatDist) / danger);
  }

  // Uncertainty is about threat location certainty (not about whether it exists).
  let uncertainty = 0;
  if (!threatExists) {
    uncertainty = 0;
  } else if (threatVisible) {
    uncertainty = 0;
  } else if (threatPeripheral) {
    uncertainty = 0.25;
  } else if (threatHeard) {
    uncertainty = 0.5;
  } else {
    const t = now - agent.memory.threatSeenAt;
    uncertainty = clamp01(t / (6.0 + agent.errorModel.belief.staleBonusSec));
  }

  // Event gating (based on what the agent knows, not world omniscience).
  s.events.fruitAppeared = fruitKnown && !prev.fruitKnown;
  s.events.fruitLost = !fruitKnown && prev.fruitKnown;
  s.events.fruitSeen = fruitVisible && !prev.fruitVisible;

  s.events.threatAppeared = threatAware && !prev.threatAware;
  s.events.threatLost = !threatAware && prev.threatAware;
  s.events.threatSeen = threatVisible && !prev.threatVisible;
  s.events.threatProxJump = threatProx - prev.threatProx > 0.25 && threatProx > 0.25;

  // Write sensors
  s.fruit.visible = fruitVisible;
  s.fruit.aware = fruitAware;
  s.fruit.known = fruitKnown;
  s.fruit.dist = fruitDist;

  s.threat.visible = threatVisible;
  s.threat.peripheral = threatPeripheral;
  s.threat.heard = threatHeard;
  s.threat.aware = threatAware;
  s.threat.dist = threatDist;
  s.threat.prox = threatProx;

  s.uncertainty = uncertainty;

  // Convenience mirror for existing rendering/debug.
  agent.seen.fruit = fruitVisible;
  agent.seen.threat = threatVisible;

  // Update prev (world existence kept only for debug; gating uses known/aware/visible).
  prev.fruitExists = fruitExists;
  prev.threatExists = threatExists;
  prev.fruitVisible = fruitVisible;
  prev.fruitKnown = fruitKnown;
  prev.threatVisible = threatVisible;
  prev.threatAware = threatAware;
  prev.threatProx = threatProx;
}

function updateDrives(world, agent, dt) {
  const threatProx = agent.sensors.threat.prox;
  const safe = threatProx < 0.08 && agent.arousal.pursuitConfidence < 0.25;
  const recovering = agent.mode === "AI" && agent.intent.id === "RECOVER";

  // Energy drains slowly. While recovering in a safe moment, energy can restore.
  const drain = recovering ? 0.005 : 0.012;
  agent.energy = clamp01(agent.energy - dt * drain);
  if (recovering && safe) {
    agent.energy = clamp01(agent.energy + dt * 0.045);
  }

  // Boredom rises with time but drops when exploring/encountering novelty.
  const speedN = clamp01(hypot(agent.vx, agent.vy) / Math.max(1e-6, agent.maxSpeed));
  let boredomUp = 0.05;
  let boredomDown = 0;
  if (agent.intent.id === "EXPLORE") boredomDown += 0.1 * agent.profile.noveltySeeking;
  if (agent.sensors.fruit.aware) boredomDown += 0.05;
  if (agent.sensors.threat.aware) boredomDown += 0.03;
  boredomDown += speedN * (agent.intent.id === "EXPLORE" ? 0.05 : 0.015);
  agent.boredom = clamp01(agent.boredom + dt * boredomUp - dt * boredomDown);

  // Stress spikes from danger and lingering uncertainty; decays when calm.
  const targetStress = clamp01(
    threatProx * (1 - agent.profile.riskTolerance) + agent.sensors.uncertainty * 0.18,
  );
  agent.stress = lerp(agent.stress, targetStress, expSmoothing(dt, 0.35));
}

function updateEmotions(world, agent, dt) {
  // Target emotions from drives + perception (keep this intentionally simple and readable).
  const hunger = 1 - agent.energy;

  const sawThreat = agent.sensors.threat.visible ? 1 : 0;
  const sawFruit = agent.sensors.fruit.visible ? 1 : 0;

  const threatAware = agent.sensors.threat.aware;
  const danger = 300;
  const threatDist =
    agent.belief.threat.quality > 0.2
      ? agent.belief.threat.dist
      : agent.sensors.threat.dist;
  const threatProx =
    threatAware && Number.isFinite(threatDist)
      ? clamp01((danger - threatDist) / danger)
      : 0;

  const startled = sawThreat && threatProx > 0.55 ? 1 : 0;
  if (startled) agent.memory.lastStartledAt = world.time;

  const recentlyAte = world.time - agent.memory.lastAteAt < 1.8 ? 1 : 0;
  const recentlyStartled = world.time - agent.memory.lastStartledAt < 1.2 ? 1 : 0;

  const joyTarget = clamp01(
    0.12 + recentlyAte * 0.85 + sawFruit * 0.12 - agent.stress * 0.4,
  );
  const fearTarget = clamp01(
    0.03 +
      threatProx * (0.9 - agent.profile.riskTolerance * 0.55) +
      recentlyStartled * 0.55,
  );
  const angerTarget = clamp01(
    0.02 + threatProx * 0.45 * (agent.profile.persistence * 0.6 + hunger * 0.25),
  );
  const sadnessTarget = clamp01(0.03 + hunger * 0.35 + agent.stress * 0.18);
  const curiosityTarget = clamp01(
    0.08 +
      agent.boredom * 0.85 * agent.profile.noveltySeeking +
      sawFruit * 0.2 +
      (1 - sawThreat) * 0.1 -
      fearTarget * 0.35,
  );

  const tau = lerp(0.65, 0.25, agent.profile.emotionalReactivity);
  const a = expSmoothing(dt, tau);

  agent.emotions.joy = lerp(agent.emotions.joy, joyTarget, a);
  agent.emotions.fear = lerp(agent.emotions.fear, fearTarget, a);
  agent.emotions.anger = lerp(agent.emotions.anger, angerTarget, a);
  agent.emotions.sadness = lerp(agent.emotions.sadness, sadnessTarget, a);
  agent.emotions.curiosity = lerp(agent.emotions.curiosity, curiosityTarget, a);
}

function getEmotionPie(agent) {
  // Normalize to a pie. If sum is tiny, fall back to mostly-curiosity.
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

// --- v1.1: intent + planning + mistakes -------------------------------------

const INTENT_IDS = Object.freeze([
  "ESCAPE",
  "FORAGE",
  "EXPLORE",
  "RECOVER",
  "CHECK_BEHIND",
]);

function getArousalTuning(state) {
  if (state === "PANICKED") {
    return {
      lookBackCadence: 0.65,
      lookBackDuration: 0.25,
      turnRate: (240 * Math.PI) / 180,
      commitMin: 0.6,
      commitMax: 1.4,
      replanMin: 0.7,
      replanMax: 1.4,
    };
  }
  if (state === "ALERT") {
    return {
      lookBackCadence: 1.4,
      lookBackDuration: 0.35,
      turnRate: (150 * Math.PI) / 180,
      commitMin: 1.5,
      commitMax: 3.0,
      replanMin: 1.4,
      replanMax: 2.6,
    };
  }
  return {
    lookBackCadence: 2.8,
    lookBackDuration: 0.45,
    turnRate: (90 * Math.PI) / 180,
    commitMin: 2.5,
    commitMax: 4.0,
    replanMin: 2.6,
    replanMax: 4.0,
  };
}

function updateArousal(world, agent, dt) {
  const now = world.time;
  const s = agent.sensors;

  let pursuitTarget = 0;
  if (s.threat.visible) pursuitTarget = 1;
  else if (s.threat.peripheral) pursuitTarget = 0.9;
  else if (s.threat.heard) pursuitTarget = 0.7;
  else if (s.threat.aware) {
    const t = now - agent.memory.threatSeenAt;
    pursuitTarget = clamp01(Math.exp(-t / 3.2) * 0.7);
  }

  agent.arousal.pursuitConfidence = lerp(
    agent.arousal.pursuitConfidence,
    pursuitTarget,
    expSmoothing(dt, 0.35),
  );

  // Arousal score with hysteresis.
  const score =
    s.threat.prox * 1.25 + agent.arousal.pursuitConfidence * 0.9 + agent.stress * 0.55;

  const cur = agent.arousal.state;
  let next = cur;
  if (cur === "CALM") {
    if (score > 1.1) next = "PANICKED";
    else if (score > 0.55) next = "ALERT";
  } else if (cur === "ALERT") {
    if (score > 1.2) next = "PANICKED";
    else if (score < 0.35) next = "CALM";
  } else {
    // PANICKED
    if (score < 0.85) next = "ALERT";
    if (score < 0.25) next = "CALM";
  }

  if (next !== cur) {
    agent.arousal.state = next;
    agent.arousal.changedAt = now;
  }
}

function updateDecisionQuality(agent, dt) {
  const recent = agent.memory.recentOutcomes;
  const n = Math.min(6, recent.length);
  let trend = 0;
  if (n > 0) {
    for (let i = recent.length - n; i < recent.length; i++) trend += recent[i];
    trend /= n; // already in [-1, 1]
  }

  const ar =
    agent.arousal.state === "CALM"
      ? 1
      : agent.arousal.state === "ALERT"
        ? 0.78
        : 0.52;

  const hunger = 1 - agent.energy;
  const uncertainty = agent.sensors.uncertainty;

  let q =
    0.34 +
    0.36 * ar +
    0.14 * (agent.energy - 0.5) +
    0.08 * (-hunger) +
    0.14 * trend -
    0.34 * agent.stress -
    0.28 * uncertainty;

  q = clamp(q, 0.05, 0.95);
  agent.decisionQuality = lerp(agent.decisionQuality, q, expSmoothing(dt, 0.55));
}

function updateErrorModel(world, agent, dt) {
  const now = world.time;
  const q = agent.decisionQuality;
  const arMul = agent.arousal.state === "CALM" ? 0.6 : agent.arousal.state === "ALERT" ? 1.0 : 1.55;

  agent.errorModel.belief.posNoisePx = (2 + (1 - q) * 26) * arMul;
  agent.errorModel.belief.staleBonusSec =
    (1 - q) * (agent.arousal.state === "PANICKED" ? 3.0 : agent.arousal.state === "ALERT" ? 1.4 : 0.4);

  const exec = agent.errorModel.exec;
  exec.motorLagTau = (0.06 + (1 - q) * 0.18) * (agent.arousal.state === "PANICKED" ? 1.25 : 1.0);
  exec.speedScale = 1;
  exec.accelScale = 1;
  exec.turnScale = 1;

  if (now >= exec.slipUntil) exec.slipKind = null;

  if (!exec.slipKind) {
    const rate = agent.arousal.state === "CALM" ? 0.02 : agent.arousal.state === "ALERT" ? 0.12 : 0.28;
    const p = 1 - Math.exp(-rate * (1 - q) * dt);
    if (Math.random() < p) {
      const r = Math.random();
      exec.slipKind = r < 0.5 ? "HESITATE" : r < 0.75 ? "OVERSTEER" : "UNDERSTEER";
      exec.slipUntil = now + randRange(0.25, 0.75);
    }
  }

  if (exec.slipKind === "HESITATE") {
    exec.speedScale *= 0.75;
    exec.accelScale *= 0.55;
    exec.turnScale *= 1.05;
  } else if (exec.slipKind === "OVERSTEER") {
    exec.turnScale *= 1.35;
  } else if (exec.slipKind === "UNDERSTEER") {
    exec.turnScale *= 0.7;
  }
}

function updateBeliefs(world, agent, dt) {
  const s = agent.sensors;
  const b = agent.belief;
  const noise = agent.errorModel.belief.posNoisePx;

  // Fruit belief: fairly accurate when visible; fuzzier when remembered/smelled.
  if (s.fruit.known && agent.memory.fruitPos) {
    const base = agent.memory.fruitPos;
    const q = s.fruit.visible ? 1 : s.fruit.aware ? 0.7 : 0.45;
    const sigma = noise * 0.35 * (1.15 - q);
    b.fruit.ox = ouStep(b.fruit.ox, dt, 0.65, sigma);
    b.fruit.oy = ouStep(b.fruit.oy, dt, 0.65, sigma);
    b.fruit.x = base.x + b.fruit.ox;
    b.fruit.y = base.y + b.fruit.oy;
    b.fruit.quality = q;
  } else {
    b.fruit.quality = 0;
    b.fruit.ox = ouStep(b.fruit.ox, dt, 0.4, 0);
    b.fruit.oy = ouStep(b.fruit.oy, dt, 0.4, 0);
  }

  // Threat belief: can get badly wrong under pressure.
  if (s.threat.aware && agent.memory.threatPos) {
    const base = agent.memory.threatPos;
    const age = Math.max(0, world.time - agent.memory.threatSeenAt);
    let q = 0;
    if (s.threat.visible) q = 1;
    else if (s.threat.peripheral) q = 0.82;
    else if (s.threat.heard) q = 0.62;
    else q = clamp01(0.48 * Math.exp(-age / 3.0));

    const sigma = noise * (0.55 + (1 - q) * 1.35) + age * 6;
    b.threat.ox = ouStep(b.threat.ox, dt, 0.45, sigma);
    b.threat.oy = ouStep(b.threat.oy, dt, 0.45, sigma);
    b.threat.x = base.x + b.threat.ox;
    b.threat.y = base.y + b.threat.oy;
    b.threat.quality = q;
    b.threat.dist = hypot(b.threat.x - agent.x, b.threat.y - agent.y);
  } else {
    b.threat.quality = 0;
    b.threat.dist = Infinity;
    b.threat.ox = ouStep(b.threat.ox, dt, 0.35, 0);
    b.threat.oy = ouStep(b.threat.oy, dt, 0.35, 0);
  }

  // Clamp beliefs into the world to avoid absurd off-map vectors.
  b.fruit.x = clamp(b.fruit.x, 0, world.width);
  b.fruit.y = clamp(b.fruit.y, 0, world.height);
  b.threat.x = clamp(b.threat.x, 0, world.width);
  b.threat.y = clamp(b.threat.y, 0, world.height);
}

function buildContextKey(agent) {
  const a = agent.arousal.state[0] ?? "C";
  const hunger = 1 - agent.energy;
  const hungerBand = hunger < 0.33 ? 0 : hunger < 0.66 ? 1 : 2;
  const p = agent.sensors.threat.prox;
  const threatBand = p < 0.1 ? 0 : p < 0.45 ? 1 : 2;
  const r = agent.sensors.fruit.visible ? "FV" : agent.sensors.fruit.known ? "FK" : "FN";
  return `A:${a}|H:${hungerBand}|T:${threatBand}|R:${r}`;
}

function choosePlanningDepth(agent) {
  const q = agent.decisionQuality;
  const u = agent.sensors.uncertainty;

  let depth = 2;
  if (agent.arousal.state === "PANICKED") depth = q < 0.55 ? 1 : 2;
  else if (agent.arousal.state === "ALERT") depth = q < 0.55 ? 2 : 3;
  else {
    // CALM
    if (q > 0.82) depth = 3;
    if (q > 0.9) depth = 4;
  }

  if (u > 0.65) depth = Math.min(depth, 2);
  if (u > 0.85) depth = 1;

  // If a context has a proven strategy, allow deeper planning.
  const key = buildContextKey(agent);
  const stats = agent.memory.strategyStats[key];
  let proven = 0;
  if (stats) {
    for (const id of Object.keys(stats)) {
      const st = stats[id];
      if (!st || st.attempts < 4) continue;
      const sr = st.successes / st.attempts;
      if (sr > 0.7) proven = 1;
    }
  }

  depth = clamp(depth + proven, 1, 5);

  // ENFP: a little extra future-thinking when calm and curious.
  if (agent.arousal.state === "CALM" && q > 0.78) {
    const pExtra = agent.profile.noveltySeeking * 0.25 + agent.emotions.curiosity * 0.2;
    if (Math.random() < pExtra) depth = clamp(depth + 1, 1, 5);
  }

  return depth;
}

function getPlanningContext(agent) {
  return {
    hunger: 1 - agent.energy,
    boredom: agent.boredom,
    stress: agent.stress,
    curiosity: agent.emotions.curiosity,
    threatProx: agent.sensors.threat.prox,
    pursuitConfidence: agent.arousal.pursuitConfidence,
    uncertainty: agent.sensors.uncertainty,
    fruitKnown: agent.sensors.fruit.known ? 1 : 0,
    fruitVisible: agent.sensors.fruit.visible ? 1 : 0,
  };
}

function possibleNextIntents(prev, ctx, agent) {
  const opts = [];
  const threatHigh = ctx.threatProx > 0.42 || ctx.pursuitConfidence > 0.78;
  const threatUncertain = ctx.uncertainty > 0.55 && ctx.pursuitConfidence > 0.35;
  const hungry = ctx.hunger > 0.58 && ctx.fruitKnown > 0;
  const bored = ctx.boredom > 0.42;
  const stressed = ctx.stress > 0.5 && ctx.threatProx < 0.18;

  if (!prev) {
    if (threatHigh) opts.push("ESCAPE");
    if (threatUncertain) opts.push("CHECK_BEHIND");
    if (hungry) opts.push("FORAGE");
    if (stressed) opts.push("RECOVER");
    if (bored) opts.push("EXPLORE");
    if (opts.length === 0) opts.push("EXPLORE");
  } else if (prev === "ESCAPE") {
    if (threatUncertain) opts.push("CHECK_BEHIND");
    opts.push("RECOVER");
    if (hungry) opts.push("FORAGE");
    opts.push("EXPLORE");
    if (threatHigh) opts.unshift("ESCAPE");
  } else if (prev === "FORAGE") {
    if (threatHigh) opts.push("ESCAPE");
    if (threatUncertain) opts.push("CHECK_BEHIND");
    opts.push("FORAGE");
    if (stressed) opts.push("RECOVER");
    if (bored) opts.push("EXPLORE");
  } else if (prev === "RECOVER") {
    if (threatHigh) opts.push("ESCAPE");
    if (hungry) opts.push("FORAGE");
    opts.push("EXPLORE");
    opts.push("RECOVER");
  } else if (prev === "CHECK_BEHIND") {
    if (threatHigh) opts.push("ESCAPE");
    if (hungry) opts.push("FORAGE");
    opts.push("RECOVER");
    opts.push("EXPLORE");
  } else {
    // EXPLORE
    if (threatHigh) opts.push("ESCAPE");
    if (hungry) opts.push("FORAGE");
    if (threatUncertain) opts.push("CHECK_BEHIND");
    opts.push("EXPLORE");
    if (stressed) opts.push("RECOVER");
  }

  // Deduplicate, keep order.
  const out = [];
  for (const id of opts) if (!out.includes(id)) out.push(id);
  return out.slice(0, 3);
}

function scoreIntentStep(prev, id, ctx, agent, contextKey, now) {
  let score = 0;
  if (id === "ESCAPE") {
    score =
      ctx.threatProx * 2.6 +
      ctx.pursuitConfidence * 1.4 -
      ctx.hunger * 0.55 -
      ctx.boredom * 0.15;
  } else if (id === "CHECK_BEHIND") {
    score =
      ctx.uncertainty * 1.45 +
      ctx.pursuitConfidence * 0.6 -
      ctx.threatProx * 0.5 -
      ctx.hunger * 0.25;
  } else if (id === "FORAGE") {
    score =
      ctx.hunger * (ctx.fruitKnown ? 2.2 : 0.3) +
      ctx.fruitVisible * 0.35 +
      ctx.curiosity * 0.15 -
      ctx.threatProx * 1.7 -
      ctx.pursuitConfidence * 0.85 -
      ctx.uncertainty * 0.25;
  } else if (id === "EXPLORE") {
    score =
      ctx.boredom * 1.6 * agent.profile.noveltySeeking +
      ctx.curiosity * 0.22 -
      ctx.threatProx * 1.25 -
      ctx.pursuitConfidence * 0.7 -
      ctx.hunger * 0.4;
  } else {
    // RECOVER
    score =
      ctx.stress * 1.3 +
      (1 - ctx.threatProx) * 0.25 -
      ctx.hunger * 0.65 -
      ctx.boredom * 0.25;
  }

  // Transition shaping (small, but makes plans feel coherent).
  if (prev === "ESCAPE" && id === "RECOVER") score += 0.35;
  if (prev === "CHECK_BEHIND" && id === "ESCAPE") score += 0.25;
  if (prev === "RECOVER" && id === "FORAGE") score += 0.12;
  if (prev === "FORAGE" && id === "RECOVER") score += 0.1;

  // Repetition penalty (except ESCAPE under threat).
  if (prev === id) {
    const allow = id === "ESCAPE" && (ctx.threatProx > 0.25 || ctx.pursuitConfidence > 0.55);
    if (!allow) score -= 0.22;
  }

  // Experience bias.
  const byCtx = agent.memory.strategyStats[contextKey];
  const st = byCtx ? byCtx[id] : null;
  if (st && st.attempts > 0) {
    const sr = st.successes / st.attempts;
    score += (sr - 0.5) * 0.9;
    score += (st.avgReward - 0.5) * 0.6;
    score -= st.avgRisk * 0.5;
    const age = Math.max(0, now - st.lastUsedAt);
    score += agent.profile.noveltySeeking * clamp01(age / 35) * (id === "EXPLORE" ? 0.14 : 0.05);
  } else {
    // Mild novelty bonus for trying something new.
    score += agent.profile.noveltySeeking * 0.05;
  }

  return score;
}

function planIntentSequence(agent, world, depth, startIntentId = null) {
  const now = world.time;
  const ctx = getPlanningContext(agent);
  const contextKey = buildContextKey(agent);

  let cands = [{ intents: [], score: 0 }];
  const keep = 18;

  for (let step = 0; step < depth; step++) {
    const next = [];
    for (const c of cands) {
      const prev = c.intents[c.intents.length - 1] ?? null;
      const options = step === 0 && startIntentId ? [startIntentId] : possibleNextIntents(prev, ctx, agent);
      for (const id of options) {
        if (c.intents.length >= 2) {
          const a = c.intents[c.intents.length - 1];
          const b = c.intents[c.intents.length - 2];
          if (a === id && b === id) continue; // avoid triple repeats
        }
        const discount = Math.pow(0.82, step);
        const stepScore = scoreIntentStep(prev, id, ctx, agent, contextKey, now);
        next.push({ intents: c.intents.concat(id), score: c.score + stepScore * discount });
      }
    }
    next.sort((a, b) => b.score - a.score);
    cands = next.slice(0, keep);
  }

  if (cands.length === 0) {
    return { chain: [startIntentId ?? "EXPLORE"], confidence: 0.2, contextKey };
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const second = cands[1]?.score ?? best.score - 0.05;
  const confidence = clamp01(0.45 + (best.score - second) * 0.25) * lerp(0.65, 1.0, agent.decisionQuality);

  // Under low quality, selection becomes noisier (planning mistakes).
  const temp = lerp(0.25, 1.35, 1 - agent.decisionQuality);
  const idx = chooseSoftmax(
    cands.map((c, i) => ({ id: i, score: c.score })),
    temp,
  );
  const chosen = cands[idx ?? 0] ?? best;

  return { chain: chosen.intents, confidence, contextKey };
}

function scheduleNextPlanCheckpoint(world, agent) {
  const now = world.time;
  const tune = getArousalTuning(agent.arousal.state);
  let t = randRange(tune.replanMin, tune.replanMax);
  // More uncertainty -> shorter horizon (needs checks).
  t *= lerp(0.75, 1.2, agent.decisionQuality);
  if (agent.sensors.uncertainty > 0.55) t = Math.min(t, tune.replanMin + 0.85);
  agent.plan.nextPlanCheckpointAt = now + t;
}

function shouldReplan(world, agent) {
  const now = world.time;
  const e = agent.sensors.events;
  if (agent.intent.id === "SPAWN") return true;
  if (!agent.plan.currentIntent) return true;
  if (now >= agent.plan.nextPlanCheckpointAt) return true;
  if (e.threatAppeared || e.threatSeen || e.threatProxJump) return true;
  if (e.fruitAppeared || e.fruitSeen) return true;
  if (agent.plan.planConfidence < 0.2 && now - agent.plan.plannedAt > 0.9) return true;
  // If we were foraging but lost the fruit, plan a new course.
  if (agent.intent.id === "FORAGE" && !agent.sensors.fruit.known && now - agent.intent.enteredAt > 1.8) return true;
  return false;
}

function recordOutcome(agent, contextKey, intentId, rewardN, riskN, success, now) {
  const statsByCtx =
    agent.memory.strategyStats[contextKey] ?? (agent.memory.strategyStats[contextKey] = Object.create(null));
  const st =
    statsByCtx[intentId] ??
    (statsByCtx[intentId] = { attempts: 0, successes: 0, avgReward: 0.5, avgRisk: 0.0, lastUsedAt: -Infinity });

  st.attempts += 1;
  if (success) st.successes += 1;
  st.avgReward = (st.avgReward * (st.attempts - 1) + rewardN) / st.attempts;
  st.avgRisk = (st.avgRisk * (st.attempts - 1) + riskN) / st.attempts;
  st.lastUsedAt = now;

  const net = clamp((rewardN - 0.5) * 2 - riskN, -1, 1);
  agent.memory.recentOutcomes.push(net);
  while (agent.memory.recentOutcomes.length > 10) agent.memory.recentOutcomes.shift();
}

function endIntent(world, agent) {
  const now = world.time;
  const start = agent.intent.start;

  const rewardScore =
    (agent.energy - start.energy) * 1.2 +
    (start.boredom - agent.boredom) * 0.9 +
    (start.stress - agent.stress) * 0.9;
  const rewardN = clamp01(0.5 + rewardScore * 0.5);
  const riskN = clamp01(start.maxThreatProx);

  const success =
    agent.intent.id === "FORAGE" ? agent.intent.flags.ateFruit : rewardN > 0.55 && riskN < 0.6;

  if (agent.intent.contextKey) {
    recordOutcome(agent, agent.intent.contextKey, agent.intent.id, rewardN, riskN, success, now);
  }
}

function enterIntent(world, agent, id) {
  const now = world.time;
  const tune = getArousalTuning(agent.arousal.state);

  agent.intent.id = id;
  agent.intent.enteredAt = now;
  agent.intent.contextKey = buildContextKey(agent);
  agent.intent.sub = "";
  agent.intent.safeSince = -Infinity;
  agent.intent.flags.ateFruit = false;

  agent.intent.start.energy = agent.energy;
  agent.intent.start.boredom = agent.boredom;
  agent.intent.start.stress = agent.stress;
  agent.intent.start.maxThreatProx = agent.sensors.threat.prox;

  // Commitment window (min time before considering leaving).
  const qScale = lerp(0.85, 1.1, agent.decisionQuality);
  let min = tune.commitMin * qScale;
  let max = tune.commitMax * qScale;
  if (id === "ESCAPE") {
    min *= 0.7;
    max *= 0.8;
  } else if (id === "FORAGE") {
    min *= 1.05;
    max *= 1.1;
  }

  const hold = randRange(min, max);
  agent.intent.commitUntil = now + hold;
  agent.intent.checkUntil = 0;

  if (id === "EXPLORE") {
    agent.intent.sub = "WANDER";
    agent.intent.waypoint = {
      x: randRange(agent.r, world.width - agent.r),
      y: randRange(agent.r, world.height - agent.r),
    };
  } else if (id === "FORAGE") {
    agent.intent.sub = agent.sensors.fruit.known ? "APPROACH" : "SEARCH";
    agent.intent.waypoint = null;
  } else if (id === "RECOVER") {
    agent.intent.sub = "REST";
    agent.intent.waypoint = null;
  } else if (id === "CHECK_BEHIND") {
    agent.intent.sub = "TURN";
    agent.intent.checkUntil = now + randRange(0.35, 0.9);
    agent.intent.commitUntil = agent.intent.checkUntil;
    agent.intent.waypoint = null;
    agent.gaze.lookBackUntil = 0;
  } else {
    agent.intent.sub = "RUN";
    agent.intent.waypoint = null;
  }

  agent.plan.currentIntent = id;
}

function ensurePlan(world, agent, { force = false, keepCurrent = true } = {}) {
  const now = world.time;
  if (!force && !shouldReplan(world, agent)) return;

  const depth = choosePlanningDepth(agent);
  const start = keepCurrent && agent.intent.id !== "SPAWN" ? agent.intent.id : null;
  const res = planIntentSequence(agent, world, depth, start);

  agent.plan.depthChosen = depth;
  agent.plan.planConfidence = res.confidence;
  agent.plan.contextKey = res.contextKey;
  agent.plan.plannedAt = now;

  if (start) {
    // Plan is "after current".
    agent.plan.currentIntent = start;
    agent.plan.nextIntents = res.chain.slice(1);
  } else {
    agent.plan.currentIntent = res.chain[0] ?? "EXPLORE";
    agent.plan.nextIntents = res.chain.slice(1);
  }

  scheduleNextPlanCheckpoint(world, agent);
}

function shouldEmergencyEscape(agent) {
  const prox = agent.sensors.threat.prox;
  const p = agent.arousal.pursuitConfidence;
  return prox > 0.55 || (prox > 0.35 && p > 0.85);
}

function isIntentComplete(world, agent) {
  const now = world.time;
  const id = agent.intent.id;

  if (id === "CHECK_BEHIND") return now >= agent.intent.checkUntil;

  if (id === "ESCAPE") {
    const safe = agent.sensors.threat.prox < 0.12 && agent.arousal.pursuitConfidence < 0.35;
    if (safe) {
      if (!Number.isFinite(agent.intent.safeSince) || agent.intent.safeSince < 0) agent.intent.safeSince = now;
    } else {
      agent.intent.safeSince = -Infinity;
    }
    return now >= agent.intent.commitUntil && safe && now - agent.intent.safeSince > 0.6;
  }

  if (id === "FORAGE") {
    if (agent.intent.flags.ateFruit) return true;
    const timeout = now - agent.intent.enteredAt > 12 + agent.errorModel.belief.staleBonusSec;
    const boredOrFull = (1 - agent.energy) < 0.25 && agent.boredom < 0.25;
    const fruitLost = !agent.sensors.fruit.known && now - agent.intent.enteredAt > 2.6;
    return timeout || (now >= agent.intent.commitUntil && (fruitLost || boredOrFull));
  }

  if (id === "EXPLORE") {
    const wp = agent.intent.waypoint;
    const arrived = wp ? hypot(wp.x - agent.x, wp.y - agent.y) < 22 : false;
    const satisfied = agent.boredom < 0.22;
    return now >= agent.intent.commitUntil && (satisfied || arrived);
  }

  // RECOVER
  const recovered = agent.stress < 0.16 && agent.energy > 0.62;
  return now >= agent.intent.commitUntil && recovered;
}

function steerTo(agent, tx, ty, speed, dt, noise = 0) {
  const exec = agent.errorModel.exec;
  const toX = tx - agent.x;
  const toY = ty - agent.y;
  const n = normalize(toX, toY);

  let dx = n.x;
  let dy = n.y;

  // Add a tiny lateral wobble to avoid robot-straight movement.
  if (noise > 0 && n.len > 1e-6) {
    const px = -dy;
    const py = dx;
    const w = Math.sin(performance.now() * 0.0017 + agent.x * 0.01 + agent.y * 0.01);
    const nn = normalize(dx + px * w * noise, dy + py * w * noise);
    dx = nn.x;
    dy = nn.y;
  }

  const desiredVx = dx * speed * exec.speedScale;
  const desiredVy = dy * speed * exec.speedScale;

  // Reaction delay / motor lag.
  const lagA = expSmoothing(dt, exec.motorLagTau);
  agent.motor.desiredVx = lerp(agent.motor.desiredVx, desiredVx, lagA);
  agent.motor.desiredVy = lerp(agent.motor.desiredVy, desiredVy, lagA);

  const ax = agent.motor.desiredVx - agent.vx;
  const ay = agent.motor.desiredVy - agent.vy;
  const an = normalize(ax, ay);

  const maxDv = agent.maxAccel * exec.accelScale * dt;
  const dv = Math.min(maxDv, an.len);
  agent.vx += an.x * dv;
  agent.vy += an.y * dv;
}

function damp(agent, dt, strength = 4.2) {
  const d = Math.exp(-dt * strength);
  agent.vx *= d;
  agent.vy *= d;
  agent.motor.desiredVx *= d;
  agent.motor.desiredVy *= d;
}

function updateGazePolicy(world, agent, dt, focus, moveAngle) {
  const now = world.time;
  const tune = getArousalTuning(agent.arousal.state);
  const turnRate = tune.turnRate * agent.errorModel.exec.turnScale;

  // Determine base gaze target.
  let target = agent.heading;
  if (focus === "THREAT" && agent.belief.threat.quality > 0.2) {
    target = angleTo(agent.belief.threat.x - agent.x, agent.belief.threat.y - agent.y);
  } else if (focus === "FRUIT" && agent.belief.fruit.quality > 0.2) {
    target = angleTo(agent.belief.fruit.x - agent.x, agent.belief.fruit.y - agent.y);
  } else if (Number.isFinite(moveAngle)) {
    target = moveAngle;
  }

  // Gentle scanning (smooth, not twitchy) when not locked to a specific target.
  if (focus === "SCAN") {
    const amp =
      agent.arousal.state === "CALM"
        ? 0.32
        : agent.arousal.state === "ALERT"
          ? 0.18
          : 0.08;
    target = wrapAngle(target + Math.sin(now * 0.65) * amp);
  }

  // Periodic look-backs (scheduled) to verify pursuit.
  const canLookBack = agent.intent.id === "ESCAPE" || agent.intent.id === "FORAGE";
  const shouldLookBackSoon =
    canLookBack &&
    agent.sensors.threat.aware &&
    (agent.sensors.uncertainty > 0.4 || agent.arousal.pursuitConfidence > 0.35);

  if (shouldLookBackSoon && now >= agent.gaze.nextLookBackAt && now >= agent.gaze.lookBackUntil) {
    agent.gaze.lookBackUntil = now + tune.lookBackDuration;
    agent.gaze.nextLookBackAt = now + tune.lookBackCadence;
    agent.gaze.lookBackTargetAngle =
      agent.belief.threat.quality > 0.2
        ? angleTo(agent.belief.threat.x - agent.x, agent.belief.threat.y - agent.y)
        : wrapAngle(moveAngle + Math.PI);
  }

  if (now < agent.gaze.lookBackUntil) {
    target = agent.gaze.lookBackTargetAngle;
  } else {
    agent.gaze.targetAngle = target;
  }

  // Update heading with capped angular velocity.
  const diff = angleDiff(agent.heading, target);
  const maxStep = turnRate * dt;
  agent.heading = wrapAngle(agent.heading + clamp(diff, -maxStep, maxStep));
}

function moveAgent(world, agent, dt, input) {
  // Track risk during the current intent for learning.
  agent.intent.start.maxThreatProx = Math.max(agent.intent.start.maxThreatProx, agent.sensors.threat.prox);

  if (agent.mode === "MANUAL") {
    const speed = agent.maxSpeed * 0.9;
    const ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const iy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (ix === 0 && iy === 0) damp(agent, dt);
    else {
      const n = normalize(ix, iy);
      steerTo(agent, agent.x + n.x * 10, agent.y + n.y * 10, speed, dt, 0.02);
    }

    // Clamp + integrate.
    const v = normalize(agent.vx, agent.vy);
    const max = agent.maxSpeed * 0.95;
    if (v.len > max) {
      agent.vx = v.x * max;
      agent.vy = v.y * max;
    }

    agent.x += agent.vx * dt;
    agent.y += agent.vy * dt;
    agent.x = Math.max(agent.r, Math.min(world.width - agent.r, agent.x));
    agent.y = Math.max(agent.r, Math.min(world.height - agent.r, agent.y));

    const moveAngle = v.len > 8 ? angleTo(agent.vx, agent.vy) : agent.heading;
    updateGazePolicy(world, agent, dt, "SCAN", moveAngle);
  } else {
    // Initialize if needed.
    if (agent.intent.id === "SPAWN") {
      ensurePlan(world, agent, { force: true, keepCurrent: false });
      enterIntent(world, agent, agent.plan.currentIntent ?? "EXPLORE");
    }

    // Emergency interrupts.
    if (shouldEmergencyEscape(agent) && agent.intent.id !== "ESCAPE") {
      endIntent(world, agent);
      agent.plan.nextIntents = [];
      enterIntent(world, agent, "ESCAPE");
      ensurePlan(world, agent, { force: true, keepCurrent: true });
    }

    // Completion transitions.
    if (isIntentComplete(world, agent)) {
      endIntent(world, agent);
      const next = agent.plan.nextIntents.shift();
      if (next) {
        enterIntent(world, agent, next);
      } else {
        ensurePlan(world, agent, { force: true, keepCurrent: false });
        enterIntent(world, agent, agent.plan.currentIntent ?? "EXPLORE");
      }
    }

    // Replan for "after current" (without switching current intent).
    ensurePlan(world, agent, { force: false, keepCurrent: true });

    // Execute intent -> motor + gaze.
    const baseSpeed = agent.maxSpeed;
    const fearBoost = lerp(1.0, 1.35, clamp01(agent.emotions.fear * 1.15 + agent.stress));
    const execSpeed = baseSpeed * fearBoost;

    let target = null;
    let speed = baseSpeed * 0.85;
    let noise = 0.05;
    let gazeFocus = "SCAN";

    if (agent.intent.id === "ESCAPE") {
      gazeFocus = "FORWARD";
      const tx =
        agent.belief.threat.quality > 0.2 ? agent.belief.threat.x : agent.x - Math.cos(agent.heading) * 50;
      const ty =
        agent.belief.threat.quality > 0.2 ? agent.belief.threat.y : agent.y - Math.sin(agent.heading) * 50;

      // Run away + bias away from walls.
      let ax = agent.x - tx;
      let ay = agent.y - ty;
      const edge = 90;
      const push = 0.9;
      if (agent.x < edge) ax += push * (edge - agent.x);
      if (agent.x > world.width - edge) ax -= push * (agent.x - (world.width - edge));
      if (agent.y < edge) ay += push * (edge - agent.y);
      if (agent.y > world.height - edge) ay -= push * (agent.y - (world.height - edge));

      const away = normalize(ax, ay);
      const dist = 260;
      target = {
        x: clamp(agent.x + away.x * dist, agent.r, world.width - agent.r),
        y: clamp(agent.y + away.y * dist, agent.r, world.height - agent.r),
      };
      speed = execSpeed;
      noise = 0.08;
    } else if (agent.intent.id === "FORAGE") {
      gazeFocus = agent.belief.fruit.quality > 0.1 ? "FRUIT" : "SCAN";
      if (agent.belief.fruit.quality > 0.1) {
        target = { x: agent.belief.fruit.x, y: agent.belief.fruit.y };
        const d = hypot(target.x - agent.x, target.y - agent.y);
        const arrive = clamp01(d / 140);
        speed = baseSpeed * lerp(0.35, 1.0, arrive);
        noise = 0.05;
      } else {
        // Search: drift to a waypoint to re-acquire.
        if (!agent.intent.waypoint) {
          agent.intent.waypoint = {
            x: randRange(agent.r, world.width - agent.r),
            y: randRange(agent.r, world.height - agent.r),
          };
        }
        const wp = agent.intent.waypoint;
        const d = hypot(wp.x - agent.x, wp.y - agent.y);
        if (d < 28) {
          agent.intent.waypoint = {
            x: randRange(agent.r, world.width - agent.r),
            y: randRange(agent.r, world.height - agent.r),
          };
        }
        target = agent.intent.waypoint;
        speed = baseSpeed * 0.7;
        noise = 0.08;
      }
    } else if (agent.intent.id === "EXPLORE") {
      gazeFocus = "SCAN";
      if (!agent.intent.waypoint) {
        agent.intent.waypoint = {
          x: randRange(agent.r, world.width - agent.r),
          y: randRange(agent.r, world.height - agent.r),
        };
      }
      const wp = agent.intent.waypoint;
      const d = hypot(wp.x - agent.x, wp.y - agent.y);
      if (d < 26) {
        agent.intent.waypoint = {
          x: randRange(agent.r, world.width - agent.r),
          y: randRange(agent.r, world.height - agent.r),
        };
      }
      target = agent.intent.waypoint;
      speed = baseSpeed * 0.82;
      noise = 0.09;
    } else if (agent.intent.id === "RECOVER") {
      gazeFocus = "SCAN";
      damp(agent, dt, 5.2);
      // Drift gently toward center to reduce corner-trapping.
      const cx = world.width * 0.5;
      const cy = world.height * 0.5;
      steerTo(agent, cx, cy, baseSpeed * 0.2, dt, 0.02);
      target = null;
    } else {
      // CHECK_BEHIND
      gazeFocus = "THREAT";
      damp(agent, dt, 6.5);
      target = null;
    }

    if (target) steerTo(agent, target.x, target.y, speed, dt, noise);

    // Clamp speed hard (safety bound even with slips).
    const v = normalize(agent.vx, agent.vy);
    const max = agent.maxSpeed * fearBoost;
    if (v.len > max) {
      agent.vx = v.x * max;
      agent.vy = v.y * max;
    }

    agent.x += agent.vx * dt;
    agent.y += agent.vy * dt;
    agent.x = Math.max(agent.r, Math.min(world.width - agent.r, agent.x));
    agent.y = Math.max(agent.r, Math.min(world.height - agent.r, agent.y));

    const moveAngle = v.len > 8 ? angleTo(agent.vx, agent.vy) : agent.heading;
    updateGazePolicy(world, agent, dt, gazeFocus, moveAngle);
  }
}

function updateThreat(world, agent, dt) {
  if (!world.threat) return;
  const t = world.threat;

  // Slower juggernaut that chases.
  const dx = agent.x - t.x;
  const dy = agent.y - t.y;
  const n = normalize(dx, dy);

  const speed = t.speed;
  t.x += n.x * speed * dt;
  t.y += n.y * speed * dt;

  t.x = Math.max(t.r, Math.min(world.width - t.r, t.x));
  t.y = Math.max(t.r, Math.min(world.height - t.r, t.y));
}

function resolveFruit(world, agent) {
  if (!world.fruit) return;
  const f = world.fruit;
  const d = hypot(f.x - agent.x, f.y - agent.y);
  if (d <= f.r + agent.r + 2) {
    world.fruit = null;
    agent.energy = clamp01(agent.energy + 0.42);
    agent.memory.lastAteAt = world.time;
    agent.sensors.events.ateFruit = true;
    agent.intent.flags.ateFruit = true;
    agent.memory.fruitPos = null;
    agent.memory.fruitSeenAt = -Infinity;

    // ENFP-ish: eating reduces boredom more strongly (novelty/reward).
    agent.boredom = clamp01(agent.boredom - 0.35);
  }
}

function drawWorld(world, agent) {
  const ctx = world.ctx;

  // Background
  ctx.fillStyle = "#f6f5f3";
  ctx.fillRect(0, 0, world.width, world.height);

  // Subtle boundary (world is the whole interface).
  ctx.strokeStyle = "rgba(30, 30, 30, 0.12)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, world.width - 2, world.height - 2);

  // LOS wedge (triangle projecting to the edges).
  const half = agent.fov * 0.5;
  const a1 = agent.heading - half;
  const a2 = agent.heading + half;
  const p1 = rayRectIntersection(agent.x, agent.y, Math.cos(a1), Math.sin(a1), world.width, world.height);
  const p2 = rayRectIntersection(agent.x, agent.y, Math.cos(a2), Math.sin(a2), world.width, world.height);

  ctx.beginPath();
  ctx.moveTo(agent.x, agent.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.fillStyle = "rgba(60, 80, 110, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(60, 80, 110, 0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Objects
  if (world.fruit) {
    ctx.beginPath();
    ctx.arc(world.fruit.x, world.fruit.y, world.fruit.r, 0, TAU);
    ctx.fillStyle = "#ffcc33";
    ctx.fill();
    ctx.strokeStyle = "rgba(20,20,20,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (world.threat) {
    ctx.beginPath();
    ctx.arc(world.threat.x, world.threat.y, world.threat.r, 0, TAU);
    ctx.fillStyle = "#3b2230";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,90,82,0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Agent: emotion pie fill.
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

  // Outer ring subtly reflects dominant emotion.
  let dom = slices[0];
  for (const s of slices) if (s.p > dom.p) dom = s;
  const ring = mixColors("#101010", dom.color, 0.35);
  ctx.beginPath();
  ctx.arc(agent.x, agent.y, agent.r, 0, TAU);
  ctx.strokeStyle = ring;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Heading notch.
  ctx.beginPath();
  ctx.moveTo(agent.x, agent.y);
  ctx.lineTo(agent.x + Math.cos(agent.heading) * (agent.r + 10), agent.y + Math.sin(agent.heading) * (agent.r + 10));
  ctx.strokeStyle = "rgba(16,16,16,0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Action label (small, keeps the interface clean).
  const label =
    agent.mode === "MANUAL"
      ? "manual"
      : agent.intent.sub
        ? `${agent.intent.id}/${agent.intent.sub}`.toLowerCase()
        : agent.intent.id.toLowerCase();
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(10,10,10,0.7)";
  ctx.fillText(label, agent.x, agent.y - agent.r - 14);

  if (world.showHelp) {
    drawHelp(world, agent);
  } else if (world.debug) {
    drawDebug(world, agent);
  }
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawHelp(world, agent) {
  const ctx = world.ctx;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.10)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, 12, 12, 360, 112, 12);
  ctx.fill();
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(10,10,10,0.78)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  const lines = [
    `v1.1  |  Agent: ${agent.profile.name}  |  mode: ${agent.mode}`,
    "Click: fruit   Shift+Click: threat (juggernaut)",
    "M: manual (WASD)   D: debug   H: help",
    "Watch: committed intent + forward planning + look-backs + mistakes.",
  ];
  let y = 32;
  for (const line of lines) {
    ctx.fillText(line, 24, y);
    y += 22;
  }
  ctx.restore();
}

function drawDebug(world, agent) {
  const ctx = world.ctx;
  const slices = getEmotionPie(agent);

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.10)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, 12, 12, 520, 218, 12);
  ctx.fill();
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(10,10,10,0.78)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const now = world.time;
  const hunger = 1 - agent.energy;
  const commitLeft = Math.max(0, agent.intent.commitUntil - now);
  const checkpointLeft = Math.max(0, agent.plan.nextPlanCheckpointAt - now);
  const next = agent.plan.nextIntents.length ? agent.plan.nextIntents.join("->").toLowerCase() : "-";
  const slip = agent.errorModel.exec.slipKind ? agent.errorModel.exec.slipKind.toLowerCase() : "-";
  const lines = [
    `intent=${agent.mode === "MANUAL" ? "manual" : `${agent.intent.id}/${agent.intent.sub}`.toLowerCase()}  commit=${commitLeft.toFixed(1)}s  arousal=${agent.arousal.state.toLowerCase()}  dq=${agent.decisionQuality.toFixed(2)}  slip=${slip}`,
    `plan depth=${agent.plan.depthChosen}  conf=${agent.plan.planConfidence.toFixed(2)}  checkpoint=${checkpointLeft.toFixed(1)}s  next=${next}`,
    `threat prox=${agent.sensors.threat.prox.toFixed(2)}  pursuit=${agent.arousal.pursuitConfidence.toFixed(2)}  uncertainty=${agent.sensors.uncertainty.toFixed(2)}  seen=${agent.sensors.threat.visible ? "Y" : "N"}`,
    `fruit known=${agent.sensors.fruit.known ? "Y" : "N"}  seen=${agent.sensors.fruit.visible ? "Y" : "N"}  beliefQ=${agent.belief.fruit.quality.toFixed(2)}/${agent.belief.threat.quality.toFixed(2)}`,
    `energy=${agent.energy.toFixed(2)} hunger=${hunger.toFixed(2)} boredom=${agent.boredom.toFixed(2)} stress=${agent.stress.toFixed(2)}`,
    `emotions (pie %): ${slices.map((s) => `${s.id}=${Math.round(s.p * 100)}`).join("  ")}`,
  ];
  let y = 34;
  for (const line of lines) {
    ctx.fillText(line, 24, y);
    y += 22;
  }
  ctx.restore();
}

function setup() {
  const canvas = document.getElementById("world");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing #world canvas");

  const world = makeWorld(canvas);
  const input = { up: false, down: false, left: false, right: false };

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

  const agent = makeAgent(world);

  // Spawn a default fruit + threat to make the AI immediately "readable".
  world.fruit = { x: world.width * 0.78, y: world.height * 0.28, r: 10 };
  world.threat = { x: world.width * 0.2, y: world.height * 0.25, r: 26, speed: 62 };

  canvas.addEventListener("pointerdown", (e) => {
    const p = worldToCanvas(world, e.clientX, e.clientY);
    if (e.shiftKey) {
      world.threat = { x: p.x, y: p.y, r: 26, speed: 62 };
    } else {
      world.fruit = { x: p.x, y: p.y, r: 10 };
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "w" || e.key === "ArrowUp") input.up = true;
    if (e.key === "s" || e.key === "ArrowDown") input.down = true;
    if (e.key === "a" || e.key === "ArrowLeft") input.left = true;
    if (e.key === "d" || e.key === "ArrowRight") input.right = true;

    if (e.key === "m" || e.key === "M") agent.mode = agent.mode === "AI" ? "MANUAL" : "AI";
    if (e.key === "d" || e.key === "D") world.debug = !world.debug;
    if (e.key === "h" || e.key === "H") world.showHelp = !world.showHelp;
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "w" || e.key === "ArrowUp") input.up = false;
    if (e.key === "s" || e.key === "ArrowDown") input.down = false;
    if (e.key === "a" || e.key === "ArrowLeft") input.left = false;
    if (e.key === "d" || e.key === "ArrowRight") input.right = false;
  });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    world.time += dt;

    // Update simulation
    resetFrameEvents(agent);
    updateSensors(world, agent);
    updateArousal(world, agent, dt);
    updateDrives(world, agent, dt);
    updateDecisionQuality(agent, dt);
    updateErrorModel(world, agent, dt);
    updateBeliefs(world, agent, dt);
    updateEmotions(world, agent, dt);

    moveAgent(world, agent, dt, input);
    resolveFruit(world, agent);
    updateThreat(world, agent, dt);

    // Render
    drawWorld(world, agent);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

setup();
