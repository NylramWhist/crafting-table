export async function rollDnd5eCraftingCheck({
  actor,
  recipe,
  getToolKey,
  hasToolProficiency,
  isToolProficient,
  localize,
  escapeHtml,
  config = globalThis.CONFIG,
  RollClass = globalThis.Roll,
  ChatMessageClass = globalThis.ChatMessage,
  hooks = globalThis.Hooks
} = {}) {
  if (!actor || !recipe) throw new Error("Dnd5eRollAdapter requires an actor and recipe.");
  const abilityId = recipe.ability || "int";
  const abilityData = actor.system?.abilities?.[abilityId] ?? {};
  const abilityMod = Number(abilityData.mod ?? 0);
  const toolKey = getToolKey(recipe);
  const toolData = toolKey ? actor.system?.tools?.[toolKey] : null;
  const rawMultiplier = Number(toolData?.value ?? toolData?.prof?.multiplier ?? 1);
  const proficiencyMultiplier = isToolProficient(toolData)
    ? (Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1)
    : (hasToolProficiency(recipe) ? 1 : 0);
  const proficiencyBonus = Number(actor.system?.attributes?.prof ?? 0) * proficiencyMultiplier;
  const actorRollData = actor.getRollData();
  const resolveActorFormula = (value) => {
    if (value === null || value === undefined || value === "") return null;
    return typeof value === "string"
      ? RollClass.replaceFormulaData(value, actorRollData, { missing: 0 })
      : value;
  };
  const knownTool = Boolean(toolKey && (config.DND5E?.tools?.[toolKey] || config.DND5E?.vehicleTypes?.[toolKey]));
  const globalBonuses = actor.system?.bonuses?.abilities ?? {};
  const constructed = config.Dice.D20Roll.constructParts({
    abilityModifier: abilityMod,
    craftingProficiency: proficiencyBonus || null,
    craftingToolBonus: resolveActorFormula(toolData?.bonuses?.check),
    craftingAbilityBonus: resolveActorFormula(abilityData?.bonuses?.check),
    craftingGlobalToolBonus: knownTool ? resolveActorFormula(globalBonuses.tool) : null,
    craftingGlobalCheckBonus: resolveActorFormula(globalBonuses.check)
  }, {});
  if (typeof actor.addRollExhaustion === "function") actor.addRollExhaustion(constructed.parts, constructed.data);

  const advantageMode = config.Dice.D20Roll.ADV_MODE;
  const rollModes = [abilityData?.check?.roll?.mode, toolData?.roll?.mode];
  const advantage = rollModes.includes(advantageMode.ADVANTAGE);
  const disadvantage = rollModes.includes(advantageMode.DISADVANTAGE);
  const maximum = Math.min(Number(abilityData?.check?.roll?.max ?? Infinity), Number(toolData?.roll?.max ?? Infinity));
  const minimum = Math.max(Number(abilityData?.check?.roll?.min ?? -Infinity), Number(toolData?.roll?.min ?? -Infinity));
  const options = { advantage, disadvantage };
  if (Number.isFinite(maximum)) options.maximum = maximum;
  if (Number.isFinite(minimum)) options.minimum = minimum;

  const flavor = escapeHtml(localize("roll.flavor", {
    recipe: recipe.name,
    dc: localize("ui.dc"),
    value: recipe.dc
  }));
  const dialog = {
    options: {
      window: {
        title: `${recipe.name} - ${localize("ui.craftingCheck")}`,
        subtitle: actor.name
      }
    }
  };
  const message = {
    data: {
      flavor,
      speaker: ChatMessageClass.getSpeaker({ actor }),
      flags: {
        dnd5e: {
          messageType: "roll",
          roll: knownTool
            ? { type: "tool", toolId: toolKey, ability: abilityId }
            : { type: "ability", ability: abilityId }
        },
        "crafting-table": {
          recipeId: recipe.recipeId,
          recipeUuid: recipe.uuid,
          recipeName: recipe.name,
          dc: recipe.dc
        }
      }
    }
  };
  const rollConfig = {
    ability: abilityId,
    target: recipe.dc,
    hookNames: ["craftingTable", ...(knownTool ? ["tool", "abilityCheck"] : ["abilityCheck"]), "d20Test"],
    halflingLucky: actor.getFlag?.("dnd5e", "halflingLucky"),
    reliableTalent: Boolean(toolData?.value >= 1 && actor.getFlag?.("dnd5e", "reliableTalent")),
    rolls: [{ parts: constructed.parts, data: constructed.data, options }]
  };

  if (typeof config.Dice.D20Roll.build !== "function") {
    const roll = await new RollClass(`1d20 + ${abilityMod} + ${proficiencyBonus}`, actorRollData).evaluate();
    await roll.toMessage({ speaker: message.data.speaker, flavor });
    return roll;
  }

  const rolls = await config.Dice.D20Roll.build(rollConfig, dialog, message);
  const roll = rolls?.[0] ?? null;
  if (!roll) return null;

  const hookData = { ability: abilityId, subject: actor };
  if (knownTool) {
    hookData.tool = toolKey;
    hooks.callAll("dnd5e.rollToolCheck", rolls, hookData);
    hooks.callAll("dnd5e.rollToolCheckV2", rolls, hookData);
  } else {
    hooks.callAll("dnd5e.rollAbilityCheck", rolls, hookData);
  }
  return roll;
}
