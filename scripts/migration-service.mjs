export async function runCraftingMigrations({
  moduleId = "crafting-table",
  currentVersion,
  recipeItems,
  actors,
  migrateRecipe,
  migrateActor,
  validateRecipe,
  getRecipeData
}) {
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return null;

  const installedVersion = Number(game.settings.get(moduleId, "migrationVersion") ?? 0);
  if (installedVersion >= currentVersion) return null;

  let recipeCount = 0;
  let requestActorCount = 0;
  let craftActorCount = 0;
  const failures = [];

  for (const item of recipeItems) {
    try {
      if (await migrateRecipe(item)) recipeCount += 1;
    } catch (error) {
      failures.push(error);
      console.warn(`${moduleId} | Could not migrate recipe item ${item?.name ?? item?.id ?? "unknown"}`, error);
    }
  }

  for (const actor of actors) {
    try {
      const result = await migrateActor(actor);
      if (result.requestsChanged) requestActorCount += 1;
      if (result.craftsChanged) craftActorCount += 1;
    } catch (error) {
      failures.push(error);
      console.warn(`${moduleId} | Could not migrate actor crafting flags for ${actor?.name ?? actor?.id ?? "unknown"}`, error);
    }
  }

  const invalidRecipes = recipeItems
    .map((item) => ({ item, errors: validateRecipe(item.name, getRecipeData(item)) }))
    .filter((entry) => entry.errors.length > 0);

  if (failures.length) {
    console.warn(`${moduleId} | Migration v${currentVersion} was not marked complete because ${failures.length} document(s) failed.`);
    return { complete: false, failures, invalidRecipes };
  }

  await game.settings.set(moduleId, "migrationVersion", currentVersion);
  console.info(`${moduleId} | Migration v${currentVersion} complete: ${recipeCount} recipe(s), ${requestActorCount} actor request set(s), and ${craftActorCount} ongoing craft set(s) updated.`);
  if (invalidRecipes.length) {
    console.debug(`${moduleId} | ${invalidRecipes.length} incomplete world recipe(s) remain after migration.`, invalidRecipes.map((entry) => ({ name: entry.item.name, errors: entry.errors })));
  }

  return {
    complete: true,
    recipeCount,
    requestActorCount,
    craftActorCount,
    invalidRecipes
  };
}
