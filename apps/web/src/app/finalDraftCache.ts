export type CachedFinalDraft = {
  id: string;
  createdAt: string;
  titleDraft?: string;
  hookDraft?: string;
  /** 结尾钩子（与 3 秒留存分开，导出到飞书是两列）。 */
  endingHookDraft?: string;
  scriptDraft?: string;
  rewriteDraft?: string;
  translationDraft?: string;
  benchmarkVideos?: Array<Record<string, unknown>>;
  /** 发布仓三块产出（3.1 封面 / 3.2 发布文案 / 3.3 发布标签），随草稿一起缓存待导出。 */
  publishWarehouse?: Record<string, unknown> | null;
  taskInfo?: Record<string, unknown> | null;
};

const CACHE_KEY = "xiaomang.finalDrafts";
const MAX_ITEMS = 200;

const safeParse = (raw: string | null): CachedFinalDraft[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const readCachedFinalDrafts = (): CachedFinalDraft[] => {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(CACHE_KEY));
};

export const writeCachedFinalDrafts = (items: CachedFinalDraft[]) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CACHE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
};

export const cacheFinalDraft = (item: CachedFinalDraft) => {
  if (!item?.id) return;
  const current = readCachedFinalDrafts().filter(draft => draft.id !== item.id);
  writeCachedFinalDrafts([item, ...current]);
};

export const removeCachedFinalDraft = (id: string) => {
  if (!id) return;
  writeCachedFinalDrafts(readCachedFinalDrafts().filter(item => item.id !== id));
};

export const clearCachedFinalDrafts = () => {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(CACHE_KEY);
};
