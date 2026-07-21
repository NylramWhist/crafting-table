const PROTOCOL_VERSION = 1;
const REQUEST_TYPE = "request";
const RESULT_TYPE = "result";

function defaultCreateId() {
  return globalThis.foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashPayload(value) {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function getOperationScope(action, payload = {}) {
  const subject = payload.recipeId || payload.recipeUuid || payload.requestId || payload.craftId || payload.pendingOutcomeId || "actor";
  return `${action}::${String(subject)}`;
}

function toSerializable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function serializeDetails(value) {
  try {
    return toSerializable(value ?? {});
  } catch (_error) {
    return {};
  }
}

function normalizeLedger(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && entry.id) : [];
}

function trimLedger(entries, maximum) {
  if (entries.length <= maximum) return entries;
  const processing = entries.filter((entry) => ["processing", "review-required"].includes(entry.status));
  const finished = entries
    .filter((entry) => !["processing", "review-required"].includes(entry.status))
    .sort((left, right) => Number(right.completedAt ?? right.startedAt ?? 0) - Number(left.completedAt ?? left.startedAt ?? 0));
  return [...processing, ...finished.slice(0, Math.max(0, maximum - processing.length))];
}

export class CraftingSocketError extends Error {
  constructor(code, message, details = {}) {
    super(message || code || "Crafting socket operation failed.");
    this.name = "CraftingSocketError";
    this.code = code || "socket-operation-failed";
    this.details = details && typeof details === "object" ? details : {};
  }
}

function serializeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? "socket-operation-failed"),
    message: String(error?.message ?? "Crafting socket operation failed."),
    details: serializeDetails(error?.details)
  };
}

function deserializeError(value) {
  const error = new CraftingSocketError(value?.code, value?.message, value?.details);
  error.name = String(value?.name ?? "CraftingSocketError");
  return error;
}

function validateAction(action) {
  const normalized = String(action ?? "").trim();
  if (!normalized || !/^[a-z][a-z0-9.-]*$/i.test(normalized)) {
    throw new CraftingSocketError("invalid-action", "The crafting socket action is invalid.");
  }
  return normalized;
}

export function createCraftingSocketExecutor({
  moduleId = "crafting-table",
  getGame = () => globalThis.game,
  resolveActor,
  authorize,
  readLedger = (actor) => actor?.getFlag?.(moduleId, "operationLedger"),
  writeLedger = (actor, entries) => actor?.setFlag?.(moduleId, "operationLedger", entries),
  createId = defaultCreateId,
  now = () => Date.now(),
  requestTimeoutMs = 15_000,
  requestRetries = 1,
  maximumLedgerEntries = 100
} = {}) {
  if (typeof resolveActor !== "function") throw new TypeError("A crafting socket actor resolver is required.");
  if (typeof writeLedger !== "function") throw new TypeError("A crafting socket ledger writer is required.");

  const channel = `module.${moduleId}`;
  const handlers = new Map();
  const pendingRequests = new Map();
  const actorQueues = new Map();
  let activeSocket = null;

  const getActiveGm = () => getGame()?.users?.activeGM ?? null;

  const enqueueActorOperation = (actor, callback) => {
    const key = String(actor?.uuid ?? actor?.id ?? "unknown-actor");
    const previous = actorQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    actorQueues.set(key, current);
    current.finally(() => {
      if (actorQueues.get(key) === current) actorQueues.delete(key);
    }).catch(() => undefined);
    return current;
  };

  const replaceLedgerEntry = async (actor, entry) => {
    const ledger = normalizeLedger(await readLedger(actor));
    const next = ledger.filter((candidate) => candidate.id !== entry.id);
    next.push(entry);
    await writeLedger(actor, trimLedger(next, maximumLedgerEntries));
  };

  const assertCurrentExecutor = (executorId) => {
    const game = getGame();
    if (game?.user?.id !== executorId || getActiveGm()?.id !== executorId) {
      throw new CraftingSocketError("executor-changed", "The active GM changed during the crafting operation.");
    }
    return true;
  };

  const runIdempotent = async (message, actor, senderUser) => {
    const requestHash = hashPayload(message.payload);
    let ledger = normalizeLedger(await readLedger(actor));
    const scope = getOperationScope(message.action, message.payload);
    const existing = ledger.find((entry) => entry.id === message.operationId);
    if (existing) {
      if (existing.action !== message.action || existing.requestHash !== requestHash) {
        throw new CraftingSocketError("operation-id-conflict", "The operation ID was already used with different crafting data.");
      }
      if (existing.status === "completed") return existing.result ?? null;
      if (existing.status === "failed") throw deserializeError(existing.error);
      throw new CraftingSocketError(
        "operation-pending-review",
        "This crafting operation was interrupted and requires GM review before it can be repeated.",
        { operationId: message.operationId }
      );
    }

    const unresolved = ledger.filter((entry) => ["processing", "review-required"].includes(entry.status) && entry.scope === scope);
    if (unresolved.length && !senderUser.isGM) {
      throw new CraftingSocketError(
        "operation-pending-review",
        "An earlier crafting operation for this recipe requires GM review.",
        { operationIds: unresolved.map((entry) => entry.id) }
      );
    }
    if (unresolved.length) {
      const supersededAt = now();
      ledger = ledger.map((entry) => unresolved.includes(entry) ? {
        ...entry,
        status: "superseded",
        completedAt: supersededAt,
        supersededBy: message.operationId
      } : entry);
      await writeLedger(actor, trimLedger(ledger, maximumLedgerEntries));
    }

    const startedAt = now();
    const baseEntry = {
      id: message.operationId,
      action: message.action,
      scope,
      requestHash,
      requestedBy: senderUser.id,
      status: "processing",
      startedAt
    };
    await replaceLedgerEntry(actor, baseEntry);

    const handler = handlers.get(message.action);
    const operation = Object.freeze({
      id: message.operationId,
      action: message.action,
      requestedBy: senderUser.id,
      assertCurrent: () => assertCurrentExecutor(message.executorId)
    });

    let result;
    try {
      operation.assertCurrent();
      result = toSerializable(await handler(message.payload, { actor, operation, senderUser }));
    } catch (error) {
      const serialized = serializeError(error);
      const requiresReview = error?.code === "operation-pending-review";
      try {
        await replaceLedgerEntry(actor, {
          ...baseEntry,
          status: requiresReview ? "review-required" : "failed",
          completedAt: now(),
          error: serialized
        });
      } catch (ledgerError) {
        console.error(`${moduleId} | Failed to record the crafting operation error.`, ledgerError);
      }
      throw deserializeError(serialized);
    }

    try {
      await replaceLedgerEntry(actor, {
        ...baseEntry,
        status: "completed",
        completedAt: now(),
        result
      });
      return result;
    } catch (error) {
      console.error(`${moduleId} | Failed to record the completed crafting operation.`, error);
      throw new CraftingSocketError(
        "operation-pending-review",
        "The crafting result was applied but its idempotency record could not be completed. GM review is required.",
        { operationId: message.operationId }
      );
    }
  };

  const processRequest = async (message, senderId) => {
    const game = getGame();
    const action = validateAction(message?.action);
    if (action !== message.action || !handlers.has(action)) {
      throw new CraftingSocketError("unknown-action", `Unknown crafting socket action: ${action}`);
    }
    const operationId = String(message?.operationId ?? "");
    const requestId = String(message?.requestId ?? "");
    if (
      !operationId
      || operationId.length > 160
      || !/^[a-zA-Z0-9_.:-]+$/.test(operationId)
      || !requestId
      || requestId.length > 160
      || typeof message.payload?.actorUuid !== "string"
      || !message.payload.actorUuid
      || message.payload.actorUuid.length > 500
    ) {
      throw new CraftingSocketError("invalid-request", "The crafting socket request is incomplete.");
    }
    if (stableStringify(message.payload).length > 250_000) {
      throw new CraftingSocketError("request-too-large", "The crafting socket request is too large.");
    }

    assertCurrentExecutor(message.executorId);
    const senderUser = game?.users?.get?.(senderId);
    if (!senderUser) throw new CraftingSocketError("unknown-user", "The crafting socket sender is not a world user.");
    const actor = await resolveActor(message.payload.actorUuid);
    if (!actor) throw new CraftingSocketError("actor-not-found", "The crafting actor could not be found.");
    if (typeof authorize === "function") await authorize({ action, actor, payload: message.payload, senderUser });
    return enqueueActorOperation(actor, () => runIdempotent(message, actor, senderUser));
  };

  const sendResult = (request, recipientId, result = null, error = null) => {
    const game = getGame();
    game?.socket?.emit?.(channel, {
      protocol: PROTOCOL_VERSION,
      type: RESULT_TYPE,
      requestId: request.requestId,
      operationId: request.operationId,
      recipientId,
      ok: !error,
      result: error ? null : result,
      error: error ? serializeError(error) : null
    }, { recipients: [recipientId] });
  };

  const handleResult = (message, senderId) => {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    const game = getGame();
    if (message.recipientId !== game?.user?.id || senderId !== pending.executorId || message.operationId !== pending.operationId) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result ?? null);
    else pending.reject(deserializeError(message.error));
  };

  const handleSocketMessage = async (message, senderId) => {
    if (!message || message.protocol !== PROTOCOL_VERSION) return;
    if (message.type === RESULT_TYPE) return handleResult(message, senderId);
    if (message.type !== REQUEST_TYPE) return;

    const game = getGame();
    if (message.executorId !== game?.user?.id || getActiveGm()?.id !== game?.user?.id) return;
    try {
      const result = await processRequest(message, senderId);
      sendResult(message, senderId, result);
    } catch (error) {
      sendResult(message, senderId, null, error);
    }
  };

  const activate = () => {
    const socket = getGame()?.socket;
    if (!socket?.on) throw new CraftingSocketError("socket-unavailable", "The Foundry socket is not available.");
    if (activeSocket === socket) return false;
    if (activeSocket?.off) activeSocket.off(channel, handleSocketMessage);
    socket.on(channel, handleSocketMessage);
    activeSocket = socket;
    return true;
  };

  const deactivate = () => {
    if (!activeSocket) return false;
    activeSocket.off?.(channel, handleSocketMessage);
    activeSocket = null;
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CraftingSocketError("socket-inactive", "The crafting socket was deactivated."));
    }
    pendingRequests.clear();
    return true;
  };

  const register = (action, handler) => {
    const normalized = validateAction(action);
    if (typeof handler !== "function") throw new TypeError(`A handler is required for crafting socket action ${normalized}.`);
    if (handlers.has(normalized)) throw new TypeError(`Crafting socket action ${normalized} is already registered.`);
    handlers.set(normalized, handler);
    return executor;
  };

  const sendRemoteRequest = (game, activeGm, message, timeoutMs) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(message.requestId);
      reject(new CraftingSocketError("socket-timeout", "The active GM did not answer the crafting request in time.", {
        operationId: message.operationId
      }));
    }, timeoutMs);
    pendingRequests.set(message.requestId, {
      executorId: activeGm.id,
      operationId: message.operationId,
      reject,
      resolve,
      timeout
    });
    try {
      game.socket.emit(channel, message, { recipients: [activeGm.id] });
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(message.requestId);
      reject(error);
    }
  });

  const execute = async (action, payload = {}, {
    operationId = createId(),
    timeoutMs = requestTimeoutMs,
    retries = requestRetries
  } = {}) => {
    const normalized = validateAction(action);
    const serializedPayload = toSerializable(payload);
    const retryCount = Number(retries ?? 0);
    const maximumAttempts = Math.min(4, Math.max(1, (Number.isFinite(retryCount) ? Math.floor(retryCount) : 0) + 1));
    let lastError = null;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const game = getGame();
      const activeGm = getActiveGm();
      if (!activeGm) throw new CraftingSocketError("no-active-gm", "An active GM is required for this crafting operation.");
      if (!game?.user?.id) throw new CraftingSocketError("unknown-user", "The current Foundry user is unavailable.");
      const message = {
        protocol: PROTOCOL_VERSION,
        type: REQUEST_TYPE,
        requestId: createId(),
        operationId: String(operationId),
        action: normalized,
        executorId: activeGm.id,
        payload: serializedPayload
      };
      if (game.user.id === activeGm.id) return processRequest(message, game.user.id);
      if (!activeSocket) activate();
      try {
        return await sendRemoteRequest(game, activeGm, message, timeoutMs);
      } catch (error) {
        lastError = error;
        if (error?.code !== "socket-timeout" || attempt + 1 >= maximumAttempts) throw error;
      }
    }
    throw lastError;
  };

  const executor = Object.freeze({ activate, channel, deactivate, execute, register });
  return executor;
}
