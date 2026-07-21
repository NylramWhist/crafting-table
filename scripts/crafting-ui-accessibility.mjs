const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const IDENTITY_ATTRIBUTES = Object.freeze([
  "name",
  "data-action",
  "data-tab",
  "data-category",
  "data-recipe-uuid",
  "data-collapse-toggle",
  "data-gm-filter",
  "data-page",
  "data-optional-ingredient-index"
]);

const responsiveBindings = new WeakMap();

export const APPLICATION_WIDTH_BREAKPOINTS = Object.freeze({
  compact: 680,
  normal: 1000,
  wide: 1280
});

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getApplicationWidthMode(width, breakpoints = APPLICATION_WIDTH_BREAKPOINTS) {
  const measuredWidth = Math.max(0, finiteNumber(width, 0));
  if (measuredWidth >= finiteNumber(breakpoints.wide, APPLICATION_WIDTH_BREAKPOINTS.wide)) return "wide";
  if (measuredWidth >= finiteNumber(breakpoints.normal, APPLICATION_WIDTH_BREAKPOINTS.normal)) return "normal";
  if (measuredWidth >= finiteNumber(breakpoints.compact, APPLICATION_WIDTH_BREAKPOINTS.compact)) return "compact";
  return "mobile";
}

function setWidthMode(element, mode) {
  if (!element) return;
  if (element.dataset) element.dataset.ctWidthMode = mode;
  else element.setAttribute?.("data-ct-width-mode", mode);
  for (const candidate of ["wide", "normal", "compact", "mobile"]) {
    element.classList?.toggle?.(`is-width-${candidate}`, candidate === mode);
  }
}

function syncApplicationWidthMode(app, binding, measuredWidth = null) {
  const target = app?.element;
  if (!target) return null;
  const fallbackWidth = target.getBoundingClientRect?.().width ?? app.position?.width ?? binding.options.preferredWidth;
  const width = measuredWidth === null || measuredWidth === undefined
    ? finiteNumber(fallbackWidth, 0)
    : finiteNumber(measuredWidth, fallbackWidth);
  const mode = getApplicationWidthMode(width, binding.options.widthBreakpoints);
  const layoutRoot = binding.options.layoutRootSelector
    ? target.querySelector?.(binding.options.layoutRootSelector)
    : target;
  setWidthMode(target, mode);
  if (layoutRoot !== target) setWidthMode(layoutRoot, mode);
  if (mode !== binding.widthMode) {
    const previousMode = binding.widthMode;
    binding.widthMode = mode;
    binding.options.onWidthModeChange?.(mode, previousMode);
  }
  return mode;
}

export function fitApplicationPosition({
  viewportWidth,
  viewportHeight,
  preferredWidth,
  preferredHeight,
  minimumWidth = 320,
  minimumHeight = 360,
  margin = 12
} = {}) {
  const screenWidth = Math.max(1, finiteNumber(viewportWidth, 1280));
  const screenHeight = Math.max(1, finiteNumber(viewportHeight, 720));
  const safeMargin = Math.max(0, Math.min(finiteNumber(margin, 12), Math.floor(Math.min(screenWidth, screenHeight) / 4)));
  const availableWidth = Math.max(1, screenWidth - (safeMargin * 2));
  const availableHeight = Math.max(1, screenHeight - (safeMargin * 2));
  const requestedWidth = Math.max(Math.min(finiteNumber(minimumWidth, 320), availableWidth), finiteNumber(preferredWidth, availableWidth));
  const requestedHeight = Math.max(Math.min(finiteNumber(minimumHeight, 360), availableHeight), finiteNumber(preferredHeight, availableHeight));
  const width = Math.min(availableWidth, requestedWidth);
  const height = Math.min(availableHeight, requestedHeight);
  return {
    width,
    height,
    left: Math.max(safeMargin, Math.round((screenWidth - width) / 2)),
    top: Math.max(safeMargin, Math.round((screenHeight - height) / 2))
  };
}

function getFocusableElements(root) {
  return root?.querySelectorAll ? Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)) : [];
}

function getIdentity(element) {
  const attributes = {};
  for (const name of IDENTITY_ATTRIBUTES) {
    const value = element?.getAttribute?.(name);
    if (value !== null && value !== undefined && value !== "") attributes[name] = value;
  }
  return attributes;
}

function identitiesMatch(element, identity) {
  return Object.entries(identity).every(([name, value]) => element?.getAttribute?.(name) === value);
}

export function captureFocusState(root, activeElement = root?.ownerDocument?.activeElement) {
  if (!root || !activeElement || !root.contains?.(activeElement)) return null;
  const focusable = getFocusableElements(root);
  const identity = getIdentity(activeElement);
  const candidates = Object.keys(identity).length
    ? focusable.filter((element) => identitiesMatch(element, identity))
    : focusable;
  const occurrence = Math.max(0, candidates.indexOf(activeElement));
  const state = { identity, occurrence, fallbackIndex: Math.max(0, focusable.indexOf(activeElement)) };
  if (typeof activeElement.selectionStart === "number") {
    state.selectionStart = activeElement.selectionStart;
    state.selectionEnd = activeElement.selectionEnd;
  }
  return state;
}

export function restoreFocusState(root, state) {
  if (!root || !state) return false;
  const focusable = getFocusableElements(root);
  const matching = Object.keys(state.identity ?? {}).length
    ? focusable.filter((element) => identitiesMatch(element, state.identity))
    : focusable;
  const target = matching[state.occurrence] ?? focusable[state.fallbackIndex] ?? null;
  if (!target?.focus) return false;
  target.focus({ preventScroll: true });
  if (typeof target.setSelectionRange === "function" && typeof state.selectionStart === "number") {
    const end = typeof state.selectionEnd === "number" ? state.selectionEnd : state.selectionStart;
    target.setSelectionRange(state.selectionStart, end);
  }
  return true;
}

export function handleTabListKeydown(event) {
  const current = event?.target?.closest?.("[role='tab']");
  const tabList = current?.closest?.("[role='tablist']");
  if (!current || !tabList) return false;
  const tabs = Array.from(tabList.querySelectorAll("[role='tab']")).filter((tab) => !tab.disabled);
  const index = tabs.indexOf(current);
  if (index < 0 || !tabs.length) return false;

  let nextIndex = null;
  if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (index + 1) % tabs.length;
  else if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  if (nextIndex === null) return false;

  event.preventDefault?.();
  tabs[nextIndex].focus?.();
  tabs[nextIndex].click?.();
  return true;
}

export function bindResponsiveApplication(app, options = {}) {
  const ownerWindow = app?.element?.ownerDocument?.defaultView ?? globalThis.window;
  if (!app?.setPosition || !ownerWindow?.addEventListener) return false;
  const existing = responsiveBindings.get(app);
  if (existing?.ownerWindow === ownerWindow) {
    existing.options = { ...existing.options, ...options };
    syncApplicationWidthMode(app, existing);
    return true;
  }
  existing?.controller.abort();

  const initialPosition = app.position ?? {};
  const binding = {
    controller: new AbortController(),
    ownerWindow,
    options: { ...options },
    timer: null,
    desiredWidth: initialPosition.width ?? options.preferredWidth,
    desiredHeight: initialPosition.height ?? options.preferredHeight,
    lastApplied: null,
    resizeObserver: null,
    widthMode: null
  };
  const onResize = () => {
    ownerWindow.clearTimeout(binding.timer);
    binding.timer = ownerWindow.setTimeout(() => {
      const position = app.position ?? {};
      if (binding.lastApplied && position.width !== binding.lastApplied.width) binding.desiredWidth = position.width;
      if (binding.lastApplied && position.height !== binding.lastApplied.height) binding.desiredHeight = position.height;
      const nextPosition = fitApplicationPosition({
        viewportWidth: ownerWindow.innerWidth,
        viewportHeight: ownerWindow.innerHeight,
        preferredWidth: binding.desiredWidth ?? binding.options.preferredWidth,
        preferredHeight: binding.desiredHeight ?? binding.options.preferredHeight,
        minimumWidth: binding.options.minimumWidth,
        minimumHeight: binding.options.minimumHeight,
        margin: binding.options.margin
      });
      binding.lastApplied = nextPosition;
      app.setPosition(nextPosition);
      syncApplicationWidthMode(app, binding, nextPosition.width);
    }, 80);
  };
  ownerWindow.addEventListener("resize", onResize, { signal: binding.controller.signal });
  const ResizeObserverClass = ownerWindow.ResizeObserver ?? globalThis.ResizeObserver;
  if (typeof ResizeObserverClass === "function") {
    binding.resizeObserver = new ResizeObserverClass((entries) => {
      const entry = entries?.find?.((candidate) => candidate.target === app.element) ?? entries?.[0];
      const borderBox = Array.isArray(entry?.borderBoxSize) ? entry.borderBoxSize[0] : entry?.borderBoxSize;
      syncApplicationWidthMode(app, binding, borderBox?.inlineSize ?? entry?.contentRect?.width);
    });
    binding.resizeObserver.observe(app.element);
  }
  responsiveBindings.set(app, binding);
  syncApplicationWidthMode(app, binding);
  return true;
}

export function releaseResponsiveApplication(app) {
  const binding = responsiveBindings.get(app);
  if (!binding) return false;
  binding.ownerWindow.clearTimeout(binding.timer);
  binding.resizeObserver?.disconnect?.();
  binding.controller.abort();
  responsiveBindings.delete(app);
  return true;
}
