export function buildRecipeAvailability({
  known = false,
  pendingGmOutcome = null,
  hasTool = false,
  hasProficiency = false,
  hasIngredients = false,
  hasCost = false,
  hasResults = false,
  permissionState = {},
  requiresProgress = false,
  progress = {},
  progressComplete = false,
  missingSelectedOptional = false,
  localize
} = {}) {
  const t = typeof localize === "function" ? localize : (key) => key;
  const baseReady = known && hasTool && hasProficiency && hasIngredients && hasCost && hasResults;
  const canWork = baseReady && !pendingGmOutcome && permissionState.canWork && requiresProgress && !progressComplete;
  const canCraft = baseReady && !pendingGmOutcome && (permissionState.canCraft || permissionState.canRequest) && progressComplete;
  const permissionReady = Boolean(permissionState.canCraft || permissionState.canRequest || permissionState.canWork);

  let statusLabel = t("status.readyToCraft");
  let statusClass = "is-ready";
  if (pendingGmOutcome) {
    statusLabel = t("status.awaitingGmDecision");
    statusClass = "is-ongoing";
  } else if (!known) {
    statusLabel = t("status.unknownRecipe");
    statusClass = "is-unknown";
  } else if (!hasTool) {
    statusLabel = t("status.missingTool");
    statusClass = "is-blocked";
  } else if (!hasProficiency) {
    statusLabel = t("status.missingProficiency");
    statusClass = "is-blocked";
  } else if (!hasIngredients) {
    statusLabel = t("status.missingIngredients");
    statusClass = "is-blocked";
  } else if (!hasCost) {
    statusLabel = t("status.missingCurrency");
    statusClass = "is-blocked";
  } else if (!hasResults) {
    statusLabel = t("status.missingResult");
    statusClass = "is-blocked";
  } else if (permissionState.statusLabel && (!requiresProgress || progressComplete || !permissionState.canWork)) {
    statusLabel = permissionState.statusLabel;
    statusClass = permissionState.statusClass;
  } else if (requiresProgress && progress.started && !progressComplete) {
    statusLabel = t("status.ongoing", { percent: progress.percent });
    statusClass = "is-ongoing";
  } else if (requiresProgress && !progressComplete) {
    statusLabel = t("status.readyToStart");
  } else if (requiresProgress) {
    statusLabel = t("status.readyToFinish");
  }

  const blockers = [];
  if (pendingGmOutcome) blockers.push(t("detail.blockedGmDecision"));
  if (!known) blockers.push(t("detail.blockedUnknownRecipe"));
  if (!hasTool) blockers.push(t("detail.blockedMissingTool"));
  if (!hasProficiency) blockers.push(t("detail.blockedMissingProficiency"));
  if (!hasIngredients) blockers.push(t(missingSelectedOptional ? "detail.blockedSelectedOptional" : "detail.blockedMissingIngredients"));
  if (!hasCost) blockers.push(t("detail.blockedMissingCurrency"));
  if (!hasResults) blockers.push(t("detail.blockedMissingResult"));
  if (!permissionReady) blockers.push(t("detail.blockedPermission"));
  if (baseReady && requiresProgress && !progressComplete && !canWork) blockers.push(t("detail.blockedProgress"));

  let statusSummary = t("ui.statusSummaryBlocked");
  if (pendingGmOutcome) statusSummary = t("ui.statusSummaryGmDecision");
  else if (canCraft && !permissionState.canRequest) statusSummary = t("ui.statusSummaryReady");
  else if (permissionState.canRequest) statusSummary = t("ui.statusSummaryRequest");
  else if (canWork && progress.started) statusSummary = t("ui.statusSummaryProgress");
  else if (canWork) statusSummary = t("ui.statusSummaryStart");

  let nextStep = t("ui.actionBlocked");
  if (pendingGmOutcome) nextStep = t("ui.actionAwaitGm");
  else if (canCraft && !requiresProgress) nextStep = t("ui.actionCraftNow");
  else if (canCraft) nextStep = t("ui.actionFinish");
  else if (permissionState.canRequest) nextStep = t("ui.actionRequest");
  else if (canWork && progress.started) nextStep = t("ui.actionContinue");
  else if (canWork) nextStep = t("ui.actionReadyToStart");

  const statusIconClass = {
    "is-ready": "fas fa-check-circle",
    "is-ongoing": "fas fa-hourglass-half",
    "is-unknown": "fas fa-eye-slash",
    "is-blocked": "fas fa-exclamation-triangle"
  }[statusClass] ?? "fas fa-info-circle";

  return {
    baseReady,
    blockers,
    canCraft,
    canWork,
    nextStep,
    permissionReady,
    statusClass,
    statusIconClass,
    statusLabel,
    statusSummary
  };
}
