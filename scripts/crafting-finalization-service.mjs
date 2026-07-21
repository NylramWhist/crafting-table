export class CraftingFinalizationRollbackError extends Error {
  constructor(cause, rollbackErrors = []) {
    super("Crafting finalization could not be fully restored. GM review is required.");
    this.name = "CraftingFinalizationRollbackError";
    this.code = "operation-pending-review";
    this.details = {
      cause: String(cause?.message ?? cause),
      rollbackErrors: rollbackErrors.map((error) => String(error?.message ?? error))
    };
  }
}

export async function finalizeCraftingState({
  actor,
  requestId = "",
  executionId = "",
  getOngoingCrafts,
  getCraftRequests,
  getPendingOutcomes = null,
  saveOngoingCrafts,
  saveCraftRequests,
  savePendingOutcomes = null,
  clearProgress,
  completeRequest,
  finalizeRequest = completeRequest,
  finalizePendingOutcome = null,
  assertCurrent = () => true,
  clone = (value) => structuredClone(value)
} = {}) {
  const ongoingCrafts = clone(getOngoingCrafts(actor));
  const craftRequests = clone(getCraftRequests(actor));
  const pendingOutcomes = getPendingOutcomes && savePendingOutcomes
    ? clone(getPendingOutcomes(actor))
    : null;

  try {
    assertCurrent();
    await clearProgress();
    assertCurrent();
    if (requestId) await finalizeRequest(actor, requestId, executionId);
    assertCurrent();
    if (finalizePendingOutcome) await finalizePendingOutcome();
    assertCurrent();
  } catch (error) {
    const rollbackErrors = [];
    try {
      await saveOngoingCrafts(actor, ongoingCrafts);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await saveCraftRequests(actor, craftRequests);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (pendingOutcomes) {
      try {
        await savePendingOutcomes(actor, pendingOutcomes);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new CraftingFinalizationRollbackError(error, rollbackErrors);
    throw error;
  }
}
