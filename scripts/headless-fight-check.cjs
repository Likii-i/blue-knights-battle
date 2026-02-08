#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MBTI_ORDER = [
  "ISTJ", "ISFJ", "INFJ", "INTJ",
  "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP",
  "ESTJ", "ESFJ", "ENFJ", "ENTJ",
];

const DEFENSIVE_TACTICS = new Set(["OPEN_UP", "RETREAT_LONG", "RETREAT_SHORT", "RESET", "BLOCK"]);
const AGGRO_TACTICS = new Set(["ATTACK", "PRESSURE", "CLASH"]);
const TACTIC_IDS = ["OPEN_UP", "RETREAT_LONG", "RETREAT_SHORT", "PRESSURE", "ATTACK", "BLOCK", "CLASH", "RESET"];

let BUNDLE_CACHE = null;

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) & 0xffffffff) / 0x100000000;
  };
}

function makeNoopCtx() {
  const target = {
    canvas: null,
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (!(prop in obj)) obj[prop] = () => {};
      return obj[prop];
    },
    set(obj, prop, value) {
      obj[prop] = value;
      return true;
    },
  });
}

function stripModuleSyntaxProfiles(src) {
  return src
    .replace(/^\s*export\s+\{[^}]+\};?\s*$/gm, "")
    .replace(/\bexport\s+function\b/g, "function")
    .replace(/\bexport\s+const\b/g, "const")
    .replace(/\bexport\s+let\b/g, "let")
    .replace(/\bexport\s+class\b/g, "class");
}

function stripModuleSyntaxEngine(src) {
  return src
    .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+function\b/g, "function")
    .replace(/\bexport\s+const\b/g, "const")
    .replace(/\bexport\s+let\b/g, "let")
    .replace(/\bexport\s+class\b/g, "class");
}

function stripMainImports(src) {
  return src.replace(/^\s*import\s+[^;]+;\s*$/gm, "");
}

function buildHeadlessBundle() {
  if (BUNDLE_CACHE) return BUNDLE_CACHE;
  const cwd = process.cwd();
  const profilesSrc = fs.readFileSync(path.join(cwd, "src/personality/mbti-profiles.js"), "utf8");
  const engineSrc = fs.readFileSync(path.join(cwd, "src/personality/mbti-engine.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(cwd, "src/main.js"), "utf8");

  const cleanProfiles = stripModuleSyntaxProfiles(profilesSrc);
  const cleanEngine = stripModuleSyntaxEngine(engineSrc);
  const cleanMain = stripMainImports(mainSrc);

  BUNDLE_CACHE = `
"use strict";
const __mbtiProfiles = (() => {
${cleanProfiles}
  return { MBTI_ORDER, TACTICS, SCENES, PROFILE_BY_TYPE, resolveMbtiProfile, nextMbtiType };
})();
const __mbtiEngine = (() => {
  const { resolveMbtiProfile, nextMbtiType, TACTICS, SCENES } = __mbtiProfiles;
${cleanEngine}
  return { initMbtiAgent, cycleMbtiAgent, updateMbtiAdaptation, getMbtiBias };
})();
const { MBTI_ORDER } = __mbtiProfiles;
const { initMbtiAgent, cycleMbtiAgent, updateMbtiAdaptation, getMbtiBias } = __mbtiEngine;
${cleanMain}
`;
  return BUNDLE_CACHE;
}

function normalizeType(typeId, fallback = "ENFP") {
  const v = String(typeId || fallback).toUpperCase();
  return MBTI_ORDER.includes(v) ? v : fallback;
}

function parseListArg(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseTypesArg(raw, fallback = MBTI_ORDER) {
  const list = parseListArg(raw).map((x) => x.toUpperCase());
  if (!list.length) return [...fallback];
  const uniq = [];
  for (const t of list) {
    if (!MBTI_ORDER.includes(t)) {
      throw new Error(`Unknown MBTI type "${t}". Expected one of: ${MBTI_ORDER.join(", ")}`);
    }
    if (!uniq.includes(t)) uniq.push(t);
  }
  return uniq;
}

function finiteJug(j) {
  if (!j) return true;
  return (
    Number.isFinite(j.x) &&
    Number.isFinite(j.y) &&
    Number.isFinite(j.vx) &&
    Number.isFinite(j.vy)
  );
}

function finiteAgent(ag) {
  if (!ag) return true;
  return (
    Number.isFinite(ag.x) &&
    Number.isFinite(ag.y) &&
    Number.isFinite(ag.vx) &&
    Number.isFinite(ag.vy) &&
    Number.isFinite(ag.motor?.desiredVx) &&
    Number.isFinite(ag.motor?.desiredVy) &&
    Number.isFinite(ag.avoid?.vx) &&
    Number.isFinite(ag.avoid?.vy) &&
    Number.isFinite(ag.emotions?.fear) &&
    Number.isFinite(ag.senses?.jug?.beliefDist) &&
    Number.isFinite(ag.senses?.jug?.quality) &&
    Number.isFinite(ag.gaze?.glance?.speedMul) &&
    Number.isFinite(ag.gaze?.glance?.accelMul)
  );
}

function runScenario(seed, frames = 2400, dtMs = 1000 / 60, opts = null) {
  const trace = Boolean(opts?.trace);
  const rng = makeRng(seed);
  const math = Object.create(Math);
  math.random = rng;

  let perfNow = 0;
  let worldRef = null;
  let rafCallback = null;
  let rafId = 0;
  let nanStep = -1;
  let nanPhase = "";
  let nanDump = null;

  class HTMLCanvasElement {}
  const ctx = makeNoopCtx();
  class FakeCanvas extends HTMLCanvasElement {
    constructor() {
      super();
      this.width = 900;
      this.height = 900;
      ctx.canvas = this;
    }

    getContext() {
      return ctx;
    }

    addEventListener() {}

    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width, height: this.height };
    }
  }
  const canvas = new FakeCanvas();

  const metrics = {
    frames: 0,
    closeCombatFrames: 0,
    directContactFrames: 0,
    exchangeIntentFrames: 0,
    attackOrPressureFrames: 0,
    activeWindupFrames: 0,
    jugTouchFrames: 0,
    jugPushFrames: 0,
    baitSetupFrames: 0,
    defensiveStallFrames: 0,
    postExchangeFrames: 0,
    postExchangeDefensiveFrames: 0,
    postExchangeAggressiveFrames: 0,
    exchangeBursts: 0,
    totalHpLoss: 0,
    tacticFramesA: Object.create(null),
    tacticFramesB: Object.create(null),
  };
  let firstDamageSeen = false;
  let prevExchangeIntent = false;
  let prevHpA = 100;
  let prevHpB = 100;
  let prevTacticA = "";
  let prevTacticB = "";
  let prevWindupA = false;
  let prevWindupB = false;
  const events = [];
  const initA = { x: 0, y: 0 };
  const initB = { x: 0, y: 0 };

  function tacticCount(map, id) {
    const key = String(id || "NONE");
    map[key] = (map[key] || 0) + 1;
  }

  function checkNaN(world, phase) {
    const agA = world?.agents?.[0];
    const agB = world?.agents?.[1];
    if (finiteAgent(agA) && finiteAgent(agB) && finiteJug(world?.juggernaut)) return false;
    nanStep = metrics.frames;
    nanPhase = phase;
    nanDump = {
      time: world?.time,
      phase,
      a: {
        x: agA?.x, y: agA?.y, vx: agA?.vx, vy: agA?.vy, tactic: agA?.tactic,
        target: agA?.nav?.target, kind: agA?.nav?.kind, dJ: agA?.senses?.jug?.beliefDist, qJ: agA?.senses?.jug?.quality,
        motor: { vx: agA?.motor?.desiredVx, vy: agA?.motor?.desiredVy },
        avoid: { vx: agA?.avoid?.vx, vy: agA?.avoid?.vy },
        fear: agA?.emotions?.fear,
        glance: { speedMul: agA?.gaze?.glance?.speedMul, accelMul: agA?.gaze?.glance?.accelMul },
      },
      b: {
        x: agB?.x, y: agB?.y, vx: agB?.vx, vy: agB?.vy, tactic: agB?.tactic,
        target: agB?.nav?.target, kind: agB?.nav?.kind, dJ: agB?.senses?.jug?.beliefDist, qJ: agB?.senses?.jug?.quality,
        motor: { vx: agB?.motor?.desiredVx, vy: agB?.motor?.desiredVy },
        avoid: { vx: agB?.avoid?.vx, vy: agB?.avoid?.vy },
        fear: agB?.emotions?.fear,
        glance: { speedMul: agB?.gaze?.glance?.speedMul, accelMul: agB?.gaze?.glance?.accelMul },
      },
      j: {
        x: world?.juggernaut?.x,
        y: world?.juggernaut?.y,
        vx: world?.juggernaut?.vx,
        vy: world?.juggernaut?.vy,
        target: world?.juggernaut?.agenda?.targetId,
      },
    };
    return true;
  }

  function sampleWorld(world) {
    const [a, b] = world.agents;
    const j = world.juggernaut;
    if (!a || !b || !j) return;
    metrics.frames += 1;

    const dO = Math.hypot(a.x - b.x, a.y - b.y);
    const hitRange = a.r + b.r + 14;
    const bodyRange = a.r + b.r + 2;

    if (dO < hitRange * 1.08) metrics.closeCombatFrames += 1;
    if (dO < bodyRange) metrics.directContactFrames += 1;

    const aAgg = AGGRO_TACTICS.has(a.tactic);
    const bAgg = AGGRO_TACTICS.has(b.tactic);
    const exchangeIntent = dO < hitRange * 1.2 && (aAgg || bAgg);
    if (exchangeIntent) metrics.exchangeIntentFrames += 1;
    if (exchangeIntent && !prevExchangeIntent) metrics.exchangeBursts += 1;
    prevExchangeIntent = exchangeIntent;

    if (aAgg || bAgg) metrics.attackOrPressureFrames += 1;
    if ((a.attackWindupUntil > world.time) || (b.attackWindupUntil > world.time)) metrics.activeWindupFrames += 1;

    tacticCount(metrics.tacticFramesA, a.tactic);
    tacticCount(metrics.tacticFramesB, b.tactic);
    const bothDefensive = DEFENSIVE_TACTICS.has(a.tactic) && DEFENSIVE_TACTICS.has(b.tactic);
    const anyWindup = a.attackWindupUntil > world.time || b.attackWindupUntil > world.time;
    if (bothDefensive && !anyWindup && dO > hitRange * 1.35) metrics.defensiveStallFrames += 1;

    const dJA = Math.hypot(a.x - j.x, a.y - j.y);
    const dJB = Math.hypot(b.x - j.x, b.y - j.y);
    const touchA = dJA < a.r + j.r + 8;
    const touchB = dJB < b.r + j.r + 8;
    if (touchA || touchB) metrics.jugTouchFrames += 1;

    const speedA = Math.hypot(a.vx, a.vy);
    const speedB = Math.hypot(b.vx, b.vy);
    const toJA = { x: (j.x - a.x) / Math.max(1e-6, dJA), y: (j.y - a.y) / Math.max(1e-6, dJA) };
    const toJB = { x: (j.x - b.x) / Math.max(1e-6, dJB), y: (j.y - b.y) / Math.max(1e-6, dJB) };
    const pushA = a.vx * toJA.x + a.vy * toJA.y;
    const pushB = b.vx * toJB.x + b.vy * toJB.y;
    if ((touchA && speedA < 26 && pushA > 4) || (touchB && speedB < 26 && pushB > 4)) metrics.jugPushFrames += 1;

    const aBait = (a.nav?.objectives?.bait ?? 0) > 0.45;
    const bBait = (b.nav?.objectives?.bait ?? 0) > 0.45;
    const safeA = dJA > (a.r + j.r + 70);
    const safeB = dJB > (b.r + j.r + 70);
    if ((aBait || bBait) && dO > 130 && dO < 320 && safeA && safeB) metrics.baitSetupFrames += 1;

    let damageThisFrame = 0;
    if (a.hp < prevHpA) damageThisFrame += (prevHpA - a.hp);
    if (b.hp < prevHpB) damageThisFrame += (prevHpB - b.hp);
    metrics.totalHpLoss += damageThisFrame;

    if (damageThisFrame > 0) firstDamageSeen = true;
    if (firstDamageSeen) {
      metrics.postExchangeFrames += 1;
      if (bothDefensive) metrics.postExchangeDefensiveFrames += 1;
      if (aAgg || bAgg) metrics.postExchangeAggressiveFrames += 1;
    }

    if (trace) {
      const t = world.time.toFixed(2);
      if (a.tactic !== prevTacticA) events.push(`t=${t} A(${a.mbti?.typeId ?? "?"}) tactic ${prevTacticA || "-"} -> ${a.tactic}`);
      if (b.tactic !== prevTacticB) events.push(`t=${t} B(${b.mbti?.typeId ?? "?"}) tactic ${prevTacticB || "-"} -> ${b.tactic}`);
      const windA = a.attackWindupUntil > world.time;
      const windB = b.attackWindupUntil > world.time;
      if (windA && !prevWindupA) events.push(`t=${t} A windup @dO=${dO.toFixed(1)}`);
      if (windB && !prevWindupB) events.push(`t=${t} B windup @dO=${dO.toFixed(1)}`);
      if (a.hp < prevHpA) events.push(`t=${t} A took ${(prevHpA - a.hp).toFixed(1)} (hp=${a.hp.toFixed(1)})`);
      if (b.hp < prevHpB) events.push(`t=${t} B took ${(prevHpB - b.hp).toFixed(1)} (hp=${b.hp.toFixed(1)})`);
      prevTacticA = a.tactic;
      prevTacticB = b.tactic;
      prevWindupA = windA;
      prevWindupB = windB;
    }
    prevHpA = a.hp;
    prevHpB = b.hp;
  }

  const context = {
    Math: math,
    Date,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isFinite,
    performance: { now: () => perfNow },
    fetch: async () => ({ ok: true }),
    HTMLCanvasElement,
    document: {
      getElementById(id) {
        return id === "world" ? canvas : null;
      },
    },
    window: {
      innerWidth: 900,
      innerHeight: 900,
      devicePixelRatio: 1,
      addEventListener() {},
    },
    __SIM_CONFIG__: opts?.agentTypes ? { agentTypes: opts.agentTypes } : undefined,
    __SIM_HOOK__: {
      onWorld(world) {
        worldRef = world;
        initA.x = world.agents?.[0]?.x ?? 0;
        initA.y = world.agents?.[0]?.y ?? 0;
        initB.x = world.agents?.[1]?.x ?? 0;
        initB.y = world.agents?.[1]?.y ?? 0;
      },
      onFrame(world) {
        sampleWorld(world);
        if (nanStep < 0) checkNaN(world, "frame");
      },
    },
  };

  context.requestAnimationFrame = (cb) => {
    rafCallback = cb;
    rafId += 1;
    return rafId;
  };
  context.cancelAnimationFrame = () => {};
  context.window.requestAnimationFrame = context.requestAnimationFrame;
  context.window.cancelAnimationFrame = context.cancelAnimationFrame;
  context.globalThis = context;

  const src = buildHeadlessBundle();
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "headless-bundle.js" });

  if (!worldRef) throw new Error("Simulation world was not captured");
  if (typeof rafCallback !== "function") throw new Error("Simulation frame callback was not scheduled");

  for (let i = 0; i < frames; i++) {
    if (typeof rafCallback !== "function") break;
    const cb = rafCallback;
    rafCallback = null;
    perfNow += dtMs;
    cb(perfNow);
    if (nanStep >= 0) break;
  }

  const denom = Math.max(1, metrics.frames);
  const postDenom = Math.max(1, metrics.postExchangeFrames);
  function tacticShare(map, key) {
    return (map[key] ?? 0) / denom;
  }
  const defensiveShareA = [...DEFENSIVE_TACTICS].reduce((sum, id) => sum + tacticShare(metrics.tacticFramesA, id), 0);
  const defensiveShareB = [...DEFENSIVE_TACTICS].reduce((sum, id) => sum + tacticShare(metrics.tacticFramesB, id), 0);
  const aggressiveShareA = [...AGGRO_TACTICS].reduce((sum, id) => sum + tacticShare(metrics.tacticFramesA, id), 0);
  const aggressiveShareB = [...AGGRO_TACTICS].reduce((sum, id) => sum + tacticShare(metrics.tacticFramesB, id), 0);

  return {
    seed,
    mbtiA: worldRef.agents?.[0]?.mbti?.typeId ?? opts?.agentTypes?.A ?? "ENFP",
    mbtiB: worldRef.agents?.[1]?.mbti?.typeId ?? opts?.agentTypes?.B ?? "ENTP",
    frames: metrics.frames,
    worldW: worldRef.width,
    worldH: worldRef.height,
    nanStep,
    nanPhase,
    nanDump,
    moveA: Math.hypot((worldRef.agents[0]?.x ?? 0) - initA.x, (worldRef.agents[0]?.y ?? 0) - initA.y),
    moveB: Math.hypot((worldRef.agents[1]?.x ?? 0) - initB.x, (worldRef.agents[1]?.y ?? 0) - initB.y),
    closeCombatRate: metrics.closeCombatFrames / denom,
    directContactRate: metrics.directContactFrames / denom,
    exchangeIntentRate: metrics.exchangeIntentFrames / denom,
    attackOrPressureRate: metrics.attackOrPressureFrames / denom,
    windupRate: metrics.activeWindupFrames / denom,
    jugTouchRate: metrics.jugTouchFrames / denom,
    jugPushRate: metrics.jugPushFrames / denom,
    baitSetupRate: metrics.baitSetupFrames / denom,
    defensiveStallRate: metrics.defensiveStallFrames / denom,
    postExchangeCoverage: metrics.postExchangeFrames / denom,
    postExchangeDefensiveRate: metrics.postExchangeDefensiveFrames / postDenom,
    postExchangeAggressiveRate: metrics.postExchangeAggressiveFrames / postDenom,
    exchangeBursts: metrics.exchangeBursts,
    defensiveShareA,
    defensiveShareB,
    aggressiveShareA,
    aggressiveShareB,
    tacticShareA: Object.fromEntries(TACTIC_IDS.map((id) => [id, tacticShare(metrics.tacticFramesA, id)])),
    tacticShareB: Object.fromEntries(TACTIC_IDS.map((id) => [id, tacticShare(metrics.tacticFramesB, id)])),
    totalHpLoss: metrics.totalHpLoss,
    finalHpA: worldRef.agents[0]?.hp ?? 0,
    finalHpB: worldRef.agents[1]?.hp ?? 0,
    events,
  };
}

function avg(list, key) {
  if (!list.length) return 0;
  return list.reduce((sum, item) => sum + (item[key] ?? 0), 0) / list.length;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function summarizeRuns(runs) {
  const summary = {
    frames: avg(runs, "frames"),
    closeCombatRate: avg(runs, "closeCombatRate"),
    directContactRate: avg(runs, "directContactRate"),
    exchangeIntentRate: avg(runs, "exchangeIntentRate"),
    attackOrPressureRate: avg(runs, "attackOrPressureRate"),
    windupRate: avg(runs, "windupRate"),
    jugTouchRate: avg(runs, "jugTouchRate"),
    jugPushRate: avg(runs, "jugPushRate"),
    baitSetupRate: avg(runs, "baitSetupRate"),
    defensiveStallRate: avg(runs, "defensiveStallRate"),
    postExchangeCoverage: avg(runs, "postExchangeCoverage"),
    postExchangeDefensiveRate: avg(runs, "postExchangeDefensiveRate"),
    postExchangeAggressiveRate: avg(runs, "postExchangeAggressiveRate"),
    exchangeBursts: avg(runs, "exchangeBursts"),
    defensiveShareA: avg(runs, "defensiveShareA"),
    defensiveShareB: avg(runs, "defensiveShareB"),
    aggressiveShareA: avg(runs, "aggressiveShareA"),
    aggressiveShareB: avg(runs, "aggressiveShareB"),
    totalHpLoss: avg(runs, "totalHpLoss"),
    nanCount: runs.filter((run) => run.nanStep >= 0).length,
  };
  return summary;
}

function evaluateChecks(summary, mode = "single") {
  const checks = [];
  if (mode === "single") {
    checks.push({ name: "closeCombatRate >= 5%", pass: summary.closeCombatRate >= 0.05 });
    checks.push({ name: "exchangeIntentRate >= 3%", pass: summary.exchangeIntentRate >= 0.03 });
    checks.push({ name: "directContactRate >= 1.5%", pass: summary.directContactRate >= 0.015 });
    checks.push({ name: "jugPushRate <= 1.0%", pass: summary.jugPushRate <= 0.01 });
    checks.push({ name: "baitSetupRate >= 4%", pass: summary.baitSetupRate >= 0.04 });
    checks.push({ name: "defensiveStallRate <= 65%", pass: summary.defensiveStallRate <= 0.65 });
    checks.push({ name: "postExchangeAggressiveRate >= 15%", pass: summary.postExchangeAggressiveRate >= 0.15 });
    checks.push({ name: "totalHpLoss >= 18", pass: summary.totalHpLoss >= 18 });
    checks.push({ name: "nanCount == 0", pass: summary.nanCount === 0 });
    return checks;
  }

  const hpLossFloor = Math.max(8, (summary.frames || 0) * 0.005);
  checks.push({ name: "exchangeIntentRate >= 2.5%", pass: summary.exchangeIntentRate >= 0.025 });
  checks.push({ name: "directContactRate >= 0.5%", pass: summary.directContactRate >= 0.005 });
  checks.push({ name: "jugPushRate <= 1.5%", pass: summary.jugPushRate <= 0.015 });
  checks.push({ name: "defensiveStallRate <= 75%", pass: summary.defensiveStallRate <= 0.75 });
  checks.push({ name: `totalHpLoss >= ${hpLossFloor.toFixed(1)}`, pass: summary.totalHpLoss >= hpLossFloor });
  checks.push({ name: "nanCount == 0", pass: summary.nanCount === 0 });
  if (summary.postExchangeCoverage >= 0.15) {
    checks.push({ name: "postExchangeAggressiveRate >= 8%", pass: summary.postExchangeAggressiveRate >= 0.08 });
    checks.push({ name: "postExchangeDefensiveRate <= 90%", pass: summary.postExchangeDefensiveRate <= 0.9 });
  }
  return checks;
}

function printSingleRun(run) {
  console.log(
    `seed=${run.seed} types=${run.mbtiA}/${run.mbtiB} world=${run.worldW}x${run.worldH} nanStep=${run.nanStep} ` +
    `move=(${run.moveA.toFixed(1)},${run.moveB.toFixed(1)}) close=${pct(run.closeCombatRate)} contact=${pct(run.directContactRate)} ` +
    `intent=${pct(run.exchangeIntentRate)} aggro=${pct(run.attackOrPressureRate)} windup=${pct(run.windupRate)} ` +
    `stall=${pct(run.defensiveStallRate)} postAgg=${pct(run.postExchangeAggressiveRate)} postDef=${pct(run.postExchangeDefensiveRate)} ` +
    `jugTouch=${pct(run.jugTouchRate)} jugPush=${pct(run.jugPushRate)} bait=${pct(run.baitSetupRate)} ` +
    `bursts=${run.exchangeBursts} hpLoss=${run.totalHpLoss.toFixed(1)} final=(${run.finalHpA.toFixed(1)},${run.finalHpB.toFixed(1)})`,
  );
  if (run.nanDump) {
    console.log(`  nanPhase=${run.nanPhase}`);
    console.log(`  nanDump=${JSON.stringify(run.nanDump)}`);
  }
}

function parseArgs(argv) {
  const arg = (name) => {
    const prefix = `--${name}=`;
    const item = [...argv].reverse().find((x) => x.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
  };
  const has = (name) => argv.includes(`--${name}`);
  const framesRaw = Number(arg("frames"));
  const frames = Number.isFinite(framesRaw) && framesRaw >= 300 ? Math.floor(framesRaw) : 2400;
  const dtRaw = Number(arg("dt"));
  const dtMs = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : (1000 / 60);
  const seeds = parseListArg(arg("seeds")).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0);
  const seedList = seeds.length ? seeds : [11, 29, 47];
  const mbtiA = normalizeType(arg("a"), "ENFP");
  const mbtiB = normalizeType(arg("b"), "ENTP");
  const types = parseTypesArg(arg("types"), MBTI_ORDER);

  return {
    trace: has("trace"),
    matrix: has("matrix"),
    matrixVerbose: has("matrix-verbose"),
    frames,
    dtMs,
    seeds: seedList,
    mbtiA,
    mbtiB,
    types,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.matrix) {
    const runs = opts.seeds.map((seed) => runScenario(seed, opts.frames, opts.dtMs, {
      trace: opts.trace,
      agentTypes: { A: opts.mbtiA, B: opts.mbtiB },
    }));
    for (const run of runs) {
      printSingleRun(run);
      if (opts.trace && run.events.length) {
        console.log("  trace");
        for (const line of run.events.slice(0, 80)) console.log(`  - ${line}`);
        if (run.events.length > 80) console.log(`  - ... (${run.events.length - 80} more)`);
      }
    }

    const summary = summarizeRuns(runs);
    console.log("\nsummary");
    console.log(
      `types=${opts.mbtiA}/${opts.mbtiB} close=${pct(summary.closeCombatRate)} contact=${pct(summary.directContactRate)} ` +
      `intent=${pct(summary.exchangeIntentRate)} aggro=${pct(summary.attackOrPressureRate)} windup=${pct(summary.windupRate)} ` +
      `stall=${pct(summary.defensiveStallRate)} postAgg=${pct(summary.postExchangeAggressiveRate)} postDef=${pct(summary.postExchangeDefensiveRate)} ` +
      `jugTouch=${pct(summary.jugTouchRate)} jugPush=${pct(summary.jugPushRate)} bait=${pct(summary.baitSetupRate)} ` +
      `bursts=${summary.exchangeBursts.toFixed(2)} hpLoss=${summary.totalHpLoss.toFixed(1)} nan=${summary.nanCount}`,
    );

    const checks = evaluateChecks(summary, "single");
    console.log("\nchecks");
    for (const c of checks) console.log(`- ${c.pass ? "PASS" : "FAIL"} ${c.name}`);
    process.exitCode = checks.some((c) => !c.pass) ? 1 : 0;
    return;
  }

  const pairResults = [];
  for (const a of opts.types) {
    for (const b of opts.types) {
      const runs = opts.seeds.map((seed) => runScenario(seed, opts.frames, opts.dtMs, {
        trace: false,
        agentTypes: { A: a, B: b },
      }));
      const summary = summarizeRuns(runs);
      const checks = evaluateChecks(summary, "matrix");
      const failed = checks.filter((c) => !c.pass);
      pairResults.push({ a, b, summary, checks, failed });
      if (opts.matrixVerbose || failed.length) {
        const status = failed.length ? "FAIL" : "PASS";
        console.log(
          `${status} ${a}/${b} intent=${pct(summary.exchangeIntentRate)} contact=${pct(summary.directContactRate)} ` +
          `stall=${pct(summary.defensiveStallRate)} postAgg=${pct(summary.postExchangeAggressiveRate)} ` +
          `jugPush=${pct(summary.jugPushRate)} hpLoss=${summary.totalHpLoss.toFixed(1)} nan=${summary.nanCount}`,
        );
      }
    }
  }

  const totalPairs = pairResults.length;
  const failedPairs = pairResults.filter((p) => p.failed.length);
  const passPairs = totalPairs - failedPairs.length;

  const aggregate = summarizeRuns(pairResults.map((p) => p.summary));
  console.log("\nmatrix-summary");
  console.log(
    `pairs=${totalPairs} pass=${passPairs} fail=${failedPairs.length} ` +
    `intent=${pct(aggregate.exchangeIntentRate)} contact=${pct(aggregate.directContactRate)} ` +
    `stall=${pct(aggregate.defensiveStallRate)} postAgg=${pct(aggregate.postExchangeAggressiveRate)} ` +
    `jugPush=${pct(aggregate.jugPushRate)} hpLoss=${aggregate.totalHpLoss.toFixed(1)} nan=${aggregate.nanCount}`,
  );

  if (failedPairs.length) {
    console.log("\nworst-pairs");
    const ranked = [...failedPairs].sort((x, y) => {
      const xi = x.summary.exchangeIntentRate + x.summary.directContactRate + x.summary.postExchangeAggressiveRate - x.summary.defensiveStallRate;
      const yi = y.summary.exchangeIntentRate + y.summary.directContactRate + y.summary.postExchangeAggressiveRate - y.summary.defensiveStallRate;
      return xi - yi;
    });
    for (const row of ranked.slice(0, 12)) {
      const reasons = row.failed.map((f) => f.name).join("; ");
      console.log(
        `- ${row.a}/${row.b}: intent=${pct(row.summary.exchangeIntentRate)} contact=${pct(row.summary.directContactRate)} ` +
        `stall=${pct(row.summary.defensiveStallRate)} postAgg=${pct(row.summary.postExchangeAggressiveRate)} ` +
        `jugPush=${pct(row.summary.jugPushRate)} hpLoss=${row.summary.totalHpLoss.toFixed(1)} | ${reasons}`,
      );
    }
  }

  process.exitCode = failedPairs.length ? 1 : 0;
}

main();
