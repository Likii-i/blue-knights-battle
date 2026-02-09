#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

function runScenario(seed, frames = 2400, dtMs = 1000 / 60, opts = null) {
  const trace = Boolean(opts?.trace);
  const rng = makeRng(seed);
  const math = Object.create(Math);
  math.random = rng;

  let perfNow = 0;
  let worldRef = null;

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
    totalHpLoss: 0,
  };
  let prevHpA = 100;
  let prevHpB = 100;
  let prevTacticA = "";
  let prevTacticB = "";
  let prevWindupA = false;
  let prevWindupB = false;
  const events = [];

  function sampleWorld(world) {
    const [a, b] = world.agents;
    const j = world.juggernaut;
    if (!a || !b || !j) return;
    metrics.frames += 1;

    const dO = Math.hypot(a.x - b.x, a.y - b.y);
    const hitRange = a.r + b.r + 10;
    const bodyRange = a.r + b.r + 2;

    if (dO < hitRange * 1.08) metrics.closeCombatFrames += 1;
    if (dO < bodyRange) metrics.directContactFrames += 1;

    const aAgg = a.tactic === "ATTACK" || a.tactic === "PRESSURE" || a.tactic === "CLASH";
    const bAgg = b.tactic === "ATTACK" || b.tactic === "PRESSURE" || b.tactic === "CLASH";
    if (dO < hitRange * 1.2 && (aAgg || bAgg)) metrics.exchangeIntentFrames += 1;
    if (aAgg || bAgg) metrics.attackOrPressureFrames += 1;
    if ((a.attackWindupUntil > world.time) || (b.attackWindupUntil > world.time)) metrics.activeWindupFrames += 1;

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

    if (a.hp < prevHpA) metrics.totalHpLoss += (prevHpA - a.hp);
    if (b.hp < prevHpB) metrics.totalHpLoss += (prevHpB - b.hp);
    if (trace) {
      const t = world.time.toFixed(2);
      if (a.tactic !== prevTacticA) events.push(`t=${t} A tactic ${prevTacticA || "-"} -> ${a.tactic}`);
      if (b.tactic !== prevTacticB) events.push(`t=${t} B tactic ${prevTacticB || "-"} -> ${b.tactic}`);
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
    __SIM_HOOK__: {
      onWorld(world) {
        worldRef = world;
      },
      onFrame() {},
    },
  };

  context.requestAnimationFrame = () => 1;
  context.cancelAnimationFrame = () => {};
  context.window.requestAnimationFrame = context.requestAnimationFrame;
  context.window.cancelAnimationFrame = context.cancelAnimationFrame;
  context.globalThis = context;

  const srcPath = path.join(process.cwd(), "src/main.js");
  const src = fs.readFileSync(srcPath, "utf8");
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "src/main.js" });

  if (!worldRef) throw new Error("Simulation world was not captured");
  const dt = dtMs / 1000;
  const initA = { x: worldRef.agents[0]?.x ?? 0, y: worldRef.agents[0]?.y ?? 0 };
  const initB = { x: worldRef.agents[1]?.x ?? 0, y: worldRef.agents[1]?.y ?? 0 };
  let nanStep = -1;
  let nanPhase = "";
  let nanDump = null;
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
    const fear = ag.emotions?.fear;
    const jugBeliefDist = ag.senses?.jug?.beliefDist;
    const jugQuality = ag.senses?.jug?.quality;
    const glanceSpeed = ag.gaze?.glance?.speedMul;
    const glanceAccel = ag.gaze?.glance?.accelMul;
    return (
      Number.isFinite(ag.x) &&
      Number.isFinite(ag.y) &&
      Number.isFinite(ag.vx) &&
      Number.isFinite(ag.vy) &&
      Number.isFinite(ag.motor?.desiredVx) &&
      Number.isFinite(ag.motor?.desiredVy) &&
      Number.isFinite(ag.avoid?.vx) &&
      Number.isFinite(ag.avoid?.vy) &&
      Number.isFinite(fear) &&
      Number.isFinite(jugBeliefDist) &&
      Number.isFinite(jugQuality) &&
      Number.isFinite(glanceSpeed) &&
      Number.isFinite(glanceAccel)
    );
  }
  function checkNaN(agA, agB, world, step, phase) {
    if (finiteAgent(agA) && finiteAgent(agB) && finiteJug(world.juggernaut)) return false;
    nanStep = step;
    nanPhase = phase;
    nanDump = {
      time: world.time,
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
        x: world.juggernaut?.x,
        y: world.juggernaut?.y,
        vx: world.juggernaut?.vx,
        vy: world.juggernaut?.vy,
        target: world.juggernaut?.agenda?.targetId,
      },
    };
    return true;
  }
  for (let i = 0; i < frames; i++) {
    const world = worldRef;
    world.time += dt;
    perfNow += dtMs;

    context.updateAbilitySystems(world, dt, "pre");
    context.updateJuggernaut(world, dt);

    const j = world.juggernaut;
    const agA = world.agents[0];
    const agB = world.agents[1];
    if (agA && agB && j) {
      context.updatePerception(world, agA, agB, j, dt);
      context.updatePerception(world, agB, agA, j, dt);
      if (checkNaN(agA, agB, world, i, "updatePerception")) break;

      context.maybeAutoCastHobbyAbility(world, agA);
      context.maybeAutoCastHobbyAbility(world, agB);

      context.updateStance(world, agA, agB, j, dt);
      context.updateStance(world, agB, agA, j, dt);
      if (checkNaN(agA, agB, world, i, "updateStance")) break;

      const meleeReach = 10;
      const hitRangeAB = agA.r + agB.r + meleeReach;
      const reactionMin = 0.14;

      function updateInterrupts(agent, opp) {
        const dO = Math.hypot(agent.x - opp.x, agent.y - opp.y);
        const oppSeen =
          agent.senses.opp.visible ||
          agent.senses.opp.peripheral ||
          world.time - agent.senses.opp.lastSeenAt < 0.25;
        if (
          oppSeen &&
          opp.attackWindupUntil > world.time &&
          opp.attackWindupTargetId === agent.id &&
          dO <= hitRangeAB * 1.4
        ) {
          agent.events.oppThreatAt = world.time;
        }

        const c = context.clearance(world, agent.x, agent.y);
        const dJ = Math.hypot(agent.x - j.x, agent.y - j.y);
        const safeDist = context.desiredSafeDistToJug(agent);
        const speed = Math.hypot(agent.vx, agent.vy);
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

      if (world.time >= agA.commitUntil || shouldInterrupt(agA)) context.decideTactic(world, agA, agB, j);
      if (world.time >= agB.commitUntil || shouldInterrupt(agB)) context.decideTactic(world, agB, agA, j);
      if (checkNaN(agA, agB, world, i, "decideTactic")) break;
    }

    const actionsById = Object.create(null);
    if (agA && agB && j) {
      actionsById[agA.id] = context.executeTactic(world, agA, agB, j, dt);
      if (checkNaN(agA, agB, world, i, "executeTactic:A")) break;
      actionsById[agB.id] = context.executeTactic(world, agB, agA, j, dt);
      if (checkNaN(agA, agB, world, i, "executeTactic:B")) break;
    }

    if (agA && agB) context.separate(agA, agB);
    if (agA && j) context.separateMobileStatic(agA, j);
    if (agB && j) context.separateMobileStatic(agB, j);
    if (checkNaN(agA, agB, world, i, "separation")) break;

    context.resolveCombat(world, actionsById);
    if (checkNaN(agA, agB, world, i, "resolveCombat")) break;

    context.updateAbilitySystems(world, dt, "post");
    if (checkNaN(agA, agB, world, i, "updateAbilitySystems")) break;

    if (agA && agB && j) {
      context.updateEmotions(world, agA, agB, j, dt);
      context.updateEmotions(world, agB, agA, j, dt);
      if (checkNaN(agA, agB, world, i, "updateEmotions")) break;
    }

    sampleWorld(world);
  }

  const denom = Math.max(1, metrics.frames);
  return {
    seed,
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

function main() {
  const args = process.argv.slice(2);
  const trace = args.includes("--trace");
  const framesArg = args.find((a) => a.startsWith("--frames="));
  const frames = framesArg ? Math.max(300, Number(framesArg.split("=")[1]) || 2400) : 2400;
  const seeds = [11, 29, 47];
  const runs = seeds.map((seed) => runScenario(seed, frames, 1000 / 60, { trace }));
  for (const run of runs) {
    console.log(
      `seed=${run.seed} world=${run.worldW}x${run.worldH} nanStep=${run.nanStep} move=(${run.moveA.toFixed(1)},${run.moveB.toFixed(1)}) ` +
      `close=${pct(run.closeCombatRate)} contact=${pct(run.directContactRate)} ` +
      `intent=${pct(run.exchangeIntentRate)} aggro=${pct(run.attackOrPressureRate)} windup=${pct(run.windupRate)} ` +
      `jugTouch=${pct(run.jugTouchRate)} jugPush=${pct(run.jugPushRate)} ` +
      `bait=${pct(run.baitSetupRate)} hpLoss=${run.totalHpLoss.toFixed(1)} final=(${run.finalHpA.toFixed(1)},${run.finalHpB.toFixed(1)})`,
    );
    if (run.nanDump) {
      console.log(`  nanPhase=${run.nanPhase}`);
      console.log(`  nanDump=${JSON.stringify(run.nanDump)}`);
    }
    if (trace && run.events.length) {
      console.log("  trace");
      for (const line of run.events.slice(0, 60)) console.log(`  - ${line}`);
      if (run.events.length > 60) console.log(`  - ... (${run.events.length - 60} more)`);
    }
  }

  const summary = {
    closeCombatRate: avg(runs, "closeCombatRate"),
    directContactRate: avg(runs, "directContactRate"),
    exchangeIntentRate: avg(runs, "exchangeIntentRate"),
    attackOrPressureRate: avg(runs, "attackOrPressureRate"),
    windupRate: avg(runs, "windupRate"),
    jugTouchRate: avg(runs, "jugTouchRate"),
    jugPushRate: avg(runs, "jugPushRate"),
    baitSetupRate: avg(runs, "baitSetupRate"),
    totalHpLoss: avg(runs, "totalHpLoss"),
  };

  console.log("\nsummary");
  console.log(
    `close=${pct(summary.closeCombatRate)} contact=${pct(summary.directContactRate)} ` +
    `intent=${pct(summary.exchangeIntentRate)} aggro=${pct(summary.attackOrPressureRate)} windup=${pct(summary.windupRate)} ` +
    `jugTouch=${pct(summary.jugTouchRate)} ` +
    `jugPush=${pct(summary.jugPushRate)} bait=${pct(summary.baitSetupRate)} hpLoss=${summary.totalHpLoss.toFixed(1)}`,
  );

  const checks = [];
  checks.push({ name: "closeCombatRate >= 8%", pass: summary.closeCombatRate >= 0.08 });
  checks.push({ name: "directContactRate >= 1.5%", pass: summary.directContactRate >= 0.015 });
  checks.push({ name: "jugPushRate <= 0.7%", pass: summary.jugPushRate <= 0.007 });
  checks.push({ name: "baitSetupRate >= 4%", pass: summary.baitSetupRate >= 0.04 });
  checks.push({ name: "totalHpLoss >= 80", pass: summary.totalHpLoss >= 80 });

  console.log("\nchecks");
  for (const c of checks) {
    console.log(`- ${c.pass ? "PASS" : "FAIL"} ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  process.exitCode = failed ? 1 : 0;
}

main();
