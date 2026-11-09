import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WORKBOOK_BYTES,
  decodeWorkbookFile,
  parseWorkbookPayload,
} from "../api/_lib/reviewWorkbook.js";

/**
 * 复盘分析的 Excel 上传解析。
 *
 * 🔴 这里有两条**必须钉住**的行为：
 *   1. `.xls`（老格式）要给出**能照做**的提示 —— 它是 OLE 复合文档不是 zip，
 *      本读取器不支持。用户最可能的上传失败就是它，错误信息必须说清怎么转。
 *   2. 列映射只是**建议**：认不出就留空 + 报 `missingMetrics`，
 *      **绝不猜**。猜错一个百分比列的口径会让整份报告全错，而用户看不出来。
 *
 * ⚠️ 测试自己合成 xlsx（STORE 不压缩的最小 zip），**不依赖磁盘 fixture、不引第三方包**。
 */

// ── 最小 zip 构造器（method=0 STORE；读取器不校验 CRC，所以填 0）────────────
const buildStoreZip = files => {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);              // method = STORE
    local.writeUInt32LE(0, 14);             // crc（不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
};

const esc = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const buildSheetXml = rows => {
  const body = rows.map((cells, index) => {
    const refs = cells.map((cell, col) => {
      const ref = `${String.fromCharCode(65 + col)}${index + 1}`;
      return cell === null || cell === undefined
        ? ""
        : `<c r="${ref}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${index + 1}">${refs}</row>`;
  }).join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
};

/** 造一个真实结构的小 xlsx（含 rels，且 Target 写在 Id 之前 —— openpyxl 风格）。 */
const buildXlsx = sheets => {
  const sheetFiles = sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, buildSheetXml(sheet.rows)]);
  const workbookXml = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets
    .map((sheet, index) => `<sheet name="${esc(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("")}</sheets></workbook>`;
  const relsXml = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((sheet, index) => `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${index + 1}.xml" Id="rId${index + 1}"/>`)
    .join("")}</Relationships>`;
  return buildStoreZip([
    ["[Content_Types].xml", "<Types/>"],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", relsXml],
    ...sheetFiles,
  ]);
};

const HEADERS = ["视频标题", "发布时间", "播放量", "点赞", "评论", "转发", "收藏", "完播率", "2s跳出率", "5s完播率", "平均播放时长", "视频时长"];
const ROW_A = ["员工主动离职能不能要赔偿？", "2026-09-21", "12500", "830", "96", "210", "340", "0.32", "0.18", "0.55", "42.5", "118"];
const ROW_B = ["试用期不签合同，公司赔了8万", "2026-09-22", "860", "41", "7", "3", "12", "0.12", "0.58", "0.21", "12", "96"];

const asBase64 = buffer => buffer.toString("base64");

// ── 文件校验与解码 ────────────────────────────────────────────────────────

test("🔴 .xls 老格式给出能照做的提示（它是 OLE 复合文档，不是 zip）", () => {
  assert.throws(
    () => decodeWorkbookFile({ fileName: "数据.xls", dataBase64: asBase64(Buffer.from("x")) }),
    error => error.status === 400 && /另存为/.test(error.message) && /\.xlsx/.test(error.message),
  );
});

test("非 Excel 扩展名被挡，并说清收到的是什么", () => {
  assert.throws(
    () => decodeWorkbookFile({ fileName: "数据.csv", dataBase64: asBase64(Buffer.from("x")) }),
    error => error.status === 400 && /只支持/.test(error.message) && /csv/.test(error.message),
  );
});

test("空内容 / 空文件被挡", () => {
  assert.throws(
    () => decodeWorkbookFile({ fileName: "a.xlsx", dataBase64: "" }),
    error => error.status === 400 && /没有收到文件内容/.test(error.message),
  );
  // ⚠️ `Buffer.alloc(0)` 的 base64 **就是空串**，所以它命中的是上面那条守卫，
  //    不是「空文件」那条 —— 如实记在这里，免得下一个会话以为漏了一个分支。
  assert.throws(
    () => decodeWorkbookFile({ fileName: "a.xlsx", dataBase64: asBase64(Buffer.alloc(0)) }),
    error => error.status === 400 && /没有收到文件内容/.test(error.message),
  );
  // 「空文件」那条分支的真实入口：base64 串非空但解码后长度为 0。
  assert.throws(
    () => decodeWorkbookFile({ fileName: "a.xlsx", dataBase64: "====" }),
    error => error.status === 400 && /空文件/.test(error.message),
  );
});

test("超过体积上限时提示实际大小", () => {
  const big = Buffer.alloc(MAX_WORKBOOK_BYTES + 16);
  assert.throws(
    () => decodeWorkbookFile({ fileName: "a.xlsx", dataBase64: asBase64(big) }),
    error => error.status === 400 && /不能超过/.test(error.message),
  );
});

test("认 dataURL 前缀（前端用 readAsDataURL 时会带上）", () => {
  const buffer = buildXlsx([{ name: "表1", rows: [["播放量"], ["100"]] }]);
  const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${asBase64(buffer)}`;
  const parsed = decodeWorkbookFile({ fileName: "a.xlsx", dataBase64: dataUrl });
  assert.equal(parsed.buffer.length, buffer.length);
});

// ── 解析 + 列映射建议 ─────────────────────────────────────────────────────

test("解析真实结构的 xlsx：表头、数据行、对象形式、建议映射全对", () => {
  const buffer = buildXlsx([{ name: "视频数据", rows: [HEADERS, ROW_A, ROW_B] }]);
  const parsed = parseWorkbookPayload({ fileName: "一周数据.xlsx", dataBase64: asBase64(buffer), platform: "douyin" });

  assert.equal(parsed.fileName, "一周数据.xlsx");
  assert.equal(parsed.sheetName, "视频数据");
  assert.deepEqual(parsed.sheetNames, ["视频数据"]);
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0]["播放量"], "12500");
  assert.equal(parsed.truncated, false);

  // 列映射建议：中文标准表头全部认出来
  assert.equal(parsed.suggestedMapping["播放量"], "plays");
  assert.equal(parsed.suggestedMapping["完播率"], "completionRate");
  assert.equal(parsed.suggestedMapping["2s跳出率"], "bounce2sRate");
  // 标题/发布时间不是指标列
  assert.deepEqual(parsed.unmatchedHeaders, ["视频标题", "发布时间"]);
  assert.deepEqual(parsed.missingMetrics, []);
});

test("表头前有整行空行时自动跳过（Excel 导出常见）", () => {
  const buffer = buildXlsx([{ name: "Sheet1", rows: [[null, null, null], HEADERS, ROW_A] }]);
  const parsed = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer) });
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.rows.length, 1);
});

test("数据行里的整行空行被丢掉", () => {
  const buffer = buildXlsx([{ name: "Sheet1", rows: [HEADERS, ROW_A, [null, null, null], ROW_B] }]);
  const parsed = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer) });
  assert.equal(parsed.rows.length, 2);
});

test("可以按名字指定工作表（用户把数据放在第二张表时）", () => {
  const buffer = buildXlsx([
    { name: "说明", rows: [["字段", "含义"], ["点赞", "共鸣"]] },
    { name: "视频数据", rows: [HEADERS, ROW_A] },
  ]);
  const byDefault = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer) });
  assert.equal(byDefault.sheetName, "说明");

  const byName = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), sheetName: "视频数据" });
  assert.equal(byName.sheetName, "视频数据");
  assert.equal(byName.suggestedMapping["播放量"], "plays");

  // 指定的表名不存在时回落到第一张，不报错（用户点了别的表又删了）
  const fallback = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), sheetName: "不存在" });
  assert.equal(fallback.sheetName, "说明");
  assert.deepEqual(fallback.sheetNames, ["说明", "视频数据"]);
});

test("平台不同 → 建议的列映射也不同（视频号认红心与 3秒以上播放率）", () => {
  const buffer = buildXlsx([{
    name: "视频数据",
    rows: [["播放量", "点赞", "评论", "转发", "红心", "完播率", "3秒以上播放率"], ["5000", "300", "40", "80", "200", "0.32", "0.65"]],
  }]);
  const douyin = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), platform: "douyin" });
  const wechat = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), platform: "wechat_channels" });

  assert.equal(wechat.suggestedMapping["红心"], "recommends");
  assert.equal(wechat.suggestedMapping["3秒以上播放率"], "play3sRate");
  assert.equal(douyin.suggestedMapping["红心"], undefined);
  assert.ok(douyin.unmatchedHeaders.includes("红心"));
});

test("认不出的表头如实进 unmatchedHeaders，不硬凑一个指标", () => {
  const buffer = buildXlsx([{ name: "Sheet1", rows: [["甲", "乙"], ["1", "2"]] }]);
  const parsed = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer) });
  assert.deepEqual(parsed.unmatchedHeaders, ["甲", "乙"]);
  assert.ok(parsed.missingMetrics.includes("plays"), "没认出播放量 → 必须提示用户指认");
});

test("不是 Excel 的字节流 → 400 中文错误，不抛到进程级", () => {
  const buffer = buildStoreZip([["random.txt", "这不是 Excel"]]);
  assert.throws(
    () => parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer) }),
    error => error.status === 400 && /Excel/.test(error.message),
  );
});

test("下发给列映射界面的指标选项：按平台过滤、带含义、标出可选", () => {
  const buffer = buildXlsx([{ name: "Sheet1", rows: [HEADERS, ROW_A] }]);
  const douyin = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), platform: "douyin" });
  const wechat = parseWorkbookPayload({ fileName: "a.xlsx", dataBase64: asBase64(buffer), platform: "wechat_channels" });

  const douyinKeys = douyin.metricOptions.map(item => item.key);
  const wechatKeys = wechat.metricOptions.map(item => item.key);

  assert.ok(douyinKeys.includes("bounce2sRate"));
  assert.ok(!douyinKeys.includes("play3sRate"), "抖音不该出现「3秒以上播放率」");
  assert.ok(wechatKeys.includes("play3sRate"));
  assert.ok(!wechatKeys.includes("bounce2sRate"), "视频号不该出现「2s跳出率」");
  assert.ok(wechatKeys.includes("recommends"));
  assert.ok(!wechatKeys.includes("bookmarks"));

  // 每个选项都要带「这个数字代表什么」—— 用户要求把含义显示出来
  assert.ok(douyin.metricOptions.every(item => item.meaning && item.label));
  // 「关注」标可选
  assert.equal(douyin.metricOptions.find(item => item.key === "follows").optional, true);
  // 分组正确
  assert.equal(douyin.metricOptions.find(item => item.key === "likes").group, "engagement");
  assert.equal(douyin.metricOptions.find(item => item.key === "plays").group, "professional");
});
