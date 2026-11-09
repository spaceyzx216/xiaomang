import type { PublishSelection } from "./publishWarehouseApi";

export type PublishSelectionPatch = {
  cover?: Partial<PublishSelection["cover"]>;
  publishCopy?: PublishSelection["publishCopy"];
  topicTags?: PublishSelection["topicTags"];
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Topic = { id: string; title: string };
type Entry = {
  selection: PublishSelection;
  dirty: PublishSelectionPatch;
  pending: PublishSelectionPatch;
  // Keep changed fields even after saving: an older initial GET may finish later.
  touched: PublishSelectionPatch;
  running?: Promise<void>;
  error: string;
  cacheError: string;
  coverRecovery: boolean;
};

export type PublishDraftSnapshot = {
  selections: Record<string, PublishSelection>;
  saving: string[];
  unsaved: string[];
  errors: Record<string, string>;
  cacheError: string;
};

const emptySelection = (topic: Topic): PublishSelection => ({
  topicId: topic.id,
  title: topic.title,
  cover: { selectedId: "", candidates: [], titleStyle: null },
  publishCopy: { items: [], selected: [] },
  topicTags: { groups: [], selected: [], missing: [] },
  updatedAt: "",
});

const hasPatch = (patch: PublishSelectionPatch) => Object.keys(patch).length > 0;

const mergePatch = (previous: PublishSelectionPatch, next: PublishSelectionPatch): PublishSelectionPatch => ({
  ...previous,
  ...next,
  ...(next.cover ? { cover: { ...previous.cover, ...next.cover } } : {}),
});

const applyPatch = (selection: PublishSelection, patch: PublishSelectionPatch): PublishSelection => ({
  ...selection,
  ...patch,
  cover: { ...selection.cover, ...patch.cover },
});

/** Per-user/customer/topic drafts and serial writes. Images stay in memory only. */
export class PublishSelectionDrafts {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(snapshot: PublishDraftSnapshot) => void>();
  private active = true;

  constructor(
    private scope: { userId: string; customerId: string },
    topics: Topic[],
    private storage: DraftStorage | undefined,
    private save: (topicId: string, title: string, patch: PublishSelectionPatch) => Promise<PublishSelection>,
  ) {
    for (const topic of topics) {
      if (!topic.id) continue;
      let dirty: PublishSelectionPatch = {};
      let coverRecovery = false;
      try {
        const cached = JSON.parse(this.storage?.getItem(this.key(topic.id)) || "null");
        // Read only our small, versioned patch shape; never restore cached images.
        if (cached?.version === 1 && cached.patch && typeof cached.patch === "object") {
          coverRecovery = cached.coverNotCached === true;
          if (!coverRecovery && typeof cached.patch.cover?.selectedId === "string") dirty.cover = { selectedId: cached.patch.cover.selectedId };
          if (Array.isArray(cached.patch.publishCopy?.items) && Array.isArray(cached.patch.publishCopy?.selected)) {
            dirty.publishCopy = cached.patch.publishCopy;
          }
          if (Array.isArray(cached.patch.topicTags?.groups) && Array.isArray(cached.patch.topicTags?.selected)) {
            dirty.topicTags = cached.patch.topicTags;
          }
        }
      } catch { /* An invalid/unavailable cache must not prevent opening the page. */ }
      this.entries.set(topic.id, {
        selection: applyPatch(emptySelection(topic), dirty), dirty, pending: dirty, touched: dirty,
        error: hasPatch(dirty) ? "上次的选择尚未保存，请重试" : "",
        cacheError: coverRecovery ? "上次未保存的封面图片或候选变更无法恢复，请重新生成或选择封面" : "",
        coverRecovery,
      });
    }
  }

  private key(topicId: string) {
    return `publishSelectionDraft:v1:${encodeURIComponent(this.scope.userId)}:${encodeURIComponent(this.scope.customerId)}:${encodeURIComponent(topicId)}`;
  }

  private cache(topicId: string, entry: Entry) {
    // An absent identity must never create a shared anonymous draft.
    if (!this.active || !this.scope.userId || !this.scope.customerId) return;
    const fullCoverChange = Boolean(entry.dirty.cover && Object.keys(entry.dirty.cover).some(key => key !== "selectedId"));
    const coverNotCached = fullCoverChange || entry.coverRecovery;
    const patch: PublishSelectionPatch = {
      ...(entry.dirty.cover && !fullCoverChange ? { cover: { selectedId: entry.dirty.cover.selectedId ?? entry.selection.cover.selectedId } } : {}),
      ...(entry.dirty.publishCopy ? { publishCopy: entry.dirty.publishCopy } : {}),
      ...(entry.dirty.topicTags ? { topicTags: entry.dirty.topicTags } : {}),
    };
    try {
      if (!this.storage) throw new Error("浏览器缓存不可用");
      if (hasPatch(patch) || coverNotCached) this.storage.setItem(this.key(topicId), JSON.stringify({ version: 1, patch, coverNotCached }));
      else this.storage.removeItem(this.key(topicId));
      entry.cacheError = entry.coverRecovery
        ? "上次未保存的封面图片或候选变更无法恢复，请重新生成或选择封面"
        : fullCoverChange ? "封面图片或候选变更尚未保存，刷新后需重新生成或选择封面" : "";
    } catch {
      entry.cacheError = "浏览器未能缓存选择，保存成功前请勿刷新页面";
    }
  }

  snapshot(): PublishDraftSnapshot {
    const snapshot: PublishDraftSnapshot = { selections: {}, saving: [], unsaved: [], errors: {}, cacheError: "" };
    for (const [topicId, entry] of this.entries) {
      snapshot.selections[topicId] = entry.selection;
      if (entry.running) snapshot.saving.push(topicId);
      if (hasPatch(entry.dirty)) snapshot.unsaved.push(topicId);
      if (entry.error) snapshot.errors[topicId] = entry.error;
      if (entry.cacheError) snapshot.cacheError = entry.cacheError;
    }
    return snapshot;
  }

  subscribe(listener: (snapshot: PublishDraftSnapshot) => void) {
    this.active = true;
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.active = false;
    };
  }

  private emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  get(topicId: string) { return this.entries.get(topicId)?.selection; }

  hydrate(items: PublishSelection[]) {
    for (const saved of items) {
      const entry = this.entries.get(saved.topicId);
      if (entry) entry.selection = applyPatch(saved, entry.touched);
    }
    this.emit();
  }

  update(topicId: string, patchOrUpdater: PublishSelectionPatch | ((current: PublishSelection) => PublishSelectionPatch)) {
    const entry = this.entries.get(topicId);
    if (!this.active || !entry || !this.scope.userId || !this.scope.customerId) return Promise.reject(new Error("未读到用户或客户信息，无法保存选择"));
    const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(entry.selection) : patchOrUpdater;
    if (patch.cover) entry.coverRecovery = false;
    entry.selection = applyPatch(entry.selection, patch);
    entry.dirty = mergePatch(entry.dirty, patch);
    entry.pending = mergePatch(entry.pending, patch);
    entry.touched = mergePatch(entry.touched, patch);
    entry.error = "";
    this.cache(topicId, entry);
    this.emit();
    return this.flush(topicId);
  }

  async flush(topicId?: string): Promise<void> {
    if (!topicId) {
      // A topic that finished early may be edited while another topic is saving.
      do {
        await Promise.all([...this.entries.keys()].map(id => this.flush(id)));
      } while ([...this.entries.values()].some(entry => entry.running || hasPatch(entry.pending)));
      return;
    }
    const entry = this.entries.get(topicId);
    if (!entry) return;
    if (!entry.running && hasPatch(entry.pending)) {
      entry.error = "";
      entry.running = Promise.resolve().then(async () => {
        while (hasPatch(entry.pending)) {
          const patch = entry.pending;
          entry.pending = {};
          try {
            if (!this.active) throw new Error("页面已切换，未保存的选择已保留在原用户缓存中");
            const saved = await this.save(topicId, entry.selection.title, patch);
            if (!hasPatch(entry.pending)) entry.dirty = {};
            entry.selection = applyPatch(saved, entry.dirty);
            this.cache(topicId, entry);
            this.emit();
          } catch (error) {
            entry.pending = mergePatch(patch, entry.pending);
            entry.error = error instanceof Error ? error.message : "发布仓保存失败";
            this.cache(topicId, entry);
            throw error;
          }
        }
      }).finally(() => {
        entry.running = undefined;
        this.emit();
      });
      this.emit();
    }
    await entry.running;
    // A click can arrive between finishing one drain and resuming its caller.
    if (hasPatch(entry.pending)) await this.flush(topicId);
  }
}
