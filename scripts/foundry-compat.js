export function addDelegatedListener(root, type, selector, listener, options = {}) {
  root?.addEventListener(type, (event) => {
    const origin = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const target = origin?.closest?.(selector);
    if (!target || !root.contains(target)) return;
    return listener(event, target);
  }, options);
}

export async function confirmCraftingAction(message, title = "Crafting Table") {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    return DialogV2.confirm({
      window: { title },
      content: `<p>${escapeHtml(message)}</p>`,
      modal: true
    });
  }
  return window.confirm(message);
}

function escapeHtml(value) {
  const element = document.createElement("textarea");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}
