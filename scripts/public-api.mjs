export const CRAFTING_TABLE_API_VERSION = 1;
export const RECIPE_SCHEMA_VERSION = 5;

export const CRAFTING_TABLE_HOOKS = Object.freeze({
  preClassifyOutcome: "craftingTablePreClassifyOutcome",
  classifyOutcome: "craftingTableClassifyOutcome",
  resolveOutcome: "craftingTableResolveOutcome",
  outcomeQueued: "craftingTableOutcomeQueued",
  outcomeResolved: "craftingTableOutcomeResolved",
  preExecuteMacro: "craftingTablePreExecuteMacro",
  postExecuteMacro: "craftingTablePostExecuteMacro"
});

export function createCraftingTableApi({
  moduleId = "crafting-table",
  open,
  openGm,
  getDnd5eItemPacks,
  recipeFlagPath,
  defaultRecipe,
  clone,
  normalizeRecipe,
  createRecipeId,
  validateRecipe,
  rules,
  json
}) {
  const createDefaultRecipe = () => {
    const recipe = clone(defaultRecipe);
    recipe.recipeId = createRecipeId?.() ?? recipe.recipeId ?? "";
    return recipe;
  };
  const recipe = Object.freeze({
    schemaVersion: RECIPE_SCHEMA_VERSION,
    schemaPath: `modules/${moduleId}/data/recipe-schema-v5.json`,
    flagPath: recipeFlagPath,
    createDefault: createDefaultRecipe,
    normalize: normalizeRecipe,
    validate: validateRecipe
  });
  const frozenRules = Object.freeze({ ...rules });
  const frozenJson = Object.freeze({ ...json });

  return Object.freeze({
    apiVersion: CRAFTING_TABLE_API_VERSION,
    moduleId,
    hooks: CRAFTING_TABLE_HOOKS,
    recipe,
    rules: frozenRules,
    json: frozenJson,
    open,
    openGm,
    dnd5eItemPacks: getDnd5eItemPacks,
    recipeFlagPath,
    exampleRecipeData: createDefaultRecipe()
  });
}
