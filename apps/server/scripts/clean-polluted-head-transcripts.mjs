/**
 * 排查 / 清理 `scope: "head"` 里「明显不是 5 秒开场片段」的转写行。
 *
 * ── 背景（2026-09-21）────────────────────────────────────────────────────────
 * `transcribeTargets` 原来写的是 `scope === TAIL ? TAIL : HEAD`，只认 head / tail ——
 * 2.4「提取完整脚本」传进来的 `scope: "script"` 被**静默收敛成 head**，整篇口播被当成
 * 「开场几秒」写了进去。根因已修（`resolveTranscriptScope`），新写入不会再串。
 *
 * ⚠️ **但历史数据不能一概而论**，`head` 里出现长文本有**两种**来源，且在库里长得一模一样：
 *   (a) **设计内的回退**：2.2 只取开头几秒，若那几秒是纯音乐/静音，转写会返回空，
 *       代码会**回退成完整转写**再存回 head（见 transcribeTargets 里那段注释）。
 *       这类长文本是**正常**的 —— 完整转写的首句本来就是开场。
 *   (b) **串味**：修复前，2.4 的完整脚本被写进了 head。内容其实也是那条视频的口播，
 *       只是它压根不属于「开场片段」这个缓存槽。
 * 两者无法从数据上区分。好在它们都是**缓存**：删掉的代价只是下次 2.2 重新转写一次，
 * 不会丢报告、不会丢选题库。所以这里默认**只报告**，删不删由你决定。
 *
 * 用法：
 *   node scripts/clean-polluted-head-transcripts.mjs                      # 只报告
 *   node scripts/clean-polluted-head-transcripts.mjs --video-id 7574693   # 只看/清理某条视频
 *   node scripts/clean-polluted-head-transcripts.mjs --apply              # 删除命中的行
 *   node scripts/clean-polluted-head-transcripts.mjs --apply --min-length 200
 *
 * 删完不是万事大吉：**已经生成的 2.2 报告不会自动变**，要重跑一次 2.2 才会用上重新转写的内容。
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const COLLECTION = "gold_three_second_transcripts";
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const minLengthArg = args.indexOf("--min-length");
const videoIdArg = args.indexOf("--video-id");
// 5 秒口播正常 20~40 字；默认阈值 120 字，既躲开「语速快 + 片段略长」的正常行，
// 又能抓住几百字的完整脚本。想更保守就调大。
const MIN_LENGTH = minLengthArg >= 0 ? Number(args[minLengthArg + 1]) : 120;
const VIDEO_ID = videoIdArg >= 0 ? String(args[videoIdArg + 1] || "").trim() : "";

const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
if (!mongoUri) { console.error("缺少 MONGODB_URI"); process.exit(1); }

const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(String(process.env.MONGODB_DB_NAME || "").trim() || undefined);

const filter = {
  scope: "head",
  ...(VIDEO_ID ? { videoId: { $regex: VIDEO_ID } } : {}),
  $expr: { $gt: [{ $strLenCP: { $ifNull: ["$text", ""] } }, MIN_LENGTH] },
};
const rows = await db.collection(COLLECTION).find(filter).sort({ updatedAt: -1 }).toArray();

console.log(`库：${db.databaseName} | 集合：${COLLECTION}`);
console.log(`判据：scope=head 且正文长度 > ${MIN_LENGTH} 字${VIDEO_ID ? ` | videoId 含 ${VIDEO_ID}` : ""}`);
console.log(`命中：${rows.length} 条${rows.length ? "（长文本可能是设计内回退，也可能是修复前的串味，见文件头注释）" : ""}\n`);

let withScript = 0;
for (const row of rows) {
  const length = String(row.text || "").length;
  const preview = String(row.text || "").slice(0, 40).replace(/\s+/g, " ");
  const scriptRows = await db.collection(COLLECTION).countDocuments({ managerId: row.managerId, videoId: row.videoId, scope: "script" });
  if (scriptRows > 0) withScript += 1;
  console.log(`  · videoId=${row.videoId} | ${length} 字 | provider=${row.provider || "-"} | ${row.updatedAt ? new Date(row.updatedAt).toISOString() : "-"}`);
  console.log(`    开头：${preview}…`);
  console.log(`    ${scriptRows > 0 ? "⚠️ 同一视频已有 scope=script 的完整脚本 —— 这条 head 属于重复，删了没有损失" : "该视频没有 scope=script 记录（可能是 2.2 的空片段回退，删了下次会重转）"}`);
}

console.log("");
if (rows.length === 0) {
  console.log("没有命中任何行 —— 不需要清理。");
} else if (!apply) {
  console.log(`以上 ${rows.length} 条只是报告，**没有删除**（其中 ${withScript} 条已被 scope=script 覆盖，删掉无损失）。`);
  console.log("确认后执行：node scripts/clean-polluted-head-transcripts.mjs --apply");
} else {
  const result = await db.collection(COLLECTION).deleteMany({ _id: { $in: rows.map(row => row._id) } });
  console.log(`已删除 ${result.deletedCount} 条。下次跑 2.2 黄金三秒时，这几条会重新转写正确的开头片段。`);
  console.log("⚠️ 已生成的 2.2 报告不会自动更新，需要重跑一次该步骤。");
}

await client.close();
