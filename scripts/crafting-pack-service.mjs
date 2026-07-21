function toArray(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection).map((entry) => Array.isArray(entry) ? entry[1] : entry);
}

function normalizePackIdList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => normalizePackIdList(entry));
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return value ? [String(value).trim()].filter(Boolean) : [];
}

function uniquePackIds(packIds) {
  return [...new Set(packIds.filter(Boolean))];
}

export function getPublicPackageFlags(module, moduleId) {
  let objectData = null;
  try {
    objectData = typeof module?.toObject === "function" ? module.toObject() : null;
  } catch (_error) {
    objectData = null;
  }
  const candidates = [module, module?.manifest, module?.metadata, objectData];
  const merged = {};
  for (const candidate of candidates) {
    const flags = candidate?.flags?.[moduleId] ?? candidate?.flags?.["crafting-table"];
    if (flags && typeof flags === "object") Object.assign(merged, flags);
  }
  return merged;
}

export function createCraftingPackService({ moduleId, getGame = () => globalThis.game } = {}) {
  if (!moduleId) throw new Error("CraftingPackService requires moduleId.");

  const game = () => getGame() ?? {};
  const getAllPacks = () => toArray(game().packs);
  const getActiveModules = () => toArray(game().modules).filter((module) => module?.active);
  const getPack = (packId) => game().packs?.get?.(packId) ?? getAllPacks().find((pack) => pack?.collection === packId);
  const resolveItemPacks = (packIds) => uniquePackIds(packIds)
    .map((packId) => getPack(packId))
    .filter((pack) => pack?.documentName === "Item");

  function readSetting(key, fallback) {
    try {
      return game().settings?.get?.(moduleId, key) ?? fallback;
    } catch (_error) {
      return fallback;
    }
  }

  const getConfiguredRecipePackIds = () => normalizePackIdList(readSetting("recipeCompendiums", ""));
  const getConfiguredItemPackIds = () => normalizePackIdList(readSetting("itemCompendiums", ""));
  const isAutomaticRecipePackDiscoveryEnabled = () => Boolean(readSetting("useModuleRecipePacks", true));
  const isAutomaticItemPackDiscoveryEnabled = () => Boolean(readSetting("useModuleItemPacks", true));

  function getModuleDeclaredPackIds(flag) {
    return uniquePackIds(getActiveModules().flatMap((module) => normalizePackIdList(getPublicPackageFlags(module, moduleId)[flag])));
  }

  function getPackFlaggedRecipePackIds() {
    return getAllPacks()
      .filter((pack) => {
        const flags = pack.metadata?.flags?.[moduleId] ?? pack.metadata?.flags?.["crafting-table"] ?? {};
        return flags.recipePack === true || flags.type === "recipes" || flags.kind === "recipes";
      })
      .map((pack) => pack.collection)
      .filter(Boolean);
  }

  function getPackFlaggedItemPackIds() {
    return getAllPacks()
      .filter((pack) => {
        const flags = pack.metadata?.flags?.[moduleId] ?? pack.metadata?.flags?.["crafting-table"] ?? {};
        return flags.itemPack === true
          || ["items", "ingredients", "results"].includes(flags.type)
          || ["items", "ingredients", "results"].includes(flags.kind);
      })
      .map((pack) => pack.collection)
      .filter(Boolean);
  }

  function getAutomaticRecipePackIds() {
    if (!isAutomaticRecipePackDiscoveryEnabled()) return [];
    return uniquePackIds([
      ...getModuleDeclaredPackIds("recipePacks"),
      ...getPackFlaggedRecipePackIds()
    ]).filter((packId) => getPack(packId)?.documentName === "Item");
  }

  function getAutomaticItemPackIds() {
    if (!isAutomaticItemPackDiscoveryEnabled()) return [];
    return uniquePackIds([
      ...getModuleDeclaredPackIds("itemPacks"),
      ...getPackFlaggedItemPackIds()
    ]).filter((packId) => getPack(packId)?.documentName === "Item");
  }

  function getRecipePacks({ includeAutomatic = true } = {}) {
    const ids = includeAutomatic
      ? [...getConfiguredRecipePackIds(), ...getAutomaticRecipePackIds()]
      : getConfiguredRecipePackIds();
    return resolveItemPacks(ids);
  }

  const getPrimaryRecipePack = () => getRecipePacks({ includeAutomatic: false })[0] ?? null;
  const getRecipePackById = (packId) => {
    const pack = packId ? getPack(packId) : null;
    return pack?.documentName === "Item" ? pack : null;
  };

  function summarizeConfiguredRecipePacks() {
    const manual = getConfiguredRecipePackIds();
    const automatic = getAutomaticRecipePackIds();
    const parts = [];
    if (manual.length) parts.push(`Manual: ${manual.join(", ")}`);
    if (automatic.length) parts.push(`Automatic: ${automatic.join(", ")}`);
    return parts.length ? parts.join(" | ") : "No recipe compendiums configured";
  }

  function getDnd5eItemPacks() {
    return getAllPacks().filter((pack) => {
      if (pack?.documentName !== "Item") return false;
      const metadata = pack.metadata ?? {};
      return metadata.packageName === "dnd5e"
        || metadata.package === "dnd5e"
        || pack.collection?.startsWith("dnd5e.");
    });
  }

  function getItemLookupPacks() {
    const ids = [];
    if (Boolean(readSetting("useDnd5eItemCompendiums", true))) {
      ids.push(...getDnd5eItemPacks().map((pack) => pack.collection));
    }
    ids.push(...getConfiguredItemPackIds());
    ids.push(...getAutomaticItemPackIds());
    ids.push(...getRecipePacks().map((pack) => pack.collection));
    return resolveItemPacks(ids);
  }

  return Object.freeze({
    getAutomaticItemPackIds,
    getAutomaticRecipePackIds,
    getConfiguredItemPackIds,
    getConfiguredRecipePackIds,
    getDnd5eItemPacks,
    getItemLookupPacks,
    getPrimaryRecipePack,
    getRecipePackById,
    getRecipePacks,
    summarizeConfiguredRecipePacks
  });
}
