const activeOperations = new Map();

export class CraftingOperationBusyError extends Error {
  constructor(key) {
    super(`Crafting operation ${key} is already running.`);
    this.name = "CraftingOperationBusyError";
    this.code = "operation-busy";
  }
}

export class CraftingStateChangedError extends Error {
  constructor(message = "Crafting state changed before the operation could be completed.") {
    super(message);
    this.name = "CraftingStateChangedError";
    this.code = "state-changed";
  }
}

function createOperationId() {
  return globalThis.foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getCraftingOperationKey({ actor, recipeId = "", recipeUuid = "", requestId = "" } = {}) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "unknown-actor");
  const recipeKey = String(recipeId || recipeUuid || requestId || "unknown-recipe");
  return `${actorKey}::${recipeKey}`;
}

export async function runExclusiveCraftingOperation(context, callback) {
  const key = getCraftingOperationKey(context);
  if (activeOperations.has(key)) throw new CraftingOperationBusyError(key);

  const id = createOperationId();
  activeOperations.set(key, id);
  const operation = Object.freeze({
    id,
    key,
    assertCurrent() {
      if (activeOperations.get(key) !== id) throw new CraftingOperationBusyError(key);
      return true;
    }
  });

  try {
    return await callback(operation);
  } finally {
    if (activeOperations.get(key) === id) activeOperations.delete(key);
  }
}

export function captureActorResourceFingerprint(actor) {
  const currency = actor?.system?.currency ?? {};
  const actorItems = actor?.items?.contents ?? Array.from(actor?.items?.values?.() ?? actor?.items ?? []);
  const items = actorItems
    .map((item) => [String(item.id), Number(item.system?.quantity ?? 1)])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    currency: {
      cp: Number(currency.cp ?? 0),
      sp: Number(currency.sp ?? 0),
      ep: Number(currency.ep ?? 0),
      gp: Number(currency.gp ?? 0),
      pp: Number(currency.pp ?? 0)
    },
    items
  });
}

export function assertActorResourcesUnchanged(actor, fingerprint) {
  if (captureActorResourceFingerprint(actor) !== fingerprint) throw new CraftingStateChangedError();
  return true;
}

export function transitionCraftRequestEntries(entries, {
  requestId,
  nextStatus,
  allowedFrom = [],
  changes = {},
  now = Date.now()
} = {}) {
  const requests = Array.isArray(entries) ? entries : [];
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) throw new CraftingStateChangedError("The craft request no longer exists.");
  if (request.status === nextStatus) return { changed: false, request, entries: requests };
  if (allowedFrom.length && !allowedFrom.includes(request.status)) {
    throw new CraftingStateChangedError(`Craft request cannot transition from ${request.status} to ${nextStatus}.`);
  }

  const updated = { ...request, ...changes, status: nextStatus, updatedTime: now };
  return {
    changed: true,
    request: updated,
    entries: requests.map((entry) => entry.id === requestId ? updated : entry)
  };
}
