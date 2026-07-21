import { normalizeCraftRequestList, normalizeOngoingCraftList, normalizePendingOutcomeList } from "./crafting-data-rules.mjs";

export function createCraftingStateService({
  moduleId = "crafting-table",
  craftRequestsFlag = "craftRequests",
  ongoingCraftsFlag = "ongoingCrafts",
  pendingOutcomesFlag = "pendingOutcomes",
  defaultIcon = "icons/svg/item-bag.svg"
} = {}) {
  const getCraftRequests = (actor) => normalizeCraftRequestList(
    actor?.getFlag?.(moduleId, craftRequestsFlag),
    { actor, defaultIcon }
  );

  const getOngoingCrafts = (actor) => normalizeOngoingCraftList(
    actor?.getFlag?.(moduleId, ongoingCraftsFlag),
    { defaultIcon }
  );

  const getPendingOutcomes = (actor) => normalizePendingOutcomeList(
    actor?.getFlag?.(moduleId, pendingOutcomesFlag),
    { actor, defaultIcon }
  );

  const setActorFlag = async (actor, flag, entries) => {
    if (!entries.length) {
      if (typeof actor.unsetFlag === "function") await actor.unsetFlag(moduleId, flag);
      else await actor.setFlag(moduleId, flag, []);
      return;
    }
    await actor.setFlag(moduleId, flag, entries);
  };

  const saveCraftRequests = async (actor, entries) => {
    const normalized = normalizeCraftRequestList(entries, { actor, defaultIcon });
    await setActorFlag(actor, craftRequestsFlag, normalized);
    return normalized;
  };

  const saveOngoingCrafts = async (actor, entries) => {
    const normalized = normalizeOngoingCraftList(entries, { defaultIcon });
    await setActorFlag(actor, ongoingCraftsFlag, normalized);
    return normalized;
  };

  const savePendingOutcomes = async (actor, entries) => {
    const normalized = normalizePendingOutcomeList(entries, { actor, defaultIcon });
    await setActorFlag(actor, pendingOutcomesFlag, normalized);
    return normalized;
  };

  return Object.freeze({
    getCraftRequests,
    getOngoingCrafts,
    getPendingOutcomes,
    saveCraftRequests,
    saveOngoingCrafts,
    savePendingOutcomes,
    setActorFlag
  });
}
