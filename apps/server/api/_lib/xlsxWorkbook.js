import zlib from "node:zlib";

/**
 * 零依赖的 .xlsx 读取器。
 *
 * .xlsx 本身就是一个普通 zip（中央目录 + 本地文件头 + deflate 流），要读的东西只有
 * sharedStrings 和几张 worksheet XML —— 用 `node:zlib` 的 inflateRawSync 就能解开，
 * 没必要为它装 jszip / exceljs / xlsx（本机 npm 装包要审批，先例见
 * apps/web/src/app/docx.ts：零依赖手写 zip + WordprocessingML）。
 *
 * 对外只给字符串矩阵：`[{ name, rows: [[...]] }]`。上层（客户导入 / 选题表导入）
 * 不用关心 sharedStrings、inlineStr、STORE、跳号行这些差异，拿到手就是补齐过的表格。
 *
 * 刻意不做的事：数值不做类型推断（一律原样透传，避免科学计数法与长小数丢精度），
 * 默认不解析样式。AI 表格识别入口可显式开启 preservePercentFormat，保留百分比样式的含义；
 * 日期序列仍由上层按实际字段解释。
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// 与 manager/documentText.js 的 documentError 同款：错误带 status，调用方可以直接
// res.status(error.status) 回给前端，不用在这里关心 HTTP。
const xlsxError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

/* ------------------------------------------------------------------ zip 层 */

/**
 * 从尾部往前找 EOCD（zip 结尾记录）。
 *
 * zip 注释里也可能出现 EOCD 签名，所以先用「注释长度正好顶到文件末尾」筛一遍；
 * 真有尾部垃圾（某些写入器会追加字节）时退回最后一个候选，宁可交给后面的步骤去
 * 报「不是有效的 xlsx」，也不要在这里误判成「不是 zip」。
 */
const findEocd = (buffer) => {
  if (buffer.length < 22) {
    throw xlsxError("不是合法的 .xlsx 文件（文件过小，缺少 zip 结尾），请确认文件未损坏或重新导出");
  }

  const start = buffer.length - 22;
  const min = Math.max(0, start - 0xffff); // 注释长度字段是 2 字节，最多 65535
  let fallback = -1;
  for (let i = start; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) !== SIG_EOCD) continue;
    if (i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) return i;
    if (fallback < 0) fallback = i;
  }
  if (fallback >= 0) return fallback;

  throw xlsxError("不是合法的 .xlsx 文件（找不到 zip 结尾），请确认文件未损坏，或用 Excel 另存为 .xlsx 再上传");
};

/**
 * 遍历中央目录，记下每个部件的压缩方式与数据起点；真正的解压留到按需读取时做。
 * 只读中央目录里的 compSize（本地头的大小字段在流式写入时可能是 0，中央目录才是权威）。
 */
const readZipEntries = (buffer) => {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64 的大小/偏移字段全是 0xFFFFFFFF，本读取器不跟进扩展记录：给一句能照做的话。
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw xlsxError("暂不支持 ZIP64 格式的 .xlsx，请用 Excel 另存为普通 .xlsx 后再上传");
  }
  // 先看条目数再看偏移：空 zip（只有 22 字节 EOCD）的偏移是 0，用越界判断会误报。
  if (count === 0) {
    throw xlsxError("不是合法的 .xlsx 文件（zip 里没有任何内容），请确认上传的是 Excel 文件");
  }
  if (cdOffset + 46 > buffer.length) {
    throw xlsxError("不是合法的 .xlsx 文件（zip 中央目录越界），请确认文件未损坏");
  }

  const entries = new Map();
  let off = cdOffset;
  for (let i = 0; i < count && off + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(off) !== SIG_CENTRAL) break;
    const flags = buffer.readUInt16LE(off + 8);
    const method = buffer.readUInt16LE(off + 10);
    const compSize = buffer.readUInt32LE(off + 20);
    const uncompSize = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOffset = buffer.readUInt32LE(off + 42);
    const name = buffer.toString("utf8", off + 46, off + 46 + nameLen);

    // bit0 = 加密。加密条目解出来是乱码，早点说清楚比后面报「解压失败」有用。
    if (flags & 0x1) {
      throw xlsxError(`Excel 内的 ${name} 已加密，请先取消密码保护后再上传`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw xlsxError("不是合法的 .xlsx 文件（zip 本地文件头损坏），请重新导出后再上传");
    }

    // 本地头的名称/扩展区长度可能与中央目录不同，必须以本地头为准算数据起点。
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    entries.set(name, {
      method,
      compSize,
      uncompSize,
      dataStart: localOffset + 30 + localNameLen + localExtraLen,
    });

    off += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.size === 0) {
    throw xlsxError("不是合法的 .xlsx 文件（zip 里没有任何内容），请确认上传的是 Excel 文件");
  }
  return entries;
};

const readEntryBuffer = (buffer, entry) => {
  const { method, compSize, uncompSize, dataStart } = entry;
  if (dataStart > buffer.length) {
    throw xlsxError("不是合法的 .xlsx 文件（zip 数据越界），请确认文件未损坏");
  }

  // 少数写入器用数据描述符，中央目录里的 compSize 会是 0，这时只能「从数据起点解到流结束」：
  // inflateRawSync 在 deflate 流结束处就停，尾部其它部件的字节不会影响结果。
  let end;
  if (compSize > 0) end = Math.min(buffer.length, dataStart + compSize);
  else if (method === 0 && uncompSize > 0) end = Math.min(buffer.length, dataStart + uncompSize);
  else end = buffer.length;

  const raw = buffer.subarray(dataStart, end);
  if (method === 0) return Buffer.from(raw); // STORE：原样拷贝，避免把整份文件钉在内存里
  if (method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      throw xlsxError("Excel 文件已损坏（工作表数据解压失败），请重新导出后再上传");
    }
  }
  throw xlsxError(`Excel 使用了不支持的压缩方式（method=${method}），请用 Excel 另存为 .xlsx 后再上传`);
};

// zip 里的部件名区分大小写，但现实中有写入器把 xl 写成 XL，这里宽容一点。
const findEntry = (entries, name) => {
  const exact = entries.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of entries) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
};

const readEntryText = (buffer, entries, name) => {
  const entry = findEntry(entries, name);
  if (!entry) return null;
  // 去 BOM：Excel 导出的 XML 偶尔带 BOM，留着会让第一个标签的匹配出问题。
  // 顺手掐掉 XML 注释，注释里出现 <sheet ...> 之类的字样不该被当成真元素。
  return readEntryBuffer(buffer, entry)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
};

/* ------------------------------------------------------------------ XML 层 */

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * 解 XML 实体：五个具名实体 + `&#123;` / `&#x1F;` 数字实体。
 * 只对**文本节点与属性值**调用 —— 先把结构切出来再解，否则 `&lt;c r="A1"&gt;`
 * 会被解成一截真标签，把后面的解析带偏。
 */
const decodeXmlEntities = (text) =>
  String(text ?? "").replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[body] ?? match;
  });

/**
 * 逐元素取属性 —— 这是本文件最容易踩的坑：
 * Excel 写 `<sheet name="表1" sheetId="1" r:id="rId1"/>`，openpyxl 的 rels 写
 * `<Relationship Target="..." Type="..." Id="rId1"/>`，**属性顺序没有任何保证**，
 * 用「固定列序」的正则去 match 会在另一种顺序下静默取错值（曾经踩过一次）。
 * 所以：先把标签整体拿出来，再逐个 `名="值"` 取，最后按属性名查（名字统一小写比较）。
 */
const parseAttrs = (tag) => {
  const attrs = new Map();
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(tag))) {
    const value = match[2] !== undefined ? match[2] : match[3];
    attrs.set(match[1].toLowerCase(), decodeXmlEntities(value));
  }
  return attrs;
};

/**
 * 按名字逐块切出元素：`<name ...>body</name>`，自闭合的当成空 body。
 *
 * 用 `\b` 卡名字边界，所以 `<sheets>` 不会被当成 `<sheet>`、`<rPr>` 不会被当成 `<r>`、
 * `<cols>` 不会被当成 `<c>`。xlsx 的属性值里不会出现裸的 `>`（都会转义成 `&gt;`），
 * 所以 `[^>]*` 取标签是安全的。
 */
const eachBlock = (xml, name, flags = "") => {
  const blocks = [];
  if (!xml) return blocks;
  const re = new RegExp(`<${name}\\b([^>]*?)(/?)>`, flags ? `${flags}g` : "g");
  let match;
  while ((match = re.exec(xml))) {
    const tag = match[0];
    if (match[2] === "/") {
      blocks.push({ tag, body: "" });
      continue;
    }
    const close = xml.indexOf(`</${name}`, re.lastIndex);
    if (close < 0) {
      blocks.push({ tag, body: "" });
      continue;
    }
    blocks.push({ tag, body: xml.slice(re.lastIndex, close) });
    re.lastIndex = close;
  }
  return blocks;
};

const firstBlock = (xml, name, flags = "") => eachBlock(xml, name, flags)[0] || null;

/**
 * 取 `<si>` / `<is>` 里的全部 `<t>` 拼起来。
 *
 * 富文本是一条 `<si>` 里挂多个 `<r><t>…</t></r>`；`<rPh>` 是注音提示，也含 `<t>`，
 * 但它不属于单元格文本，必须先整块删掉，否则中日文表格会多出重复的读音。
 */
const readRichText = (xml) => {
  const withoutPhonetic = String(xml ?? "").replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "");
  return eachBlock(withoutPhonetic, "t")
    .map((block) => decodeXmlEntities(block.body))
    .join("");
};

/* --------------------------------------------------------------- 表格结构层 */

/**
 * `A1` / `AB12` → 0 基列号；取不到（没写 r 属性、或格式怪）返回 -1 交给调用方按顺序推。
 */
const columnIndex = (ref) => {
  const letters = /^([A-Za-z]+)/.exec(String(ref ?? ""))?.[1];
  if (!letters) return -1;
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
};

const readCellValue = (attrs, body, sharedStrings, percentStyles) => {
  const type = attrs.get("t") || "n";

  // 内联字符串：值在 <is> 里，可能还是富文本。
  if (type === "inlineStr") {
    const inline = firstBlock(body, "is");
    return readRichText(inline ? inline.body : body);
  }

  const valueBlock = firstBlock(body, "v");
  const text = valueBlock ? decodeXmlEntities(valueBlock.body).trim() : "";

  switch (type) {
    case "s": {
      // 共享字符串下标越界说明文件本身有问题：给空串，别让一个坏格子炸掉整份导入。
      const item = sharedStrings[Number.parseInt(text, 10)];
      return typeof item === "string" ? item : "";
    }
    case "b":
      return text === "1" || text.toLowerCase() === "true" ? "TRUE" : "FALSE";
    // str = 公式的字符串结果，e = #DIV/0! 这类错误值，都当普通文本用。
    case "str":
    case "e":
      return text;
    default:
      if (percentStyles?.has(Number(attrs.get('s') || 0)) && text && Number.isFinite(Number(text))) {
        return `${Number((Number(text) * 100).toPrecision(15))}%`;
      }
      // 数值 / n：原样保留字面量，科学计数法（1E+20）与长小数不会被 Number() 抹掉。
      return text;
  }
};

/**
 * worksheet XML → 等长字符串矩阵。
 *
 * 行号看 `r`、列号看单元格的 `r`，中途跳过的行和格子一律补 `""`，最后按最宽的一行
 * 对齐 —— 上层（尤其 rowsToObjects）最怕的就是行长短不一导致的错位。
 */
const parseSheetRows = (xml, sharedStrings, percentStyles) => {
  const rows = [];
  for (const rowBlock of eachBlock(xml, "row")) {
    const declared = Number.parseInt(parseAttrs(rowBlock.tag).get("r") ?? "", 10);
    let index = Number.isFinite(declared) && declared > 0 ? declared - 1 : rows.length;
    // 行号重复（合并/复制产生的坏文件）：落到下一行，别覆盖已有数据。
    if (rows[index] !== undefined) index = rows.length;

    const cells = [];
    let cursor = 0;
    for (const cellBlock of eachBlock(rowBlock.body, "c")) {
      const cellAttrs = parseAttrs(cellBlock.tag);
      const at = columnIndex(cellAttrs.get("r"));
      const position = at >= 0 ? at : cursor;
      while (cells.length < position) cells.push("");
      cells[position] = readCellValue(cellAttrs, cellBlock.body, sharedStrings, percentStyles);
      cursor = position + 1;
    }
    rows[index] = cells;
  }

  let width = 0;
  for (const row of rows) if (row && row.length > width) width = row.length;
  return Array.from({ length: rows.length }, (_, i) => {
    const row = rows[i] || [];
    return Array.from({ length: width }, (_, j) => (typeof row[j] === "string" ? row[j] : ""));
  });
};

const parseSharedStrings = (xml) => {
  if (!xml) return [];
  return eachBlock(xml, "si").map((block) => readRichText(block.body));
};

/* --------------------------------------------------------------- 路径与清单 */

/**
 * 相对 `xl/` 解析关系里的 Target。
 * openpyxl 会写成 `/xl/worksheets/sheet1.xml`（前导斜杠 = 从包根算），Excel 写
 * `worksheets/sheet1.xml`（相对部件所在目录），两种都要能落到同一个部件名上。
 */
const resolveZipPath = (target, baseDir) => {
  const raw = String(target ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  const parts = (raw.startsWith("/") ? raw.slice(1) : `${baseDir}/${raw}`).split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
};

// r:id / id 都可能出现（不同写入器的前缀不同）；注意别把 sheetId 当关系 id。
const pickRelationshipId = (attrs) => {
  if (attrs.has("r:id")) return attrs.get("r:id");
  for (const [key, value] of attrs) {
    if (key.includes(":")) {
      if (key.slice(key.lastIndexOf(":") + 1) === "id") return value;
    } else if (key === "id") return value;
  }
  return "";
};

const parseSheetList = (buffer, entries) => {
  const workbookXml = readEntryText(buffer, entries, "xl/workbook.xml");
  if (!workbookXml) {
    throw xlsxError("不是有效的 .xlsx 文件（缺少 xl/workbook.xml），请确认上传的是 Excel 工作簿");
  }

  const targetById = new Map();
  const relsXml = readEntryText(buffer, entries, "xl/_rels/workbook.xml.rels");
  // rels 的元素名首字母大小写并不统一，用 i 标志匹配。
  for (const block of eachBlock(relsXml, "Relationship", "i")) {
    const attrs = parseAttrs(block.tag);
    const id = attrs.get("id");
    if (id) targetById.set(id, attrs.get("target") || "");
  }

  const sheets = [];
  for (const block of eachBlock(workbookXml, "sheet")) {
    const attrs = parseAttrs(block.tag);
    const name = attrs.get("name") || `工作表${sheets.length + 1}`;
    const path = resolveZipPath(targetById.get(pickRelationshipId(attrs)) || "", "xl");
    // 关系表缺项时退回规范位置，别为一个可推导的路径把整份文件判死。
    const fallback = `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({
      name,
      path: path && findEntry(entries, path) ? path : fallback,
    });
  }

  if (sheets.length === 0) {
    throw xlsxError("Excel 里没有任何工作表，请确认文件内容后再上传");
  }
  return sheets;
};

/* ------------------------------------------------------------------ 对外 API */

const ensureBuffer = (buffer) => {
  if (Buffer.isBuffer(buffer)) {
    if (buffer.length === 0) throw xlsxError("上传的 Excel 为空或无法读取，请重新选择文件");
    return buffer;
  }
  if (buffer instanceof Uint8Array) {
    if (buffer.byteLength === 0) throw xlsxError("上传的 Excel 为空或无法读取，请重新选择文件");
    return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  throw xlsxError("上传的 Excel 为空或无法读取，请重新选择文件");
};

/**
 * 读整份工作簿。
 *
 * @param {Buffer} buffer .xlsx 文件内容
 * @returns {{ name: string, rows: string[][] }[]} 每个工作表一项，行已补齐成等长字符串
 */
export const readWorkbook = (buffer, { preservePercentFormat = false } = {}) => {
  const bytes = ensureBuffer(buffer);
  const entries = readZipEntries(bytes);
  const sheets = parseSheetList(bytes, entries);
  const sharedStrings = parseSharedStrings(readEntryText(bytes, entries, "xl/sharedStrings.xml"));
  const percentStyles = new Set();
  if (preservePercentFormat) {
    const styles = readEntryText(bytes, entries, 'xl/styles.xml');
    const formats = new Set([9, 10]);
    for (const block of eachBlock(styles, 'numFmt')) {
      const attrs = parseAttrs(block.tag);
      const code = String(attrs.get('formatcode') || '').replace(/"[^"]*"/g, '');
      if (/(^|[^\\])%/.test(code)) formats.add(Number(attrs.get('numfmtid')));
    }
    const cellXfs = firstBlock(styles, 'cellXfs');
    if (cellXfs) [...eachBlock(cellXfs.body, 'xf')].forEach((block, index) => {
      if (formats.has(Number(parseAttrs(block.tag).get('numfmtid')))) percentStyles.add(index);
    });
  }

  return sheets.map((sheet) => {
    const xml = readEntryText(bytes, entries, sheet.path);
    // 关系表指向了不存在的部件：这一张给空表，不因为一个坏部件丢掉整份文件。
    return { name: sheet.name, rows: xml ? parseSheetRows(xml, sharedStrings, percentStyles) : [] };
  });
};

/**
 * 取单个工作表：`readSheetRows(buffer, "客户名单")` 或 `readSheetRows(buffer, 0)`。
 *
 * @returns {string[][]} 该表的行（同样已补齐等长）
 */
export const readSheetRows = (buffer, sheetNameOrIndex) => {
  const sheets = readWorkbook(buffer);

  const asIndex =
    typeof sheetNameOrIndex === "number"
      ? sheetNameOrIndex
      : /^\d+$/.test(String(sheetNameOrIndex ?? "").trim())
        ? Number.parseInt(String(sheetNameOrIndex).trim(), 10)
        : -1;

  const sheet =
    asIndex >= 0 ? sheets[asIndex] : sheets.find((item) => item.name === String(sheetNameOrIndex ?? "").trim());

  if (!sheet) {
    if (asIndex >= 0) {
      throw xlsxError(`Excel 里没有第 ${asIndex + 1} 个工作表（共 ${sheets.length} 个）`, 404);
    }
    const names = sheets.map((item) => item.name).join("、");
    throw xlsxError(`Excel 里找不到名为「${sheetNameOrIndex}」的工作表（现有：${names}）`, 404);
  }
  return sheet.rows;
};

/**
 * 行 → 对象：首行当表头，表头去空白并去重，全空行丢掉。
 *
 * 表头为空（多半是「补齐」出来的尾列）时给一个 `列N` 的兜底名字 —— 直接跳过那一列
 * 会静默吃掉下面的数据，比给个丑名字危险得多。单元格的值原样保留（不去 trim），
 * 只对表头做归一化。
 */
export const rowsToObjects = (rows) => {
  const table = (Array.isArray(rows) ? rows : []).filter((row) => Array.isArray(row));
  if (table.length === 0) return [];

  let width = 0;
  for (const row of table) if (row.length > width) width = row.length;

  const headers = [];
  const used = new Set();
  for (let i = 0; i < width; i += 1) {
    // 表头去掉**所有**空白（不只是首尾）：Excel 表头经常被折成「客户\n名称」或「客户 名称」，
    // 而下游认的字段名是「客户名称」—— 只 trim 的话同一列会变成两个不同的键。
    const label = String(table[0][i] ?? "").replace(/\s+/g, "");
    let key = label || `列${i + 1}`;
    let suffix = 2;
    while (used.has(key)) {
      key = `${label || `列${i + 1}`}_${suffix}`;
      suffix += 1;
    }
    used.add(key);
    headers.push(key);
  }

  const records = [];
  for (const row of table.slice(1)) {
    // Excel 常在数据后面留一堆「看着是空、其实有空串」的幽灵行，全空的直接不要。
    if (row.every((cell) => String(cell ?? "").trim() === "")) continue;
    const record = {};
    for (let i = 0; i < width; i += 1) {
      record[headers[i]] = typeof row[i] === "string" ? row[i] : (row[i] ?? "");
    }
    records.push(record);
  }
  return records;
};
