export function captureCraftTransactionState({ actor, itemIds = [], currency } = {}) {
  const itemSnapshots = new Map();
  for (const itemId of itemIds) {
    const item = actor?.items?.get?.(itemId);
    if (item) itemSnapshots.set(itemId, item.toObject());
  }
  return {
    currencyBefore: { ...(currency ?? actor?.system?.currency ?? {}) },
    itemSnapshots,
    resultRecords: []
  };
}

export async function rollbackCraftTransaction({ actor, currencyBefore, itemSnapshots, resultRecords = [], onError } = {}) {
  const rollbackErrors = [];
  try {
    const createdIds = resultRecords.flatMap((record) => record.type === "create" ? record.itemIds : []);
    const existingCreatedIds = createdIds.filter((itemId) => actor.items.get(itemId));
    if (existingCreatedIds.length) await actor.deleteEmbeddedDocuments("Item", existingCreatedIds);
    const resultUpdates = resultRecords
      .filter((record) => record.type === "update" && actor.items.get(record.itemId))
      .map((record) => ({ _id: record.itemId, "system.quantity": record.previousQuantity }));
    if (resultUpdates.length) await actor.updateEmbeddedDocuments("Item", resultUpdates);
  } catch (error) {
    rollbackErrors.push(error);
  }

  try {
    const updates = [];
    const creates = [];
    for (const [itemId, data] of itemSnapshots ?? []) {
      if (actor.items.get(itemId)) updates.push({ _id: itemId, "system.quantity": Number(data.system?.quantity ?? 1) });
      else creates.push(data);
    }
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
    if (creates.length) await actor.createEmbeddedDocuments("Item", creates, { keepId: true });
  } catch (error) {
    rollbackErrors.push(error);
  }

  try {
    await actor.update({
      "system.currency.cp": Number(currencyBefore?.cp ?? 0),
      "system.currency.sp": Number(currencyBefore?.sp ?? 0),
      "system.currency.ep": Number(currencyBefore?.ep ?? 0),
      "system.currency.gp": Number(currencyBefore?.gp ?? 0),
      "system.currency.pp": Number(currencyBefore?.pp ?? 0)
    });
  } catch (error) {
    rollbackErrors.push(error);
  }

  if (rollbackErrors.length) onError?.(rollbackErrors);
  return { complete: rollbackErrors.length === 0, errors: rollbackErrors };
}
