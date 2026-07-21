import { addDelegatedListener, confirmCraftingAction } from "./foundry-compat.js";
import {
  buildOutcomeExecutionPlan,
  classifyCraftOutcome,
  clearRecipeToolRequirement,
  getIngredientMatchMode,
  hasExplicitEmptyToolRequirement,
  ingredientMatchesCandidate,
  isIngredientRequired,
  normalizeOptionalIngredientSelection,
  toolHasProficiency,
  toolNamesMatch
} from "./crafting-rules.mjs";
import { buildPlayerCategories, deduplicatePlayerRecipeSources, filterAndSortOngoingCrafts, filterCraftRequests, filterPlayerRecipeSummaries, normalizeGmActiveTab, sortCraftRequests, summarizeCraftRequests } from "./crafting-ui-rules.mjs";
import {
  assertCanManageCrafting,
  assertCanModifyCraftingActor,
  canUserModifyCraftingActor,
  CraftingAuthorizationError
} from "./crafting-authorization.mjs";
import {
  assertActorResourcesUnchanged,
  captureActorResourceFingerprint,
  CraftingOperationBusyError,
  CraftingStateChangedError,
  runExclusiveCraftingOperation
} from "./crafting-operation-service.mjs";
import { captureCraftTransactionState, rollbackCraftTransaction } from "./crafting-transaction-service.mjs";
import { createCraftingStateService } from "./crafting-state-service.mjs";
import { createCraftRequestService } from "./craft-request-service.mjs";
import { createPendingOutcomeService, PENDING_OUTCOME_RESOLUTIONS } from "./crafting-pending-outcome-service.mjs";
import { createCraftingSocketExecutor, CraftingSocketError } from "./crafting-socket-service.mjs";
import { executeCraftingMacro } from "./crafting-macro-service.mjs";
import { downloadCraftingRecipeJson, extractRecipeImportEntries, promptForCraftingRecipeJsonImport, slugifyFileName } from "./recipe-json-service.mjs";
import { createTidyIntegration } from "./tidy-integration.mjs";
import { runCraftingMigrations } from "./migration-service.mjs";
import { finalizeCraftingState } from "./crafting-finalization-service.mjs";
import {
  createRecipeId,
  deriveLegacyRecipeId,
  findLegacyRecipeMigrationMatch,
  isValidRecipeId,
  normalizeRecipeId,
  recipeReferencesMatch,
  replaceRecipeReferenceEntry,
  resolveRecipeId
} from "./recipe-identity-service.mjs";
import { buildPlayerUiLabels, ct, registerTemplateHelpers } from "./crafting-i18n.mjs";
import { CRAFTING_TABLE_API_VERSION, CRAFTING_TABLE_HOOKS, createCraftingTableApi, RECIPE_SCHEMA_VERSION } from "./public-api.mjs";
import { DEFAULT_OUTCOMES, DEFAULT_RECIPE } from "./recipe-contract.mjs";
import { buildApplicationUniqueId } from "./application-identifiers.mjs";
import { createRecipeRepository } from "./recipe-repository.mjs";
import { RecipeDraftStore } from "./recipe-draft-store.mjs";
import { buildRecipeAvailability } from "./recipe-availability-service.mjs";
import { rollDnd5eCraftingCheck } from "./dnd5e-roll-adapter.mjs";
import { createCraftingPackService } from "./crafting-pack-service.mjs";
import {
  bindResponsiveApplication,
  fitApplicationPosition,
  getApplicationWidthMode,
  handleTabListKeydown,
  releaseResponsiveApplication
} from "./crafting-ui-accessibility.mjs";

const MODULE_ID = "crafting-table";
const CURRENT_RECIPE_SCHEMA_VERSION = RECIPE_SCHEMA_VERSION;
const CURRENT_MIGRATION_VERSION = 5;
const RECIPE_FLAG = "recipe";
const tidyIntegration = createTidyIntegration({ moduleId: MODULE_ID, openCraftingBench });
const ONGOING_CRAFTS_FLAG = "ongoingCrafts";
const CRAFT_REQUESTS_FLAG = "craftRequests";
const PENDING_OUTCOMES_FLAG = "pendingOutcomes";
const OPERATION_LEDGER_FLAG = "operationLedger";
const INTERRUPTED_OPERATION_GRACE_MS = 30_000;
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/crafting-table.hbs`;
const PLAYER_HEADER_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/crafting-table-header.hbs`;
const PLAYER_CATEGORIES_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/crafting-table-categories.hbs`;
const PLAYER_RECIPES_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/crafting-table-recipes.hbs`;
const PLAYER_DETAILS_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/crafting-table-details.hbs`;
const GM_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel.hbs`;
const GM_HEADER_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-header.hbs`;
const GM_LIBRARY_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-library.hbs`;
const GM_EDITOR_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-editor.hbs`;
const GM_PREVIEW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-preview.hbs`;
const GM_REQUESTS_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-requests.hbs`;
const GM_IMPORT_EXPORT_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-panel-import-export.hbs`;
const GM_INGREDIENT_ROW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/partials/gm-ingredient-row.hbs`;
const GM_RESULT_ROW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/partials/gm-result-row.hbs`;
const GM_OUTCOME_RESULT_ROW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/partials/gm-outcome-result-row.hbs`;
const GM_OUTCOME_EFFECT_ROW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/partials/gm-outcome-effect-row.hbs`;
const GM_OUTCOME_RESULT_EMPTY_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/partials/gm-outcome-result-empty.hbs`;
const GM_ROW_PARTIALS = Object.freeze({
  ctIngredientRow: GM_INGREDIENT_ROW_TEMPLATE_PATH,
  ctResultRow: GM_RESULT_ROW_TEMPLATE_PATH,
  ctOutcomeResultRow: GM_OUTCOME_RESULT_ROW_TEMPLATE_PATH,
  ctOutcomeEffectRow: GM_OUTCOME_EFFECT_ROW_TEMPLATE_PATH
});
const OUTCOME_PREVIEW_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/outcome-preview.hbs`;
const DEFAULT_RECIPE_ICON = "icons/svg/item-bag.svg";
const RECIPE_FOLDER_NAME = "Recipe";
const RECIPE_NAME_PREFIX = "Recipe:";
const NO_TOOL_CHOICE = "__noToolRequired";
const CUSTOM_TOOL_CHOICE = "__customTool";
const CURRENT_TOOL_CHOICE = "__currentTool";
const NEW_RECIPE_DRAFT_UUID = "CraftingTable.Draft.Recipe";
const GM_PANEL_LAYOUTS = {
  compact: { width: 1180, height: 700, density: 0.88, fontScale: 0.92 },
  normal: { width: 1280, height: 760, density: 1, fontScale: 1 },
  large: { width: 1520, height: 860, density: 1.08, fontScale: 1.06 }
};
const APPLICATION_VIEWPORT_MARGIN = 12;
const PLAYER_PANEL_MIN_WIDTH = 320;
const PLAYER_PANEL_MIN_HEIGHT = 420;
const GM_PANEL_MIN_WIDTH = 360;
const GM_PANEL_MIN_HEIGHT = 480;
const RECIPE_PAGE_SIZE_LIST = 6;
const RECIPE_PAGE_SIZE_GRID = 12;
const GM_RECIPE_PARTS = Object.freeze(["library", "editor", "preview", "importExport"]);
const GM_DYNAMIC_PARTS = Object.freeze(["header", ...GM_RECIPE_PARTS, "requests"]);
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
let cachedToolOptions = null;
const itemNameLookupCache = new Map();
const applicationRefreshTimers = new WeakMap();
const craftingPackService = createCraftingPackService({ moduleId: MODULE_ID, getGame: () => game });
const getRecipePacks = (options) => craftingPackService.getRecipePacks(options);
const getPrimaryRecipePack = () => craftingPackService.getPrimaryRecipePack();
const summarizeConfiguredRecipePacks = () => craftingPackService.summarizeConfiguredRecipePacks();
const getItemLookupPacks = () => craftingPackService.getItemLookupPacks();
const getDnd5eItemPacks = () => craftingPackService.getDnd5eItemPacks();
const recipeRepository = createRecipeRepository({
  moduleId: MODULE_ID,
  recipeFlag: RECIPE_FLAG,
  defaultIcon: DEFAULT_RECIPE_ICON,
  getRecipePacks: () => getRecipePacks(),
  getWorldItems: () => game.items ?? [],
  fromUuid: (uuid) => safeFromUuid(uuid)
});
const CURRENCY_TO_CP = {
  cp: 1,
  sp: 10,
  ep: 50,
  gp: 100,
  pp: 1000
};
const CURRENCY_FROM_HIGH_TO_LOW = ["pp", "gp", "ep", "sp", "cp"];
const VALID_OUTCOME_TYPES = new Set(["success", "failure", "partialSuccess", "criticalSuccess", "criticalFailure"]);
const VALID_PENDING_OUTCOME_RESOLUTIONS = new Set(PENDING_OUTCOME_RESOLUTIONS);
const craftingState = createCraftingStateService({
  moduleId: MODULE_ID,
  craftRequestsFlag: CRAFT_REQUESTS_FLAG,
  ongoingCraftsFlag: ONGOING_CRAFTS_FLAG,
  pendingOutcomesFlag: PENDING_OUTCOMES_FLAG,
  defaultIcon: DEFAULT_RECIPE_ICON
});
const getActorCraftRequests = craftingState.getCraftRequests;
const getActorOngoingCrafts = craftingState.getOngoingCrafts;
const getActorPendingOutcomes = craftingState.getPendingOutcomes;
const saveActorCraftRequests = craftingState.saveCraftRequests;
const saveActorOngoingCrafts = craftingState.saveOngoingCrafts;
const saveActorPendingOutcomes = craftingState.savePendingOutcomes;
const setNormalizedActorFlag = craftingState.setActorFlag;
const craftRequestService = createCraftRequestService({
  state: craftingState,
  assertActorAccess: assertCanModifyCraftingActor,
  assertManagerAccess: assertCanManageCrafting,
  createId: () => foundry.utils.randomID()
});
const pendingOutcomeService = createPendingOutcomeService({
  state: craftingState,
  assertActorAccess: assertCanModifyCraftingActor,
  assertManagerAccess: assertCanManageCrafting,
  createId: () => foundry.utils.randomID()
});
const craftingSocketExecutor = createCraftingSocketExecutor({
  moduleId: MODULE_ID,
  resolveActor: async (uuid) => {
    const actor = await safeFromUuid(uuid);
    return actor?.documentName === "Actor" ? actor : null;
  },
  authorize: ({ action, actor, senderUser }) => {
    if (action.startsWith("gm.")) assertCanManageCrafting(senderUser);
    else assertCanModifyCraftingActor(actor, senderUser);
  },
  readLedger: (actor) => actor.getFlag(MODULE_ID, OPERATION_LEDGER_FLAG),
  writeLedger: (actor, entries) => actor.setFlag(MODULE_ID, OPERATION_LEDGER_FLAG, entries)
});

craftingSocketExecutor
  .register("work.add", handleSocketWorkAdded)
  .register("request.create", handleSocketRequestCreated)
  .register("request.claim", handleSocketRequestClaimed)
  .register("request.release", handleSocketRequestReleased)
  .register("craft.commit", handleSocketCraftCommitted)
  .register("gm.request.decide", handleSocketRequestDecided)
  .register("gm.request.clear", handleSocketRequestCleared)
  .register("gm.request.prune", handleSocketRequestsPruned)
  .register("gm.outcome.resolve", handleSocketPendingOutcomeResolved)
  .register("gm.outcome.cancel", handleSocketPendingOutcomeCancelled)
  .register("gm.outcome.prune", handleSocketPendingOutcomesPruned)
  .register("gm.operation.review", handleSocketOperationReviewed)
  .register("gm.progress.ready", handleSocketProgressReady)
  .register("gm.progress.clear", handleSocketProgressCleared)
  .register("gm.progress.prune", handleSocketProgressPruned);

const CATEGORY_OPTIONS = [
  { value: "alchemy", label: "Alchemy", i18nKey: "CRAFTINGTABLE.Option.Alchemy" },
  { value: "cooking", label: "Cooking", i18nKey: "CRAFTINGTABLE.Option.Cooking" },
  { value: "smithing", label: "Smithing", i18nKey: "CRAFTINGTABLE.Option.Smithing" },
  { value: "poisons", label: "Poisons", i18nKey: "CRAFTINGTABLE.Option.Poisons" },
  { value: "ammunition", label: "Ammunition", i18nKey: "CRAFTINGTABLE.Option.Ammunition" },
  { value: "magic-items", label: "Magic Items", i18nKey: "CRAFTINGTABLE.Option.MagicItems" },
  { value: "other", label: "Other", i18nKey: "CRAFTINGTABLE.Option.Other" }
];

const ABILITY_OPTIONS = [
  { value: "str", label: "Strength", i18nKey: "CRAFTINGTABLE.Option.Strength" },
  { value: "dex", label: "Dexterity", i18nKey: "CRAFTINGTABLE.Option.Dexterity" },
  { value: "con", label: "Constitution", i18nKey: "CRAFTINGTABLE.Option.Constitution" },
  { value: "int", label: "Intelligence", i18nKey: "CRAFTINGTABLE.Option.Intelligence" },
  { value: "wis", label: "Wisdom", i18nKey: "CRAFTINGTABLE.Option.Wisdom" },
  { value: "cha", label: "Charisma", i18nKey: "CRAFTINGTABLE.Option.Charisma" }
];

const MODE_OPTIONS = [
  { value: "automatic", label: "Automatic", i18nKey: "CRAFTINGTABLE.Option.Automatic" },
  { value: "gm-approval", label: "GM Approval", i18nKey: "CRAFTINGTABLE.Option.GMApproval" },
  { value: "manual", label: "Manual", i18nKey: "CRAFTINGTABLE.Option.Manual" }
];

const RARITY_OPTIONS = [
  { value: "common", label: "Common", i18nKey: "CRAFTINGTABLE.Option.Common" },
  { value: "uncommon", label: "Uncommon", i18nKey: "CRAFTINGTABLE.Option.Uncommon" },
  { value: "rare", label: "Rare", i18nKey: "CRAFTINGTABLE.Option.Rare" },
  { value: "veryRare", label: "Very Rare", i18nKey: "CRAFTINGTABLE.Option.VeryRare" },
  { value: "legendary", label: "Legendary", i18nKey: "CRAFTINGTABLE.Option.Legendary" }
];

const TIME_UNIT_OPTIONS = [
  { value: "minutes", label: "minutes", i18nKey: "CRAFTINGTABLE.Option.Minutes" },
  { value: "hours", label: "hours", i18nKey: "CRAFTINGTABLE.Option.Hours" },
  { value: "days", label: "days", i18nKey: "CRAFTINGTABLE.Option.Days" },
  { value: "weeks", label: "weeks", i18nKey: "CRAFTINGTABLE.Option.Weeks" }
];

const DENOMINATION_OPTIONS = [
  { value: "cp", label: "cp" },
  { value: "sp", label: "sp" },
  { value: "ep", label: "ep" },
  { value: "gp", label: "gp" },
  { value: "pp", label: "pp" }
];

const RECIPE_SORT_OPTIONS = [
  { value: "updated", label: "Recently Updated", i18nKey: "CRAFTINGTABLE.Option.RecentlyUpdated" },
  { value: "name", label: "Name", i18nKey: "CRAFTINGTABLE.GM.Name" },
  { value: "rarity", label: "Rarity", i18nKey: "CRAFTINGTABLE.GM.Rarity" },
  { value: "time", label: "Time", i18nKey: "CRAFTINGTABLE.GM.Time" },
  { value: "cost", label: "Cost", i18nKey: "CRAFTINGTABLE.GM.Cost" }
];

const RECIPE_TIME_FILTER_OPTIONS = [
  { value: "any", label: "Any", i18nKey: "CRAFTINGTABLE.Option.Any" },
  { value: "minutes", label: "Minutes", i18nKey: "CRAFTINGTABLE.Option.Minutes" },
  { value: "hours", label: "Hours", i18nKey: "CRAFTINGTABLE.Option.Hours" },
  { value: "days", label: "Days", i18nKey: "CRAFTINGTABLE.Option.Days" },
  { value: "weeks", label: "Weeks", i18nKey: "CRAFTINGTABLE.Option.Weeks" }
];

const REQUEST_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All", i18nKey: "CRAFTINGTABLE.Option.Any" },
  { value: "pending", label: "Pending", i18nKey: "CRAFTINGTABLE.GM.Pending" },
  { value: "approved", label: "Approved", i18nKey: "CRAFTINGTABLE.GM.Approved" },
  { value: "processing", label: "Processing", i18nKey: "CRAFTINGTABLE.GM.Processing" },
  { value: "rejected", label: "Rejected", i18nKey: "CRAFTINGTABLE.GM.Rejected" },
  { value: "completed", label: "Completed", i18nKey: "CRAFTINGTABLE.GM.Completed" }
];

const REQUEST_SORT_OPTIONS = [
  { value: "updatedDesc", label: "Recently Updated", i18nKey: "CRAFTINGTABLE.Option.RecentlyUpdated" },
  { value: "updatedAsc", label: "Oldest Updated", i18nKey: "CRAFTINGTABLE.Option.OldestUpdated" },
  { value: "actor", label: "Actor", i18nKey: "CRAFTINGTABLE.GM.Actor" },
  { value: "recipe", label: "Recipe", i18nKey: "CRAFTINGTABLE.GM.Recipe" },
  { value: "status", label: "Status", i18nKey: "CRAFTINGTABLE.GM.Status" }
];

const ONGOING_SORT_OPTIONS = [
  { value: "updatedDesc", label: "Recently Updated", i18nKey: "CRAFTINGTABLE.Option.RecentlyUpdated" },
  { value: "updatedAsc", label: "Oldest Updated", i18nKey: "CRAFTINGTABLE.Option.OldestUpdated" },
  { value: "actor", label: "Actor", i18nKey: "CRAFTINGTABLE.GM.Actor" },
  { value: "recipe", label: "Recipe", i18nKey: "CRAFTINGTABLE.GM.Recipe" },
  { value: "progress", label: "Progress", i18nKey: "CRAFTINGTABLE.GM.Progress" }
];

const INGREDIENT_TYPE_OPTIONS = [
  { value: "required", label: "Required", i18nKey: "CRAFTINGTABLE.Option.Required" },
  { value: "optional", label: "Optional", i18nKey: "CRAFTINGTABLE.Option.Optional" }
];

const MATCH_MODE_OPTIONS = [
  { value: "uuid", label: "UUID", i18nKey: "CRAFTINGTABLE.GM.UUID" },
  { value: "name", label: "Name", i18nKey: "CRAFTINGTABLE.GM.Name" },
  { value: "tag", label: "Tag", i18nKey: "CRAFTINGTABLE.Option.Tag" }
];

const FAILURE_RULE_OPTIONS = [
  { value: "noPenalty", label: "No Penalty", i18nKey: "CRAFTINGTABLE.Option.NoPenalty" },
  { value: "loseAllIngredients", label: "Lose All Ingredients", i18nKey: "CRAFTINGTABLE.Option.LoseAllIngredients" },
  { value: "loseHalfIngredients", label: "Lose Half Ingredients", i18nKey: "CRAFTINGTABLE.Option.LoseHalfIngredients" },
  { value: "createFailureItem", label: "Create Failure Item", i18nKey: "CRAFTINGTABLE.Option.CreateFailureItem" },
  { value: "gmDecision", label: "GM Decision", i18nKey: "CRAFTINGTABLE.Option.GMDecision" },
  { value: "customMacro", label: "Custom Macro", i18nKey: "CRAFTINGTABLE.Option.CustomMacro" }
];

const FAILURE_RULE_META = {
  noPenalty: {
    chipLabel: "No Penalty",
    iconClass: "fas fa-shield-alt",
    severityClass: "is-neutral"
  },
  loseAllIngredients: {
    chipLabel: "Lose Ingredients",
    iconClass: "fas fa-skull-crossbones",
    severityClass: "is-warning"
  },
  loseHalfIngredients: {
    chipLabel: "Lose Half",
    iconClass: "fas fa-balance-scale",
    severityClass: "is-warning"
  },
  createFailureItem: {
    chipLabel: "Creates Failure Item",
    iconClass: "fas fa-flask",
    severityClass: "is-info"
  },
  gmDecision: {
    chipLabel: "GM Decision",
    iconClass: "fas fa-dice-d20",
    severityClass: "is-neutral"
  },
  customMacro: {
    chipLabel: "Custom Macro",
    iconClass: "fas fa-scroll",
    severityClass: "is-info"
  }
};

const PARTIAL_EFFECT_OPTIONS = [
  { value: "gmDecision", label: "GM Decision", i18nKey: "CRAFTINGTABLE.Option.GMDecision" },
  { value: "reducedOutput", label: "Reduced Output", i18nKey: "CRAFTINGTABLE.Option.ReducedOutput" },
  { value: "reducedQuality", label: "Reduced Quality", i18nKey: "CRAFTINGTABLE.Option.ReducedQuality" },
  { value: "increasedTime", label: "Increased Time", i18nKey: "CRAFTINGTABLE.Option.IncreasedTime" },
  { value: "consumeExtraMaterials", label: "Consume Extra Materials", i18nKey: "CRAFTINGTABLE.Option.ConsumeExtraMaterials" },
  { value: "unstableItem", label: "Unstable Item", i18nKey: "CRAFTINGTABLE.Option.UnstableItem" },
  { value: "weakerItem", label: "Weaker Item", i18nKey: "CRAFTINGTABLE.Option.WeakerItem" }
];

const QUALITY_TIER_OPTIONS = [
  { value: "poor", label: "Poor", i18nKey: "CRAFTINGTABLE.Option.Poor" },
  { value: "normal", label: "Normal", i18nKey: "CRAFTINGTABLE.Option.Normal" },
  { value: "excellent", label: "Excellent", i18nKey: "CRAFTINGTABLE.Option.Excellent" },
  { value: "masterwork", label: "Masterwork", i18nKey: "CRAFTINGTABLE.Option.Masterwork" }
];

const CRITICAL_SUCCESS_TRIGGER_OPTIONS = [
  { value: "nat20", label: "Natural 20", i18nKey: "CRAFTINGTABLE.Option.Natural20" },
  { value: "beatDcBy5", label: "Beat DC by 5", i18nKey: "CRAFTINGTABLE.Option.BeatDC5" },
  { value: "beatDcBy10", label: "Beat DC by 10", i18nKey: "CRAFTINGTABLE.Option.BeatDC10" },
  { value: "custom", label: "Custom", i18nKey: "CRAFTINGTABLE.Option.Custom" }
];

const CRITICAL_FAILURE_TRIGGER_OPTIONS = [
  { value: "nat1", label: "Natural 1", i18nKey: "CRAFTINGTABLE.Option.Natural1" },
  { value: "missDcBy10", label: "Miss DC by 10", i18nKey: "CRAFTINGTABLE.Option.MissDC10" },
  { value: "custom", label: "Custom", i18nKey: "CRAFTINGTABLE.Option.Custom" }
];

const CRITICAL_FAILURE_EFFECT_OPTIONS = [
  { value: "createFailureItem", label: "Create Failure Item", i18nKey: "CRAFTINGTABLE.Option.CreateFailureItem" },
  { value: "destroyTool", label: "Destroy Tool", i18nKey: "CRAFTINGTABLE.Option.DestroyTool" },
  { value: "gmDecision", label: "GM Decision", i18nKey: "CRAFTINGTABLE.Option.GMDecision" },
  { value: "customMacro", label: "Custom Macro", i18nKey: "CRAFTINGTABLE.Option.CustomMacro" }
];

const CRITICAL_SUCCESS_EFFECT_OPTIONS = [
  { value: "doubleOutput", label: "Double Output", i18nKey: "CRAFTINGTABLE.Option.DoubleOutput" },
  { value: "noGoldCost", label: "No Gold Cost", i18nKey: "CRAFTINGTABLE.Option.NoGoldCost" },
  { value: "reduceTime", label: "Reduce Time", i18nKey: "CRAFTINGTABLE.Option.ReduceTime" },
  { value: "bonusItem", label: "Bonus Item", i18nKey: "CRAFTINGTABLE.Option.BonusItem" }
];

const VISIBILITY_OPTIONS = [
  { value: "hidden", label: "Hidden", i18nKey: "CRAFTINGTABLE.Option.Hidden" },
  { value: "visible", label: "Visible", i18nKey: "CRAFTINGTABLE.Option.Visible" }
];

const KNOWLEDGE_SOURCE_OPTIONS = [
  { value: "globalUnlocked", label: "Global Unlocked", i18nKey: "CRAFTINGTABLE.Option.GlobalUnlocked" },
  { value: "toolProficiency", label: "Unlock with Tool Proficiency", i18nKey: "CRAFTINGTABLE.Option.ToolProficiency" },
  { value: "recipeItem", label: "Only if You Have Recipe", i18nKey: "CRAFTINGTABLE.Option.HaveRecipe" }
];

const CRAFT_PERMISSION_OPTIONS = [
  { value: "anyPlayer", label: "Any Player", i18nKey: "CRAFTINGTABLE.Option.AnyPlayer" },
  { value: "ownerOnly", label: "Owner Only", i18nKey: "CRAFTINGTABLE.Option.OwnerOnly" },
  { value: "gmOnly", label: "GM Only", i18nKey: "CRAFTINGTABLE.Option.GMOnly" },
  { value: "gmApprovalRequired", label: "GM Approval Required", i18nKey: "CRAFTINGTABLE.Option.GMApprovalRequired" }
];

const TOOL_PROFICIENCY_GROUPS = {
  art: [
    "alchemist",
    "brewer",
    "calligrapher",
    "carpenter",
    "cartographer",
    "cobbler",
    "cook",
    "glassblower",
    "jeweler",
    "leatherworker",
    "mason",
    "painter",
    "potter",
    "smith",
    "tinker",
    "weaver",
    "woodcarver"
  ]
};

Hooks.once("init", async () => {
  await foundry.applications.handlebars.loadTemplates(GM_ROW_PARTIALS);
  game.settings.register(MODULE_ID, "migrationVersion", {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "moduleLanguage", {
    name: game.i18n.localize("CRAFTINGTABLE.ModuleLanguage"),
    hint: game.i18n.localize("CRAFTINGTABLE.ModuleLanguageHint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: game.i18n.localize("CRAFTINGTABLE.ModuleLanguageAuto"),
      en: "English",
      pl: "Polski"
    },
    default: "auto",
    onChange: () => refreshOpenCraftingApps()
  });

  game.settings.register(MODULE_ID, "recipeCompendiums", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.RecipeCompendiums.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.RecipeCompendiums.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "useModuleRecipePacks", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.UseModuleRecipePacks.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.UseModuleRecipePacks.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "defaultMode", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.DefaultMode.Name"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      automatic: game.i18n.localize("CRAFTINGTABLE.Option.Automatic"),
      "gm-approval": game.i18n.localize("CRAFTINGTABLE.Option.GMApproval"),
      manual: game.i18n.localize("CRAFTINGTABLE.Option.Manual")
    },
    default: "automatic"
  });

  game.settings.register(MODULE_ID, "useDnd5eItemCompendiums", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.UseDnd5ePacks.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.UseDnd5ePacks.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "itemCompendiums", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.ItemCompendiums.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.ItemCompendiums.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "useModuleItemPacks", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.UseModuleItemPacks.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.UseModuleItemPacks.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "customCategories", {
    name: game.i18n.localize("CRAFTINGTABLE.CustomCategories"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.CustomCategories.Hint"),
    scope: "world",
    config: false,
    type: String,
    default: "[]"
  });

  game.settings.register(MODULE_ID, "gmPanelScale", {
    name: "GM Panel scale (legacy)",
    hint: "Deprecated legacy setting kept for compatibility. Use GM Panel layout instead.",
    scope: "client",
    config: false,
    type: Number,
    range: {
      min: 50,
      max: 200,
      step: 5
    },
    default: 100
  });

  game.settings.register(MODULE_ID, "gmPanelLayout", {
    name: game.i18n.localize("CRAFTINGTABLE.Setting.GmPanelLayout.Name"),
    hint: game.i18n.localize("CRAFTINGTABLE.Setting.GmPanelLayout.Hint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: game.i18n.localize("CRAFTINGTABLE.Setting.Layout.Auto"),
      compact: game.i18n.localize("CRAFTINGTABLE.Setting.Layout.Compact"),
      normal: game.i18n.localize("CRAFTINGTABLE.Setting.Layout.Normal"),
      large: game.i18n.localize("CRAFTINGTABLE.Setting.Layout.Large")
    },
    default: "auto"
  });

  game.keybindings.register(MODULE_ID, "openBench", {
    name: game.i18n.localize("CRAFTINGTABLE.OpenTable"),
    editable: [{ key: "KeyC", modifiers: ["Alt"] }],
    onDown: () => {
      openCraftingBench();
      return true;
    },
    restricted: false
  });

  game.craftingTable = createCraftingTableApi({
    moduleId: MODULE_ID,
    open: openCraftingBench,
    openGm: openCraftingGmPanel,
    getDnd5eItemPacks,
    recipeFlagPath: `flags.${MODULE_ID}.${RECIPE_FLAG}`,
    defaultRecipe: DEFAULT_RECIPE,
    clone: (value) => foundry.utils.deepClone(value),
    createRecipeId: () => createRecipeId(() => foundry.utils.randomID(24)),
    normalizeRecipe: (value) => normalizeRecipeData(value),
    validateRecipe: (value, { itemName = "Recipe" } = {}) => validateRecipeData({ itemName, recipe: normalizeRecipeData(value) }),
    rules: { buildOutcomeExecutionPlan, classifyCraftOutcome, toolHasProficiency, toolNamesMatch },
    json: { extractRecipeImportEntries, slugifyFileName }
  });
});

Hooks.on("renderApplicationV1", (app, html) => queueCraftingTableInjection(app, html));
Hooks.on("renderApplicationV2", (app, element) => queueCraftingTableInjection(app, element));
Hooks.once("tidy5e-sheet.ready", (api) => tidyIntegration.register(api));
Hooks.on("createItem", (item) => handleCraftingItemChange(item));
Hooks.on("updateItem", (item, changes) => handleCraftingItemChange(item, changes));
Hooks.on("deleteItem", (item) => handleCraftingItemChange(item));
Hooks.on("updateActor", (actor, changes) => handleCraftingActorChange(actor, changes));
Hooks.on("updateCompendium", (pack) => handleCraftingCompendiumChange(pack));

Hooks.once("ready", () => {
  craftingSocketExecutor.activate();
  tidyIntegration.register(game.modules.get("tidy5e-sheet")?.api);
  window.setTimeout(() => injectOpenActorSheets(), 250);
  window.setTimeout(() => {
    if (game.users?.activeGM?.id !== game.user?.id) return;
    void migrateCraftingTableData().catch((error) => {
      console.error(`${MODULE_ID} | Could not migrate Crafting Table data`, error);
    });
  }, 500);
});

function queueCraftingTableInjection(app, html) {
  const rootElement = getRootElement(app, html);
  const ownerWindow = rootElement?.ownerDocument?.defaultView ?? window;
  ownerWindow.setTimeout(() => {
    injectCraftingTableButton(app, rootElement);
  }, 0);
}

function injectCraftingTableButton(app, html) {
  if (app instanceof CraftingBenchApp) return;
  if (tidyIntegration.registered && tidyIntegration.isTidyCharacterSheet(app)) return;

  const actor = getActorFromApp(app);
  if (actor?.type !== "character") return;

  const rootElement = getRootElement(app, html);
  if (!rootElement) return;
  if (!isCharacterActorSheetApp(app, rootElement, actor)) return;

  const targetWindow = rootElement.closest?.(".app, .application, .window-app") ?? rootElement;
  if (targetWindow.querySelector?.(".crafting-table-sheet-button, .crafting-table-rail-button, .crafting-table-side-launcher, .crafting-table-floating-button")) return;

  const ownerDocument = rootElement.ownerDocument ?? document;
  const railButton = createCraftingTableButton({ actor, compact: true, document: ownerDocument });
  const tidyTarget = rootElement.querySelector([
    ".tidy5e-sheet .sheet-header .header-actions",
    ".tidy5e-sheet .profile .header-actions",
    ".tidy5e-sheet nav.tabs",
    ".tidy5e-sheet .tabs",
    ".tidy5e-navigation",
    ".tidy-tabs",
    ".sheet-navigation"
  ].join(", "));
  if (tidyTarget) {
    tidyTarget.append(railButton);
    return;
  }

  const rightRailTarget = rootElement.querySelector([
    ".dnd5e2.vertical-tabs nav.tabs.tabs-right",
    "nav.tabs.tabs-right",
    "[data-application-part='tabs'] nav.tabs",
    ".sheet-tabs[aria-orientation='vertical']",
    "nav.tabs[aria-orientation='vertical']",
    ".tabs[aria-orientation='vertical']",
    ".sheet-tabs.vertical",
    "nav.tabs.vertical",
    ".tabs.vertical",
    ".sidebar nav.tabs",
    ".sidebar .tabs",
    ".sheet-sidebar nav.tabs",
    ".sheet-sidebar .tabs"
  ].join(", "));
  if (rightRailTarget) {
    railButton.classList.add("item", "control");
    railButton.setAttribute("data-tooltip", "");
    rightRailTarget.append(railButton);
    return;
  }

  injectCraftingTableSideLauncher(targetWindow, actor, ownerDocument);
}

function createCraftingTableButton({ actor, compact, document: ownerDocument }) {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = compact ? "crafting-table-rail-button" : "crafting-table-sheet-button";
  button.title = game.i18n.localize("CRAFTINGTABLE.OpenTable");
  button.setAttribute("aria-label", button.title);
  button.innerHTML = compact
    ? '<i class="fas fa-hammer"></i>'
    : `<i class="fas fa-hammer"></i><span>${game.i18n.localize("CRAFTINGTABLE.CraftingTable")}</span>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCraftingBench(actor);
  });
  return button;
}

function injectCraftingTableSideLauncher(targetWindow, actor, ownerDocument = document) {
  if (!targetWindow || targetWindow.querySelector?.(".crafting-table-side-launcher")) return;

  const computedStyle = ownerDocument.defaultView?.getComputedStyle?.(targetWindow);
  if (computedStyle?.position === "static") targetWindow.style.position = "relative";

  const dock = ownerDocument.createElement("div");
  dock.className = "crafting-table-side-launcher-dock";

  const button = createCraftingTableButton({ actor, compact: true, document: ownerDocument });
  button.classList.add("crafting-table-side-launcher");

  dock.append(button);
  targetWindow.append(dock);
}

function getActorFromApp(app) {
  const candidates = [
    app?.actor,
    app?.document,
    app?.object,
    app?.token?.actor,
    app?.context?.actor,
    app?.options?.document
  ];
  return candidates.find((candidate) => candidate?.documentName === "Actor") ?? null;
}

function isCharacterActorSheetApp(app, rootElement, actor) {
  if (actor?.type !== "character") return false;

  const actorSheetClass = globalThis.ActorSheet;
  if (actorSheetClass && app instanceof actorSheetClass) return true;

  const constructorName = String(app?.constructor?.name ?? "");
  if (/\b(actor|character).*(sheet)|\b(sheet).*(actor|character)/i.test(constructorName)) return true;

  const targetWindow = rootElement.closest?.(".app, .application, .window-app") ?? rootElement;
  const sheetSelectors = [
    ".actor.sheet",
    ".sheet.actor",
    ".dnd5e.actor",
    ".dnd5e2.actor",
    ".tidy5e-sheet",
    "[data-document-class='Actor']",
    "[data-document-name='Actor']",
    "[data-document-type='Actor']"
  ];
  if (sheetSelectors.some((selector) => rootElement.matches?.(selector) || rootElement.querySelector?.(selector) || targetWindow.matches?.(selector) || targetWindow.querySelector?.(selector))) return true;

  return false;
}

function getRootElement(app, html) {
  if (html?.nodeType === 1) return html;
  if (html?.[0]?.nodeType === 1) return html[0];
  if (app?.element?.nodeType === 1) return app.element;
  if (app?.element?.[0]?.nodeType === 1) return app.element[0];
  if (app?.appId) return document.querySelector(`[data-appid="${app.appId}"]`);
  return null;
}

function getOpenApplicationInstances() {
  const applications = [];
  const addApplications = (iterable) => {
    try {
      for (const app of iterable ?? []) {
        if (app) applications.push(app);
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not enumerate open Foundry applications`, error);
    }
  };

  if (typeof ApplicationV2?.instances === "function") {
    addApplications(ApplicationV2.instances());
  } else {
    addApplications(foundry.applications?.instances?.values?.());
  }
  addApplications(Object.values(ui.windows ?? {}));

  return Array.from(new Set(applications));
}

function injectOpenActorSheets() {
  for (const app of getOpenApplicationInstances()) queueCraftingTableInjection(app, getRootElement(app));
}


function handleCraftingItemChange(item, changes = {}) {
  if (!item) return;
  recipeRepository.invalidateDocument(item);
  const recipe = item.getFlag?.(MODULE_ID, RECIPE_FLAG);
  const actor = item.parent?.documentName === "Actor" ? item.parent : null;
  const recipeChanged = Boolean(changes.flags?.[MODULE_ID]?.[RECIPE_FLAG]);
  if (!recipe?.isRecipe && !recipeChanged && !actor) return;
  refreshOpenCraftingApps({ actorUuid: actor?.uuid ?? null, includeGm: true });
}

function handleCraftingActorChange(actor, changes = {}) {
  const craftingFlagsChanged = changeTouchesPath(changes, `flags.${MODULE_ID}`);
  const actorResourcesChanged = [
    "system.tools",
    "system.traits.toolProf",
    "system.traits.toolProficiencies",
    "system.proficiencies.tools",
    "system.currency",
    "ownership"
  ].some((path) => changeTouchesPath(changes, path));
  if (!craftingFlagsChanged && !actorResourcesChanged) return;
  refreshOpenCraftingApps({ actorUuid: actor?.uuid ?? null, includeGm: craftingFlagsChanged });
}

function changeTouchesPath(changes, path) {
  if (!changes || !path) return false;
  if (foundry.utils.hasProperty(changes, path)) return true;
  const flattened = foundry.utils.flattenObject(changes);
  return Object.keys(flattened).some((key) => key === path || key.startsWith(`${path}.`));
}

function handleCraftingCompendiumChange(pack) {
  recipeRepository.invalidatePack(pack);
  cachedToolOptions = null;
  itemNameLookupCache.clear();
  refreshOpenCraftingApps({ includeGm: true });
}

function refreshOpenCraftingApps({ actorUuid = null, includeGm = false } = {}) {
  for (const app of getOpenApplicationInstances()) {
    const isBench = app instanceof CraftingBenchApp && (!actorUuid || app.actor?.uuid === actorUuid);
    const isGmPanel = includeGm && app instanceof CraftingTableGmApp;
    if (!isBench && !isGmPanel) continue;
    scheduleApplicationRefresh(app);
  }
}

function scheduleApplicationRefresh(app) {
  const activeTimer = applicationRefreshTimers.get(app);
  if (activeTimer) clearTimeout(activeTimer);
  const ownerWindow = app.element?.ownerDocument?.defaultView ?? window;
  const timer = ownerWindow.setTimeout(() => {
    applicationRefreshTimers.delete(app);
    if (app.rendered) app.render({ parts: ["main"] });
  }, 50);
  applicationRefreshTimers.set(app, timer);
}

export async function openCraftingBench(actor = null) {
  const target = actor ?? canvas.tokens?.controlled?.[0]?.actor ?? game.user.character;
  if (!target) {
    ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectActor"));
    return;
  }

  try {
    const existing = findOpenCraftingApplication((app) => app instanceof CraftingBenchApp && app.actor?.uuid === target.uuid);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new CraftingBenchApp(target, { position: getCenteredWindowPosition() });
    await app.render({ force: true });
    return app;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not open Crafting Table`, error);
    ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.OpenFailed"));
    return null;
  }
}

export async function openCraftingGmPanel() {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.GmOnly"));
    return null;
  }

  try {
    const existing = findOpenCraftingApplication((app) => app instanceof CraftingTableGmApp);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new CraftingTableGmApp({ position: getGmPanelPosition() });
    await app.render({ force: true });
    return app;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not open Crafting Table GM Panel`, error);
    ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.OpenGmFailed"));
    return null;
  }
}

function findOpenCraftingApplication(predicate) {
  return getOpenApplicationInstances().find((app) => app.rendered && predicate(app)) ?? null;
}

function getCenteredWindowPosition(width = 1120, height = 720, {
  minimumWidth = PLAYER_PANEL_MIN_WIDTH,
  minimumHeight = PLAYER_PANEL_MIN_HEIGHT
} = {}) {
  return fitApplicationPosition({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    preferredWidth: width,
    preferredHeight: height,
    minimumWidth,
    minimumHeight,
    margin: APPLICATION_VIEWPORT_MARGIN
  });
}

function getGmPanelPosition() {
  const requested = getRequestedGmPanelLayout();
  const layout = requested === "auto" ? "normal" : requested;
  const size = GM_PANEL_LAYOUTS[layout] ?? GM_PANEL_LAYOUTS.normal;
  return getCenteredWindowPosition(size.width, size.height, {
    minimumWidth: GM_PANEL_MIN_WIDTH,
    minimumHeight: GM_PANEL_MIN_HEIGHT
  });
}

function getRequestedGmPanelLayout() {
  const value = String(game.settings.get(MODULE_ID, "gmPanelLayout") ?? "auto");
  return ["auto", "compact", "normal", "large"].includes(value) ? value : "auto";
}

function getResolvedGmPanelLayout(applicationWidth = GM_PANEL_LAYOUTS.normal.width) {
  const requested = getRequestedGmPanelLayout();
  if (requested !== "auto") return requested;
  const widthMode = getApplicationWidthMode(applicationWidth);
  if (["mobile", "compact"].includes(widthMode)) return "compact";
  if (widthMode === "wide" && Number(applicationWidth) >= GM_PANEL_LAYOUTS.large.width) return "large";
  return "normal";
}

function getGmPanelLayoutViewData(applicationWidth) {
  const requested = getRequestedGmPanelLayout();
  const resolved = getResolvedGmPanelLayout(applicationWidth);
  const layout = GM_PANEL_LAYOUTS[resolved] ?? GM_PANEL_LAYOUTS.normal;
  return {
    requested,
    resolved,
    density: layout.density,
    fontScale: layout.fontScale,
    className: `is-layout-${resolved} is-layout-request-${requested}`,
    style: `--ct-gm-density: ${layout.density.toFixed(2)}; --ct-gm-font-scale: ${layout.fontScale.toFixed(2)};`
  };
}

export class CraftingBenchApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    actions: {
      "work-craft": function (_event, target) {
        return this._workSelected(target);
      },
      "finish-craft": function () {
        return this._craftSelected();
      },
      craft: function () {
        return this._craftSelected();
      }
    },
    id: "crafting-table-app-{id}",
    classes: ["dnd5e", "d5ecb-app"],
    position: {
      width: 1120,
      height: 720
    },
    tag: "section",
    window: {
      icon: "fas fa-hammer",
      title: "CRAFTINGTABLE.CraftingTable",
      resizable: true
    }
  };

  static PARTS = {
    shell: { template: TEMPLATE_PATH },
    header: { template: PLAYER_HEADER_TEMPLATE_PATH },
    categories: {
      template: PLAYER_CATEGORIES_TEMPLATE_PATH,
      scrollable: [""]
    },
    recipes: {
      template: PLAYER_RECIPES_TEMPLATE_PATH,
      scrollable: [".d5ecb__recipe-list"]
    },
    details: {
      template: PLAYER_DETAILS_TEMPLATE_PATH,
      scrollable: [""]
    }
  };

  constructor(actor, options = {}) {
    const uniqueId = options.uniqueId || buildApplicationUniqueId(
      "actor",
      actor?.uuid ?? actor?.id,
      foundry.utils.randomID(8)
    );
    super({ ...options, uniqueId });
    this.actor = actor;
    this.category = "all";
    this.visibility = "known";
    this.search = "";
    this.mode = getWorldDefaultCraftingMode();
    this.selectedUuid = null;
    this.optionalIngredientSelections = new Map();
    this.playerView = "browse";
    this._craftingInProgress = false;
  }

  async _prepareContext(options) {
    const requestedParts = new Set(options?.parts ?? Object.keys(this.constructor.PARTS));
    const includeIndex = requestedParts.has("categories") || requestedParts.has("recipes");
    return {
      ...await super._prepareContext(options),
      ...await this._prepareData({
        includeIndex,
        includeDetails: requestedParts.has("details")
      })
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.element) return;

    bindResponsiveApplication(this, {
      preferredWidth: 1120,
      preferredHeight: 720,
      minimumWidth: PLAYER_PANEL_MIN_WIDTH,
      minimumHeight: PLAYER_PANEL_MIN_HEIGHT,
      margin: APPLICATION_VIEWPORT_MARGIN,
      layoutRootSelector: ".d5ecb",
      onWidthModeChange: (mode) => {
        this.widthMode = mode;
        this._syncPlayerViewState();
      }
    });
    this._syncPlayerViewState();
    this._setCraftingBusy(this._craftingInProgress);

    this._eventController?.abort();
    this._eventController = new AbortController();
    const signal = this._eventController.signal;

    addDelegatedListener(this.element, "input", "[name='search']", (_event, target) => {
      this.search = target.value;
      this.playerView = "browse";
      clearTimeout(this._searchRenderTimer);
      this._searchRenderTimer = setTimeout(() => this._renderTable(["categories", "recipes", "details"]), 160);
    }, { signal });

    addDelegatedListener(this.element, "change", "[name='visibility']", (_event, target) => {
      this.visibility = target.value;
      this.playerView = "browse";
      this._renderTable(["categories", "recipes", "details"]);
    }, { signal });

    addDelegatedListener(this.element, "click", ".d5ecb__category", (_event, target) => {
      this.category = target.dataset.category;
      this.playerView = "browse";
      this._renderTable(["categories", "recipes", "details"]);
    }, { signal });

    addDelegatedListener(this.element, "click", ".d5ecb__recipe", async (_event, target) => {
      this.selectedUuid = target.dataset.recipeUuid;
      this.playerView = "details";
      await this._renderTable(["recipes", "details"]);
      if (["compact", "mobile"].includes(this.widthMode)) {
        this.element?.querySelector?.("[data-action='back-to-recipes']")?.focus?.({ preventScroll: true });
      }
    }, { signal });

    addDelegatedListener(this.element, "click", "[data-action='back-to-recipes']", (event) => {
      event.preventDefault();
      this.playerView = "browse";
      this._syncPlayerViewState({ focus: true });
    }, { signal });

    addDelegatedListener(this.element, "change", "[data-optional-ingredient-index]", (_event, target) => {
      const index = Number(target.dataset.optionalIngredientIndex);
      if (!this.selectedUuid || !Number.isInteger(index)) return;
      const selected = new Set(this.optionalIngredientSelections.get(this.selectedUuid) ?? []);
      if (target.checked) selected.add(index);
      else selected.delete(index);
      this.optionalIngredientSelections.set(this.selectedUuid, [...selected].sort((left, right) => left - right));
      this._renderTable(["recipes", "details"]);
    }, { signal });
  }

  _renderTable(parts = ["categories", "recipes", "details"]) {
    return this.render({ parts });
  }

  _syncPlayerViewState({ focus = false } = {}) {
    const root = this.element?.querySelector?.(".d5ecb");
    if (!root) return;
    root.dataset.playerView = this.playerView;
    if (focus && this.playerView === "browse") {
      const selected = Array.from(root.querySelectorAll?.("[data-recipe-uuid]") ?? [])
        .find((entry) => entry.dataset.recipeUuid === this.selectedUuid);
      selected?.focus?.({ preventScroll: true });
    }
  }

  _setCraftingBusy(isBusy) {
    this._craftingInProgress = Boolean(isBusy);
    const root = this.element?.querySelector?.(".d5ecb");
    root?.setAttribute?.("aria-busy", String(this._craftingInProgress));
    const status = this.element?.querySelector?.("[data-crafting-busy-status]");
    if (status) status.hidden = !this._craftingInProgress;
    for (const button of this.element?.querySelectorAll?.("[data-action='craft'], [data-action='work-craft'], [data-action='finish-craft']") ?? []) {
      if (this._craftingInProgress) {
        button.dataset.ctDisabledBeforeBusy ??= String(Boolean(button.disabled));
        button.disabled = true;
      } else if (button.dataset.ctDisabledBeforeBusy !== undefined) {
        button.disabled = button.dataset.ctDisabledBeforeBusy === "true";
        delete button.dataset.ctDisabledBeforeBusy;
      }
      button.classList.toggle("is-loading", this._craftingInProgress);
    }
  }

  _onClose(options) {
    this._eventController?.abort();
    releaseResponsiveApplication(this);
    return super._onClose(options);
  }

  async _prepareData({ includeIndex = true, includeDetails = true } = {}) {
    let categories = [];
    let categoryCount = 0;
    let recipes = [];
    let selectedRecipe = null;

    if (includeIndex) {
      const allRecipes = await this._collectRecipes();
      const summaries = allRecipes.map((recipe) => this._prepareRecipeSummary(recipe));
      const categoryScoped = this._filterRecipeSummaries(summaries, { ignoreCategory: true }).filter((recipe) => !recipe.invalid);
      const candidates = this._filterRecipeSummaries(summaries).filter((recipe) => !recipe.invalid);
      const visible = this.visibility === "ready"
        ? candidates.filter((recipe) => recipe.canCraft || recipe.canWork || recipe.missingSelectedOptional)
        : candidates;

      if (!this.selectedUuid && visible.length) this.selectedUuid = visible[0].uuid;
      if (this.selectedUuid && !visible.some((recipe) => recipe.uuid === this.selectedUuid)) this.selectedUuid = visible[0]?.uuid ?? null;

      categories = this._buildCategories(categoryScoped);
      categoryCount = categoryScoped.length;
      recipes = visible.map((recipe) => ({ ...recipe, selected: recipe.uuid === this.selectedUuid }));

      if (includeDetails) {
        const recipesByUuid = new Map(allRecipes.map((recipe) => [recipe.item.uuid, recipe]));
        const selectedSource = recipesByUuid.get(this.selectedUuid);
        const selectedEntry = selectedSource ? await recipeRepository.resolveEntry(selectedSource) : null;
        selectedRecipe = selectedEntry ? await this._prepareRecipe(selectedEntry) : null;
      }
    } else if (includeDetails) {
      selectedRecipe = await this._prepareSelectedRecipe();
    }

    return {
      actor: this.actor,
      category: this.category,
      categories,
      counts: { all: categoryCount },
      isAllCategory: this.category === "all",
      labels: buildPlayerUiLabels(),
      craftingInProgress: Boolean(this._craftingInProgress),
      playerView: this.playerView,
      recipes,
      search: this.search,
      selectedRecipe,
      visibility: this.visibility,
      visibilityAll: this.visibility === "all",
      visibilityKnown: this.visibility === "known",
      visibilityReady: this.visibility === "ready"
    };
  }

  _prepareRecipeSummary(recipeSource, { user = game.user } = {}) {
    const state = this._getRecipeAvailabilityState(recipeSource, { user });
    const validationErrors = getRecipeValidationErrors(state.item.name, state.recipe);
    const availability = buildRecipeAvailability({
      ...state,
      hasResults: state.resultEntries.length > 0 && state.resultEntries.every((entry) => Boolean(entry?.uuid)),
      localize: ct
    });
    return {
      uuid: state.item.uuid,
      name: state.item.name ?? "",
      img: state.item.img || DEFAULT_RECIPE_ICON,
      category: state.recipe.category || "other",
      categoryLabel: getCategoryLabel(state.recipe.category || "other"),
      known: recipeSource.known,
      invalid: validationErrors.length > 0,
      validationErrors,
      missingSelectedOptional: state.missingSelectedOptional,
      ...availability
    };
  }

  _filterRecipeSummaries(recipes, { ignoreCategory = false } = {}) {
    return filterPlayerRecipeSummaries(recipes, {
      category: ignoreCategory ? "all" : this.category,
      visibility: this.visibility,
      search: this.search
    });
  }

  async _prepareSelectedRecipe() {
    if (!this.selectedUuid) return null;
    const source = (await this._collectRecipes()).find((recipe) => recipe.item.uuid === this.selectedUuid);
    const entry = source ? await recipeRepository.resolveEntry(source) : null;
    return entry ? this._prepareRecipe(entry) : null;
  }

  async _collectRecipes() {
    const actorRecipes = this.actor.items
      .filter((item) => {
        const recipe = item.getFlag(MODULE_ID, RECIPE_FLAG);
        if (!recipe?.isRecipe) return false;
        return game.user.isGM || isRecipeVisibleToPlayers(recipe);
      })
      .map((item) => ({ item, source: "actor", known: true }));

    const worldRecipes = Array.from(game.items ?? [])
      .filter((item) => {
        const recipe = item.getFlag(MODULE_ID, RECIPE_FLAG);
        if (!recipe?.isRecipe) return false;
        return game.user.isGM || isRecipeVisibleToPlayers(recipe);
      })
      .map((item) => ({ item, source: "world", known: this._actorKnowsRecipe(item) }));

    const packRecipes = [];
    for (const item of await recipeRepository.listIndexedItems()) {
      try {
        const data = item.getFlag(MODULE_ID, RECIPE_FLAG);
        if (!data?.isRecipe) continue;
        if (!game.user.isGM && !isRecipeVisibleToPlayers(data)) continue;
        packRecipes.push({ item, source: item.pack ?? "pack", known: this._actorKnowsRecipe(item, data) });
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not read indexed recipe ${item?.uuid ?? item?.name ?? ""}`, error);
      }
    }

    return deduplicatePlayerRecipeSources([...worldRecipes, ...packRecipes, ...actorRecipes].map((entry) => ({
      ...entry,
      name: entry.item.name,
      identityKeys: getRecipeIdentityKeys(entry.item)
    })));
  }

  _getRecipeAvailabilityState(recipeSource, { user = game.user } = {}) {
    const item = recipeSource.item;
    const recipe = getRecipeData(item);
    const ingredientEntries = recipe.ingredients ?? [];
    const baseCost = getRecipeCostData(recipe);
    const cost = getAdjustedRecipeCostData(recipe);
    const baseWorkHours = getRecipeWorkHours(recipe);
    const totalWorkHours = getAdjustedRecipeWorkHours(recipe);
    const recipeReference = { recipeId: recipe.recipeId, recipeUuid: item.uuid };
    const progress = this._getCraftProgress(recipeReference, totalWorkHours);
    const pendingGmOutcome = pendingOutcomeService.findActive(this.actor, recipeReference);
    const storedOptionalSelection = pendingGmOutcome
      ? (pendingGmOutcome.optionalIngredientIndexes ?? [])
      : (progress.pendingOutcome
        ? (progress.pendingOutcome.optionalIngredientIndexes ?? [])
        : (this.optionalIngredientSelections?.get(item.uuid) ?? []));
    const optionalIngredientIndexes = normalizeOptionalIngredientSelection(
      ingredientEntries,
      storedOptionalSelection
    ).indexes;
    const ingredientPlan = this._buildIngredientConsumptionPlan(ingredientEntries, { optionalIngredientIndexes });
    const resultEntries = getRecipeResults(recipe);
    const hasTool = this._hasTool(recipe);
    const proficiencyRequired = isRecipeProficiencyRequired(recipe);
    const hasProficiency = !proficiencyRequired || this._hasToolProficiency(recipe);
    const hasIngredients = ingredientPlan.ok;
    const hasCost = this._canPayCost(cost);
    const requiresProgress = totalWorkHours > 0;
    const progressComplete = !requiresProgress || progress.percent >= 100;
    const outcomes = normalizeOutcomesData(recipe);
    const permissions = normalizePermissionsData(recipe);
    const effectiveMode = getEffectiveCraftingMode(recipe, this.mode);
    const permissionState = this._getCraftPermissionState(recipe, item.uuid, effectiveMode, user);
    const missingSelectedOptional = ingredientPlan.states.some((state) => !state.required && state.used && state.available < state.quantity);

    return {
      item,
      recipe,
      recipeSource,
      ingredientEntries,
      ingredientPlan,
      resultEntries,
      baseCost,
      cost,
      baseWorkHours,
      totalWorkHours,
      progress,
      pendingGmOutcome,
      optionalIngredientIndexes,
      selectionLocked: Boolean(progress.pendingOutcome || pendingGmOutcome),
      hasTool,
      proficiencyRequired,
      hasProficiency,
      hasIngredients,
      hasCost,
      requiresProgress,
      progressComplete,
      outcomes,
      permissions,
      effectiveMode,
      permissionState,
      missingSelectedOptional,
      known: recipeSource.known
    };
  }

  async _prepareRecipe(recipeSource, { user = game.user } = {}) {
    const state = this._getRecipeAvailabilityState(recipeSource, { user });
    const {
      item,
      recipe,
      ingredientEntries,
      ingredientPlan,
      resultEntries,
      baseCost,
      cost,
      baseWorkHours,
      totalWorkHours,
      progress,
      pendingGmOutcome,
      optionalIngredientIndexes,
      selectionLocked,
      hasTool,
      proficiencyRequired,
      hasProficiency,
      hasIngredients,
      hasCost,
      requiresProgress,
      progressComplete,
      outcomes,
      permissions,
      effectiveMode,
      permissionState,
      missingSelectedOptional
    } = state;
    const optionalIngredientSet = new Set(optionalIngredientIndexes);
    const ingredients = await Promise.all(ingredientEntries.map((entry, index) => this._prepareIngredient(entry, {
      index,
      selected: optionalIngredientSet.has(index),
      selectionLocked
    })));
    for (const state of ingredientPlan.states) {
      if (!state.used) continue;
      const ingredient = ingredients[state.index];
      if (!ingredient) continue;
      ingredient.available = state.available >= state.quantity;
      ingredient.statusClass = ingredient.available ? "ok" : "bad";
      ingredient.statusLabel = ingredient.available
        ? (ingredient.required ? ct("ui.ok") : ct("ui.selected"))
        : ct("ui.missing");
    }
    const results = await Promise.all(resultEntries.map((entry) => this._prepareResult(entry)));
    const result = results[0] ?? await this._prepareResult(null);
    const hasResults = results.length > 0 && results.every((entry) => entry.uuid);
    const availability = buildRecipeAvailability({ ...state, hasResults, localize: ct });
    const { blockers, canCraft, canWork, nextStep, permissionReady, statusClass, statusIconClass, statusLabel, statusSummary } = availability;
    const adjustedDc = getAdjustedRecipeDc(recipe);
    const requiredIngredients = ingredients.filter((entry) => entry.required);
    const availableRequiredIngredients = requiredIngredients.filter((entry) => entry.available).length;

    return {
      uuid: item.uuid,
      recipeId: recipe.recipeId,
      recipeRevision: JSON.stringify(recipe),
      optionalIngredientIndexes,
      name: item.name,
      img: item.img,
      category: recipe.category || "other",
      categoryLabel: getCategoryLabel(recipe.category || "other"),
      recipeTypeLabel: ct("ui.recipeType", { category: getCategoryLabel(recipe.category || "other") }),
      toolName: recipe.toolName || ct("ui.anyAppropriateTool"),
      ability: recipe.ability || "int",
      abilityLabel: CONFIG.DND5E?.abilities?.[recipe.ability]?.label ?? recipe.ability?.toUpperCase() ?? "INT",
      dc: adjustedDc,
      baseDc: Number(recipe.dc ?? 10),
      hasAdjustedDc: adjustedDc !== Number(recipe.dc ?? 10),
      effectiveMode,
      effectiveModeLabel: getOptionLabel(MODE_OPTIONS, effectiveMode),
      effectiveModeSourceLabel: game.i18n.localize("CRAFTINGTABLE.GM.Recipe"),
      timeLabel: totalWorkHours > 0 ? formatWorkHours(totalWorkHours) : ct("ui.immediate"),
      baseTimeLabel: baseWorkHours > 0 ? formatWorkHours(baseWorkHours) : ct("ui.immediate"),
      hasAdjustedTime: Math.abs(totalWorkHours - baseWorkHours) > 0.001,
      totalWorkHours,
      progress,
      pendingGmOutcome,
      requiresProgress,
      progressComplete,
      canWork,
      workButtonLabel: progress.started ? ct("button.continueCrafting") : ct("button.startCrafting"),
      craftButtonLabel: pendingGmOutcome ? ct("status.awaitingGmDecision") : (permissionState.canRequest ? ct("button.requestApproval") : (requiresProgress ? ct("button.finishCrafting") : ct("button.craft"))),
      finishButtonLabel: pendingGmOutcome ? ct("status.awaitingGmDecision") : (permissionState.canRequest ? ct("button.requestApproval") : (permissionState.pending ? ct("status.approvalPending") : ct("button.finishCraft"))),
      showCraftButton: !requiresProgress || progressComplete,
      costGp: Number(cost.value ?? 0),
      baseCostGp: Number(baseCost.value ?? 0),
      costDenomination: cost.denomination,
      costLabel: formatCurrencyCost(cost),
      baseCostLabel: formatCurrencyCost(baseCost),
      hasAdjustedCost: Number(cost.value ?? 0) !== Number(baseCost.value ?? 0),
      failure: recipe.failure || ct("ui.noFailureText"),
      failureRule: outcomes.failure,
      outcomes,
      ingredients,
      result,
      results,
      hasTool,
      proficiencyRequired,
      hasProficiency,
      hasIngredients,
      missingSelectedOptional,
      hasCost,
      canCraft,
      known: recipeSource.known,
      permissions,
      permissionState,
      source: recipeSource.source,
      statusLabel,
      statusClass,
      statusIconClass,
      statusSummary,
      blockers,
      worldAdjustments: getWorldAdjustmentLabels(),
      nextStep,
      requirementChecklist: [
        { label: ct("ui.requirementTool"), value: recipe.toolName || ct("ui.anyAppropriateTool"), stateLabel: hasTool ? ct("ui.ok") : ct("ui.missing"), stateClass: hasTool ? "ok" : "bad" },
        ...(proficiencyRequired ? [{ label: ct("ui.requirementProficiency"), value: ct("ui.required"), stateLabel: hasProficiency ? ct("ui.ok") : ct("ui.missing"), stateClass: hasProficiency ? "ok" : "bad" }] : []),
        { label: ct("ui.requirementIngredients"), value: `${availableRequiredIngredients}/${requiredIngredients.length || 0} ${ct("ui.required")}`, stateLabel: hasIngredients ? ct("ui.ok") : ct("ui.missing"), stateClass: hasIngredients ? "ok" : "bad" },
        { label: ct("ui.requirementCost"), value: formatCurrencyCost(cost), stateLabel: hasCost ? ct("ui.ok") : ct("ui.missing"), stateClass: hasCost ? "ok" : "bad" },
        { label: ct("ui.requirementResults"), value: `${results.length}`, stateLabel: hasResults ? ct("ui.ok") : ct("ui.missing"), stateClass: hasResults ? "ok" : "bad" },
        { label: ct("ui.requirementPermission"), value: permissionState.statusLabel || ct("ui.readyNow"), stateLabel: permissionReady ? ct("ui.ok") : ct("ui.blocked"), stateClass: permissionReady ? "ok" : "bad" },
        ...(requiresProgress ? [{ label: ct("ui.requirementProgress"), value: progress.text, stateLabel: progressComplete ? ct("ui.complete") : (progress.started ? ct("ui.readyNow") : ct("ui.notStarted")), stateClass: progressComplete ? "ok" : (canWork ? "warn" : "bad") }] : [])
      ]
    };
  }

  async _prepareIngredient(entry, { index = -1, selected = false, selectionLocked = false } = {}) {
    const source = await resolveItemSource(entry);
    const name = entry.name || source?.name || ct("ui.unknownIngredient");
    const quantity = Number(entry.quantity ?? 1);
    const normalizedEntry = { ...entry, name, uuid: entry.uuid || source?.uuid };
    const owned = this._findMatchingIngredientItems(normalizedEntry).reduce((total, item) => total + Number(item.system?.quantity ?? 1), 0);
    const required = isIngredientRequired(entry);
    const available = owned >= quantity;
    const isSelected = !required && selected;
    return {
      uuid: entry.uuid || source?.uuid,
      name,
      quantity,
      owned,
      type: required ? "required" : "optional",
      matchMode: getIngredientMatchMode(entry),
      consumed: entry.consumed !== false,
      index,
      required,
      selected: isSelected,
      selectionDisabled: !required && (selectionLocked || (!available && !selected)),
      available,
      ok: required ? available : true,
      statusClass: available && (required || isSelected) ? "ok" : ((!available && (required || isSelected)) ? "bad" : ""),
      statusLabel: required
        ? (available ? ct("ui.ok") : ct("ui.missing"))
        : (isSelected ? (available ? ct("ui.selected") : ct("ui.missing")) : ct("ui.skipped"))
    };
  }

  async _prepareResult(entry) {
    if (!entry?.uuid && !entry?.name) return { uuid: null, name: ct("ui.noResultConfigured"), img: "icons/svg/mystery-man.svg", quantity: 0 };
    const source = await resolveItemSource(entry);
    return {
      uuid: entry.uuid || source?.uuid,
      sourceUuid: source?.uuid ?? entry.uuid,
      name: entry.name || source?.name || ct("ui.unknownResult"),
      img: entry.img || source?.img || "icons/svg/item-bag.svg",
      quantity: Number(entry.quantity ?? 1)
    };
  }

  _buildCategories(recipes) {
    return buildPlayerCategories(recipes, { activeCategory: this.category });
  }

  _actorKnowsRecipe(recipeItem, recipeData = null) {
    const recipe = recipeData ?? getRecipeData(recipeItem);
    const permissions = normalizePermissionsData(recipe);
    if (permissions.knowledgeSource === "globalUnlocked") return true;
    if (permissions.knowledgeSource === "toolProficiency") return this._hasToolProficiency(recipe);

    return this.actor.items.some((item) => {
      const actorRecipe = item.getFlag(MODULE_ID, RECIPE_FLAG);
      if (!actorRecipe?.isRecipe) return false;
      return recipeItemsShareIdentity(item, getRecipeData(item), recipeItem, recipe);
    });
  }

  _getCraftRequests() {
    return craftRequestService.getRequests(this.actor);
  }

  _getCraftRequestFor(recipeReference, statuses = null) {
    return craftRequestService.findLatest(this.actor, recipeReference, statuses);
  }

  _getCraftPermissionState(recipe, recipeUuid, mode = this.mode, user = game.user) {
    const permissions = normalizePermissionsData(recipe);
    const craftPermission = normalizeCraftPermission(permissions.craftPermission);
    const effectiveMode = normalizeCraftingMode(mode, this.mode);
    const existing = this._getCraftRequestFor({ recipeId: recipe.recipeId, recipeUuid }, ["pending", "approved", "processing"]);
    const canModifyActor = canUserModifyCraftingActor(this.actor, user);
    const base = {
      craftPermission,
      mode: effectiveMode,
      request: existing,
      requestId: existing?.id ?? "",
      canWork: canModifyActor,
      canCraft: canModifyActor,
      canRequest: false,
      pending: existing?.status === "pending",
      approved: existing?.status === "approved",
      statusLabel: "",
      statusClass: "is-ready"
    };

    if (existing?.status === "processing") {
      return {
        ...base,
        canWork: false,
        canCraft: false,
        statusLabel: ct("status.processing"),
        statusClass: "is-ongoing"
      };
    }

    if (user?.isGM) return base;

    if (!canModifyActor) {
      return {
        ...base,
        canWork: false,
        canCraft: false,
        canRequest: false,
        statusLabel: ct("status.ownerOnly"),
        statusClass: "is-blocked"
      };
    }

    if (craftPermission === "gmOnly") {
      return {
        ...base,
        canWork: false,
        canCraft: false,
        statusLabel: ct("status.gmOnly"),
        statusClass: "is-blocked"
      };
    }

    if (craftPermission === "ownerOnly" && !canUserModifyCraftingActor(this.actor, user)) {
      return {
        ...base,
        canWork: false,
        canCraft: false,
        statusLabel: ct("status.ownerOnly"),
        statusClass: "is-blocked"
      };
    }

    if (craftPermission === "gmApprovalRequired" || effectiveMode === "gm-approval") {
      if (existing?.status === "approved") {
        return {
          ...base,
          canCraft: true,
          statusLabel: ct("status.approvedToFinish"),
          statusClass: "is-ready"
        };
      }
      if (existing?.status === "pending") {
        return {
          ...base,
          canCraft: false,
          statusLabel: ct("status.approvalPending"),
          statusClass: "is-ongoing"
        };
      }
      return {
        ...base,
        canCraft: false,
        canRequest: true,
        statusLabel: ct("status.needsGmApproval"),
        statusClass: "is-ongoing"
      };
    }

    return base;
  }

  _hasToolProficiency(recipe) {
    const toolKey = getRecipeToolKey(recipe);
    if (toolKey && toolHasProficiency(this.actor?.system?.tools?.[toolKey])) return true;
    const requiredTools = getRecipeToolRequirementNames(recipe);
    if (!requiredTools.length) return true;
    const actorTools = getActorToolProficiencyNames(this.actor);
    return requiredTools.some((requiredTool) => actorTools.some((actorTool) => toolNamesMatch(actorTool, requiredTool)));
  }

  _hasTool(recipe) {
    const toolName = String(recipe.toolName ?? recipe.requirements?.tool?.name ?? "").trim();
    const toolUuid = String(recipe.toolUuid ?? recipe.requirements?.tool?.uuid ?? "").trim();
    const toolKey = getRecipeToolKey(recipe);
    if (!toolName && !toolUuid && !toolKey) return true;
    if (isNoToolRequiredName(toolName)) return true;
    return Boolean(this._findOwnedToolItem(recipe));
  }

  _findOwnedToolItem(recipe) {
    const toolKey = getRecipeToolKey(recipe);
    return this.actor.items.find((item) => {
      if (recipe.toolUuid && (item.uuid === recipe.toolUuid || item.getFlag("core", "sourceId") === recipe.toolUuid)) return true;
      if (toolKey && findDnd5eToolKey(
        item.system?.identifier,
        item.system?.type?.baseItem,
        item.system?.type?.value,
        item.getFlag("core", "sourceId"),
        item.name
      ) === toolKey) return true;
      return recipe.toolName && item.name.toLowerCase() === recipe.toolName.toLowerCase();
    }) ?? null;
  }

  _findMatchingIngredientItems(entry) {
    return this.actor.items.filter((item) => ingredientMatchesCandidate(entry, {
      uuid: item.uuid,
      sourceId: item.getFlag("core", "sourceId"),
      name: item.name,
      tags: getItemCraftingTags(item)
    }));
  }

  _buildIngredientConsumptionPlan(entries = [], { multiplier = 1, optionalIngredientIndexes = [] } = {}) {
    const remaining = new Map(this.actor.items.map((item) => [item.id, Math.max(0, Number(item.system?.quantity ?? 1))]));
    const consumed = new Map();
    const states = [];
    const selectedOptional = new Set(normalizeOptionalIngredientSelection(entries, optionalIngredientIndexes).indexes);

    const plannedEntries = entries
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => Number(isIngredientRequired(right.entry)) - Number(isIngredientRequired(left.entry)));
    for (const { entry, index } of plannedEntries) {
      const quantity = Math.max(0, Math.ceil(Number(entry.quantity ?? 1) * Number(multiplier ?? 1)));
      const matches = this._findMatchingIngredientItems(entry);
      const available = matches.reduce((total, item) => total + Number(remaining.get(item.id) ?? 0), 0);
      const required = isIngredientRequired(entry);
      const shouldUse = required || selectedOptional.has(index);
      states.push({ entry, index, required, quantity, available, used: shouldUse });
      if (!shouldUse) continue;
      if (available < quantity) return { ok: false, consumed, states };
      if (entry.consumed === false) continue;

      let needed = quantity;
      for (const item of matches) {
        if (needed <= 0) break;
        const itemRemaining = Number(remaining.get(item.id) ?? 0);
        const used = Math.min(itemRemaining, needed);
        if (!used) continue;
        needed -= used;
        remaining.set(item.id, itemRemaining - used);
        consumed.set(item.id, (consumed.get(item.id) ?? 0) + used);
      }
    }

    return { ok: true, consumed, states };
  }

  _availableCurrency() {
    return this.actor.system?.currency ?? {};
  }

  _canPayCost(cost) {
    return getCurrencyValueInCp(this._availableCurrency()) >= getCostValueInCp(cost);
  }

  _getOngoingCrafts() {
    return getActorOngoingCrafts(this.actor);
  }

  _getCraftProgress(recipeReference, totalWorkHours = 0) {
    const reference = typeof recipeReference === "string" ? { recipeUuid: recipeReference } : (recipeReference ?? {});
    const craft = this._getOngoingCrafts().find((entry) => recipeReferencesMatch(entry, reference));
    const total = Math.max(0, Number(totalWorkHours ?? 0), Number(craft?.totalHours ?? 0));
    const worked = Math.min(total, Math.max(0, Number(craft?.workedHours ?? 0)));
    const remaining = Math.max(0, total - worked);
    const percent = total > 0 ? Math.min(100, Math.floor((worked / total) * 100)) : 100;
    return {
      started: worked > 0,
      workedHours: worked,
      totalHours: total,
      remainingHours: remaining,
      percent,
      text: `${formatWorkHours(worked)} / ${formatWorkHours(total)}`,
      remainingText: formatWorkHours(remaining),
      defaultWorkHours: Math.max(0.25, Math.min(1, remaining || 1)),
      pendingOutcome: craft?.pendingOutcome ?? null
    };
  }

  async _setCraftProgress(recipe, workedHours, { totalHours = recipe.totalWorkHours, pendingOutcome = recipe.progress?.pendingOutcome ?? null } = {}) {
    assertCanModifyCraftingActor(this.actor);
    this._activeCraftOperation?.assertCurrent();
    const previousCrafts = foundry.utils.deepClone(this._getOngoingCrafts());
    const reference = { recipeId: recipe.recipeId, recipeUuid: recipe.uuid };
    const total = Math.max(0, Number(totalHours ?? 0));
    const worked = Math.min(total, Math.max(0, Number(workedHours ?? 0)));
    const craft = {
      id: recipe.recipeId,
      recipeId: recipe.recipeId,
      recipeUuid: recipe.uuid,
      recipeName: recipe.name,
      recipeImg: recipe.img,
      workedHours: worked,
      totalHours: total,
      pendingOutcome,
      updatedTime: Date.now()
    };
    const crafts = replaceRecipeReferenceEntry(previousCrafts, reference, craft);
    let saved = false;
    try {
      await saveActorOngoingCrafts(this.actor, crafts);
      saved = true;
      this._activeCraftOperation?.assertCurrent();
    } catch (error) {
      if (saved) {
        try {
          await saveActorOngoingCrafts(this.actor, previousCrafts);
        } catch (rollbackError) {
          throw new CraftingSocketError(
            "operation-pending-review",
            "Crafting progress could not be restored after an interrupted operation.",
            { cause: String(rollbackError?.message ?? rollbackError) }
          );
        }
      }
      throw error;
    }
  }

  async _clearCraftProgress(recipe) {
    assertCanModifyCraftingActor(this.actor);
    this._activeCraftOperation?.assertCurrent();
    const reference = { recipeId: recipe?.recipeId, recipeUuid: recipe?.uuid };
    const previousCrafts = foundry.utils.deepClone(this._getOngoingCrafts());
    const crafts = replaceRecipeReferenceEntry(previousCrafts, reference);
    let saved = false;
    try {
      await saveActorOngoingCrafts(this.actor, crafts);
      saved = true;
      this._activeCraftOperation?.assertCurrent();
    } catch (error) {
      if (saved) {
        try {
          await saveActorOngoingCrafts(this.actor, previousCrafts);
        } catch (rollbackError) {
          throw new CraftingSocketError(
            "operation-pending-review",
            "Completed crafting progress could not be restored after an interrupted operation.",
            { cause: String(rollbackError?.message ?? rollbackError) }
          );
        }
      }
      throw error;
    }
  }

  async _workSelected(button = null) {
    if (this._craftingInProgress) {
      ui.notifications.warn(ct("notify.craftingBusy"));
      return null;
    }
    this._setCraftingBusy(true);
    try {
      assertCanModifyCraftingActor(this.actor);
      return await runExclusiveCraftingOperation({ actor: this.actor, recipeUuid: this.selectedUuid }, async (operation) => {
        const recipe = await this._prepareSelectedRecipe();
        if (!recipe) return null;
        if (!recipe.canWork) {
          ui.notifications.warn(ct("notify.cannotWork"));
          return null;
        }
        const field = button?.closest?.(".d5ecb__progress")?.querySelector?.("[name='workHours']");
        const amount = Math.max(0, Number(field?.value ?? recipe.progress.defaultWorkHours ?? 1));
        if (!Number.isFinite(amount) || amount <= 0) {
          ui.notifications.warn(ct("notify.enterPositiveWork"));
          return null;
        }
        const result = await craftingSocketExecutor.execute("work.add", {
          actorUuid: this.actor.uuid,
          recipeId: recipe.recipeId,
          recipeUuid: recipe.uuid,
          recipeRevision: recipe.recipeRevision,
          amount
        }, { operationId: `${operation.id}:work` });
        await createCraftingMessage({
          actor: this.actor,
          content: ct("chat.progressLogged", {
            recipe: escapeHtml(recipe.name),
            amount: escapeHtml(formatWorkHours(result.addedHours)),
            percent: result.percent
          })
        });
        return this._renderTable();
      });
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderTable();
      throw error;
    } finally {
      this._setCraftingBusy(false);
    }
  }

  async _craftSelected() {
    if (this._craftingInProgress) {
      ui.notifications.warn(ct("notify.craftingBusy"));
      return null;
    }
    this._setCraftingBusy(true);
    try {
      assertCanModifyCraftingActor(this.actor);
      return await runExclusiveCraftingOperation({ actor: this.actor, recipeUuid: this.selectedUuid }, async (operation) => {
        this._activeCraftOperation = operation;
        let approvedRequestId = "";
        let activeRecipeId = "";
        let requestClaimed = false;
        let outcomeResolved = false;
        try {
          let recipe = await this._prepareSelectedRecipe();
          if (!recipe) return null;
          activeRecipeId = recipe.recipeId;
          if (recipe.permissionState?.canRequest) return this._requestCraftApproval(recipe, operation.id);
          if (!recipe.canCraft) {
            ui.notifications.warn(ct("notify.notReadyToCraft"));
            return null;
          }

          approvedRequestId = recipe.permissionState?.approved ? recipe.permissionState.requestId : "";
          if (approvedRequestId) {
            await this._claimCraftRequest(approvedRequestId, operation.id, activeRecipeId);
            requestClaimed = true;
          }

          const resourceFingerprint = captureActorResourceFingerprint(this.actor);
          const recipeRevision = recipe.recipeRevision;
          const pendingOutcome = recipe.progress?.pendingOutcome?.type;
          let outcomeType = pendingOutcome || "success";
          let roll = null;
          if (!pendingOutcome) {
            roll = await this._rollCheck(recipe);
            if (!roll) return null;
            assertActorResourcesUnchanged(this.actor, resourceFingerprint);
            const refreshedRecipe = await this._prepareSelectedRecipe();
            if (!refreshedRecipe || refreshedRecipe.recipeRevision !== recipeRevision || !refreshedRecipe.canCraft) {
              throw new CraftingStateChangedError();
            }
            recipe = refreshedRecipe;
            outcomeType = classifyCraftOutcome({ total: roll.total, natural: getNaturalD20Result(roll), dc: recipe.dc, outcomes: recipe.outcomes });
            const classification = {
              apiVersion: CRAFTING_TABLE_API_VERSION,
              recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
              actor: this.actor,
              recipe,
              roll,
              initialOutcomeType: outcomeType,
              outcomeType
            };
            const shouldContinue = Hooks.call(CRAFTING_TABLE_HOOKS.preClassifyOutcome, classification);
            if (shouldContinue === false) {
              ui.notifications.warn(ct("notify.classificationCancelled"));
              return this._renderTable();
            }
            if (isValidOutcomeType(classification.outcomeType)) outcomeType = classification.outcomeType;
            else if (classification.outcomeType !== outcomeType) {
              console.warn(`${MODULE_ID} | Ignoring invalid outcome type from ${CRAFTING_TABLE_HOOKS.preClassifyOutcome}: ${classification.outcomeType}`);
            }
            Hooks.callAll(CRAFTING_TABLE_HOOKS.classifyOutcome, {
              ...classification,
              outcomeType,
              finalOutcomeType: outcomeType
            });
          }
          operation.assertCurrent();
          if (recipe.effectiveMode === "manual") {
            const result = await this._commitCraftOutcome(recipe, outcomeType, {
              executionId: operation.id,
              requestId: approvedRequestId,
              resumed: Boolean(pendingOutcome),
              manual: true
            });
            outcomeResolved = result.resolved;
            if (!outcomeResolved) return this._renderTable();
            await createCraftingMessage({
              actor: this.actor,
              content: ct("chat.manualOutcome", {
                recipe: escapeHtml(recipe.name),
                outcome: escapeHtml(formatOutcomeLabel(outcomeType))
              })
            });
            return this._renderTable();
          }
          if (outcomeType === "failure") {
            outcomeResolved = await this._resolveCraftFailure(recipe, { executionId: operation.id, requestId: approvedRequestId });
          } else if (outcomeType === "criticalFailure") {
            outcomeResolved = await this._resolveCriticalFailure(recipe, { executionId: operation.id, requestId: approvedRequestId });
          } else {
            outcomeResolved = await this._resolveSuccessfulOutcome(recipe, outcomeType, {
              executionId: operation.id,
              requestId: approvedRequestId,
              resumed: Boolean(pendingOutcome)
            });
          }
          if (!outcomeResolved) return this._renderTable();
          return this._renderTable();
        } finally {
          if (requestClaimed && !outcomeResolved) await this._releaseCraftRequestClaimSafely(approvedRequestId, operation.id, activeRecipeId);
          this._activeCraftOperation = null;
        }
      });
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderTable();
      console.error(`${MODULE_ID} | Crafting resolution failed`, error);
      ui.notifications.error(ct("notify.craftingFailed"));
      return this._renderTable();
    } finally {
      this._setCraftingBusy(false);
    }
  }

  async _commitCraftOutcome(recipe, outcomeType, {
    executionId,
    requestId = "",
    resumed = false,
    manual = false
  } = {}) {
    return craftingSocketExecutor.execute("craft.commit", {
      actorUuid: this.actor.uuid,
      recipeId: recipe.recipeId,
      recipeUuid: recipe.uuid,
      recipeRevision: recipe.recipeRevision,
      outcomeType,
      optionalIngredientIndexes: recipe.optionalIngredientIndexes ?? [],
      executionId,
      requestId,
      resumed,
      manual
    }, { operationId: `${executionId}:commit` });
  }

  async _resolveSuccessfulOutcome(recipe, outcomeType, { executionId, requestId = "", resumed = false } = {}) {
    const result = await this._commitCraftOutcome(recipe, outcomeType, { executionId, requestId, resumed });
    if (!result.resolved && result.kind !== "extra-time") return false;
    if (result.kind === "gm-decision-pending") {
      const message = ct("notify.partialNeedsGm", { recipe: recipe.name });
      await createCraftingMessage({ actor: this.actor, content: `<p>${escapeHtml(message)}</p>` });
      return true;
    }
    if (result.kind === "extra-time") {
      const message = ct("notify.partialExtraTime", { recipe: recipe.name, time: formatWorkHours(result.remainingHours) });
      await createCraftingMessage({ actor: this.actor, content: `<p>${escapeHtml(message)}</p>` });
      return false;
    }
    const resultNames = (result.createdLabels ?? []).join(", ");
    const notes = result.notes?.length ? ` ${result.notes.map(formatExecutionNote).join(" ")}` : "";
    const message = ct("chat.outcomeResolved", {
      outcome: formatOutcomeLabel(outcomeType),
      results: resultNames || recipe.name,
      notes
    });
    await createCraftingMessage({ actor: this.actor, content: `<p><strong>${escapeHtml(recipe.name)}</strong>: ${escapeHtml(message)}</p>` });
    return true;
  }

  async _requestCraftApproval(recipe, executionId) {
    const result = await craftingSocketExecutor.execute("request.create", {
      actorUuid: this.actor.uuid,
      recipeId: recipe.recipeId,
      recipeUuid: recipe.uuid,
      recipeRevision: recipe.recipeRevision,
      progressPercent: recipe.progress?.percent ?? 100
    }, { operationId: `${executionId}:request` });
    if (!result.created) {
      const key = result.request?.status === "pending" ? "request.alreadyPending" : "request.alreadyDecided";
      ui.notifications.info(ct(key, { recipe: recipe.name }));
      return this._renderTable();
    }
    await createCraftingMessage({
      actor: this.actor,
      content: ct("request.chat", {
        actor: escapeHtml(this.actor.name),
        recipe: escapeHtml(recipe.name)
      })
    });
    return this._renderTable();
  }

  async _claimCraftRequest(requestId, executionId, recipeId = "") {
    return craftingSocketExecutor.execute("request.claim", {
      actorUuid: this.actor.uuid,
      recipeId,
      recipeUuid: this.selectedUuid,
      requestId,
      executionId
    }, { operationId: `${executionId}:claim` });
  }

  async _releaseCraftRequestClaimSafely(requestId, executionId, recipeId = "") {
    try {
      return await craftingSocketExecutor.execute("request.release", {
        actorUuid: this.actor.uuid,
        recipeId,
        recipeUuid: this.selectedUuid,
        requestId,
        executionId
      }, { operationId: `${executionId}:release` });
    } catch (error) {
      console.error(`${MODULE_ID} | Could not release craft request claim`, error);
      return false;
    }
  }

  async _rollCheck(recipe) {
    return rollDnd5eCraftingCheck({
      actor: this.actor,
      recipe,
      getToolKey: getRecipeToolKey,
      hasToolProficiency: (targetRecipe) => this._hasToolProficiency(targetRecipe),
      isToolProficient: toolHasProficiency,
      localize: ct,
      escapeHtml
    });
  }

  async _resolveCraftFailure(recipe, { executionId, requestId = "" } = {}) {
    const result = await this._commitCraftOutcome(recipe, "failure", { executionId, requestId });
    if (!result.resolved) return false;
    if (result.kind === "gm-decision-pending") {
      const message = ct("notify.partialNeedsGm", { recipe: recipe.name });
      await createCraftingMessage({ actor: this.actor, content: `<p>${escapeHtml(message)}</p>` });
      return true;
    }
    const type = result.failureType || "loseAllIngredients";
    let message = ct("chat.failure");

    if (type === "loseAllIngredients") {
      message = ct("chat.failureIngredients");
    } else if (type === "loseHalfIngredients") {
      message = ct("chat.failureHalfIngredients");
    } else if (type === "createFailureItem") {
      message = ct("chat.failureItems");
    } else if (type === "noPenalty") {
      message = ct("chat.failureNoPenalty");
    } else if (type === "customMacro") {
      message = ct("chat.failureMacro");
    } else {
      message = ct("chat.failureGm");
    }

    await createCraftingMessage({
      actor: this.actor,
      content: `<p><strong>${escapeHtml(recipe.name)}</strong>: ${escapeHtml(message)}</p>`
    });
    return true;
  }

  async _resolveCriticalFailure(recipe, { executionId, requestId = "" } = {}) {
    const result = await this._commitCraftOutcome(recipe, "criticalFailure", { executionId, requestId });
    if (!result.resolved) return false;
    if (result.kind === "gm-decision-pending") {
      const message = ct("notify.partialNeedsGm", { recipe: recipe.name });
      await createCraftingMessage({ actor: this.actor, content: `<p>${escapeHtml(message)}</p>` });
      return true;
    }
    const effectType = result.effectType || "gmDecision";
    const effect = getOptionLabel(CRITICAL_FAILURE_EFFECT_OPTIONS, effectType);
    const message = ct("chat.criticalFailure", { effect });
    await createCraftingMessage({ actor: this.actor, content: `<p><strong>${escapeHtml(recipe.name)}</strong>: ${escapeHtml(message)}</p>` });
    return true;
  }
  async _consumeIngredients(recipe, { multiplier = 1, plan = null } = {}) {
    assertCanModifyCraftingActor(this.actor);
    this._activeCraftOperation?.assertCurrent();
    plan ??= this._buildIngredientConsumptionPlan(recipe.ingredients, { multiplier });
    if (!plan.ok) throw new Error("Insufficient ingredients during crafting.");
    const updates = [];
    const deletions = [];
    for (const [itemId, used] of plan.consumed) {
      const item = this.actor.items.get(itemId);
      if (!item) throw new Error(`Crafting ingredient ${itemId} is no longer available.`);
      const nextQuantity = Number(item.system?.quantity ?? 1) - used;
      if (nextQuantity <= 0) deletions.push(itemId);
      else updates.push({ _id: itemId, "system.quantity": nextQuantity });
    }
    if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
    if (deletions.length) await this.actor.deleteEmbeddedDocuments("Item", deletions);
    return plan;
  }

  async _consumeCost(cost) {
    assertCanModifyCraftingActor(this.actor);
    this._activeCraftOperation?.assertCurrent();
    const costInCp = getCostValueInCp(cost);
    if (!costInCp) return;
    const currency = normalizeCurrency(this._availableCurrency());
    let remaining = getCurrencyValueInCp(currency) - costInCp;
    if (remaining < 0) {
      ui.notifications.error(ct("notify.notEnoughCurrency"));
      throw new Error("Insufficient currency during crafting.");
    }
    const next = {};
    for (const denomination of CURRENCY_FROM_HIGH_TO_LOW) {
      const value = CURRENCY_TO_CP[denomination];
      next[denomination] = Math.floor(remaining / value);
      remaining -= next[denomination] * value;
    }
    await this.actor.update({
      "system.currency.cp": next.cp,
      "system.currency.sp": next.sp,
      "system.currency.ep": next.ep,
      "system.currency.gp": next.gp,
      "system.currency.pp": next.pp
    });
  }

  async _executeCraftTransaction(recipe, execution = {}, {
    resultEntries = recipe.results ?? [],
    cost = { value: recipe.costGp, denomination: recipe.costDenomination },
    destroyTool = false,
    optionalIngredientIndexes = recipe.optionalIngredientIndexes ?? [],
    finalize = null
  } = {}) {
    assertCanModifyCraftingActor(this.actor);
    this._activeCraftOperation?.assertCurrent();
    const effectiveCost = execution.waiveCost ? { value: 0, denomination: cost.denomination || "gp" } : cost;
    if (!this._canPayCost(effectiveCost)) throw new Error("Insufficient currency during crafting.");

    const ingredientMultiplier = Math.max(0, Number(execution.ingredientMultiplier ?? 1));
    const ingredientPlan = this._buildIngredientConsumptionPlan(recipe.ingredients, {
      multiplier: ingredientMultiplier,
      optionalIngredientIndexes
    });
    if (!ingredientPlan.ok) throw new Error("Insufficient ingredients during crafting.");

    const normalResults = selectChanceResults(resultEntries).map((result) => ({ result, bonus: false }));
    const bonusResults = selectChanceResults(execution.bonusResults ?? []).map((result) => ({ result, bonus: true }));
    const outputs = [...normalResults, ...bonusResults];
    const loadedOutputs = await this._loadResultEntries(outputs.map((entry) => entry.result));
    if (loadedOutputs.some((entry) => !entry.source)) throw new Error("One or more crafting result items could not be loaded.");

    const toolItem = destroyTool ? this._findOwnedToolItem(recipe) : null;
    if (destroyTool && !toolItem) throw new Error("The required tool could not be found for the critical failure.");

    const transaction = captureCraftTransactionState({
      actor: this.actor,
      itemIds: [...ingredientPlan.consumed.keys(), ...(toolItem ? [toolItem.id] : [])],
      currency: normalizeCurrency(this._availableCurrency())
    });

    try {
      await this._consumeCost(effectiveCost);
      await this._consumeIngredients(recipe, { plan: ingredientPlan });
      for (let index = 0; index < loadedOutputs.length; index += 1) {
        this._activeCraftOperation?.assertCurrent();
        const loaded = loadedOutputs[index];
        const metadata = outputs[index];
        const record = await this._createResult({ ...recipe, result: metadata.result }, loaded.source, {
          quantityMultiplier: metadata.bonus ? 1 : Number(execution.outputMultiplier ?? 1),
          itemTraits: execution.itemTraits ?? []
        });
        if (!record) throw new Error(`Could not create crafting result ${metadata.result.name ?? metadata.result.uuid}.`);
        transaction.resultRecords.push(record);
      }
      this._activeCraftOperation?.assertCurrent();
      if (toolItem && this.actor.items.get(toolItem.id)) await this.actor.deleteEmbeddedDocuments("Item", [toolItem.id]);
      if (typeof finalize === "function") await finalize();
      return { createdLabels: outputs.map((entry) => entry.result.name || entry.result.uuid).filter(Boolean) };
    } catch (error) {
      const rollback = await rollbackCraftTransaction({
        actor: this.actor,
        ...transaction,
        onError: (rollbackErrors) => console.error(`${MODULE_ID} | Crafting rollback was incomplete`, rollbackErrors)
      });
      if (!rollback.complete) {
        throw new CraftingSocketError(
          "operation-pending-review",
          "The crafting transaction could not be fully rolled back. GM review is required.",
          { cause: String(error?.message ?? error), rollbackErrors: rollback.errors.map((entry) => String(entry?.message ?? entry)) }
        );
      }
      throw error;
    }
  }

  async _loadResultEntries(results = []) {
    return Promise.all(results.map(async (result) => {
      const sourceUuid = result.sourceUuid || result.uuid;
      return { result, source: await safeFromUuid(sourceUuid) };
    }));
  }

  async _createResult(recipe, source = null, { quantityMultiplier = 1, itemTraits = [] } = {}) {
    const sourceUuid = recipe.result.sourceUuid || recipe.result.uuid;
    source ??= await safeFromUuid(sourceUuid);
    if (!source) return false;
    const data = source.toObject();
    delete data._id;
    data.system = data.system ?? {};
    data.flags = data.flags ?? {};
    data.flags.core = data.flags.core ?? {};
    if (sourceUuid && !data.flags.core.sourceId) data.flags.core.sourceId = sourceUuid;
    const traits = Array.from(new Set(itemTraits.filter(Boolean))).sort();
    data.flags[MODULE_ID] = data.flags[MODULE_ID] ?? {};
    if (traits.length) data.flags[MODULE_ID].craftedOutcome = { traits };
    data.name = applyCraftOutcomeName(data.name || recipe.result.name, traits);

    const baseQuantity = Math.max(1, Number(data.system.quantity ?? 1)) * Math.max(1, Number(recipe.result.quantity ?? 1));
    const craftedQuantity = Math.max(1, Math.floor(baseQuantity * Math.max(0.01, Number(quantityMultiplier ?? 1))));
    const existing = this._findStackableResultItem({
      name: data.name || recipe.result.name,
      type: data.type,
      sourceUuid,
      traits
    });

    if (existing) {
      const currentQuantity = Math.max(0, Number(existing.system?.quantity ?? 1));
      await existing.update({ "system.quantity": currentQuantity + craftedQuantity });
      return { type: "update", itemId: existing.id, previousQuantity: currentQuantity };
    }

    data.system.quantity = craftedQuantity;
    const created = await this.actor.createEmbeddedDocuments("Item", [data]);
    return { type: "create", itemIds: created.map((item) => item.id) };
  }

  _findStackableResultItem(result) {
    const sourceUuid = String(result.sourceUuid ?? "").trim();
    const normalizedName = normalizeName(result.name);
    const expectedTraits = JSON.stringify(Array.from(new Set(result.traits ?? [])).sort());
    return this.actor.items.find((item) => {
      const itemTraits = item.getFlag(MODULE_ID, "craftedOutcome")?.traits ?? [];
      if (JSON.stringify(Array.from(new Set(itemTraits)).sort()) !== expectedTraits) return false;
      const sourceId = String(item.getFlag("core", "sourceId") ?? "").trim();
      if (sourceUuid && sourceId === sourceUuid) return true;
      if (result.type && item.type && item.type !== result.type) return false;
      return normalizedName && normalizeName(item.name) === normalizedName;
    });
  }
}

const GM_APPLICATION_ACTIONS = Object.fromEntries([
  "add-ingredient-row",
  "add-optional-row",
  "remove-ingredient-row",
  "add-result-row",
  "remove-result-row",
  "clear-result",
  "add-outcome-result",
  "remove-outcome-result",
  "add-outcome-effect",
  "remove-outcome-effect",
  "move-row-up",
  "move-row-down",
  "select-item",
  "choose-icon",
  "clear-icon",
  "expand-all-sections",
  "collapse-all-sections",
  "preview-outcomes",
  "import-recipes-from-json",
  "import-recipes-from-compendium",
  "import-selected-recipes-from-compendium",
  "export-selected-recipe",
  "export-selected-recipes",
  "export-all-recipes",
  "clear-recipe-selection",
  "create-recipe",
  "edit-recipe",
  "cancel-edit-recipe",
  "toggle-favorite-recipe",
  "add-category",
  "edit-category",
  "manage-categories",
  "reset-recipe-filters",
  "set-recipe-view",
  "set-recipe-page",
  "approve-craft-request",
  "reject-craft-request",
  "clear-craft-request",
  "mark-ongoing-ready",
  "clear-ongoing-craft",
  "clear-finished-requests",
  "resolve-pending-outcome",
  "cancel-pending-outcome",
  "clear-finished-outcomes",
  "clear-finished-ongoing",
  "save-recipe",
  "duplicate-recipe",
  "delete-recipe"
].map((action) => [action, function (event, target) {
  event.preventDefault();
  event.stopPropagation();
  return this._handleAction(action, target);
}]));

export class CraftingOutcomePreviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "crafting-table-outcome-preview-{id}",
    classes: ["dnd5e", "ctop-app", "ctgm-app"],
    position: {
      width: 840,
      height: 760
    },
    tag: "section",
    window: {
      icon: "fas fa-eye",
      title: "CRAFTINGTABLE.Preview.Title",
      resizable: true
    }
  };

  static PARTS = {
    main: {
      template: OUTCOME_PREVIEW_TEMPLATE_PATH,
      scrollable: [".ctop__body"]
    }
  };

  constructor(previewData, options = {}) {
    const uniqueId = options.uniqueId || buildApplicationUniqueId(
      "recipe",
      previewData?.recipeUuid,
      foundry.utils.randomID(8)
    );
    super({ ...options, uniqueId });
    this.previewData = previewData;
    this.recipeUuid = previewData.recipeUuid || "draft";
    this.accessibilityId = `ctop-${uniqueId}`;
  }

  async _prepareContext(options) {
    return {
      ...await super._prepareContext(options),
      ...this.previewData,
      accessibilityId: this.accessibilityId
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    bindResponsiveApplication(this, {
      preferredWidth: 840,
      preferredHeight: 760,
      minimumWidth: PLAYER_PANEL_MIN_WIDTH,
      minimumHeight: PLAYER_PANEL_MIN_HEIGHT,
      margin: APPLICATION_VIEWPORT_MARGIN
    });
  }

  _onClose(options) {
    releaseResponsiveApplication(this);
    return super._onClose(options);
  }

  async updatePreview(previewData) {
    this.previewData = previewData;
    this.recipeUuid = previewData.recipeUuid || "draft";
    return this.render({ force: true });
  }
}

export class CraftingTableGmApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    actions: GM_APPLICATION_ACTIONS,
    id: "crafting-table-gm-app",
    classes: ["dnd5e", "ctgm-app"],
    position: {
      width: 1280,
      height: 760
    },
    tag: "section",
    window: {
      icon: "fas fa-hammer",
      title: "CRAFTINGTABLE.GmPanel",
      resizable: true
    }
  };

  static TABS = {
    primary: {
      initial: "recipes",
      tabs: [
        { id: "recipes", label: "CRAFTINGTABLE.GM.Recipes" },
        { id: "requests", label: "CRAFTINGTABLE.GM.Requests" },
        { id: "import-export", label: "CRAFTINGTABLE.GM.ImportExport" }
      ]
    }
  };

  static PARTS = {
    shell: { template: GM_TEMPLATE_PATH },
    header: { template: GM_HEADER_TEMPLATE_PATH },
    library: { template: GM_LIBRARY_TEMPLATE_PATH, scrollable: [""] },
    editor: { template: GM_EDITOR_TEMPLATE_PATH, scrollable: [""] },
    preview: { template: GM_PREVIEW_TEMPLATE_PATH, scrollable: [""] },
    importExport: { template: GM_IMPORT_EXPORT_TEMPLATE_PATH, scrollable: [""] },
    requests: { template: GM_REQUESTS_TEMPLATE_PATH, scrollable: [""] }
  };

  constructor(options = {}) {
    super(options);
    this.tabGroups.primary = "recipes";
    this.advancedMode = false;
    this.category = "all";
    this.search = "";
    this.recipeSort = "updated";
    this.recipeView = "list";
    this.recipePage = 1;
    this.recipeFilters = {
      rarity: "all",
      mode: "all",
      time: "any"
    };
    this.requestSearch = "";
    this.requestStatus = "all";
    this.requestSort = "updatedDesc";
    this.ongoingSort = "updatedDesc";
    this.selectedUuid = null;
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    this.isEditingRecipe = false;
    this.recipeDrafts = new RecipeDraftStore();
    this.newRecipeDraftItem = null;
    this.exportPackId = "";
    this.gmResponsiveView = "library";
    this.selectedRecipeUuids = new Set();
    this.collapsedSections = {
      basic: false,
      requirements: false,
      ingredients: false,
      result: false,
      rules: true,
      outcomeFailure: false,
      outcomePartialSuccess: true,
      outcomeCriticalSuccess: true,
      outcomeCriticalFailure: true,
      permissions: true,
      notes: true
    };
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.tabs.importExport = context.tabs["import-export"];
    return {
      ...context,
      ...await this._prepareData()
    };
  }

  async changeTab(tab, group, options = {}) {
    if (group === "primary") {
      await this._captureCurrentDraft();
      tab = normalizeGmActiveTab(tab);
    }
    super.changeTab(tab, group, options);
    if (group === "primary") this._syncPrimaryTabAccessibility(tab);
  }

  _syncPrimaryTabAccessibility(activeTab = this.tabGroups.primary) {
    for (const tab of this.element?.querySelectorAll?.(".ctgm__tabs [data-group='primary'][data-tab]") ?? []) {
      const active = tab.dataset.tab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.removeAttribute("aria-pressed");
      tab.tabIndex = active ? 0 : -1;
    }
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.element) return;

    const gmLayout = GM_PANEL_LAYOUTS[getResolvedGmPanelLayout(this.position?.width)] ?? GM_PANEL_LAYOUTS.normal;
    try {
      bindResponsiveApplication(this, {
        preferredWidth: gmLayout.width,
        preferredHeight: gmLayout.height,
        minimumWidth: GM_PANEL_MIN_WIDTH,
        minimumHeight: GM_PANEL_MIN_HEIGHT,
        margin: APPLICATION_VIEWPORT_MARGIN,
        layoutRootSelector: ".ctgm",
        onWidthModeChange: (mode) => {
          this.widthMode = mode;
          this._syncGmResponsiveView();
        }
      });
      this._syncGmResponsiveView();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to initialize the responsive GM layout.`, error);
    }

    try {
      this._syncRowOrderControls();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to synchronize GM row controls.`, error);
    }

    try {
      this._applyInlineValidation(this.validationErrors, { focus: this._focusValidationAfterRender });
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to synchronize GM validation messages.`, error);
    }
    this._focusValidationAfterRender = false;

    this._eventController?.abort();
    this._eventController = new AbortController();
    const signal = this._eventController.signal;

    addDelegatedListener(this.element, "keydown", "[role='tab']", (event) => {
      handleTabListKeydown(event);
    }, { signal });
    addDelegatedListener(this.element, "click", "[data-gm-responsive-view]", (event, target) => {
      event.preventDefault();
      this._setGmResponsiveView(target.dataset.gmResponsiveView, { focus: true });
    }, { signal });
    addDelegatedListener(this.element, "click", "[data-collapse-toggle]", (event, target) => {
      event.preventDefault();
      this._toggleCollapseSection(target.dataset.collapseToggle);
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='advancedMode']", (_event, target) => {
      this.advancedMode = target.checked;
      this.element.querySelector(".ctgm")?.classList.toggle("is-advanced", this.advancedMode);
    }, { signal });
    const handleEditorChange = (_event, target) => {
      if (target.name === "advancedMode") return;
      this._syncOutcomeEnabledControl(target);
      this._clearInlineFieldError(target);
      this._markCurrentRecipeDirty();
      this._syncPreviewFromForm();
    };
    addDelegatedListener(this.element, "input", "[data-recipe-editor] input, [data-recipe-editor] select, [data-recipe-editor] textarea", handleEditorChange, { signal });
    addDelegatedListener(this.element, "change", "[data-recipe-editor] input, [data-recipe-editor] select, [data-recipe-editor] textarea", handleEditorChange, { signal });
    addDelegatedListener(this.element, "dragover", "[data-drop-zone]", (event, target) => {
      if (this._draggedEditorRow) return;
      if (!this._canUseDropZone(target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }, { signal });
    addDelegatedListener(this.element, "dragenter", "[data-drop-zone]", (_event, target) => {
      if (this._draggedEditorRow) return;
      if (!this._canUseDropZone(target)) return;
      target.classList.add("is-drop-active");
    }, { signal });
    addDelegatedListener(this.element, "dragleave", "[data-drop-zone]", (event, target) => {
      const related = event.relatedTarget;
      if (related && target.contains(related)) return;
      target.classList.remove("is-drop-active");
    }, { signal });
    addDelegatedListener(this.element, "drop", "[data-drop-zone]", (event, target) => {
      if (this._draggedEditorRow) return;
      event.preventDefault();
      target.classList.remove("is-drop-active");
      if (!this._canUseDropZone(target, { notify: true })) return;
      this._handleDrop(event, target);
    }, { signal });
    addDelegatedListener(this.element, "dragstart", "[data-row-drag-handle]", (event, target) => {
      this._startEditorRowDrag(event, target);
    }, { signal });
    addDelegatedListener(this.element, "dragover", "[data-editor-row]", (event, target) => {
      this._overEditorRowDrag(event, target);
    }, { signal });
    addDelegatedListener(this.element, "drop", "[data-editor-row]", (event, target) => {
      this._dropEditorRow(event, target);
    }, { signal });
    addDelegatedListener(this.element, "dragend", "[data-row-drag-handle]", () => {
      this._finishEditorRowDrag();
    }, { signal });
    addDelegatedListener(this.element, "input", "[name='gm-search']", (_event, target) => {
      const value = target.value;
      clearTimeout(this._searchRenderTimer);
      this._searchRenderTimer = setTimeout(async () => {
        await this._captureCurrentDraft();
        this.search = value;
        this.recipePage = 1;
        this._renderPanel(["editor", "preview", "importExport"]);
      }, 180);
    }, { signal });
    addDelegatedListener(this.element, "click", "[data-category]", async (_event, target) => {
      await this._captureCurrentDraft();
      this.category = target.dataset.category;
      this.recipePage = 1;
      this.isEditingRecipe = false;
      this._renderPanel(GM_RECIPE_PARTS);
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='gm-sort']", async (_event, target) => {
      await this._captureCurrentDraft();
      this.recipeSort = target.value || "updated";
      this.recipePage = 1;
      this._renderPanel(["editor", "preview", "importExport"]);
    }, { signal });
    addDelegatedListener(this.element, "change", "[data-gm-filter]", async (_event, target) => {
      await this._captureCurrentDraft();
      const key = target.dataset.gmFilter;
      if (key) this.recipeFilters[key] = target.value;
      this.recipePage = 1;
      this._renderPanel(["editor", "preview", "importExport"]);
    }, { signal });
    addDelegatedListener(this.element, "input", "[name='gm-requests-search']", (_event, target) => {
      const value = target.value;
      clearTimeout(this._requestSearchRenderTimer);
      this._requestSearchRenderTimer = setTimeout(() => {
        this.requestSearch = value;
        this._renderPanel(["requests"]);
      }, 180);
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='gm-requests-status']", (_event, target) => {
      this.requestStatus = target.value || "all";
      this._renderPanel(["requests"]);
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='gm-requests-sort']", (_event, target) => {
      this.requestSort = target.value || "updatedDesc";
      this._renderPanel(["requests"]);
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='gm-ongoing-sort']", (_event, target) => {
      this.ongoingSort = target.value || "updatedDesc";
      this._renderPanel(["requests"]);
    }, { signal });
    addDelegatedListener(this.element, "change", "[data-tool-choice]", (_event, target) => {
      const wrapper = target.closest("[data-drop-zone='tool']");
      const customField = wrapper?.querySelector("[name='recipe.customToolName']");
      customField?.classList.toggle("is-hidden", target.value !== CUSTOM_TOOL_CHOICE && target.value !== CURRENT_TOOL_CHOICE);
    }, { signal });
    addDelegatedListener(this.element, "click", "[data-recipe-uuid]", async (event, target) => {
      if (event.target.closest("[data-action], [data-recipe-bulk-select], .ctgm__bulk-select")) return;
      await this._selectRecipe(target.dataset.recipeUuid);
    }, { signal });
    addDelegatedListener(this.element, "change", "[data-recipe-bulk-select]", (event, target) => {
      event.stopPropagation();
      const uuid = target.dataset.recipeUuid;
      if (!uuid) return;
      if (target.checked) this.selectedRecipeUuids.add(uuid);
      else this.selectedRecipeUuids.delete(uuid);
      this._syncBulkSelectionUi();
    }, { signal });
    addDelegatedListener(this.element, "click", ".ctgm__bulk-select", (event) => {
      event.stopPropagation();
    }, { signal });
    addDelegatedListener(this.element, "change", "[name='recipe-export-pack']", (_event, target) => {
      this.exportPackId = target.value;
    }, { signal });
    addDelegatedListener(this.element, "click", "[data-placeholder]", (_event, target) => {
      const label = target.dataset.placeholder;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.Later", { label }));
    }, { signal });

  }

  _renderPanel(parts = GM_DYNAMIC_PARTS) {
    return this.render({ parts: [...parts] });
  }

  _setGmResponsiveView(view, { focus = false } = {}) {
    if (!["library", "editor", "preview"].includes(view)) return false;
    this.gmResponsiveView = view;
    this._syncGmResponsiveView({ focus });
    return true;
  }

  _syncGmResponsiveView({ focus = false } = {}) {
    const root = this.element?.querySelector?.(".ctgm");
    if (!root) return;
    root.dataset.gmResponsiveView = this.gmResponsiveView;
    const widthMode = root.dataset.ctWidthMode ?? this.widthMode;
    const effectiveView = widthMode === "normal" && this.gmResponsiveView === "library"
      ? "editor"
      : this.gmResponsiveView;
    for (const button of root.querySelectorAll?.("[data-gm-responsive-view]") ?? []) {
      const active = button.dataset.gmResponsiveView === effectiveView;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const pane of root.querySelectorAll?.("[data-gm-responsive-pane]") ?? []) {
      const paneName = pane.dataset.gmResponsivePane;
      const visible = widthMode === "wide"
        || (widthMode === "normal" && (paneName === "library" || paneName === effectiveView))
        || (["compact", "mobile"].includes(widthMode) && paneName === this.gmResponsiveView);
      pane.setAttribute("aria-hidden", String(!visible));
    }
    if (focus) {
      root.querySelector?.(`[data-gm-responsive-view="${effectiveView}"]`)?.focus?.({ preventScroll: true });
    }
  }

  async close(options = {}) {
    if (!options.force) {
      await this._captureCurrentDraft();
      if (this.recipeDrafts.hasUnsavedChanges()) {
        const proceed = await confirmCraftingAction(game.i18n.localize("CRAFTINGTABLE.Dialog.DiscardClosePanel"));
        if (!proceed) return this;
      }
    }
    return super.close(options);
  }

  _onClose(options) {
    this._eventController?.abort();
    releaseResponsiveApplication(this);
    return super._onClose(options);
  }

  async _handleAction(action, element = null) {
    try {
      assertCanManageCrafting();
    } catch (error) {
      if (notifyCraftingOperationError(error)) return null;
      throw error;
    }
    if (action === "add-ingredient-row") return this._addIngredientRow();
    if (action === "add-optional-row") return this._addIngredientRow("optional");
    if (action === "remove-ingredient-row") return this._removeIngredientRow(element);
    if (action === "add-result-row") return this._addResultRow();
    if (action === "remove-result-row") return this._removeResultRow(element);
    if (action === "clear-result") return this._clearResultFields();
    if (action === "preview-outcomes") return this._openOutcomePreview();
    if (action === "add-outcome-result") return this._addOutcomeResultRow(element?.dataset.resultScope);
    if (action === "remove-outcome-result") return this._removeOutcomeResultRow(element);
    if (action === "add-outcome-effect") return this._addOutcomeEffectRow(element?.dataset.effectScope);
    if (action === "remove-outcome-effect") return this._removeOutcomeEffectRow(element);
    if (action === "move-row-up") return this._moveEditorRow(element, -1);
    if (action === "move-row-down") return this._moveEditorRow(element, 1);
    if (action === "select-item") return this._selectItemForEditor(element);
    if (action === "choose-icon") return this._chooseIcon();
    if (action === "clear-icon") return this._clearIcon();
    if (action === "expand-all-sections") return this._setAllCollapseSections(false);
    if (action === "collapse-all-sections") return this._setAllCollapseSections(true);
    if (action === "import-recipes-from-json") return this._importRecipesFromJson();

    if (action === "export-selected-recipe") return this._exportSelectedRecipeToJson();
    if (action === "export-selected-recipes") return this._exportSelectedRecipesToJson();
    if (action === "export-all-recipes") return this._exportAllRecipesToJson();
    if (action === "clear-recipe-selection") return this._clearRecipeSelection();
    if (action === "create-recipe") return this._createRecipe();
    if (action === "edit-recipe") return this._editRecipe(element);
    if (action === "cancel-edit-recipe") return this._cancelRecipeEdit();
    if (action === "toggle-favorite-recipe") return this._toggleFavoriteRecipe(element);
    if (action === "add-category") return this._addCategory();
    if (action === "edit-category") return this._editCategory();
    if (action === "manage-categories") return this._manageCategories();
    if (action === "reset-recipe-filters") return this._resetRecipeFilters();
    if (action === "set-recipe-view") return this._setRecipeView(element?.dataset.view);
    if (action === "set-recipe-page") return this._setRecipePage(element?.dataset.page);
    if (action === "approve-craft-request") return this._updateCraftRequest(element, "approved");
    if (action === "reject-craft-request") return this._updateCraftRequest(element, "rejected");
    if (action === "clear-craft-request") return this._clearCraftRequest(element);
    if (action === "mark-ongoing-ready") return this._markOngoingCraftReady(element);
    if (action === "clear-ongoing-craft") return this._clearOngoingCraft(element);
    if (action === "clear-finished-requests") return this._clearFinishedRequests();
    if (action === "resolve-pending-outcome") return this._resolvePendingOutcome(element);
    if (action === "cancel-pending-outcome") return this._cancelPendingOutcome(element);
    if (action === "clear-finished-outcomes") return this._clearFinishedPendingOutcomes();
    if (action === "clear-finished-ongoing") return this._clearFinishedOngoingCrafts();
    if (action === "review-interrupted-operation") return this._reviewInterruptedOperation(element);
    if (action === "save-recipe") return this._saveSelectedRecipe();
    if (action === "duplicate-recipe") return this._duplicateSelectedRecipe();
    if (action === "delete-recipe") {
      const uuid = element?.dataset.recipeUuid;
      if (uuid && uuid !== this.selectedUuid) this.selectedUuid = uuid;
      return this._deleteSelectedRecipe();
    }
    return null;
  }

    async _openOutcomePreview() {
    const form = this.element?.querySelector("[data-recipe-editor]");
    const item = await this._getSelectedRecipeItem();
    if (!form && !item) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectPreview"));
      return null;
    }

    let itemName = getRecipeDisplayName(item?.name) || game.i18n.localize("CRAFTINGTABLE.Preview.Title");
    let itemImg = item?.img || DEFAULT_RECIPE_ICON;
    let recipe = item ? getRecipeData(item) : foundry.utils.deepClone(DEFAULT_RECIPE);

    if (form) {
      const draft = collectRecipeFormData(form, recipe, item);
      recipe = draft.recipe;
      itemName = draft.itemName || itemName;
      itemImg = draft.itemImg || itemImg;
    }

    const previewData = prepareOutcomePreviewRecipe(recipe, {
      recipeUuid: item?.uuid || this.selectedUuid || "draft",
      recipeName: itemName,
      recipeImg: itemImg
    });
    const existing = findOpenCraftingApplication((app) => app instanceof CraftingOutcomePreviewApp && app.recipeUuid === previewData.recipeUuid);
    if (existing) {
      await existing.updatePreview(previewData);
      existing.bringToFront();
      return existing;
    }

    const app = new CraftingOutcomePreviewApp(previewData, { position: getCenteredWindowPosition(840, 760) });
    await app.render({ force: true });
    return app;
  }

  async _updateCraftRequest(element, status) {
    assertCanManageCrafting();
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const requestId = element?.dataset.requestId;
    if (!actor || !requestId) {
      ui.notifications.warn(ct("request.notFound"));
      return null;
    }

    try {
      return await runExclusiveCraftingOperation({ actor, requestId }, async (operation) => {
        const requests = getActorCraftRequests(actor);
        const request = requests.find((entry) => entry.id === requestId);
        if (!request) {
          ui.notifications.warn(ct("request.notFound"));
          return null;
        }

        const transition = await craftingSocketExecutor.execute("gm.request.decide", {
          actorUuid: actor.uuid,
          requestId,
          status,
          decisionId: operation.id
        }, { operationId: `${operation.id}:decision` });
        if (!transition.changed) {
          ui.notifications.info(ct("request.alreadyDecided"));
          return this._renderPanel();
        }
        await createCraftingMessage({
          actor,
          speaker: ChatMessage.getSpeaker({ alias: "Crafting Table" }),
          content: ct("request.decisionChat", {
            recipe: escapeHtml(request.recipeName),
            actor: escapeHtml(actor.name),
            status: escapeHtml(status)
          })
        });
        ui.notifications.info(ct("request.updated", { status, recipe: request.recipeName }));
        return this._renderPanel();
      });
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderPanel();
      throw error;
    }
  }

  async _clearFinishedRequests() {
    let cleared = 0;
    for (const actor of game.actors ?? []) {
      const requests = getActorCraftRequests(actor);
      if (!requests.length) continue;
      const next = requests.filter((request) => ["pending", "approved", "processing"].includes(request.status));
      if (next.length === requests.length) continue;
      const result = await craftingSocketExecutor.execute("gm.request.prune", { actorUuid: actor.uuid });
      cleared += result.cleared;
    }
    ui.notifications.info(cleared ? ct("request.finishedCleared", { count: cleared }) : ct("request.noFinishedToClear"));
    return this._renderPanel();
  }

  async _resolvePendingOutcome(element) {
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const pendingOutcomeId = element?.dataset.outcomeId;
    const resolution = element?.dataset.resolution;
    if (!actor || !pendingOutcomeId || !VALID_PENDING_OUTCOME_RESOLUTIONS.has(resolution)) {
      ui.notifications.warn(ct("outcomeDecision.notFound"));
      return null;
    }
    const pendingOutcome = pendingOutcomeService.findById(actor, pendingOutcomeId);
    if (!pendingOutcome || pendingOutcome.status !== "pending") {
      ui.notifications.warn(ct("outcomeDecision.notFound"));
      return this._renderPanel();
    }

    try {
      const decisionId = foundry.utils.randomID();
      const result = await craftingSocketExecutor.execute("gm.outcome.resolve", {
        actorUuid: actor.uuid,
        pendingOutcomeId,
        resolution,
        decisionId
      }, { operationId: `${decisionId}:outcome` });
      if (!result?.resolved) {
        ui.notifications.warn(ct("outcomeDecision.notResolved"));
        return this._renderPanel();
      }
      const resultNames = (result.createdLabels ?? []).join(", ");
      const chatContent = result.kind === "extra-time"
        ? ct("outcomeDecision.chatExtraTime", {
          recipe: escapeHtml(pendingOutcome.recipeName),
          actor: escapeHtml(actor.name),
          time: escapeHtml(formatWorkHours(result.remainingHours))
        })
        : ct("outcomeDecision.chatResolved", {
          recipe: escapeHtml(pendingOutcome.recipeName),
          actor: escapeHtml(actor.name),
          resolution: escapeHtml(formatPendingOutcomeResolution(resolution)),
          result: escapeHtml(resultNames || ct("outcomeDecision.noCreatedItems"))
        });
      await createCraftingMessage({
        actor,
        speaker: ChatMessage.getSpeaker({ alias: "Crafting Table" }),
        content: chatContent
      });
      ui.notifications.info(ct("outcomeDecision.resolved", { recipe: pendingOutcome.recipeName }));
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderPanel();
      throw error;
    }
    return this._renderPanel();
  }

  async _cancelPendingOutcome(element) {
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const pendingOutcomeId = element?.dataset.outcomeId;
    if (!actor || !pendingOutcomeId) {
      ui.notifications.warn(ct("outcomeDecision.notFound"));
      return null;
    }
    const pendingOutcome = pendingOutcomeService.findById(actor, pendingOutcomeId);
    if (!pendingOutcome || pendingOutcome.status !== "pending") {
      ui.notifications.warn(ct("outcomeDecision.notFound"));
      return this._renderPanel();
    }

    try {
      const decisionId = foundry.utils.randomID();
      await craftingSocketExecutor.execute("gm.outcome.cancel", {
        actorUuid: actor.uuid,
        pendingOutcomeId,
        decisionId
      }, { operationId: `${decisionId}:cancel-outcome` });
      await createCraftingMessage({
        actor,
        speaker: ChatMessage.getSpeaker({ alias: "Crafting Table" }),
        content: ct("outcomeDecision.chatReturned", {
          recipe: escapeHtml(pendingOutcome.recipeName),
          actor: escapeHtml(actor.name)
        })
      });
      ui.notifications.info(ct("outcomeDecision.returned", { recipe: pendingOutcome.recipeName }));
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderPanel();
      throw error;
    }
    return this._renderPanel();
  }

  async _clearFinishedPendingOutcomes() {
    let cleared = 0;
    for (const actor of game.actors ?? []) {
      const outcomes = getActorPendingOutcomes(actor);
      if (!outcomes.some((entry) => entry.status !== "pending")) continue;
      const result = await craftingSocketExecutor.execute("gm.outcome.prune", { actorUuid: actor.uuid });
      cleared += Number(result.cleared ?? 0);
    }
    ui.notifications.info(cleared
      ? ct("outcomeDecision.finishedCleared", { count: cleared })
      : ct("outcomeDecision.noFinishedToClear"));
    return this._renderPanel();
  }

  async _clearCraftRequest(element) {
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const requestId = element?.dataset.requestId;
    if (!actor || !requestId) {
      ui.notifications.warn(ct("request.notFound"));
      return null;
    }

    try {
      await craftingSocketExecutor.execute("gm.request.clear", { actorUuid: actor.uuid, requestId });
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderPanel();
      throw error;
    }
    ui.notifications.info(ct("request.cleared"));
    return this._renderPanel();
  }

  async _markOngoingCraftReady(element) {
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const craftId = element?.dataset.craftId;
    const recipeId = element?.dataset.recipeId;
    const recipeUuid = element?.dataset.recipeUuid;
    if (!actor || (!craftId && !recipeId && !recipeUuid)) {
      ui.notifications.warn(ct("ongoing.notFound"));
      return null;
    }

    await craftingSocketExecutor.execute("gm.progress.ready", { actorUuid: actor.uuid, craftId, recipeId, recipeUuid });
    ui.notifications.info(ct("ongoing.ready"));
    return this._renderPanel();
  }

  async _clearFinishedOngoingCrafts() {
    let cleared = 0;
    for (const actor of game.actors ?? []) {
      const crafts = getActorOngoingCrafts(actor);
      if (!Array.isArray(crafts) || !crafts.length) continue;
      const next = crafts.filter((entry) => !isOngoingCraftComplete(entry));
      if (next.length === crafts.length) continue;
      const result = await craftingSocketExecutor.execute("gm.progress.prune", { actorUuid: actor.uuid });
      cleared += result.cleared;
    }
    ui.notifications.info(cleared ? ct("ongoing.finishedCleared", { count: cleared }) : ct("ongoing.noFinishedToClear"));
    return this._renderPanel();
  }

  async _clearOngoingCraft(element) {
    const actor = await safeFromUuid(element?.dataset.actorUuid);
    const craftId = element?.dataset.craftId;
    const recipeId = element?.dataset.recipeId;
    const recipeUuid = element?.dataset.recipeUuid;
    if (!actor || (!craftId && !recipeId && !recipeUuid)) {
      ui.notifications.warn(ct("ongoing.notFound"));
      return null;
    }

    await craftingSocketExecutor.execute("gm.progress.clear", { actorUuid: actor.uuid, craftId, recipeId, recipeUuid });
    ui.notifications.info(ct("ongoing.cleared"));
    return this._renderPanel();
  }

  async _reviewInterruptedOperation(element) {
    const actorUuid = element?.dataset.actorUuid;
    const operationId = element?.dataset.operationId;
    if (!actorUuid || !operationId) return null;
    const actor = await safeFromUuid(actorUuid);
    if (!actor) return null;
    try {
      await craftingSocketExecutor.execute("gm.operation.review", {
        actorUuid,
        targetOperationId: operationId
      });
    } catch (error) {
      if (notifyCraftingOperationError(error)) return this._renderPanel();
      throw error;
    }
    ui.notifications.info(game.i18n.localize("CRAFTINGTABLE.GM.InterruptedReviewed"));
    return this._renderPanel();
  }

  _toggleCollapseSection(sectionId) {
    if (!sectionId) return null;
    this.collapsedSections[sectionId] = !Boolean(this.collapsedSections[sectionId]);

    const section = this.element.querySelector(`[data-collapse-section="${sectionId}"]`);
    if (section?.dataset.outcomePanel && section.classList.contains("is-disabled")) {
      this.collapsedSections[sectionId] = true;
      return null;
    }
    const body = section?.querySelector(".ctgm__collapse-body, .ctgm__outcome-body");
    const button = section?.querySelector("[data-collapse-toggle]");
    const isCollapsed = Boolean(this.collapsedSections[sectionId]);
    section?.classList.toggle("is-open", !isCollapsed);
    if (body) body.hidden = isCollapsed;
    button?.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    return null;
  }

  _syncOutcomeEnabledControl(target) {
    const sectionId = {
      "outcomes.partialSuccess.enabled": "outcomePartialSuccess",
      "outcomes.criticalSuccess.enabled": "outcomeCriticalSuccess",
      "outcomes.criticalFailure.enabled": "outcomeCriticalFailure"
    }[target?.name];
    if (!sectionId) return false;

    const enabled = Boolean(target.checked);
    this.collapsedSections[sectionId] = !enabled;
    const section = this.element?.querySelector?.(`[data-collapse-section="${sectionId}"]`);
    const body = section?.querySelector(".ctgm__outcome-body");
    const button = section?.querySelector("[data-collapse-toggle]");
    section?.classList.toggle("is-disabled", !enabled);
    section?.classList.toggle("is-open", enabled);
    if (body) body.hidden = !enabled;
    button?.setAttribute("aria-expanded", enabled ? "true" : "false");
    return true;
  }

  _setAllCollapseSections(collapsed) {
    for (const sectionId of Object.keys(this.collapsedSections)) {
      this.collapsedSections[sectionId] = collapsed;
      const section = this.element.querySelector(`[data-collapse-section="${sectionId}"]`);
      const body = section?.querySelector(".ctgm__collapse-body, .ctgm__outcome-body");
      const button = section?.querySelector("[data-collapse-toggle]");
      section?.classList.toggle("is-open", !collapsed);
      if (body) body.hidden = collapsed;
      button?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    return null;
  }

  _canUseDropZone(target, { notify = false } = {}) {
    if (target?.closest?.("[data-failure-results].is-disabled")) {
      if (notify) ui.notifications.info(game.i18n.localize("CRAFTINGTABLE.Notify.FailureItemFirst"));
      return false;
    }
    return true;
  }

  async _selectRecipe(uuid) {
    if (!uuid) return null;
    if (uuid === this.selectedUuid) {
      this._setGmResponsiveView("editor");
      return null;
    }

    await this._captureCurrentDraft();
    if (this._hasUnsavedChanges(this.selectedUuid)) {
      const proceed = await confirmCraftingAction(game.i18n.localize("CRAFTINGTABLE.Dialog.DiscardSwitchRecipe"));
      if (!proceed) return null;
      this._discardDraft(this.selectedUuid);
    }

    this.selectedUuid = uuid;
    this.isEditingRecipe = false;
    this.gmResponsiveView = "editor";
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    return this._renderPanel();
  }

  async _editRecipe(element = null) {
    const uuid = element?.dataset.recipeUuid;
    if (uuid && uuid !== this.selectedUuid) {
      await this._selectRecipe(uuid);
    }

    if (!this.selectedUuid) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectRecipeEdit"));
      return null;
    }

    this.isEditingRecipe = true;
    this.gmResponsiveView = "editor";
    this.validationErrors = [];
    return this._renderPanel();
  }

  async _cancelRecipeEdit() {
    await this._captureCurrentDraft();
    if (this._hasUnsavedChanges(this.selectedUuid)) {
      const proceed = await confirmCraftingAction(game.i18n.localize("CRAFTINGTABLE.Dialog.DiscardBackToList"));
      if (!proceed) return null;
      this._discardDraft(this.selectedUuid);
    }

    this.isEditingRecipe = false;
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    return this._renderPanel();
  }

  async _toggleFavoriteRecipe(element = null) {
    const uuid = element?.dataset.recipeUuid || this.selectedUuid;
    if (!uuid) return null;
    if (uuid === this.selectedUuid) await this._captureCurrentDraft();

    const item = uuid === this.newRecipeDraftItem?.uuid ? this.newRecipeDraftItem : await safeFromUuid(uuid);
    if (!this._canEditRecipeItem(item)) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.DuplicateFavorite"));
      return null;
    }

    const recipe = item._isCraftingTableDraft
      ? (this.recipeDrafts.get(uuid)?.recipe ?? getRecipeData(item))
      : getRecipeData(item);
    recipe.favorite = !Boolean(recipe.favorite);
    if (item._isCraftingTableDraft) {
      const draft = this.recipeDrafts.get(item.uuid) ?? { itemName: item.name, itemImg: item.img, recipe };
      draft.recipe.favorite = recipe.favorite;
      draft.dirty = true;
      this.recipeDrafts.set(item.uuid, draft);
      this.recipeDrafts.markDirty(item.uuid);
      return this._renderPanel();
    }
    await item.update({ [`flags.${MODULE_ID}.${RECIPE_FLAG}`]: recipe });
    const existingDraft = this.recipeDrafts.get(uuid);
    if (existingDraft) existingDraft.recipe.favorite = recipe.favorite;
    ui.notifications.info(game.i18n.format(recipe.favorite ? "CRAFTINGTABLE.Notify.Favorited" : "CRAFTINGTABLE.Notify.Unfavorited", { recipe: getRecipeDisplayName(item.name) }));
    return this._renderPanel();
  }

  async _addCategory() {
    const label = this._getCategoryToolLabel();
    if (!label) return null;

    const category = normalizeCategoryInput(label);
    if (!category?.id) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.CategoryEmpty"));
      return null;
    }

    await addCustomCategory(category);
    await getOrCreateRecipeCategoryFolder(category.id);
    this.category = category.id;
    this.recipePage = 1;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.CategoryAdded", { category: category.label }));
    return this._renderPanel();
  }

  async _editCategory() {
    if (!this.category || this.category === "all") {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectCategory"));
      return null;
    }

    const label = this._getCategoryToolLabel();
    if (!label) return null;

    const next = normalizeCategoryInput(label);
    if (!next?.id) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.CategoryEmpty"));
      return null;
    }
    if (next.id === this.category) return null;

    const oldId = this.category;
    await replaceCustomCategory(oldId, next);
    const folder = await getOrCreateRecipeCategoryFolder(next.id);
    let updated = 0;
    for (const item of getWorldRecipeItems()) {
      const recipe = getRecipeData(item);
      if (recipe.category !== oldId) continue;
      recipe.category = next.id;
      await item.update({
        folder: folder?.id ?? null,
        [`flags.${MODULE_ID}.${RECIPE_FLAG}`]: recipe
      });
      updated += 1;
    }

    this.category = next.id;
    this.recipePage = 1;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.CategoryRenamed", { category: next.label, count: updated }));
    return this._renderPanel();
  }

  _manageCategories() {
    if (this.category && this.category !== "all") return this._editCategory();
    return this._addCategory();
  }

  _getCategoryToolLabel() {
    const field = this.element?.querySelector?.("[name='gm-category-name']");
    const label = field?.value?.trim() || "";
    if (!label) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.EnterCategory"));
      field?.focus?.();
      return "";
    }
    return label;
  }

  async _resetRecipeFilters() {
    await this._captureCurrentDraft();
    this.recipeFilters = {
      rarity: "all",
      mode: "all",
      time: "any"
    };
    this.search = "";
    this.recipePage = 1;
    return this._renderPanel();
  }

  async _setRecipeView(view = "list") {
    await this._captureCurrentDraft();
    this.recipeView = view === "grid" ? "grid" : "list";
    this.recipePage = 1;
    return this._renderPanel();
  }

  async _setRecipePage(page) {
    await this._captureCurrentDraft();
    if (page === "first") this.recipePage = 1;
    else if (page === "prev") this.recipePage = Math.max(1, this.recipePage - 1);
    else if (page === "next") this.recipePage += 1;
    else if (page === "last") this.recipePage = Number.MAX_SAFE_INTEGER;
    else this.recipePage = Math.max(1, Number(page) || 1);
    return this._renderPanel();
  }

  async _captureCurrentDraft() {
    const form = this.element?.querySelector?.("[data-recipe-editor]");
    if (!form || !this.selectedUuid) return null;

    const item = await this._getSelectedRecipeItem();
    if (!item) return null;

    const existing = this.recipeDrafts.get(this.selectedUuid);
    const isDirty = this._hasUnsavedChanges(this.selectedUuid);
    if (!existing && !isDirty) return null;
    const baseRecipe = existing?.recipe ?? getRecipeData(item);
    const fallbackItem = {
      name: existing?.itemName ?? item.name,
      img: existing?.itemImg ?? item.img
    };
    const draft = collectRecipeFormData(form, baseRecipe, fallbackItem);
    draft.itemImg = this._resolveRecipeItemIcon(draft.itemImg, item, draft.recipe);
    draft.dirty = isDirty;
    this.recipeDrafts.set(this.selectedUuid, draft);
    return draft;
  }

  _markCurrentRecipeDirty() {
    if (!this.selectedUuid) return;
    this.recipeDrafts.markDirty(this.selectedUuid);
    this._setDirtyIndicator(true);
  }

  _hasUnsavedChanges(uuid = this.selectedUuid) {
    return this.recipeDrafts.isDirty(uuid);
  }

  _discardDraft(uuid) {
    if (!uuid) return;
    this.recipeDrafts.discard(uuid);
    if (this.newRecipeDraftItem?.uuid === uuid) {
      this.newRecipeDraftItem = null;
      if (this.selectedUuid === uuid) this.selectedUuid = null;
    }
  }

  _setDirtyIndicator(isDirty) {
    this.element?.querySelectorAll?.("[data-unsaved-indicator]").forEach((node) => {
      node.hidden = !isDirty;
      node.classList.toggle("is-visible", isDirty);
    });
  }

  _syncBulkSelectionUi() {
    const count = this.selectedRecipeUuids.size;
    this.element?.querySelectorAll?.("[data-bulk-selection-count]").forEach((node) => {
      node.textContent = String(count);
    });
    this.element?.querySelectorAll?.("[data-bulk-selection-required]").forEach((node) => {
      node.disabled = count === 0;
    });
  }

  async _addIngredientRow(type = "required", data = {}) {
    const list = this.element.querySelector("[data-ingredient-list]");
    if (!list) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.AddIngredients"));
      return null;
    }

    const row = prepareGmIngredientRow({ ...data, type });
    const html = await foundry.applications.handlebars.renderTemplate(GM_INGREDIENT_ROW_TEMPLATE_PATH, {
      ...row,
      editable: true
    });
    list.querySelector("[data-empty-ingredients]")?.remove();
    list.insertAdjacentHTML("beforeend", html);
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  _removeIngredientRow(element) {
    const row = element?.closest?.("[data-ingredient-row]");
    const list = row?.parentElement;
    row?.remove();
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  async _addResultRow(data = {}) {
    const list = this.element.querySelector("[data-result-list]");
    if (!list) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.AddResults"));
      return null;
    }

    const previousPrimaryIcon = this._getPrimaryResultIcon();
    const row = prepareGmResultRow(data);
    const html = await foundry.applications.handlebars.renderTemplate(GM_RESULT_ROW_TEMPLATE_PATH, {
      ...row,
      editable: true
    });
    list.querySelector("[data-empty-results]")?.remove();
    list.insertAdjacentHTML("beforeend", html);
    this._syncRowOrderControls(list);
    if (!previousPrimaryIcon) this._syncRecipeIconFromResult(data.img, { previousPrimaryIcon });
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  _removeResultRow(element) {
    const row = element?.closest?.("[data-result-row]");
    const list = row?.parentElement;
    row?.remove();
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  async _clearResultFields() {
    const list = this.element.querySelector("[data-result-list]");
    if (list) {
      list.innerHTML = await foundry.applications.handlebars.renderTemplate(GM_RESULT_ROW_TEMPLATE_PATH, {
        ...prepareGmResultRow(),
        editable: true
      });
      this._syncRowOrderControls(list);
      this._markCurrentRecipeDirty();
      this._syncPreviewFromForm();
    }
    return null;
  }

  async _addOutcomeResultRow(scope = "failure", data = {}) {
    const list = this.element.querySelector(`[data-outcome-results='${scope}']`);
    if (!list) return null;

    const html = await foundry.applications.handlebars.renderTemplate(GM_OUTCOME_RESULT_ROW_TEMPLATE_PATH, {
      ...prepareOutcomeResult(data),
      editable: true,
      canCreateResults: true
    });
    list.querySelector("[data-empty-outcome-results]")?.remove();
    list.insertAdjacentHTML("beforeend", html);
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  async _removeOutcomeResultRow(element) {
    const row = element?.closest?.("[data-outcome-result-row]");
    const list = row?.parentElement;
    const scope = list?.dataset.outcomeResults || "failure";
    row?.remove();
    if (list && !list.querySelector("[data-outcome-result-row]")) {
      const html = await foundry.applications.handlebars.renderTemplate(GM_OUTCOME_RESULT_EMPTY_TEMPLATE_PATH, {
        isFailure: scope === "failure"
      });
      list.insertAdjacentHTML("beforeend", html);
    }
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  async _addOutcomeEffectRow(scope = "criticalSuccess", data = {}) {
    const list = this.element.querySelector(`[data-outcome-effects='${scope}']`);
    if (!list) return null;

    const fallbackType = scope === "partialSuccess" ? "gmDecision" : "doubleOutput";
    const html = await foundry.applications.handlebars.renderTemplate(GM_OUTCOME_EFFECT_ROW_TEMPLATE_PATH, {
      ...prepareOutcomeEffect({ type: fallbackType, ...data }, scope),
      editable: true,
      isPartial: scope === "partialSuccess"
    });
    list.querySelector("[data-empty-outcome-effects]")?.remove();
    list.insertAdjacentHTML("beforeend", html);
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  _removeOutcomeEffectRow(element) {
    const row = element?.closest?.("[data-outcome-effect-row]");
    const list = row?.parentElement;
    row?.remove();
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  _syncRowOrderControls(root = this.element) {
    if (!root?.querySelectorAll) return;
    const lists = new Set(Array.from(root.querySelectorAll("[data-editor-row]")).map((row) => row.parentElement).filter(Boolean));
    if (root.matches?.("[data-ingredient-list], [data-result-list], [data-outcome-results], [data-outcome-effects]")) lists.add(root);
    for (const list of lists) {
      const rows = Array.from(list.children).filter((child) => child.matches?.("[data-editor-row]"));
      rows.forEach((row, index) => {
        const up = row.querySelector("[data-action='move-row-up']");
        const down = row.querySelector("[data-action='move-row-down']");
        for (const control of row.querySelectorAll("[data-row-drag-handle], [data-action='move-row-up'], [data-action='move-row-down']")) {
          control.dataset.ctRowLocked ??= String(Boolean(control.disabled));
        }
        if (up) up.disabled = up.dataset.ctRowLocked === "true" || index === 0;
        if (down) down.disabled = down.dataset.ctRowLocked === "true" || index === rows.length - 1;
      });
    }
  }

  _moveEditorRow(element, direction) {
    const row = element?.closest?.("[data-editor-row]");
    const list = row?.parentElement;
    if (!row || !list || element?.disabled) return null;
    const rows = Array.from(list.children).filter((child) => child.matches?.("[data-editor-row]"));
    const currentIndex = rows.indexOf(row);
    const targetIndex = currentIndex + (direction < 0 ? -1 : 1);
    const target = rows[targetIndex];
    if (!target) return null;
    if (direction < 0) target.before(row);
    else target.after(row);
    this._syncRowOrderControls(list);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    row.querySelector(direction < 0 ? "[data-action='move-row-up']" : "[data-action='move-row-down']")?.focus?.({ preventScroll: true });
    return null;
  }

  _startEditorRowDrag(event, handle) {
    if (handle.disabled) return;
    const row = handle.closest("[data-editor-row]");
    if (!row) return;
    this._draggedEditorRow = row;
    row.classList.add("is-row-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "crafting-table-editor-row");
    }
  }

  _overEditorRowDrag(event, target) {
    const dragged = this._draggedEditorRow;
    if (!dragged || target === dragged || target.parentElement !== dragged.parentElement) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.element.querySelectorAll(".is-row-drag-before, .is-row-drag-after").forEach((row) => row.classList.remove("is-row-drag-before", "is-row-drag-after"));
    const placeAfter = event.clientY >= target.getBoundingClientRect().top + (target.getBoundingClientRect().height / 2);
    target.classList.add(placeAfter ? "is-row-drag-after" : "is-row-drag-before");
  }

  _dropEditorRow(event, target) {
    const dragged = this._draggedEditorRow;
    if (!dragged || target === dragged || target.parentElement !== dragged.parentElement) return;
    event.preventDefault();
    event.stopPropagation();
    const placeAfter = event.clientY >= target.getBoundingClientRect().top + (target.getBoundingClientRect().height / 2);
    if (placeAfter) target.after(dragged);
    else target.before(dragged);
    this._syncRowOrderControls(dragged.parentElement);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    this._finishEditorRowDrag();
    dragged.querySelector("[data-row-drag-handle]")?.focus?.({ preventScroll: true });
  }

  _finishEditorRowDrag() {
    this._draggedEditorRow?.classList.remove("is-row-dragging");
    this.element?.querySelectorAll?.(".is-row-drag-before, .is-row-drag-after").forEach((row) => row.classList.remove("is-row-drag-before", "is-row-drag-after"));
    this._draggedEditorRow = null;
  }

  _clearInlineFieldError(field) {
    if (!field) return;
    field.removeAttribute?.("aria-invalid");
    const describedBy = field.getAttribute?.("aria-describedby");
    if (describedBy?.startsWith("ctgm-field-error-")) field.removeAttribute("aria-describedby");
    const container = field.closest?.("label, [data-editor-row], [data-result-list], [data-ingredient-list]");
    container?.classList?.remove("has-field-error");
    container?.querySelectorAll?.(":scope > .ctgm__field-error").forEach((error) => error.remove());
  }

  _setInlineFieldError(field, message) {
    if (!field || !message || field.getAttribute?.("aria-invalid") === "true") return;
    const container = field.matches?.("[data-result-list], [data-ingredient-list]")
      ? field
      : field.closest?.("label") ?? field.closest?.("[data-editor-row]") ?? field;
    const id = `ctgm-field-error-${foundry.utils.randomID(8)}`;
    const error = document.createElement("span");
    error.className = "ctgm__field-error";
    error.id = id;
    error.setAttribute("role", "alert");
    error.textContent = message;
    container.classList?.add("has-field-error");
    container.append?.(error);
    field.setAttribute?.("aria-invalid", "true");
    field.setAttribute?.("aria-describedby", id);
  }

  _applyInlineValidation(errors = [], { focus = false } = {}) {
    const form = this.element?.querySelector?.("[data-recipe-editor]");
    if (!form) return 0;
    form.querySelectorAll(".ctgm__field-error").forEach((error) => error.remove());
    form.querySelectorAll("[aria-invalid='true']").forEach((field) => {
      field.removeAttribute("aria-invalid");
      if (field.getAttribute("aria-describedby")?.startsWith("ctgm-field-error-")) field.removeAttribute("aria-describedby");
    });
    form.querySelectorAll(".has-field-error").forEach((container) => container.classList.remove("has-field-error"));
    if (!errors?.length) return 0;

    const add = (field, message) => this._setInlineFieldError(field, message);
    const value = (selector) => form.querySelector(selector)?.value?.trim?.() ?? "";
    const number = (selector) => Number(value(selector));
    if (!value("[name='recipe.name']")) add(form.querySelector("[name='recipe.name']"), game.i18n.localize("CRAFTINGTABLE.Validation.MissingName"));
    if (!value("[name='recipe.category']")) add(form.querySelector("[name='recipe.category']"), game.i18n.localize("CRAFTINGTABLE.Validation.MissingCategory"));
    if (!value("[name='recipe.dc']") || !Number.isFinite(number("[name='recipe.dc']"))) add(form.querySelector("[name='recipe.dc']"), game.i18n.localize("CRAFTINGTABLE.Validation.DcNumber"));
    if (!value("[name='recipe.costGp']") || !Number.isFinite(number("[name='recipe.costGp']")) || number("[name='recipe.costGp']") < 0) add(form.querySelector("[name='recipe.costGp']"), game.i18n.localize("CRAFTINGTABLE.Validation.CostNegative"));
    if (!Number.isFinite(number("[name='recipe.timeValue']")) || number("[name='recipe.timeValue']") <= 0 || !value("[name='recipe.timeUnit']")) {
      add(form.querySelector("[name='recipe.timeValue']"), game.i18n.localize("CRAFTINGTABLE.Validation.TimeEmpty"));
    }

    const resultRows = Array.from(form.querySelectorAll("[data-result-row]"));
    if (!resultRows.length) add(form.querySelector("[data-result-list]"), game.i18n.localize("CRAFTINGTABLE.Validation.MissingResult"));
    for (const row of resultRows) {
      const nameField = row.querySelector("[name='result.name']");
      const uuidField = row.querySelector("[name='result.uuid']");
      const quantityField = row.querySelector("[name='result.quantity']");
      const label = nameField?.value?.trim() || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedResult");
      if (!nameField?.value?.trim() && !uuidField?.value?.trim()) add(nameField, game.i18n.format("CRAFTINGTABLE.Validation.ResultNoUuid", { name: label }));
      if (!Number.isFinite(Number(quantityField?.value)) || Number(quantityField?.value) <= 0) add(quantityField, game.i18n.format("CRAFTINGTABLE.Validation.ResultQuantity", { name: label }));
    }

    for (const row of form.querySelectorAll("[data-ingredient-row]")) {
      const nameField = row.querySelector("[name='ingredient.name']");
      const uuidField = row.querySelector("[name='ingredient.uuid']");
      const modeField = row.querySelector("[name='ingredient.matchMode']");
      const quantityField = row.querySelector("[name='ingredient.quantity']");
      const label = nameField?.value?.trim() || uuidField?.value?.trim() || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedIngredient");
      if (modeField?.value === "uuid" && !uuidField?.value?.trim() && !nameField?.value?.trim()) add(nameField, game.i18n.format("CRAFTINGTABLE.Validation.IngredientUuidMissing", { name: label }));
      if (!Number.isFinite(Number(quantityField?.value)) || Number(quantityField?.value) <= 0) add(quantityField, game.i18n.format("CRAFTINGTABLE.Validation.IngredientQuantity", { name: label }));
    }

    for (const row of form.querySelectorAll("[data-outcome-result-row]")) {
      const list = row.closest("[data-outcome-results]");
      const scope = formatOutcomeLabel(list?.dataset.outcomeResults || "failure");
      const nameField = row.querySelector("[name='outcome.result.name']");
      const uuidField = row.querySelector("[name='outcome.result.uuid']");
      const quantityField = row.querySelector("[name='outcome.result.quantity']");
      const chanceField = row.querySelector("[name='outcome.result.chance']");
      const label = nameField?.value?.trim() || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedOutcomeResult");
      if (!nameField?.value?.trim() && !uuidField?.value?.trim()) add(nameField, game.i18n.format("CRAFTINGTABLE.Validation.OutcomeNoUuid", { scope, name: label }));
      if (!Number.isFinite(Number(quantityField?.value)) || Number(quantityField?.value) <= 0) add(quantityField, game.i18n.format("CRAFTINGTABLE.Validation.OutcomeQuantity", { scope, name: label }));
      if (!Number.isFinite(Number(chanceField?.value)) || Number(chanceField?.value) < 0 || Number(chanceField?.value) > 100) add(chanceField, game.i18n.format("CRAFTINGTABLE.Validation.OutcomeChance", { scope, name: label }));
    }

    const partialRange = form.querySelector("[name='outcomes.partialSuccess.missBy']");
    if (partialRange && (!Number.isFinite(Number(partialRange.value)) || Number(partialRange.value) <= 0)) add(partialRange, game.i18n.localize("CRAFTINGTABLE.Validation.PartialRange"));
    for (const scope of ["criticalSuccess", "criticalFailure"]) {
      const trigger = form.querySelector(`[name='outcomes.${scope}.trigger.type']`);
      const threshold = form.querySelector(`[name='outcomes.${scope}.trigger.threshold']`);
      if (trigger?.value === "custom" && (!threshold?.value?.trim() || !Number.isFinite(Number(threshold?.value)))) {
        add(threshold, game.i18n.localize(scope === "criticalSuccess" ? "CRAFTINGTABLE.Validation.CriticalSuccessTrigger" : "CRAFTINGTABLE.Validation.CriticalFailureTrigger"));
      }
    }
    const failureType = form.querySelector("[name='outcomes.failure.type']");
    const failureMacro = form.querySelector("[name='outcomes.failure.macroUuid']");
    if (failureType?.value === "customMacro" && !failureMacro?.value?.trim()) add(failureMacro, game.i18n.format("CRAFTINGTABLE.Validation.MacroRequired", { scope: game.i18n.localize("CRAFTINGTABLE.GM.Failure") }));
    const criticalFailureType = form.querySelector("[name='outcomes.criticalFailure.effect.type']");
    const criticalFailureMacro = form.querySelector("[name='outcomes.criticalFailure.effect.macroUuid']");
    if (criticalFailureType?.value === "customMacro" && !criticalFailureMacro?.value?.trim()) add(criticalFailureMacro, game.i18n.format("CRAFTINGTABLE.Validation.MacroRequired", { scope: game.i18n.localize("CRAFTINGTABLE.GM.CriticalFailure") }));

    const invalid = Array.from(form.querySelectorAll("[aria-invalid='true']"));
    if (focus && invalid.length) {
      const first = invalid[0];
      const section = first.closest("[data-collapse-section]");
      if (section) {
        section.classList.add("is-open");
        const body = section.querySelector(":scope > .ctgm__collapse-body, :scope > .ctgm__outcome-body");
        if (body) body.hidden = false;
        section.querySelector(":scope > [data-collapse-toggle]")?.setAttribute("aria-expanded", "true");
      }
      first.focus?.({ preventScroll: false });
    }
    return invalid.length;
  }

  async _chooseIcon() {
    const field = this.element.querySelector("[name='recipe.img']");
    const current = String(field?.value ?? this.pendingRecipeIcon ?? DEFAULT_RECIPE_ICON).trim();
    const FilePickerClass = foundry.applications?.apps?.FilePicker;
    if (!FilePickerClass) {
      ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.FilePickerUnavailable"));
      return null;
    }

    const picker = new FilePickerClass({
      type: "image",
      current,
      field,
      callback: (path) => {
        const icon = String(path ?? "").trim() || DEFAULT_RECIPE_ICON;
        this.pendingRecipeIcon = icon;
        if (field) field.value = icon;
        this._setLiveRecipeIcon(icon);
        this._markCurrentRecipeDirty();
        this._syncPreviewFromForm();
      }
    });
    return picker.browse(current);
  }

  _clearIcon() {
    const resultIcon = this._getPrimaryResultIcon();
    const field = this.element.querySelector("[name='recipe.img']");
    const icon = resultIcon || DEFAULT_RECIPE_ICON;
    this.pendingRecipeIcon = icon;
    if (field) field.value = icon;
    this._setLiveRecipeIcon(icon);
    this._markCurrentRecipeDirty();
    this._syncPreviewFromForm();
    return null;
  }

  async _handleDrop(event, target) {
    const item = await getItemFromDropEvent(event);
    if (!item) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.DropReadFailed"));
      return null;
    }

    return this._applyItemToEditor(item, {
      zone: target.dataset.dropZone,
      ingredientType: target.dataset.ingredientType,
      resultScope: target.dataset.resultScope,
      target
    });
  }

  async _selectItemForEditor(element) {
    if (!element || element.disabled) return null;
    const item = await promptForCraftingItem();
    if (!item) return null;
    return this._applyItemToEditor(item, {
      zone: element.dataset.selectZone,
      ingredientType: element.dataset.ingredientType,
      resultScope: element.dataset.resultScope,
      target: element
    });
  }

  _applyItemToEditor(item, { zone, ingredientType = "required", resultScope = "failure", target = null } = {}) {
    const dropped = {
      name: item.name,
      uuid: item.uuid,
      img: item.img,
      quantity: 1
    };

    if (zone === "ingredient") return this._addIngredientRow(ingredientType || "required", {
      ...dropped,
      type: ingredientType || "required",
      consumed: true,
      matchMode: "uuid"
    });

    if (zone === "result") return this._addResultRow(dropped);

    if (zone === "outcome-result") {
      return this._addOutcomeResultRow(resultScope || "failure", {
        ...dropped,
        chance: 100
      });
    }

    if (zone === "outcome-effect-item") {
      const row = target.closest("[data-outcome-effect-row]");
      const nameField = row?.querySelector("[name='outcome.effect.itemName']");
      const uuidField = row?.querySelector("[name='outcome.effect.itemUuid']");
      const imgField = row?.querySelector("[name='outcome.effect.itemImg']");
      if (nameField) nameField.value = item.name;
      if (uuidField) uuidField.value = item.uuid;
      if (imgField) imgField.value = item.img;
      const icon = row?.querySelector(".ctgm__row-icon");
      if (icon) icon.src = item.img;
      this._markCurrentRecipeDirty();
      this._syncPreviewFromForm();
      return null;
    }

    if (zone === "tool") {
      const nameField = this.element.querySelector("[name='recipe.toolName']");
      const uuidField = this.element.querySelector("[name='recipe.toolUuid']");
      const choiceField = this.element.querySelector("[name='recipe.toolChoice']");
      const customField = this.element.querySelector("[name='recipe.customToolName']");
      if (nameField) nameField.value = item.name;
      if (uuidField) uuidField.value = item.uuid;
      if (customField) customField.value = item.name;
      if (choiceField) {
        const uuidChoice = `uuid:${item.uuid}`;
        if (Array.from(choiceField.options).some((option) => option.value === uuidChoice)) choiceField.value = uuidChoice;
        else {
          let option = Array.from(choiceField.options).find((candidate) => candidate.value === CURRENT_TOOL_CHOICE);
          if (!option) {
            option = document.createElement("option");
            option.value = CURRENT_TOOL_CHOICE;
            choiceField.append(option);
          }
          option.textContent = item.name;
          choiceField.value = CURRENT_TOOL_CHOICE;
        }
        customField?.classList.toggle("is-hidden", choiceField.value !== CUSTOM_TOOL_CHOICE && choiceField.value !== CURRENT_TOOL_CHOICE);
      }
      this._markCurrentRecipeDirty();
      this._syncPreviewFromForm();
      return null;
    }

    if (zone === "failure-item") {
      return this._addOutcomeResultRow("failure", {
        ...dropped,
        chance: 100
      });
    }

    if (zone === "critical-failure-item") {
      return this._addOutcomeResultRow("criticalFailure", {
        ...dropped,
        chance: 100
      });
    }

    return null;
  }

  _syncPreviewFromForm() {
    const form = this.element.querySelector("[data-recipe-editor]");
    if (!form) return;
    const snapshot = collectRecipeFormData(form, {}).recipe;
    const liveText = (key, fallback = "") => this.element.querySelector(`[data-live='${key}']`)?.textContent?.trim() || fallback;
    const liveImg = this.element.querySelector("[data-live='img']")?.getAttribute("src") || "icons/svg/item-bag.svg";
    const name = form.querySelector("[name='recipe.name']")?.value?.trim() || liveText("name", game.i18n.localize("CRAFTINGTABLE.GM.UnnamedRecipe"));
    const img = form.querySelector("[name='recipe.img']")?.value?.trim() || liveImg;
    const result = snapshot.results?.[0] ?? snapshot.result ?? {};
    const ingredientCount = snapshot.ingredients?.length ?? 0;
    const categoryText = form.querySelector("[name='recipe.category']") ? titleCase(snapshot.category) : liveText("category", titleCase(snapshot.category));
    const dcText = form.querySelector("[name='recipe.dc']") ? String(snapshot.dc || 0) : liveText("dc", String(snapshot.dc || 0));
    const timeText = form.querySelector("[name='recipe.timeValue']") ? snapshot.time || "" : liveText("time", snapshot.time || "");
    const costText = form.querySelector("[name='recipe.costGp']") ? `${snapshot.costGp ?? 0} ${snapshot.costDenomination || "gp"}` : liveText("cost", `${snapshot.costGp ?? 0} ${snapshot.costDenomination || "gp"}`);
    const noResultLabel = game.i18n.localize("CRAFTINGTABLE.GM.NoResult");
    const resultText = form.querySelector("[data-result-list]")
      ? (result.name ? `${result.name} x${result.quantity || 1}` : noResultLabel)
      : liveText("result", result.name ? `${result.name} x${result.quantity || 1}` : noResultLabel);
    const ingredientText = form.querySelector("[data-ingredient-list]")
      ? String(ingredientCount)
      : liveText("ingredients", String(ingredientCount));

    this.element.querySelectorAll("[data-live='name']").forEach((node) => { node.textContent = name; });
    this.element.querySelectorAll("[data-live='category']").forEach((node) => { node.textContent = categoryText; });
    this.element.querySelectorAll("[data-live='img']").forEach((node) => { node.src = img; });
    this.element.querySelectorAll("[data-live='dc']").forEach((node) => { node.textContent = dcText; });
    this.element.querySelectorAll("[data-live='time']").forEach((node) => { node.textContent = timeText; });
    this.element.querySelectorAll("[data-live='cost']").forEach((node) => { node.textContent = costText; });
    this.element.querySelectorAll("[data-live='result']").forEach((node) => { node.textContent = resultText; });
    this.element.querySelectorAll("[data-live='ingredients']").forEach((node) => { node.textContent = ingredientText; });
    this._syncOutcomeSummariesFromRecipe(snapshot);
  }

  _syncOutcomeSummariesFromRecipe(recipe) {
    const outcomes = prepareOutcomeViewData(normalizeOutcomesData(recipe), recipe);
    const updates = {
      failureSummary: outcomes.failure.summary,
      failureChip: outcomes.failure.chipLabel,
      failureInfo: outcomes.failure.infoText,
      partialSummary: outcomes.partialSuccess.summary,
      partialExample: outcomes.partialSuccess.exampleText,
      criticalSuccessSummary: outcomes.criticalSuccess.summary,
      criticalSuccessExample: outcomes.criticalSuccess.exampleText,
      criticalFailureSummary: outcomes.criticalFailure.summary,
      criticalFailureExample: outcomes.criticalFailure.exampleText
    };

    for (const [key, value] of Object.entries(updates)) {
      this.element.querySelectorAll(`[data-outcome-live='${key}']`).forEach((node) => {
        node.textContent = value;
      });
    }

    this.element.querySelectorAll("[data-outcome-chip='failure']").forEach((node) => {
      node.className = `ctgm__outcome-chip ${outcomes.failure.severityClass}`;
    });
    this.element.querySelectorAll("[data-outcome-icon='failureRule']").forEach((node) => {
      node.className = outcomes.failure.iconClass;
    });
    this.element.querySelectorAll("[data-outcome-info='failure']").forEach((node) => {
      node.className = `ctgm__outcome-info ${outcomes.failure.severityClass}`;
    });

    this._syncFailureResultsState(outcomes.failure.canCreateResults);
    this.element.querySelectorAll("[data-custom-macro-field='failure']").forEach((node) => {
      node.hidden = !outcomes.failure.isCustomMacro;
    });
    this.element.querySelectorAll("[data-custom-macro-field='criticalFailure']").forEach((node) => {
      node.hidden = !outcomes.criticalFailure.isCustomMacro;
    });
    this.element.querySelectorAll("[data-custom-trigger-field='criticalSuccess']").forEach((node) => {
      node.hidden = !outcomes.criticalSuccess.isCustomTrigger;
    });
    this.element.querySelectorAll("[data-custom-trigger-field='criticalFailure']").forEach((node) => {
      node.hidden = !outcomes.criticalFailure.isCustomTrigger;
    });

    this.element.querySelectorAll("[data-quality-tier-field]").forEach((node) => {
      node.hidden = !outcomes.partialSuccess.isReducedQuality;
    });

    for (const [key, outcome] of Object.entries({
      partialSuccess: outcomes.partialSuccess,
      criticalSuccess: outcomes.criticalSuccess,
      criticalFailure: outcomes.criticalFailure
    })) {
      this.element.querySelectorAll(`[data-outcome-chip-list='${key}']`).forEach((node) => {
        replaceOutcomeChips(node, outcome.chips);
      });
    }

    for (const [key, outcome] of Object.entries({
      partialSuccess: outcomes.partialSuccess,
      criticalSuccess: outcomes.criticalSuccess,
      criticalFailure: outcomes.criticalFailure
    })) {
      const section = this.element.querySelector(`[data-outcome-panel='${key}']`);
      section?.classList.toggle("is-disabled", !outcome.enabled);
      if (!outcome.enabled) {
        section?.classList.remove("is-open");
        const body = section?.querySelector(".ctgm__outcome-body");
        const button = section?.querySelector("[data-collapse-toggle]");
        if (body) body.hidden = true;
        button?.setAttribute("aria-expanded", "false");
      }
    }
  }

  _syncFailureResultsState(canCreateResults) {
    const wrap = this.element.querySelector("[data-failure-results]");
    if (!wrap) return;
    const failureRule = this.element.querySelector("[name='outcomes.failure.type']");
    const isEditable = !failureRule?.disabled;
    wrap.classList.toggle("is-disabled", !canCreateResults);
    wrap.querySelectorAll("[data-action='add-outcome-result'], [data-action='remove-outcome-result'], [data-action='move-row-up'], [data-action='move-row-down'], [data-row-drag-handle], [data-select-zone='outcome-result']").forEach((button) => {
      button.disabled = !isEditable || !canCreateResults;
      if (button.matches("[data-action='move-row-up'], [data-action='move-row-down'], [data-row-drag-handle]")) {
        button.dataset.ctRowLocked = String(!isEditable || !canCreateResults);
      }
    });
    wrap.querySelectorAll("input").forEach((input) => {
      input.readOnly = !isEditable || !canCreateResults;
    });
    wrap.querySelectorAll("[data-drop-zone]").forEach((zone) => {
      zone.setAttribute("aria-disabled", canCreateResults ? "false" : "true");
      zone.classList.remove("is-drop-active");
    });
    this._syncRowOrderControls(wrap);
  }

  _syncRecipeIconFromResult(resultIcon, { previousPrimaryIcon = null, force = false } = {}) {
    if (!resultIcon) return;
    const field = this.element.querySelector("[name='recipe.img']");
    const currentIcon = field?.value?.trim()
      || this.pendingRecipeIcon
      || this.element.querySelector("[data-live='img']")?.getAttribute("src")
      || DEFAULT_RECIPE_ICON;
    if (!force && !shouldUseResultIcon(currentIcon, previousPrimaryIcon)) return;

    this.pendingRecipeIcon = resultIcon;
    if (field) field.value = resultIcon;
    this._setLiveRecipeIcon(resultIcon);
    this._markCurrentRecipeDirty();
  }

  _setLiveRecipeIcon(icon) {
    this.element.querySelectorAll("[data-live='img']").forEach((node) => {
      node.src = icon || DEFAULT_RECIPE_ICON;
    });
  }

  _getPrimaryResultIcon() {
    const row = Array.from(this.element.querySelectorAll("[data-result-row]"))
      .find((candidate) => {
        const name = candidate.querySelector("[name='result.name']")?.value?.trim();
        const uuid = candidate.querySelector("[name='result.uuid']")?.value?.trim();
        return name || uuid;
      });
    return row?.querySelector("[name='result.img']")?.value?.trim() || null;
  }

  async _importRecipesFromJson() {
    const data = await promptForCraftingRecipeJsonImport();
    if (!data) return null;

    const entries = extractRecipeImportEntries(data);
    if (!entries.length) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.JsonNoRecipes"));
      return null;
    }

    let imported = 0;
    let skipped = 0;
    let invalid = 0;
    let lastImported = null;
    const existingWorldRecipes = getWorldRecipeItems();

    for (const entry of entries) {
      const result = await this._importRecipeJsonEntryToWorld(entry, existingWorldRecipes);
      if (result.invalid) invalid += 1;
      if (result.skipped) {
        skipped += 1;
        continue;
      }
      if (result.item) lastImported = result.item;
      imported += 1;
    }

    if (lastImported) {
      this.selectedUuid = lastImported.uuid;
      this.category = getRecipeData(lastImported).category || "all";
      this.search = "";
    }

    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.Imported", { imported, skipped, invalid }));
    return this._renderPanel();
  }

  async _importRecipeJsonEntryToWorld(entry, existingWorldRecipes = getWorldRecipeItems()) {
    const normalized = normalizeImportedRecipeEntry(entry);
    if (!normalized) return { item: null, skipped: true, invalid: true };

    const { itemName, itemImg, recipeData, sourceRecipeUuid } = normalized;
    recipeData.recipeId ||= deriveLegacyRecipeId({
      sourceRecipeUuid,
      legacyKey: JSON.stringify({ itemName, recipe: recipeData })
    }) || createRecipeId(() => foundry.utils.randomID(24));
    const importedRecipeId = recipeData.recipeId;
    const exists = existingWorldRecipes.some((item) => {
      const worldRecipe = getRecipeData(item);
      return worldRecipe.recipeId === importedRecipeId;
    });
    if (exists) return { item: null, skipped: true, invalid: false };

    let resolvedRecipe = recipeData;
    try {
      const resolved = await ensureRecipeItemReferences(recipeData, { createMissing: false });
      resolvedRecipe = resolved.recipe;
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve imported JSON recipe references for ${itemName}`, error);
    }

    const validationErrors = getRecipeValidationErrors(itemName, resolvedRecipe);
    if (validationErrors.length) {
      console.warn(`${MODULE_ID} | Skipping invalid imported recipe ${itemName}`, validationErrors);
      return { item: null, skipped: true, invalid: true, errors: validationErrors };
    }

    const folder = await getOrCreateRecipeCategoryFolder(resolvedRecipe.category);
    const data = buildRecipeItemData({
      name: getUniqueWorldItemName(getRecipeItemName(itemName)),
      img: itemImg || DEFAULT_RECIPE_ICON,
      folderId: folder?.id,
      recipeData: {
        ...resolvedRecipe,
        sourceRecipeUuid: sourceRecipeUuid || resolvedRecipe.sourceRecipeUuid || ""
      }
    });
    const item = await Item.create(data, { renderSheet: false });
    existingWorldRecipes.push(item);
    return { item, skipped: false, invalid: false };
  }

  async _exportSelectedRecipeToJson() {
    const item = await this._getSelectedRecipeItem();
    if (!item?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectExport"));
      return null;
    }

    await this._captureCurrentDraft();
    const payload = buildRecipeJsonExportPayload([item], { drafts: this.recipeDrafts });
    if (!payload.recipes.length) {
      this.validationErrors = payload.invalid.flatMap((entry) => entry.errors);
      ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.InvalidExport"));
      return this._renderPanel();
    }

    downloadCraftingRecipeJson(payload, `crafting-table-${slugifyFileName(payload.recipes[0]?.name || 'recipe')}.json`);
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.Exported", { count: 1, invalid: payload.invalid.length }));
    return this._renderPanel();
  }

  async _exportSelectedRecipesToJson() {
    const items = await this._getBulkSelectedRecipeItems();
    if (!items.length) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectMultipleExport"));
      return null;
    }
    return this._exportRecipeItemsToJson(items, "selected-recipes");
  }

  async _exportAllRecipesToJson() {
    const items = getWorldRecipeItems();
    if (!items.length) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.NoWorldRecipes"));
      return null;
    }
    return this._exportRecipeItemsToJson(items, "world-recipes");
  }

  async _exportRecipeItemsToJson(items, filenameBase = "recipes") {
    await this._captureCurrentDraft();
    const payload = buildRecipeJsonExportPayload(items, { drafts: this.recipeDrafts });
    if (!payload.recipes.length) {
      this.validationErrors = payload.invalid.flatMap((entry) => entry.errors);
      ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.NoValidExport"));
      return this._renderPanel();
    }

    downloadCraftingRecipeJson(payload, `crafting-table-${slugifyFileName(filenameBase)}.json`);
    this.selectedRecipeUuids.clear();
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.Exported", { count: payload.recipes.length, invalid: payload.invalid.length }));
    return this._renderPanel();
  }

  async _getBulkSelectedRecipeItems({ worldOnly = false, compendiumOnly = false } = {}) {
    const items = [];
    for (const uuid of this.selectedRecipeUuids) {
      const item = uuid === this.newRecipeDraftItem?.uuid ? this.newRecipeDraftItem : await safeFromUuid(uuid);
      if (!item?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) continue;
      if (worldOnly && item.pack) continue;
      if (compendiumOnly && !item.pack) continue;
      items.push(item);
    }
    return items;
  }

  _clearRecipeSelection() {
    this.selectedRecipeUuids.clear();
    return this._renderPanel();
  }

  async _getSelectedRecipeItem() {
    if (this.selectedUuid === this.newRecipeDraftItem?.uuid) return this.newRecipeDraftItem;
    return safeFromUuid(this.selectedUuid);
  }

  _canEditRecipeItem(item) {
    return Boolean(game.user?.isGM && item && item.documentName === "Item" && (!item.pack || item._isCraftingTableDraft));
  }

  async _createRecipe() {
    await this._captureCurrentDraft();
    if (this._hasUnsavedChanges(this.selectedUuid)) {
      const proceed = await confirmCraftingAction(game.i18n.localize("CRAFTINGTABLE.Dialog.DiscardCreateRecipe"));
      if (!proceed) return null;
      this._discardDraft(this.selectedUuid);
    }

    const category = this.category !== "all" ? this.category : DEFAULT_RECIPE.category;
    const recipeData = {
      ...foundry.utils.deepClone(DEFAULT_RECIPE),
      category,
      recipeId: createRecipeId(() => foundry.utils.randomID(24))
    };
    const defaultFailureText = game.i18n.localize("CRAFTINGTABLE.GM.DefaultFailureText");
    recipeData.failure = defaultFailureText;
    recipeData.outcomes.failure.flavorText = defaultFailureText;
    const item = createRecipeDraftItem({
      name: getUniqueWorldItemName(getRecipeItemName(getDefaultRecipeName())),
      recipeData
    });

    this.newRecipeDraftItem = item;
    this.selectedUuid = item.uuid;
    this.recipeDrafts.set(item.uuid, {
      itemName: item.name,
      itemImg: item.img,
      recipe: recipeData,
      dirty: true
    });
    this.recipeDrafts.markDirty(item.uuid);
    this.category = category;
    this.search = "";
    this.isEditingRecipe = true;
    this.gmResponsiveView = "editor";
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.CreatedRecipeDraft", { recipe: getRecipeDisplayName(item.name) }));
    return this._renderPanel();
  }

  async _saveSelectedRecipe({ render = true } = {}) {
    const item = await this._getSelectedRecipeItem();
    if (!this._canEditRecipeItem(item)) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.DuplicateEdit"));
      return null;
    }

    let draft = await this._captureCurrentDraft();
    draft ??= this.recipeDrafts.get(item.uuid) ?? {
      itemName: item.name,
      itemImg: item.img,
      recipe: getRecipeData(item)
    };
    if (!draft) {
      ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.EditorMissing"));
      return null;
    }

    let { itemName, itemImg, recipe } = draft;
    const displayName = getRecipeDisplayName(itemName || item.name);
    const draftValidationErrors = validateRecipeData({
      itemName: displayName,
      recipe,
      allowResolvableReferences: true
    });
    if (draftValidationErrors.length) {
      this.validationErrors = draftValidationErrors;
      this._focusValidationAfterRender = true;
      ui.notifications.error(game.i18n.format("CRAFTINGTABLE.Notify.CannotSaveDetails", { errors: draftValidationErrors.join(" ") }));
      if (render) return this._renderPanel();
      return null;
    }

    let materialized = { recipe, createdItems: [] };
    let savedItem = null;
    try {
      materialized = await ensureRecipeItemReferences(recipe);
      recipe = materialized.recipe;
      const validationErrors = validateRecipeData({ itemName: displayName, recipe });
      if (validationErrors.length) {
        const rolledBack = await rollbackCreatedRecipeReferences(materialized.createdItems);
        this.validationErrors = validationErrors;
        this._focusValidationAfterRender = true;
        ui.notifications.error(rolledBack
          ? game.i18n.format("CRAFTINGTABLE.Notify.CannotSaveDetails", { errors: validationErrors.join(" ") })
          : game.i18n.localize("CRAFTINGTABLE.Notify.ReferenceRollbackFailed"));
        if (render) return this._renderPanel();
        return null;
      }

      const folder = await getOrCreateRecipeCategoryFolder(recipe.category);
      const resolvedItemImg = this._resolveRecipeItemIcon(itemImg, item, recipe);
      const uniqueName = getUniqueWorldItemName(getRecipeItemName(displayName), {
        excludeItem: item._isCraftingTableDraft ? null : item
      });
      if (item._isCraftingTableDraft) {
        savedItem = await Item.create(buildRecipeItemData({
          name: uniqueName,
          img: resolvedItemImg,
          folderId: folder?.id,
          recipeData: recipe
        }), { renderSheet: false });
        if (!savedItem) throw new Error("Foundry did not create the recipe Item.");
      } else {
        savedItem = await item.update({
          name: uniqueName,
          folder: folder?.id ?? null,
          img: resolvedItemImg,
          "system.description.value": recipe.description ?? "",
          [`flags.${MODULE_ID}.${RECIPE_FLAG}`]: recipe
        }) ?? item;
      }
    } catch (error) {
      const rolledBack = await rollbackCreatedRecipeReferences(materialized.createdItems);
      console.error(`${MODULE_ID} | Could not save recipe or create its missing item references`, error);
      ui.notifications.error(game.i18n.localize(rolledBack && !error?.recipeReferenceRollbackIncomplete
        ? "CRAFTINGTABLE.Notify.ReferenceFailed"
        : "CRAFTINGTABLE.Notify.ReferenceRollbackFailed"));
      if (render) return this._renderPanel();
      return null;
    }

    const previousUuid = this.selectedUuid;
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    this._discardDraft(previousUuid);
    this.category = recipe.category || "all";
    this.selectedUuid = savedItem.uuid;
    this.isEditingRecipe = false;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.SavedRecipe", { recipe: displayName }));
    if (materialized.createdItems.length) {
      ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.CreatedReferences", { items: materialized.createdItems.map((created) => created.name).join(", ") }));
    }
    if (render) return this._renderPanel();
    return savedItem;
  }

  _resolveRecipeItemIcon(itemImg, item, recipe) {
    const resultIcon = recipe.results?.[0]?.img || recipe.result?.img || null;
    if (this.pendingRecipeIcon) return this.pendingRecipeIcon;
    if (resultIcon && shouldUseResultIcon(itemImg || item?.img, resultIcon)) return resultIcon;
    return itemImg || item?.img || DEFAULT_RECIPE_ICON;
  }

  async _duplicateSelectedRecipe() {
    await this._captureCurrentDraft();
    let sourceItem = await this._getSelectedRecipeItem();
    if (!sourceItem) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.SelectDuplicate"));
      return null;
    }
    if (sourceItem._isCraftingTableDraft) {
      sourceItem = await this._saveSelectedRecipe({ render: false });
      if (!sourceItem) return this._renderPanel();
    }

    const sourceDraft = this.recipeDrafts.get(sourceItem.uuid);
    let recipeData = {
      ...(sourceDraft?.recipe ?? getRecipeData(sourceItem)),
      recipeId: createRecipeId(() => foundry.utils.randomID(24))
    };
    const sourceName = getRecipeDisplayName(sourceDraft?.itemName || sourceItem.name);
    const copyName = game.i18n.format("CRAFTINGTABLE.GM.CopyName", { name: sourceName });
    const draftErrors = validateRecipeData({ itemName: copyName, recipe: recipeData, allowResolvableReferences: true });
    if (draftErrors.length) {
      this.validationErrors = draftErrors;
      ui.notifications.error(game.i18n.format("CRAFTINGTABLE.Notify.CannotSaveDetails", { errors: draftErrors.join(" ") }));
      return this._renderPanel();
    }

    let materialized = { recipe: recipeData, createdItems: [] };
    let item = null;
    try {
      materialized = await ensureRecipeItemReferences(recipeData);
      recipeData = materialized.recipe;
      const validationErrors = validateRecipeData({ itemName: copyName, recipe: recipeData });
      if (validationErrors.length) throw new Error(validationErrors.join(" "));
      const folder = await getOrCreateRecipeCategoryFolder(recipeData.category);
      const data = buildRecipeItemData({
        name: getUniqueWorldItemName(getRecipeItemName(copyName)),
        img: sourceDraft?.itemImg || sourceItem.img,
        folderId: folder?.id,
        recipeData
      });
      data.system = foundry.utils.mergeObject(sourceItem.toObject().system ?? {}, data.system ?? {}, { inplace: false });
      item = await Item.create(data, { renderSheet: false });
      if (!item) throw new Error("Foundry did not create the duplicated recipe Item.");
    } catch (error) {
      const rolledBack = await rollbackCreatedRecipeReferences(materialized.createdItems);
      console.error(`${MODULE_ID} | Could not duplicate recipe`, error);
      ui.notifications.error(game.i18n.localize(rolledBack && !error?.recipeReferenceRollbackIncomplete
        ? "CRAFTINGTABLE.Notify.ReferenceFailed"
        : "CRAFTINGTABLE.Notify.ReferenceRollbackFailed"));
      return this._renderPanel();
    }
    this.selectedUuid = item.uuid;
    this.category = recipeData.category || "all";
    this.search = "";
    this.isEditingRecipe = true;
    this.validationErrors = [];
    this.pendingRecipeIcon = null;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.DuplicatedRecipe", { recipe: getRecipeDisplayName(item.name) }));
    return this._renderPanel();
  }

  async _deleteSelectedRecipe() {
    const item = await this._getSelectedRecipeItem();
    if (!this._canEditRecipeItem(item)) {
      ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.Notify.WorldDeleteOnly"));
      return null;
    }

    if (item._isCraftingTableDraft) {
      const name = getRecipeDisplayName(item.name);
      this._discardDraft(item.uuid);
      this.isEditingRecipe = false;
      this.validationErrors = [];
      ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.DiscardedRecipeDraft", { recipe: name }));
      return this._renderPanel();
    }

    const confirmed = await confirmCraftingAction(
      game.i18n.format("CRAFTINGTABLE.Dialog.DeleteRecipeMessage", { recipe: getRecipeDisplayName(item.name) }),
      game.i18n.localize("CRAFTINGTABLE.Dialog.DeleteRecipeTitle")
    );
    if (!confirmed) return null;

    await item.delete();
    this._discardDraft(item.uuid);
    this.selectedUuid = null;
    ui.notifications.info(game.i18n.format("CRAFTINGTABLE.Notify.DeletedRecipe", { recipe: getRecipeDisplayName(item.name) }));
    return this._renderPanel();
  }

  async _prepareData() {
    const activeTab = normalizeGmActiveTab(this.tabGroups.primary);
    this.tabGroups.primary = activeTab;

    const allRecipes = await recipeRepository.listEntries({ includeWorldItems: true });
    if (this.newRecipeDraftItem) allRecipes.unshift({ item: this.newRecipeDraftItem, source: "draft" });
    const indexed = allRecipes.map((entry) => prepareGmRecipeIndex(entry, this.recipeDrafts.get(entry.item.uuid)));
    const categories = buildGmCategories(indexed, this.category);
    const filters = normalizeRecipeFilters(this.recipeFilters);
    let visible = filterGmRecipes(indexed, this.category, this.search, filters);
    visible = sortGmRecipes(visible, this.recipeSort);

    if (!this.selectedUuid && visible.length) this.selectedUuid = visible[0].uuid;
    if (this.selectedUuid && !visible.some((recipe) => recipe.uuid === this.selectedUuid)) {
      this.selectedUuid = visible[0]?.uuid ?? null;
    }

    const pageSize = this.recipeView === "grid" ? RECIPE_PAGE_SIZE_GRID : RECIPE_PAGE_SIZE_LIST;
    const totalRecipes = visible.length;
    const pageCount = Math.max(1, Math.ceil(totalRecipes / pageSize));
    this.recipePage = Math.min(Math.max(1, this.recipePage), pageCount);
    const pageStart = (this.recipePage - 1) * pageSize;
    const pagedIndexes = visible.slice(pageStart, pageStart + pageSize);
    const entriesByUuid = new Map(allRecipes.map((entry) => [entry.item.uuid, entry]));
    const pagedRecipes = pagedIndexes;
    let selectedRecipe = null;
    if (this.isEditingRecipe && this.selectedUuid) {
      const selectedEntry = entriesByUuid.get(this.selectedUuid);
      const resolvedEntry = selectedEntry ? await recipeRepository.resolveEntry(selectedEntry) : null;
      if (resolvedEntry) selectedRecipe = await prepareGmRecipe(resolvedEntry, this.recipeDrafts.get(this.selectedUuid));
    }
    const activeCategoryLabel = this.category === "all" ? game.i18n.localize("CRAFTINGTABLE.GM.AllRecipes") : (getCategoryOption(this.category)?.label || titleCase(this.category));
    const recipePacks = getRecipePacks().map((pack) => ({
      id: pack.collection,
      label: pack.title || pack.collection,
      selected: (this.exportPackId || getPrimaryRecipePack()?.collection || "") === pack.collection
    }));
    const gmLayout = getGmPanelLayoutViewData(this.position?.width);
    const allOngoingCrafts = collectOngoingCraftsForGm();
    const allCraftRequests = collectCraftRequestsForGm();
    const allPendingOutcomes = collectPendingOutcomesForGm();
    const interruptedOperations = collectInterruptedOperationsForGm();
    const filteredCraftRequests = filterCraftRequests(allCraftRequests, {
      search: this.requestSearch,
      status: this.requestStatus
    });
    const craftRequests = sortCraftRequests(filteredCraftRequests, { sort: this.requestSort });
    const requestSummary = summarizeCraftRequests(filteredCraftRequests);
    const ongoingCrafts = filterAndSortOngoingCrafts(allOngoingCrafts, {
      search: this.requestSearch,
      sort: this.ongoingSort
    });
    const hasFinishedRequests = allCraftRequests.some((request) => !["pending", "approved", "processing"].includes(request.status));
    const normalizedRequestSearch = String(this.requestSearch ?? "").trim().toLocaleLowerCase();
    const pendingOutcomes = allPendingOutcomes.filter((entry) => entry.status === "pending" && (
      !normalizedRequestSearch
      || `${entry.actorName} ${entry.recipeName} ${entry.outcomeLabel}`.toLocaleLowerCase().includes(normalizedRequestSearch)
    ));
    const pendingOutcomeCount = allPendingOutcomes.filter((entry) => entry.status === "pending").length;
    const hasFinishedOutcomes = allPendingOutcomes.some((entry) => entry.status !== "pending");
    const hasFinishedOngoingCrafts = allOngoingCrafts.some(isOngoingCraftComplete);

    return {
      activeTab,
      advancedMode: this.advancedMode,
      gmPanelLayout: gmLayout.resolved,
      gmPanelRequestedLayout: gmLayout.requested,
      gmPanelLayoutClass: gmLayout.className,
      gmPanelStyle: gmLayout.style,
      gmResponsiveView: this.gmResponsiveView,
      isGmLibraryView: this.gmResponsiveView === "library",
      isGmEditorView: this.gmResponsiveView === "editor",
      isGmPreviewView: this.gmResponsiveView === "preview",
      categories,
      isRecipesTab: activeTab === "recipes",
      isRequestsTab: activeTab === "requests",
      isImportExportTab: activeTab === "import-export",
      isRecipeEditorMode: Boolean(this.isEditingRecipe && selectedRecipe),
      isBasicOpen: !this.collapsedSections.basic,
      isRequirementsOpen: !this.collapsedSections.requirements,
      isIngredientsOpen: !this.collapsedSections.ingredients,
      isResultOpen: !this.collapsedSections.result,
      isRulesOpen: !this.collapsedSections.rules,
      isOutcomeFailureOpen: !this.collapsedSections.outcomeFailure,
      isOutcomePartialOpen: Boolean(selectedRecipe?.outcomes?.partialSuccess?.enabled) && !this.collapsedSections.outcomePartialSuccess,
      isOutcomeCriticalSuccessOpen: Boolean(selectedRecipe?.outcomes?.criticalSuccess?.enabled) && !this.collapsedSections.outcomeCriticalSuccess,
      isOutcomeCriticalFailureOpen: Boolean(selectedRecipe?.outcomes?.criticalFailure?.enabled) && !this.collapsedSections.outcomeCriticalFailure,
      isPermissionsOpen: !this.collapsedSections.permissions,
      isNotesOpen: !this.collapsedSections.notes,
      isAllCategory: this.category === "all",
      activeCategoryLabel,
      categoryToolLabel: this.category === "all" ? "" : activeCategoryLabel,
      recipes: pagedRecipes.map((recipe) => ({
        ...recipe,
        selected: recipe.uuid === this.selectedUuid,
        bulkSelected: this.selectedRecipeUuids.has(recipe.uuid)
      })),
      recipeCount: indexed.length,
      visibleRecipeCount: totalRecipes,
      recipeRangeStart: totalRecipes ? pageStart + 1 : 0,
      recipeRangeEnd: Math.min(pageStart + pageSize, totalRecipes),
      recipeSort: this.recipeSort,
      recipeSortOptions: buildSelectOptions(RECIPE_SORT_OPTIONS, this.recipeSort),
      recipeView: this.recipeView,
      isRecipeGridView: this.recipeView === "grid",
      isRecipeListView: this.recipeView !== "grid",
      recipeFilters: {
        ...filters,
        rarityOptions: buildAllSelectOptions(RARITY_OPTIONS, filters.rarity, "All"),
        modeOptions: buildAllSelectOptions(MODE_OPTIONS, filters.mode, "All"),
        timeOptions: buildSelectOptions(RECIPE_TIME_FILTER_OPTIONS, filters.time)
      },
      hasRecipeFilters: hasActiveRecipeFilters(filters) || Boolean(this.search),
      pagination: buildPaginationData(this.recipePage, pageCount),
      recipePacks,
      recipePackSummary: summarizeConfiguredRecipePacks(),
      bulkSelectedCount: this.selectedRecipeUuids.size,
      hasBulkSelection: this.selectedRecipeUuids.size > 0,
      requestSearch: this.requestSearch,
      requestStatus: this.requestStatus,
      requestSort: this.requestSort,
      ongoingSort: this.ongoingSort,
      requestStatusOptions: buildCleanSelectOptions(REQUEST_STATUS_FILTER_OPTIONS, this.requestStatus),
      requestSortOptions: buildCleanSelectOptions(REQUEST_SORT_OPTIONS, this.requestSort),
      ongoingSortOptions: buildCleanSelectOptions(ONGOING_SORT_OPTIONS, this.ongoingSort),
      requestSummary,
      hasFinishedRequests,
      hasFinishedOutcomes,
      hasFinishedOngoingCrafts,
      craftRequests,
      pendingCraftRequests: allCraftRequests.filter((request) => request.status === "pending"),
      hasCraftRequests: craftRequests.length > 0,
      pendingCraftRequestCount: allCraftRequests.filter((request) => request.status === "pending").length,
      pendingOutcomes,
      hasPendingOutcomes: pendingOutcomes.length > 0,
      pendingOutcomeCount,
      pendingGmActionCount: allCraftRequests.filter((request) => request.status === "pending").length + pendingOutcomeCount,
      interruptedOperations,
      hasInterruptedOperations: interruptedOperations.length > 0,
      ongoingCrafts,
      hasOngoingCrafts: ongoingCrafts.length > 0,
      search: this.search,
      selectedRecipe,
      sourceSummary: summarizeRecipeSources(indexed),
      hasUnsavedChanges: this._hasUnsavedChanges(this.selectedUuid),
      validationErrors: this.validationErrors
    };
  }
}

function hasNormalizedDataChanges(left, right) {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function buildRecipeMigrationCandidates(items = []) {
  const candidates = [];
  const seen = new Set();
  for (const item of items) {
    if (!item?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) continue;
    const recipe = getRecipeData(item);
    if (!recipe.recipeId || seen.has(recipe.recipeId)) continue;
    seen.add(recipe.recipeId);
    candidates.push({
      recipeId: recipe.recipeId,
      recipeUuid: item.uuid,
      recipeName: getRecipeDisplayName(item.name),
      totalHours: getRecipeWorkHours(recipe)
    });
  }
  return candidates;
}

async function migrateLegacyRecipeReference(entry, candidates) {
  if (entry.recipeId) return entry;
  let match = null;
  if (entry.recipeUuid) {
    const item = await safeFromUuid(entry.recipeUuid);
    if (item?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) {
      const recipe = getRecipeData(item);
      match = {
        recipeId: recipe.recipeId,
        recipeUuid: item.uuid,
        recipeName: getRecipeDisplayName(item.name),
        totalHours: getRecipeWorkHours(recipe)
      };
    }
  }
  match ??= findLegacyRecipeMigrationMatch(entry, candidates);
  if (!match?.recipeId) return entry;
  return {
    ...entry,
    recipeId: match.recipeId,
    recipeUuid: match.recipeUuid || entry.recipeUuid
  };
}

async function migrateActorCraftFlags(actor, recipeCandidates = []) {
  if (!actor) return { requestsChanged: false, craftsChanged: false };

  const rawRequests = actor.getFlag?.(MODULE_ID, CRAFT_REQUESTS_FLAG);
  const normalizedRequests = await Promise.all(
    getActorCraftRequests(actor).map((entry) => migrateLegacyRecipeReference(entry, recipeCandidates))
  );
  const requestsChanged = hasNormalizedDataChanges(rawRequests, normalizedRequests);
  if (requestsChanged) await setNormalizedActorFlag(actor, CRAFT_REQUESTS_FLAG, normalizedRequests);

  const rawCrafts = actor.getFlag?.(MODULE_ID, ONGOING_CRAFTS_FLAG);
  const normalizedCrafts = await Promise.all(
    getActorOngoingCrafts(actor).map((entry) => migrateLegacyRecipeReference(entry, recipeCandidates))
  );
  const craftsChanged = hasNormalizedDataChanges(rawCrafts, normalizedCrafts);
  if (craftsChanged) await setNormalizedActorFlag(actor, ONGOING_CRAFTS_FLAG, normalizedCrafts);

  return { requestsChanged, craftsChanged };
}

async function migrateRecipeItemData(item) {
  const rawRecipe = item?.getFlag?.(MODULE_ID, RECIPE_FLAG);
  if (!rawRecipe?.isRecipe) return false;

  let migratedRecipe = getRecipeData(item);
  const hasUnresolvedReferences = (migratedRecipe.ingredients ?? [])
    .some((entry) => entry?.name && !entry?.uuid && getIngredientMatchMode(entry) !== "tag")
    || getRecipeResults(migratedRecipe).some((entry) => entry?.name && !entry?.uuid);
  if (hasUnresolvedReferences) {
    const resolved = await ensureRecipeItemReferences(migratedRecipe, { createMissing: false });
    migratedRecipe = normalizeRecipeData(resolved.recipe);
  }

  const description = migratedRecipe.description ?? "";
  const changed = hasNormalizedDataChanges(rawRecipe, migratedRecipe)
    || String(item.system?.description?.value ?? "") !== description;
  if (!changed) return false;

  await item.update({
    "system.description.value": description,
    [`flags.${MODULE_ID}.${RECIPE_FLAG}`]: migratedRecipe
  });
  return true;
}

async function migrateCraftingTableData() {
  const actors = Array.from(game.actors ?? []);
  const actorRecipeItems = actors.flatMap((actor) => Array.from(actor.items ?? []))
    .filter((item) => item.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe);
  const worldRecipeItems = getWorldRecipeItems();
  const recipeItems = Array.from(new Map(
    [...worldRecipeItems, ...actorRecipeItems].map((item) => [item.uuid, item])
  ).values());
  const indexedRecipeItems = await recipeRepository.listIndexedItems();
  const recipeCandidates = buildRecipeMigrationCandidates([...worldRecipeItems, ...indexedRecipeItems, ...actorRecipeItems]);
  return runCraftingMigrations({
    moduleId: MODULE_ID,
    currentVersion: CURRENT_MIGRATION_VERSION,
    recipeItems,
    actors,
    migrateRecipe: migrateRecipeItemData,
    migrateActor: (actor) => migrateActorCraftFlags(actor, recipeCandidates),
    validateRecipe: getRecipeValidationErrors,
    getRecipeData
  });
}

function collectCraftRequestsForGm() {
  if (typeof game === "undefined" || !game.user?.isGM) return [];

  const rows = [];
  for (const actor of game.actors ?? []) {
    const requests = getActorCraftRequests(actor);
    for (const request of requests) {
      const status = request.status || "pending";
      rows.push({
        id: request.id || `${actor.id}-${rows.length}`,
        actorUuid: actor.uuid,
        actorName: request.actorName || actor.name,
        recipeId: request.recipeId || "",
        recipeUuid: request.recipeUuid || "",
        recipeName: request.recipeName || "Unknown recipe",
        recipeImg: request.recipeImg || DEFAULT_RECIPE_ICON,
        status,
        isPending: status === "pending",
        isApproved: status === "approved",
        isProcessing: status === "processing",
        isRejected: status === "rejected",
        isCompleted: status === "completed",
        statusLabel: titleCase(status),
        requestedLabel: formatShortDateTime(request.requestedAt),
        updatedLabel: formatShortDateTime(request.updatedTime || request.requestedAt),
        progressPercent: Number(request.progressPercent ?? 0),
        updatedTime: Number(request.updatedTime ?? request.requestedAt ?? 0)
      });
    }
  }

  return rows.sort((left, right) => right.updatedTime - left.updatedTime);
}

function collectPendingOutcomesForGm() {
  if (typeof game === "undefined" || !game.user?.isGM) return [];

  const rows = [];
  for (const actor of game.actors ?? []) {
    for (const entry of getActorPendingOutcomes(actor)) {
      rows.push({
        id: entry.id,
        actorUuid: actor.uuid,
        actorName: entry.actorName || actor.name,
        recipeId: entry.recipeId,
        recipeUuid: entry.recipeUuid,
        recipeName: entry.recipeName || "Unknown recipe",
        recipeImg: entry.recipeImg || DEFAULT_RECIPE_ICON,
        outcomeType: entry.outcomeType,
        outcomeLabel: formatOutcomeLabel(entry.outcomeType),
        reason: entry.reason,
        status: entry.status,
        resolution: entry.resolution,
        resolutionLabel: formatPendingOutcomeResolution(entry.resolution),
        requestedBy: entry.requestedBy,
        createdAt: Number(entry.createdAt ?? 0),
        createdLabel: formatShortDateTime(entry.createdAt),
        updatedTime: Number(entry.updatedTime ?? entry.createdAt ?? 0)
      });
    }
  }
  return rows.sort((left, right) => right.updatedTime - left.updatedTime);
}

function collectInterruptedOperationsForGm() {
  if (typeof game === "undefined" || !game.user?.isGM) return [];
  const rows = [];
  const interruptedBefore = Date.now() - INTERRUPTED_OPERATION_GRACE_MS;
  for (const actor of game.actors ?? []) {
    const ledger = actor.getFlag?.(MODULE_ID, OPERATION_LEDGER_FLAG);
    for (const entry of Array.isArray(ledger) ? ledger : []) {
      if (!["processing", "review-required"].includes(entry?.status)) continue;
      if (entry.status === "processing" && Number(entry.startedAt ?? 0) > interruptedBefore) continue;
      rows.push({
        id: entry.id,
        actorUuid: actor.uuid,
        actorName: actor.name,
        action: entry.action || "crafting",
        startedLabel: formatShortDateTime(entry.startedAt),
        startedAt: Number(entry.startedAt ?? 0)
      });
    }
  }
  return rows.sort((left, right) => right.startedAt - left.startedAt);
}

function collectOngoingCraftsForGm() {
  if (typeof game === "undefined" || !game.user?.isGM) return [];

  const rows = [];
  for (const actor of game.actors ?? []) {
    const crafts = getActorOngoingCrafts(actor);
    if (!Array.isArray(crafts)) continue;

    for (const entry of crafts) {
      const total = Math.max(0, Number(entry.totalHours ?? 0));
      const worked = Math.min(total || Number(entry.workedHours ?? 0), Math.max(0, Number(entry.workedHours ?? 0)));
      const remaining = Math.max(0, total - worked);
      const percent = total > 0 ? Math.min(100, Math.floor((worked / total) * 100)) : 100;
      rows.push({
        id: entry.id || `${actor.id}-${rows.length}`,
        actorUuid: actor.uuid,
        actorName: actor.name,
        recipeId: entry.recipeId || "",
        recipeUuid: entry.recipeUuid,
        recipeName: entry.recipeName || "Unknown recipe",
        recipeImg: entry.recipeImg || DEFAULT_RECIPE_ICON,
        workedHours: worked,
        totalHours: total,
        percent,
        progressText: `${formatWorkHours(worked)} / ${formatWorkHours(total)}`,
        remainingText: formatWorkHours(remaining),
        updatedTime: Number(entry.updatedTime ?? 0)
      });
    }
  }

  return rows.sort((left, right) => right.updatedTime - left.updatedTime);
}

function isOngoingCraftComplete(entry = {}) {
  const total = Math.max(0, Number(entry.totalHours ?? 0));
  const worked = Math.max(0, Number(entry.workedHours ?? 0));
  return total > 0 && worked >= total;
}

function prepareGmRecipeIndex(entry, draftData = null) {
  const item = entry.item;
  const recipe = normalizeRecipeData(draftData?.recipe ?? item.getFlag(MODULE_ID, RECIPE_FLAG) ?? {});
  const itemName = getRecipeDisplayName(draftData?.itemName || item.name);
  const results = getRecipeResults(recipe);
  const primaryResult = results[0] ?? {};
  const validationErrors = getRecipeValidationErrors(itemName, recipe);
  const time = getRecipeTimeData(recipe);
  const cost = getRecipeCostData(recipe);
  const category = recipe.category || "other";
  const rarity = recipe.rarity || "common";
  const editable = (entry.source === "world" && !item.pack) || Boolean(item._isCraftingTableDraft);
  const hasConfiguredResult = Boolean(primaryResult.name || primaryResult.uuid);
  const itemImg = draftData?.itemImg || item.img;

  return {
    uuid: item.uuid,
    name: itemName,
    img: getRecipeDisplayIcon(itemImg, hasConfiguredResult ? primaryResult.img : null),
    favorite: Boolean(recipe.favorite),
    source: entry.source,
    editable,
    invalid: validationErrors.length > 0,
    validationErrors,
    category,
    categoryLabel: getCategoryLabel(category),
    rarity,
    rarityLabel: getOptionLabel(RARITY_OPTIONS, rarity),
    defaultMode: getEffectiveCraftingMode(recipe, getWorldDefaultCraftingMode()),
    time: `${time.value} ${time.unit}`,
    timeUnit: time.unit,
    timeSort: getTimeSortValue(time),
    costGp: Number(cost.value ?? 0),
    costDenomination: cost.denomination,
    costSort: Number(cost.value ?? 0),
    resultName: hasConfiguredResult
      ? (primaryResult.name || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedResult"))
      : game.i18n.localize("CRAFTINGTABLE.GM.NoResult"),
    result: { quantity: hasConfiguredResult ? Number(primaryResult.quantity ?? 1) : 0 },
    rarityRank: getRarityRank(rarity),
    updatedTime: Number(item._stats?.modifiedTime ?? item._stats?.createdTime ?? item.sort ?? 0)
  };
}

async function prepareGmRecipe(entry, draftData = null) {
  const item = entry.item;
  const recipe = normalizeRecipeData(draftData?.recipe ?? item.getFlag(MODULE_ID, RECIPE_FLAG) ?? {});
  const validationErrors = getRecipeValidationErrors(draftData?.itemName || item.name, recipe);
  const resultsData = getRecipeResults(recipe);
  const result = await resolveRecipeResult(resultsData[0] ?? recipe.result);
  const results = await Promise.all(resultsData.map((entry) => resolveRecipeResult(entry)));
  const ingredients = await Promise.all((recipe.ingredients ?? []).map((ingredient) => resolveRecipeIngredient(ingredient)));
  const category = recipe.category || "other";
  const rarity = recipe.rarity || "common";
  const ability = recipe.ability || "int";
  const time = getRecipeTimeData(recipe);
  const cost = getRecipeCostData(recipe);
  const failure = normalizeFailureData(recipe);
  const outcomes = prepareOutcomeViewData(normalizeOutcomesData(recipe), recipe);
  const permissions = normalizePermissionsData(recipe);
  const notes = normalizeNotesData(recipe);
  const defaultMode = getEffectiveCraftingMode(recipe, getWorldDefaultCraftingMode());
  const editable = (entry.source === "world" && !item.pack) || Boolean(item._isCraftingTableDraft);
  const hasConfiguredResult = Boolean(resultsData[0]?.name || resultsData[0]?.uuid);
  const itemName = getRecipeDisplayName(draftData?.itemName || item.name);
  const itemImg = draftData?.itemImg || item.img;
  const recipeIcon = getRecipeDisplayIcon(itemImg, hasConfiguredResult ? result.img : null);
  const updatedTime = Number(item._stats?.modifiedTime ?? item._stats?.createdTime ?? item.sort ?? 0);
  const toolNameInput = recipe.toolName ?? "";
  const toolUuid = recipe.toolUuid ?? recipe.requirements?.tool?.uuid ?? "";
  const toolChoice = getToolChoiceValue({ name: toolNameInput, uuid: toolUuid });
  const toolOptions = await buildToolSelectOptions(recipe);
  const selectedToolOption = toolOptions.find((option) => option.selected);

  return {
    uuid: item.uuid,
    name: itemName,
    img: recipeIcon,
    favorite: Boolean(recipe.favorite),
    source: entry.source,
    sourceLabel: item._isCraftingTableDraft
      ? game.i18n.localize("CRAFTINGTABLE.GM.UnsavedDraft")
      : (editable
        ? game.i18n.localize("CRAFTINGTABLE.GM.WorldItem")
        : game.i18n.format("CRAFTINGTABLE.GM.CompendiumSource", { source: entry.source })),
    invalid: validationErrors.length > 0,
    validationErrors,
    editable,
    category,
    categoryLabel: getCategoryLabel(category),
    categoryOptions: buildCategoryOptions(category),
    rarity,
    rarityLabel: getOptionLabel(RARITY_OPTIONS, rarity),
    rarityOptions: buildSelectOptions(RARITY_OPTIONS, rarity),
    toolName: recipe.toolName || game.i18n.localize("CRAFTINGTABLE.GM.AnyAppropriateTool"),
    toolNameInput,
    toolUuid,
    toolChoice,
    toolOptions,
    isCustomTool: selectedToolOption?.value === CUSTOM_TOOL_CHOICE || selectedToolOption?.value === CURRENT_TOOL_CHOICE,
    ability,
    abilityLabel: CONFIG.DND5E?.abilities?.[ability]?.label ?? ability?.toUpperCase() ?? "INT",
    abilityOptions: buildSelectOptions(ABILITY_OPTIONS, ability),
    dc: Number(recipe.dc ?? 10),
    proficiencyRequired: Boolean(recipe.proficiencyRequired ?? recipe.requirements?.proficiencyRequired),
    time: `${time.value} ${time.unit}`,
    timeValue: time.value,
    timeUnit: time.unit,
    timeSort: getTimeSortValue(time),
    timeUnitOptions: buildSelectOptions(TIME_UNIT_OPTIONS, time.unit),
    costGp: Number(cost.value ?? 0),
    costDenomination: cost.denomination,
    costSort: Number(cost.value ?? 0),
    updatedTime,
    rarityRank: getRarityRank(rarity),
    denominationOptions: buildSelectOptions(DENOMINATION_OPTIONS, cost.denomination),
    failure: recipe.failure || "The GM decides what happens.",
    failureInput: recipe.failure ?? "",
    failureData: {
      ...failure,
      typeOptions: buildSelectOptions(FAILURE_RULE_OPTIONS, failure.type)
    },
    outcomes,
    ingredients,
    ingredientCount: ingredients.length,
    requiredIngredientCount: ingredients.filter((ingredient) => ingredient.type === "required").length,
    defaultMode,
    modeLabel: MODE_OPTIONS.find((option) => option.value === defaultMode)?.label ?? titleCase(defaultMode),
    modeOptions: buildSelectOptions(MODE_OPTIONS, defaultMode),
    result,
    results,
    resultInput: {
      name: hasConfiguredResult ? resultsData[0]?.name || "" : "",
      uuid: resultsData[0]?.uuid || "",
      img: resultsData[0]?.img || result.img || "",
      quantity: hasConfiguredResult ? Number(resultsData[0]?.quantity ?? result.quantity ?? 1) : 1
    },
    resultName: result.name,
    showToPlayers: recipe.showToPlayers !== false,
    permissions: {
      ...permissions,
      visibilityOptions: buildSelectOptions(VISIBILITY_OPTIONS, permissions.visibility),
      knowledgeSourceOptions: buildSelectOptions(KNOWLEDGE_SOURCE_OPTIONS, permissions.knowledgeSource),
      craftPermissionOptions: buildSelectOptions(CRAFT_PERMISSION_OPTIONS, permissions.craftPermission)
    },
    notes,
    description: recipe.description || item.system?.description?.value || ""
  };
}

function normalizeRecipeData(recipe = {}) {
  const next = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_RECIPE),
    recipe ?? {},
    { inplace: false }
  );

  next.isRecipe = true;
  next.schemaVersion = Math.max(CURRENT_RECIPE_SCHEMA_VERSION, Number(next.schemaVersion ?? 0));
  next.recipeId = normalizeRecipeId(next.recipeId);
  delete next.allowLearning;
  delete next.allowDiscovery;
  next.ingredients = Array.isArray(next.ingredients)
    ? next.ingredients.map((entry) => {
      const name = String(entry?.name ?? "").trim();
      const uuid = String(entry?.uuid ?? "").trim();
      if (!name && !uuid) return null;
      const normalized = {
        quantity: Math.max(1, getNumberValue(entry?.quantity, 1)),
        type: normalizeIngredientType(entry?.type),
        consumed: entry?.consumed === false ? false : true,
        matchMode: String(entry?.matchMode ?? (uuid ? "uuid" : "name")).trim() || (uuid ? "uuid" : "name")
      };
      if (name) normalized.name = name;
      if (uuid) normalized.uuid = uuid;
      if (entry?.img) normalized.img = entry.img;
      return normalized;
    }).filter(Boolean)
    : [];
  next.results = getRecipeResults(next)
    .map((entry) => {
      const name = String(entry?.name ?? "").trim();
      const uuid = String(entry?.uuid ?? "").trim();
      if (!name && !uuid) return null;
      const normalized = {
        quantity: Math.max(1, getNumberValue(entry?.quantity, 1))
      };
      if (name) normalized.name = name;
      if (uuid) normalized.uuid = uuid;
      if (entry?.img) normalized.img = entry.img;
      return normalized;
    })
    .filter(Boolean);
  next.result = next.results[0] ?? null;
  normalizeRecipeToolFields(next);
  next.requirements = {
    ...(next.requirements ?? {}),
    tool: {
      name: next.toolName,
      uuid: next.toolUuid,
      key: next.toolKey
    },
    ability: next.ability,
    dc: next.dc,
    proficiencyRequired: isRecipeProficiencyRequired(next),
    time: {
      value: Math.max(1, getNumberValue(next.requirements?.time?.value ?? next.timeValue, 1)),
      unit: String(next.requirements?.time?.unit ?? next.timeUnit ?? "hours") || "hours"
    },
    cost: {
      value: Math.max(0, getNumberValue(next.requirements?.cost?.value ?? next.costGp, 0)),
      denomination: String(next.requirements?.cost?.denomination ?? next.costDenomination ?? "gp") || "gp"
    },
    defaultMode: normalizeCraftingMode(recipe?.defaultMode ?? recipe?.requirements?.defaultMode, getWorldDefaultCraftingMode())
  };
  next.timeValue = next.requirements.time.value;
  next.timeUnit = next.requirements.time.unit;
  next.time = `${next.timeValue} ${next.timeUnit}`;
  next.costGp = next.requirements.cost.value;
  next.costDenomination = next.requirements.cost.denomination;
  next.proficiencyRequired = next.requirements.proficiencyRequired === true;
  next.defaultMode = next.requirements.defaultMode;
  next.outcomes = normalizeOutcomesData(next);
  next.failure = next.outcomes.failure?.flavorText ?? next.failure ?? DEFAULT_RECIPE.failure;
  next.failureData = outcomesToFailureData(next.outcomes);
  next.permissions = normalizePermissionsData(next);
  next.notes = normalizeNotesData(next);
  return next;
}

function getRecipeData(item) {
  const recipe = normalizeRecipeData(item.getFlag(MODULE_ID, RECIPE_FLAG) ?? {});
  recipe.recipeId = resolveRecipeId({
    recipeId: recipe.recipeId,
    sourceRecipeUuid: recipe.sourceRecipeUuid,
    sourceId: item?.getFlag?.("core", "sourceId"),
    compendiumSource: item?._stats?.compendiumSource,
    documentUuid: item?.uuid
  });
  return recipe;
}

function createHeadlessCraftingBench(actor, operation = null) {
  const runner = Object.create(CraftingBenchApp.prototype);
  runner.actor = actor;
  runner.mode = getWorldDefaultCraftingMode();
  runner.selectedUuid = null;
  runner._activeCraftOperation = operation;
  return runner;
}

async function prepareSocketRecipe({ actor, operation, payload, senderUser }) {
  operation.assertCurrent();
  const item = await resolveSocketRecipeItem(actor, payload);
  if (item?.documentName !== "Item" || !item.getFlag(MODULE_ID, RECIPE_FLAG)?.isRecipe) {
    throw new CraftingStateChangedError("The crafting recipe no longer exists.");
  }
  const rawRecipe = getRecipeData(item);
  if (payload.recipeId && payload.recipeId !== rawRecipe.recipeId) {
    throw new CraftingStateChangedError("The crafting recipe identity changed before the operation could be completed.");
  }
  if (payload.recipeRevision && payload.recipeRevision !== JSON.stringify(rawRecipe)) {
    throw new CraftingStateChangedError("The crafting recipe changed before the operation could be completed.");
  }

  const runner = createHeadlessCraftingBench(actor, operation);
  runner.selectedUuid = item.uuid;
  const known = senderUser.isGM || (isRecipeVisibleToPlayers(rawRecipe) && runner._actorKnowsRecipe(item, rawRecipe));
  if (!known) throw new CraftingAuthorizationError("recipe-unavailable", "The user cannot access this crafting recipe.");
  const recipe = await runner._prepareRecipe({ item, source: "socket", known }, { user: senderUser });
  operation.assertCurrent();
  return { item, rawRecipe, recipe, runner };
}

async function resolveSocketRecipeItem(actor, reference = {}) {
  const direct = await safeFromUuid(reference.recipeUuid);
  if (direct?.documentName === "Item" && direct.getFlag(MODULE_ID, RECIPE_FLAG)?.isRecipe) {
    const directRecipe = getRecipeData(direct);
    if (!reference.recipeId || directRecipe.recipeId === reference.recipeId) return direct;
  }
  if (!reference.recipeId) return null;

  const localCandidates = [
    ...Array.from(actor?.items ?? []),
    ...Array.from(game.items ?? [])
  ];
  for (const candidate of localCandidates) {
    if (!candidate?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) continue;
    if (getRecipeData(candidate).recipeId === reference.recipeId) return candidate;
  }
  return recipeRepository.findByRecipeId(reference.recipeId, { localItems: localCandidates });
}

function hasPreparedCraftResources(recipe) {
  return Boolean(
    recipe?.known
    && recipe.hasTool
    && recipe.hasProficiency
    && recipe.hasIngredients
    && recipe.hasCost
    && recipe.progressComplete
    && recipe.results?.length
    && recipe.results.every((entry) => entry.uuid)
  );
}

function assertSocketCraftPermission({ actor, rawRecipe, recipe, payload, senderUser }) {
  if (recipe.pendingGmOutcome) {
    throw new CraftingStateChangedError("This recipe is already waiting for a GM outcome decision.");
  }
  if (!hasPreparedCraftResources(recipe)) throw new CraftingStateChangedError("The actor is no longer ready to craft this recipe.");
  if (senderUser.isGM) return true;

  const permissions = normalizePermissionsData(rawRecipe);
  const craftPermission = normalizeCraftPermission(permissions.craftPermission);
  if (craftPermission === "gmOnly") {
    throw new CraftingAuthorizationError("gm-required", "Only a GM can craft this recipe.");
  }

  const needsApproval = craftPermission === "gmApprovalRequired" || recipe.effectiveMode === "gm-approval";
  if (!needsApproval) return true;
  const request = getActorCraftRequests(actor).find((entry) => entry.id === payload.requestId);
  if (
    !request
    || !recipeReferencesMatch(request, { recipeId: recipe.recipeId, recipeUuid: recipe.uuid })
    || request.status !== "processing"
    || request.executionId !== payload.executionId
  ) {
    throw new CraftingStateChangedError("The GM approval is no longer reserved for this crafting operation.");
  }
  if (request.requestedByUserId && request.requestedByUserId !== senderUser.id) {
    throw new CraftingAuthorizationError("request-owner-required", "The GM approval belongs to another user.");
  }
  return true;
}

function assertSocketOptionalIngredientSelection(recipe, selection) {
  const normalized = normalizeOptionalIngredientSelection(recipe.ingredients ?? [], selection ?? []);
  if (normalized.invalid.length) {
    throw new CraftingSocketError("invalid-optional-ingredients", "The optional ingredient selection is invalid.");
  }
  return normalized.indexes;
}

function ingredientSelectionsMatch(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function finalizeSocketCraft({
  actor,
  runner,
  recipe,
  requestId,
  executionId,
  clearProgress = () => runner._clearCraftProgress(recipe),
  finalizeRequest = craftRequestService.complete,
  pendingOutcomeId = "",
  pendingOutcomeStatus = "resolved",
  pendingOutcomeDecision = null
}) {
  return finalizeCraftingState({
    actor,
    requestId,
    executionId,
    getOngoingCrafts: getActorOngoingCrafts,
    getCraftRequests: getActorCraftRequests,
    getPendingOutcomes: getActorPendingOutcomes,
    saveOngoingCrafts: saveActorOngoingCrafts,
    saveCraftRequests: saveActorCraftRequests,
    savePendingOutcomes: saveActorPendingOutcomes,
    clearProgress,
    completeRequest: craftRequestService.complete,
    finalizeRequest,
    finalizePendingOutcome: pendingOutcomeId ? () => {
      const transition = pendingOutcomeStatus === "cancelled"
        ? pendingOutcomeService.cancel
        : pendingOutcomeService.resolve;
      return transition(actor, pendingOutcomeId, pendingOutcomeDecision ?? {});
    } : null,
    assertCurrent: () => runner._activeCraftOperation?.assertCurrent(),
    clone: (value) => foundry.utils.deepClone(value)
  });
}

async function queueSocketPendingOutcome({ actor, operation, senderUser, recipe, payload, reason = "gmDecision", notes = [] }) {
  operation.assertCurrent();
  const queued = await pendingOutcomeService.queue(actor, {
    actorUuid: actor.uuid,
    actorName: actor.name,
    recipeId: recipe.recipeId,
    recipeUuid: recipe.uuid,
    recipeRevision: recipe.recipeRevision,
    recipeName: recipe.name,
    recipeImg: recipe.img,
    outcomeType: payload.outcomeType,
    optionalIngredientIndexes: recipe.optionalIngredientIndexes ?? [],
    reason,
    requestId: payload.requestId,
    requestExecutionId: payload.executionId,
    sourceOperationId: operation.id,
    requestedBy: senderUser.name ?? "",
    requestedByUserId: senderUser.id,
    resolutionNotes: notes
  });
  operation.assertCurrent();
  Hooks.callAll(CRAFTING_TABLE_HOOKS.outcomeQueued, {
    apiVersion: CRAFTING_TABLE_API_VERSION,
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    actor,
    recipe,
    outcomeType: payload.outcomeType,
    pendingOutcome: queued.outcome
  });
  return {
    resolved: true,
    kind: "gm-decision-pending",
    created: queued.created,
    pendingOutcomeId: queued.outcome.id,
    notes
  };
}

async function executeSocketFailureOutcome({ actor, runner, recipe, finalize }) {
  const failure = recipe.failureRule ?? { type: "loseAllIngredients", results: [] };
  const failureType = failure.type || "loseAllIngredients";
  let transaction = { createdLabels: [] };
  if (failureType === "loseAllIngredients") {
    transaction = await runner._executeCraftTransaction(recipe, { ingredientMultiplier: 1 }, {
      resultEntries: [], cost: { value: 0, denomination: "gp" }, finalize
    });
  } else if (failureType === "loseHalfIngredients") {
    transaction = await runner._executeCraftTransaction(recipe, { ingredientMultiplier: 0.5 }, {
      resultEntries: [], cost: { value: 0, denomination: "gp" }, finalize
    });
  } else if (failureType === "createFailureItem") {
    transaction = await runner._executeCraftTransaction(recipe, { ingredientMultiplier: 1, outputMultiplier: 1, itemTraits: ["failure"] }, {
      resultEntries: failure.results ?? [], cost: { value: 0, denomination: "gp" }, finalize
    });
  } else {
    if (failureType === "customMacro") {
      const completed = await executeCraftingMacro({
        macroUuid: failure.macroUuid,
        actor,
        recipe,
        outcomeType: "failure",
        app: runner,
        throwOnError: true
      });
      if (!completed) return { resolved: false, kind: "macro-cancelled", failureType };
    } else if (failureType !== "noPenalty") {
      Hooks.callAll(CRAFTING_TABLE_HOOKS.resolveOutcome, {
        apiVersion: CRAFTING_TABLE_API_VERSION,
        recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
        actor,
        recipe,
        outcomeType: "failure",
        failure
      });
    }
    await finalize();
  }
  return { resolved: true, kind: "failure", failureType, createdLabels: transaction.createdLabels };
}

async function executeSocketCriticalFailureOutcome({ actor, runner, recipe, finalize }) {
  const critical = recipe.outcomes?.criticalFailure ?? {};
  const effectType = critical.effect?.type || "gmDecision";
  if (effectType === "customMacro") {
    const completed = await executeCraftingMacro({
      macroUuid: critical.effect?.macroUuid,
      actor,
      recipe,
      outcomeType: "criticalFailure",
      app: runner,
      throwOnError: true
    });
    if (!completed) return { resolved: false, kind: "macro-cancelled", effectType };
    await finalize();
    return { resolved: true, kind: "critical-failure", effectType, createdLabels: [] };
  }

  const resultEntries = effectType === "createFailureItem" ? (critical.results ?? []) : [];
  const destroyTool = effectType === "destroyTool" && Boolean(runner._findOwnedToolItem(recipe));
  const transaction = await runner._executeCraftTransaction(recipe, {
    ingredientMultiplier: 1,
    outputMultiplier: 1,
    itemTraits: ["critical-failure"]
  }, {
    resultEntries,
    cost: { value: 0, denomination: "gp" },
    destroyTool,
    finalize
  });
  return { resolved: true, kind: "critical-failure", effectType, createdLabels: transaction.createdLabels };
}

async function handleSocketWorkAdded(payload, context) {
  const { actor, operation } = context;
  const { recipe, runner } = await prepareSocketRecipe({ ...context, payload });
  if (!recipe.canWork) throw new CraftingStateChangedError("The actor can no longer work on this recipe.");
  const amount = Math.max(0, Number(payload.amount ?? 0));
  if (!Number.isFinite(amount) || amount <= 0) throw new CraftingSocketError("invalid-work-amount", "Crafting work must be a positive number.");
  const previousWorked = recipe.progress.workedHours;
  const workedHours = Math.min(recipe.totalWorkHours, previousWorked + amount);
  await runner._setCraftProgress(recipe, workedHours);
  operation.assertCurrent();
  return {
    addedHours: Math.max(0, workedHours - previousWorked),
    workedHours,
    totalHours: recipe.totalWorkHours,
    percent: recipe.totalWorkHours > 0 ? Math.min(100, Math.floor((workedHours / recipe.totalWorkHours) * 100)) : 100
  };
}

async function handleSocketRequestCreated(payload, context) {
  const { actor, senderUser } = context;
  const { recipe } = await prepareSocketRecipe({ ...context, payload });
  const recipeReference = { recipeId: recipe.recipeId, recipeUuid: recipe.uuid };
  const existing = craftRequestService.findLatest(actor, recipeReference, craftRequestService.activeStatuses);
  if (!existing && (!recipe.canCraft || !recipe.permissionState?.canRequest)) {
    throw new CraftingAuthorizationError("approval-unavailable", "This recipe cannot be submitted for GM approval.");
  }
  const result = await craftRequestService.createApprovalRequest(actor, {
    recipeId: recipe.recipeId,
    recipeUuid: recipe.uuid,
    recipeName: recipe.name,
    recipeImg: recipe.img,
    actorUuid: actor.uuid,
    actorId: actor.id,
    actorName: actor.name,
    requestedBy: senderUser.name ?? "",
    requestedByUserId: senderUser.id,
    mode: recipe.effectiveMode,
    progressPercent: Math.max(0, Math.min(100, Number(payload.progressPercent ?? recipe.progress?.percent ?? 100)))
  });
  return { created: result.created, request: result.request };
}

function assertMatchingCraftRequest(actor, payload) {
  const request = getActorCraftRequests(actor).find((entry) => entry.id === payload.requestId);
  if (!request || ((payload.recipeId || payload.recipeUuid) && !recipeReferencesMatch(request, payload))) {
    throw new CraftingStateChangedError("The craft request no longer exists.");
  }
  return request;
}

function assertCraftRequestInitiator(request, senderUser) {
  if (!senderUser.isGM && request.requestedByUserId && request.requestedByUserId !== senderUser.id) {
    throw new CraftingAuthorizationError("request-owner-required", "The craft request belongs to another user.");
  }
}

async function handleSocketRequestClaimed(payload, { actor, senderUser }) {
  const request = assertMatchingCraftRequest(actor, payload);
  assertCraftRequestInitiator(request, senderUser);
  if (pendingOutcomeService.findActive(actor, request)) {
    throw new CraftingStateChangedError("This recipe is already waiting for a GM outcome decision.");
  }
  return craftRequestService.claim(actor, payload.requestId, payload.executionId);
}

async function handleSocketRequestReleased(payload, { actor, senderUser }) {
  const request = assertMatchingCraftRequest(actor, payload);
  assertCraftRequestInitiator(request, senderUser);
  return { released: await craftRequestService.release(actor, payload.requestId, payload.executionId) };
}

async function handleSocketCraftCommitted(payload, context) {
  const { actor, operation, senderUser } = context;
  if (!isValidOutcomeType(payload.outcomeType)) {
    throw new CraftingSocketError("invalid-outcome", "The crafting outcome is invalid.");
  }
  const prepared = await prepareSocketRecipe({ ...context, payload });
  const { rawRecipe, recipe, runner } = prepared;
  const optionalIngredientIndexes = assertSocketOptionalIngredientSelection(rawRecipe, payload.optionalIngredientIndexes);
  const pendingOptionalIngredientIndexes = recipe.progress?.pendingOutcome?.optionalIngredientIndexes;
  if (recipe.progress?.pendingOutcome?.recipeRevision && recipe.progress.pendingOutcome.recipeRevision !== recipe.recipeRevision) {
    throw new CraftingStateChangedError("The recipe changed while the crafting outcome was pending.");
  }
  if (recipe.progress?.pendingOutcome && !ingredientSelectionsMatch(
    optionalIngredientIndexes,
    assertSocketOptionalIngredientSelection(rawRecipe, pendingOptionalIngredientIndexes)
  )) {
    throw new CraftingStateChangedError("The optional ingredient selection changed while the outcome was pending.");
  }
  recipe.optionalIngredientIndexes = optionalIngredientIndexes;
  assertSocketCraftPermission({ actor, rawRecipe, recipe, payload, senderUser });
  const pendingOutcome = recipe.progress?.pendingOutcome?.type;
  if (pendingOutcome && (!payload.resumed || pendingOutcome !== payload.outcomeType)) {
    throw new CraftingStateChangedError("The pending crafting outcome changed.");
  }

  const finalize = () => finalizeSocketCraft({
    actor,
    runner,
    recipe,
    requestId: payload.requestId,
    executionId: payload.executionId
  });

  if (recipe.effectiveMode === "manual") {
    await finalize();
    return { resolved: true, kind: "manual" };
  }

  if (payload.outcomeType === "failure") {
    return executeSocketFailureOutcome({ actor, runner, recipe, finalize });
  }

  if (payload.outcomeType === "criticalFailure") {
    const critical = recipe.outcomes?.criticalFailure ?? {};
    const effectType = critical.effect?.type || "gmDecision";
    const destroyTool = effectType === "destroyTool" && Boolean(runner._findOwnedToolItem(recipe));
    if (effectType === "gmDecision" || (effectType === "destroyTool" && !destroyTool)) {
      return queueSocketPendingOutcome({
        actor,
        operation,
        senderUser,
        recipe,
        payload,
        reason: effectType === "destroyTool" ? "missingTool" : "gmDecision"
      });
    }
    return executeSocketCriticalFailureOutcome({ actor, runner, recipe, finalize });
  }

  const execution = buildOutcomeExecutionPlan({ type: payload.outcomeType, outcomes: recipe.outcomes });
  const gmDecisionApproved = Boolean(recipe.progress?.pendingOutcome?.gmDecisionApproved);
  if (execution.requiresGm && !gmDecisionApproved) {
    return queueSocketPendingOutcome({
      actor,
      operation,
      senderUser,
      recipe,
      payload,
      reason: "gmDecision",
      notes: execution.notes ?? []
    });
  }
  if (!payload.resumed && execution.extraTimeMultiplier > 1 && recipe.totalWorkHours > 0) {
    const extendedTotal = recipe.totalWorkHours * execution.extraTimeMultiplier;
    await runner._setCraftProgress(recipe, recipe.progress.workedHours, {
      totalHours: extendedTotal,
      pendingOutcome: {
        type: payload.outcomeType,
        optionalIngredientIndexes,
        recipeRevision: recipe.recipeRevision
      }
    });
    operation.assertCurrent();
    return {
      resolved: false,
      kind: "extra-time",
      extendedTotal,
      remainingHours: Math.max(0, extendedTotal - recipe.progress.workedHours)
    };
  }
  const transaction = await runner._executeCraftTransaction(recipe, execution, { finalize });
  return {
    resolved: true,
    kind: "success",
    createdLabels: transaction.createdLabels,
    notes: execution.notes ?? []
  };
}

async function handleSocketRequestDecided(payload, { actor, senderUser }) {
  const status = String(payload.status ?? "");
  if (!new Set(["approved", "rejected"]).has(status)) {
    throw new CraftingSocketError("invalid-request-status", "The craft request decision is invalid.");
  }
  assertMatchingCraftRequest(actor, payload);
  const transition = await craftRequestService.decide(actor, payload.requestId, status, {
    decisionId: payload.decisionId,
    decidedBy: senderUser.name ?? "GM",
    decidedByUserId: senderUser.id
  });
  return { changed: transition.changed, request: transition.request };
}

async function handleSocketRequestCleared(payload, { actor }) {
  const request = await craftRequestService.clear(actor, payload.requestId);
  return { cleared: true, requestId: request.id };
}

async function handleSocketRequestsPruned(_payload, { actor }) {
  const requests = getActorCraftRequests(actor);
  const next = requests.filter((request) => ["pending", "approved", "processing"].includes(request.status));
  await saveActorCraftRequests(actor, next);
  return { cleared: requests.length - next.length };
}

function buildPendingOutcomeDecision(payload, senderUser, resolution) {
  return {
    decisionId: String(payload.decisionId ?? ""),
    resolution,
    resolvedBy: senderUser.name ?? "GM",
    resolvedByUserId: senderUser.id,
    resolutionNotes: Array.isArray(payload.resolutionNotes) ? payload.resolutionNotes : []
  };
}

async function handleSocketPendingOutcomeResolved(payload, context) {
  const { actor, operation, senderUser } = context;
  const resolution = String(payload.resolution ?? "");
  if (!VALID_PENDING_OUTCOME_RESOLUTIONS.has(resolution)) {
    throw new CraftingSocketError("invalid-gm-resolution", "The GM outcome resolution is invalid.");
  }
  const pendingOutcome = pendingOutcomeService.findById(actor, payload.pendingOutcomeId);
  if (!pendingOutcome || pendingOutcome.status !== "pending") {
    throw new CraftingStateChangedError("The pending GM outcome no longer exists.");
  }
  const prepared = await prepareSocketRecipe({
    ...context,
    payload: {
      recipeId: pendingOutcome.recipeId,
      recipeUuid: pendingOutcome.recipeUuid,
      recipeRevision: pendingOutcome.recipeRevision
    }
  });
  const { rawRecipe, recipe, runner } = prepared;
  if (pendingOutcome.outcomeType && !isValidOutcomeType(pendingOutcome.outcomeType)) {
    throw new CraftingStateChangedError("The pending crafting outcome is invalid.");
  }
  recipe.optionalIngredientIndexes = assertSocketOptionalIngredientSelection(rawRecipe, pendingOutcome.optionalIngredientIndexes);

  const decision = buildPendingOutcomeDecision(payload, senderUser, resolution);
  const finalize = () => finalizeSocketCraft({
    actor,
    runner,
    recipe,
    requestId: pendingOutcome.requestId,
    executionId: pendingOutcome.requestExecutionId,
    pendingOutcomeId: pendingOutcome.id,
    pendingOutcomeDecision: decision
  });

  let result;
  if (resolution === "noEffect") {
    await finalize();
    result = { resolved: true, kind: "no-effect", createdLabels: [] };
  } else if (resolution === "failure") {
    result = await executeSocketFailureOutcome({ actor, runner, recipe, finalize });
  } else if (resolution === "success") {
    const transaction = await runner._executeCraftTransaction(recipe, {}, { finalize });
    result = { resolved: true, kind: "success", createdLabels: transaction.createdLabels };
  } else if (pendingOutcome.outcomeType === "criticalFailure") {
    result = await executeSocketCriticalFailureOutcome({ actor, runner, recipe, finalize });
  } else {
    const execution = {
      ...buildOutcomeExecutionPlan({ type: pendingOutcome.outcomeType, outcomes: recipe.outcomes }),
      requiresGm: false
    };
    if (execution.extraTimeMultiplier > 1 && recipe.totalWorkHours > 0) {
      const extendedTotal = recipe.totalWorkHours * execution.extraTimeMultiplier;
      await finalizeSocketCraft({
        actor,
        runner,
        recipe,
        requestId: pendingOutcome.requestId,
        executionId: pendingOutcome.requestExecutionId,
        clearProgress: () => runner._setCraftProgress(recipe, recipe.progress.workedHours, {
          totalHours: extendedTotal,
          pendingOutcome: {
            type: pendingOutcome.outcomeType,
            gmDecisionApproved: true,
            optionalIngredientIndexes: recipe.optionalIngredientIndexes,
            recipeRevision: recipe.recipeRevision
          }
        }),
        finalizeRequest: craftRequestService.release,
        pendingOutcomeId: pendingOutcome.id,
        pendingOutcomeDecision: decision
      });
      result = {
        resolved: true,
        kind: "extra-time",
        extendedTotal,
        remainingHours: Math.max(0, extendedTotal - recipe.progress.workedHours),
        createdLabels: []
      };
    } else {
      const transaction = await runner._executeCraftTransaction(recipe, execution, { finalize });
      result = {
        resolved: true,
        kind: "configured",
        createdLabels: transaction.createdLabels,
        notes: execution.notes ?? []
      };
    }
  }

  if (!result?.resolved) return result;
  operation.assertCurrent();
  Hooks.callAll(CRAFTING_TABLE_HOOKS.resolveOutcome, {
    apiVersion: CRAFTING_TABLE_API_VERSION,
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    actor,
    recipe,
    outcomeType: pendingOutcome.outcomeType,
    resolution,
    pendingOutcome,
    result
  });
  Hooks.callAll(CRAFTING_TABLE_HOOKS.outcomeResolved, {
    apiVersion: CRAFTING_TABLE_API_VERSION,
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    actor,
    recipe,
    outcomeType: pendingOutcome.outcomeType,
    resolution,
    pendingOutcome,
    result
  });
  return { ...result, resolution, pendingOutcomeId: pendingOutcome.id };
}

async function handleSocketPendingOutcomeCancelled(payload, { actor, operation, senderUser }) {
  const pendingOutcome = pendingOutcomeService.findById(actor, payload.pendingOutcomeId);
  if (!pendingOutcome || pendingOutcome.status !== "pending") {
    throw new CraftingStateChangedError("The pending GM outcome no longer exists.");
  }
  const runner = createHeadlessCraftingBench(actor, operation);
  const recipeReference = {
    recipeId: pendingOutcome.recipeId,
    uuid: pendingOutcome.recipeUuid
  };
  const decision = buildPendingOutcomeDecision(payload, senderUser, "returned");
  await finalizeSocketCraft({
    actor,
    runner,
    recipe: recipeReference,
    requestId: pendingOutcome.requestId,
    executionId: pendingOutcome.requestExecutionId,
    clearProgress: async () => undefined,
    finalizeRequest: craftRequestService.release,
    pendingOutcomeId: pendingOutcome.id,
    pendingOutcomeStatus: "cancelled",
    pendingOutcomeDecision: decision
  });
  operation.assertCurrent();
  Hooks.callAll(CRAFTING_TABLE_HOOKS.outcomeResolved, {
    apiVersion: CRAFTING_TABLE_API_VERSION,
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    actor,
    outcomeType: pendingOutcome.outcomeType,
    resolution: "returned",
    pendingOutcome,
    result: { resolved: false, kind: "returned" }
  });
  return { cancelled: true, resolution: "returned", pendingOutcomeId: pendingOutcome.id };
}

async function handleSocketPendingOutcomesPruned(_payload, { actor }) {
  return { cleared: await pendingOutcomeService.pruneFinished(actor) };
}

async function handleSocketOperationReviewed(payload, { actor, senderUser }) {
  const ledger = actor.getFlag(MODULE_ID, OPERATION_LEDGER_FLAG);
  const entries = Array.isArray(ledger) ? ledger : [];
  const target = entries.find((entry) => entry.id === payload.targetOperationId);
  if (!target || !["processing", "review-required"].includes(target.status)) {
    throw new CraftingStateChangedError("The interrupted crafting operation no longer requires review.");
  }
  const reviewedAt = Date.now();
  await actor.setFlag(MODULE_ID, OPERATION_LEDGER_FLAG, entries.map((entry) => entry === target ? {
    ...entry,
    status: "reviewed",
    completedAt: reviewedAt,
    reviewedAt,
    reviewedBy: senderUser.id
  } : entry));
  return { reviewed: true, operationId: target.id };
}

function findSocketProgressEntry(entries, payload) {
  return entries.find((entry) => (payload.craftId && entry.id === payload.craftId)
    || ((payload.recipeId || payload.recipeUuid) && recipeReferencesMatch(entry, payload)));
}

async function handleSocketProgressReady(payload, { actor }) {
  const crafts = getActorOngoingCrafts(actor);
  const target = findSocketProgressEntry(crafts, payload);
  if (!target) throw new CraftingStateChangedError("The ongoing craft no longer exists.");
  const next = crafts.map((entry) => {
    if (entry !== target) return entry;
    const totalHours = Math.max(0, Number(entry.totalHours ?? entry.workedHours ?? 0));
    return { ...entry, workedHours: totalHours, totalHours, updatedTime: Date.now() };
  });
  await saveActorOngoingCrafts(actor, next);
  return { ready: true };
}

async function handleSocketProgressCleared(payload, { actor }) {
  const crafts = getActorOngoingCrafts(actor);
  const target = findSocketProgressEntry(crafts, payload);
  if (!target) throw new CraftingStateChangedError("The ongoing craft no longer exists.");
  await saveActorOngoingCrafts(actor, crafts.filter((entry) => entry !== target));
  return { cleared: true };
}

async function handleSocketProgressPruned(_payload, { actor }) {
  const crafts = getActorOngoingCrafts(actor);
  const next = crafts.filter((entry) => !isOngoingCraftComplete(entry));
  await saveActorOngoingCrafts(actor, next);
  return { cleared: crafts.length - next.length };
}

function getRecipeIdentityKeys(item, recipeData = null) {
  const recipe = recipeData ?? getRecipeData(item);
  const recipeId = resolveRecipeId({
    recipeId: recipe.recipeId,
    sourceRecipeUuid: recipe.sourceRecipeUuid,
    sourceId: item?.getFlag?.("core", "sourceId"),
    compendiumSource: item?._stats?.compendiumSource,
    documentUuid: item?.uuid
  });
  return recipeId ? [recipeId] : [];
}

function recipeItemsShareIdentity(leftItem, leftRecipe, rightItem, rightRecipe) {
  const rightIdentities = new Set(getRecipeIdentityKeys(rightItem, rightRecipe));
  return getRecipeIdentityKeys(leftItem, leftRecipe).some((identity) => rightIdentities.has(identity));
}

function getRecipeResults(recipe) {
  if (Array.isArray(recipe.results) && recipe.results.length) return recipe.results;
  return recipe.result ? [recipe.result] : [];
}

function getRecipeTimeData(recipe) {
  if (recipe.requirements?.time) {
    return {
      value: Number(recipe.requirements.time.value ?? recipe.timeValue ?? 1),
      unit: recipe.requirements.time.unit || recipe.timeUnit || "hours"
    };
  }

  const match = String(recipe.time ?? "").match(/^(\d+(?:\.\d+)?)\s*(\w+)?/);
  return {
    value: Number(recipe.timeValue ?? match?.[1] ?? 1),
    unit: recipe.timeUnit || match?.[2] || "hours"
  };
}

function getRecipeWorkHours(recipe) {
  const time = getRecipeTimeData(recipe);
  const value = Math.max(0, Number(time.value ?? 0));
  const unit = String(time.unit ?? "hours").toLowerCase();
  const multipliers = {
    minute: 1 / 60,
    minutes: 1 / 60,
    hour: 1,
    hours: 1,
    day: 8,
    days: 8,
    week: 40,
    weeks: 40
  };
  return value * (multipliers[unit] ?? 1);
}


function getNaturalD20Result(roll) {
  const die = roll?.dice?.find((term) => Number(term.faces) === 20);
  const active = die?.results?.find((result) => result.active !== false && result.discarded !== true);
  return Number(active?.result ?? die?.total ?? 0) || null;
}

function isValidOutcomeType(value) {
  return VALID_OUTCOME_TYPES.has(String(value ?? ""));
}

function notifyCraftingOperationError(error) {
  if (error instanceof CraftingOperationBusyError || error?.code === "operation-busy") {
    ui.notifications.warn(ct("notify.craftingBusy"));
    return true;
  }
  if (error instanceof CraftingStateChangedError || [
    "state-changed",
    "operation-id-conflict",
    "actor-not-found",
    "recipe-unavailable",
    "approval-unavailable"
  ].includes(error?.code)) {
    ui.notifications.warn(ct("notify.craftingStateChanged"));
    return true;
  }
  if (error instanceof CraftingAuthorizationError || ["actor-owner-required", "request-owner-required", "gm-required"].includes(error?.code)) {
    const key = error.code === "gm-required" ? "notify.gmPermissionDenied" : "notify.actorPermissionDenied";
    ui.notifications.warn(ct(key));
    return true;
  }
  if (error instanceof CraftingSocketError) {
    if (error.code === "no-active-gm") ui.notifications.warn(ct("notify.noActiveGm"));
    else if (error.code === "operation-pending-review") ui.notifications.warn(ct("notify.operationPendingReview"));
    else if (["socket-timeout", "executor-changed", "socket-inactive", "socket-unavailable"].includes(error.code)) {
      ui.notifications.warn(ct("notify.socketUnavailable"));
    } else return false;
    return true;
  }
  return false;
}

function formatOutcomeLabel(type) {
  const labels = {
    success: ct("outcome.success"),
    failure: ct("outcome.failure"),
    partialSuccess: ct("outcome.partialSuccess"),
    criticalSuccess: ct("outcome.criticalSuccess"),
    criticalFailure: ct("outcome.criticalFailure")
  };
  return labels[type] ?? titleCase(type);
}

function formatExecutionNote(note) {
  const value = String(note ?? "");
  const timeMultiplier = value.match(/^Crafting time multiplier:\s*(.+)$/i);
  if (timeMultiplier) return ct("chat.noteTimeMultiplier", { value: timeMultiplier[1] });
  const condition = value.match(/^Condition:\s*(.+)$/i);
  if (condition) return ct("chat.noteCondition", { value: condition[1] });
  return value;
}

function formatPendingOutcomeResolution(resolution) {
  const labels = {
    configured: ct("outcomeDecision.configured"),
    success: ct("outcomeDecision.success"),
    failure: ct("outcomeDecision.failure"),
    noEffect: ct("outcomeDecision.noEffect"),
    returned: ct("outcomeDecision.return")
  };
  return labels[resolution] ?? titleCase(resolution);
}

function selectChanceResults(results = []) {
  return (results ?? []).filter((result) => {
    const chance = Math.max(0, Math.min(100, Number(result.chance ?? 100)));
    return chance >= 100 || Math.random() * 100 < chance;
  });
}

function applyCraftOutcomeName(name, traits = []) {
  const prefixes = [];
  const quality = traits.find((trait) => String(trait).startsWith("quality:"));
  if (quality) prefixes.push(getOptionLabel(QUALITY_TIER_OPTIONS, String(quality).slice(8)));
  if (traits.includes("unstable")) prefixes.push(ct("outcomeName.unstable"));
  if (traits.includes("weaker")) prefixes.push(ct("outcomeName.weaker"));
  return [...prefixes, String(name ?? ct("outcomeName.craftedItem"))].join(" ").trim();
}

function getRecipeCostData(recipe) {
  return {
    value: Number(recipe.requirements?.cost?.value ?? recipe.costGp ?? 0),
    denomination: recipe.requirements?.cost?.denomination || recipe.costDenomination || "gp"
  };
}

function formatCurrencyCost(cost = {}) {
  const value = Number(cost.value ?? 0);
  const denomination = String(cost.denomination ?? "gp").toLowerCase();
  return `${value} ${CURRENCY_TO_CP[denomination] ? denomination : "gp"}`;
}

function getCostValueInCp(cost = {}) {
  const value = Math.max(0, Number(cost.value ?? 0));
  const denomination = String(cost.denomination ?? "gp").toLowerCase();
  return Math.floor(value * (CURRENCY_TO_CP[denomination] ?? CURRENCY_TO_CP.gp));
}

function normalizeCurrency(currency = {}) {
  return {
    cp: Math.max(0, Number(currency.cp ?? 0)),
    sp: Math.max(0, Number(currency.sp ?? 0)),
    ep: Math.max(0, Number(currency.ep ?? 0)),
    gp: Math.max(0, Number(currency.gp ?? 0)),
    pp: Math.max(0, Number(currency.pp ?? 0))
  };
}

function getCurrencyValueInCp(currency = {}) {
  const normalized = normalizeCurrency(currency);
  return Object.entries(CURRENCY_TO_CP).reduce((total, [denomination, multiplier]) => {
    return total + Math.floor(Number(normalized[denomination] ?? 0) * multiplier);
  }, 0);
}

function normalizeFailureData(recipe) {
  const failure = typeof recipe.failureData === "object" && recipe.failureData
    ? foundry.utils.mergeObject(
      foundry.utils.deepClone(DEFAULT_RECIPE.failureData),
      recipe.failureData,
      { inplace: false }
    )
    : foundry.utils.deepClone(DEFAULT_RECIPE.failureData);

  failure.failureItem = failure.failureItem ?? { name: "", uuid: "" };
  return failure;
}

function normalizeOutcomesData(recipe) {
  const legacyFailure = normalizeFailureData(recipe);
  const legacyOutcomes = buildOutcomesFromLegacyFailure(recipe, legacyFailure);
  const sourceOutcomes = typeof recipe.outcomes === "object" && recipe.outcomes ? recipe.outcomes : {};
  const outcomes = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_OUTCOMES),
    legacyOutcomes,
    { inplace: false }
  );

  foundry.utils.mergeObject(outcomes, sourceOutcomes, { inplace: true });
  outcomes.success = outcomes.success ?? {};
  outcomes.failure = outcomes.failure ?? {};
  const failureTypes = new Set(FAILURE_RULE_OPTIONS.map((option) => option.value));
  outcomes.failure.type = failureTypes.has(outcomes.failure.type) ? outcomes.failure.type : "gmDecision";
  outcomes.failure.results = Array.isArray(outcomes.failure.results) ? outcomes.failure.results : [];
  outcomes.failure.flavorText = String(outcomes.failure.flavorText ?? recipe.failure ?? "").trim();
  outcomes.failure.macroUuid = String(outcomes.failure.macroUuid ?? "").trim();

  outcomes.partialSuccess = outcomes.partialSuccess ?? {};
  outcomes.partialSuccess.enabled = Boolean(outcomes.partialSuccess.enabled);
  outcomes.partialSuccess.missBy = Math.max(1, Number(outcomes.partialSuccess.missBy ?? 2));
  const partialEffectTypes = new Set(PARTIAL_EFFECT_OPTIONS.map((option) => option.value));
  const normalizePartialEffect = (effect) => {
    const normalized = typeof effect === "object" && effect ? effect : { type: effect || "gmDecision" };
    normalized.type = partialEffectTypes.has(normalized.type) ? normalized.type : "gmDecision";
    return normalized;
  };
  outcomes.partialSuccess.effect = normalizePartialEffect(outcomes.partialSuccess.effect);
  outcomes.partialSuccess.effect.qualityTier = outcomes.partialSuccess.effect.qualityTier || "poor";
  outcomes.partialSuccess.additionalEffects = Array.isArray(outcomes.partialSuccess.additionalEffects)
    ? outcomes.partialSuccess.additionalEffects.map(normalizePartialEffect)
    : [];

  outcomes.criticalSuccess = outcomes.criticalSuccess ?? {};
  outcomes.criticalSuccess.enabled = Boolean(outcomes.criticalSuccess.enabled);
  outcomes.criticalSuccess.trigger = typeof outcomes.criticalSuccess.trigger === "object" && outcomes.criticalSuccess.trigger
    ? outcomes.criticalSuccess.trigger
    : { type: outcomes.criticalSuccess.trigger || "nat20" };
  const criticalSuccessTriggerTypes = new Set(CRITICAL_SUCCESS_TRIGGER_OPTIONS.map((option) => option.value));
  outcomes.criticalSuccess.trigger.type = criticalSuccessTriggerTypes.has(outcomes.criticalSuccess.trigger.type)
    ? outcomes.criticalSuccess.trigger.type
    : "nat20";
  outcomes.criticalSuccess.trigger.threshold = getNumberValue(outcomes.criticalSuccess.trigger.threshold, 20);
  outcomes.criticalSuccess.effects = Array.isArray(outcomes.criticalSuccess.effects)
    ? outcomes.criticalSuccess.effects
    : [];

  outcomes.criticalFailure = outcomes.criticalFailure ?? {};
  outcomes.criticalFailure.enabled = Boolean(outcomes.criticalFailure.enabled);
  outcomes.criticalFailure.trigger = typeof outcomes.criticalFailure.trigger === "object" && outcomes.criticalFailure.trigger
    ? outcomes.criticalFailure.trigger
    : { type: outcomes.criticalFailure.trigger || "nat1" };
  const criticalFailureTriggerTypes = new Set(CRITICAL_FAILURE_TRIGGER_OPTIONS.map((option) => option.value));
  outcomes.criticalFailure.trigger.type = criticalFailureTriggerTypes.has(outcomes.criticalFailure.trigger.type)
    ? outcomes.criticalFailure.trigger.type
    : "nat1";
  outcomes.criticalFailure.trigger.threshold = getNumberValue(outcomes.criticalFailure.trigger.threshold, 5);
  outcomes.criticalFailure.effect = typeof outcomes.criticalFailure.effect === "object" && outcomes.criticalFailure.effect
    ? outcomes.criticalFailure.effect
    : { type: outcomes.criticalFailure.effect || "gmDecision" };
  const criticalFailureTypes = new Set(CRITICAL_FAILURE_EFFECT_OPTIONS.map((option) => option.value));
  outcomes.criticalFailure.effect.type = criticalFailureTypes.has(outcomes.criticalFailure.effect.type)
    ? outcomes.criticalFailure.effect.type
    : "gmDecision";
  outcomes.criticalFailure.effect.macroUuid = String(outcomes.criticalFailure.effect.macroUuid ?? "").trim();
  outcomes.criticalFailure.results = Array.isArray(outcomes.criticalFailure.results)
    ? outcomes.criticalFailure.results
    : [];

  return outcomes;
}

function buildOutcomesFromLegacyFailure(recipe, failure) {
  const failureResult = normalizeOutcomeResult({
    ...(failure.failureItem ?? {}),
    quantity: 1,
    chance: 100
  });
  const criticalEffects = [];
  if (failure.criticalSuccess?.doubleOutput) criticalEffects.push({ type: "doubleOutput" });
  if (failure.criticalSuccess?.noGoldCost) criticalEffects.push({ type: "noGoldCost" });
  if (failure.criticalSuccess?.reduceTimeHalf) criticalEffects.push({ type: "reduceTime", multiplier: 0.5 });
  if (failure.criticalSuccess?.createBonusItem) criticalEffects.push({ type: "bonusItem", item: null });

  return {
    failure: {
      type: failure.type || "loseAllIngredients",
      results: failureResult ? [failureResult] : [],
      flavorText: recipe.failure || DEFAULT_OUTCOMES.failure.flavorText,
      macroUuid: ""
    },
    partialSuccess: {
      enabled: Boolean(failure.partialSuccess?.enabled),
      missBy: Math.max(1, Number(failure.partialSuccess?.missBy ?? 2)),
      effect: {
        type: failure.partialSuccess?.effect || "gmDecision",
        qualityTier: "poor"
      },
      additionalEffects: []
    },
    criticalSuccess: {
      enabled: Boolean(failure.criticalSuccess?.enabled),
      trigger: {
        type: "nat20"
      },
      effects: criticalEffects
    }
  };
}

function normalizeOutcomeResult(entry) {
  const name = String(entry?.name ?? "").trim();
  const uuid = String(entry?.uuid ?? "").trim();
  if (!name && !uuid) return null;
  const quantity = getNumberValue(entry.quantity, 1);
  const chance = getNumberValue(entry.chance, 100);
  const result = {
    quantity: Math.max(1, quantity),
    chance: Math.max(0, Math.min(100, chance))
  };
  if (name) result.name = name;
  if (uuid) result.uuid = uuid;
  if (entry?.img) result.img = entry.img;
  return result;
}

function prepareOutcomeViewData(outcomes, recipe = {}) {
  const data = foundry.utils.deepClone(outcomes);
  const dc = Number(recipe.dc ?? 12);
  data.failure.results = data.failure.results.map((result) => prepareOutcomeResult(result));
  data.failure.typeOptions = buildSelectOptions(FAILURE_RULE_OPTIONS, data.failure.type);
  data.failure.typeLabel = getOptionLabel(FAILURE_RULE_OPTIONS, data.failure.type);
  data.failure.meta = getFailureRuleMeta(data.failure.type);
  data.failure.canCreateResults = data.failure.type === "createFailureItem";
  data.failure.summary = game.i18n.format("CRAFTINGTABLE.Outcome.FailureSummary", { effect: data.failure.meta.chipLabel });
  data.failure.chipLabel = data.failure.meta.chipLabel;
  data.failure.iconClass = data.failure.meta.iconClass;
  data.failure.severityClass = data.failure.meta.severityClass;
  data.failure.infoText = getFailureInfoText(data.failure.type);
  data.failure.isCustomMacro = data.failure.type === "customMacro";
  data.failure.macroOptions = buildMacroSelectOptions(data.failure.macroUuid);

  data.partialSuccess.effectOptions = buildSelectOptions(PARTIAL_EFFECT_OPTIONS, data.partialSuccess.effect.type);
  data.partialSuccess.qualityTierOptions = buildSelectOptions(QUALITY_TIER_OPTIONS, data.partialSuccess.effect.qualityTier);
  data.partialSuccess.effectLabel = getOptionLabel(PARTIAL_EFFECT_OPTIONS, data.partialSuccess.effect.type);
  data.partialSuccess.qualityTierLabel = getOptionLabel(QUALITY_TIER_OPTIONS, data.partialSuccess.effect.qualityTier);
  data.partialSuccess.effectMeta = getPartialEffectMeta(data.partialSuccess.effect.type);
  data.partialSuccess.effectIconClass = data.partialSuccess.effectMeta.iconClass;
  data.partialSuccess.isReducedQuality = data.partialSuccess.effect.type === "reducedQuality";
  data.partialSuccess.additionalEffects = data.partialSuccess.additionalEffects.map((effect) => prepareOutcomeEffect(effect, "partialSuccess"));
  data.partialSuccess.additionalEffectCount = data.partialSuccess.additionalEffects.length;
  data.partialSuccess.hasAdditionalEffects = data.partialSuccess.additionalEffectCount > 0;
  const partialMissLabel = game.i18n.format("CRAFTINGTABLE.Outcome.MissBy", { value: data.partialSuccess.missBy });
  const partialExtraLabel = data.partialSuccess.additionalEffects.length
    ? " + " + game.i18n.format("CRAFTINGTABLE.Outcome.Extra", { count: data.partialSuccess.additionalEffects.length })
    : "";
  data.partialSuccess.summary = data.partialSuccess.enabled
    ? partialMissLabel + " -> " + data.partialSuccess.effectLabel + partialExtraLabel
    : game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled");
  data.partialSuccess.exampleText = data.partialSuccess.enabled
    ? game.i18n.format("CRAFTINGTABLE.Outcome.TriggerRange", { min: Math.max(1, dc - data.partialSuccess.missBy), max: Math.max(1, dc - 1) }) + " -> " + getPartialSuccessResultText(data.partialSuccess)
    : game.i18n.localize("CRAFTINGTABLE.Outcome.PartialDisabled");
  data.partialSuccess.chips = data.partialSuccess.enabled
    ? [
      { iconClass: "fas fa-balance-scale", label: partialMissLabel, tone: "is-info" },
      { iconClass: data.partialSuccess.effectIconClass, label: data.partialSuccess.effectLabel, tone: "is-neutral" }
    ]
    : [{ iconClass: "fas fa-ban", label: game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled"), tone: "is-muted" }];
  if (data.partialSuccess.additionalEffectCount) {
    data.partialSuccess.chips.push({ iconClass: "fas fa-layer-group", label: game.i18n.format("CRAFTINGTABLE.Outcome.Extra", { count: data.partialSuccess.additionalEffectCount }), tone: "is-info" });
  }

  data.criticalSuccess.triggerOptions = buildSelectOptions(CRITICAL_SUCCESS_TRIGGER_OPTIONS, data.criticalSuccess.trigger.type);
  data.criticalSuccess.isCustomTrigger = data.criticalSuccess.trigger.type === "custom";
  data.criticalSuccess.triggerLabel = data.criticalSuccess.isCustomTrigger
    ? game.i18n.format("CRAFTINGTABLE.Outcome.TotalAtLeast", { value: data.criticalSuccess.trigger.threshold })
    : getOptionLabel(CRITICAL_SUCCESS_TRIGGER_OPTIONS, data.criticalSuccess.trigger.type);
  data.criticalSuccess.triggerIconClass = getCriticalSuccessTriggerIcon(data.criticalSuccess.trigger.type);
  data.criticalSuccess.effects = data.criticalSuccess.effects.map((effect) => prepareOutcomeEffect(effect, "criticalSuccess"));
  data.criticalSuccess.effectCount = data.criticalSuccess.effects.length;
  data.criticalSuccess.hasEffects = data.criticalSuccess.effectCount > 0;
  data.criticalSuccess.summary = data.criticalSuccess.enabled
    ? summarizeOutcomeEffects(data.criticalSuccess.effects)
    : game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled");
  data.criticalSuccess.exampleText = data.criticalSuccess.enabled
    ? `${data.criticalSuccess.triggerLabel} -> ${summarizeOutcomeEffects(data.criticalSuccess.effects)}`
    : game.i18n.localize("CRAFTINGTABLE.Outcome.CriticalSuccessDisabled");
  data.criticalSuccess.chips = data.criticalSuccess.enabled
    ? buildCriticalSuccessChips(data.criticalSuccess)
    : [{ iconClass: "fas fa-ban", label: game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled"), tone: "is-muted" }];

  data.criticalFailure.triggerOptions = buildSelectOptions(CRITICAL_FAILURE_TRIGGER_OPTIONS, data.criticalFailure.trigger.type);
  data.criticalFailure.effectOptions = buildSelectOptions(CRITICAL_FAILURE_EFFECT_OPTIONS, data.criticalFailure.effect.type);
  data.criticalFailure.isCustomTrigger = data.criticalFailure.trigger.type === "custom";
  data.criticalFailure.triggerLabel = data.criticalFailure.isCustomTrigger
    ? game.i18n.format("CRAFTINGTABLE.Outcome.TotalAtMost", { value: data.criticalFailure.trigger.threshold })
    : getOptionLabel(CRITICAL_FAILURE_TRIGGER_OPTIONS, data.criticalFailure.trigger.type);
  data.criticalFailure.effectLabel = getOptionLabel(CRITICAL_FAILURE_EFFECT_OPTIONS, data.criticalFailure.effect.type);
  data.criticalFailure.triggerIconClass = getCriticalFailureTriggerIcon(data.criticalFailure.trigger.type);
  data.criticalFailure.effectMeta = getCriticalFailureEffectMeta(data.criticalFailure.effect.type);
  data.criticalFailure.effectIconClass = data.criticalFailure.effectMeta.iconClass;
  data.criticalFailure.isCustomMacro = data.criticalFailure.effect.type === "customMacro";
  data.criticalFailure.macroOptions = buildMacroSelectOptions(data.criticalFailure.effect.macroUuid);
  data.criticalFailure.results = data.criticalFailure.results.map((result) => prepareOutcomeResult(result));
  data.criticalFailure.resultCount = data.criticalFailure.results.length;
  data.criticalFailure.hasResults = data.criticalFailure.resultCount > 0;
  data.criticalFailure.summary = data.criticalFailure.enabled
    ? summarizeCriticalFailure(data.criticalFailure)
    : game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled");
  data.criticalFailure.exampleText = data.criticalFailure.enabled
    ? `${data.criticalFailure.triggerLabel} -> ${summarizeCriticalFailure(data.criticalFailure)}`
    : game.i18n.localize("CRAFTINGTABLE.Outcome.CriticalFailureDisabled");
  data.criticalFailure.chips = data.criticalFailure.enabled
    ? [
      { iconClass: data.criticalFailure.triggerIconClass, label: data.criticalFailure.triggerLabel, tone: "is-danger" },
      { iconClass: data.criticalFailure.effectIconClass, label: data.criticalFailure.effectLabel, tone: "is-neutral" }
    ]
    : [{ iconClass: "fas fa-ban", label: game.i18n.localize("CRAFTINGTABLE.Outcome.Disabled"), tone: "is-muted" }];
  if (data.criticalFailure.resultCount) {
    data.criticalFailure.chips.push({ iconClass: "fas fa-box-open", label: game.i18n.format("CRAFTINGTABLE.Outcome.ResultCount", { count: data.criticalFailure.resultCount }), tone: "is-danger" });
  }

  return data;
}

function prepareOutcomePreviewRecipe(recipe = {}, {
  recipeUuid = "draft",
  recipeName = game.i18n.localize("CRAFTINGTABLE.Preview.Title"),
  recipeImg = DEFAULT_RECIPE_ICON
} = {}) {
  const normalizedRecipe = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_RECIPE),
    recipe ?? {},
    { inplace: false }
  );
  const outcomes = prepareOutcomeViewData(normalizeOutcomesData(normalizedRecipe), normalizedRecipe);
  const resultEntries = getRecipeResults(normalizedRecipe);
  return {
    recipeUuid,
    recipeName,
    recipeImg,
    toolName: normalizedRecipe.toolName || ct("ui.anyAppropriateTool"),
    abilityLabel: CONFIG.DND5E?.abilities?.[normalizedRecipe.ability]?.label ?? String(normalizedRecipe.ability ?? "int").toUpperCase(),
    dc: Number(normalizedRecipe.dc ?? 10),
    time: normalizedRecipe.time || ct("ui.immediate"),
    costLabel: formatCurrencyCost(getRecipeCostData(normalizedRecipe)),
    proficiencyRequired: Boolean(normalizedRecipe.proficiencyRequired),
    resultCount: resultEntries.length,
    outcomes,
    failureResults: outcomes.failure.results,
    criticalFailureResults: outcomes.criticalFailure.results,
    partialEffects: outcomes.partialSuccess.additionalEffects,
    criticalSuccessEffects: outcomes.criticalSuccess.effects
  };
}

function prepareOutcomeResult(result = {}) {
  return {
    name: result.name || "",
    uuid: result.uuid || "",
    img: result.img || "icons/svg/item-bag.svg",
    quantity: Number(result.quantity ?? 1),
    chance: Number(result.chance ?? 100)
  };
}

function prepareOutcomeEffect(effect = {}, scope = "criticalSuccess") {
  const typeOptions = scope === "partialSuccess"
    ? PARTIAL_EFFECT_OPTIONS
    : CRITICAL_SUCCESS_EFFECT_OPTIONS;
  const item = prepareOutcomeResult(effect.item ?? {});
  const meta = scope === "partialSuccess"
    ? getPartialEffectMeta(effect.type)
    : getCriticalSuccessEffectMeta(effect.type);
  return {
    ...effect,
    label: meta.label,
    description: meta.description,
    iconClass: meta.iconClass,
    item,
    typeOptions: buildSelectOptions(typeOptions, effect.type),
    value: effect.multiplier ?? effect.value ?? "",
    conditions: effect.conditions ?? ""
  };
}

function getPartialEffectMeta(type) {
  const meta = {
    gmDecision: { label: "GM Decision", iconClass: "fas fa-dice-d20", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.GmPartial") },
    reducedOutput: { label: "Reduced Output", iconClass: "fas fa-compress-arrows-alt", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.ReducedOutput") },
    reducedQuality: { label: "Reduced Quality", iconClass: "fas fa-balance-scale", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.ReducedQuality") },
    increasedTime: { label: "Increased Time", iconClass: "fas fa-hourglass-half", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.IncreasedTime") },
    consumeExtraMaterials: { label: "Consume Extra Materials", iconClass: "fas fa-box-open", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.ExtraMaterials") },
    unstableItem: { label: "Unstable Item", iconClass: "fas fa-flask", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.Unstable") },
    weakerItem: { label: "Weaker Item", iconClass: "fas fa-arrow-down", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.Weaker") }
  };
  const entry = meta[type] ?? { label: titleCase(type || "effect"), iconClass: "fas fa-sliders-h", description: "" };
  return { ...entry, label: getOptionLabel(PARTIAL_EFFECT_OPTIONS, type) };
}

function getCriticalSuccessEffectMeta(type) {
  const meta = {
    doubleOutput: { label: "Double Output", iconClass: "fas fa-cubes", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.DoubleOutput") },
    noGoldCost: { label: "No Gold Cost", iconClass: "fas fa-coins", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.NoGold") },
    reduceTime: { label: "Reduce Time", iconClass: "fas fa-hourglass-half", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.ReduceTime") },
    bonusItem: { label: "Bonus Item", iconClass: "fas fa-gift", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.BonusItem") }
  };
  const entry = meta[type] ?? { label: titleCase(type || "effect"), iconClass: "fas fa-star", description: "" };
  return { ...entry, label: getOptionLabel(CRITICAL_SUCCESS_EFFECT_OPTIONS, type) };
}

function getCriticalFailureEffectMeta(type) {
  const meta = {
    createFailureItem: { label: "Create Failure Item", iconClass: "fas fa-flask", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.FailureItem") },

    destroyTool: { label: "Destroy Tool", iconClass: "fas fa-hammer", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.DestroyTool") },
    gmDecision: { label: "GM Decision", iconClass: "fas fa-dice-d20", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.GmCritical") },
    customMacro: { label: "Custom Macro", iconClass: "fas fa-scroll", description: game.i18n.localize("CRAFTINGTABLE.Outcome.Description.MacroCritical") }
  };
  const entry = meta[type] ?? { label: titleCase(type || "effect"), iconClass: "fas fa-fire", description: "" };
  return { ...entry, label: getOptionLabel(CRITICAL_FAILURE_EFFECT_OPTIONS, type) };
}

function getCriticalSuccessTriggerIcon(type) {
  const icons = {
    nat20: "fas fa-dice-d20",
    beatDcBy5: "fas fa-arrow-up",
    beatDcBy10: "fas fa-angle-double-up",
    custom: "fas fa-sliders-h"
  };
  return icons[type] ?? "fas fa-star";
}

function getCriticalFailureTriggerIcon(type) {
  const icons = {
    nat1: "fas fa-dice-d20",
    missDcBy10: "fas fa-angle-double-down",
    custom: "fas fa-sliders-h"
  };
  return icons[type] ?? "fas fa-fire";
}

function buildCriticalSuccessChips(criticalSuccess) {
  if (!criticalSuccess.effects.length) {
    return [{ iconClass: "fas fa-star", label: game.i18n.localize("CRAFTINGTABLE.Outcome.NoEffects"), tone: "is-muted" }];
  }
  return criticalSuccess.effects.slice(0, 3).map((effect) => ({
    iconClass: effect.iconClass,
    label: effect.label,
    tone: "is-good"
  }));
}

function summarizeOutcomeEffects(effects = []) {
  if (!effects.length) return game.i18n.localize("CRAFTINGTABLE.Outcome.NoEffectsConfigured");
  return effects.map((effect) => {
    if (effect.type === "bonusItem" && effect.item?.name) return game.i18n.format("CRAFTINGTABLE.Outcome.Bonus", { name: effect.item.name });
    return effect.label ?? titleCase(effect.type);
  }).join(" + ");
}

function summarizeCriticalFailure(criticalFailure) {
  const result = criticalFailure.results?.[0];
  if (result?.name) return result.chance && result.chance < 100
    ? `${result.name} (${result.chance}%)`
    : `${result.name}${criticalFailure.results.length > 1 ? ` + ${criticalFailure.results.length - 1} more` : ""}`;
  return criticalFailure.effectLabel || getOptionLabel(CRITICAL_FAILURE_EFFECT_OPTIONS, "gmDecision");
}

function getPartialSuccessResultText(partial) {
  if (partial.effect.type === "reducedQuality") return game.i18n.format("CRAFTINGTABLE.Outcome.QualityResult", { quality: partial.qualityTierLabel });
  return partial.effectLabel;
}

function getFailureInfoText(type) {
  const info = {
    noPenalty: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.NoPenalty"),
    loseAllIngredients: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.LoseAll"),
    loseHalfIngredients: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.LoseHalf"),
    createFailureItem: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.CreateFailure"),
    gmDecision: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.GmDecision"),
    customMacro: game.i18n.localize("CRAFTINGTABLE.Outcome.Info.CustomMacro")
  };
  return info[type] ?? info.gmDecision;
}

function getFailureRuleMeta(type) {
  const meta = FAILURE_RULE_META[type] ?? FAILURE_RULE_META.gmDecision;
  return { ...meta, chipLabel: getOptionLabel(FAILURE_RULE_OPTIONS, type) };
}

function getOptionLabel(options, value) {
  const option = options.find((entry) => entry.value === value);
  return option ? localizeOptionLabel(option) : titleCase(value);
}

function outcomesToFailureData(outcomes) {
  const failureResult = outcomes.failure?.results?.[0] ?? {};
  const criticalEffects = outcomes.criticalSuccess?.effects ?? [];
  return {
    type: outcomes.failure?.type || "loseAllIngredients",
    failureItem: {
      name: failureResult.name || "",
      uuid: failureResult.uuid || ""
    },
    partialSuccess: {
      enabled: Boolean(outcomes.partialSuccess?.enabled),
      missBy: Math.max(1, Number(outcomes.partialSuccess?.missBy ?? 2)),
      effect: outcomes.partialSuccess?.effect?.type || "gmDecision"
    },
    criticalSuccess: {
      enabled: Boolean(outcomes.criticalSuccess?.enabled),
      doubleOutput: criticalEffects.some((effect) => effect.type === "doubleOutput"),
      noGoldCost: criticalEffects.some((effect) => effect.type === "noGoldCost"),
      reduceTimeHalf: criticalEffects.some((effect) => effect.type === "reduceTime" && Number(effect.multiplier ?? 1) <= 0.5),
      createBonusItem: criticalEffects.some((effect) => effect.type === "bonusItem")
    }
  };
}

function normalizePermissionsData(recipe) {
  const permissions = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_RECIPE.permissions),
    {
      ...(recipe.permissions ?? {}),
      showToPlayers: recipe.showToPlayers !== false,
      },
    { inplace: false }
  );
  permissions.visibility = normalizePermissionVisibility(permissions.visibility, recipe);
  permissions.knowledgeSource = normalizeKnowledgeSource(permissions.knowledgeSource);
  permissions.craftPermission = normalizeCraftPermission(permissions.craftPermission);
  permissions.showToPlayers = permissions.visibility !== "hidden";
  delete permissions.allowLearning;
  delete permissions.allowDiscovery;
  return permissions;
}

function normalizeNotesData(recipe) {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_RECIPE.notes),
    recipe.notes ?? {},
    { inplace: false }
  );
}

function buildRecipeCopyData(sourceItem, { name = sourceItem.name, img = sourceItem.img, folderId = null, recipeData } = {}) {
  const data = sourceItem.toObject();
  delete data._id;
  data.name = getRecipeItemName(name);
  data.img = img || data.img || "icons/svg/item-bag.svg";
  if (folderId) data.folder = folderId;
  data.type = data.type || getRecipeItemType();
  data.system = data.system ?? {};
  data.system.description = data.system.description ?? {};

  const recipe = foundry.utils.mergeObject(
    getRecipeData(sourceItem),
    recipeData ?? {},
    { inplace: false }
  );
  recipe.isRecipe = true;
  recipe.recipeId ||= createRecipeId(() => foundry.utils.randomID(24));
  data.system.description.value = recipe.description ?? data.system.description.value ?? "";
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, {
    [MODULE_ID]: {
      [RECIPE_FLAG]: recipe
    }
  }, { inplace: false });
  return data;
}

function buildRecipeJsonExportPayload(items = [], { drafts = new Map() } = {}) {
  const recipes = [];
  const invalid = [];
  for (const item of items) {
    if (!item?.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) continue;
    const draft = drafts.get(item.uuid);
    const name = getRecipeDisplayName(draft?.itemName || item.name);
    const img = draft?.itemImg || item.img || DEFAULT_RECIPE_ICON;
    const recipe = normalizeRecipeData(draft?.recipe ?? item.getFlag(MODULE_ID, RECIPE_FLAG));
    const errors = validateRecipeData({ itemName: name, recipe });
    if (errors.length) {
      invalid.push({ uuid: item.uuid, name, errors });
      continue;
    }
    recipes.push({
      type: "Item",
      name,
      img,
      sourceRecipeUuid: item._isCraftingTableDraft ? "" : item.uuid,
      recipe
    });
  }
  return {
    format: "crafting-table-recipes",
    formatVersion: 1,
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? "",
    recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    recipes,
    invalid
  };
}

function buildRecipeItemData({ name, img = "icons/svg/item-bag.svg", folderId = null, recipeData } = {}) {
  const recipe = normalizeRecipeData(recipeData ?? {});
  recipe.recipeId ||= createRecipeId(() => foundry.utils.randomID(24));

  const data = {
    name: getRecipeItemName(name || getDefaultRecipeName()),
    type: getRecipeItemType(),
    img,
    system: {
      description: {
        value: recipe.description ?? ""
      }
    },
    flags: {
      [MODULE_ID]: {
        [RECIPE_FLAG]: recipe
      }
    }
  };
  if (folderId) data.folder = folderId;
  return data;
}

function createRecipeDraftItem({ name, img = DEFAULT_RECIPE_ICON, recipeData } = {}) {
  const data = buildRecipeItemData({ name, img, recipeData });
  const recipe = data.flags[MODULE_ID][RECIPE_FLAG];
  return {
    id: null,
    uuid: NEW_RECIPE_DRAFT_UUID,
    documentName: "Item",
    pack: null,
    name: data.name,
    img: data.img,
    type: data.type,
    system: data.system,
    flags: data.flags,
    _stats: { createdTime: Date.now(), modifiedTime: Date.now() },
    _isCraftingTableDraft: true,
    getFlag(scope, key) {
      if (scope === MODULE_ID && key === RECIPE_FLAG) return recipe;
      return this.flags?.[scope]?.[key];
    },
    toObject() {
      return foundry.utils.deepClone(data);
    }
  };
}

async function ensureRecipeItemReferences(recipe, { createMissing = true } = {}) {
  const next = normalizeRecipeData(recipe ?? {});
  const createdItems = [];
  const context = { createdItems, createMissing };
  try {
    next.ingredients = await ensureItemReferenceList(next.ingredients, { ...context, isIngredient: true });
    next.results = await ensureItemReferenceList(getRecipeResults(next), context);
    next.result = next.results[0] ?? null;

    const outcomes = normalizeOutcomesData(next);
    outcomes.failure.results = await ensureItemReferenceList(outcomes.failure?.results, context);
    outcomes.criticalFailure.results = await ensureItemReferenceList(outcomes.criticalFailure?.results, context);
    outcomes.partialSuccess.additionalEffects = await ensureOutcomeEffectReferences(outcomes.partialSuccess?.additionalEffects, context);
    outcomes.criticalSuccess.effects = await ensureOutcomeEffectReferences(outcomes.criticalSuccess?.effects, context);
    next.outcomes = outcomes;

    return { recipe: next, createdItems };
  } catch (error) {
    const rolledBack = await rollbackCreatedRecipeReferences(createdItems);
    if (!rolledBack && error && typeof error === "object") error.recipeReferenceRollbackIncomplete = true;
    throw error;
  }
}

async function rollbackCreatedRecipeReferences(createdItems = []) {
  const items = [...createdItems].reverse().filter((item) => item?.delete);
  if (!items.length) return true;
  const results = await Promise.allSettled(items.map((item) => item.delete({ render: false })));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    console.error(`${MODULE_ID} | Could not roll back automatically created recipe references`, failures.map((entry) => entry.reason));
  }
  return failures.length === 0;
}

async function ensureItemReferenceList(entries = [], context = {}) {
  const resolved = [];
  for (const entry of entries ?? []) {
    const item = await ensureItemReference(entry, context);
    if (item?.name || item?.uuid) resolved.push(item);
  }
  return resolved;
}

async function ensureOutcomeEffectReferences(effects = [], context = {}) {
  const resolved = [];
  for (const effect of effects ?? []) {
    const next = { ...effect };
    if (next.item) next.item = await ensureItemReference(next.item, context);
    resolved.push(next);
  }
  return resolved;
}

async function ensureItemReference(entry, { createdItems = [], isIngredient = false, createMissing = true } = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  const name = String(next.name ?? "").trim();
  if (isIngredient && getIngredientMatchMode(next) === "tag") return next;

  if (next.uuid) {
    const source = await safeFromUuid(next.uuid);
    return applyItemReferenceSource(next, source, { isIngredient });
  }

  if (!name) return next;

  const source = findCreatedItemByName(createdItems, name)
    ?? findWorldItemByName(name)
    ?? await findCompendiumItemByName(name);

  if (!source && !createMissing) return next;

  const resolvedSource = source ?? await createUncommonCraftingItem({ name, img: next.img, createdItems });

  return applyItemReferenceSource(next, resolvedSource, { isIngredient });
}

function applyItemReferenceSource(entry, source, { isIngredient = false } = {}) {
  const next = { ...entry };
  if (!source) return next;
  next.uuid = source.uuid;
  next.name = source.name || next.name;
  next.img = next.img || source.img || DEFAULT_RECIPE_ICON;
  if (isIngredient && !entry.matchMode) next.matchMode = "uuid";
  return next;
}

function findCreatedItemByName(items, name) {
  const normalized = normalizeName(name);
  return items.find((item) => normalizeName(item.name) === normalized) ?? null;
}

function findWorldItemByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return Array.from(game.items ?? []).find((item) => {
    if (item.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) return false;
    return normalizeName(item.name) === normalized;
  }) ?? null;
}

async function createUncommonCraftingItem({ name, img = DEFAULT_RECIPE_ICON, createdItems = [] } = {}) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName || typeof Item === "undefined" || typeof Item.create !== "function") return null;

  const item = await Item.create(buildAutoCraftingItemData({
    name: cleanName,
    img: img || DEFAULT_RECIPE_ICON
  }), { renderSheet: false });

  if (item) createdItems.push(item);
  return item;
}

function buildAutoCraftingItemData({ name, img = DEFAULT_RECIPE_ICON } = {}) {
  return {
    name,
    type: getRecipeItemType(),
    img,
    system: {
      description: {
        value: "<p>Automatically created by Crafting Table for recipe use.</p>"
      },
      quantity: 1,
      rarity: "uncommon"
    },
    flags: {
      [MODULE_ID]: {
        autoCreatedItem: true
      }
    }
  };
}

function getWorldRecipeItems() {
  return Array.from(game.items ?? []).filter((item) => item.getFlag(MODULE_ID, RECIPE_FLAG)?.isRecipe);
}

function worldRecipeMatchesSource(worldItem, sourceItem) {
  return recipeItemsShareIdentity(worldItem, getRecipeData(worldItem), sourceItem, getRecipeData(sourceItem));
}

async function exportRecipeItemToPack(item, pack) {
  return withUnlockedPack(pack, async () => {
    const match = await findMatchingRecipeInPack(item, pack);
    const data = buildRecipeCopyData(item, {
      name: item.name,
      recipeData: {
        ...getRecipeData(item),
        sourceRecipeUuid: item.uuid
      }
    });

    if (match) {
      const existing = await pack.getDocument(match._id);
      await existing.update(data);
      return existing;
    }

    const imported = await pack.importDocument(item);
    await imported.update({
      [`flags.${MODULE_ID}.${RECIPE_FLAG}`]: data.flags[MODULE_ID][RECIPE_FLAG],
      "system.description.value": data.system?.description?.value ?? "",
      img: data.img
    });
    return imported;
  });
}

async function findMatchingRecipeInPack(item, pack) {
  const sourceUuid = item.uuid;
  const index = await pack.getIndex({
    fields: [
      "name",
      `flags.${MODULE_ID}.${RECIPE_FLAG}.recipeId`,
      `flags.${MODULE_ID}.${RECIPE_FLAG}.sourceRecipeUuid`,
      "flags.core.sourceId"
    ]
  });

  return index.find((entry) => {
    const recipe = entry.flags?.[MODULE_ID]?.[RECIPE_FLAG] ?? {};
    const sourceId = entry.flags?.core?.sourceId;
    const sourceRecipeId = getRecipeData(item).recipeId;
    if (recipe.recipeId && sourceRecipeId) return recipe.recipeId === sourceRecipeId;
    return recipe.sourceRecipeUuid === sourceUuid || sourceId === sourceUuid;
  });
}

async function withUnlockedPack(pack, operation) {
  const wasLocked = Boolean(pack.locked);
  if (wasLocked) {
    if (typeof pack.configure !== "function") {
      throw new Error(`Compendium ${pack.collection} is locked and cannot be configured.`);
    }
    await pack.configure({ locked: false });
  }

  try {
    return await operation();
  } finally {
    if (wasLocked && typeof pack.configure === "function") {
      await pack.configure({ locked: true });
    }
  }
}

function getRecipeItemType() {
  const typeLabels = CONFIG.Item?.typeLabels ?? {};
  const dataModels = CONFIG.Item?.dataModels ?? {};
  if (typeLabels.loot || dataModels.loot) return "loot";
  if (typeLabels.equipment || dataModels.equipment) return "equipment";
  return "loot";
}

function collectRecipeFormData(form, currentRecipe, item = null) {
  const FormDataClass = foundry.applications?.ux?.FormDataExtended ?? FormData;
  const formData = new FormDataClass(form);
  const recipe = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_RECIPE),
    currentRecipe ?? {},
    { inplace: false }
  );

  recipe.isRecipe = true;
  recipe.category = getMaybeFormString(formData, "recipe.category", recipe.category);
  recipe.rarity = getMaybeFormString(formData, "recipe.rarity", recipe.rarity || "common");
  recipe.description = getMaybeOptionalFormString(formData, "recipe.description", recipe.description);
  applyToolChoiceToRecipe(recipe, formData);
  normalizeRecipeToolFields(recipe);
  recipe.ability = getMaybeFormString(formData, "recipe.ability", recipe.ability);
  recipe.dc = getMaybeFormNumber(formData, "recipe.dc", recipe.dc);
  recipe.proficiencyRequired = getMaybeCheckbox(form, "recipe.proficiencyRequired", Boolean(recipe.proficiencyRequired));
  recipe.timeValue = Math.max(1, getMaybeFormNumber(formData, "recipe.timeValue", recipe.timeValue || 1));
  recipe.timeUnit = getMaybeFormString(formData, "recipe.timeUnit", recipe.timeUnit || "hours");
  recipe.time = `${recipe.timeValue} ${recipe.timeUnit}`;
  recipe.costGp = Math.max(0, getMaybeFormNumber(formData, "recipe.costGp", recipe.costGp));
  recipe.costDenomination = getMaybeFormString(formData, "recipe.costDenomination", recipe.costDenomination || "gp");
  recipe.failure = getMaybeOptionalFormString(formData, "recipe.failure", recipe.failure);
  recipe.defaultMode = getMaybeFormString(formData, "recipe.defaultMode", recipe.defaultMode);
  recipe.showToPlayers = getMaybeCheckbox(form, "recipe.showToPlayers", recipe.showToPlayers !== false);
  recipe.ingredients = form.querySelector("[data-ingredient-list]") ? collectIngredientFormData(form) : (recipe.ingredients ?? []);
  recipe.results = form.querySelector("[data-result-list]") ? collectResultFormData(form) : getRecipeResults(recipe);
  recipe.result = recipe.results[0] ?? null;
  recipe.requirements = {
    tool: {
      name: recipe.toolName,
      uuid: recipe.toolUuid,
      key: recipe.toolKey
    },
    ability: recipe.ability,
    dc: recipe.dc,
    proficiencyRequired: recipe.proficiencyRequired,
    time: {
      value: recipe.timeValue,
      unit: recipe.timeUnit
    },
    cost: {
      value: recipe.costGp,
      denomination: recipe.costDenomination
    },
    defaultMode: recipe.defaultMode
  };
  recipe.outcomes = form.querySelector("[data-outcomes-editor]")
    ? collectOutcomesFormData(form, formData, recipe)
    : normalizeOutcomesData(recipe);
  recipe.failure = recipe.outcomes.failure?.flavorText ?? recipe.failure;
  recipe.failureData = formData.has("failure.type")
    ? collectFailureFormData(formData)
    : outcomesToFailureData(recipe.outcomes);
  recipe.permissions = formData.has("permissions.visibility") ? collectPermissionsFormData(formData, recipe) : normalizePermissionsData(recipe);
  recipe.showToPlayers = recipe.permissions.visibility !== "hidden";
  recipe.notes = formData.has("notes.player") || formData.has("notes.gm")
    ? {
      player: getOptionalFormString(formData, "notes.player"),
      gm: getOptionalFormString(formData, "notes.gm")
    }
    : normalizeNotesData(recipe);

  return {
    itemName: getRecipeDisplayName(getMaybeFormString(formData, "recipe.name", getRecipeDisplayName(item?.name) || getDefaultRecipeName())),
    itemImg: getMaybeFormString(formData, "recipe.img", item?.img || "icons/svg/item-bag.svg"),
    recipe: normalizeRecipeData(recipe)
  };
}

function applyToolChoiceToRecipe(recipe, formData) {
  const choice = getOptionalFormString(formData, "recipe.toolChoice");
  const customName = getOptionalFormString(formData, "recipe.customToolName");
  const currentName = getMaybeOptionalFormString(formData, "recipe.toolName", recipe.toolName);
  const currentUuid = getMaybeOptionalFormString(formData, "recipe.toolUuid", recipe.toolUuid);

  if (!choice) {
    recipe.toolName = currentName;
    recipe.toolUuid = currentUuid;
    recipe.toolKey = getRecipeToolKey(recipe);
    return;
  }

  if (choice === NO_TOOL_CHOICE) {
    clearRecipeToolRequirement(recipe);
    return;
  }

  if (choice === CUSTOM_TOOL_CHOICE) {
    recipe.toolName = customName || currentName || "Custom Tool";
    recipe.toolUuid = "";
    recipe.toolKey = findDnd5eToolKey(recipe.toolName);
    return;
  }

  if (choice === CURRENT_TOOL_CHOICE) {
    recipe.toolName = currentName;
    recipe.toolUuid = currentUuid;
    recipe.toolKey = getRecipeToolKey(recipe);
    return;
  }

  if (choice.startsWith("uuid:")) {
    const uuid = choice.slice(5);
    const option = cachedToolOptions?.find((tool) => tool.uuid === uuid);
    recipe.toolName = option?.name || currentName;
    recipe.toolUuid = uuid;
    recipe.toolKey = option?.key || findDnd5eToolKey(recipe.toolName, uuid);
    return;
  }

  if (choice.startsWith("key:")) {
    const key = choice.slice(4);
    const option = cachedToolOptions?.find((tool) => tool.key === key);
    recipe.toolName = option?.name || getToolLabel(key);
    recipe.toolUuid = option?.uuid || "";
    recipe.toolKey = key;
    return;
  }

  if (choice.startsWith("name:")) {
    recipe.toolName = choice.slice(5);
    recipe.toolUuid = "";
    recipe.toolKey = findDnd5eToolKey(recipe.toolName);
    return;
  }

  recipe.toolName = currentName;
  recipe.toolUuid = currentUuid;
  recipe.toolKey = getRecipeToolKey(recipe);
}

function collectIngredientFormData(form) {
  const rows = Array.from(form.querySelectorAll("[data-ingredient-row]"));
  return rows.reduce((ingredients, row) => {
    const name = String(row.querySelector("[name='ingredient.name']")?.value ?? "").trim();
    const uuid = String(row.querySelector("[name='ingredient.uuid']")?.value ?? "").trim();
    const img = String(row.querySelector("[name='ingredient.img']")?.value ?? "").trim();
    const type = normalizeIngredientType(row.querySelector("[name='ingredient.type']")?.value);
    const matchMode = String(row.querySelector("[name='ingredient.matchMode']")?.value ?? (uuid ? "uuid" : "name")).trim();
    if (!name && !uuid) return ingredients;

    const quantity = Math.max(1, getNumberValue(row.querySelector("[name='ingredient.quantity']")?.value, 1));
    const ingredient = {
      quantity,
      type,
      consumed: Boolean(row.querySelector("[name='ingredient.consumed']")?.checked),
      matchMode
    };
    if (name) ingredient.name = name;
    if (uuid) ingredient.uuid = uuid;
    if (img) ingredient.img = img;
    ingredients.push(ingredient);
    return ingredients;
  }, []);
}

function collectResultFormData(form) {
  const rows = Array.from(form.querySelectorAll("[data-result-row]"));
  return rows.reduce((results, row) => {
    const name = String(row.querySelector("[name='result.name']")?.value ?? "").trim();
    const uuid = String(row.querySelector("[name='result.uuid']")?.value ?? "").trim();
    const img = String(row.querySelector("[name='result.img']")?.value ?? "").trim();
    if (!name && !uuid) return results;

    const result = {
      quantity: Math.max(1, getNumberValue(row.querySelector("[name='result.quantity']")?.value, 1))
    };
    if (name) result.name = name;
    if (uuid) result.uuid = uuid;
    if (img) result.img = img;
    results.push(result);
    return results;
  }, []);
}

function collectFailureFormData(formData) {
  return {
    type: getFormString(formData, "failure.type", "loseAllIngredients"),
    failureItem: {
      name: getOptionalFormString(formData, "failure.itemName"),
      uuid: getOptionalFormString(formData, "failure.itemUuid")
    },
    partialSuccess: {
      enabled: formData.has("failure.partial.enabled"),
      missBy: Math.max(1, getFormNumber(formData, "failure.partial.missBy", 2)),
      effect: getFormString(formData, "failure.partial.effect", "gmDecision")
    },
    criticalSuccess: {
      enabled: formData.has("failure.critical.enabled"),
      doubleOutput: formData.has("failure.critical.doubleOutput"),
      noGoldCost: formData.has("failure.critical.noGoldCost"),
      reduceTimeHalf: formData.has("failure.critical.reduceTimeHalf"),
      createBonusItem: formData.has("failure.critical.createBonusItem")
    }
  };
}

function collectOutcomesFormData(form, formData, recipe) {
  const current = normalizeOutcomesData(recipe);
  const partialEffectType = getFormString(formData, "outcomes.partialSuccess.effect.type", current.partialSuccess.effect.type);

  return {
    success: current.success ?? {},
    failure: {
      type: getFormString(formData, "outcomes.failure.type", current.failure.type),
      results: collectOutcomeResultRows(form, "failure"),
      flavorText: getOptionalFormString(formData, "outcomes.failure.flavorText"),
      macroUuid: getOptionalFormString(formData, "outcomes.failure.macroUuid")
    },
    partialSuccess: {
      enabled: getMaybeCheckbox(form, "outcomes.partialSuccess.enabled", current.partialSuccess.enabled),
      missBy: Math.max(1, getFormNumber(formData, "outcomes.partialSuccess.missBy", current.partialSuccess.missBy)),
      effect: {
        type: partialEffectType,
        qualityTier: getFormString(formData, "outcomes.partialSuccess.effect.qualityTier", current.partialSuccess.effect.qualityTier || "poor")
      },
      additionalEffects: collectOutcomeEffectRows(form, "partialSuccess")
    },
    criticalSuccess: {
      enabled: getMaybeCheckbox(form, "outcomes.criticalSuccess.enabled", current.criticalSuccess.enabled),
      trigger: {
        type: getFormString(formData, "outcomes.criticalSuccess.trigger.type", current.criticalSuccess.trigger.type),
        threshold: getFormNumber(formData, "outcomes.criticalSuccess.trigger.threshold", current.criticalSuccess.trigger.threshold)
      },
      effects: collectOutcomeEffectRows(form, "criticalSuccess")
    },
    criticalFailure: {
      enabled: getMaybeCheckbox(form, "outcomes.criticalFailure.enabled", current.criticalFailure.enabled),
      trigger: {
        type: getFormString(formData, "outcomes.criticalFailure.trigger.type", current.criticalFailure.trigger.type),
        threshold: getFormNumber(formData, "outcomes.criticalFailure.trigger.threshold", current.criticalFailure.trigger.threshold)
      },
      effect: {
        type: getFormString(formData, "outcomes.criticalFailure.effect.type", current.criticalFailure.effect.type),
        macroUuid: getOptionalFormString(formData, "outcomes.criticalFailure.effect.macroUuid")
      },
      results: collectOutcomeResultRows(form, "criticalFailure")
    }
  };
}

function collectOutcomeResultRows(form, scope) {
  const rows = Array.from(form.querySelectorAll(`[data-outcome-results='${scope}'] [data-outcome-result-row]`));
  return rows.reduce((results, row) => {
    const result = normalizeOutcomeResult({
      name: row.querySelector("[name='outcome.result.name']")?.value,
      uuid: row.querySelector("[name='outcome.result.uuid']")?.value,
      img: row.querySelector("[name='outcome.result.img']")?.value,
      quantity: row.querySelector("[name='outcome.result.quantity']")?.value,
      chance: row.querySelector("[name='outcome.result.chance']")?.value
    });
    if (result) results.push(result);
    return results;
  }, []);
}

function collectOutcomeEffectRows(form, scope) {
  const rows = Array.from(form.querySelectorAll(`[data-outcome-effects='${scope}'] [data-outcome-effect-row]`));
  return rows.reduce((effects, row) => {
    const type = String(row.querySelector("[name='outcome.effect.type']")?.value ?? "").trim();
    if (!type) return effects;

    const value = String(row.querySelector("[name='outcome.effect.value']")?.value ?? "").trim();
    const conditions = String(row.querySelector("[name='outcome.effect.conditions']")?.value ?? "").trim();
    const item = normalizeOutcomeResult({
      name: row.querySelector("[name='outcome.effect.itemName']")?.value,
      uuid: row.querySelector("[name='outcome.effect.itemUuid']")?.value,
      img: row.querySelector("[name='outcome.effect.itemImg']")?.value,
      quantity: row.querySelector("[name='outcome.effect.itemQuantity']")?.value,
      chance: row.querySelector("[name='outcome.effect.itemChance']")?.value
    });
    const effect = { type };

    if (type === "reduceTime") {
      effect.multiplier = Math.max(0, getNumberValue(value || 0.5, 0.5));
    } else if (value) {
      effect.value = value;
    }
    if (conditions) effect.conditions = conditions;
    if (item) effect.item = item;
    effects.push(effect);
    return effects;
  }, []);
}

function collectPermissionsFormData(formData, recipe) {
  const visibility = normalizePermissionVisibility(getFormString(formData, "permissions.visibility", "visible"));
  const knowledgeSource = normalizeKnowledgeSource(getFormString(formData, "permissions.knowledgeSource", "globalUnlocked"));
  return {
    visibility,
    knowledgeSource,
    craftPermission: getFormString(formData, "permissions.craftPermission", "gmApprovalRequired"),
    showToPlayers: visibility !== "hidden",
  };
}

function getRecipeValidationErrors(itemName, recipe) {
  return validateRecipeData({
    itemName: getRecipeDisplayName(itemName),
    recipe: normalizeRecipeData(recipe)
  });
}

function normalizeImportedRecipeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const itemName = getRecipeDisplayName(entry.name || entry.itemName || game.i18n.localize("CRAFTINGTABLE.GM.ImportedRecipe"));
  const itemImg = String(entry.img ?? entry.itemImg ?? DEFAULT_RECIPE_ICON).trim() || DEFAULT_RECIPE_ICON;
  const rawRecipe = entry.recipe ?? entry.flags?.[MODULE_ID]?.[RECIPE_FLAG] ?? null;
  if (!rawRecipe || typeof rawRecipe !== "object") return null;
  const recipeData = normalizeRecipeData({
    ...rawRecipe,
    sourceRecipeUuid: entry.sourceRecipeUuid || rawRecipe.sourceRecipeUuid || ""
  });
  return {
    itemName,
    itemImg,
    sourceRecipeUuid: recipeData.sourceRecipeUuid || entry.sourceRecipeUuid || "",
    recipeData
  };
}

function validateRecipeItemDocument(item) {
  const recipe = getRecipeData(item);
  const errors = getRecipeValidationErrors(item?.name, recipe);
  return {
    recipe,
    errors,
    valid: errors.length === 0
  };
}

function validateRecipeData({ itemName, recipe, allowResolvableReferences = false }) {
  const errors = [];
  if (!String(itemName ?? "").trim()) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.MissingName"));
  if (!isValidRecipeId(recipe.recipeId)) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.InvalidRecipeId"));
  if (!String(recipe.category ?? "").trim()) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.MissingCategory"));
  if (!Array.isArray(recipe.results) || !recipe.results.length) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.MissingResult"));
  for (const result of recipe.results ?? []) {
    const name = result.name || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedResult");
    if (!String(result.uuid ?? "").trim() && !(allowResolvableReferences && String(result.name ?? "").trim())) {
      errors.push(game.i18n.format("CRAFTINGTABLE.Validation.ResultNoUuid", { name }));
    }
    if (Number(result.quantity) <= 0) errors.push(game.i18n.format("CRAFTINGTABLE.Validation.ResultQuantity", { name }));
  }
  for (const ingredient of recipe.ingredients ?? []) {
    const label = ingredient.name || ingredient.uuid || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedIngredient");
    if (!ingredient.uuid && !ingredient.matchMode) errors.push(game.i18n.format("CRAFTINGTABLE.Validation.IngredientNoReference", { name: label }));
    if (ingredient.matchMode === "uuid" && !ingredient.uuid && !(allowResolvableReferences && ingredient.name)) {
      errors.push(game.i18n.format("CRAFTINGTABLE.Validation.IngredientUuidMissing", { name: label }));
    }
    if (Number(ingredient.quantity) <= 0) errors.push(game.i18n.format("CRAFTINGTABLE.Validation.IngredientQuantity", { name: label }));
  }
  if (!Number.isFinite(Number(recipe.dc))) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.DcNumber"));
  if (Number(recipe.costGp) < 0) errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.CostNegative"));
  if (!Number.isFinite(Number(recipe.timeValue)) || Number(recipe.timeValue) <= 0 || !recipe.timeUnit) {
    errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.TimeEmpty"));
  }
  errors.push(...validateOutcomeData(recipe.outcomes ?? normalizeOutcomesData(recipe), { allowResolvableReferences }));
  return errors;
}

function validateOutcomeData(outcomes, { allowResolvableReferences = false } = {}) {
  const errors = [];
  const checkResults = (results, label) => {
    for (const result of results ?? []) {
      const name = result.name || result.uuid || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedOutcomeResult");
      if (!String(result.uuid ?? "").trim() && !(allowResolvableReferences && String(result.name ?? "").trim())) {
        errors.push(game.i18n.format("CRAFTINGTABLE.Validation.OutcomeNoUuid", { scope: label, name }));
      }
      if (!Number.isFinite(Number(result.quantity)) || Number(result.quantity) <= 0) {
        errors.push(game.i18n.format("CRAFTINGTABLE.Validation.OutcomeQuantity", { scope: label, name }));
      }
      if (!Number.isFinite(Number(result.chance)) || Number(result.chance) < 0 || Number(result.chance) > 100) {
        errors.push(game.i18n.format("CRAFTINGTABLE.Validation.OutcomeChance", { scope: label, name }));
      }
    }
  };
  const checkEffects = (effects, label) => {
    for (const effect of effects ?? []) {
      const effectName = getOptionLabel([...CRITICAL_SUCCESS_EFFECT_OPTIONS, ...PARTIAL_EFFECT_OPTIONS], effect.type);
      if (effect.type === "reduceTime" && (!Number.isFinite(Number(effect.multiplier)) || Number(effect.multiplier) <= 0)) {
        errors.push(game.i18n.format("CRAFTINGTABLE.Validation.EffectMultiplier", { scope: label, name: effectName }));
      }
      if (effect.item) checkResults([effect.item], `${label} — ${game.i18n.localize("CRAFTINGTABLE.GM.BonusItem")}`);
    }
  };

  if (!Number.isFinite(Number(outcomes.partialSuccess?.missBy)) || Number(outcomes.partialSuccess?.missBy) <= 0) {
    errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.PartialRange"));
  }
  if (outcomes.criticalSuccess?.trigger?.type === "custom" && !Number.isFinite(Number(outcomes.criticalSuccess.trigger.threshold))) {
    errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.CriticalSuccessTrigger"));
  }
  if (outcomes.criticalFailure?.trigger?.type === "custom" && !Number.isFinite(Number(outcomes.criticalFailure.trigger.threshold))) {
    errors.push(game.i18n.localize("CRAFTINGTABLE.Validation.CriticalFailureTrigger"));
  }
  const failureLabel = game.i18n.localize("CRAFTINGTABLE.GM.Failure");
  const partialLabel = game.i18n.localize("CRAFTINGTABLE.GM.PartialSuccess");
  const criticalSuccessLabel = game.i18n.localize("CRAFTINGTABLE.GM.CriticalSuccess");
  const criticalFailureLabel = game.i18n.localize("CRAFTINGTABLE.GM.CriticalFailure");
  if (outcomes.failure?.type === "createFailureItem") checkResults(outcomes.failure?.results, failureLabel);
  if (outcomes.failure?.type === "customMacro" && !String(outcomes.failure?.macroUuid ?? "").trim()) {
    errors.push(game.i18n.format("CRAFTINGTABLE.Validation.MacroRequired", { scope: failureLabel }));
  }
  if (outcomes.criticalFailure?.effect?.type === "createFailureItem") checkResults(outcomes.criticalFailure?.results, criticalFailureLabel);
  if (outcomes.criticalFailure?.effect?.type === "customMacro" && !String(outcomes.criticalFailure?.effect?.macroUuid ?? "").trim()) {
    errors.push(game.i18n.format("CRAFTINGTABLE.Validation.MacroRequired", { scope: criticalFailureLabel }));
  }
  checkEffects(outcomes.partialSuccess?.additionalEffects, partialLabel);
  checkEffects(outcomes.criticalSuccess?.effects, criticalSuccessLabel);
  return errors;
}

function getFormString(formData, key, fallback = "") {
  const value = String(formData.get(key) ?? "").trim();
  return value || fallback || "";
}

function getMaybeFormString(formData, key, fallback = "") {
  return formData.has(key) ? getFormString(formData, key, fallback) : fallback || "";
}

function getOptionalFormString(formData, key) {
  return String(formData.get(key) ?? "").trim();
}

function getMaybeOptionalFormString(formData, key, fallback = "") {
  return formData.has(key) ? getOptionalFormString(formData, key) : fallback || "";
}

function getFormNumber(formData, key, fallback = 0) {
  return getNumberValue(formData.get(key), fallback);
}

function getMaybeFormNumber(formData, key, fallback = 0) {
  return formData.has(key) ? getFormNumber(formData, key, fallback) : getNumberValue(fallback, 0);
}

function getMaybeCheckbox(form, key, fallback = false) {
  const field = Array.from(form.querySelectorAll("input[type='checkbox']")).find((input) => input.name === key);
  return field ? field.checked : Boolean(fallback);
}

function getNumberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback ?? 0);
}

function prepareGmIngredientRow(entry = {}) {
  const type = normalizeIngredientType(entry.type);
  const matchMode = entry.matchMode || (entry.uuid ? "uuid" : "name");
  return {
    uuid: entry.uuid || "",
    name: entry.name || "",
    quantity: Math.max(1, Number(entry.quantity ?? 1)),
    img: entry.img || "icons/svg/item-bag.svg",
    type,
    consumed: entry.consumed !== false,
    matchMode,
    typeOptions: buildSelectOptions(INGREDIENT_TYPE_OPTIONS, type),
    matchModeOptions: buildSelectOptions(MATCH_MODE_OPTIONS, matchMode)
  };
}

function prepareGmResultRow(entry = {}) {
  return {
    uuid: entry.uuid || "",
    name: entry.name || "",
    img: entry.img || "icons/svg/item-bag.svg",
    quantity: Math.max(1, Number(entry.quantity ?? 1))
  };
}

function replaceOutcomeChips(container, chips = []) {
  const ownerDocument = container?.ownerDocument;
  if (!ownerDocument?.createElement || !container?.replaceChildren) return false;
  const elements = chips.map((chip) => {
    const wrapper = ownerDocument.createElement("span");
    wrapper.className = `ctgm__outcome-chip ${chip.tone || ""}`.trim();
    const icon = ownerDocument.createElement("i");
    icon.className = chip.iconClass || "fas fa-circle";
    wrapper.append(icon, ownerDocument.createTextNode(` ${chip.label || ""}`));
    return wrapper;
  });
  container.replaceChildren(...elements);
  return true;
}

function buildCategoryOptions(currentCategory) {
  const categories = [...getAllCategoryOptions()];
  if (currentCategory && !categories.some((option) => option.value === currentCategory)) {
    categories.push({ value: currentCategory, label: titleCase(currentCategory) });
  }
  return buildSelectOptions(categories, currentCategory);
}

function localizeOptionLabel(option = {}) {
  if (option.i18nKey) return game.i18n.localize(option.i18nKey);
  return option.label ?? "";
}

function buildSelectOptions(options, selectedValue) {
  return options.map((option) => ({
    ...option,
    label: localizeOptionLabel(option),
    selected: option.value === selectedValue
  }));
}

function buildCleanSelectOptions(options, selectedValue) {
  return buildSelectOptions(options, selectedValue).map((option) => ({
    ...option,
    label: String(option.label ?? "").replace(/:\s*$/, "")
  }));
}

function buildMacroSelectOptions(selectedUuid = "") {
  const options = [{ value: "", label: game.i18n.localize("CRAFTINGTABLE.Outcome.SelectMacro") }];
  const macros = Array.from(globalThis.game?.macros ?? [])
    .filter((macro) => macro?.uuid)
    .sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));
  for (const macro of macros) options.push({ value: macro.uuid, label: macro.name || macro.uuid });
  return buildSelectOptions(options, selectedUuid);
}

async function buildToolSelectOptions(recipe = {}) {
  const current = {
    name: recipe.toolName ?? recipe.requirements?.tool?.name ?? "",
    uuid: recipe.toolUuid ?? recipe.requirements?.tool?.uuid ?? "",
    key: getRecipeToolKey(recipe)
  };
  const currentValue = getToolChoiceValue(current);
  const tools = await getCraftingToolSources();
  const options = [
    { value: NO_TOOL_CHOICE, label: game.i18n.localize("CRAFTINGTABLE.Outcome.NoTool"), selected: currentValue === NO_TOOL_CHOICE }
  ];
  let matchedCurrent = currentValue === NO_TOOL_CHOICE;

  for (const tool of tools) {
    const value = getToolChoiceValue(tool);
    const selected = value === currentValue;
    if (selected) matchedCurrent = true;
    options.push({
      value,
      label: tool.name,
      uuid: tool.uuid,
      key: tool.key,
      img: tool.img,
      selected
    });
  }

  if (!matchedCurrent && current.name) {
    options.push({
      value: CURRENT_TOOL_CHOICE,
      label: `${current.name} (${game.i18n.localize("CRAFTINGTABLE.Outcome.Current")})`,
      uuid: current.uuid,
      selected: true
    });
  }

  options.push({
    value: CUSTOM_TOOL_CHOICE,
    label: game.i18n.localize("CRAFTINGTABLE.Outcome.CustomTool"),
    selected: currentValue === CUSTOM_TOOL_CHOICE
  });

  return options;
}

async function getCraftingToolSources() {
  if (cachedToolOptions) return cachedToolOptions;
  const tools = [];
  const seen = new Set();

  for (const tool of await getToolsFromModuleCompendium()) {
    addToolSource(tools, seen, tool);
  }

  if (!tools.length) {
    for (const tool of await getToolsFromBundledData()) {
      addToolSource(tools, seen, tool);
    }
  }

  cachedToolOptions = tools.sort((left, right) => left.name.localeCompare(right.name));
  return cachedToolOptions;
}

async function getToolsFromModuleCompendium() {
  const pack = game.packs?.get?.(`${MODULE_ID}.tools`);
  if (!pack || pack.documentName !== "Item") return [];

  try {
    const index = await pack.getIndex({ fields: ["name", "img", "type"] });
    return index
      .filter((entry) => !entry.type || entry.type === "tool")
      .map((entry) => ({
        name: entry.name,
        img: entry.img,
        uuid: `Compendium.${pack.collection}.Item.${entry._id}`,
        key: findDnd5eToolKey(entry.name)
      }));
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read tools compendium`, error);
    return [];
  }
}

async function getToolsFromBundledData() {
  if (typeof fetch !== "function") return [];
  try {
    const response = await fetch(`modules/${MODULE_ID}/data/tools-index.json`);
    if (!response.ok) return [];
    const tools = await response.json();
    return Array.isArray(tools) ? tools.map((tool) => ({
      name: tool.name,
      img: tool.img,
      uuid: tool.uuid ?? "",
      key: tool.key ?? findDnd5eToolKey(tool.name, tool.uuid)
    })) : [];
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read bundled tools data`, error);
    return [];
  }
}

function addToolSource(tools, seen, tool) {
  const name = String(tool?.name ?? "").trim();
  if (!name) return;
  const key = normalizeName(tool.uuid || name);
  if (seen.has(key)) return;
  seen.add(key);
  tools.push({
    name,
    uuid: String(tool.uuid ?? "").trim(),
    key: String(tool.key ?? findDnd5eToolKey(name, tool.uuid) ?? "").trim(),
    img: tool.img || "icons/tools/smithing/anvil.webp"
  });
}

function getToolChoiceValue(tool = {}) {
  const name = String(tool.name ?? "").trim();
  const uuid = String(tool.uuid ?? "").trim();
  const key = String(tool.key ?? "").trim();
  if (isNoToolRequiredName(name)) return NO_TOOL_CHOICE;
  if (key) return `key:${key}`;
  if (uuid) return `uuid:${uuid}`;
  if (name) return `name:${name}`;
  return NO_TOOL_CHOICE;
}

function isNoToolRequiredName(name) {
  return ["no tool required", "none", "bez narzedzi", "bez narzędzi"].includes(normalizeName(name));
}

function buildAllSelectOptions(options, selectedValue, allLabel = "All") {
  return buildSelectOptions([{ value: "all", label: allLabel }, ...options], selectedValue || "all");
}

function getAllCategoryOptions() {
  const custom = getCustomCategories();
  const seen = new Set();
  return [...CATEGORY_OPTIONS, ...custom]
    .filter((option) => {
      if (!option?.value || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
}

function getCategoryOption(categoryId) {
  return getAllCategoryOptions().find((option) => option.value === categoryId) ?? null;
}

function getCategoryLabel(categoryId) {
  const option = getCategoryOption(categoryId);
  return option ? localizeOptionLabel(option) : titleCase(categoryId || "other");
}

function getCustomCategories() {
  if (typeof game === "undefined" || !game.settings?.settings?.has(`${MODULE_ID}.customCategories`)) return [];
  try {
    const raw = game.settings.get(MODULE_ID, "customCategories") || "[]";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeCategoryInput(entry?.label || entry?.value || entry?.id))
      .filter((entry) => entry?.id)
      .map((entry) => ({ value: entry.id, label: entry.label }));
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not parse custom categories`, error);
    return [];
  }
}

async function setCustomCategories(categories) {
  const defaults = new Set(CATEGORY_OPTIONS.map((option) => option.value));
  const seen = new Set();
  const data = categories
    .map((entry) => normalizeCategoryInput(entry?.label || entry?.value || entry?.id))
    .filter((entry) => entry?.id && !defaults.has(entry.id))
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => ({ id: entry.id, label: entry.label }));
  await game.settings.set(MODULE_ID, "customCategories", JSON.stringify(data));
}

async function addCustomCategory(category) {
  const current = getCustomCategories().map((entry) => ({ id: entry.value, label: entry.label }));
  if (!getCategoryOption(category.id)) current.push(category);
  await setCustomCategories(current);
}

async function replaceCustomCategory(oldId, nextCategory) {
  const current = getCustomCategories()
    .map((entry) => ({ id: entry.value, label: entry.label }))
    .filter((entry) => entry.id !== oldId && entry.id !== nextCategory.id);
  current.push(nextCategory);
  await setCustomCategories(current);
}

function normalizeCategoryInput(value) {
  const label = titleCase(String(value ?? "").trim()).replace(/\s+/g, " ");
  const id = slugifyCategoryId(label);
  if (!id) return null;
  return { id, label };
}

function slugifyCategoryId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizePermissionVisibility(value, recipe = null) {
  if (value === "hidden") return "hidden";
  if (recipe?.showToPlayers === false) return "hidden";
  return "visible";
}

function normalizeKnowledgeSource(value) {
  if (value === "toolProficiency") return "toolProficiency";
  if (value === "recipeItem") return "recipeItem";
  return "globalUnlocked";
}

function getWorldDefaultCraftingMode() {
  if (typeof game !== "undefined" && game.settings?.settings?.has(`${MODULE_ID}.defaultMode`)) {
    return normalizeCraftingMode(game.settings.get(MODULE_ID, "defaultMode"), DEFAULT_RECIPE.defaultMode);
  }
  return DEFAULT_RECIPE.defaultMode;
}

function normalizeCraftingMode(value, fallback = "automatic") {
  const mode = String(value ?? "").trim();
  const fallbackMode = String(fallback ?? "").trim();
  const allowed = new Set(MODE_OPTIONS.map((option) => option.value));
  if (allowed.has(mode)) return mode;
  return allowed.has(fallbackMode) ? fallbackMode : "automatic";
}

function getEffectiveCraftingMode(recipe = {}, fallbackMode = "automatic") {
  return normalizeCraftingMode(recipe.defaultMode ?? recipe.requirements?.defaultMode, fallbackMode);
}

function normalizeCraftPermission(value) {
  if (value === "anyPlayer") return "anyPlayer";
  if (value === "ownerOnly") return "ownerOnly";
  if (value === "gmOnly") return "gmOnly";
  return "gmApprovalRequired";
}

function normalizeIngredientType(value) {
  return value === "optional" ? "optional" : "required";
}

function isRecipeProficiencyRequired(recipe = {}) {
  return recipe.proficiencyRequired === true || recipe.requirements?.proficiencyRequired === true;
}

function getItemCraftingTags(item) {
  const values = [
    item?.type,
    item?.system?.identifier,
    item?.system?.type?.value,
    item?.system?.type?.baseItem,
    item?.getFlag?.(MODULE_ID, "tags"),
    item?.getFlag?.(MODULE_ID, "craftingTags")
  ];
  return values.flatMap((value) => normalizeTagValues(value)).filter(Boolean);
}

function normalizeTagValues(value) {
  if (!value) return [];
  if (value instanceof Set) return Array.from(value).flatMap((entry) => normalizeTagValues(entry));
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeTagValues(entry));
  if (typeof value === "object") return Object.entries(value)
    .filter(([, enabled]) => enabled === true || Number(enabled) > 0)
    .map(([key]) => key);
  return String(value).split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
}

function isRecipeVisibleToPlayers(recipe) {
  return normalizePermissionsData(recipe).visibility !== "hidden";
}

function getRecipeItemName(name) {
  const cleanName = getRecipeDisplayName(name) || getDefaultRecipeName();
  return `${RECIPE_NAME_PREFIX} ${cleanName}`;
}

function getDefaultRecipeName() {
  return game.i18n.localize("CRAFTINGTABLE.GM.NewRecipeName");
}

function getRecipeDisplayName(name) {
  return String(name ?? "")
    .trim()
    .replace(new RegExp(`^${escapeRegExp(RECIPE_NAME_PREFIX)}\\s*`, "i"), "")
    .trim();
}

function getRecipeCategoryFolderName(category) {
  const value = category || DEFAULT_RECIPE.category;
  return getCategoryOption(value)?.label ?? titleCase(value);
}

async function getOrCreateRecipeCategoryFolder(category) {
  const root = await getOrCreateItemFolder(RECIPE_FOLDER_NAME);
  if (!root) return null;
  return getOrCreateItemFolder(getRecipeCategoryFolderName(category), root.id);
}

async function getOrCreateItemFolder(name, parentId = null) {
  const folder = Array.from(game.folders ?? []).find((entry) => {
    if (entry.type !== "Item") return false;
    const parent = entry.folder?.id ?? entry.folder ?? entry.parent?.id ?? null;
    return entry.name === name && (parent || null) === (parentId || null);
  });
  if (folder) return folder;
  if (typeof Folder === "undefined" || typeof Folder.create !== "function") return null;

  return Folder.create({
    name,
    type: "Item",
    folder: parentId || null,
    sorting: "a"
  });
}

function getUniqueWorldItemName(baseName, { excludeItem = null } = {}) {
  const existingNames = new Set(Array.from(game.items ?? [])
    .filter((item) => item !== excludeItem && item.id !== excludeItem?.id && item.uuid !== excludeItem?.uuid)
    .map((item) => normalizeName(item.name)));
  const base = baseName || getRecipeItemName(getDefaultRecipeName());
  if (!existingNames.has(normalizeName(base))) return base;

  let index = 2;
  const cleanBase = getRecipeDisplayName(base);
  let nextName = getRecipeItemName(`${cleanBase} ${index}`);
  while (existingNames.has(normalizeName(nextName))) {
    index += 1;
    nextName = getRecipeItemName(`${cleanBase} ${index}`);
  }
  return nextName;
}

async function resolveRecipeIngredient(entry) {
  const source = await resolveItemSource(entry);
  const type = normalizeIngredientType(entry.type);
  const matchMode = entry.matchMode || (entry.uuid ? "uuid" : "name");
  return {
    uuid: entry.uuid || source?.uuid,
    name: entry.name || source?.name || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedIngredient"),
    quantity: Number(entry.quantity ?? 1),
    img: entry.img || source?.img || "icons/svg/item-bag.svg",
    type,
    consumed: entry.consumed !== false,
    matchMode,
    typeOptions: buildSelectOptions(INGREDIENT_TYPE_OPTIONS, type),
    matchModeOptions: buildSelectOptions(MATCH_MODE_OPTIONS, matchMode)
  };
}

async function resolveRecipeResult(entry) {
  if (!entry?.uuid && !entry?.name) {
    return { uuid: null, name: game.i18n.localize("CRAFTINGTABLE.GM.NoResult"), img: "icons/svg/mystery-man.svg", quantity: 0 };
  }

  const source = await resolveItemSource(entry);
  return {
    uuid: entry.uuid || source?.uuid,
    name: entry.name || source?.name || game.i18n.localize("CRAFTINGTABLE.Validation.UnnamedResult"),
    img: entry.img || source?.img || "icons/svg/item-bag.svg",
    quantity: Number(entry.quantity ?? 1)
  };
}

function buildGmCategories(recipes, activeCategory) {
  const counts = new Map();
  for (const recipe of recipes) counts.set(recipe.category, (counts.get(recipe.category) ?? 0) + 1);
  const knownIds = new Set(getAllCategoryOptions().map((option) => option.value));
  const categories = getAllCategoryOptions().map((option) => ({
    id: option.value,
    label: option.label,
    count: counts.get(option.value) ?? 0,
    active: activeCategory === option.value
  }));
  const extras = Array.from(counts.keys())
    .filter((id) => !knownIds.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      label: titleCase(id),
      count: counts.get(id) ?? 0,
      active: activeCategory === id
    }));

  if (activeCategory && activeCategory !== "all" && !knownIds.has(activeCategory) && !counts.has(activeCategory)) {
    extras.push({
      id: activeCategory,
      label: titleCase(activeCategory),
      count: 0,
      active: true
    });
  }

  return [...categories, ...extras];
}

function filterGmRecipes(recipes, category, search, filters = {}) {
  const normalizedSearch = normalizeName(search);
  return recipes.filter((recipe) => {
    if (category !== "all" && recipe.category !== category) return false;
    if (normalizedSearch && !normalizeName(recipe.name).includes(normalizedSearch)) return false;
    if (filters.rarity !== "all" && recipe.rarity !== filters.rarity) return false;
    if (filters.mode !== "all" && recipe.defaultMode !== filters.mode) return false;
    if (filters.time !== "any" && recipe.timeUnit !== filters.time) return false;
    return true;
  });
}

function sortGmRecipes(recipes, sortMode = "updated") {
  const sorted = [...recipes];
  sorted.sort((left, right) => {
    if (sortMode === "name") return compareText(left.name, right.name);
    if (sortMode === "rarity") return (left.rarityRank - right.rarityRank) || compareText(left.name, right.name);
    if (sortMode === "time") return (left.timeSort - right.timeSort) || compareText(left.name, right.name);
    if (sortMode === "cost") return (left.costSort - right.costSort) || compareText(left.name, right.name);
    return (right.updatedTime - left.updatedTime) || compareText(left.name, right.name);
  });
  return sorted;
}

function normalizeRecipeFilters(filters = {}) {
  return {
    rarity: filters.rarity || "all",
    mode: filters.mode || "all",
    time: filters.time || "any"
  };
}

function hasActiveRecipeFilters(filters = {}) {
  return filters.rarity !== "all" || filters.mode !== "all" || filters.time !== "any";
}

function buildPaginationData(currentPage, pageCount) {
  const pages = [];
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(pageCount, start + 4);
  for (let page = start; page <= end; page += 1) {
    pages.push({ page, active: page === currentPage });
  }
  return {
    currentPage,
    pageCount,
    pages,
    hasPages: pageCount > 1,
    canPrevious: currentPage > 1,
    canNext: currentPage < pageCount
  };
}

function getRarityRank(rarity) {
  const index = RARITY_OPTIONS.findIndex((option) => option.value === rarity);
  return index >= 0 ? index : RARITY_OPTIONS.length;
}

function getTimeSortValue(time = {}) {
  const multipliers = {
    minutes: 1,
    hours: 60,
    days: 1440,
    weeks: 10080
  };
  return Number(time.value ?? 0) * (multipliers[time.unit] ?? 60);
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base" });
}

function formatShortDateTime(timestamp) {
  const value = Number(timestamp ?? 0);
  if (!value) return "Unknown time";
  try {
    return new Date(value).toLocaleString();
  } catch (_error) {
    return "Unknown time";
  }
}

function summarizeRecipeSources(recipes) {
  const sources = new Set(recipes.map((recipe) => recipe.source));
  if (!sources.size) return "No recipe sources configured";
  return Array.from(sources).join(", ");
}

function getCraftingMessageRecipients(actor = null) {
  const recipients = new Set();
  if (game.user?.id) recipients.add(game.user.id);
  for (const user of game.users ?? []) {
    if (user?.isGM) recipients.add(user.id);
    else if (game.user?.isGM && actor?.testUserPermission?.(user, "OWNER")) recipients.add(user.id);
  }
  return Array.from(recipients).filter(Boolean);
}

async function createCraftingMessage({ actor = null, speaker = null, content = "", ...data } = {}) {
  return ChatMessage.create({
    ...data,
    speaker: speaker ?? ChatMessage.getSpeaker({ actor }),
    content,
    whisper: getCraftingMessageRecipients(actor)
  });
}
async function safeFromUuid(uuid) {
  if (!uuid) return null;
  try {
    return await foundry.utils.fromUuid(uuid);
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not load UUID ${uuid}`, error);
    return null;
  }
}

async function getItemFromDropEvent(event) {
  const textEditor = foundry.applications?.ux?.TextEditor;
  const data = textEditor?.getDragEventData?.(event) ?? parseDropData(event);
  const uuid = data?.uuid || data?.documentUuid;
  if (uuid) {
    const document = await safeFromUuid(uuid);
    if (document?.documentName === "Item") return document;
  }

  if (data?.type === "Item" && data.id) {
    const item = game.items?.get(data.id);
    if (item) return item;
  }

  if (data?.type === "Item" && data.actorId && data.data?._id) {
    const actor = game.actors?.get(data.actorId);
    const item = actor?.items?.get(data.data._id);
    if (item) return item;
  }

  return null;
}

async function promptForCraftingItem() {
  const choices = await collectCraftingItemChoices();
  if (!choices.length) {
    ui.notifications.warn(game.i18n.localize("CRAFTINGTABLE.GM.ItemPickerEmpty"));
    return null;
  }

  const options = choices.map((choice, index) => `
    <option value="${escapeHtml(choice.uuid)}" data-search="${escapeHtml(normalizeLooseName(`${choice.name} ${choice.type} ${choice.source}`))}" ${index === 0 ? "selected" : ""}>
      ${escapeHtml(choice.name)} — ${escapeHtml(choice.source)}
    </option>`).join("");
  const content = `
    <div class="ctgm-item-picker">
      <p>${escapeHtml(game.i18n.localize("CRAFTINGTABLE.GM.ItemPickerSource"))}</p>
      <label>${escapeHtml(game.i18n.localize("CRAFTINGTABLE.GM.ItemPickerSearch"))}
        <input type="search" name="itemSearch" autocomplete="off" autofocus>
      </label>
      <label>${escapeHtml(game.i18n.localize("CRAFTINGTABLE.GM.Item"))}
        <select name="itemUuid" size="12" required>${options}</select>
      </label>
    </div>`;
  const uuid = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("CRAFTINGTABLE.GM.ItemPickerTitle") },
    content,
    modal: true,
    rejectClose: false,
    render: (_event, dialog) => {
      const search = dialog.element?.querySelector?.("[name='itemSearch']");
      const select = dialog.element?.querySelector?.("[name='itemUuid']");
      search?.addEventListener?.("input", () => {
        const query = normalizeLooseName(search.value);
        let firstVisible = null;
        for (const option of select?.options ?? []) {
          const visible = !query || option.dataset.search.includes(query);
          option.hidden = !visible;
          if (visible && !firstVisible) firstVisible = option;
        }
        if (select?.selectedOptions?.[0]?.hidden && firstVisible) firstVisible.selected = true;
      });
    },
    ok: {
      label: game.i18n.localize("CRAFTINGTABLE.GM.SelectItem"),
      callback: (_event, button) => button.form.elements.itemUuid.value || null
    }
  });
  if (!uuid) return null;
  return choices.find((choice) => choice.uuid === uuid) ?? safeFromUuid(uuid);
}

async function collectCraftingItemChoices() {
  const choices = new Map();
  for (const item of game.items ?? []) {
    if (!item?.uuid || item.getFlag?.(MODULE_ID, RECIPE_FLAG)?.isRecipe) continue;
    choices.set(item.uuid, {
      uuid: item.uuid,
      name: item.name || game.i18n.localize("CRAFTINGTABLE.GM.Item"),
      img: item.img || DEFAULT_RECIPE_ICON,
      type: item.type || "",
      source: game.i18n.localize("CRAFTINGTABLE.GM.WorldItems")
    });
  }

  const packs = getItemLookupPacks();
  const indexes = await Promise.all(packs.map(async (pack) => ({
    pack,
    index: await pack.getIndex({ fields: ["name", "type", "img"] }).catch((error) => {
      console.warn(`${MODULE_ID} | Could not index Item picker pack ${pack.collection}`, error);
      return [];
    })
  })));
  for (const { pack, index } of indexes) {
    for (const entry of index ?? []) {
      const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
      if (!uuid || choices.has(uuid)) continue;
      choices.set(uuid, {
        uuid,
        name: entry.name || game.i18n.localize("CRAFTINGTABLE.GM.Item"),
        img: entry.img || DEFAULT_RECIPE_ICON,
        type: entry.type || "",
        source: pack.metadata?.label || pack.title || pack.collection
      });
    }
  }
  return Array.from(choices.values()).sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
}

function parseDropData(event) {
  try {
    return JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
  } catch {
    return {};
  }
}

async function resolveItemSource(entry) {
  if (entry?.uuid) {
    const source = await safeFromUuid(entry.uuid);
    if (source) return source;
  }

  if (!entry?.name) return null;
  return findCompendiumItemByName(entry.name);
}

async function findCompendiumItemByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;

  const packs = getItemLookupPacks();
  const cacheKey = `${normalized}|${packs.map((pack) => pack.collection).join(",")}`;
  if (itemNameLookupCache.has(cacheKey)) return itemNameLookupCache.get(cacheKey);

  const indexedPacks = await Promise.all(packs.map(async (pack) => ({
    pack,
    index: await pack.getIndex({ fields: ["name", "type", "img"] })
  })));
  for (const { pack, index } of indexedPacks) {
    const match = index.find((entry) => normalizeName(entry.name) === normalized);
    if (!match) continue;
    const summary = {
      id: match._id,
      uuid: match.uuid || `Compendium.${pack.collection}.Item.${match._id}`,
      name: match.name,
      type: match.type,
      img: match.img
    };
    itemNameLookupCache.set(cacheKey, summary);
    return summary;
  }

  itemNameLookupCache.set(cacheKey, null);
  return null;
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLooseName(value) {
  return normalizeName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function getToolLabel(key, data = {}) {
  const configTool = CONFIG.DND5E?.tools?.[key] ?? CONFIG.DND5E?.toolProficiencies?.[key];
  const label = data?.label ?? data?.name ?? configTool?.label ?? configTool?.name
    ?? (typeof configTool === "string" ? configTool : key);
  return localizeMaybe(label);
}

function getRecipeToolRequirementNames(recipe = {}) {
  const values = [
    recipe.toolName,
    recipe.toolUuid,
    recipe.requirements?.tool?.name,
    recipe.requirements?.tool?.uuid,
    recipe.toolKey,
    recipe.requirements?.tool?.key,
    recipe.requirements?.tool?.identifier
  ];

  for (const entry of recipe.tools ?? recipe.toolRequirements?.tools ?? recipe.requirements?.tools ?? []) {
    values.push(entry?.name, entry?.uuid, entry?.key, entry?.identifier);
  }

  if (values.some((value) => isNoToolRequiredName(value))) return [];

  return values
    .flatMap((value) => expandToolNameAliases(value))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function getRecipeToolKey(recipe = {}) {
  const explicit = String(recipe.toolKey ?? recipe.requirements?.tool?.key ?? recipe.requirements?.tool?.identifier ?? "").trim();
  if (explicit && CONFIG.DND5E?.tools?.[explicit]) return explicit;
  return findDnd5eToolKey(
    explicit,
    recipe.toolName,
    recipe.toolUuid,
    recipe.requirements?.tool?.name,
    recipe.requirements?.tool?.uuid
  );
}

function normalizeRecipeToolFields(recipe = {}) {
  if (hasExplicitEmptyToolRequirement(recipe)) {
    recipe.schemaVersion = Math.max(CURRENT_RECIPE_SCHEMA_VERSION, Number(recipe.schemaVersion ?? 0));
    return clearRecipeToolRequirement(recipe);
  }
  const toolKey = getRecipeToolKey(recipe);
  recipe.schemaVersion = Math.max(CURRENT_RECIPE_SCHEMA_VERSION, Number(recipe.schemaVersion ?? 0));
  recipe.toolKey = toolKey;
  if (String(recipe.toolUuid ?? "").startsWith(`Compendium.${MODULE_ID}.tools.`)) recipe.toolUuid = "";
  recipe.requirements = recipe.requirements ?? {};
  recipe.requirements.tool = {
    ...(recipe.requirements.tool ?? {}),
    name: recipe.toolName ?? recipe.requirements.tool?.name ?? "",
    uuid: recipe.toolUuid ?? recipe.requirements.tool?.uuid ?? "",
    key: toolKey
  };
  return recipe;
}

function findDnd5eToolKey(...values) {
  const candidates = values.flat().filter(Boolean);
  const tools = CONFIG.DND5E?.tools ?? {};
  for (const [key, config] of Object.entries(tools)) {
    const aliases = [key, config?.id, config?.label, config?.name, getToolLabel(key, config)].filter(Boolean);
    if (candidates.some((value) => aliases.some((alias) => toolNamesMatch(value, alias)))) return key;
  }
  return "";
}

function getActorToolProficiencyNames(actor) {
  const values = [];
  const tools = actor?.system?.tools ?? {};
  for (const [key, data] of Object.entries(tools)) {
    if (!toolHasProficiency(data)) continue;
    values.push(key, getToolLabel(key, data), data?.label, data?.name, data?.identifier, data?.slug, data?.key);
  }

  const toolProf = actor?.system?.traits?.toolProf ?? actor?.system?.traits?.toolProficiencies ?? {};
  values.push(...extractToolProficiencyValues(toolProf?.value));
  values.push(...extractToolProficiencyValues(toolProf?.custom));
  values.push(...extractToolProficiencyValues(toolProf?.choices));
  values.push(...extractToolProficiencyValues(actor?.system?.proficiencies?.tools));

  for (const item of actor?.items ?? []) {
    if (!isToolLikeItem(item)) continue;
    if (!toolHasProficiency(item.system ?? item)) continue;
    values.push(
      item.name,
      item.system?.identifier,
      item.system?.slug,
      item.system?.type?.baseItem,
      item.system?.type?.value,
      item.getFlag?.("core", "sourceId")
    );
  }

  return values
    .flatMap((value) => expandToolNameAliases(value))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function extractToolProficiencyValues(value) {
  if (!value) return [];
  if (value instanceof Set) return Array.from(value).flatMap((entry) => extractToolProficiencyValues(entry));
  if (Array.isArray(value)) return value.flatMap((entry) => extractToolProficiencyValues(entry));
  if (typeof value === "string") return value.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (entry === true) return [key];
      if (typeof entry === "string") return [key, entry];
      if (typeof entry !== "object" || !entry) return [];
      if (!toolHasProficiency(entry) && entry.value !== true && entry.proficient !== true) return [];
      return [key, entry.label, entry.name, entry.identifier, entry.slug];
    });
  }
  return [String(value)];
}

function expandToolNameAliases(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const localized = localizeMaybe(raw);
  const aliases = new Set([raw, localized]);
  const configTools = {
    ...(CONFIG.DND5E?.tools ?? {}),
    ...(CONFIG.DND5E?.toolProficiencies ?? {})
  };
  for (const [key, config] of Object.entries(configTools)) {
    const label = getToolLabel(key, config);
    const id = typeof config === "object" ? config.id : "";
    if (toolNamesMatch(raw, key) || toolNamesMatch(raw, label) || toolNamesMatch(raw, id) || toolNamesMatch(localized, label)) {
      aliases.add(key);
      aliases.add(label);
    }
  }
  for (const [group, members] of Object.entries(TOOL_PROFICIENCY_GROUPS)) {
    if (!toolNamesMatch(raw, group) && !toolNamesMatch(raw, getToolLabel(group))) continue;
    for (const member of members) aliases.add(member);
  }
  return Array.from(aliases).map((entry) => normalizeToolName(entry)).filter(Boolean);
}

function normalizeToolName(value) {
  return normalizeLooseName(value)
    .replace(/(?:tools?|supplies|utensils|kits?)$/g, "")
    .replace(/artisanstools/g, "")
    .replace(/toolproficiencies/g, "");
}

function localizeMaybe(value) {
  const label = typeof value === "object" ? value?.label ?? value?.name ?? "" : String(value ?? "");
  if (!label) return "";
  if (typeof game === "undefined" || typeof game.i18n?.localize !== "function") return label;
  return game.i18n.localize(label) || label;
}

function isToolLikeItem(item) {
  const type = String(item?.type ?? "").toLowerCase();
  if (type === "tool") return true;
  const identifier = String(item?.system?.identifier ?? item?.system?.type?.value ?? "").toLowerCase();
  return ["equipment", "loot"].includes(type) && /tool|suppl|utensil|kit/.test(`${identifier} ${item?.name ?? ""}`.toLowerCase());
}

function getRecipeDisplayIcon(itemIcon, resultIcon) {
  if (resultIcon && shouldUseResultIcon(itemIcon, resultIcon)) return resultIcon;
  return itemIcon || DEFAULT_RECIPE_ICON;
}

function shouldUseResultIcon(currentIcon, previousPrimaryIcon = null) {
  if (!currentIcon || isDefaultRecipeIcon(currentIcon)) return true;
  return Boolean(previousPrimaryIcon && iconsMatch(currentIcon, previousPrimaryIcon));
}

function isDefaultRecipeIcon(icon) {
  return iconsMatch(icon, DEFAULT_RECIPE_ICON);
}

function iconsMatch(left, right) {
  return normalizeIconPath(left) === normalizeIconPath(right);
}

function normalizeIconPath(value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  const match = text.match(/(?:^|\/)((?:icons|systems|modules|worlds)\/.+)$/);
  return match?.[1] ?? text;
}

function escapeHtml(value) {
  const element = document.createElement("textarea");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function localizeHtml(key, data = null) {
  const value = data ? game.i18n.format(key, data) : game.i18n.localize(key);
  return escapeHtml(value);
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}






const STAGE2_WORLD_DEFAULTS = {
  dcModifier: 0,
  timeMultiplier: 1,
  costMultiplier: 1
};

Hooks.once("init", () => {
  if (!game.settings.settings.has(`${MODULE_ID}.dcModifier`)) {
    game.settings.register(MODULE_ID, "dcModifier", {
      name: ct("setting.dcModifier.name"),
      hint: ct("setting.dcModifier.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: -20, max: 20, step: 1 },
      default: STAGE2_WORLD_DEFAULTS.dcModifier
    });
  }
  if (!game.settings.settings.has(`${MODULE_ID}.timeMultiplier`)) {
    game.settings.register(MODULE_ID, "timeMultiplier", {
      name: ct("setting.timeMultiplier.name"),
      hint: ct("setting.timeMultiplier.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0.25, max: 10, step: 0.25 },
      default: STAGE2_WORLD_DEFAULTS.timeMultiplier
    });
  }
  if (!game.settings.settings.has(`${MODULE_ID}.costMultiplier`)) {
    game.settings.register(MODULE_ID, "costMultiplier", {
      name: ct("setting.costMultiplier.name"),
      hint: ct("setting.costMultiplier.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 10, step: 0.25 },
      default: STAGE2_WORLD_DEFAULTS.costMultiplier
    });
  }
});

function getWorldCraftingModifiers() {
  if (typeof game === "undefined" || !game.settings?.settings) return { ...STAGE2_WORLD_DEFAULTS };
  const read = (key, fallback) => {
    if (!game.settings.settings.has(`${MODULE_ID}.${key}`)) return fallback;
    const value = Number(game.settings.get(MODULE_ID, key));
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    dcModifier: read("dcModifier", STAGE2_WORLD_DEFAULTS.dcModifier),
    timeMultiplier: Math.max(0.25, read("timeMultiplier", STAGE2_WORLD_DEFAULTS.timeMultiplier)),
    costMultiplier: Math.max(0, read("costMultiplier", STAGE2_WORLD_DEFAULTS.costMultiplier))
  };
}

function getAdjustedRecipeDc(recipe) {
  const base = Number(recipe?.dc ?? 10);
  return Math.max(0, Math.round((base + getWorldCraftingModifiers().dcModifier) * 100) / 100);
}

function getAdjustedRecipeWorkHours(recipe) {
  const base = Math.max(0, Number(getRecipeWorkHours(recipe) ?? 0));
  return Math.round(base * getWorldCraftingModifiers().timeMultiplier * 100) / 100;
}

function getAdjustedRecipeCostData(recipe) {
  const base = getRecipeCostData(recipe);
  return {
    value: Math.max(0, Math.round(Number(base.value ?? 0) * getWorldCraftingModifiers().costMultiplier * 100) / 100),
    denomination: base.denomination
  };
}

function formatCompactNumber(value) {
  const rounded = Math.round(Number(value ?? 0) * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`.replace(/0+$/, "").replace(/\.$/, "");
}

function getWorldAdjustmentLabels() {
  const modifiers = getWorldCraftingModifiers();
  const labels = [];
  if (modifiers.dcModifier) {
    const dcValue = modifiers.dcModifier > 0 ? `+${formatCompactNumber(modifiers.dcModifier)}` : formatCompactNumber(modifiers.dcModifier);
    labels.push(ct("world.dcAdjustment", { value: dcValue }));
  }
  if (Math.abs(modifiers.timeMultiplier - 1) > 0.001) labels.push(ct("world.timeAdjustment", { value: formatCompactNumber(modifiers.timeMultiplier) }));
  if (Math.abs(modifiers.costMultiplier - 1) > 0.001) labels.push(ct("world.costAdjustment", { value: formatCompactNumber(modifiers.costMultiplier) }));
  return labels;
}

function formatWorkHours(hours) {
  const value = Math.max(0, Number(hours ?? 0));
  if (value === 0) return `0 ${ct("time.hoursShort")}`;
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} ${ct("time.minutesShort")}`;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${ct("time.hoursShort")}`;
}




Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const toolName = "crafting-table-gm-open";
  const tool = {
    name: toolName,
    title: game.i18n.localize("CRAFTINGTABLE.OpenGmPanel"),
    icon: "fa-solid fa-hammer",
    button: true,
    visible: true,
    onChange: () => openCraftingGmPanel()
  };

  if (Array.isArray(controls)) {
    const target = controls.find((control) => ["token", "tokens"].includes(control.name)) ?? controls[0];
    if (!target) return;
    target.tools ??= [];
    if (Array.isArray(target.tools)) {
      if (!target.tools.some((existing) => existing.name === toolName)) target.tools.push(tool);
    } else {
      target.tools[toolName] ??= { ...tool, order: Object.keys(target.tools).length };
    }
    return;
  }

  const target = controls?.tokens ?? controls?.token ?? Object.values(controls ?? {})[0];
  if (!target) return;
  target.tools ??= {};
  if (Array.isArray(target.tools)) {
    if (!target.tools.some((existing) => existing.name === toolName)) target.tools.push(tool);
  } else {
    target.tools[toolName] ??= { ...tool, order: Object.keys(target.tools).length };
  }
});
