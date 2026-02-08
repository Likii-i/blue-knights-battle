import { resolveMbtiProfile, nextMbtiType, TACTICS, SCENES } from "./mbti-profiles.js";

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(n) {
  return clamp(n, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function expSmoothing(dt, tau) {
  return 1 - Math.exp(-dt / Math.max(1e-6, tau));
}

function makeMap(keys, value = 0) {
  const out = Object.create(null);
  for (const key of keys) out[key] = value;
  return out;
}

function mergeStyle(base, delta) {
  return {
    riskTolerance: clamp((base.riskTolerance ?? 0.5) + (delta.riskTolerance ?? 0), 0, 1),
    wrapWhenChased: clamp((base.wrapWhenChased ?? 0.25) + (delta.wrapWhenChased ?? 0), 0, 1),
    staminaConserve: clamp((base.staminaConserve ?? 0.45) + (delta.staminaConserve ?? 0), 0, 1),
    engageBias: clamp((base.engageBias ?? 0.55) + (delta.engageBias ?? 0), 0, 1),
    blockDiscipline: clamp((base.blockDiscipline ?? 0.5) + (delta.blockDiscipline ?? 0), 0, 1),
    probeBias: clamp((base.probeBias ?? 0.5) + (delta.probeBias ?? 0), 0, 1),
    commitmentBias: clamp((base.commitmentBias ?? 0.5) + (delta.commitmentBias ?? 0), 0, 1),
    replanBias: clamp((base.replanBias ?? 0.5) + (delta.replanBias ?? 0), 0, 1),
    fairnessBias: clamp((base.fairnessBias ?? 0.5) + (delta.fairnessBias ?? 0), 0, 1),
    intimidationBias: clamp((base.intimidationBias ?? 0.5) + (delta.intimidationBias ?? 0), 0, 1),
    mercyBias: clamp((base.mercyBias ?? 0.45) + (delta.mercyBias ?? 0), 0, 1),
    deceptionBias: clamp((base.deceptionBias ?? 0.5) + (delta.deceptionBias ?? 0), 0, 1),
    patternBias: clamp((base.patternBias ?? 0.5) + (delta.patternBias ?? 0), 0, 1),
    concreteBias: clamp((base.concreteBias ?? 0.5) + (delta.concreteBias ?? 0), 0, 1),
    stressRigidity: clamp((base.stressRigidity ?? 0.45) + (delta.stressRigidity ?? 0), 0, 1),
    stressVolatility: clamp((base.stressVolatility ?? 0.5) + (delta.stressVolatility ?? 0), 0, 1),
    inferiorNoise: clamp((base.inferiorNoise ?? 0.45) + (delta.inferiorNoise ?? 0), 0, 1),
    killEfficiency: clamp((base.killEfficiency ?? 0.5) + (delta.killEfficiency ?? 0), 0, 1),
  };
}

function zeroStyleDelta() {
  return {
    riskTolerance: 0,
    wrapWhenChased: 0,
    staminaConserve: 0,
    engageBias: 0,
    blockDiscipline: 0,
    probeBias: 0,
    commitmentBias: 0,
    replanBias: 0,
    fairnessBias: 0,
    intimidationBias: 0,
    mercyBias: 0,
    deceptionBias: 0,
    patternBias: 0,
    concreteBias: 0,
    stressRigidity: 0,
    stressVolatility: 0,
    inferiorNoise: 0,
    killEfficiency: 0,
  };
}

function makeSignalState(now = 0) {
  return {
    chainHeat: 0,
    threatLoad: 0,
    ambiguityLoad: 0,
    socialLoad: 0,
    stress: 0,
    lastUpdate: now,
  };
}

function makeMilestoneFlags() {
  return {
    chain: false,
    shell: false,
    ambiguity: false,
    social: false,
  };
}

function makeDriftState() {
  return {
    objective: { recover: 0, duel: 0, bait: 0 },
    tactic: makeMap(TACTICS, 0),
    scene: makeMap(SCENES, 0),
    style: zeroStyleDelta(),
  };
}

function makeBiasState() {
  return {
    objective: { recover: 0, duel: 0, bait: 0 },
    tactic: makeMap(TACTICS, 0),
    scene: makeMap(SCENES, 0),
    goalKind: Object.create(null),
    styleDelta: zeroStyleDelta(),
    objectiveTemperature: 1,
    tacticTemperature: 1,
    commitMul: 1,
    decisionCadenceMul: 1,
    milestoneLabels: [],
  };
}

function updateMilestoneFlag(flags, key, value, milestone) {
  if (!flags[key] && value >= milestone.enter) flags[key] = true;
  else if (flags[key] && value <= milestone.exit) flags[key] = false;
}

function accumulateObjective(target, source, mul = 1) {
  target.recover += (source.recover ?? 0) * mul;
  target.duel += (source.duel ?? 0) * mul;
  target.bait += (source.bait ?? 0) * mul;
}

function accumulateMap(target, source, keys, mul = 1) {
  for (const key of keys) target[key] += (source[key] ?? 0) * mul;
}

function accumulateStyle(target, source, mul = 1) {
  for (const key of Object.keys(target)) target[key] += (source[key] ?? 0) * mul;
}

function boundedNoise(scale) {
  return (Math.random() * 2 - 1) * scale;
}

function inferSignals(world, agent, opp, j) {
  const now = world.time;
  const dO = Math.hypot(agent.x - opp.x, agent.y - opp.y);
  const meleeRange = agent.r + opp.r + 14;
  const oppSeen = agent.senses?.opp?.visible || agent.senses?.opp?.peripheral || dO < 240;
  const hitTakenShock = clamp01(1 - (now - (agent.events?.gotHitAt ?? -Infinity)) / 1.1);
  const hitDealtShock = clamp01(1 - (now - (agent.events?.dealtHitAt ?? -Infinity)) / 1.0);
  const dJ = j ? agent.senses?.jug?.beliefDist ?? Infinity : Infinity;
  const safeDist = j ? (150 + 110 * clamp01((agent.belief?.jugDamage?.mean ?? 20) / Math.max(1, agent.maxHp))) : 260;
  const jugPressure = j ? clamp01((safeDist - dJ) / Math.max(1e-6, safeDist)) : 0;
  const staminaDebt = clamp01(1 - (agent.stamina ?? 0) / Math.max(1, agent.maxStamina ?? 100));
  const uncertainty = clamp01((agent.senses?.jug?.uncertainty ?? 0) * 0.8 + (oppSeen ? 0 : 0.35));
  const socialGap = oppSeen ? clamp01((dO - meleeRange * 1.2) / 220) : 0;
  const pressureWindow = clamp01((meleeRange * 2.4 - dO) / (meleeRange * 2.4));

  return {
    chain: clamp01(hitDealtShock * 0.65 + pressureWindow * 0.45),
    threat: clamp01(jugPressure * 0.7 + hitTakenShock * 0.45 + staminaDebt * 0.35),
    ambiguity: clamp01(uncertainty * 0.75 + (agent.style?.patternBias ?? 0.5) * 0.18),
    social: clamp01(socialGap * 0.45 + (agent.style?.probeBias ?? 0.5) * 0.45 + hitDealtShock * 0.25),
    stress: clamp01(jugPressure * 0.62 + hitTakenShock * 0.42 + staminaDebt * 0.28),
  };
}

function applyDrift(profile, state, bias, dt) {
  const caps = profile.drift.caps;
  const gain = profile.drift.gain;
  const decay = profile.drift.decay;
  const volatility = profile.drift.volatility;
  const stressVol = lerp(0.75, 1.45, state.signals.stress * (profile.styleBase.stressVolatility ?? 0.5));

  const driftObj = state.drift.objective;
  driftObj.recover += (-driftObj.recover * decay + boundedNoise(volatility * 16 * stressVol)) * dt * gain;
  driftObj.duel += (-driftObj.duel * decay + boundedNoise(volatility * 16 * stressVol)) * dt * gain;
  driftObj.bait += (-driftObj.bait * decay + boundedNoise(volatility * 16 * stressVol)) * dt * gain;
  driftObj.recover = clamp(driftObj.recover, -caps.objective, caps.objective);
  driftObj.duel = clamp(driftObj.duel, -caps.objective, caps.objective);
  driftObj.bait = clamp(driftObj.bait, -caps.objective, caps.objective);

  for (const tactic of TACTICS) {
    const drift = state.drift.tactic[tactic];
    state.drift.tactic[tactic] = clamp(
      drift + (-drift * decay + boundedNoise(volatility * 24 * stressVol)) * dt * gain,
      -caps.tactic,
      caps.tactic,
    );
  }
  for (const scene of SCENES) {
    const drift = state.drift.scene[scene];
    state.drift.scene[scene] = clamp(
      drift + (-drift * decay + boundedNoise(volatility * 10 * stressVol)) * dt * gain,
      -caps.scene,
      caps.scene,
    );
  }

  for (const key of Object.keys(state.drift.style)) {
    const drift = state.drift.style[key];
    state.drift.style[key] = clamp(
      drift + (-drift * (decay * 1.2) + boundedNoise(volatility * 0.06 * stressVol)) * dt * gain,
      -caps.style,
      caps.style,
    );
  }

  accumulateObjective(bias.objective, state.drift.objective, 1);
  accumulateMap(bias.tactic, state.drift.tactic, TACTICS, 1);
  accumulateMap(bias.scene, state.drift.scene, SCENES, 1);
  accumulateStyle(bias.styleDelta, state.drift.style, 1);
}

function buildBiasFromState(agent, profile) {
  const state = agent.mbti.state;
  const bias = makeBiasState();
  accumulateObjective(bias.objective, profile.objectiveBase, 1);
  accumulateMap(bias.tactic, profile.tacticBase, TACTICS, 1);
  accumulateMap(bias.scene, profile.sceneBase, SCENES, 1);
  bias.goalKind = { ...profile.goalKindBase };

  const labels = [];
  const milestones = profile.milestones;
  if (state.milestoneFlags.chain) {
    accumulateObjective(bias.objective, milestones.chain.objective, 1);
    accumulateMap(bias.tactic, milestones.chain.tactic, TACTICS, 1);
    accumulateMap(bias.scene, milestones.chain.scene, SCENES, 1);
    accumulateStyle(bias.styleDelta, milestones.chain.style, 1);
    labels.push("chain");
  }
  if (state.milestoneFlags.shell) {
    accumulateObjective(bias.objective, milestones.shell.objective, 1);
    accumulateMap(bias.tactic, milestones.shell.tactic, TACTICS, 1);
    accumulateMap(bias.scene, milestones.shell.scene, SCENES, 1);
    accumulateStyle(bias.styleDelta, milestones.shell.style, 1);
    labels.push("shell");
  }
  if (state.milestoneFlags.ambiguity) {
    accumulateObjective(bias.objective, milestones.ambiguity.objective, 1);
    accumulateMap(bias.tactic, milestones.ambiguity.tactic, TACTICS, 1);
    accumulateMap(bias.scene, milestones.ambiguity.scene, SCENES, 1);
    accumulateStyle(bias.styleDelta, milestones.ambiguity.style, 1);
    labels.push("ambiguity");
  }
  if (state.milestoneFlags.social) {
    accumulateObjective(bias.objective, milestones.social.objective, 1);
    accumulateMap(bias.tactic, milestones.social.tactic, TACTICS, 1);
    accumulateMap(bias.scene, milestones.social.scene, SCENES, 1);
    accumulateStyle(bias.styleDelta, milestones.social.style, 1);
    labels.push("social");
  }

  applyDrift(profile, state, bias, Math.max(1 / 240, state.lastDt ?? 1 / 60));

  const control = profile.styleBase.commitmentBias ?? 0.5;
  const improv = profile.styleBase.replanBias ?? 0.5;
  const stress = state.signals.stress;
  bias.commitMul = clamp(0.78 + control * 0.52 - improv * 0.18 - stress * (profile.styleBase.inferiorNoise ?? 0.45) * 0.22, 0.6, 1.6);
  bias.decisionCadenceMul = clamp(0.9 + improv * 0.45 - control * 0.2 + stress * (profile.styleBase.stressVolatility ?? 0.5) * 0.25, 0.6, 1.6);
  bias.objectiveTemperature = clamp(0.9 + (improv - control) * 0.45 + stress * 0.25, 0.65, 1.5);
  bias.tacticTemperature = clamp(0.88 + (improv - control) * 0.5 + stress * 0.28, 0.6, 1.6);
  bias.milestoneLabels = labels;
  return bias;
}

function resolveType(typeId) {
  return resolveMbtiProfile(typeId).id;
}

export function initMbtiAgent(agent, typeId, now = 0) {
  const profile = resolveMbtiProfile(typeId);
  const styleBase = mergeStyle(profile.styleBase, zeroStyleDelta());
  const mbti = {
    typeId: profile.id,
    profile,
    styleBase,
    state: {
      signals: makeSignalState(now),
      milestoneFlags: makeMilestoneFlags(),
      drift: makeDriftState(),
      bias: makeBiasState(),
      lastDt: 1 / 60,
      switchedAt: now,
    },
  };
  agent.mbti = mbti;
  agent.style = {
    riskTolerance: styleBase.riskTolerance,
    wrapWhenChased: styleBase.wrapWhenChased,
    staminaConserve: styleBase.staminaConserve,
    engageBias: styleBase.engageBias,
    blockDiscipline: styleBase.blockDiscipline,
    probeBias: styleBase.probeBias,
    commitmentBias: styleBase.commitmentBias,
    replanBias: styleBase.replanBias,
    fairnessBias: styleBase.fairnessBias,
    intimidationBias: styleBase.intimidationBias,
    mercyBias: styleBase.mercyBias,
    deceptionBias: styleBase.deceptionBias,
    patternBias: styleBase.patternBias,
    concreteBias: styleBase.concreteBias,
    stressRigidity: styleBase.stressRigidity,
    stressVolatility: styleBase.stressVolatility,
    inferiorNoise: styleBase.inferiorNoise,
    killEfficiency: styleBase.killEfficiency,
  };
  return profile.id;
}

export function cycleMbtiAgent(agent, step = 1, now = 0) {
  const current = resolveType(agent?.mbti?.typeId ?? "ENFP");
  const next = nextMbtiType(current, step);
  initMbtiAgent(agent, next, now);
  return next;
}

export function updateMbtiAdaptation(world, agent, opp, j, dt) {
  if (!agent?.mbti?.profile) initMbtiAgent(agent, "ENFP", world.time);
  const profile = agent.mbti.profile;
  const state = agent.mbti.state;

  state.lastDt = dt;
  const a = expSmoothing(dt, 0.38);
  const signal = inferSignals(world, agent, opp, j);
  state.signals.chainHeat = lerp(state.signals.chainHeat, signal.chain, a);
  state.signals.threatLoad = lerp(state.signals.threatLoad, signal.threat, a);
  state.signals.ambiguityLoad = lerp(state.signals.ambiguityLoad, signal.ambiguity, a);
  state.signals.socialLoad = lerp(state.signals.socialLoad, signal.social, a);
  state.signals.stress = lerp(state.signals.stress, signal.stress, a);
  state.signals.lastUpdate = world.time;

  updateMilestoneFlag(state.milestoneFlags, "chain", state.signals.chainHeat, profile.milestones.chain);
  updateMilestoneFlag(state.milestoneFlags, "shell", state.signals.threatLoad, profile.milestones.shell);
  updateMilestoneFlag(state.milestoneFlags, "ambiguity", state.signals.ambiguityLoad, profile.milestones.ambiguity);
  updateMilestoneFlag(state.milestoneFlags, "social", state.signals.socialLoad, profile.milestones.social);

  const bias = buildBiasFromState(agent, profile);
  state.bias = bias;

  const style = mergeStyle(profile.styleBase, bias.styleDelta);
  agent.style.riskTolerance = style.riskTolerance;
  agent.style.wrapWhenChased = style.wrapWhenChased;
  agent.style.staminaConserve = style.staminaConserve;
  agent.style.engageBias = style.engageBias;
  agent.style.blockDiscipline = style.blockDiscipline;
  agent.style.probeBias = style.probeBias;
  agent.style.commitmentBias = style.commitmentBias;
  agent.style.replanBias = style.replanBias;
  agent.style.fairnessBias = style.fairnessBias;
  agent.style.intimidationBias = style.intimidationBias;
  agent.style.mercyBias = style.mercyBias;
  agent.style.deceptionBias = style.deceptionBias;
  agent.style.patternBias = style.patternBias;
  agent.style.concreteBias = style.concreteBias;
  agent.style.stressRigidity = style.stressRigidity;
  agent.style.stressVolatility = style.stressVolatility;
  agent.style.inferiorNoise = style.inferiorNoise;
  agent.style.killEfficiency = style.killEfficiency;
}

export function getMbtiBias(agent) {
  return agent?.mbti?.state?.bias ?? makeBiasState();
}
