const MBTI_ORDER = [
  "ISTJ", "ISFJ", "INFJ", "INTJ",
  "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP",
  "ESTJ", "ESFJ", "ENFJ", "ENTJ",
];

const TACTICS = [
  "OPEN_UP",
  "RETREAT_LONG",
  "RETREAT_SHORT",
  "PRESSURE",
  "ATTACK",
  "BLOCK",
  "CLASH",
  "RESET",
];

const SCENES = ["RESET", "DUEL", "SCRAMBLE", "ESCAPE", "FINISH"];

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeBiasMap(keys, value = 0) {
  const out = Object.create(null);
  for (const key of keys) out[key] = value;
  return out;
}

function ensureObjectiveShape(objective) {
  return {
    recover: Number(objective?.recover ?? 0),
    duel: Number(objective?.duel ?? 0),
    bait: Number(objective?.bait ?? 0),
  };
}

function ensureMapShape(keys, value, input) {
  const out = makeBiasMap(keys, value);
  if (input && typeof input === "object") {
    for (const key of keys) out[key] = Number(input[key] ?? out[key]);
  }
  return out;
}

function mergeMilestone(base, patch) {
  if (!patch) return base;
  return {
    enter: Number(patch.enter ?? base.enter),
    exit: Number(patch.exit ?? base.exit),
    objective: ensureObjectiveShape({ ...base.objective, ...(patch.objective ?? {}) }),
    tactic: ensureMapShape(TACTICS, 0, { ...base.tactic, ...(patch.tactic ?? {}) }),
    scene: ensureMapShape(SCENES, 0, { ...base.scene, ...(patch.scene ?? {}) }),
    style: {
      engageBias: Number(patch.style?.engageBias ?? base.style.engageBias),
      staminaConserve: Number(patch.style?.staminaConserve ?? base.style.staminaConserve),
      riskTolerance: Number(patch.style?.riskTolerance ?? base.style.riskTolerance),
      wrapWhenChased: Number(patch.style?.wrapWhenChased ?? base.style.wrapWhenChased),
      blockDiscipline: Number(patch.style?.blockDiscipline ?? base.style.blockDiscipline),
      probeBias: Number(patch.style?.probeBias ?? base.style.probeBias),
      commitmentBias: Number(patch.style?.commitmentBias ?? base.style.commitmentBias),
    },
  };
}

const NEUTRAL_PROFILE = {
  id: "ENFP",
  letters: { ie: "E", sn: "N", tf: "F", jp: "P" },
  archetype: "Adaptive improviser",
  styleBase: {
    riskTolerance: 0.55,
    wrapWhenChased: 0.25,
    staminaConserve: 0.45,
    engageBias: 0.55,
    blockDiscipline: 0.48,
    probeBias: 0.56,
    commitmentBias: 0.48,
    replanBias: 0.52,
    fairnessBias: 0.5,
    intimidationBias: 0.45,
    mercyBias: 0.42,
    deceptionBias: 0.55,
    patternBias: 0.62,
    concreteBias: 0.45,
    stressRigidity: 0.42,
    stressVolatility: 0.55,
    inferiorNoise: 0.46,
  },
  objectiveBase: { recover: 0, duel: 0, bait: 0 },
  sceneBase: makeBiasMap(SCENES, 0),
  tacticBase: makeBiasMap(TACTICS, 0),
  goalKindBase: {
    CENTER: 0,
    SAFE_MEMORY: 0,
    STANCE_ANCHOR: 0,
    ESCAPE_LANE: 0,
    DUEL_RING: 0,
    ATTACK_LANE: 0,
    BAIT_LINE: 0,
    HOLD: 0,
  },
  drift: {
    gain: 0.9,
    decay: 0.28,
    volatility: 0.16,
    caps: {
      objective: 120,
      tactic: 240,
      scene: 120,
      style: 0.28,
    },
  },
  milestones: {
    chain: {
      enter: 0.62,
      exit: 0.38,
      objective: { recover: -34, duel: 52, bait: 22 },
      tactic: {
        ATTACK: 72,
        PRESSURE: 55,
        CLASH: 40,
        RESET: -48,
        OPEN_UP: -36,
      },
      scene: { DUEL: 48, FINISH: 36, RESET: -28 },
      style: {
        engageBias: 0.08,
        staminaConserve: -0.06,
        riskTolerance: 0.07,
        wrapWhenChased: 0.02,
        blockDiscipline: -0.03,
        probeBias: 0.06,
        commitmentBias: 0.05,
      },
    },
    shell: {
      enter: 0.58,
      exit: 0.34,
      objective: { recover: 64, duel: -48, bait: -20 },
      tactic: {
        RETREAT_LONG: 66,
        OPEN_UP: 52,
        BLOCK: 32,
        ATTACK: -52,
        PRESSURE: -46,
      },
      scene: { ESCAPE: 68, SCRAMBLE: 30, DUEL: -34, FINISH: -20 },
      style: {
        engageBias: -0.09,
        staminaConserve: 0.1,
        riskTolerance: -0.08,
        wrapWhenChased: -0.05,
        blockDiscipline: 0.09,
        probeBias: -0.08,
        commitmentBias: 0.03,
      },
    },
    ambiguity: {
      enter: 0.52,
      exit: 0.29,
      objective: { recover: 10, duel: -12, bait: 18 },
      tactic: {
        PRESSURE: -10,
        CLASH: -8,
        RESET: 12,
        OPEN_UP: 8,
      },
      scene: { RESET: 10, DUEL: -8 },
      style: {
        engageBias: -0.03,
        staminaConserve: 0.02,
        riskTolerance: -0.02,
        wrapWhenChased: 0.03,
        blockDiscipline: 0.02,
        probeBias: -0.01,
        commitmentBias: -0.02,
      },
    },
    social: {
      enter: 0.5,
      exit: 0.25,
      objective: { recover: -8, duel: 12, bait: 24 },
      tactic: {
        PRESSURE: 24,
        BAIT_LINE: 0,
        ATTACK: 10,
        RESET: -12,
      },
      scene: { DUEL: 18, FINISH: 12, RESET: -10 },
      style: {
        engageBias: 0.03,
        staminaConserve: -0.01,
        riskTolerance: 0.03,
        wrapWhenChased: 0.03,
        blockDiscipline: -0.01,
        probeBias: 0.1,
        commitmentBias: -0.03,
      },
    },
  },
};

const LETTER_DELTAS = {
  I: {
    style: {
      engageBias: -0.08,
      probeBias: -0.14,
      commitmentBias: 0.05,
      intimidationBias: -0.05,
      deceptionBias: 0.04,
      replanBias: -0.06,
    },
    objective: { recover: 12, duel: -10, bait: 2 },
    tactic: { OPEN_UP: 18, PRESSURE: -12, ATTACK: -10, RESET: 10, CLASH: -8 },
    scene: { RESET: 10, DUEL: -8 },
  },
  E: {
    style: {
      engageBias: 0.09,
      probeBias: 0.16,
      commitmentBias: -0.04,
      intimidationBias: 0.06,
      deceptionBias: 0.03,
      replanBias: 0.07,
    },
    objective: { recover: -8, duel: 12, bait: 8 },
    tactic: { OPEN_UP: -10, PRESSURE: 18, ATTACK: 12, RESET: -8, CLASH: 8 },
    scene: { RESET: -8, DUEL: 10, FINISH: 8 },
  },
  S: {
    style: {
      concreteBias: 0.2,
      patternBias: -0.16,
      commitmentBias: 0.05,
      replanBias: -0.03,
      blockDiscipline: 0.04,
      stressRigidity: 0.08,
    },
    objective: { recover: 8, duel: 10, bait: -14 },
    tactic: { PRESSURE: 8, ATTACK: 10, CLASH: 10, RESET: 4 },
    scene: { DUEL: 8, RESET: 4 },
    goalKind: { DUEL_RING: 14, ATTACK_LANE: 10, BAIT_LINE: -18, SAFE_MEMORY: 8 },
  },
  N: {
    style: {
      concreteBias: -0.16,
      patternBias: 0.2,
      commitmentBias: -0.04,
      replanBias: 0.09,
      blockDiscipline: -0.03,
      stressVolatility: 0.08,
    },
    objective: { recover: -4, duel: 4, bait: 16 },
    tactic: { PRESSURE: 10, ATTACK: 4, CLASH: -4, RESET: 2 },
    scene: { DUEL: 6, FINISH: 6, RESET: -2 },
    goalKind: { DUEL_RING: 6, ATTACK_LANE: 8, BAIT_LINE: 22, SAFE_MEMORY: -4 },
  },
  T: {
    style: {
      fairnessBias: -0.16,
      mercyBias: -0.14,
      killEfficiency: 0.18,
      blockDiscipline: 0.06,
      riskTolerance: -0.02,
      stressRigidity: 0.06,
    },
    objective: { recover: 4, duel: 18, bait: 2 },
    tactic: { ATTACK: 18, PRESSURE: 12, BLOCK: 8, OPEN_UP: -6 },
    scene: { FINISH: 14, DUEL: 8, RESET: -4 },
  },
  F: {
    style: {
      fairnessBias: 0.2,
      mercyBias: 0.16,
      killEfficiency: -0.08,
      blockDiscipline: -0.02,
      riskTolerance: 0.02,
      intimidationBias: 0.05,
    },
    objective: { recover: 10, duel: -4, bait: 14 },
    tactic: { ATTACK: -6, PRESSURE: 4, BLOCK: 6, OPEN_UP: 8, RESET: 4 },
    scene: { RESET: 8, DUEL: 2, FINISH: -8 },
  },
  J: {
    style: {
      commitmentBias: 0.2,
      replanBias: -0.18,
      staminaConserve: 0.06,
      blockDiscipline: 0.08,
      stressRigidity: 0.16,
      stressVolatility: -0.08,
    },
    objective: { recover: 8, duel: 6, bait: -8 },
    tactic: { RESET: 14, BLOCK: 10, PRESSURE: 6, CLASH: -4 },
    scene: { RESET: 12, DUEL: 6, ESCAPE: 8 },
  },
  P: {
    style: {
      commitmentBias: -0.18,
      replanBias: 0.2,
      staminaConserve: -0.05,
      blockDiscipline: -0.05,
      stressRigidity: -0.1,
      stressVolatility: 0.14,
    },
    objective: { recover: -4, duel: 8, bait: 10 },
    tactic: { RESET: -8, BLOCK: -6, PRESSURE: 10, CLASH: 10, ATTACK: 6 },
    scene: { RESET: -6, DUEL: 10, FINISH: 6 },
  },
};

const TYPE_OVERRIDES = {
  ISTJ: {
    archetype: "Disciplined procedural controller",
    styleBase: { stressRigidity: 0.68, stressVolatility: 0.25, probeBias: 0.34, deceptionBias: 0.22 },
    objectiveBase: { recover: 16, duel: 8, bait: -16 },
    tacticBase: { RESET: 26, BLOCK: 14, ATTACK: 8, CLASH: -10 },
    sceneBase: { RESET: 16, DUEL: 8, FINISH: 4 },
    goalKindBase: { SAFE_MEMORY: 14, ESCAPE_LANE: 12, BAIT_LINE: -20, DUEL_RING: 4 },
  },
  ISFJ: {
    archetype: "Protective stabilizer",
    styleBase: { fairnessBias: 0.72, mercyBias: 0.66, blockDiscipline: 0.64, intimidationBias: 0.3 },
    objectiveBase: { recover: 22, duel: -4, bait: -6 },
    tacticBase: { BLOCK: 20, OPEN_UP: 18, PRESSURE: -8, ATTACK: -14 },
    sceneBase: { RESET: 18, ESCAPE: 10, DUEL: -4 },
  },
  INFJ: {
    archetype: "Anticipatory trap strategist",
    styleBase: { patternBias: 0.82, concreteBias: 0.32, deceptionBias: 0.64, stressVolatility: 0.44 },
    objectiveBase: { recover: 8, duel: 12, bait: 16 },
    tacticBase: { PRESSURE: 18, ATTACK: 8, CLASH: -4, RESET: 6 },
    sceneBase: { DUEL: 16, FINISH: 10, RESET: 6 },
    goalKindBase: { BAIT_LINE: 24, ATTACK_LANE: 10, DUEL_RING: 10 },
  },
  INTJ: {
    archetype: "Ruthless strategic optimizer",
    styleBase: { killEfficiency: 0.84, patternBias: 0.86, commitmentBias: 0.68, probeBias: 0.36 },
    objectiveBase: { recover: 6, duel: 18, bait: 8 },
    tacticBase: { ATTACK: 20, PRESSURE: 18, RESET: 10, CLASH: -2 },
    sceneBase: { FINISH: 22, DUEL: 14, RESET: 8 },
  },
  ISTP: {
    archetype: "Micro-adjusting combat engineer",
    styleBase: { concreteBias: 0.84, commitmentBias: 0.46, replanBias: 0.72, probeBias: 0.5 },
    objectiveBase: { recover: -2, duel: 18, bait: 4 },
    tacticBase: { CLASH: 24, ATTACK: 14, PRESSURE: 12, RESET: -6 },
    sceneBase: { DUEL: 20, FINISH: 8, RESET: -6 },
    goalKindBase: { DUEL_RING: 22, ATTACK_LANE: 16, BAIT_LINE: 4 },
  },
  ISFP: {
    archetype: "Fluid duelist with value spikes",
    styleBase: { riskTolerance: 0.6, fairnessBias: 0.66, stressVolatility: 0.64, commitmentBias: 0.42 },
    objectiveBase: { recover: 2, duel: 14, bait: 10 },
    tacticBase: { CLASH: 18, ATTACK: 10, PRESSURE: 6, RESET: -6 },
    sceneBase: { DUEL: 18, FINISH: 6 },
  },
  INFP: {
    archetype: "Creative ideal-driven improviser",
    styleBase: { patternBias: 0.8, fairnessBias: 0.84, mercyBias: 0.74, commitmentBias: 0.34, stressVolatility: 0.72 },
    objectiveBase: { recover: 12, duel: 4, bait: 18 },
    tacticBase: { PRESSURE: 6, ATTACK: -4, RESET: 12, OPEN_UP: 10 },
    sceneBase: { RESET: 14, DUEL: 8, FINISH: -4 },
    goalKindBase: { BAIT_LINE: 26, SAFE_MEMORY: 8, DUEL_RING: 4 },
  },
  INTP: {
    archetype: "Model-first exploit finder",
    styleBase: { patternBias: 0.88, probeBias: 0.46, commitmentBias: 0.3, replanBias: 0.78, stressRigidity: 0.38 },
    objectiveBase: { recover: 6, duel: 14, bait: 18 },
    tacticBase: { PRESSURE: 16, ATTACK: 6, CLASH: -2, RESET: 8 },
    sceneBase: { DUEL: 14, RESET: 10, FINISH: 6 },
    goalKindBase: { BAIT_LINE: 24, ATTACK_LANE: 10, DUEL_RING: 6 },
  },
  ESTP: {
    archetype: "Tempo-dominant chaos operator",
    styleBase: { riskTolerance: 0.74, engageBias: 0.78, probeBias: 0.82, commitmentBias: 0.42, stressVolatility: 0.58 },
    objectiveBase: { recover: -10, duel: 22, bait: 6 },
    tacticBase: { ATTACK: 22, PRESSURE: 24, CLASH: 16, RESET: -12, OPEN_UP: -10 },
    sceneBase: { DUEL: 22, FINISH: 16, RESET: -10 },
    goalKindBase: { DUEL_RING: 20, ATTACK_LANE: 18, BAIT_LINE: 8, ESCAPE_LANE: -8 },
  },
  ESFP: {
    archetype: "Adaptive distraction fighter",
    styleBase: { engageBias: 0.72, probeBias: 0.74, fairnessBias: 0.66, intimidationBias: 0.62, stressVolatility: 0.66 },
    objectiveBase: { recover: 2, duel: 12, bait: 14 },
    tacticBase: { PRESSURE: 18, ATTACK: 10, CLASH: 10, RESET: -4 },
    sceneBase: { DUEL: 14, FINISH: 10, RESET: -2 },
    goalKindBase: { BAIT_LINE: 16, DUEL_RING: 14, ATTACK_LANE: 10 },
  },
  ENFP: {
    archetype: "High-creativity misdirection engine",
    styleBase: { patternBias: 0.82, probeBias: 0.8, deceptionBias: 0.78, stressVolatility: 0.74, commitmentBias: 0.36 },
    objectiveBase: { recover: -2, duel: 10, bait: 24 },
    tacticBase: { PRESSURE: 16, ATTACK: 8, CLASH: 4, RESET: 2 },
    sceneBase: { DUEL: 12, FINISH: 8, RESET: 2 },
    goalKindBase: { BAIT_LINE: 28, ATTACK_LANE: 10, DUEL_RING: 10 },
  },
  ENTP: {
    archetype: "Deception-driven counter adapter",
    styleBase: { deceptionBias: 0.88, probeBias: 0.86, patternBias: 0.9, commitmentBias: 0.3, stressVolatility: 0.7 },
    objectiveBase: { recover: -4, duel: 14, bait: 22 },
    tacticBase: { PRESSURE: 20, ATTACK: 10, CLASH: 2, RESET: 4, BLOCK: -6 },
    sceneBase: { DUEL: 18, FINISH: 10, RESET: 2 },
    goalKindBase: { BAIT_LINE: 30, ATTACK_LANE: 12, DUEL_RING: 8 },
  },
  ESTJ: {
    archetype: "Command-and-control executor",
    styleBase: { commitmentBias: 0.78, blockDiscipline: 0.7, stressRigidity: 0.76, probeBias: 0.54 },
    objectiveBase: { recover: 10, duel: 16, bait: -10 },
    tacticBase: { PRESSURE: 20, ATTACK: 12, RESET: 14, BLOCK: 12, CLASH: 4 },
    sceneBase: { DUEL: 18, FINISH: 14, RESET: 10 },
    goalKindBase: { ATTACK_LANE: 14, DUEL_RING: 10, SAFE_MEMORY: 8, BAIT_LINE: -12 },
  },
  ESFJ: {
    archetype: "Cohesion and support stabilizer",
    styleBase: { fairnessBias: 0.84, mercyBias: 0.68, probeBias: 0.72, blockDiscipline: 0.62, intimidationBias: 0.54 },
    objectiveBase: { recover: 20, duel: 4, bait: 8 },
    tacticBase: { BLOCK: 18, OPEN_UP: 14, RESET: 16, PRESSURE: 4, ATTACK: -8 },
    sceneBase: { RESET: 16, ESCAPE: 12, DUEL: 4 },
  },
  ENFJ: {
    archetype: "Battle conductor and pressure shaper",
    styleBase: { probeBias: 0.86, intimidationBias: 0.74, fairnessBias: 0.68, commitmentBias: 0.62, stressVolatility: 0.52 },
    objectiveBase: { recover: 2, duel: 16, bait: 14 },
    tacticBase: { PRESSURE: 24, ATTACK: 14, CLASH: 6, RESET: 2 },
    sceneBase: { DUEL: 20, FINISH: 14, RESET: 2 },
    goalKindBase: { BAIT_LINE: 18, ATTACK_LANE: 14, DUEL_RING: 12 },
  },
  ENTJ: {
    archetype: "Strategic aggressor and tempo controller",
    styleBase: { killEfficiency: 0.92, commitmentBias: 0.74, engageBias: 0.76, probeBias: 0.62, stressRigidity: 0.64 },
    objectiveBase: { recover: -2, duel: 24, bait: 8 },
    tacticBase: { ATTACK: 28, PRESSURE: 26, CLASH: 8, RESET: 6, OPEN_UP: -8 },
    sceneBase: { FINISH: 24, DUEL: 20, RESET: 4 },
    goalKindBase: { ATTACK_LANE: 18, DUEL_RING: 14, BAIT_LINE: 8, SAFE_MEMORY: -8 },
  },
};

function applyPatch(target, patch) {
  if (!patch) return;
  if (patch.styleBase) {
    for (const [key, val] of Object.entries(patch.styleBase)) target.styleBase[key] = Number(val);
  }
  if (patch.objectiveBase) {
    target.objectiveBase.recover += Number(patch.objectiveBase.recover ?? 0);
    target.objectiveBase.duel += Number(patch.objectiveBase.duel ?? 0);
    target.objectiveBase.bait += Number(patch.objectiveBase.bait ?? 0);
  }
  if (patch.sceneBase) {
    for (const key of SCENES) target.sceneBase[key] += Number(patch.sceneBase[key] ?? 0);
  }
  if (patch.tacticBase) {
    for (const key of TACTICS) target.tacticBase[key] += Number(patch.tacticBase[key] ?? 0);
  }
  if (patch.goalKindBase) {
    for (const key of Object.keys(target.goalKindBase)) {
      target.goalKindBase[key] += Number(patch.goalKindBase[key] ?? 0);
    }
  }
  if (patch.drift) {
    target.drift.gain = Number(patch.drift.gain ?? target.drift.gain);
    target.drift.decay = Number(patch.drift.decay ?? target.drift.decay);
    target.drift.volatility = Number(patch.drift.volatility ?? target.drift.volatility);
    if (patch.drift.caps) {
      target.drift.caps.objective = Number(patch.drift.caps.objective ?? target.drift.caps.objective);
      target.drift.caps.tactic = Number(patch.drift.caps.tactic ?? target.drift.caps.tactic);
      target.drift.caps.scene = Number(patch.drift.caps.scene ?? target.drift.caps.scene);
      target.drift.caps.style = Number(patch.drift.caps.style ?? target.drift.caps.style);
    }
  }
  if (patch.milestones) {
    for (const key of Object.keys(target.milestones)) {
      target.milestones[key] = mergeMilestone(target.milestones[key], patch.milestones[key]);
    }
  }
  if (patch.archetype) target.archetype = String(patch.archetype);
}

function buildProfile(typeId) {
  const letters = {
    ie: typeId[0],
    sn: typeId[1],
    tf: typeId[2],
    jp: typeId[3],
  };
  const profile = deepClone(NEUTRAL_PROFILE);
  profile.id = typeId;
  profile.letters = letters;

  applyPatch(profile, LETTER_DELTAS[letters.ie]);
  applyPatch(profile, LETTER_DELTAS[letters.sn]);
  applyPatch(profile, LETTER_DELTAS[letters.tf]);
  applyPatch(profile, LETTER_DELTAS[letters.jp]);
  applyPatch(profile, TYPE_OVERRIDES[typeId]);

  return profile;
}

const PROFILE_BY_TYPE = Object.create(null);
for (const typeId of MBTI_ORDER) PROFILE_BY_TYPE[typeId] = buildProfile(typeId);

export { MBTI_ORDER, TACTICS, SCENES, PROFILE_BY_TYPE };

export function resolveMbtiProfile(typeId) {
  const key = String(typeId || "").toUpperCase();
  return PROFILE_BY_TYPE[key] ?? PROFILE_BY_TYPE.ENFP;
}

export function nextMbtiType(currentType, step = 1) {
  const current = String(currentType || "").toUpperCase();
  const idx = Math.max(0, MBTI_ORDER.indexOf(current));
  const next = (idx + step + MBTI_ORDER.length) % MBTI_ORDER.length;
  return MBTI_ORDER[next];
}
