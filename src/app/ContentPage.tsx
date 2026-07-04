import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiUrl, fetchWithRetry } from "./api";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./components/ui/accordion";
import { Loader2, FileText, Layers, CheckCircle2, Sparkles, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { clearCachedFinalDrafts, readCachedFinalDrafts } from "./finalDraftCache";

type TopicLike = {
  id?: string;
  platform?: "douyin" | "wechat_channels" | "tiktok";
  title?: string;
  authorName?: string;
  link?: string;
  stats?: {
    comments?: number;
    likes?: number;
    shares?: number;
    bookmarks?: number;
  };
  publishDate?: string;
  hotTopics?: string[];
  source?: {
    platform?: string;
    objectId?: string;
    objectNonceId?: string;
    finderUsername?: string;
    mediaUrl?: string;
    decodeKey?: string;
    coverUrl?: string;
  };
  rawData?: any;
};

type BenchmarkVideo = {
  title: string;
  link: string;
  coverUrl: string;
  durationSeconds: number;
  authorName: string;
  publishDate: string;
  likes: number;
  comments: number;
  shares: number;
  bookmarks: number;
  hotTopics: string[];
};

type WorkflowHook = {
  id: string;
  content: string;
  hookType: "opening_text" | "ending_text" | "unknown";
};

type WorkflowResult = {
  titles: string[];
  hooks: WorkflowHook[];
  scripts: Array<{ id: string; title: string; content: string }>;
};

type WorkflowResultGroup = {
  id: string;
  shareLink: string;
  result: WorkflowResult;
};

type RunWorkflowOptions = {
  force?: boolean;
};

type TranslationItem = {
  id: string;
  zh: string;
  en: string;
  sourceType: "title" | "hook" | "script";
  original?: string;
  translated?: string;
};

type RewritePlatform = "douyin" | "xiaohongshu" | "wechat";

const fallbackResult: WorkflowResult = {
  titles: [],
  hooks: [],
  scripts: [],
};

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const mockStyles = [
  {
    id: "style-1",
    label: "专业理性",
    text: "突出数据优势，强调方案可行性与执行路径。",
  },
  {
    id: "style-2",
    label: "轻量口播",
    text: "用简洁语言突出卖点，强调易理解与易传播。",
  },
];

const splitByLine = (input?: string) =>
  String(input || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);

const toPreview = (text: string, max = 80) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

const normalizeTitleLine = (line: string) =>
  String(line || "")
    .replace(/^[-]{2,}\s*$/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^\*+\s*/, "")
    .replace(/\*+$/, "")
    .trim();

const extractQuotedTitle = (line: string) => {
  const match = String(line || "").match(/《([^》]+)》/);
  return match?.[1]?.trim() || "";
};

const splitInlineTitleDetail = (value: string) => {
  const text = normalizeTitleLine(value);
  const detailStart = text.search(/(?:类型|优势|技巧)[:：]|【/);
  if (detailStart < 0) return { title: text.trim(), rest: "" };
  return {
    title: text.slice(0, detailStart).trim(),
    rest: text.slice(detailStart).trim(),
  };
};

const normalizeTitleType = (value: string) =>
  normalizeTitleLine(value)
    .replace(/[+＋/|]/g, "、")
    .replace(/\s*、\s*/g, "、")
    .replace(/^类型[:：]\s*/, "")
    .replace(/[。；;，,]\s*$/, "")
    .trim();

const readInlineField = (text: string, label: "类型" | "优势" | "技巧") => {
  const pattern = new RegExp(`${label}[:：]\\s*([\\s\\S]*?)(?=(?:类型|优势|技巧)[:：]|$)`);
  const matched = text.match(pattern)?.[1] || "";
  return normalizeTitleLine(matched)
    .replace(/[。；;]\s*$/, "")
    .trim();
};

const parseTitleStartLine = (line: string) => {
  const normalized = normalizeTitleLine(line)
    .replace(/^\d+\s*[\.、]?\s*/, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/^标题\s*/, "")
    .trim();
  const quoted = extractQuotedTitle(normalized);
  const closeIndex = normalized.indexOf("》");
  const restAfterQuote = quoted && closeIndex >= 0 ? normalized.slice(closeIndex + 1).trim() : "";
  const split = quoted ? { title: quoted, rest: restAfterQuote } : splitInlineTitleDetail(normalized);
  const bracketType = split.rest.match(/【([^】]+)】/)?.[1] || "";

  return {
    title: split.title.replace(/^《?\s*/, "").replace(/\s*》?$/, "").trim(),
    type: normalizeTitleType(readInlineField(split.rest, "类型") || bracketType),
    advantage: readInlineField(split.rest, "优势"),
    skill: readInlineField(split.rest, "技巧"),
  };
};

const parseTitleBlocks = (titleText: string) => {
  const lines = splitByLine(titleText)
    .map(normalizeTitleLine)
    .filter(Boolean)
    .filter(line => !line.includes("爆款标题") && line !== "---");

  const blocks: Array<{ title: string; type: string; advantage: string; skill: string }> = [];
  let current: { title: string; type: string; advantage: string; skill: string } | null = null;

  const pushCurrent = () => {
    if (!current?.title) return;
    blocks.push({ ...current });
  };

  for (const line of lines) {
    const isBlockStart = /^\d+\s*[\.、]/.test(line) || /^标题[:：]/.test(line);

    if (isBlockStart) {
      pushCurrent();
      current = parseTitleStartLine(line);
      continue;
    }

    if (!current) continue;

    if (/^\*?\*?标题\*?\*?[:：]/.test(line)) {
      const parsed = parseTitleStartLine(line.replace(/^\*?\*?标题\*?\*?[:：]\s*/, ""));
      current.title = parsed.title || current.title;
      current.type ||= parsed.type;
      current.advantage ||= parsed.advantage;
      current.skill ||= parsed.skill;
      continue;
    }

    if (/^\*?\*?类型\*?\*?[:：]/.test(line)) {
      current.type = normalizeTitleType(line.replace(/^\*?\*?类型\*?\*?[:：]\s*/, ""));
      continue;
    }

    if (/^\*?\*?优势\*?\*?[:：]/.test(line)) {
      current.advantage = line.replace(/^\*?\*?优势\*?\*?[:：]\s*/, "").trim();
      continue;
    }

    if (/^\*?\*?技巧\*?\*?[:：]/.test(line)) {
      current.skill = line.replace(/^\*?\*?技巧\*?\*?[:：]\s*/, "").trim();
      continue;
    }
  }

  pushCurrent();

  return blocks.map((item, index) => {
    const detailLines = [
      item.type ? `类型：${item.type}` : "",
      item.advantage ? `优势：${item.advantage}` : "",
      item.skill ? `技巧：${item.skill}` : "",
    ].filter(Boolean);

    const titleLine = `${index + 1}. ${item.title}`;
    return [titleLine, ...detailLines].join("\n");
  });
};

const extractTitleLabel = (titleBlock: string) => {
  const firstLine = normalizeTitleLine(splitByLine(titleBlock)[0] || "");
  const parsed = parseTitleStartLine(firstLine);
  if (parsed.title) return parsed.title;
  const quoted = extractQuotedTitle(firstLine);
  if (quoted) return quoted;
  return firstLine
    .replace(/^\d+\s*[\.、]?\s*/, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/^《?\s*/, "")
    .replace(/\s*》?$/, "")
    .trim();
};

const formatTitleDisplay = (titleBlock: string) => {
  const lines = splitByLine(titleBlock);
  const firstLine = normalizeTitleLine(lines[0] || "");
  const parsed = parseTitleStartLine(firstLine);
  const fallbackLabel = extractTitleLabel(titleBlock);
  const inlineDetailLines = [
    parsed.type ? `类型：${parsed.type}` : "",
    parsed.advantage ? `优势：${parsed.advantage}` : "",
    parsed.skill ? `技巧：${parsed.skill}` : "",
  ].filter(Boolean);

  return {
    titleLabel: parsed.title || fallbackLabel || titleBlock,
    detailLines: lines.length > 1 ? lines.slice(1) : inlineDetailLines,
  };
};

const getTopicShareLink = (topic: TopicLike) => {
  const rawData = topic?.rawData || {};
  return (
    rawData?.share_info?.share_url ||
    rawData?.share_url ||
    rawData?.video?.play_addr?.url_list?.[0] ||
    topic?.link ||
    ""
  );
};

const isWeChatChannelsTopic = (topic: TopicLike) =>
  topic?.platform === "wechat_channels" ||
  topic?.source?.platform === "wechat_channels" ||
  topic?.rawData?.platform === "wechat_channels";

const getTopicWorkflowKey = (topic: TopicLike) => {
  if (!isWeChatChannelsTopic(topic)) return getTopicShareLink(topic);
  const rawData = topic?.rawData || {};
  const source = topic?.source || {};
  const id =
    source.objectId ||
    rawData.id ||
    rawData.object_id ||
    rawData.objectId ||
    topic.id ||
    source.objectNonceId ||
    rawData.object_nonce_id ||
    rawData.objectNonceId ||
    topic.title ||
    "topic";
  return `wechat_channels:${String(id).replace(/^wechat_channels:/, "")}`;
};

const describeTopicSource = (topic: TopicLike) => {
  if (!isWeChatChannelsTopic(topic)) return getTopicShareLink(topic);
  const source = topic?.source || {};
  return [
    source.finderUsername ? `finderUsername: ${source.finderUsername}` : "",
    source.objectId ? `objectId: ${source.objectId}` : "",
    source.objectNonceId ? `objectNonceId: ${source.objectNonceId}` : "",
  ].filter(Boolean).join(" / ");
};

const toNumber = (value: any) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const readStat = (topic: TopicLike, statKey: keyof NonNullable<TopicLike["stats"]>, rawKeys: string[]) => {
  const rawData = topic?.rawData || {};
  const statBlocks = [
    topic?.stats,
    rawData?.statistics,
    rawData?.stats,
    rawData?.statistics_data,
    rawData?.status,
  ].filter(Boolean);

  for (const block of statBlocks) {
    const direct = (block as any)?.[statKey];
    if (direct !== undefined && direct !== null) return toNumber(direct);
    for (const key of rawKeys) {
      const value = (block as any)?.[key];
      if (value !== undefined && value !== null) return toNumber(value);
    }
  }
  return 0;
};

const normalizePublishDate = (value: any) => {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value);
};

const firstHttpUrl = (...values: any[]): string => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstHttpUrl(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === "object") {
      const nested = firstHttpUrl(value.url_list, value.url, value.uri);
      if (nested) return nested;
      continue;
    }
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
};

const normalizeDurationSeconds = (...values: any[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.round(parsed > 10000 ? parsed / 1000 : parsed);
  }
  return 0;
};

const buildBenchmarkVideos = (topics: TopicLike[]): BenchmarkVideo[] => {
  return topics.map((topic) => {
    const rawData = topic?.rawData || {};
    return {
      title: String(topic?.title || rawData?.desc || rawData?.title || "未命名选题"),
      link: getTopicShareLink(topic),
      coverUrl: firstHttpUrl(
        (topic as any)?.coverUrl,
        (topic as any)?.cover,
        rawData?.cover,
        rawData?.cover_url,
        rawData?.video?.cover,
        rawData?.video?.origin_cover,
        rawData?.video?.dynamic_cover,
        rawData?.video?.animated_cover,
      ),
      durationSeconds: normalizeDurationSeconds(
        (topic as any)?.durationSeconds,
        (topic as any)?.duration,
        rawData?.duration,
        rawData?.video_duration,
        rawData?.video?.duration,
        rawData?.video?.duration_ms,
      ),
      authorName: String(topic?.authorName || rawData?.author?.nickname || rawData?.author_name || "未知"),
      publishDate: normalizePublishDate(topic?.publishDate || rawData?.create_time || rawData?.createTime),
      likes: readStat(topic, "likes", ["digg_count", "like_count", "likes"]),
      comments: readStat(topic, "comments", ["comment_count", "comments"]),
      shares: readStat(topic, "shares", ["share_count", "shares"]),
      bookmarks: readStat(topic, "bookmarks", ["collect_count", "favorite_count", "bookmark_count", "bookmarks"]),
      hotTopics: Array.isArray(topic?.hotTopics) ? topic.hotTopics : [],
    };
  });
};

const sameLink = (a?: string, b?: string) => {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return left === right;
};

const hasWorkflowResult = (group?: WorkflowResultGroup | null) => {
  const result = group?.result;
  return Boolean(
    result &&
      ((Array.isArray(result.titles) && result.titles.length > 0) ||
        (Array.isArray(result.hooks) && result.hooks.length > 0) ||
        (Array.isArray(result.scripts) && result.scripts.length > 0)),
  );
};

const pickReusableWorkflowGroups = (links: string[], groups: WorkflowResultGroup[]) => {
  const used = new Set<number>();
  return links
    .map((link, index) => {
      const groupIndex = groups.findIndex((group, candidateIndex) =>
        !used.has(candidateIndex) && sameLink(group.shareLink, link) && hasWorkflowResult(group),
      );
      if (groupIndex < 0) return null;
      used.add(groupIndex);
      return {
        ...groups[groupIndex],
        id: `link-${index + 1}`,
        shareLink: link,
      };
    })
    .filter(Boolean) as WorkflowResultGroup[];
};

const orderWorkflowGroupsByLinks = (links: string[], groups: WorkflowResultGroup[]) => {
  const used = new Set<number>();
  return links
    .map((link, index) => {
      const groupIndex = groups.findIndex((group, candidateIndex) =>
        !used.has(candidateIndex) && sameLink(group.shareLink, link) && hasWorkflowResult(group),
      );
      if (groupIndex < 0) return null;
      used.add(groupIndex);
      return {
        ...groups[groupIndex],
        id: `link-${index + 1}`,
        shareLink: link,
      };
    })
    .filter(Boolean) as WorkflowResultGroup[];
};

const formatMetric = (value: number) => {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value || 0);
};

const formatBenchmarkVideo = (item: BenchmarkVideo, index: number) => [
  `对标视频 ${index + 1}`,
  `标题：${item.title || "未命名选题"}`,
  `链接：${item.link || "未提供"}`,
  `作者：${item.authorName || "未知"}`,
  item.publishDate ? `发布时间：${item.publishDate}` : "",
  `数据：点赞 ${formatMetric(item.likes)} / 评论 ${formatMetric(item.comments)} / 转发 ${formatMetric(item.shares)} / 收藏 ${formatMetric(item.bookmarks)}`,
  item.hotTopics.length > 0 ? `热词：${item.hotTopics.join("、")}` : "",
].filter(Boolean).join("\n");

const formatBenchmarkSummary = (items: BenchmarkVideo[]) => {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map(formatBenchmarkVideo).join("\n\n");
};

type BitableBinding = {
  targetUrl?: string;
  appToken?: string;
  tableId?: string;
  tableName?: string;
  bitableUrl?: string;
};

const bitableTaskKey = (task: any) => {
  const raw = String(task?._id || task?.customerName || "default").trim() || "default";
  return `xiaomang.feishuBitable.${raw}`;
};

const readBitableBinding = (key: string): BitableBinding => {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeBitableBinding = (key: string, value: BitableBinding) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
};

const parseWorkflowPayload = (payloadText: string): WorkflowResult => {
  const text = String(payloadText || "").trim();
  if (!text) return fallbackResult;

  const startIdx = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

  let obj: any = null;
  try {
    obj = JSON.parse(jsonText);
    if (typeof obj?.output === "string") {
      try {
        obj = JSON.parse(obj.output);
      } catch {
        obj = { output: obj.output };
      }
    }
  } catch {
    obj = { output: text };
  }

  const codeListFieldRaw = obj?.Code_list?.[0]?.fields?.[0];
  const codeListField = (() => {
    if (!codeListFieldRaw) return null;
    if (typeof codeListFieldRaw === "string") {
      try {
        return JSON.parse(codeListFieldRaw);
      } catch {
        return null;
      }
    }
    return codeListFieldRaw;
  })();

  const codeList1FieldRaw = obj?.Code_list1?.[0]?.records?.[0]?.fields;
  const codeList1Field = (() => {
    if (!codeList1FieldRaw) return null;
    if (typeof codeList1FieldRaw === "string") {
      try {
        return JSON.parse(codeList1FieldRaw);
      } catch {
        return null;
      }
    }
    return codeList1FieldRaw;
  })();

  const titleText = String(codeListField?.title || codeList1Field?.标题 || obj?.title || "");
  const titleBlocks = parseTitleBlocks(titleText);
  const titles = (titleBlocks.length > 0 ? titleBlocks : splitByLine(titleText))
    .map(item => item.trim())
    .filter(Boolean);

  const openingHookRaw = codeList1Field?.opening_text || codeList1Field?.开头钩子;
  const endingHookRaw = codeList1Field?.ending_text || codeList1Field?.结尾钩子;

  const openingHooks = (() => {
    if (typeof openingHookRaw !== "object" || !openingHookRaw) {
      const single = String(openingHookRaw || "").trim();
      return single ? [single] : [];
    }

    const extracted = String(openingHookRaw?.extracted || "").trim();
    const created = Array.isArray(openingHookRaw?.created)
      ? openingHookRaw.created.map((item: any) => String(item || "").trim()).filter(Boolean)
      : [];

    return [extracted, ...created].filter(Boolean);
  })();

  const endingHooks = (() => {
    if (typeof endingHookRaw !== "object" || !endingHookRaw) {
      const single = String(endingHookRaw || "").trim();
      return single ? [single] : [];
    }

    const extracted = String(endingHookRaw?.extracted_result || "").trim();
    const rcs = Array.isArray(endingHookRaw?.rcs)
      ? endingHookRaw.rcs.map((item: any) => String(item || "").trim()).filter(Boolean)
      : [];

    return [extracted, ...rcs].filter(item => item && item !== "无");
  })();

  const hooks: WorkflowHook[] = [
    ...openingHooks.map((content, idx) => ({
      id: `hook-opening-${idx + 1}`,
      content,
      hookType: "opening_text" as const,
    })),
    ...endingHooks.map((content, idx) => ({
      id: `hook-ending-${idx + 1}`,
      content,
      hookType: "ending_text" as const,
    })),
  ];

  const primaryScriptContent = String(codeListField?.content || "").trim();
  const scripts = primaryScriptContent
    ? [
        {
          id: "script-1",
          title: "二创文案",
          content: primaryScriptContent,
        },
      ]
    : [];

  if (titles.length === 0 && hooks.length === 0 && scripts.length === 0) {
    const outputText = String(obj?.output || text || "");
    if (!outputText) return fallbackResult;
    return {
      titles: fallbackResult.titles,
      hooks: fallbackResult.hooks,
      scripts: [
        {
          id: "script-1",
          title: "工作流原始输出",
          content: outputText,
        },
      ],
    };
  }

  return {
    titles: titles.length > 0 ? titles : fallbackResult.titles,
    hooks: hooks.length > 0 ? hooks : fallbackResult.hooks,
    scripts: scripts.length > 0 ? scripts : fallbackResult.scripts,
  };
};

const parseWorkflowPayloadGroups = (payloadText: string, links: string[]): WorkflowResultGroup[] => {
  const text = String(payloadText || "").trim();
  if (!text || links.length === 0) return [];

  const startIdx = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

  let obj: any = null;
  try {
    obj = JSON.parse(jsonText);
    if (typeof obj?.output === "string") {
      try {
        obj = JSON.parse(obj.output);
      } catch {
        obj = { output: obj.output };
      }
    }
  } catch {
    obj = { output: text };
  }

  const listFromCodeList = Array.isArray(obj?.Code_list) ? obj.Code_list : [];
  const listFromCodeList1 = Array.isArray(obj?.Code_list1) ? obj.Code_list1 : [];

  const results = links.map((shareLink, index) => {
    const codeItemRaw = listFromCodeList[index]?.fields?.[0];
    const codeItem = (() => {
      if (!codeItemRaw) return null;
      if (typeof codeItemRaw === "string") {
        try {
          return JSON.parse(codeItemRaw);
        } catch {
          return null;
        }
      }
      return codeItemRaw;
    })();

    const code1ItemRaw = listFromCodeList1[index]?.records?.[0]?.fields;
    const code1Item = (() => {
      if (!code1ItemRaw) return null;
      if (typeof code1ItemRaw === "string") {
        try {
          return JSON.parse(code1ItemRaw);
        } catch {
          return null;
        }
      }
      return code1ItemRaw;
    })();

    const titleText = String(codeItem?.title || code1Item?.标题 || "");
    const titleBlocks = parseTitleBlocks(titleText);
    const titles = (titleBlocks.length > 0 ? titleBlocks : splitByLine(titleText))
      .map(item => item.trim())
      .filter(Boolean);

    const openingHookRaw = code1Item?.opening_text || code1Item?.开头钩子;
    const endingHookRaw = code1Item?.ending_text || code1Item?.结尾钩子;

    const openingHooks = (() => {
      if (typeof openingHookRaw !== "object" || !openingHookRaw) {
        const single = String(openingHookRaw || "").trim();
        return single ? [single] : [];
      }

      const extracted = String(openingHookRaw?.extracted || "").trim();
      const created = Array.isArray(openingHookRaw?.created)
        ? openingHookRaw.created.map((item: any) => String(item || "").trim()).filter(Boolean)
        : [];

      return [extracted, ...created].filter(Boolean);
    })();

    const endingHooks = (() => {
      if (typeof endingHookRaw !== "object" || !endingHookRaw) {
        const single = String(endingHookRaw || "").trim();
        return single ? [single] : [];
      }

      const extracted = String(endingHookRaw?.extracted_result || "").trim();
      const rcs = Array.isArray(endingHookRaw?.rcs)
        ? endingHookRaw.rcs.map((item: any) => String(item || "").trim()).filter(Boolean)
        : [];

      return [extracted, ...rcs].filter(item => item && item !== "无");
    })();

    const hooks: WorkflowHook[] = [
      ...openingHooks.map((content, innerIdx) => ({
        id: `hook-opening-${index}-${innerIdx + 1}`,
        content,
        hookType: "opening_text" as const,
      })),
      ...endingHooks.map((content, innerIdx) => ({
        id: `hook-ending-${index}-${innerIdx + 1}`,
        content,
        hookType: "ending_text" as const,
      })),
    ];

    const scriptContent = String(codeItem?.content || "").trim();
    const scripts = scriptContent
      ? [
          {
            id: `script-${index + 1}`,
            title: "二创文案",
            content: scriptContent,
          },
        ]
      : [];

    const result: WorkflowResult = {
      titles,
      hooks,
      scripts,
    };

    return {
      id: `link-${index + 1}`,
      shareLink,
      result,
    };
  });

  return results;
};

export default function ContentPage() {
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [selectedHooks, setSelectedHooks] = useState<string[]>([]);
  const [selectedScripts, setSelectedScripts] = useState<string[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [streamPreview, setStreamPreview] = useState("");
  const [workflowRawDone, setWorkflowRawDone] = useState(() => sessionStorage.getItem("workflowRawDone") || "");
  const [workflowGroups, setWorkflowGroups] = useState<WorkflowResultGroup[]>(() => loadJson<WorkflowResultGroup[]>("contentWorkflowGroups", []));
  const [activeGroupIndex, setActiveGroupIndex] = useState(() => {
    const raw = Number(sessionStorage.getItem("contentActiveGroupIndex") || 0);
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  });
  const [activeScript, setActiveScript] = useState<{ title: string; content: string } | null>(null);

  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationPreview, setTranslationPreview] = useState("");
  const [translationItems, setTranslationItems] = useState<TranslationItem[]>([]);
  const [activeTranslationItem, setActiveTranslationItem] = useState<TranslationItem | null>(null);
  const [translationCopyHint, setTranslationCopyHint] = useState<string | null>(null);
  const [taskCompleteVisible, setTaskCompleteVisible] = useState(false);
  const [pendingDraftCount, setPendingDraftCount] = useState(0);
  const [batchExportLoading, setBatchExportLoading] = useState(false);
  const [batchExportMessage, setBatchExportMessage] = useState<string | null>(null);
  const [bitableTargetUrl, setBitableTargetUrl] = useState("");

  const workflowInFlightRef = useRef(false);
  const workflowRunIdRef = useRef(0);
  const workflowAbortControllerRef = useRef<AbortController | null>(null);
  const autoRunKeyRef = useRef("");

  const [rewriteEnabled, setRewriteEnabled] = useState(false);
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [rewritePreview, setRewritePreview] = useState("");
  const [rewriteTarget, setRewriteTarget] = useState<RewritePlatform>("douyin");
  const [rewriteSelection, setRewriteSelection] = useState<string[]>([]);
  const [rewriteResults, setRewriteResults] = useState<Array<{ id: string; original: string; rewritten: string; target: RewritePlatform }>>([]);

  const navigate = useNavigate();

  const selectedTopics = loadJson<TopicLike[]>("selectedTopics", []);
  const contentTasks = loadJson<any[]>("contentTasks", []);
  const activeTask = contentTasks?.[0];
  const bitableBindingKey = useMemo(() => bitableTaskKey(activeTask), [activeTask?._id, activeTask?.customerName]);
  const [cachedBitableBinding, setCachedBitableBinding] = useState<BitableBinding>(() => readBitableBinding(bitableTaskKey(activeTask)));
  const taskTableName = [
    activeTask?.customerName,
    activeTask?.platformName,
    "选题复盘",
  ].filter(Boolean).join(" - ") || "选题复盘";

  useEffect(() => {
    const binding = readBitableBinding(bitableBindingKey);
    setCachedBitableBinding(binding);
    setBitableTargetUrl(binding.targetUrl || binding.bitableUrl || "");
  }, [bitableBindingKey]);

  const shareLinks = useMemo(() => {
    return selectedTopics
      .filter(topic => !isWeChatChannelsTopic(topic))
      .map(getTopicShareLink)
      .map(link => String(link || "").trim())
      .filter(Boolean);
  }, [selectedTopics]);
  // share_links 来源平台：从所选非视频号 topic 推断，含 tiktok 则标 tiktok，否则默认 douyin。
  // 后端据此为 resolveTikHubVideo 选择正确的 TikHub 端点（/tiktok/ 或 /douyin/）。
  const shareLinkPlatform = useMemo(() => {
    const hasTiktok = selectedTopics.some(topic => !isWeChatChannelsTopic(topic) && topic?.platform === "tiktok");
    return hasTiktok ? "tiktok" : "douyin";
  }, [selectedTopics]);

  const wechatTopics = useMemo(() => selectedTopics.filter(isWeChatChannelsTopic), [selectedTopics]);
  const workflowInputs = useMemo(() => [
    ...shareLinks.map(link => ({ id: link, kind: "share_link" as const, link, topic: null as TopicLike | null })),
    ...wechatTopics.map(topic => ({ id: getTopicWorkflowKey(topic), kind: "wechat_topic" as const, link: "", topic })),
  ], [shareLinks, wechatTopics]);
  const workflowInputIds = useMemo(() => workflowInputs.map(item => item.id), [workflowInputs]);
  const activeGroup = workflowGroups[activeGroupIndex] || null;
  const workflowResult = activeGroup?.result || fallbackResult;
  const benchmarkVideos = useMemo(() => buildBenchmarkVideos(selectedTopics), [selectedTopics]);
  const activeBenchmarkVideos = useMemo(() => {
    const matchedTopics = selectedTopics.filter(topic => sameLink(getTopicWorkflowKey(topic), activeGroup?.shareLink));
    if (matchedTopics.length > 0) return buildBenchmarkVideos(matchedTopics);
    const matched = benchmarkVideos.filter(item => sameLink(item.link, activeGroup?.shareLink));
    return matched.length > 0 ? matched : benchmarkVideos;
  }, [selectedTopics, benchmarkVideos, activeGroup?.shareLink]);

  const toggleSelection = (value: string, list: string[], setList: (v: string[]) => void) => {
    setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  };

  const funnelStatus = useMemo(() => {
    return {
      titleCount: selectedTitles.length,
      hookCount: selectedHooks.length,
      scriptCount: selectedScripts.length,
    };
  }, [selectedTitles, selectedHooks, selectedScripts]);

  useEffect(() => {
    if (!translationEnabled) {
      setTranslationError(null);
      setTranslationPreview("");
      setTranslationItems([]);
    }
  }, [translationEnabled]);

  useEffect(() => {
    if (!rewriteEnabled) {
      setRewriteError(null);
      setRewritePreview("");
      setRewriteSelection([]);
      setRewriteResults([]);
    }
  }, [rewriteEnabled]);

  useEffect(() => {
    return () => {
      workflowAbortControllerRef.current?.abort();
      workflowAbortControllerRef.current = null;
      workflowInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeGroup) {
      setSelectedTitles([]);
      setSelectedHooks([]);
      setSelectedScripts([]);
      setTranslationItems([]);
      setRewriteSelection([]);
      setRewriteResults([]);
      return;
    }

    setSelectedTitles([]);
    setSelectedHooks([]);
    setSelectedScripts([]);
    setTranslationItems([]);
    setRewriteSelection([]);
    setRewriteResults([]);
  }, [activeGroup?.id]);

  useEffect(() => {
    sessionStorage.setItem("contentActiveGroupIndex", String(activeGroupIndex));
  }, [activeGroupIndex]);

  const refreshPendingDraftCount = async () => {
    const cachedCount = readCachedFinalDrafts().length;
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"));
      const data = await response.json();
      const list = Array.isArray(data?.items) ? data.items : [];
      setPendingDraftCount(Math.max(list.length, cachedCount));
    } catch {
      setPendingDraftCount(cachedCount);
    }
  };

  useEffect(() => {
    refreshPendingDraftCount();
  }, []);

  const parseTranslationPayload = (
    payloadText: string,
    selectedPayload: { titles: string[]; hooks: string[]; scripts: string[] },
  ): TranslationItem[] => {
    const text = String(payloadText || "").trim();
    if (!text) return [];

    const startIdx = text.indexOf("{");
    const endIdx = text.lastIndexOf("}");
    const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

    let obj: any = null;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      const fallbackLines = splitByLine(text);
      const fallbackTranslated = fallbackLines.join("\n").trim();
      const fallbackOriginal = [
        ...selectedPayload.titles,
        ...selectedPayload.hooks,
        ...selectedPayload.scripts,
      ].join("\n\n").trim();

      if (!fallbackTranslated) return [];
      return [
        {
          id: "translation-1",
          sourceType: "script",
          original: fallbackOriginal || "（未识别到原文）",
          translated: fallbackTranslated,
          zh: fallbackOriginal || "（未识别到原文）",
          en: fallbackTranslated,
        },
      ];
    }

    const list: TranslationItem[] = [];

    const appendIfValid = (
      original: string,
      translated: string,
      sourceType: TranslationItem["sourceType"],
    ) => {
      const originText = String(original || "").trim();
      const translatedText = String(translated || "").trim();
      if (!originText || !translatedText) return;
      list.push({
        id: `${sourceType}-${list.length + 1}`,
        original: originText,
        translated: translatedText,
        zh: originText,
        en: translatedText,
        sourceType,
      });
    };

    if (Array.isArray(obj?.translations)) {
      obj.translations.forEach((item: any) => {
        appendIfValid(
          item?.original || item?.source || item?.zh || item?.cn,
          item?.translated || item?.target || item?.en || item?.english,
          item?.sourceType || "script",
        );
      });
    }

    if (Array.isArray(obj?.data)) {
      obj.data.forEach((item: any) => {
        appendIfValid(
          item?.original || item?.source_text || item?.zh || item?.cn,
          item?.translated || item?.target_text || item?.en || item?.english,
          item?.sourceType || "script",
        );
      });
    }

    if (list.length === 0) {
      const translatedText = String(
        obj?.translated_text || obj?.translated || obj?.result || obj?.en || obj?.english || "",
      ).trim();
      const originalTextFromPayload = [
        ...selectedPayload.titles,
        ...selectedPayload.hooks,
        ...selectedPayload.scripts,
      ].join("\n\n").trim();
      const originalText = String(obj?.original_text || originalTextFromPayload || "（未识别到原文）").trim();

      if (translatedText) {
        appendIfValid(originalText, translatedText, "script");
      } else {
        const rawOutput = String(obj?.output || text || "").trim();
        const match = rawOutput.match(/"translated_text"\s*:\s*"([\s\S]*?)"/);
        const extracted = match?.[1]
          ? match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim()
          : "";
        if (extracted) {
          appendIfValid(originalText, extracted, "script");
        }
      }
    }

    return list;
  };

  const runTranslationWorkflow = async () => {
    if (!translationEnabled) return;

    const selectedTitleBlocks = workflowResult.titles.filter(item => selectedTitles.includes(item));
    const selectedHookObjects = workflowResult.hooks.filter(item => selectedHooks.includes(item.id));
    const selectedScriptObjects = workflowResult.scripts.filter(item => selectedScripts.includes(item.id));

    const payloadForTranslation = {
      titles: selectedTitleBlocks.map(extractTitleLabel),
      hooks: selectedHookObjects.map(item => item.content),
      scripts: selectedScriptObjects.map(item => item.content),
    };

    const hasAnySelected =
      payloadForTranslation.titles.length > 0 ||
      payloadForTranslation.hooks.length > 0 ||
      payloadForTranslation.scripts.length > 0;

    if (!hasAnySelected) {
      setTranslationError("请先在标题 / 3秒留存 / 二创文案中至少勾选一项，再执行翻译。");
      return;
    }

    setTranslationLoading(true);
    setTranslationError(null);
    setTranslationPreview("");
    setTranslationItems([]);

    try {
      const response = await fetchWithRetry(apiUrl("/api/agent/translation"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: payloadForTranslation,
        }),
      });

      if (!response.ok) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const payloadText = JSON.stringify(data, null, 2);
      setTranslationPreview(payloadText);
      const parsed = parseTranslationPayload(payloadText, payloadForTranslation)
        .map((item) => {
          const translatedOnly = String(item.translated || item.en || "").trim();
          return {
            ...item,
            translated: translatedOnly,
            en: translatedOnly,
          };
        })
        .filter((item) => String(item.translated || "").trim().length > 0);
      setTranslationItems(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "翻译工作流执行失败";
      setTranslationError(message);
    } finally {
      setTranslationLoading(false);
    }
  };

  const runRewriteWorkflow = async () => {
    if (!rewriteEnabled) return;

    const candidateScripts = workflowResult.scripts;
    const selectedRewriteScripts = candidateScripts.filter(item => rewriteSelection.includes(item.id));

    if (selectedRewriteScripts.length === 0) {
      setRewriteError("请在文案风格转写板块至少勾选一条文案后再执行转写。");
      return;
    }

    setRewriteLoading(true);
    setRewriteError(null);
    setRewritePreview("");
    setRewriteResults([]);

    try {
      const inputPayload = selectedRewriteScripts.map(item => ({ id: item.id, text: item.content }));

      const response = await fetchWithRetry(apiUrl("/api/agent/rewrite"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetPlatform: rewriteTarget,
          scripts: inputPayload,
        }),
      });

      if (!response.ok) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const parsed = await response.json();
      const answerText = JSON.stringify(parsed, null, 2);
      setRewritePreview(answerText);

      if (Array.isArray(parsed?.results)) {
        const mapped = parsed.results
          .map((item: any, idx: number) => {
            const id = String(item?.id || selectedRewriteScripts[idx]?.id || `rw-${idx + 1}`);
            const rewritten = String(item?.rewritten || item?.content || "").trim();
            const original = selectedRewriteScripts.find(s => s.id === id)?.content || selectedRewriteScripts[idx]?.content || "";
            if (!rewritten) return null;
            return { id, original, rewritten, target: rewriteTarget };
          })
          .filter(Boolean) as Array<{ id: string; original: string; rewritten: string; target: RewritePlatform }>;

        setRewriteResults(mapped);
      } else if (answerText) {
        const first = selectedRewriteScripts[0];
        setRewriteResults([
          {
            id: first?.id || "rw-1",
            original: first?.content || "",
            rewritten: answerText,
            target: rewriteTarget,
          },
        ]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "转写对话流执行失败";
      setRewriteError(message);
    } finally {
      setRewriteLoading(false);
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadBlobResponse = async (response: Response, fallbackName: string) => {
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      const raw = await response.text();
      const trimmed = raw.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          message = String(parsed?.error || parsed?.message || message);
        } catch {
          message = trimmed;
        }
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const matched = disposition.match(/filename="([^"]+)"/);
    const filename = matched?.[1] || fallbackName;
    triggerDownload(blob, filename);
  };

  const clearAllPendingDrafts = async () => {
    try {
      const resp = await fetchWithRetry(apiUrl("/api/final-drafts"), { method: "DELETE" });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `清空待导出文案失败（HTTP ${resp.status}）`);
      }
    } finally {
      clearCachedFinalDrafts();
    }
  };

  const readPendingDraftItems = async () => {
    try {
      const draftResp = await fetchWithRetry(apiUrl("/api/final-drafts"));
      const draftData = await draftResp.json();
      const list = Array.isArray(draftData?.items) ? draftData.items : [];
      if (list.length > 0) return list;
    } catch {
      // fall back to browser cache below
    }
    return readCachedFinalDrafts();
  };

  const buildCombinedDraft = (items: any[]) => ({
    titleDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.titleDraft || "")}`).join("\n\n"),
    hookDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.hookDraft || "")}`).join("\n\n"),
    scriptDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.scriptDraft || "")}`).join("\n\n"),
    rewriteDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.rewriteDraft || "")}`).join("\n\n"),
    translationDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.translationDraft || "")}`).join("\n\n"),
    benchmarkVideos: items.flatMap(item => Array.isArray(item?.benchmarkVideos) ? item.benchmarkVideos : []),
    taskInfo: items.find(item => item?.taskInfo)?.taskInfo || {
      id: String(activeTask?._id || ""),
      customerName: String(activeTask?.customerName || ""),
      ownerName: String(activeTask?.ownerName || ""),
      platformName: String(activeTask?.platformName || ""),
      contentDirection: String(activeTask?.contentDirection || ""),
    },
  });

  const exportAllPendingDrafts = async (format: "word" | "excel" | "feishu" | "bitable") => {
    setBatchExportLoading(true);
    setBatchExportMessage(null);

    const exportItemsLocally = (items: any[]) => {
      if (items.length === 0) throw new Error("暂无可导出的已保存文案");

      if (format === "excel") {
        const esc = (v: any) => `"${String(v || "").replace(/"/g, '""')}"`;
        const rows = [
          ["序号", "保存时间", "对标选题视频", "标题", "3秒留存", "二创文案", "风格转写结果", "中英翻译结果"],
          ...items.map((item: any, idx: number) => [
            String(idx + 1),
            String(item?.createdAt || ""),
            formatBenchmarkSummary(Array.isArray(item?.benchmarkVideos) ? item.benchmarkVideos : []),
            String(item?.titleDraft || ""),
            String(item?.hookDraft || ""),
            String(item?.scriptDraft || ""),
            String(item?.rewriteDraft || ""),
            String(item?.translationDraft || ""),
          ]),
        ];
        const csv = rows.map((row: string[]) => row.map(esc).join(",")).join("\n");
        triggerDownload(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `final-drafts-all-${Date.now()}.csv`);
        return;
      }

      const text = [
        "# 全部任务最终文案汇总",
        `共 ${items.length} 份`,
        "",
        ...items.map((item: any, idx: number) => [
          `# 任务 ${idx + 1}`,
          `保存时间：${String(item?.createdAt || "")}`,
          "",
          "## 对标选题视频",
          formatBenchmarkSummary(Array.isArray(item?.benchmarkVideos) ? item.benchmarkVideos : []) || "未提供",
          "",
          "## 标题",
          String(item?.titleDraft || ""),
          "",
          "## 3 秒留存",
          String(item?.hookDraft || ""),
          "",
          "## 二创文案",
          String(item?.scriptDraft || ""),
          "",
          "## 风格转写结果",
          String(item?.rewriteDraft || ""),
          "",
          "## 中英翻译结果",
          String(item?.translationDraft || ""),
          "",
          "---",
          "",
        ].join("\n")),
      ].join("\n");
      triggerDownload(new Blob([text], { type: "application/msword;charset=utf-8" }), `final-drafts-all-${Date.now()}.doc`);
    };

    try {
      const items = await readPendingDraftItems();
      if (items.length === 0) throw new Error("暂无可导出的已保存文案");

      if (format === "feishu") {
        const response = await fetchWithRetry(apiUrl("/api/export/feishu"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildCombinedDraft(items)),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || `写入飞书文档失败（HTTP ${response.status}）`);
        }
        const documentUrl = String(data?.documentUrl || "");
        if (documentUrl) window.open(documentUrl, "_blank", "noopener,noreferrer");
      } else if (format === "bitable") {
        const targetUrl = bitableTargetUrl.trim() || cachedBitableBinding.targetUrl || cachedBitableBinding.bitableUrl || "";
        if (!cachedBitableBinding.tableId && !targetUrl) {
          throw new Error("请先粘贴一次飞书多维表格 URL，系统会自动创建并复用当前任务的数据表。");
        }

        let binding: BitableBinding = {
          targetUrl,
          appToken: cachedBitableBinding.appToken || "",
          tableId: cachedBitableBinding.tableId || "",
          tableName: cachedBitableBinding.tableName || taskTableName,
          bitableUrl: cachedBitableBinding.bitableUrl || "",
        };

        for (const item of items) {
          const response = await fetchWithRetry(apiUrl("/api/export/bitable"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...item,
              taskInfo: item?.taskInfo || buildCombinedDraft([item]).taskInfo,
              feishuBitable: {
                targetUrl: binding.targetUrl || "",
                appToken: binding.appToken || "",
                tableId: binding.tableId || "",
                tableName: binding.tableName || taskTableName,
              },
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data?.success) {
            throw new Error(data?.error || `写入飞书多维表格失败（HTTP ${response.status}）`);
          }
          binding = {
            targetUrl: binding.targetUrl || targetUrl,
            appToken: String(data?.appToken || binding.appToken || ""),
            tableId: String(data?.tableId || binding.tableId || ""),
            tableName: String(data?.tableName || binding.tableName || taskTableName),
            bitableUrl: String(data?.bitableUrl || binding.bitableUrl || ""),
          };
          writeBitableBinding(bitableBindingKey, binding);
          setCachedBitableBinding(binding);
        }
        if (binding.bitableUrl) window.open(binding.bitableUrl, "_blank", "noopener,noreferrer");
      } else {
        try {
        const response = await fetchWithRetry(
          apiUrl(format === "word" ? "/api/export/final-drafts/word" : "/api/export/final-drafts/excel"),
          { method: "POST" },
        );

        if (response.status === 404 || response.status === 400) {
          exportItemsLocally(items);
        } else {
          await downloadBlobResponse(response, format === "word" ? "final-drafts-all.doc" : "final-drafts-all.csv");
        }
      } catch (requestError) {
        const cachedItems = readCachedFinalDrafts();
        if (cachedItems.length === 0) throw requestError;
        exportItemsLocally(cachedItems);
      }
      }

      await clearAllPendingDrafts();
      await refreshPendingDraftCount();
      setBatchExportMessage("导出并清空完成，待导出已更新为 0");
    } catch (error) {
      setBatchExportMessage(error instanceof Error ? error.message : "批量导出失败");
    } finally {
      setBatchExportLoading(false);
    }
  };

  const goToFinalEditor = () => {
    const selectedTitleBlocks = workflowResult.titles.filter(item => selectedTitles.includes(item));
    const selectedHookObjects = workflowResult.hooks.filter(item => selectedHooks.includes(item.id));
    const selectedScriptObjects = workflowResult.scripts.filter(item => selectedScripts.includes(item.id));

    const payload = {
      selectedTitles: selectedTitleBlocks.map(item => ({
        title: extractTitleLabel(item),
        detail: splitByLine(item).slice(1).join("\n"),
        raw: item,
      })),
      selectedHooks: selectedHookObjects,
      selectedScripts: selectedScriptObjects,
      rewriteResults,
      translationItems,
      benchmarkVideos: activeBenchmarkVideos,
      taskInfo: activeTask ? {
        id: String(activeTask._id || ""),
        customerName: String(activeTask.customerName || ""),
        ownerName: String(activeTask.ownerName || ""),
        platformName: String(activeTask.platformName || ""),
        contentDirection: String(activeTask.contentDirection || ""),
      } : null,
      createdAt: Date.now(),
      sourceGroupId: activeGroup?.id || null,
      sourceGroupIndex: activeGroupIndex,
      totalGroups: workflowGroups.length,
    };

    sessionStorage.setItem("finalDraftPayload", JSON.stringify(payload));
    navigate("/final-editor");
  };

  const handleConfirmComplete = () => {
    setTaskCompleteVisible(true);
    setTimeout(() => {
      setTaskCompleteVisible(false);
      window.location.href = "/";
    }, 1800);
  };

  const runWorkflow = async (options: RunWorkflowOptions = {}) => {
    if (workflowInFlightRef.current) {
      return;
    }

    if (workflowInputs.length === 0) {
      setWorkflowError("未检测到可生成内容的选题，请先在上一页选择选题");
      return;
    }

    const force = options.force !== false;
    const reusableGroups = force ? [] : pickReusableWorkflowGroups(workflowInputIds, workflowGroups);
    const inputsToGenerate = force
      ? workflowInputs
      : workflowInputs.filter(input => !reusableGroups.some(group => sameLink(group.shareLink, input.id)));

    if (!force) {
      const orderedReusableGroups = orderWorkflowGroupsByLinks(workflowInputIds, reusableGroups);
      setWorkflowRawDone("");
      setWorkflowGroups(orderedReusableGroups);
      sessionStorage.removeItem("workflowRawDone");
      sessionStorage.setItem("contentWorkflowGroups", JSON.stringify(orderedReusableGroups));
      setActiveGroupIndex(index => {
        const nextIndex = Math.min(Math.max(0, index), Math.max(0, orderedReusableGroups.length - 1));
        sessionStorage.setItem("contentActiveGroupIndex", String(nextIndex));
        return nextIndex;
      });
    }

    if (inputsToGenerate.length === 0) {
      setWorkflowError(null);
      setStreamPreview("");
      return;
    }

    workflowInFlightRef.current = true;
    workflowAbortControllerRef.current?.abort();
    const controller = new AbortController();
    workflowAbortControllerRef.current = controller;

    const currentRunId = workflowRunIdRef.current + 1;
    workflowRunIdRef.current = currentRunId;
    const isCurrentRun = () => workflowRunIdRef.current === currentRunId;

    setWorkflowLoading(true);
    setWorkflowError(null);
    setStreamPreview("");
    if (force) {
      setWorkflowRawDone("");
      setWorkflowGroups([]);
      setActiveGroupIndex(0);
      sessionStorage.removeItem("workflowRawDone");
      sessionStorage.setItem("contentWorkflowGroups", "[]");
      sessionStorage.setItem("contentActiveGroupIndex", "0");
    } else {
      setWorkflowRawDone("");
      sessionStorage.removeItem("workflowRawDone");
      setWorkflowGroups(reusableGroups);
      sessionStorage.setItem("contentWorkflowGroups", JSON.stringify(reusableGroups));
      setActiveGroupIndex(index => {
        const nextIndex = Math.min(Math.max(0, index), Math.max(0, reusableGroups.length - 1));
        sessionStorage.setItem("contentActiveGroupIndex", String(nextIndex));
        return nextIndex;
      });
    }

    try {
      const MAX_INPUTS_PER_BATCH = 1;
      const batches: typeof workflowInputs[] = [];
      for (let i = 0; i < inputsToGenerate.length; i += MAX_INPUTS_PER_BATCH) {
        batches.push(inputsToGenerate.slice(i, i + MAX_INPUTS_PER_BATCH));
      }

      const allGroups: WorkflowResultGroup[] = [...reusableGroups];
      const allRawPayloads: string[] = [];

      const ensureCurrentRun = () => {
        if (!isCurrentRun()) {
          throw new Error("工作流任务已被新的请求替换");
        }
      };

      const commitPartialResults = () => {
        ensureCurrentRun();
        const combinedPayload = allRawPayloads.join("\n\n");
        const orderedGroups = orderWorkflowGroupsByLinks(workflowInputIds, allGroups);
        setWorkflowRawDone(combinedPayload);
        sessionStorage.setItem("workflowRawDone", combinedPayload);
        setWorkflowGroups(orderedGroups);
        sessionStorage.setItem("contentWorkflowGroups", JSON.stringify(orderedGroups));
      };

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        ensureCurrentRun();

        const batchInputs = batches[batchIndex];
        const batchIds = batchInputs.map(item => item.id);
        const batchLinksText = batchInputs
          .filter(item => item.kind === "share_link")
          .map(item => item.link)
          .join("\n");
        const batchWechatTopics = batchInputs
          .filter(item => item.kind === "wechat_topic" && item.topic)
          .map(item => item.topic);

        const response = await fetch(apiUrl("/api/agent/workflow/stream-run"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflow_id: "7618854964156563519",
            source_platform: shareLinkPlatform,
            parameters: {
              share_links: batchLinksText,
              benchmark_topics: batchWechatTopics,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let donePayload = "";
        let batchPreview = "";
        let seenDone = false;

        while (true) {
          ensureCurrentRun();

          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";

          for (const chunk of chunks) {
            const lines = chunk.split("\n");
            let event = "";
            let dataLine = "";

            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }

            if (!event) continue;

            let data: any = {};
            try {
              data = dataLine ? JSON.parse(dataLine) : {};
            } catch {
              data = { raw: dataLine };
            }

            if (event === "Message") {
              const content = String(data?.content || "");
              if (content) {
                batchPreview += content;
                if (isCurrentRun()) {
                  setStreamPreview(prev => prev + content);
                }
                donePayload = content;
              }
            }

            if (event === "Error") {
              throw new Error(data?.error_message || `工作流执行失败（批次 ${batchIndex + 1}/${batches.length}）`);
            }

            if (event === "Done") {
              seenDone = true;
              const payloadText = donePayload || batchPreview;
              allRawPayloads.push(payloadText);

              const grouped = parseWorkflowPayloadGroups(payloadText, batchIds);
              const normalized = grouped.length > 0
                ? grouped
                : [
                    {
                      id: `link-${allGroups.length + 1}`,
                      shareLink: batchIds[0] || "",
                      result: parseWorkflowPayload(payloadText),
                    },
                  ];

              allGroups.push(...normalized);
            }
          }
        }

        if (!seenDone) {
          throw new Error(`工作流连接已结束，但未收到 Done 事件（批次 ${batchIndex + 1}/${batches.length}）。可能是请求超时或中途被中断，请重试。`);
        }

        commitPartialResults();
      }

      commitPartialResults();
    } catch (error) {
      if (!isCurrentRun()) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        setWorkflowError("工作流任务已取消");
        return;
      }

      const message = error instanceof Error ? error.message : "工作流执行失败";
      setWorkflowError(message);
    } finally {
      if (isCurrentRun()) {
        workflowAbortControllerRef.current = null;
        workflowInFlightRef.current = false;
        setWorkflowLoading(false);
      }
    }
  };

  useEffect(() => {
    const autoRunKey = sessionStorage.getItem("contentAutoRunKey") || "";
    const consumedKey = sessionStorage.getItem("contentAutoRunConsumedKey") || "";
    if (workflowInputs.length === 0 || workflowInFlightRef.current) return;
    const reusableGroups = pickReusableWorkflowGroups(workflowInputIds, workflowGroups);
    const hasMissingLinks = workflowInputIds.some(id => !reusableGroups.some(group => sameLink(group.shareLink, id)));
    if (autoRunKey && consumedKey === autoRunKey && !hasMissingLinks) return;
    if (!autoRunKey || (autoRunKeyRef.current === autoRunKey && !hasMissingLinks)) return;

    autoRunKeyRef.current = autoRunKey;
    sessionStorage.setItem("contentAutoRunConsumedKey", autoRunKey);
    runWorkflow({ force: false });
  }, [workflowInputs, workflowInputIds, workflowGroups]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-8 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">内容生成与确认</h1>
            <p className="text-sm text-slate-500 mt-1">
              系统已生成多组内容方案，请逐步筛选并确认最终文案
            </p>
          </div>
          <Button
            variant="outline"
            className="border-slate-200 text-slate-600 hover:text-slate-800"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            返回选题生成
          </Button>
        </div>
      </header>

      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-6">
          <div className="space-y-4">
            <Accordion type="multiple" defaultValue={["context-1", "context-2"]} className="space-y-3">
              <AccordionItem value="context-1" className="border border-slate-200 rounded-xl bg-white">
                <AccordionTrigger className="px-4 py-3 text-sm font-semibold text-slate-800">
                  客户信息
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 text-sm text-slate-600 space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">客户名称</div>
                    <div className="mt-1">{activeTask?.customerName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">负责人</div>
                    <div className="mt-1">{activeTask?.ownerName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">平台账号</div>
                    <div className="mt-1">{activeTask?.platformName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">联系方式</div>
                    <div className="mt-1">{activeTask?.contact || "未提供"}</div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="context-2" className="border border-slate-200 rounded-xl bg-white">
                <AccordionTrigger className="px-4 py-3 text-sm font-semibold text-slate-800">
                  内容需求
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 text-sm text-slate-600 space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">内容方向与约束条件</div>
                    <div className="mt-1">
                      {Array.isArray(activeTask?.contentRequirements) && activeTask?.contentRequirements.length > 0
                        ? activeTask?.contentRequirements.join("、")
                        : "未提供"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">补充说明</div>
                    <div className="mt-1">{activeTask?.notes || "未提供"}</div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          <div className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 space-y-3">
              <div>
                当前已选选题：{selectedTopics.length} 条。后续标题、3 秒留存、二创文案将基于这些真实选题数据生成。
              </div>
              {wechatTopics.length > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  已包含 {wechatTopics.length} 条视频号选题。系统将使用媒体地址和 decode_key 解密后进入转写生成。
                </div>
              )}

              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  onClick={() => runWorkflow({ force: true })}
                  disabled={workflowLoading || workflowInputs.length === 0}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  {workflowLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      生成中...
                    </>
                  ) : workflowGroups.length > 0 ? "重新生成" : "重新生成内容"}
                </Button>
                {workflowError && <span className="text-xs text-red-600">{workflowError}</span>}
              </div>

              {streamPreview && (
                <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">流式输出预览</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                    {streamPreview}
                  </pre>
                </details>
              )}

              {workflowRawDone && (
                <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">Done 前最后 payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                    {workflowRawDone}
                  </pre>
                </details>
              )}

              {selectedTopics.length > 0 && (
                <Accordion type="multiple" className="space-y-2">
                  {selectedTopics.map((topic, index) => (
                    <AccordionItem
                      key={topic?.id || index}
                      value={`topic-${topic?.id || index}`}
                      className="border border-slate-200 rounded-lg bg-slate-50"
                    >
                      <AccordionTrigger className="px-3 py-2 text-xs text-slate-700">
                        <span className="text-slate-900 font-medium">{topic?.title || "未命名选题"}</span>
                      </AccordionTrigger>
                      <AccordionContent className="px-3 pb-3 text-xs text-slate-600 space-y-2">
                        <div>作者：{topic?.authorName || "未知"}</div>
                        <div>{isWeChatChannelsTopic(topic) ? "视频号来源" : "链接"}：{describeTopicSource(topic) || "未提供"}</div>
                        <div>
                          数据：点赞 {formatMetric(readStat(topic, "likes", ["digg_count", "like_count", "likes"]))} / 评论 {formatMetric(readStat(topic, "comments", ["comment_count", "comments"]))} / 转发 {formatMetric(readStat(topic, "shares", ["share_count", "shares"]))} / 收藏 {formatMetric(readStat(topic, "bookmarks", ["collect_count", "favorite_count", "bookmark_count", "bookmarks"]))}
                        </div>
                        <div>原始数据：</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                          {JSON.stringify(topic?.rawData ?? topic, null, 2)}
                        </pre>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </div>

            <Card className="bg-white border-slate-200 overflow-hidden">
              <CardHeader className="pb-3 border-b border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-slate-700">
                    当前任务卡片：
                    <span className="ml-1 font-semibold text-slate-900">
                      {workflowGroups.length > 0 ? `${activeGroupIndex + 1} / ${workflowGroups.length}` : "0 / 0"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-2"
                      onClick={() => setActiveGroupIndex((prev) => Math.max(0, prev - 1))}
                      disabled={workflowGroups.length === 0 || activeGroupIndex <= 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-2"
                      onClick={() => setActiveGroupIndex((prev) => Math.min(workflowGroups.length - 1, prev + 1))}
                      disabled={workflowGroups.length === 0 || activeGroupIndex >= workflowGroups.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

              </CardHeader>

              <CardContent className="pt-4">
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-stretch">
              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">标题</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.titleCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.titles.map((titleBlock) => {
                    const { titleLabel, detailLines } = formatTitleDisplay(titleBlock);
                    return (
                      <div
                        key={titleBlock}
                        className={`rounded-lg border px-3 py-2 text-sm transition ${
                          selectedTitles.includes(titleBlock)
                            ? "border-indigo-400 bg-indigo-50"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={selectedTitles.includes(titleBlock)}
                            onCheckedChange={() => toggleSelection(titleBlock, selectedTitles, setSelectedTitles)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-slate-900 break-words leading-5 font-medium">{titleLabel || titleBlock}</div>
                            {detailLines.length > 0 && (
                              <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap break-words leading-5">
                                {detailLines.join("\n")}
                              </div>
                            )}
                            {selectedTitles.includes(titleBlock) && (
                              <div className="text-xs text-indigo-600 mt-1">已选为候选标题</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">3 秒留存</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.hookCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.hooks.map((hook) => {
                    const isSelected = selectedHooks.includes(hook.id);
                    const typeLabel = hook.hookType === "opening_text"
                      ? "开头钩子"
                      : hook.hookType === "ending_text"
                        ? "结尾钩子"
                        : "没有检测到钩子（unknown）";

                    return (
                      <div
                        key={hook.id}
                        className={`rounded-lg border px-3 py-3 text-sm transition ${
                          isSelected
                            ? "border-indigo-400 bg-indigo-50"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleSelection(hook.id, selectedHooks, setSelectedHooks)}
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{typeLabel}</Badge>
                            </div>
                            <div className="text-slate-900 whitespace-pre-wrap break-words leading-6">
                              {hook.content}
                            </div>
                            {isSelected && (
                              <div className="text-xs text-indigo-600 mt-1">已进入下一筛选阶段</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">二创文案</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.scriptCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.scripts.map((script) => (
                    <div
                      key={script.id}
                      className={`rounded-lg border ${
                        selectedScripts.includes(script.id)
                          ? "border-indigo-400 bg-indigo-50"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <label className="flex items-start gap-3 text-sm px-3 py-3">
                        <Checkbox
                          checked={selectedScripts.includes(script.id)}
                          onCheckedChange={() => toggleSelection(script.id, selectedScripts, setSelectedScripts)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-slate-900 font-medium break-words">{script.title}</div>
                          <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap break-words leading-5">
                            {toPreview(script.content, 72) || "（空）"}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="mt-2 h-7 px-2 text-xs"
                            onClick={() => setActiveScript({ title: script.title, content: script.content })}
                          >
                            打开大窗口阅读全文
                          </Button>
                          {selectedScripts.includes(script.id) && (
                            <div className="mt-2 text-xs text-indigo-600">已进入最终组合</div>
                          )}
                        </div>
                      </label>
                    </div>
                  ))}
                </CardContent>
              </Card>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-indigo-500" />
                      <CardTitle className="text-base font-semibold text-slate-900">中 / 英翻译（可选）</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{translationEnabled ? "已启用" : "未启用"}</span>
                      <Switch checked={translationEnabled} onCheckedChange={(v) => setTranslationEnabled(Boolean(v))} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-700">
                  <div className="text-xs text-slate-500">
                    启用后可对你在上方三个板块中勾选的内容执行中英翻译；关闭时不影响主流程。
                  </div>

                  {translationEnabled ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          onClick={runTranslationWorkflow}
                          disabled={translationLoading}
                          variant="outline"
                          className="border-indigo-200 text-indigo-700"
                        >
                          {translationLoading ? "翻译中..." : "执行翻译"}
                        </Button>
                        <span className="text-xs text-slate-500">
                          将翻译：标题 {selectedTitles.length} 条 / 3秒留存 {selectedHooks.length} 条 / 二创文案 {selectedScripts.length} 条
                        </span>
                      </div>

                      {translationError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {translationError}
                        </div>
                      )}

                      {translationItems.length > 0 ? (
                        <div className="max-h-80 overflow-auto space-y-2 pr-1">
                          {translationItems.map(item => (
                            <div key={item.id} className="rounded-lg border border-slate-200 px-3 py-2 bg-slate-50 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] text-slate-500">来源：{item.sourceType}</div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-7 px-2 text-[11px]"
                                  onClick={async () => {
                                    const toCopy = String(item.translated || item.en || "");
                                    if (!toCopy) return;
                                    await navigator.clipboard.writeText(toCopy);
                                    setTranslationCopyHint("已复制翻译文案");
                                    setTimeout(() => setTranslationCopyHint(null), 1500);
                                  }}
                                >
                                  复制翻译
                                </Button>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">原文</div>
                                <div className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-5">
                                  {toPreview(item.original || item.zh || "", 110)}
                                </div>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">翻译结果</div>
                                <div className="text-sm text-slate-900 whitespace-pre-wrap break-words leading-6">
                                  {toPreview(item.translated || item.en || "", 120)}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => setActiveTranslationItem(item)}
                              >
                                打开大窗口查看原文与翻译
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                          暂无翻译结果。你可以先勾选需要翻译的内容，再点击“执行翻译”。
                        </div>
                      )}

                      {translationCopyHint && (
                        <div className="text-xs text-emerald-600">{translationCopyHint}</div>
                      )}

                      {translationPreview && (
                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <summary className="cursor-pointer text-xs font-semibold text-slate-700">翻译流式输出预览</summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                            {translationPreview}
                          </pre>
                        </details>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                      翻译模块当前已关闭。你可以在需要时随时打开，不影响当前文案筛选与确认。
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-indigo-500" />
                      <CardTitle className="text-base font-semibold text-slate-900">文案风格转写（可选）</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{rewriteEnabled ? "已启用" : "未启用"}</span>
                      <Switch checked={rewriteEnabled} onCheckedChange={(v) => setRewriteEnabled(Boolean(v))} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-700">
                  <div className="text-xs text-slate-500">
                    启用后你可以从已筛选的二创文案中二次勾选，按目标平台一键转写；关闭时不影响主流程。
                  </div>

                  {rewriteEnabled ? (
                    <>
                      <div className="flex flex-wrap gap-2 items-center">
                        {[
                          { id: "douyin", label: "抖音" },
                          { id: "xiaohongshu", label: "小红书" },
                          { id: "wechat", label: "公众号" },
                        ].map(item => (
                          <Button
                            key={item.id}
                            type="button"
                            variant={rewriteTarget === item.id ? "default" : "outline"}
                            className={rewriteTarget === item.id ? "bg-indigo-600 hover:bg-indigo-700" : ""}
                            onClick={() => setRewriteTarget(item.id as RewritePlatform)}
                          >
                            {item.label}
                          </Button>
                        ))}
                      </div>

                      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                        <div className="text-xs text-slate-500">二次勾选需要转写的文案（来自你上方已勾选的二创文案）</div>
                        <div className="space-y-2 max-h-48 overflow-auto pr-1">
                          {workflowResult.scripts
                            .filter(script => selectedScripts.includes(script.id))
                            .map(script => {
                              const checked = rewriteSelection.includes(script.id);
                              return (
                                <label key={script.id} className={`flex items-start gap-2 rounded-md border px-2 py-2 ${checked ? "border-indigo-300 bg-indigo-50" : "border-slate-200"}`}>
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={() => toggleSelection(script.id, rewriteSelection, setRewriteSelection)}
                                  />
                                  <div className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-5">
                                    {toPreview(script.content, 120)}
                                  </div>
                                </label>
                              );
                            })}
                          {workflowResult.scripts.filter(script => selectedScripts.includes(script.id)).length === 0 && (
                            <div className="text-xs text-slate-500">请先在上方“二创文案”中勾选至少一条。</div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          onClick={runRewriteWorkflow}
                          disabled={rewriteLoading}
                          variant="outline"
                          className="border-indigo-200 text-indigo-700"
                        >
                          {rewriteLoading ? "转写中..." : "执行平台转写"}
                        </Button>
                        <span className="text-xs text-slate-500">目标平台：{rewriteTarget}</span>
                      </div>

                      {rewriteError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {rewriteError}
                        </div>
                      )}

                      {rewriteResults.length > 0 && (
                        <div className="space-y-2 max-h-72 overflow-auto pr-1">
                          {rewriteResults.map(item => (
                            <div key={item.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50 space-y-2">
                              <div className="text-[11px] text-slate-500">目标平台：{item.target}</div>
                              <div>
                                <div className="text-[11px] text-slate-500">原文</div>
                                <div className="text-xs text-slate-700 whitespace-pre-wrap break-words">{item.original}</div>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">转写结果</div>
                                <div className="text-sm text-slate-900 whitespace-pre-wrap break-words">{item.rewritten}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {rewritePreview && (
                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <summary className="cursor-pointer text-xs font-semibold text-slate-700">转写流式输出预览</summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                            {rewritePreview}
                          </pre>
                        </details>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                      转写模块当前已关闭。你可以在需要做平台改写时再开启，不影响当前文案筛选与确认。
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="bg-white border-slate-200">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-indigo-500" />
                    <CardTitle className="text-base font-semibold text-slate-900">最终文案（可编辑）</CardTitle>
                  </div>
                  <Badge className="bg-emerald-50 text-emerald-600">{pendingDraftCount} 份待导出</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm text-slate-600">
                <div>当前页面不直接展开编辑器，请在下一步进入完整编辑页。</div>
                <div className="flex flex-wrap gap-2">
                  <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={goToFinalEditor}>
                    进入最终文案编辑页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-emerald-200 text-emerald-700"
                    onClick={() => exportAllPendingDrafts("word")}
                    disabled={batchExportLoading || pendingDraftCount === 0}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    一键导出全部文档
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-emerald-200 text-emerald-700"
                    onClick={() => exportAllPendingDrafts("excel")}
                    disabled={batchExportLoading || pendingDraftCount === 0}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    一键导出全部表格
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-blue-200 text-blue-700"
                    onClick={() => exportAllPendingDrafts("feishu")}
                    disabled={batchExportLoading || pendingDraftCount === 0}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    写入飞书文档
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-blue-200 text-blue-700"
                    onClick={() => exportAllPendingDrafts("bitable")}
                    disabled={batchExportLoading || pendingDraftCount === 0}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    写入多维表格
                  </Button>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-medium text-slate-700">飞书多维表格归档</div>
                    <Badge className={cachedBitableBinding.tableId ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}>
                      {cachedBitableBinding.tableId ? "当前任务已绑定" : "粘贴一次即可"}
                    </Badge>
                  </div>
                  <input
                    value={bitableTargetUrl}
                    onChange={(event) => setBitableTargetUrl(event.target.value)}
                    placeholder="粘贴飞书多维表格 URL，首次写入会自动创建当前任务的数据表"
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                  />
                  <div className="text-[11px] text-slate-500">
                    数据表：{cachedBitableBinding.tableName || taskTableName}
                    {cachedBitableBinding.tableId ? ` · ${cachedBitableBinding.tableId}` : ""}
                  </div>
                </div>
                {batchExportMessage && <div className="text-xs text-slate-500">{batchExportMessage}</div>}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white px-8 py-6">
        <div className="max-w-[1600px] mx-auto flex justify-end">
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleConfirmComplete}>
            <CheckCircle2 className="h-4 w-4 mr-2" />
            确认无误（OK）
          </Button>
        </div>
      </div>

      {activeScript && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-white border border-slate-200 shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-slate-500">二创文案 · 独立阅读窗口</div>
                <div className="text-base font-semibold text-slate-900 break-words">{activeScript.title}</div>
              </div>
              <Button variant="outline" onClick={() => setActiveScript(null)}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 font-sans">
                {activeScript.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {taskCompleteVisible && (
        <div className="fixed inset-0 z-[70] bg-slate-900/35 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="relative w-full max-w-md rounded-2xl border border-emerald-200 bg-white shadow-2xl px-8 py-10 text-center overflow-hidden">
            <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-emerald-100/70" />
            <div className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full bg-indigo-100/60" />
            <div className="relative">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 animate-pulse">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h3 className="text-2xl font-semibold text-slate-900">任务完成</h3>
              <p className="mt-2 text-sm text-slate-600">本次文案已确认无误，正在为你跳转到选题生成页，继续下一个任务。</p>
            </div>
          </div>
        </div>
      )}

      {activeTranslationItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-white border border-slate-200 shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-slate-500">中英翻译 · 独立阅读窗口</div>
                <div className="text-base font-semibold text-slate-900 break-words">来源：{activeTranslationItem.sourceType}</div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const toCopy = String(activeTranslationItem.translated || activeTranslationItem.en || "");
                    if (!toCopy) return;
                    await navigator.clipboard.writeText(toCopy);
                    setTranslationCopyHint("已复制翻译文案");
                    setTimeout(() => setTranslationCopyHint(null), 1500);
                  }}
                >
                  一键复制翻译
                </Button>
                <Button variant="outline" onClick={() => setActiveTranslationItem(null)}>
                  关闭
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div>
                <div className="text-xs text-slate-500 mb-1">原文</div>
                <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 font-sans rounded-md border border-slate-200 p-3 bg-slate-50">
                  {activeTranslationItem.original || activeTranslationItem.zh || ""}
                </pre>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">翻译结果</div>
                <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-900 font-sans rounded-md border border-indigo-200 p-3 bg-indigo-50">
                  {activeTranslationItem.translated || activeTranslationItem.en || ""}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
