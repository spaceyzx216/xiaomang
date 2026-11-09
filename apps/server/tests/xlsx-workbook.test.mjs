import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { readWorkbook, readSheetRows, rowsToObjects } from "../api/_lib/xlsxWorkbook.js";

/**
 * 零依赖 .xlsx 读取器的契约测试。
 *
 * **不依赖磁盘上的 fixture，也不依赖任何第三方库**：xlsx 就是一个 zip，测试里自己拼
 * 本地头 + 中央目录 + EOCD，再用 zlib.deflateRawSync 造出 deflate 流。这样每条断言
 * 都对应一份「我知道每个字节是什么」的文件，读错了能直接定位到是哪段结构没解析对；
 * 借 openpyxl 生成的样例文件来测，就只能看到「结果不对」，看不到为什么不对。
 *
 * 真实文件的关键差异（属性顺序、绝对 Target、数据描述符）都在这里按结构复现，
 * 详见「真实文件结构」那几条。
 */

/* ------------------------------------------------------- 最小 zip 写入器 */

// CRC32 只是为了让造出来的 fixture 是**合法 zip**（我们的读取器不校验它，
// 但 fixture 要经得起 unzip 之类的外部工具复核）。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};

/**
 * files: [{ name, data, method?, compSizeZero?, rawData? }]
 *   method 0 = STORE，8 = DEFLATE（默认）
 *   compSizeZero: 中央目录里的 compSize 写 0（模拟流式写入器把大小留在数据描述符里）
 *   rawData: 原样写入，不做压缩（用来造「声明 deflate、实际是坏流」的部件）
 */
const buildZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const method = file.method === 0 ? 0 : 8;
    const data = file.rawData || method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.compSizeZero ? 0 : data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移

  return Buffer.concat([...localParts, centralDir, eocd]);
};

/* --------------------------------------------------- 最小 xlsx 部件写入器 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const NS_REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

const escapeXml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// —— 单元格构造：t 的四种取值 + 布尔/错误值 ——
const sharedCell = (ref, index, extra = "") => `<c r="${ref}" t="s"${extra}><v>${index}</v></c>`;
const inlineCell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
// 原样塞进 <t>：用来手写 &amp; / &#35270; 这类实体，验证读取器真的解了它们
const rawInlineCell = (ref, rawText) => `<c r="${ref}" t="inlineStr"><is><t>${rawText}</t></is></c>`;
const numberCell = (ref, literal) => `<c r="${ref}"><v>${literal}</v></c>`;
const formulaCell = (ref, formula, text) => `<c r="${ref}" t="str"><f>${escapeXml(formula)}</f><v>${escapeXml(text)}</v></c>`;
const boolCell = (ref, literal) => `<c r="${ref}" t="b"><v>${literal}</v></c>`;
const errorCell = (ref, literal) => `<c r="${ref}" t="e"><v>${literal}</v></c>`;

const row = (r, cells) => `<row r="${r}">${cells}</row>`;
const sheetPart = (rowsXml) => `${XML_HEAD}<worksheet ${NS_MAIN}><sheetData>${rowsXml}</sheetData></worksheet>`;

/**
 * sheets: [{ name, xml, target? }]
 * sharedStrings: 字符串数组（不给就不生成 xl/sharedStrings.xml）
 * relationshipOrder: "excel"（Id 在前）| "openpyxl"（Target 在前 + 绝对路径）
 * method: 数字，或 (partName) => 0|8，用来在同一次测试里混用 STORE / DEFLATE
 */
const buildXlsx = ({ sheets, sharedStrings, relationshipOrder = "excel", method = 8, compSizeZeroPart = "" }) => {
  const pick = (name) => (typeof method === "function" ? method(name) : method);

  const sheetTags = sheets
    // rawName：原样写进 XML 的属性值，用来手写实体（如 name="客户&amp;订单&#35270;"）
    .map((sheet, i) => `<sheet name="${sheet.rawName ?? escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");

  const relationships = sheets
    .map((sheet, i) => {
      const target = sheet.target ?? `worksheets/sheet${i + 1}.xml`;
      const absolute = relationshipOrder === "openpyxl" && !target.startsWith("/") ? `/${"xl/"}${target}` : target;
      // 属性顺序刻意不同：Excel 写 Id 在前，openpyxl 写 Target 在前。
      return relationshipOrder === "openpyxl"
        ? `<Relationship Target="${escapeXml(absolute)}" Type="${REL_TYPE}" Id="rId${i + 1}"/>`
        : `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}" Target="${escapeXml(target)}"/>`;
    })
    .join("");

  const files = [
    {
      name: "[Content_Types].xml",
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    },
    {
      name: "xl/workbook.xml",
      data: `${XML_HEAD}<workbook ${NS_MAIN} ${NS_REL}><sheets>${sheetTags}</sheets></workbook>`,
    },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML_HEAD}<Relationships>${relationships}</Relationships>` },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheet.xml })),
  ];

  if (sharedStrings) {
    const items = sharedStrings.map((text) => `<si>${text}</si>`).join("");
    files.push({ name: "xl/sharedStrings.xml", data: `${XML_HEAD}<sst ${NS_MAIN} count="${sharedStrings.length}">${items}</sst>` });
  }

  if (compSizeZeroPart) {
    // 放到最前面：让「解到流结束」真的会遇到后面部件的字节，而不是刚好读到文件尾。
    const index = files.findIndex((file) => file.name === compSizeZeroPart);
    const [moved] = files.splice(index, 1);
    files.unshift({ ...moved, compSizeZero: true });
  }

  return buildZip(files.map((file) => ({ ...file, method: pick(file.name) })));
};

// 每行等长是上游（rowsToObjects / 表格导入）不出错的前提，统一在这里断言。
const assertRectangular = (rows) => {
  const width = rows[0]?.length ?? 0;
  for (const [i, rowValues] of rows.entries()) {
    assert.equal(rowValues.length, width, `第 ${i + 1} 行长度应为 ${width}`);
  }
  return rows;
};

/* ------------------------------------------------------------ 压缩方式 */

test("STORE（method=0）与 DEFLATE（method=8）都能读出同一份数据", () => {
  const xml = sheetPart(row(1, inlineCell("A1", "客户") + inlineCell("B1", "金额")) + row(2, inlineCell("A2", "甲公司") + numberCell("B2", "1200")));
  const expected = [
    ["客户", "金额"],
    ["甲公司", "1200"],
  ];

  const deflated = buildXlsx({ sheets: [{ name: "订单", xml }], method: 8 });
  const stored = buildXlsx({ sheets: [{ name: "订单", xml }], method: 0 });

  // 两份输入的字节完全不同（一个存原文、一个存 deflate 流），结果必须一致。
  assert.notDeepEqual(deflated, stored);
  assert.deepEqual(readWorkbook(deflated), [{ name: "订单", rows: expected }]);
  assert.deepEqual(readWorkbook(stored), [{ name: "订单", rows: expected }]);
});

test("同一个 zip 里混用 STORE 与 DEFLATE 也能读", () => {
  const xml = sheetPart(row(1, inlineCell("A1", "混合")));
  const buffer = buildXlsx({
    sheets: [{ name: "表1", xml }],
    sharedStrings: ["<t>共享串</t>"],
    // workbook.xml 存原文，其余部件 deflate
    method: (name) => (name === "xl/workbook.xml" ? 0 : 8),
  });

  assert.deepEqual(readWorkbook(buffer), [{ name: "表1", rows: [["混合"]] }]);
});

test("中央目录里 compSize=0 时兜底「从数据起点解到流结束」（deflate 与 store 都要）", () => {
  const xml = sheetPart(
    row(1, inlineCell("A1", "兜底") + inlineCell("B1", "第二列")) + row(2, inlineCell("A2", "第二行")),
  );
  const expected = [
    ["兜底", "第二列"],
    ["第二行", ""],
  ];

  for (const method of [8, 0]) {
    const buffer = buildXlsx({ sheets: [{ name: "表1", xml }], method, compSizeZeroPart: "xl/worksheets/sheet1.xml" });
    // 兜底时 raw 一直取到文件尾，尾部还有别的部件的字节：必须完整解出整张表，不能只解一半。
    assert.deepEqual(readWorkbook(buffer), [{ name: "表1", rows: expected }], `method=${method} 时 compSize=0 的兜底应生效`);
  }
});

/* ------------------------------------------------------- 单元格取值路径 */

test("t=\"s\" 走 sharedStrings 查表（含富文本拼接与注音剔除）", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "共享串",
        xml: sheetPart(
          row(1, sharedCell("A1", 0) + sharedCell("B1", 1)) +
            // 富文本：一条 <si> 拆成多个 <r><t>，必须拼成一个单元格
            row(2, sharedCell("A2", 2) + sharedCell("B2", 3)) +
            row(3, sharedCell("A3", 99)), // 下标越界：给空串，不许把整份文件带崩
        ),
      },
    ],
    sharedStrings: [
      "<t>姓名</t>",
      "<t>金额</t>",
      "<r><t>北</t></r><r><t>京</t></r>",
      // rPh 是注音提示，也含 <t>，但不属于单元格文本
      "<r><t>重</t></r><rPh sb=\"0\" eb=\"1\"><t>zhong</t></rPh>",
    ],
  });

  assert.deepEqual(readWorkbook(buffer)[0].rows, [
    ["姓名", "金额"],
    ["北京", "重"],
    ["", ""],
  ]);
});

test("t=\"inlineStr\" 读 <is><t>，并与 t=\"str\" / t=\"b\" / t=\"e\" 共存", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "类型",
        xml: sheetPart(
          row(
            1,
            inlineCell("A1", "内联") + formulaCell("B1", "A1&\"!\"", "公式结果") + boolCell("C1", "1"),
          ) + row(2, inlineCell("A2", "换行\n也保留") + errorCell("B2", "#DIV/0!") + boolCell("C2", "0")),
        ),
      },
    ],
  });

  assert.deepEqual(readWorkbook(buffer)[0].rows, [
    ["内联", "公式结果", "TRUE"],
    ["换行\n也保留", "#DIV/0!", "FALSE"],
  ]);
});

test("数值单元格：小数、负数、科学计数法都按字面量透传（不丢精度）", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "数值",
        xml: sheetPart(
          row(
            1,
            numberCell("A1", "42") +
              numberCell("B1", "-1234.5") +
              numberCell("C1", "0.001") +
              numberCell("D1", "1.23E+20") +
              numberCell("E1", "3.14159265358979"),
          ),
        ),
      },
    ],
  });

  assert.deepEqual(readWorkbook(buffer)[0].rows, [["42", "-1234.5", "0.001", "1.23E+20", "3.14159265358979"]]);
});

test("单元格属性顺序不固定也能取到 t 与 r（s 在前、r 在后）", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "属性顺序",
        // 故意把 t 写在最前面，验证是「逐属性取」而不是按位置切
        xml: sheetPart(`<row r="1"><c t="inlineStr" r="B1"><is><t>落在B列</t></is></c></row>`),
      },
    ],
  });

  assert.deepEqual(readWorkbook(buffer)[0].rows, [["", "落在B列"]]);
});

/* ------------------------------------------------------------- 中文与实体 */

test("中文表头、中文内容、以及 &#35270; 这类数字实体都不乱码", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "客户&订单视",
        // 手写实体形式的工作表名：Excel 自己就爱把 & 写成 &amp;、把中文写成 &#数字;
        rawName: "客户&amp;订单&#35270;",
        xml: sheetPart(
          row(1, rawInlineCell("A1", "&#35270;频号") + rawInlineCell("B1", "客户名称")) +
            row(
              2,
              rawInlineCell("A2", "A&amp;B &lt;测试&gt; &quot;引号&quot; &apos;单引号&apos;") + rawInlineCell("B2", "李&#22235;"),
            ),
        ),
      },
    ],
  });

  const [sheet] = readWorkbook(buffer);
  assert.equal(sheet.name, "客户&订单视"); // 工作表名里的实体同样要解
  assert.deepEqual(sheet.rows, [
    ["视频号", "客户名称"],
    ['A&B <测试> "引号" \'单引号\'', "李四"],
  ]);
});

test("实体解码发生在结构切分之后：转义出来的尖括号不会被当成真标签", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "转义",
        xml: sheetPart(row(1, inlineCell("A1", '<c r="Z9">不是标签</c>'))),
      },
    ],
  });

  assert.deepEqual(readWorkbook(buffer)[0].rows, [['<c r="Z9">不是标签</c>']]);
});

/* -------------------------------------------------------- 空行 / 跳号 / 缺格 */

test("空行、跳号行、缺格子的行都补齐成 \"\"，且每行等长", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "稀疏",
        xml: sheetPart(
          row(1, inlineCell("A1", "姓名") + inlineCell("C1", "备注")) + // B1 缺格
            `<row r="2" spans="1:3"/>` + // 自闭合空行
            row(4, inlineCell("A4", "张三")) + // 第 3 行整行跳号
            row(5, inlineCell("C5", "只有C列")) + // 前两列缺格
            "<row>" + inlineCell("A6", "没有行号") + "</row>", // 无 r：按顺序落到第 6 行
        ),
      },
    ],
  });

  const rows = assertRectangular(readWorkbook(buffer)[0].rows);
  assert.deepEqual(rows, [
    ["姓名", "", "备注"],
    ["", "", ""],
    ["", "", ""],
    ["张三", "", ""],
    ["", "", "只有C列"],
    ["没有行号", "", ""],
  ]);
});

test("最宽的一行决定列数：尾部空列也要补出来", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "宽度",
        xml: sheetPart(row(1, inlineCell("A1", "只有一列")) + row(2, inlineCell("D2", "第四列"))),
      },
    ],
  });

  const rows = assertRectangular(readWorkbook(buffer)[0].rows);
  assert.deepEqual(rows, [
    ["只有一列", "", "", ""],
    ["", "", "", "第四列"],
  ]);
});

test("空工作表返回 [].rows = []，不报错", () => {
  const buffer = buildXlsx({ sheets: [{ name: "空表", xml: sheetPart("") }] });
  assert.deepEqual(readWorkbook(buffer), [{ name: "空表", rows: [] }]);
});

/* -------------------------------------------------------- 多表与真实结构 */

test("多工作表：按名字、按下标都能取到", () => {
  const buffer = buildXlsx({
    sheets: [
      { name: "客户名单", xml: sheetPart(row(1, inlineCell("A1", "客户")) + row(2, inlineCell("A2", "甲公司"))) },
      { name: "回款计划", xml: sheetPart(row(1, inlineCell("A1", "月份") + inlineCell("B1", "金额")) + row(2, inlineCell("A2", "3月") + numberCell("B2", "500"))) },
    ],
    sharedStrings: null,
  });

  const workbook = readWorkbook(buffer);
  assert.deepEqual(workbook.map((sheet) => sheet.name), ["客户名单", "回款计划"]);
  assert.deepEqual(readSheetRows(buffer, "回款计划"), [
    ["月份", "金额"],
    ["3月", "500"],
  ]);
  assert.deepEqual(readSheetRows(buffer, 0), [["客户"], ["甲公司"]]);
  assert.deepEqual(readSheetRows(buffer, "1"), [["月份", "金额"], ["3月", "500"]]); // 数字字符串当下标
});

test("rels 属性顺序不固定（Excel 的 Id 在前 / openpyxl 的 Target 在前）都要按 Target 认表", () => {
  // 部件文件名与工作表顺序**故意错开**：只有真的读了 Target 才可能对得上。
  // 否则「关系表没解析出来、退回 xl/worksheets/sheetN.xml」这条兜底会把 bug 盖住 ——
  // 这个测试存在的意义就是让「按固定属性顺序切 rels」的实现立刻变红。
  for (const relationshipOrder of ["excel", "openpyxl"]) {
    const buffer = buildXlsx({
      relationshipOrder,
      sheets: [
        { name: "第一张", xml: sheetPart(row(1, inlineCell("A1", "甲"))), target: "worksheets/sheet2.xml" },
        { name: "第二张", xml: sheetPart(row(1, inlineCell("A1", "乙"))), target: "worksheets/sheet1.xml" },
      ],
    });

    assert.deepEqual(
      readWorkbook(buffer),
      [
        { name: "第一张", rows: [["乙"]] },
        { name: "第二张", rows: [["甲"]] },
      ],
      `${relationshipOrder} 风格的关系表应按 Target 定位到错开的部件`,
    );
  }
});

test("关系表缺项 / 指向不存在的部件时不整份报错：能退回规范路径就用，退不了给空表", () => {
  const buffer = buildXlsx({
    sheets: [
      { name: "关系断了", xml: sheetPart(row(1, inlineCell("A1", "靠规范路径找到"))), target: "worksheets/renamed.xml" },
    ],
  });
  // xl/worksheets/sheet1.xml 还在包里 → 按位置退回去读
  assert.deepEqual(readWorkbook(buffer)[0].rows, [["靠规范路径找到"]]);

  // 关系指向的部件和规范路径都不存在 → 这一张给空表
  const broken = buildZip([
    { name: "xl/workbook.xml", data: `${XML_HEAD}<workbook ${NS_MAIN} ${NS_REL}><sheets><sheet name="丢了" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML_HEAD}<Relationships><Relationship Id="rId1" Type="${REL_TYPE}" Target="worksheets/missing.xml"/></Relationships>` },
  ]);
  assert.deepEqual(readWorkbook(broken), [{ name: "丢了", rows: [] }]);
});

test("取不到工作表时抛中文错误并带 status=404", () => {
  const buffer = buildXlsx({ sheets: [{ name: "客户名单", xml: sheetPart(row(1, inlineCell("A1", "客户"))) }] });

  assert.throws(
    () => readSheetRows(buffer, "回款计划"),
    (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /找不到名为「回款计划」的工作表（现有：客户名单）/);
      return true;
    },
  );
  assert.throws(
    () => readSheetRows(buffer, 3),
    (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /没有第 4 个工作表（共 1 个）/);
      return true;
    },
  );
});

/* --------------------------------------------------------------- 非法输入 */

test("空 buffer、截断的 zip 头、随机字节都抛带 status 的中文错误（不崩）", () => {
  const cases = [
    { input: Buffer.alloc(0), pattern: /为空或无法读取/ },
    { input: Buffer.from([0x50, 0x4b, 0x03, 0x04]), pattern: /不是合法的 \.xlsx/ },
    { input: Buffer.from("这不是一个 zip，只是一段随便的文本。".repeat(3), "utf8"), pattern: /不是合法的 \.xlsx/ },
    { input: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 0xff)), pattern: /不是合法的 \.xlsx/ },
    { input: "D:\\导出\\客户.xlsx", pattern: /为空或无法读取/ }, // 传错类型（路径而不是字节）
  ];

  for (const { input, pattern } of cases) {
    assert.throws(
      () => readWorkbook(input),
      (error) => {
        assert.ok(error instanceof Error, "必须是 Error 实例");
        assert.equal(error.status, 400);
        assert.match(error.message, pattern);
        return true;
      },
      `输入 ${Buffer.isBuffer(input) ? `${input.length} 字节` : typeof input} 应抛中文错误`,
    );
    assert.throws(() => readSheetRows(input, 0), /[\u4e00-\u9fa5]/);
  }
});

test("合法 zip 但不是 xlsx → 提示缺少 xl/workbook.xml", () => {
  const notXlsx = buildZip([{ name: "hello.txt", data: "我是普通文本" }]);
  assert.throws(
    () => readWorkbook(notXlsx),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /缺少 xl\/workbook\.xml/);
      return true;
    },
  );
});

test("zip 里没有工作表 / 一个部件都没有时也是中文错误", () => {
  const noSheet = buildZip([
    { name: "xl/workbook.xml", data: `${XML_HEAD}<workbook ${NS_MAIN} ${NS_REL}><sheets/></workbook>` },
  ]);
  assert.throws(() => readWorkbook(noSheet), /没有任何工作表/);

  assert.throws(
    () => readWorkbook(buildZip([])),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /没有任何内容/);
      return true;
    },
  );
});

test("工作表数据是坏 deflate 流 → 中文错误，而不是把 zlib 的原始报错抛出去", () => {
  const broken = buildZip([
    { name: "xl/workbook.xml", data: `${XML_HEAD}<workbook ${NS_MAIN} ${NS_REL}><sheets><sheet name="坏表" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML_HEAD}<Relationships><Relationship Id="rId1" Type="${REL_TYPE}" Target="worksheets/sheet1.xml"/></Relationships>` },
    // rawData：声明成 deflate，但字节根本不是 deflate 流
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from("这不是 deflate 流", "utf8"), method: 8, rawData: true },
  ]);

  assert.throws(
    () => readWorkbook(broken),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /解压失败|不是有效的 \.xlsx/);
      assert.doesNotMatch(error.message, /invalid|zlib/i);
      return true;
    },
  );
});

/* ------------------------------------------------------------ 行 → 对象 */

test("rowsToObjects：首行当表头、表头去空白与换行、重复表头自动改名", () => {
  const records = rowsToObjects([
    ["", "  客户\n名称 ", "客户 名称", "金额（元）"],
    ["x", "甲公司", "乙公司", "100"],
    ["", "", "", ""], // 全空行（Excel 常见的幽灵行）丢掉
    ["y", "丙公司", "丁公司", "200"],
  ]);

  assert.deepEqual(records, [
    { 列1: "x", 客户名称: "甲公司", 客户名称_2: "乙公司", "金额（元）": "100" },
    { 列1: "y", 客户名称: "丙公司", 客户名称_2: "丁公司", "金额（元）": "200" },
  ]);
});

test("rowsToObjects：表头重名撞上原生 _2 时继续往后排；值不做 trim，空白原样保留", () => {
  const records = rowsToObjects([
    ["名称", "名称", "名称_2"],
    [" 甲 ", "乙", "丙"],
  ]);
  assert.deepEqual(records, [{ 名称: " 甲 ", 名称_2: "乙", 名称_2_2: "丙" }]);
});

test("rowsToObjects：空表头列给 列N 兜底名（不丢数据），无数据行返回 []", () => {
  assert.deepEqual(rowsToObjects([["名称", ""], ["甲", "备注里的数据"]]), [{ 名称: "甲", 列2: "备注里的数据" }]);
  assert.deepEqual(rowsToObjects([]), []);
  assert.deepEqual(rowsToObjects([["只有表头"]]), []);
  assert.deepEqual(rowsToObjects(null), []);
});

/* ------------------------------------------------------- 端到端：真表 → 对象 */

test("端到端：读表 → rowsToObjects，中文表头 + 跳号行也能对上字段", () => {
  const buffer = buildXlsx({
    sheets: [
      {
        name: "客户导入",
        xml: sheetPart(
          row(2, inlineCell("A2", "客户名称") + inlineCell("B2", "联系人")) + // 首行空着：表头在第 2 行
            row(4, inlineCell("A4", "甲公司") + inlineCell("B4", "李四")),
        ),
      },
    ],
  });

  const rows = assertRectangular(readSheetRows(buffer, "客户导入"));
  assert.deepEqual(rows, [
    ["", ""],
    ["客户名称", "联系人"],
    ["", ""],
    ["甲公司", "李四"],
  ]);
  // 表头前有空行时 rowsToObjects 会把它当表头 —— 这是**已知口径**：调用方负责从第一行
  // 有内容的行开始传。这里钉住行为，避免以后悄悄改掉。
  assert.deepEqual(rowsToObjects(rows.slice(1)), [{ 客户名称: "甲公司", 联系人: "李四" }]);
});
