export function slugifyFileName(value = "") {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "recipes";
}

export function downloadCraftingRecipeJson(payload, filename = "crafting-table-recipes.json") {
  const text = JSON.stringify(payload, null, 2);
  if (typeof foundry.utils.saveDataToFile === "function") {
    foundry.utils.saveDataToFile(text, "application/json", filename);
    return;
  }

  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function promptForCraftingRecipeJsonImport({ moduleId = "crafting-table" } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(JSON.parse(await file.text()));
      } catch (error) {
        console.error(`${moduleId} | Could not read recipe JSON import`, error);
        ui.notifications.error(game.i18n.localize("CRAFTINGTABLE.Notify.JsonReadFailed"));
        resolve(null);
      }
    }, { once: true });
    input.click();
  });
}

export function extractRecipeImportEntries(data, { moduleId = "crafting-table", recipeFlag = "recipe" } = {}) {
  if (Array.isArray(data)) {
    return data.flatMap((entry) => extractRecipeImportEntries(entry, { moduleId, recipeFlag }));
  }
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.recipes)) return data.recipes;
  if (data.type === "Item" || data.recipe || data.flags?.[moduleId]?.[recipeFlag]) return [data];
  return [];
}
