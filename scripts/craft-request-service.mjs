import { CraftingOperationBusyError, CraftingStateChangedError, transitionCraftRequestEntries } from "./crafting-operation-service.mjs";
import { recipeReferencesMatch } from "./recipe-identity-service.mjs";

const ACTIVE_REQUEST_STATUSES = Object.freeze(["pending", "approved", "processing"]);

export function createCraftRequestService({ state, assertActorAccess, assertManagerAccess, createId, now = () => Date.now() } = {}) {
  if (!state) throw new TypeError("Craft request state service is required.");

  const getRequests = (actor) => state.getCraftRequests(actor);

  const findLatest = (actor, recipeReference, statuses = null) => {
    const reference = typeof recipeReference === "string" ? { recipeUuid: recipeReference } : (recipeReference ?? {});
    const allowed = Array.isArray(statuses) ? statuses : (statuses ? [statuses] : null);
    return getRequests(actor)
      .filter((request) => recipeReferencesMatch(request, reference))
      .filter((request) => !allowed || allowed.includes(request.status))
      .sort((left, right) => Number(right.updatedTime ?? right.requestedAt ?? 0) - Number(left.updatedTime ?? left.requestedAt ?? 0))[0] ?? null;
  };

  const createApprovalRequest = async (actor, data) => {
    assertActorAccess?.(actor);
    const requests = getRequests(actor);
    const existing = findLatest(actor, data, ACTIVE_REQUEST_STATUSES);
    if (existing) return { created: false, request: existing };

    const timestamp = now();
    const request = {
      ...data,
      id: createId?.() ?? `${timestamp}-${Math.random().toString(36).slice(2)}`,
      status: "pending",
      requestedAt: timestamp,
      updatedTime: timestamp
    };
    const saved = await state.saveCraftRequests(actor, [...requests, request]);
    return { created: true, request: saved.find((entry) => entry.id === request.id) ?? request };
  };

  const claim = async (actor, requestId, executionId) => {
    assertActorAccess?.(actor);
    const transition = transitionCraftRequestEntries(getRequests(actor), {
      requestId,
      nextStatus: "processing",
      allowedFrom: ["approved"],
      changes: { executionId },
      now: now()
    });
    await state.saveCraftRequests(actor, transition.entries);
    const claimed = getRequests(actor).find((request) => request.id === requestId);
    if (claimed?.status !== "processing" || claimed.executionId !== executionId) throw new CraftingOperationBusyError(requestId);
    return claimed;
  };

  const release = async (actor, requestId, executionId) => {
    assertActorAccess?.(actor);
    const requests = getRequests(actor);
    const request = requests.find((entry) => entry.id === requestId);
    if (!request || request.status !== "processing" || request.executionId !== executionId) return false;
    const transition = transitionCraftRequestEntries(requests, {
      requestId,
      nextStatus: "approved",
      allowedFrom: ["processing"],
      changes: { executionId: "" },
      now: now()
    });
    await state.saveCraftRequests(actor, transition.entries);
    return true;
  };

  const complete = async (actor, requestId, executionId = "") => {
    assertActorAccess?.(actor);
    const requests = getRequests(actor);
    const request = requests.find((entry) => entry.id === requestId);
    if (request?.status === "completed") return request;
    if (request?.status === "processing" && request.executionId !== executionId) throw new CraftingStateChangedError();
    const transition = transitionCraftRequestEntries(requests, {
      requestId,
      nextStatus: "completed",
      allowedFrom: ["approved", "processing"],
      changes: { executionId: "", completedAt: now() },
      now: now()
    });
    await state.saveCraftRequests(actor, transition.entries);
    return transition.request;
  };

  const decide = async (actor, requestId, status, decision) => {
    assertManagerAccess?.();
    const transition = transitionCraftRequestEntries(getRequests(actor), {
      requestId,
      nextStatus: status,
      allowedFrom: ["pending"],
      changes: decision,
      now: now()
    });
    if (!transition.changed) return transition;
    await state.saveCraftRequests(actor, transition.entries);
    const saved = getRequests(actor).find((entry) => entry.id === requestId);
    if (saved?.status !== status || saved.decisionId !== decision.decisionId) throw new CraftingStateChangedError();
    return { ...transition, request: saved };
  };

  const clear = async (actor, requestId) => {
    assertManagerAccess?.();
    const requests = getRequests(actor);
    const request = requests.find((entry) => entry.id === requestId);
    if (!request) throw new CraftingStateChangedError("The craft request no longer exists.");
    if (request.status === "processing") throw new CraftingOperationBusyError(requestId);
    await state.saveCraftRequests(actor, requests.filter((entry) => entry.id !== requestId));
    return request;
  };

  return Object.freeze({
    activeStatuses: ACTIVE_REQUEST_STATUSES,
    claim,
    clear,
    complete,
    createApprovalRequest,
    decide,
    findLatest,
    getRequests,
    release
  });
}
