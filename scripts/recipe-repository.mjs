const DEFAULT_INDEX_FIELDS = Object.freeze([
  "name",
  "img",
  "type",
  "sort",
  "_stats.createdTime",
  "_stats.modifiedTime",
  "_stats.compendiumSource",
  "flags.core.sourceId"
]);

function toArray(collection) {
  return Array.from(collection ?? []);
}

function getRevision(item) {
  return String(item?._stats?.modifiedTime ?? item?._stats?.createdTime ?? item?.sort ?? "");
}

export function createIndexedRecipeItem({ pack, entry, moduleId, recipeFlag, defaultIcon }) {
  const recipe = entry.flags?.[moduleId]?.[recipeFlag] ?? {};
  const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
  return {
    id: entry._id,
    uuid,
    name: entry.name,
    img: entry.img || defaultIcon,
    type: entry.type,
    pack: pack.collection,
    sort: entry.sort ?? 0,
    _stats: entry._stats ?? {},
    system: {},
    _isCraftingTableIndexEntry: true,
    getFlag(scope, key) {
      if (scope === moduleId && key === recipeFlag) return recipe;
      if (scope === "core" && key === "sourceId") return entry.flags?.core?.sourceId;
      return entry.flags?.[scope]?.[key];
    }
  };
}

export function createRecipeRepository({
  moduleId,
  recipeFlag = "recipe",
  defaultIcon = "icons/svg/item-bag.svg",
  getRecipePacks,
  getWorldItems = () => [],
  fromUuid,
  logger = console
} = {}) {
  if (!moduleId) throw new Error("RecipeRepository requires moduleId.");
  if (typeof getRecipePacks !== "function") throw new Error("RecipeRepository requires getRecipePacks.");
  if (typeof fromUuid !== "function") throw new Error("RecipeRepository requires fromUuid.");

  const indexCache = new Map();
  const documentCache = new Map();
  const recipeField = `flags.${moduleId}.${recipeFlag}`;
  const indexFields = [...DEFAULT_INDEX_FIELDS, recipeField];

  async function getPackIndexItems(pack) {
    if (!pack || pack.documentName !== "Item" || !pack.collection) return [];
    const cacheKey = pack.collection;
    const cached = indexCache.get(cacheKey);
    if (cached?.items) return cached.items;
    if (cached?.promise) return cached.promise;

    const promise = Promise.resolve(pack.getIndex({ fields: indexFields }))
      .then((index) => toArray(index)
        .map((entry) => createIndexedRecipeItem({ pack, entry, moduleId, recipeFlag, defaultIcon }))
        .filter((item) => item.getFlag(moduleId, recipeFlag)?.isRecipe));
    indexCache.set(cacheKey, { promise });

    try {
      const items = await promise;
      if (indexCache.get(cacheKey)?.promise === promise) indexCache.set(cacheKey, { items });
      return items;
    } catch (error) {
      if (indexCache.get(cacheKey)?.promise === promise) indexCache.delete(cacheKey);
      logger.warn?.(`${moduleId} | Could not index recipe compendium ${cacheKey}`, error);
      throw error;
    }
  }

  async function listIndexedItems() {
    const packs = toArray(getRecipePacks()).filter((pack) => pack?.documentName === "Item");
    const groups = await Promise.all(packs.map((pack) => getPackIndexItems(pack)));
    return groups.flat();
  }

  async function listEntries({ includeWorldItems = false } = {}) {
    const entries = [];
    if (includeWorldItems) {
      for (const item of toArray(getWorldItems())) {
        if (item?.getFlag?.(moduleId, recipeFlag)?.isRecipe) entries.push({ item, source: "world", known: true });
      }
    }
    for (const item of await listIndexedItems()) {
      entries.push({ item, source: item.pack ?? "pack", known: true });
    }
    return entries;
  }

  async function resolveItem(itemOrUuid) {
    const item = typeof itemOrUuid === "string" ? null : itemOrUuid;
    const uuid = typeof itemOrUuid === "string" ? itemOrUuid : item?.uuid;
    if (!uuid) return item ?? null;
    if (item && !item._isCraftingTableIndexEntry) return item;

    const revision = getRevision(item);
    const cached = documentCache.get(uuid);
    if (cached && cached.revision === revision) return cached.document;

    const document = await fromUuid(uuid);
    if (!document) return null;
    documentCache.set(uuid, { document, revision, pack: item?.pack ?? document.pack ?? "" });
    return document;
  }

  async function resolveEntry(entry) {
    if (!entry?.item) return null;
    const item = await resolveItem(entry.item);
    return item ? { ...entry, item } : null;
  }

  async function findByRecipeId(recipeId, { localItems = [] } = {}) {
    if (!recipeId) return null;
    for (const item of toArray(localItems)) {
      if (item?.getFlag?.(moduleId, recipeFlag)?.recipeId === recipeId) return item;
    }
    const indexed = (await listIndexedItems())
      .find((item) => item.getFlag(moduleId, recipeFlag)?.recipeId === recipeId);
    return indexed ? resolveItem(indexed) : null;
  }

  function invalidatePack(packOrId) {
    const packId = typeof packOrId === "string" ? packOrId : packOrId?.collection;
    if (!packId) return;
    indexCache.delete(packId);
    for (const [uuid, cached] of documentCache) {
      if (cached.pack === packId || uuid.startsWith(`Compendium.${packId}.`)) documentCache.delete(uuid);
    }
  }

  function invalidateDocument(itemOrUuid) {
    const uuid = typeof itemOrUuid === "string" ? itemOrUuid : itemOrUuid?.uuid;
    if (uuid) documentCache.delete(uuid);
    const packId = typeof itemOrUuid === "object" ? itemOrUuid?.pack : "";
    if (packId) invalidatePack(packId);
  }

  function clear() {
    indexCache.clear();
    documentCache.clear();
  }

  return Object.freeze({
    clear,
    findByRecipeId,
    getPackIndexItems,
    invalidateDocument,
    invalidatePack,
    listEntries,
    listIndexedItems,
    resolveEntry,
    resolveItem
  });
}
