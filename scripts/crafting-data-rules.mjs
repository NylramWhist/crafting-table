function normalizeText(value = "") {
  return String(value ?? "").trim();
}

function clampNumber(value, { min = 0, max = Number.POSITIVE_INFINITY, fallback = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeRequestStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return ["pending", "approved", "processing", "rejected", "completed"].includes(status) ? status : "pending";
}

function normalizePendingOutcomeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return ["pending", "resolved", "cancelled"].includes(status) ? status : "pending";
}

export function normalizeCraftRequestEntry(entry = {}, { actor = null, defaultIcon = "icons/svg/item-bag.svg" } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const recipeId = normalizeText(entry.recipeId);
  const recipeUuid = normalizeText(entry.recipeUuid);
  const recipeName = normalizeText(entry.recipeName);
  if (!recipeId && !recipeUuid && !recipeName) return null;

  const requestedAt = normalizeTimestamp(entry.requestedAt, normalizeTimestamp(entry.updatedTime, 0));
  const updatedTime = normalizeTimestamp(entry.updatedTime, requestedAt);
  const status = normalizeRequestStatus(entry.status);
  const actorUuid = normalizeText(entry.actorUuid || actor?.uuid);
  const actorName = normalizeText(entry.actorName || actor?.name) || "Unknown actor";
  const recipeImg = normalizeText(entry.recipeImg) || defaultIcon;
  const idBase = recipeId || recipeUuid || recipeName.replace(/\s+/g, "-").toLowerCase() || "request";

  return {
    id: normalizeText(entry.id) || `${idBase}-${requestedAt || updatedTime || 0}`,
    actorUuid,
    actorName,
    recipeId,
    recipeUuid,
    recipeName: recipeName || "Unknown recipe",
    recipeImg,
    status,
    decisionId: normalizeText(entry.decisionId),
    executionId: normalizeText(entry.executionId),
    requestedBy: normalizeText(entry.requestedBy),
    requestedByUserId: normalizeText(entry.requestedByUserId),
    decidedBy: normalizeText(entry.decidedBy),
    decidedByUserId: normalizeText(entry.decidedByUserId),
    completedAt: normalizeTimestamp(entry.completedAt, 0),
    progressPercent: clampNumber(entry.progressPercent, { min: 0, max: 100, fallback: 0 }),
    requestedAt,
    updatedTime
  };
}

export function normalizeCraftRequestList(entries = [], context = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeCraftRequestEntry(entry, context))
    .filter(Boolean);
}

export function normalizeOngoingCraftEntry(entry = {}, { defaultIcon = "icons/svg/item-bag.svg" } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const recipeId = normalizeText(entry.recipeId);
  const recipeUuid = normalizeText(entry.recipeUuid);
  const recipeName = normalizeText(entry.recipeName);
  if (!recipeId && !recipeUuid && !recipeName) return null;

  const totalHours = clampNumber(entry.totalHours, { min: 0, fallback: 0 });
  const workedHours = clampNumber(entry.workedHours, { min: 0, max: totalHours || Number.POSITIVE_INFINITY, fallback: 0 });
  const updatedTime = normalizeTimestamp(entry.updatedTime, 0);
  const recipeImg = normalizeText(entry.recipeImg) || defaultIcon;
  const idBase = recipeId || recipeUuid || recipeName.replace(/\s+/g, "-").toLowerCase() || "craft";
  const pendingOutcome = entry.pendingOutcome && typeof entry.pendingOutcome === "object" ? entry.pendingOutcome : null;

  return {
    id: normalizeText(entry.id) || `${idBase}-${updatedTime || 0}`,
    recipeId,
    recipeUuid,
    recipeName: recipeName || "Unknown recipe",
    recipeImg,
    workedHours,
    totalHours,
    pendingOutcome,
    updatedTime
  };
}

export function normalizeOngoingCraftList(entries = [], context = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeOngoingCraftEntry(entry, context))
    .filter(Boolean);
}

export function normalizePendingOutcomeEntry(entry = {}, { actor = null, defaultIcon = "icons/svg/item-bag.svg" } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const recipeId = normalizeText(entry.recipeId);
  const recipeUuid = normalizeText(entry.recipeUuid);
  const recipeName = normalizeText(entry.recipeName);
  if (!recipeId && !recipeUuid && !recipeName) return null;

  const createdAt = normalizeTimestamp(entry.createdAt, normalizeTimestamp(entry.updatedTime, 0));
  const updatedTime = normalizeTimestamp(entry.updatedTime, createdAt);
  const resolvedAt = normalizeTimestamp(entry.resolvedAt, 0);
  const status = normalizePendingOutcomeStatus(entry.status);
  const actorUuid = normalizeText(entry.actorUuid || actor?.uuid);
  const actorName = normalizeText(entry.actorName || actor?.name) || "Unknown actor";
  const recipeImg = normalizeText(entry.recipeImg) || defaultIcon;
  const idBase = recipeId || recipeUuid || recipeName.replace(/\s+/g, "-").toLowerCase() || "outcome";

  return {
    id: normalizeText(entry.id) || `${idBase}-${createdAt || updatedTime || 0}`,
    actorUuid,
    actorName,
    recipeId,
    recipeUuid,
    recipeRevision: normalizeText(entry.recipeRevision),
    recipeName: recipeName || "Unknown recipe",
    recipeImg,
    outcomeType: normalizeText(entry.outcomeType),
    optionalIngredientIndexes: Array.isArray(entry.optionalIngredientIndexes)
      ? [...new Set(entry.optionalIngredientIndexes.map(Number).filter(Number.isInteger))].sort((left, right) => left - right)
      : [],
    reason: normalizeText(entry.reason),
    status,
    requestId: normalizeText(entry.requestId),
    requestExecutionId: normalizeText(entry.requestExecutionId),
    sourceOperationId: normalizeText(entry.sourceOperationId),
    requestedBy: normalizeText(entry.requestedBy),
    requestedByUserId: normalizeText(entry.requestedByUserId),
    decisionId: normalizeText(entry.decisionId),
    resolution: normalizeText(entry.resolution),
    resolvedBy: normalizeText(entry.resolvedBy),
    resolvedByUserId: normalizeText(entry.resolvedByUserId),
    resolutionNotes: Array.isArray(entry.resolutionNotes) ? entry.resolutionNotes.map(normalizeText).filter(Boolean) : [],
    createdAt,
    updatedTime,
    resolvedAt
  };
}

export function normalizePendingOutcomeList(entries = [], context = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizePendingOutcomeEntry(entry, context))
    .filter(Boolean);
}
