/**
 * 零依赖的 .docx 生成器。
 *
 * ── 为什么手写而不是装库 ──────────────────────────────────────────────────────
 * 项目里没有 jszip / docx / file-saver，而 HANDOFF §6.5㉖ 明确记着本机 npm 装包
 * 出过问题。但 .docx 本质就是一个 zip 里装几个 XML，而 zip 条目用 **STORE（不压缩）**
 * 时只需要 CRC32 + 字节拼装 —— 纯 JS 就能写，不需要 deflate（浏览器也没有 zlib）。
 *
 * 刻意**不**走「HTML 改名成 .doc」那条捷径：那个方案 Word 会弹「文件格式与扩展名
 * 不匹配」的警告，对非技术用户来说很像中毒；而且拿到的不是真正的 Word 文档，
 * 样式、标题级别、表格都不是 Word 原生的。
 *
 * 产出结构（最小可用 .docx）：
 *   [Content_Types].xml
 *   _rels/.rels
 *   word/document.xml
 *   word/styles.xml
 */

const encoder = new TextEncoder();

// ── CRC32（zip 每条目都要）─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * 打包成 zip。**全部用 STORE（method 0）**，不压缩。
 *
 * 代价是文件比压缩后大（XML 冗长），但一份报告量级完全无所谓，
 * 换来的是浏览器里也能生成、且不依赖任何库。
 */
const zipStore = files => {
  const chunks = [];
  const central = [];
  let offset = 0;

  // zip 的时间戳用 DOS 格式。写死成一个固定值即可 —— 内容才是要关心的。
  const dosTime = 0;
  const dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const crc = crc32(dataBytes);

    // 本地文件头
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 签名
    lv.setUint16(4, 20, true); // 需要的版本
    // 0x0800 = 文件名按 UTF-8 编码（中文文件名必需，否则 Word 里是乱码）
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); // method 0 = STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra 长度
    local.set(nameBytes, 30);

    chunks.push(local, dataBytes);

    // 中央目录项
    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true); // 制作版本
    ev.setUint16(6, 20, true); // 需要版本
    ev.setUint16(8, 0x0800, true);
    ev.setUint16(10, 0, true); // STORE
    ev.setUint16(12, dosTime, true);
    ev.setUint16(14, dosDate, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, dataBytes.length, true);
    ev.setUint32(24, dataBytes.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint16(30, 0, true); // extra
    ev.setUint16(32, 0, true); // comment
    ev.setUint16(34, 0, true); // 起始磁盘
    ev.setUint16(36, 0, true); // 内部属性
    ev.setUint32(38, 0, true); // 外部属性
    ev.setUint32(42, offset, true); // 本地头偏移
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length + dataBytes.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
};

// ── WordprocessingML ──────────────────────────────────────────────────────
const escapeXml = value => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  // Word 里换行必须用 <w:br/>，直接塞 \n 会被吞掉。这里先用占位符，后面替换。
  .replace(/\r?\n/g, "\u0000BR\u0000");

const textRun = value => {
  const text = escapeXml(value);
  const parts = text.split("\u0000BR\u0000");
  const runs = parts.map((part, index) => (
    `${index > 0 ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${part}</w:t></w:r>`
  )).join("");
  return runs || "<w:r><w:t xml:space=\"preserve\"></w:t></w:r>";
};

const paragraph = (text, style) => (
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${textRun(text)}</w:p>`
);

const bullet = text => (
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${textRun(text)}</w:p>`
);

/** 表格。第一行按表头加粗加底纹。 */
const table = (headers, rows) => {
  const cell = (value, header) => (
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>' : ""}</w:tcPr>`
    + `<w:p>${header ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>` : textRun(value)}</w:p></w:tc>`
  );
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map(h => cell(h, true)).join("")}</w:tr>`;
  const body = rows.map(row => `<w:tr>${row.map(value => cell(value, false)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${head}${body}</w:tbl>`;
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/>
    <w:sz w:val="21"/><w:szCs w:val="21"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420"/></w:pPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/>
  </w:tblBorders></w:tblPr></w:style>
</w:styles>`;

/**
 * 把「块」渲染成 docx。
 *
 * 块类型刻意做得很窄 —— 只覆盖报告真正需要的几种，避免在这里造一套排版 DSL。
 *   { type: "title" | "heading" | "text" | "bullet" | "table", ... }
 */
export const buildDocxBlob = blocks => {
  const body = (Array.isArray(blocks) ? blocks : []).map(block => {
    switch (block?.type) {
      case "title": return paragraph(block.text, "Title");
      case "heading": {
        const level = Math.min(3, Math.max(1, Number(block.level) || 1));
        return paragraph(block.text, `Heading${level}`);
      }
      case "bullet": return bullet(block.text);
      case "table": return table(block.headers || [], block.rows || []);
      case "spacer": return paragraph("", undefined);
      case "text":
      default: return paragraph(block?.text ?? "", undefined);
    }
  }).join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: STYLES_XML },
  ]);
};

/** 触发浏览器下载。 */
export const downloadDocx = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName.endsWith(".docx") ? fileName : `${fileName}.docx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 在部分浏览器上会让下载拿不到数据，延后释放。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** 文件名里不能出现的字符（Word/各系统都会出问题）。 */
export const safeDocxFileName = value => String(value || "")
  .replace(/[\\/:*?"<>|\r\n\t]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 80) || "报告";
