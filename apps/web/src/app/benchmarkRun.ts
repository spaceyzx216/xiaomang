import { apiUrl, fetchWithRetry } from "./api";
import {
  extractAccountProfile,
  normalizeBenchmarkVideosFromBatch,
  type BenchmarkContentStyle,
  type BenchmarkPlatform,
  type BenchmarkReport,
} from "./benchmarkAnalysis";
import { parseApiError } from "./reportApi";

/** 抓取 + 分类一个账号的产出：内存里的分类报告，以及这份报告覆盖的作品条数。 */
export type ClassificationRunResult = {
  report: BenchmarkReport;
  videoCount: number;
};

/** 账号名按老口径截断：上游偶尔把一整段简介塞进作者名，直接透传会把报告头撑爆。 */
const compactInput = (value: string) => String(value || "").trim().slice(0, 200);

/**
 * 抓取**一个**对标账号的最新 60 条作品并跑分类 Agent，返回分类报告。
 *
 * 2.1「对标账号分类分析」和 1.2「对标账号分析」的输入是同一件事 —— 1.2 允许直接分析一个
 * 新账号，那就得先跑一次 2.1 的分类。这段抓取 + 分类的逻辑因此只能有一份。
 *
 * **报告落不落库由调用方决定**：2.1 会把它交给用户确认后保存，1.2 只拿它当本次分析的输入，
 * 不写进「已保存的分类报告」列表。
 *
 * 抓取阶段的进度文案由调用方给：2.1 要标出「第 N/M 个账号」，1.2 要说清这是本模块的前置步骤，
 * 这两句都带着调用方的语境，helper 自己编不出来；第二句（已抓取 N 条…）与账号无关，在这里发。
 */
export const runAccountClassification = async (options: {
  accountUrl: string;
  platform: BenchmarkPlatform;
  contentStyle: BenchmarkContentStyle;
  /** 抓取阶段的进度文案，例如「正在抓取第 1/3 个账号的最新 60 条作品…」。 */
  fetchProgressMessage: string;
  onProgress?: (message: string) => void;
}): Promise<ClassificationRunResult> => {
  const { accountUrl, platform, contentStyle, fetchProgressMessage, onProgress } = options;

  onProgress?.(fetchProgressMessage);
  const batchResponse = await fetchWithRetry(apiUrl("/api/tikhub/batch"), {
    method: "POST",
    retries: 1,
    retryBaseDelayMs: 800,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [accountUrl], platform, latestOnly: true, maxPages: 20, count: 60 }),
  });
  const batchData = await parseApiError(batchResponse);
  const result = batchData?.results?.[0];
  if (!result || result.error) throw new Error(String(result?.error || "未能获取该账号的视频作品"));
  const videos = normalizeBenchmarkVideosFromBatch(result, platform);
  if (videos.length === 0) throw new Error("该账号没有返回可分析的视频作品");

  onProgress?.(`已抓取 ${videos.length} 条，正在运行${contentStyle === "spoken" ? "口播类" : "演绎类"}分析 Agent…`);
  const analysisResponse = await fetchWithRetry(apiUrl("/api/agent/benchmark-analysis"), {
    method: "POST",
    retries: 0,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentStyle,
      platform,
      accountUrl,
      accountName: compactInput(result.authorName),
      fetchMode: result.fetchMode || "latest",
      // 账号简介与粉丝数：模块 1「对标账号分析」的商业定位要用。
      // TikHub 本来就抓回来了，只是分类报告以前把它丢掉了。
      // 取不到就是空串，由后端如实落成「待人工补充」，绝不猜一个简介。
      accountProfile: extractAccountProfile(result),
      videos,
    }),
  });
  const analysisData = await parseApiError(analysisResponse);
  const report = analysisData?.report as BenchmarkReport | undefined;
  if (!report) throw new Error("分析 Agent 没有返回有效报告");

  return { report, videoCount: videos.length };
};
