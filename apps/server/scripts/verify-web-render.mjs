#!/usr/bin/env node
/**
 * 前端真渲染检查 —— `npm run verify:render`
 *
 * ── 为什么需要它（这是本项目摔过两次的地方）────────────────────────────────
 *
 * 本项目的 `npm run build` 只有 `vite build`，**不做类型检查**；而 `npm test` 只覆盖
 * 数据层。于是出现过一个反复出现的组合：
 *
 *     「构建成功 + 单测全绿」但**整页白屏**
 *
 * 已经发生过两次：
 *   1. 组件里调用了一个**没导入**的函数（构建期完全不报错）；
 *   2. TDZ —— 常量在声明前被使用（只在某条分支上炸）。
 *
 * 项目既有的对策是「改动后手动刷页面看一眼」。那依赖人记得、也依赖环境能起浏览器。
 * 这个脚本把「看一眼」里**最要命的那部分**自动化了：把页面与阶段组件**真的渲染一遍**，
 * 渲染期抛异常（未定义标识符 / TDZ / 组件类型是 undefined）就会被抓住。
 *
 * ── 它做了什么 ────────────────────────────────────────────────────────────
 *
 *   1. 用项目已有的 esbuild 把 `AccountPositioningPage` 与 `VideoAnalysisStage`
 *      连同 React 一起打成**单份 CJS 包**（单实例 React，避免 Invalid hook call）；
 *   2. 把 `window.sessionStorage` 打桩成「模块 4 / 4.1」，逼出那条子步骤轨道；
 *   3. `renderToString` 渲染，然后对渲染出的文本做断言。
 *
 * ⚠️ **它不能替代浏览器里的交互验证**：`useEffect`、事件处理器、真实网络请求
 *    都不在服务端渲染里跑。接口那半边由 `npm run verify:routes` 覆盖，
 *    而「点了按钮会发生什么」仍然需要人真点一次。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "../..");
const webDir = path.join(repoRoot, "apps/web");

// 临时产物放在 apps/web 下（需要能解析到仓库根的 node_modules），跑完即删。
const ENTRY = path.join(webDir, ".render-check-entry.ts");
const BUNDLE = path.join(webDir, ".render-check-bundle.cjs");

const ENTRY_SOURCE = `
import { renderToString } from "react-dom/server";
import { createElement, useMemo, useEffect, useRef, useState } from "react";
import { MemoryRouter, useNavigate, useSearchParams } from "react-router";
// ⚠️ AccountPositioningPage 是 **default** 导出，VideoAnalysisStage 是**具名**导出 ——
//    写混了就是 "Element type is invalid ... got: undefined"，正是本脚本要抓的那类错。
import AccountPositioningPage from "./src/app/AccountPositioningPage.tsx";
import { VideoAnalysisStage } from "./src/app/VideoAnalysisStage.tsx";
import { WeeklyAnalysisStage, WeeklyReportView } from "./src/app/WeeklyAnalysisStage.tsx";
import { ReviewVideoFields } from './src/app/ReviewVideoFields.tsx';
import { ReviewWorkbookImport } from './src/app/ReviewWorkbookImport.tsx';
import { getReviewInputOptions } from '../server/api/_lib/reviewWorkbookRecognition.js';
import { buildWeeklyAnalysisReport } from "../server/api/_lib/weeklyAnalysis.js";
import { weeklyInput, weeklyDictionary } from "../server/tests/helpers/weekly-fixture.mjs";
export { renderToString, createElement, MemoryRouter, AccountPositioningPage, VideoAnalysisStage, WeeklyAnalysisStage, WeeklyReportView };
export { ReviewVideoFields, ReviewWorkbookImport, getReviewInputOptions };
export const weeklyReport = buildWeeklyAnalysisReport({input: weeklyInput(), categoryDictionary: weeklyDictionary});
`;

const checks = [];
const check = (label, run) => {
  try {
    const value = run();
    const ok = typeof value === "string" ? value.length > 0 : Boolean(value);
    checks.push([ok, label, ok ? "" : "结果为空"]);
    return value;
  } catch (error) {
    checks.push([false, label, String(error?.message || error).replace(/\s+/g, " ").slice(0, 220)]);
    return "";
  }
};

const strip = html => String(html)
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, " ");

let exitCode = 1;

try {
  writeFileSync(ENTRY, ENTRY_SOURCE);
  const build = spawnSync(path.join(repoRoot, "node_modules/.bin/esbuild"), [
    ENTRY,
    "--bundle", "--format=cjs", "--platform=node", "--jsx=automatic", "--target=node20",
    // Vite 的 `import.meta.env` 在 CJS 里不存在，打个空桩（与浏览器里的取值无关，
    // 这些常量只在请求 URL 拼接时用，SSR 阶段不会发请求）。
    "--define:import.meta.env={}",
    `--outfile=${BUNDLE}`,
    "--log-level=error",
  ], { cwd: repoRoot, encoding: "utf8" });

  if (build.status !== 0) {
    console.error("打包前端组件失败：\n" + (build.stderr || build.stdout || "").slice(0, 2000));
    process.exit(1);
  }

  const require = createRequire(import.meta.url);
  const bundle = require(BUNDLE);
  const { renderToString, createElement, MemoryRouter, AccountPositioningPage, VideoAnalysisStage } = bundle;

  // ── 1. 阶段组件本身 ───────────────────────────────────────────────────
  const stageHtml = check("4.1 阶段组件能渲染（embedded）", () =>
    renderToString(createElement(VideoAnalysisStage, { embedded: true })));
  const stageText = strip(stageHtml);
  const stageFull = check("4.1 阶段组件能渲染（整页）", () =>
    renderToString(createElement(VideoAnalysisStage, {})));

  check("  渲染出数据填写入口", () => stageText.includes("第一步"));
  check("  说明分析的是自己账号的视频", () => stageText.includes("自己账号已发布的视频"));
  check("  给出 .xlsx 格式提示（.xls 要另存为）", () => stageText.includes("xlsx") && stageText.includes("另存为"));
  check("  有客户下拉", () => stageHtml.includes("<select"));
  check("  有文件选择控件", () => stageHtml.includes('type="file"'));
  check("  两个平台都能选", () => stageText.includes("抖音") && stageText.includes("视频号"));
  check("  整页版带页头标题", () => strip(stageFull).includes("复盘分析"));

  // ── 2. 账号定位页（把阶段草稿打桩成「模块 4 / 4.1」）───────────────────
  // stageDraft 的判据是 `typeof window !== "undefined" && Boolean(window.sessionStorage)`，
  // 所以只要给出 window.sessionStorage 就能喂进指定模块 —— 否则只能看到默认的模块 3。
  globalThis.window = {
    sessionStorage: {
      getItem: key => (key.endsWith("activeModuleId") ? '"review"'
        : key.endsWith("activeStepId") ? '"video-review"'
          : null),
      setItem: () => {},
    },
  };

  const pageHtml = check("账号定位页能渲染（模块 4 打开）", () =>
    renderToString(createElement(MemoryRouter, null, createElement(AccountPositioningPage))));
  const pageText = strip(pageHtml);

  check("  四个模块卡片都在（图标表没漏键）", () =>
    ["对标账号分析", "账号规划", "选题库构建", "复盘分析"].every(text => pageText.includes(text)));
  check("  模块 4 的子步骤轨道渲染出 4.1", () => pageText.includes("4.1") && pageText.includes("视频数据分析"));
  check("  模块 4 的子步骤轨道渲染出 4.2", () => pageText.includes("4.2") && pageText.includes("账号数据分析"));
  check("  4.1 挂的是真组件（不是「待实现」面板）", () => pageText.includes("第一步") && pageText.includes("数据填写方式"));
  check("  4.2 已开放（不再显示待实现）", () => !pageText.includes("待实现"));
  check("  页面没落进 ErrorBoundary 兜底文案", () =>
    !pageText.includes("出了点问题") && !pageText.includes("渲染出错") && !pageText.includes("页面出错了"));

  globalThis.window.sessionStorage.getItem = key => key.endsWith('activeModuleId') ? '"review"' : key.endsWith('activeStepId') ? '"account-review"' : null;
  const weeklyPage = check('4.2 导航挂载周度分析真实组件', () => renderToString(createElement(MemoryRouter, null, createElement(AccountPositioningPage))));
  check('4.2 显示周度填写入口', () => strip(weeklyPage).includes('填写并核对一周视频数据') && !strip(weeklyPage).includes('还没有实现'));
  const weeklyStage = check('4.2 独立阶段可渲染', () => renderToString(createElement(bundle.WeeklyAnalysisStage)));
  check('4.2 有账号、周期、条数输入', () => strip(weeklyStage).includes('账号名称') && strip(weeklyStage).includes('下周计划条数') && weeklyStage.includes('type="date"'));
  const weeklyReport = check('4.2 完整周报可渲染（有真实形状的统计）', () => renderToString(createElement(bundle.WeeklyReportView, { report: bundle.weeklyReport })));
  check('4.2 周报含绝对、相对、流量池与建议', () => ['绝对数据', '相对数据', '流量池分层', '优化建议方案'].every(s => strip(weeklyReport).includes(s)));
  check('4.2 缺 AI 建议显示待人工补充', () => strip(weeklyReport).includes('待人工补充'));
  check('4.1 默认显示数据表单，无需先上传 Excel', () => stageText.includes('直接填写') && stageText.includes('视频文案') && stageText.includes('开始分析'));
  check('4.2 默认可逐条填写并添加视频', () => strip(weeklyStage).includes('添加视频') && weeklyStage.includes('视频1发布时间'));
  const fields = check('平台字段表单可真实渲染', () => renderToString(createElement(bundle.ReviewVideoFields, { row: bundle.weeklyReport.sourceRows[0], onChange: () => {}, options: bundle.getReviewInputOptions('douyin') })));
  check('表单保留百分比值、零值与专业指标含义', () => fields.includes('32%') && strip(fields).includes('5s 完播率') && strip(fields).includes('反映开场'));
  const wechatFields = check('视频号字段表单可真实渲染', () => renderToString(createElement(bundle.ReviewVideoFields, { row: bundle.weeklyReport.sourceRows[0], onChange: () => {}, options: bundle.getReviewInputOptions('wechat_channels') })));
  check('切平台后展示正确指标', () => wechatFields.includes('aria-label="3 秒以上播放率"') && !wechatFields.includes('aria-label="2s 跳出率"'));
  check('Excel 识别入口可真实渲染', () => renderToString(createElement(bundle.ReviewWorkbookImport, { platform: 'douyin', mode: 'weekly', options: bundle.getReviewInputOptions('douyin'), onImport: () => {}, onBusyChange: () => {} })));

  console.log("── 前端真渲染检查（服务端渲染）──");
  let failed = 0;
  for (const [ok, label, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  → ${detail}` : ""}`);
  }
  console.log(`\n结果: ${checks.length - failed} passed / ${failed} failed`);
  console.log("⚠️ 服务端渲染抓不到 useEffect / 事件处理器 / 真实请求 —— 改了交互仍需真点一次。");
  exitCode = failed === 0 ? 0 : 1;
} finally {
  for (const file of [ENTRY, BUNDLE]) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

process.exit(exitCode);
