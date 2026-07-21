export class CraftingAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CraftingAuthorizationError";
    this.code = code;
  }
}

export function canUserManageCrafting(user = globalThis.game?.user) {
  return Boolean(user?.isGM);
}

export function canUserModifyCraftingActor(actor, user = globalThis.game?.user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  if (typeof actor.testUserPermission === "function") return actor.testUserPermission(user, "OWNER");
  return Boolean(actor.isOwner);
}

export function assertCanModifyCraftingActor(actor, user = globalThis.game?.user) {
  if (!canUserModifyCraftingActor(actor, user)) {
    throw new CraftingAuthorizationError("actor-owner-required", "The current user cannot modify this Actor.");
  }
  return true;
}

export function assertCanManageCrafting(user = globalThis.game?.user) {
  if (!canUserManageCrafting(user)) {
    throw new CraftingAuthorizationError("gm-required", "Only a GM can perform this crafting management action.");
  }
  return true;
}
