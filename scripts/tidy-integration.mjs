export function createTidyIntegration({ moduleId = "crafting-table", openCraftingBench }) {
  const tabId = `${moduleId}-open-table`;
  let registered = false;

  function getActorFromApp(app) {
    const candidates = [
      app?.actor,
      app?.document,
      app?.object,
      app?.token?.actor,
      app?.context?.actor,
      app?.options?.document
    ];
    return candidates.find((candidate) => candidate?.documentName === "Actor") ?? null;
  }

  function bindTabLauncher(params) {
    const actor = getActorFromApp(params.app);
    if (actor?.type !== "character") return;
    if (!game.user?.isGM && !actor.testUserPermission?.(game.user, "OBSERVER")) return;

    const openTable = () => openCraftingBench(actor);
    params.tabContentsElement?.querySelector(".crafting-table-tidy-tab-open")?.addEventListener("click", openTable);

    const tabControl = params.element?.querySelector(`[data-tab-id="${tabId}"]`);
    if (!tabControl || tabControl.dataset.craftingTableBound === "true") return;
    tabControl.dataset.craftingTableBound = "true";

    const activate = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openTable();
    };
    tabControl.addEventListener("click", activate, { capture: true });
    tabControl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    }, { capture: true });
  }

  function register(api) {
    if (registered) return;
    if (!api?.registerCharacterTab || !api?.models?.HtmlTab) return;

    try {
      api.registerCharacterTab(new api.models.HtmlTab({
        title: game.i18n.localize("CRAFTINGTABLE.CraftingTable"),
        iconClass: "fas fa-hammer",
        tabId,
        html: `
          <div class="crafting-table-tidy-tab-launcher">
            <button type="button" class="crafting-table-tidy-tab-open">
              <i class="fas fa-hammer"></i>
              ${game.i18n.localize("CRAFTINGTABLE.OpenTable")}
            </button>
          </div>
        `,
        onRender(params) {
          bindTabLauncher(params);
        }
      }));
      registered = true;
    } catch (error) {
      console.warn(`${moduleId} | Could not register the Tidy 5e character tab`, error);
    }
  }

  function isTidyCharacterSheet(app) {
    const api = game.modules.get("tidy5e-sheet")?.api;
    if (!api?.isTidy5eCharacterSheet) return false;
    return api.isTidy5eCharacterSheet(app);
  }

  return {
    register,
    isTidyCharacterSheet,
    get registered() {
      return registered;
    }
  };
}
