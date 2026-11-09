import { useEffect, useState } from "react";

/**
 * 阶段草稿：用法和 `useState` 一样，但会把值同步一份到 sessionStorage。
 *
 * 账号定位是一条任务流，而 `AccountPositioningPage` 只渲染当前阶段 —— 阶段之间来回切时
 * 组件会被卸载重建。用普通 `useState` 的话，从第二步退回第一步，之前分析出来的报告就没了。
 * 草稿把值留在 sessionStorage 里，组件重建时读回来：**同一个任务内可以随便来回走，
 * 刷新页面也不会丢**，关掉标签页才清空。
 *
 * 只应该放「用户不想重新做一遍」的东西（输入、分析结果、勾选）。
 * loading / error / 保存中 这些瞬时状态不要放进来。
 */
export const STAGE_DRAFT_PREFIX = "xm_stage_draft_";

const storageAvailable = () => typeof window !== "undefined" && Boolean(window.sessionStorage);

const readDraft = <T,>(storageKey: string, initial: T): T => {
  if (!storageAvailable()) return initial;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return initial;
    return JSON.parse(raw) as T;
  } catch {
    // 解析失败（旧格式、被手改过）就当成没有草稿，不能因此白屏。
    return initial;
  }
};

const writeDraft = (storageKey: string, value: unknown) => {
  if (!storageAvailable()) return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 配额超了（报告体积不小）或隐私模式禁用存储：静默降级成纯内存。
    // 草稿存不下只是「刷新后要重做」，不该让功能直接坏掉。
  }
};

export function useStageDraft<T>(key: string, initial: T) {
  const storageKey = `${STAGE_DRAFT_PREFIX}${key}`;
  const [value, setValue] = useState<T>(() => readDraft(storageKey, initial));

  useEffect(() => {
    writeDraft(storageKey, value);
  }, [storageKey, value]);

  return [value, setValue] as const;
}

/** 清掉所有阶段草稿。退出登录、切换账号时必须调，否则会把上一个人的数据带过来。 */
export const clearStageDrafts = () => {
  if (!storageAvailable()) return;
  try {
    const keys = Object.keys(window.sessionStorage).filter(key => key.startsWith(STAGE_DRAFT_PREFIX));
    keys.forEach(key => window.sessionStorage.removeItem(key));
  } catch {
    // 读不到就算了，退出登录本身不该失败。
  }
};
