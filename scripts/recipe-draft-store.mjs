export class RecipeDraftStore {
  #drafts = new Map();
  #dirty = new Set();

  get size() {
    return this.#drafts.size;
  }

  get(uuid) {
    return this.#drafts.get(uuid);
  }

  has(uuid) {
    return this.#drafts.has(uuid);
  }

  set(uuid, draft) {
    if (!uuid) return this;
    this.#drafts.set(uuid, draft);
    if (draft?.dirty) this.#dirty.add(uuid);
    return this;
  }

  markDirty(uuid) {
    if (!uuid) return false;
    this.#dirty.add(uuid);
    const draft = this.#drafts.get(uuid);
    if (draft) draft.dirty = true;
    return true;
  }

  isDirty(uuid) {
    return Boolean(uuid && (this.#dirty.has(uuid) || this.#drafts.get(uuid)?.dirty));
  }

  hasUnsavedChanges() {
    return this.#dirty.size > 0 || [...this.#drafts.values()].some((draft) => draft?.dirty);
  }

  discard(uuid) {
    if (!uuid) return false;
    const existed = this.#drafts.delete(uuid);
    this.#dirty.delete(uuid);
    return existed;
  }

  clear() {
    this.#drafts.clear();
    this.#dirty.clear();
  }
}
