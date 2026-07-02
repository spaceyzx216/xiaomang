import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { FileText, ArrowLeft } from "lucide-react";
import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
import { cacheFinalDraft } from "./finalDraftCache";

type BenchmarkVideo = {
  title?: string;
  link?: string;
  coverUrl?: string;
  durationSeconds?: number;
  authorName?: string;
  publishDate?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  bookmarks?: number;
  hotTopics?: string[];
};

type FinalDraftPayload = {
  selectedTitles?: Array<{ title: string; detail?: string; raw?: string }>;
  selectedHooks?: Array<{ id: string; content: string; hookType: string }>;
  selectedScripts?: Array<{ id: string; title: string; content: string }>;
  rewriteResults?: Array<{ id: string; original: string; rewritten: string; target: string }>;
  translationItems?: Array<{ id: string; zh: string; en: string; sourceType: string }>;
  benchmarkVideos?: BenchmarkVideo[];
  taskInfo?: {
    id?: string;
    customerName?: string;
    ownerName?: string;
    platformName?: string;
    contentDirection?: string;
  } | null;
  sourceGroupId?: string | null;
  sourceGroupIndex?: number;
  totalGroups?: number;
};

const loadDraftPayload = (): FinalDraftPayload => {
  try {
    const raw = sessionStorage.getItem("finalDraftPayload");
    if (!raw) return {};
    return JSON.parse(raw) as FinalDraftPayload;
  } catch {
    return {};
  }
};

const joinNonEmpty = (lines: string[]) => lines.map(item => String(item || "").trim()).filter(Boolean).join("\n\n");

const formatMetric = (value?: number) => {
  const numeric = Number(value || 0);
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1)}万`;
  return String(numeric || 0);
};

const formatDuration = (value?: number) => {
  const total = Math.max(0, Math.round(Number(value || 0)));
  if (!total) return "未知";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
};

export default function FinalEditorPage() {
  const navigate = useNavigate();
  const payload = useMemo(() => loadDraftPayload(), []);
  const benchmarkVideos = Array.isArray(payload.benchmarkVideos) ? payload.benchmarkVideos : [];

  const [titleDraft, setTitleDraft] = useState(() => joinNonEmpty(
    (payload.selectedTitles || []).map((item, idx) => `${idx + 1}. ${item.title}${item.detail ? `\n${item.detail}` : ""}`)
  ));

  const [hookDraft, setHookDraft] = useState(() => joinNonEmpty(
    (payload.selectedHooks || []).map((item, idx) => `${idx + 1}. ${item.content}`)
  ));

  const [scriptDraft, setScriptDraft] = useState(() => joinNonEmpty(
    (payload.selectedScripts || []).map((item, idx) => `【文案 ${idx + 1}】\n${item.content}`)
  ));

  const [rewriteDraft, setRewriteDraft] = useState(() => joinNonEmpty(
    (payload.rewriteResults || []).map((item, idx) => `【${idx + 1} | ${item.target}】\n${item.rewritten}`)
  ));

  const [translationDraft, setTranslationDraft] = useState(() => joinNonEmpty(
    (payload.translationItems || []).map((item, idx) => `【${idx + 1} | ${item.sourceType}】\nZH: ${item.zh}\nEN: ${item.en}`)
  ));

  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const hasRewriteResult = (payload.rewriteResults || []).length > 0;
  const hasTranslationResult = (payload.translationItems || []).length > 0;

  const draftPayload = {
    titleDraft,
    hookDraft,
    scriptDraft,
    rewriteDraft: hasRewriteResult ? rewriteDraft : "",
    translationDraft: hasTranslationResult ? translationDraft : "",
    benchmarkVideos,
    taskInfo: payload.taskInfo || null,
  };

  const saveFinalDraft = async () => {
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload),
      });
      const data = await parseApiJson(response);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      if (data?.item?.id) {
        cacheFinalDraft(data.item);
      }
      const currentIndex = Number(payload.sourceGroupIndex || 0);
      const totalGroups = Number(payload.totalGroups || 0);
      const nextIndex = totalGroups > 0 ? Math.min(currentIndex + 1, totalGroups - 1) : 0;
      sessionStorage.setItem("contentActiveGroupIndex", String(nextIndex));
      setSaveMessage("保存成功，已返回内容生成页。");
      navigate("/content");
    } catch (error) {
      const fallbackItem = {
        id: `local_${Date.now()}`,
        createdAt: new Date().toISOString(),
        ...draftPayload,
      };
      cacheFinalDraft(fallbackItem);
      const currentIndex = Number(payload.sourceGroupIndex || 0);
      const totalGroups = Number(payload.totalGroups || 0);
      const nextIndex = totalGroups > 0 ? Math.min(currentIndex + 1, totalGroups - 1) : 0;
      sessionStorage.setItem("contentActiveGroupIndex", String(nextIndex));
      setSaveMessage("服务端保存失败，已先保存到本地浏览器待导出列表，并返回内容生成页。");
      navigate("/content");
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-8 py-6">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">最终文案编辑页</h1>
            <p className="text-sm text-slate-500 mt-1">已自动载入上一步勾选内容，可直接编辑。</p>
          </div>
          <Button variant="outline" onClick={() => navigate("/content") }>
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回内容确认页
          </Button>
        </div>
      </header>

      <div className="p-8 max-w-[1400px] mx-auto space-y-4">
        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">对标选题视频</CardTitle>
              <Badge className="bg-slate-100 text-slate-700">{benchmarkVideos.length} 条</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {benchmarkVideos.length > 0 ? benchmarkVideos.map((item, index) => (
              <div key={`${item.link || item.title || index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
                <div className="font-medium text-slate-900 break-words">{index + 1}. {item.title || "未命名选题"}</div>
                <div className="break-all text-xs text-slate-500">{item.link || "未提供链接"}</div>
                <div className="text-xs text-slate-600">
                  作者：{item.authorName || "未知"}{item.publishDate ? ` · 发布时间：${item.publishDate}` : ""}
                </div>
                <div className="text-xs text-slate-600">
                  封面：{item.coverUrl ? <span className="break-all text-slate-500">{item.coverUrl}</span> : "未提供"} · 时长：{formatDuration(item.durationSeconds)}
                </div>
                <div className="text-xs text-slate-600">
                  点赞 {formatMetric(item.likes)} / 评论 {formatMetric(item.comments)} / 转发 {formatMetric(item.shares)} / 收藏 {formatMetric(item.bookmarks)}
                </div>
              </div>
            )) : (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                当前最终文案未携带对标视频信息。
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">标题</CardTitle>
              <Badge className="bg-indigo-50 text-indigo-600">可编辑</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <textarea value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} className="w-full min-h-36 rounded-md border border-slate-300 p-3 text-sm" />
          </CardContent>
        </Card>

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2"><CardTitle className="text-base">3 秒留存</CardTitle></CardHeader>
          <CardContent>
            <textarea value={hookDraft} onChange={(e) => setHookDraft(e.target.value)} className="w-full min-h-28 rounded-md border border-slate-300 p-3 text-sm" />
          </CardContent>
        </Card>

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2"><CardTitle className="text-base">二创文案</CardTitle></CardHeader>
          <CardContent>
            <textarea value={scriptDraft} onChange={(e) => setScriptDraft(e.target.value)} className="w-full min-h-72 rounded-md border border-slate-300 p-3 text-sm leading-6" />
          </CardContent>
        </Card>

        {(hasRewriteResult || hasTranslationResult) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {hasRewriteResult && (
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-2"><CardTitle className="text-base">风格转写结果</CardTitle></CardHeader>
                <CardContent>
                  <textarea value={rewriteDraft} onChange={(e) => setRewriteDraft(e.target.value)} className="w-full min-h-44 rounded-md border border-slate-300 p-3 text-sm" />
                </CardContent>
              </Card>
            )}
            {hasTranslationResult && (
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-2"><CardTitle className="text-base">中英翻译结果</CardTitle></CardHeader>
                <CardContent>
                  <textarea value={translationDraft} onChange={(e) => setTranslationDraft(e.target.value)} className="w-full min-h-44 rounded-md border border-slate-300 p-3 text-sm" />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {saveMessage && (
          <div className="text-sm text-slate-600">{saveMessage}</div>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveFinalDraft} disabled={saveLoading}>
            <FileText className="h-4 w-4 mr-2" />
            {saveLoading ? "保存中..." : "保存最终文案"}
          </Button>
        </div>
      </div>
    </div>
  );
}
