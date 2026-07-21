function normalizeLooseName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function normalizeToolName(value) {
  return normalizeLooseName(value)
    .replace(/(?:tools?|supplies|utensils|kits?)$/g, "")
    .replace(/artisanstools/g, "")
    .replace(/toolproficiencies/g, "");
}

export function toolNamesMatch(left, right) {
  const leftName = normalizeToolName(left);
  const rightName = normalizeToolName(right);
  if (!leftName || !rightName) return false;
  if (leftName === rightName) return true;
  if (Math.min(leftName.length, rightName.length) < 4) return false;
  return leftName.includes(rightName) || rightName.includes(leftName);
}

export function hasExplicitEmptyToolRequirement(recipe = {}) {
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(recipe, key);
  if (!["toolName", "toolUuid", "toolKey"].every(hasOwn)) return false;
  return !String(recipe.toolName ?? "").trim()
    && !String(recipe.toolUuid ?? "").trim()
    && !String(recipe.toolKey ?? "").trim();
}

export function clearRecipeToolRequirement(recipe = {}) {
  recipe.toolName = "";
  recipe.toolUuid = "";
  recipe.toolKey = "";
  recipe.requirements = recipe.requirements ?? {};
  recipe.requirements.tool = { name: "", uuid: "", key: "" };
  return recipe;
}

export function toolHasProficiency(data = {}) {
  if (data == null) return false;
  const values = typeof data === "object"
    ? [data.value, data.prof?.multiplier, data.prof, data.proficiencyMultiplier, data.proficiency, data.proficient]
    : [data];
  return values.some((value) => {
    if (value === true) return true;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0;
    const text = String(value ?? "").trim().toLowerCase();
    return ["proficient", "expertise", "expert", "double"].includes(text);
  });
}

export function isIngredientRequired(entry = {}) {
  return String(entry.type ?? "required").toLowerCase() !== "optional";
}

export function normalizeOptionalIngredientSelection(entries = [], selection = []) {
  const ingredients = Array.isArray(entries) ? entries : [];
  const requested = Array.isArray(selection) ? selection : [];
  const indexes = [];
  const invalid = [];
  const seen = new Set();

  for (const value of requested) {
    const index = Number(value);
    if (
      !Number.isInteger(index)
      || index < 0
      || index >= ingredients.length
      || isIngredientRequired(ingredients[index])
    ) {
      invalid.push(value);
      continue;
    }
    if (seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
  }

  indexes.sort((left, right) => left - right);
  return { indexes, invalid };
}

export function getIngredientMatchMode(entry = {}) {
  const mode = String(entry.matchMode ?? "").trim().toLowerCase();
  if (["uuid", "name", "tag"].includes(mode)) return mode;
  return entry.uuid ? "uuid" : "name";
}

export function ingredientMatchesCandidate(entry = {}, candidate = {}) {
  const mode = getIngredientMatchMode(entry);
  if (mode === "uuid") {
    const uuid = String(entry.uuid ?? "").trim();
    return Boolean(uuid && [candidate.uuid, candidate.sourceId].some((value) => String(value ?? "").trim() === uuid));
  }
  if (mode === "tag") {
    const tag = normalizeLooseName(entry.tag ?? entry.name);
    return Boolean(tag && (candidate.tags ?? []).some((value) => normalizeLooseName(value) === tag));
  }
  const name = normalizeLooseName(entry.name);
  return Boolean(name && normalizeLooseName(candidate.name) === name);
}

function triggerMatches(trigger, { total, natural, dc }, success) {
  const type = trigger?.type;
  if (success) {
    if (type === "nat20") return natural === 20;
    if (type === "beatDcBy5") return total >= dc + 5;
    if (type === "beatDcBy10") return total >= dc + 10;
    if (type === "custom") return total >= Number(trigger.threshold);
    return false;
  }
  if (type === "nat1") return natural === 1;
  if (type === "missDcBy10") return total <= dc - 10;
  if (type === "custom") return total <= Number(trigger.threshold);
  return false;
}

export function classifyCraftOutcome({ total = 0, natural = null, dc = 10, outcomes = {} } = {}) {
  const numericTotal = Number(total ?? 0);
  const numericDc = Number(dc ?? 10);
  const success = numericTotal >= numericDc;
  const criticalFailure = outcomes.criticalFailure ?? {};
  const criticalSuccess = outcomes.criticalSuccess ?? {};
  const partialSuccess = outcomes.partialSuccess ?? {};

  if (criticalFailure.enabled && triggerMatches(criticalFailure.trigger, {
    total: numericTotal,
    natural: Number(natural),
    dc: numericDc
  }, false)) return "criticalFailure";

  if (criticalSuccess.enabled && success && triggerMatches(criticalSuccess.trigger, {
    total: numericTotal,
    natural: Number(natural),
    dc: numericDc
  }, true)) return "criticalSuccess";

  if (success) return "success";
  const missBy = Math.max(1, Number(partialSuccess.missBy ?? 2));
  if (partialSuccess.enabled && numericDc - numericTotal <= missBy) return "partialSuccess";
  return "failure";
}

function positiveMultiplier(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function buildOutcomeExecutionPlan({ type = "success", outcomes = {} } = {}) {
  const plan = {
    type,
    outputMultiplier: 1,
    ingredientMultiplier: 1,
    waiveCost: false,
    extraTimeMultiplier: 1,
    bonusResults: [],
    itemTraits: [],
    notes: [],
    requiresGm: false
  };

  let effects = [];
  if (type === "criticalSuccess") effects = outcomes.criticalSuccess?.effects ?? [];
  if (type === "partialSuccess") {
    const partial = outcomes.partialSuccess ?? {};
    effects = [partial.effect, ...(partial.additionalEffects ?? [])].filter(Boolean);
  }

  for (const effect of effects) {
    if (effect.type === "doubleOutput") plan.outputMultiplier *= 2;
    else if (effect.type === "noGoldCost") plan.waiveCost = true;
    else if (effect.type === "bonusItem" && effect.item) plan.bonusResults.push(effect.item);
    else if (effect.type === "reduceTime") {
      const multiplier = positiveMultiplier(effect.multiplier ?? effect.value, 0.5);
      plan.itemTraits.push(`time-reduced:${multiplier}`);
      plan.notes.push(`Crafting time multiplier: ${multiplier}`);
    }
    else if (effect.type === "reducedOutput") plan.outputMultiplier *= positiveMultiplier(effect.value, 0.5);
    else if (effect.type === "reducedQuality") plan.itemTraits.push(`quality:${effect.qualityTier || "poor"}`);
    else if (effect.type === "increasedTime") plan.extraTimeMultiplier = Math.max(plan.extraTimeMultiplier, positiveMultiplier(effect.value, 1.5));
    else if (effect.type === "consumeExtraMaterials") plan.ingredientMultiplier *= positiveMultiplier(effect.value, 1.5);
    else if (effect.type === "unstableItem") plan.itemTraits.push("unstable");
    else if (effect.type === "weakerItem") plan.itemTraits.push("weaker");
    else if (effect.type === "gmDecision") plan.requiresGm = true;
    if (effect.conditions) plan.notes.push(`Condition: ${effect.conditions}`);
  }

  return plan;
}
