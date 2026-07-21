import { CraftingStateChangedError } from "./crafting-operation-service.mjs";
import { recipeReferencesMatch } from "./recipe-identity-service.mjs";

export const PENDING_OUTCOME_RESOLUTIONS = Object.freeze(["configured", "success", "failure", "noEffect"]);

export function createPendingOutcomeService({
  state,
  assertActorAccess,
  assertManagerAccess,
  createId,
  now = () => Date.now()
} = {}) {
  if (!state) throw new TypeError("Pending outcome state service is required.");

  const getOutcomes = (actor) => state.getPendingOutcomes(actor);

  const findById = (actor, outcomeId) => getOutcomes(actor).find((entry) => entry.id === outcomeId) ?? null;

  const findActive = (actor, recipeReference) => getOutcomes(actor)
    .filter((entry) => entry.status === "pending")
    .filter((entry) => recipeReferencesMatch(entry, recipeReference ?? {}))
    .sort((left, right) => Number(right.updatedTime ?? 0) - Number(left.updatedTime ?? 0))[0] ?? null;

  const queue = async (actor, data = {}) => {
    assertActorAccess?.(actor);
    const outcomes = getOutcomes(actor);
    const existing = outcomes.find((entry) => entry.status === "pending" && (
      (data.sourceOperationId && entry.sourceOperationId === data.sourceOperationId)
      || recipeReferencesMatch(entry, data)
    ));
    if (existing) return { created: false, outcome: existing };

    const timestamp = now();
    const outcome = {
      ...data,
      id: createId?.() ?? `${timestamp}-${Math.random().toString(36).slice(2)}`,
      status: "pending",
      createdAt: timestamp,
      updatedTime: timestamp
    };
    const saved = await state.savePendingOutcomes(actor, [...outcomes, outcome]);
    return { created: true, outcome: saved.find((entry) => entry.id === outcome.id) ?? outcome };
  };

  const transition = async (actor, outcomeId, status, decision = {}) => {
    assertManagerAccess?.();
    const outcomes = getOutcomes(actor);
    const target = outcomes.find((entry) => entry.id === outcomeId);
    if (!target || target.status !== "pending") {
      throw new CraftingStateChangedError("The pending GM outcome no longer exists.");
    }

    const timestamp = now();
    const next = outcomes.map((entry) => entry === target ? {
      ...entry,
      ...decision,
      status,
      updatedTime: timestamp,
      resolvedAt: timestamp
    } : entry);
    const saved = await state.savePendingOutcomes(actor, next);
    const resolved = saved.find((entry) => entry.id === outcomeId);
    if (!resolved || resolved.status !== status || (decision.decisionId && resolved.decisionId !== decision.decisionId)) {
      throw new CraftingStateChangedError("The pending GM outcome changed before it could be resolved.");
    }
    return resolved;
  };

  const resolve = (actor, outcomeId, decision) => transition(actor, outcomeId, "resolved", decision);
  const cancel = (actor, outcomeId, decision) => transition(actor, outcomeId, "cancelled", decision);

  const pruneFinished = async (actor) => {
    assertManagerAccess?.();
    const outcomes = getOutcomes(actor);
    const next = outcomes.filter((entry) => entry.status === "pending");
    if (next.length !== outcomes.length) await state.savePendingOutcomes(actor, next);
    return outcomes.length - next.length;
  };

  return Object.freeze({
    cancel,
    findActive,
    findById,
    getOutcomes,
    pruneFinished,
    queue,
    resolve
  });
}
