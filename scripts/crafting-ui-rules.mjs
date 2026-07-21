function normalizeText(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function titleCase(value = "") {
  return String(value ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base" });
}

export function deduplicatePlayerRecipeSources(entries = []) {
  const seenIdentities = new Set();
  const unique = [];

  for (const entry of entries ?? []) {
    const identities = Array.from(new Set((entry.identityKeys ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)));
    const matchesIdentity = identities.some((identity) => seenIdentities.has(identity));
    if (matchesIdentity) continue;

    unique.push(entry);
    for (const identity of identities) seenIdentities.add(identity);
  }

  return unique;
}

export function filterPlayerRecipeSummaries(recipes = [], {
  category = "all",
  visibility = "all",
  search = ""
} = {}) {
  const normalizedSearch = normalizeText(search);
  return (recipes ?? []).filter((recipe) => {
    if (category !== "all" && recipe.category !== category) return false;
    if (visibility === "known" && !recipe.known) return false;
    if (normalizedSearch && !normalizeText(recipe.name).includes(normalizedSearch)) return false;
    return true;
  });
}

export function buildPlayerCategories(recipes = [], { activeCategory = "all" } = {}) {
  const counts = new Map();
  for (const recipe of recipes ?? []) {
    counts.set(recipe.category, (counts.get(recipe.category) ?? 0) + 1);
  }
  if (activeCategory !== "all" && !counts.has(activeCategory)) counts.set(activeCategory, 0);
  return Array.from(counts.entries())
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, count]) => ({
      id,
      label: titleCase(id),
      count,
      active: activeCategory === id
    }));
}

export function normalizeGmActiveTab(activeTab, allowedTabs = ["recipes", "requests", "import-export"]) {
  return allowedTabs.includes(activeTab) ? activeTab : (allowedTabs[0] ?? "recipes");
}

export function filterCraftRequests(requests = [], {
  search = "",
  status = "all"
} = {}) {
  const normalizedSearch = normalizeText(search);
  return (requests ?? []).filter((request) => {
    if (status !== "all" && request.status !== status) return false;
    if (!normalizedSearch) return true;
    const haystack = [request.actorName, request.recipeName, request.statusLabel, request.status]
      .map((value) => normalizeText(value))
      .join(" ");
    return haystack.includes(normalizedSearch);
  });
}

export function sortCraftRequests(requests = [], { sort = "updatedDesc" } = {}) {
  const sorted = [...(requests ?? [])];
  sorted.sort((left, right) => {
    if (sort === "updatedAsc") return (left.updatedTime - right.updatedTime) || compareText(left.recipeName, right.recipeName);
    if (sort === "actor") return compareText(left.actorName, right.actorName) || compareText(left.recipeName, right.recipeName);
    if (sort === "recipe") return compareText(left.recipeName, right.recipeName) || compareText(left.actorName, right.actorName);
    if (sort === "status") return compareText(left.status, right.status) || (right.updatedTime - left.updatedTime);
    return (right.updatedTime - left.updatedTime) || compareText(left.recipeName, right.recipeName);
  });
  return sorted;
}

export function summarizeCraftRequests(requests = []) {
  const summary = { total: 0, pending: 0, approved: 0, processing: 0, rejected: 0, completed: 0 };
  for (const request of requests ?? []) {
    summary.total += 1;
    if (Object.hasOwn(summary, request.status)) summary[request.status] += 1;
  }
  return summary;
}

export function filterAndSortOngoingCrafts(crafts = [], {
  search = "",
  sort = "updatedDesc"
} = {}) {
  const normalizedSearch = normalizeText(search);
  const filtered = (crafts ?? []).filter((craft) => {
    if (!normalizedSearch) return true;
    const haystack = [craft.actorName, craft.recipeName].map((value) => normalizeText(value)).join(" ");
    return haystack.includes(normalizedSearch);
  });
  filtered.sort((left, right) => {
    if (sort === "updatedAsc") return (left.updatedTime - right.updatedTime) || compareText(left.recipeName, right.recipeName);
    if (sort === "actor") return compareText(left.actorName, right.actorName) || compareText(left.recipeName, right.recipeName);
    if (sort === "recipe") return compareText(left.recipeName, right.recipeName) || compareText(left.actorName, right.actorName);
    if (sort === "progress") return (right.percent - left.percent) || (right.updatedTime - left.updatedTime);
    return (right.updatedTime - left.updatedTime) || compareText(left.recipeName, right.recipeName);
  });
  return filtered;
}
