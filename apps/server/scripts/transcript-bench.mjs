// 转写性能基准（黄金三秒链路 vs 旧全局链路）。
//
//   node scripts/transcript-bench.mjs            # 默认 4 条
//   BENCH_VIDEOS=8 node scripts/transcript-bench.mjs
//
// 只读真实库取视频链接，会真的调用 TikHub / 豆包 ASR（有成本）。
// 刻意绕开 Mongo 转写缓存，所以每次都真跑 —— 这样才能比较「冷启动」成本。
import fs from "node:fs";
import { MongoClient } from "mongodb";

const envText = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
for (const line of envText.split("\n")) {
  if (!line.includes("=") || line.trim().startsWith("#")) continue;
  const i = line.indexOf("=");
  const k = line.slice(0, i).trim();
  if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim();
}
// 让 config 用 .env 里的原始值，方便对比「旧全局链路」
delete process.env.TRANSCRIPT_PROVIDERS;

const { getContentAgentConfig } = await import("../api/_lib/contentAgent/config.js");
const { resolveTikHubVideo, transcribeVideo, clearTranscriptCacheForTests } = await import(
  "../api/_lib/contentAgent/providers.js"
);

const VIDEO_COUNT = Number(process.env.BENCH_VIDEOS || 4);

const cap = () => {
  const events = [];
  const push = level => (event, fields = {}) => events.push({ level, event, fields });
  return { events, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
};
const avg = arr => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB_NAME || undefined);
const report = (await db.collection("benchmark_reports").find({}).sort({ createdAt: -1 }).limit(1).toArray())[0];
await client.close();
if (!report) throw new Error("库里没有分类报告");
const videos = (report.report?.videos || []).filter(v => v.link).slice(0, VIDEO_COUNT);

const config = getContentAgentConfig();
console.log(`账号：${report.accountName}｜${videos.length} 条\n`);
console.log(`  旧全局链路     : ${config.transcriptProviders.join(" → ")}`);
console.log(`  黄金三秒新链路 : ${config.goldTranscriptProviders.join(" → ")}  (裁剪 ${config.goldTranscriptClipSeconds}s)\n`);

const silent = { info() {}, warn() {}, error() {} };
const cases = [
  { name: "旧链路", providers: config.transcriptProviders, clip: 0 },
  { name: "黄金三秒新链路", providers: config.goldTranscriptProviders, clip: config.goldTranscriptClipSeconds },
];

const rows = [];
for (const video of videos) {
  let meta;
  const tResolve = Date.now();
  try {
    meta = await resolveTikHubVideo(video.link, config, { logger: silent, platform: "douyin" });
  } catch (error) {
    console.log(`  ${video.id} 解析失败：${error.message}`);
    continue;
  }
  const resolveMs = Date.now() - tResolve;
  const hasMusic = Boolean(meta.musicUrl);

  for (const c of cases) {
    clearTranscriptCacheForTests();
    const log = cap();
    const t0 = Date.now();
    let ok = true, text = "", provider = "", err = "";
    try {
      const out = await transcribeVideo(meta, config, { logger: log.logger, clipSeconds: c.clip, providers: c.providers });
      text = String(out?.text || "");
      provider = String(out?.provider || "");
    } catch (error) {
      ok = false;
      err = `${error?.code || ""} ${error.message}`.slice(0, 60);
    }
    const totalMs = Date.now() - t0;
    const asrMs = log.events.filter(e => String(e.fields.interface || "").includes("asr"))
      .reduce((a, e) => a + Number(e.fields.durationMs || 0), 0);
    // 提取阶段 = ffmpeg.extract.start → ffmpeg.extract.end（含下载，因为 ffmpeg 直接从流里读）
    const end = log.events.find(e => e.event === "ffmpeg.extract.end");
    const extractMs = end ? Number(end.fields.durationMs || 0) : 0;

    rows.push({ videoId: video.id, run: c.name, ok, totalMs, resolveMs, hasMusic, asrMs, extractMs, provider: provider || err, textLen: text.length });
    console.log(
      `  ${video.id}｜mp3直链 ${hasMusic ? "有" : "无"}｜[${c.name}] ${ok ? "✅" : "❌"} 总 ${totalMs}ms（提取 ${extractMs}ms + ASR ${asrMs}ms）｜${provider || err}｜${text.length}字`,
    );
  }
  console.log();
}

console.log("════ 汇总（每条平均）════");
const byRun = {};
for (const r of rows) (byRun[r.run] ||= []).push(r);
for (const [name, list] of Object.entries(byRun)) {
  const okList = list.filter(r => r.ok);
  console.log(
    `  ${name}: n=${list.length} 成功 ${okList.length}｜总 ${avg(list.map(r => r.totalMs))}ms｜提取 ${avg(list.map(r => r.extractMs))}ms｜ASR ${avg(list.map(r => r.asrMs))}ms`,
  );
}
console.log(`\n  每条 TikHub 解析（两轮共用，只算一次）：平均 ${avg(rows.map(r => r.resolveMs))}ms`);

// ───────────────────────────────────────────────────────────────────────────
// 第二节：整批路径（transcribeTargets）—— 这才是端点真正走的代码。
// 对比「旧设置（每批 3 条 + 不预取解析）」与「现设置（每批 30 + 预取 8）」。
// 用 BENCH_BATCH=0 跳过这一节。
// ───────────────────────────────────────────────────────────────────────────
if (String(process.env.BENCH_BATCH || "1") !== "0") {
  const { transcribeTargets, selectTranscriptTargets } = await import("../api/_lib/goldThreeSecondTranscripts.js");
  const batchVideos = Number(process.env.BENCH_BATCH_VIDEOS || 12);
  const targets = selectTranscriptTargets(report.report, batchVideos).slice(0, batchVideos);

  const batchCases = [
    { name: "旧设置（批3·无预取）", concurrency: 3, resolveConcurrency: 0, batchSize: 3 },
    { name: "新设置（批30·预取8）", concurrency: config.goldTranscriptConcurrency, resolveConcurrency: config.goldTranscriptResolveConcurrency, batchSize: config.goldTranscriptBatchSize },
  ];

  console.log(`\n════ 整批路径（${targets.length} 条，含解析）════`);
  for (const c of batchCases) {
    clearTranscriptCacheForTests();
    const silentLogger = { info() {}, warn() {}, error() {} };
    const t0 = Date.now();
    let done = 0;
    // 模拟端点的分批循环：每批最多 batchSize 条，跑到达标或没有待办为止
    let remaining = [...targets];
    let rounds = 0;
    while (remaining.length > 0 && rounds < 80) {
      rounds += 1;
      const batch = remaining.slice(0, c.batchSize);
      await transcribeTargets({
        targets: batch,
        config,
        logger: silentLogger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: c.concurrency,
        resolveConcurrency: c.resolveConcurrency,
        onResult: () => { done += 1; },
      });
      remaining = remaining.slice(batch.length);
    }
    const totalMs = Date.now() - t0;
    console.log(`  ${c.name}: ${done}/${targets.length} 条｜${rounds} 轮｜合计 ${(totalMs / 1000).toFixed(1)}s｜每条 ${Math.round(totalMs / Math.max(1, done))}ms`);
  }
}
