import { CRAFTING_TABLE_API_VERSION, CRAFTING_TABLE_HOOKS, RECIPE_SCHEMA_VERSION } from "./public-api.mjs";

async function resolveCraftingMacro(macroUuid) {
  const uuid = String(macroUuid ?? "").trim();
  if (!uuid) return null;

  try {
    const resolved = await foundry.utils.fromUuid?.(uuid);
    if (resolved?.documentName === "Macro") return resolved;
  } catch (error) {
    console.warn("crafting-table | Could not resolve crafting macro", uuid, error);
  }

  const id = uuid.split(".").pop();
  const worldMacro = globalThis.game?.macros?.get?.(id);
  return worldMacro?.documentName === "Macro" ? worldMacro : null;
}

export async function executeCraftingMacro({ macroUuid, actor, recipe, outcomeType, app, moduleId = "crafting-table", throwOnError = false }) {
  const macro = await resolveCraftingMacro(macroUuid);
  if (!macro) {
    ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.MacroMissing"));
    return false;
  }
  if (!macro.canExecute) {
    ui.notifications.error(game.i18n.format("CRAFTINGTABLE.Notify.MacroPermission", { macro: macro.name }));
    return false;
  }

  const token = actor?.getActiveTokens?.(true, true)?.[0] ?? null;
  const context = {
    actor,
    token,
    speaker: ChatMessage.getSpeaker({ actor, token }),
    recipe,
    outcomeType,
    craftingTable: {
      apiVersion: CRAFTING_TABLE_API_VERSION,
      recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
      moduleId,
      actorUuid: actor?.uuid ?? "",
      recipeId: recipe?.recipeId ?? "",
      recipeUuid: recipe?.uuid ?? "",
      recipeName: recipe?.name ?? "",
      dc: Number(recipe?.dc ?? 0),
      app
    }
  };

  Hooks.callAll(CRAFTING_TABLE_HOOKS.preExecuteMacro, context);
  try {
    const result = await macro.execute(context);
    if (result === false || result?.cancel === true) {
      ui.notifications.warn(game.i18n.format("CRAFTINGTABLE.Notify.MacroCancelled", { macro: macro.name }));
      return false;
    }
    Hooks.callAll(CRAFTING_TABLE_HOOKS.postExecuteMacro, { ...context, macro, result });
    return true;
  } catch (error) {
    console.error(`${moduleId} | Crafting macro ${macro.name} failed`, error);
    ui.notifications.error(game.i18n.format("CRAFTINGTABLE.Notify.MacroFailed", { macro: macro.name }));
    if (throwOnError) {
      const uncertain = new Error(`Crafting macro ${macro.name} failed after it started. GM review is required.`, { cause: error });
      uncertain.name = "CraftingMacroExecutionError";
      uncertain.code = "operation-pending-review";
      throw uncertain;
    }
    return false;
  }
}
