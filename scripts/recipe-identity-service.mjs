function normalizeText(value = "") {
  return String(value ?? "").trim();
}

function hashText(value) {
  const input = normalizeText(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeRecipeId(value) {
  return normalizeText(value);
}

export function isValidRecipeId(value) {
  return /^(?:recipe-[A-Za-z0-9_-]{8,}|legacy-[a-f0-9]{16})$/.test(normalizeRecipeId(value));
}

export function createRecipeId(createId = null) {
  const randomId = createId?.()
    ?? globalThis.foundry?.utils?.randomID?.(24)
    ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `recipe-${normalizeText(randomId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function deriveLegacyRecipeId({
  sourceRecipeUuid = "",
  sourceId = "",
  compendiumSource = "",
  documentUuid = "",
  legacyKey = ""
} = {}) {
  const source = [sourceRecipeUuid, sourceId, compendiumSource, documentUuid, legacyKey]
    .map(normalizeText)
    .find(Boolean);
  return source ? `legacy-${hashText(source)}` : "";
}

export function resolveRecipeId(reference = {}) {
  return normalizeRecipeId(reference.recipeId) || deriveLegacyRecipeId(reference);
}

export function recipeReferencesMatch(left = {}, right = {}) {
  const leftId = normalizeRecipeId(left.recipeId);
  const rightId = normalizeRecipeId(right.recipeId);
  if (leftId && rightId) return leftId === rightId;

  const leftUuid = normalizeText(left.recipeUuid ?? left.documentUuid);
  const rightUuid = normalizeText(right.recipeUuid ?? right.documentUuid);
  return Boolean(leftUuid && rightUuid && leftUuid === rightUuid);
}

export function replaceRecipeReferenceEntry(entries = [], reference = {}, replacement = null) {
  const list = Array.isArray(entries) ? entries : [];
  const filtered = list.filter((entry) => !recipeReferencesMatch(entry, reference));
  return replacement ? [...filtered, replacement] : filtered;
}

export function findLegacyRecipeMigrationMatch(entry = {}, candidates = []) {
  if (normalizeRecipeId(entry.recipeId)) return null;
  const recipeUuid = normalizeText(entry.recipeUuid);
  if (recipeUuid) {
    const uuidMatches = candidates.filter((candidate) => normalizeText(candidate.recipeUuid) === recipeUuid);
    if (uuidMatches.length === 1) return uuidMatches[0];
  }

  const recipeName = normalizeText(entry.recipeName).toLocaleLowerCase();
  if (!recipeName) return null;
  const totalHours = Number(entry.totalHours);
  const hasDuration = Number.isFinite(totalHours) && totalHours > 0;
  const nameMatches = candidates.filter((candidate) => {
    if (normalizeText(candidate.recipeName).toLocaleLowerCase() !== recipeName) return false;
    if (!hasDuration) return true;
    return Number(candidate.totalHours ?? 0) === totalHours;
  });
  return nameMatches.length === 1 ? nameMatches[0] : null;
}
