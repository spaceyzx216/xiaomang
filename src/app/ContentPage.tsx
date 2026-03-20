import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { apiUrl } from "./api";
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
import { Loader2, FileText, Layers, CheckCircle2, Sparkles } from "lucide-react";

type TopicLike = {
  id?: string;
  title?: string;
  authorName?: string;
  link?: string;
  rawData?: any;
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

const parseTitleBlocks = (titleText: string) => {
  const lines = splitByLine(titleText)
    .map(line => line.replace(/^[-]{2,}\s*$/, "").trim())
    .filter(Boolean)
    .filter(line => !line.includes("爆款标题") && line !== "---");

  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^\d+\./.test(line)) {
      if (current.length > 0) blocks.push(current);
      current = [line];
      continue;
    }

    if (current.length === 0) continue;

    if (/^(类型|优势|技巧)[:：]/.test(line)) {
      current.push(line);
    }
  }

  if (current.length > 0) blocks.push(current);

  return blocks.map(block => block.join("\n")).filter(Boolean);
};

const extractTitleLabel = (titleBlock: string) => {
  const firstLine = splitByLine(titleBlock)[0] || "";
  return firstLine
    .replace(/^\d+\.?\s*/, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/\*\*/g, "")
    .trim();
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

  const hooks: WorkflowHook[] = [
    {
      id: "hook-opening",
      content: String(codeList1Field?.opening_text || codeList1Field?.开头钩子 || "").trim(),
      hookType: "opening_text",
    },
    {
      id: "hook-ending",
      content: String(codeList1Field?.ending_text || codeList1Field?.结尾钩子 || "").trim(),
      hookType: "ending_text",
    },
  ].filter(item => item.content);

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

export default function ContentPage() {
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [selectedHooks, setSelectedHooks] = useState<string[]>([]);
  const [selectedScripts, setSelectedScripts] = useState<string[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [streamPreview, setStreamPreview] = useState("");
  const [workflowRawDone, setWorkflowRawDone] = useState("");
  const [workflowResult, setWorkflowResult] = useState<WorkflowResult>(fallbackResult);
  const [activeScript, setActiveScript] = useState<{ title: string; content: string } | null>(null);

  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationPreview, setTranslationPreview] = useState("");
  const [translationItems, setTranslationItems] = useState<TranslationItem[]>([]);
  const [activeTranslationItem, setActiveTranslationItem] = useState<TranslationItem | null>(null);
  const [translationCopyHint, setTranslationCopyHint] = useState<string | null>(null);
  const [taskCompleteVisible, setTaskCompleteVisible] = useState(false);

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

  const shareLinks = useMemo(() => {
    return selectedTopics
      .map(getTopicShareLink)
      .map(link => String(link || "").trim())
      .filter(Boolean);
  }, [selectedTopics]);

  const shareLinksText = useMemo(() => shareLinks.join("\n"), [shareLinks]);

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
      const response = await fetch(apiUrl("/api/coze/workflow/stream-run"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow_id: "7619219558927253550",
          parameters: {
            input: JSON.stringify(payloadForTranslation),
            content: JSON.stringify(payloadForTranslation),
            selected_titles: payloadForTranslation.titles.join("\n"),
            selected_hooks: payloadForTranslation.hooks.join("\n"),
            selected_scripts: payloadForTranslation.scripts.join("\n\n"),
          },
        }),
      });

      if (!response.ok || !response.body) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let donePayload = "";

      while (true) {
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
              setTranslationPreview(prev => prev + content);
              donePayload = content;
            }
          }

          if (event === "Error") {
            throw new Error(data?.error_message || "翻译工作流执行失败");
          }

          if (event === "Done") {
            const payloadText = donePayload || translationPreview;
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
          }
        }
      }
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
      const systemPrompt = `你是资深新媒体编辑，请将用户给出的文案改写为${rewriteTarget}平台风格。输出必须是JSON：{"results":[{"id":"...","rewritten":"..."}]}`;
      const inputPayload = selectedRewriteScripts.map(item => ({ id: item.id, text: item.content }));

      const response = await fetch(apiUrl("/api/coze/workflows/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow_id: "7580278982190874675",
          additional_messages: [
            {
              role: "user",
              content_type: "text",
              content: JSON.stringify({
                task: "rewrite",
                target_platform: rewriteTarget,
                scripts: inputPayload,
              }),
            },
          ],
          parameters: {
            SYSTEM_PROMPT: systemPrompt,
          },
          connector_id: "1024",
        }),
      });

      if (!response.ok || !response.body) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finalAnswer = "";

      while (true) {
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

          if (event === "conversation.message.delta" && data?.type === "answer") {
            const part = String(data?.content || "");
            if (part) {
              setRewritePreview(prev => prev + part);
              finalAnswer += part;
            }
          }

          if (event === "conversation.message.completed" && data?.type === "answer") {
            finalAnswer = String(data?.content || finalAnswer || "");
          }

          if (event === "conversation.chat.failed" || event === "error") {
            throw new Error(data?.msg || data?.error_message || "转写对话流执行失败");
          }
        }
      }

      const answerText = String(finalAnswer || "").trim();
      const startIdx = answerText.indexOf("{");
      const endIdx = answerText.lastIndexOf("}");
      const jsonText = startIdx >= 0 && endIdx > startIdx ? answerText.slice(startIdx, endIdx + 1) : answerText;

      let parsed: any = null;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = null;
      }

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
      createdAt: Date.now(),
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

  const runWorkflow = async () => {
    if (!shareLinksText) {
      setWorkflowError("未检测到分享链接，请先在上一页选择选题并携带可用链接");
      return;
    }

    setWorkflowLoading(true);
    setWorkflowError(null);
    setStreamPreview("");
    setWorkflowRawDone("");

    try {
      const response = await fetch(apiUrl("/api/coze/workflow/stream-run"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow_id: "7618854964156563519",
          parameters: {
            share_links: shareLinksText,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let donePayload = "";

      while (true) {
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
              setStreamPreview(prev => prev + content);
              donePayload = content;
            }
          }

          if (event === "Error") {
            throw new Error(data?.error_message || "工作流执行失败");
          }

          if (event === "Done") {
            const payloadText = donePayload || streamPreview;
            setWorkflowRawDone(payloadText);
            const parsed = parseWorkflowPayload(payloadText);
            setWorkflowResult(parsed);
          }
        }
      }

      if (!donePayload) {
        throw new Error("工作流连接已结束，但未收到 Done 事件。可能是请求超时或中途被中断，请重试。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作流执行失败";
      setWorkflowError(message);
    } finally {
      setWorkflowLoading(false);
    }
  };

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
              {shareLinksText && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-700">工作流输入 share_links（已自动导入）</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                    {shareLinksText}
                  </pre>
                </div>
              )}

              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  onClick={runWorkflow}
                  disabled={workflowLoading || !shareLinksText}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  {workflowLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      生成中...
                    </>
                  ) : "调用工作流生成内容"}
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

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
              <Card className="bg-white border-slate-200 xl:sticky xl:top-4">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">标题</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.titleCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[62vh] overflow-auto pr-1">
                  {workflowResult.titles.map((titleBlock) => {
                    const titleLabel = extractTitleLabel(titleBlock);
                    const extraLines = splitByLine(titleBlock).slice(1);
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
                            {extraLines.length > 0 && (
                              <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap break-words leading-5">
                                {extraLines.join("\n")}
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

              <Card className="bg-white border-slate-200 xl:sticky xl:top-4">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">3 秒留存</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.hookCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[62vh] overflow-auto pr-1">
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

              <Card className="bg-white border-slate-200 xl:sticky xl:top-4">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">二创文案</CardTitle>
                    <Badge className="bg-indigo-50 text-indigo-600">{funnelStatus.scriptCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 max-h-[62vh] overflow-auto pr-1">
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
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-indigo-500" />
                    <CardTitle className="text-base font-semibold text-slate-900">最终文案（可编辑）</CardTitle>
                  </div>
                  <Badge className="bg-emerald-50 text-emerald-600">{funnelStatus.scriptCount} 条待合并</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm text-slate-600">
                <div>当前页面不直接展开编辑器，请在下一步进入完整编辑页。</div>
                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white w-fit" onClick={goToFinalEditor}>
                  进入最终文案编辑页
                </Button>
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
