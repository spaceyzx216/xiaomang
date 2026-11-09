export const buildReviewWorkbook = (rows, { styles = '', numericCells = {} } = {}) => {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const column = n => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const worksheet = `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => {
    const ref = `${column(j)}${i + 1}`;
    return numericCells[ref] !== undefined ? `<c r="${ref}" s="${numericCells[ref]}"><v>${esc(v)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = [
    ['xl/workbook.xml', '<workbook><sheets><sheet name="视频数据" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', worksheet], ...(styles ? [['xl/styles.xml', styles]] : []),
  ];
  const chunks = []; const central = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name); const bytes = Buffer.from(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(bytes.length, 20); cd.writeUInt32LE(bytes.length, 24); cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, bytes); central.push(cd, nameBytes); offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
};
