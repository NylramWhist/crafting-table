import { RECIPE_SCHEMA_VERSION } from "./public-api.mjs";

export const DEFAULT_OUTCOMES = {
  success: {},
  partialSuccess: {
    enabled: false,
    missBy: 2,
    effect: {
      type: "gmDecision",
      qualityTier: "poor"
    },
    additionalEffects: []
  },
  failure: {
    type: "loseAllIngredients",
    results: [],
    flavorText: "You lose the ingredients.",
    macroUuid: ""
  },
  criticalSuccess: {
    enabled: false,
    trigger: {
      type: "nat20",
      threshold: 20
    },
    effects: []
  },
  criticalFailure: {
    enabled: false,
    trigger: {
      type: "nat1",
      threshold: 5
    },
    effect: {
      type: "gmDecision",
      macroUuid: ""
    },
    results: []
  }
};

export const DEFAULT_RECIPE = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  recipeId: "",
  isRecipe: true,
  category: "alchemy",
  rarity: "common",
  description: "",
  toolName: "Alchemist's Supplies",
  toolUuid: "",
  toolKey: "alchemist",
  ability: "int",
  dc: 12,
  proficiencyRequired: false,
  time: "4 hours",
  timeValue: 4,
  timeUnit: "hours",
  costGp: 0,
  costDenomination: "gp",
  failure: "You lose the ingredients.",
  defaultMode: "automatic",
  showToPlayers: true,
  ingredients: [],
  result: null,
  results: [],
  outcomes: DEFAULT_OUTCOMES,
  failureData: {
    type: "loseAllIngredients",
    failureItem: null,
    partialSuccess: {
      enabled: false,
      missBy: 2,
      effect: "gmDecision"
    },
    criticalSuccess: {
      enabled: false,
      doubleOutput: false,
      noGoldCost: false,
      reduceTimeHalf: false,
      createBonusItem: false
    }
  },
  permissions: {
    visibility: "visible",
    knowledgeSource: "globalUnlocked",
    craftPermission: "gmApprovalRequired"
  },
  notes: {
    player: "",
    gm: ""
  }
};
