/**
 * 复盘分析的 **Excel 上传解析**（模块 4 的入口）。
 *
 * ── 为什么走 base64 + JSON，而不是 multipart ──────────────────────────────
 *
 * 项目里已有一个 multipart 上传先例（`src/manager/ai.js` 的 `extract-document`，用 multer），
 * 但它是**本地 Express 专有**的：Vercel serverless 那套（`api/**`）没有 multer，
 * `readBody` 也只解析 JSON。本项目「两套后端必须同步」是硬约束（HANDOFF §6.1⑤/§6.2⑤），
 * 所以这里选一条**两边都能跑**的路：前端把文件读成 base64 放进 JSON，
 * 后端解码成 Buffer 再解析。收益是两套入口共用同一段逻辑、零新增中间件。
 *
 * ⚠️ 代价与边界（照 `src/index.js` 里 `jsonWithImages` 的同一套说明写清楚）：
 *   · 请求体比原文件大约 1.33 倍，所以路由上单独放宽 body 上限，**不动全局 1mb**；
 *   · Vercel 侧请求体有 4.5MB 硬上限 —— 抬本地限制救不了线上，
 *     所以这里把**解码后的文件**卡在 5MB，并在超限时给能照做的中文提示。
 *   实测一周 60 条视频的导出表通常只有几十 KB，离上限很远。
 */

import { readWorkbook, rowsToObjects } from "./xlsxWorkbook.js";
import {
  ENGAGEMENT_METRIC_CATALOG,
  PROFESSIONAL_METRIC_CATALOG,
  metricsForPlatform,
  suggestColumnMapping,
} from "./reviewMetrics.js";

/** 解码后的 Excel 上限（base64 后约 6.7MB）。 */
export const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;

/** 最多回多少行给前端（一周 60 条足够；防止一个几万行的表把响应撑爆）。 */
export const MAX_WORKBOOK_ROWS = 500;

/** 最多回几个工作表。 */
export const MAX_WORKBOOK_SHEETS = 8;

const asText = value => String(value ?? "").trim();

const badRequest = message => Object.assign(new Error(message), { status: 400 });

/**
 * 给列映射界面用的指标下拉项。
 *
 * 🔴 **由后端下发，前端不另存一份**（同 §6.3-⑫ 的纪律）：指标清单、中文标签、
 *    「这个数字代表什么」的含义、以及哪个可缺，全部只在 `reviewMetrics.js` 里定义一次。
 *    前端多存一份必然漂移 —— 到时候界面能选「2s跳出率」而视频号根本没有这个指标。
 */
export const buildMetricOptions = platform => {
  const available = new Set(metricsForPlatform(platform).map(metric => metric.key));
  const pick = (catalog, group) => catalog
    .filter(metric => available.has(metric.key))
    .map(metric => ({ key: metric.key, label: metric.label, meaning: metric.meaning, optional: Boolean(metric.optional), kind: metric.kind || 'count', group }));
  return [...pick(ENGAGEMENT_METRIC_CATALOG, "engagement"), ...pick(PROFESSIONAL_METRIC_CATALOG, "professional")];
};

/**
 * 校验并解码 base64 文件。
 *
 * 分开写是因为**三种失败要给三种不同的提示**：格式不支持、文件太大、内容不是 Excel。
 * 用户看到的是「该怎么做」，不是「400 Bad Request」。
 */
export const decodeWorkbookFile = ({ fileName = "", dataBase64 = "" } = {}) => {
  const name = asText(fileName);
  const extension = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || "";

  if (extension === "xls") {
    // 老格式是 OLE 复合文档，不是 zip —— 本读取器**不支持**，如实说清楚怎么转。
    throw badRequest("不支持 .xls 老格式，请在 Excel 里「另存为」.xlsx 后再上传");
  }
  if (extension && !["xlsx", "xlsm"].includes(extension)) {
    throw badRequest(`只支持 .xlsx 文件（收到的是 .${extension}）`);
  }

  const raw = asText(dataBase64);
  if (!raw) throw badRequest("没有收到文件内容，请重新选择文件");

  // 去掉 dataURL 前缀（前端用 FileReader.readAsDataURL 时会有）。
  const pure = raw.includes(",") && raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  let buffer;
  try {
    buffer = Buffer.from(pure, "base64");
  } catch {
    throw badRequest("文件内容不是合法的 base64，请重新上传");
  }
  if (buffer.length === 0) throw badRequest("上传的 Excel 是空文件");
  if (buffer.length > MAX_WORKBOOK_BYTES) {
    throw badRequest(`Excel 不能超过 ${Math.round(MAX_WORKBOOK_BYTES / 1024 / 1024)}MB，当前约 ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
  }
  return { fileName: name || "未命名.xlsx", buffer };
};

/**
 * 解析上传的 Excel → 工作表 + **建议的列映射**。
 *
 * 🔴 列映射只是**建议**：界面必须让用户确认或改（用户 2026-09-30 明确要求）。
 *    猜错一个百分比列的口径会让整份报告全错，而用户从界面上看不出来 ——
 *    所以这里把 `unmatched`（没认出的列）与 `missingMetrics`（没找到列的指标）
 *    一并返回，界面据此提示「请指认播放量在哪一列」。
 *
 * @param platform 决定认哪些指标（抖音有 2s跳出率、视频号有 3秒以上播放率）
 */
export const parseWorkbookPayload = ({ fileName, dataBase64, platform = "douyin", sheetName } = {}) => {
  const { fileName: safeName, buffer } = decodeWorkbookFile({ fileName, dataBase64 });

  let sheets;
  try {
    sheets = readWorkbook(buffer);
  } catch (error) {
    // 读取器已经给了能照做的中文错误，这里只补上「是哪个文件」。
    throw badRequest(`${error?.message || "Excel 解析失败"}（文件：${safeName}）`);
  }
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw badRequest("这个 Excel 里没有任何工作表，请确认文件内容");
  }

  const wanted = asText(sheetName);
  const picked = wanted ? (sheets.find(sheet => sheet.name === wanted) || sheets[0]) : sheets[0];

  const allRows = Array.isArray(picked.rows) ? picked.rows : [];
  // 首行当表头；丢掉整行皆空的行（Excel 里常有）。
  const headerRowIndex = allRows.findIndex(row => (row || []).some(cell => asText(cell)));
  const headers = headerRowIndex >= 0 ? (allRows[headerRowIndex] || []).map(cell => asText(cell)) : [];
  const dataRows = allRows
    .slice(headerRowIndex + 1)
    .filter(row => (row || []).some(cell => asText(cell)))
    .slice(0, MAX_WORKBOOK_ROWS);

  const objects = headers.some(Boolean) ? rowsToObjects([headers, ...dataRows]) : [];
  const suggestion = headers.some(Boolean)
    ? suggestColumnMapping({ headers, platform })
    : { mapping: {}, unmatched: [], missingMetrics: [] };

  return {
    fileName: safeName,
    /** 全部工作表名，供界面切换（用户可能把数据放在第二张表）。 */
    sheetNames: sheets.slice(0, MAX_WORKBOOK_SHEETS).map(sheet => sheet.name),
    sheetName: picked.name,
    headers,
    /** 表头行之后的数据行（已去掉整行皆空的行）。 */
    rows: dataRows,
    /** 表头 → 值 的对象形式，界面做列映射预览时直接用。 */
    records: objects.slice(0, MAX_WORKBOOK_ROWS),
    suggestedMapping: suggestion.mapping,
    unmatchedHeaders: suggestion.unmatched,
    missingMetrics: suggestion.missingMetrics,
    /** 列映射下拉的选项（后端唯一定义，前端只渲染）。 */
    metricOptions: buildMetricOptions(platform),
    truncated: allRows.length - headerRowIndex - 1 > MAX_WORKBOOK_ROWS,
  };
};
