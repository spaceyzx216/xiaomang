import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { FileText, ArrowLeft, Download } from "lucide-react";

type FinalDraftPayload = {
  selectedTitles?: Array<{ title: string; detail?: string; raw?: string }>;
  selectedHooks?: Array<{ id: string; content: string; hookType: string }>;
  selectedScripts?: Array<{ id: string; title: string; content: string }>;
  rewriteResults?: Array<{ id: string; original: string; rewritten: string; target: string }>;
  translationItems?: Array<{ id: string; zh: string; en: string; sourceType: string }>;
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

export default function FinalEditorPage() {
  const navigate = useNavigate();
  const payload = useMemo(() => loadDraftPayload(), []);

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
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);

  const hasRewriteResult = (payload.rewriteResults || []).length > 0;
  const hasTranslationResult = (payload.translationItems || []).length > 0;

  const draftPayload = {
    titleDraft,
    hookDraft,
    scriptDraft,
    rewriteDraft: hasRewriteResult ? rewriteDraft : "",
    translationDraft: hasTranslationResult ? translationDraft : "",
  };

  const saveFinalDraft = async () => {
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const response = await fetch("/tikhub-proxy/api/final-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setSavedDraftId(String(data?.item?.id || "") || null);
      setSaveMessage("保存成功，已临时落库（导出后将自动删除）。");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaveLoading(false);
    }
  };

  const clearSavedDraftAfterExport = async () => {
    if (!savedDraftId) return;
    try {
      await fetch(`/tikhub-proxy/api/final-drafts/${savedDraftId}`, {
        method: "DELETE",
      });
      setSavedDraftId(null);
    } catch {
      // ignore delete failures
    }
  };

  const downloadFile = async (apiPath: string, fallbackName: string) => {
    const response = await fetch(apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftPayload),
    });
    if (!response.ok) {
      const t = await response.text();
      throw new Error(t || `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const matched = disposition.match(/filename="([^"]+)"/);
    const filename = matched?.[1] || fallbackName;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    await clearSavedDraftAfterExport();
    setSaveMessage("导出完成，临时保存记录已自动删除。");
  };

  const exportWord = async () => {
    await downloadFile("/tikhub-proxy/api/export/word", "final-copy.doc");
  };

  const exportExcel = async () => {
    await downloadFile("/tikhub-proxy/api/export/excel", "final-copy.csv");
  };

  const clearLegacyDraftFile = async () => {
    try {
      await fetch("/tikhub-proxy/api/final-drafts", { method: "DELETE" });
    } catch {
      // ignore cleanup errors
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
          <Button variant="outline" onClick={exportWord}>
            <Download className="h-4 w-4 mr-2" />
            导出 Word
          </Button>
          <Button variant="outline" onClick={exportExcel}>
            <Download className="h-4 w-4 mr-2" />
            导出 Excel
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveFinalDraft} disabled={saveLoading}>
            <FileText className="h-4 w-4 mr-2" />
            {saveLoading ? "保存中..." : "保存最终文案"}
          </Button>
        </div>
      </div>
    </div>
  );
}
