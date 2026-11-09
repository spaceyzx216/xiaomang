import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import WordExtractor from 'word-extractor';

const MAX_DOCUMENT_CHARS = 12000;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  'txt',
  'md',
  'csv',
  'json',
  'doc',
  'docx',
  'pdf'
]);

function documentError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getDocumentExtension(filename = '') {
  return path.extname(String(filename)).slice(1).toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function limitDocumentText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    throw documentError('未能从文档中提取到可用文字，可能是空文档或扫描版 PDF');
  }

  return {
    text: normalized.slice(0, MAX_DOCUMENT_CHARS),
    characterCount: normalized.length,
    truncated: normalized.length > MAX_DOCUMENT_CHARS
  };
}

async function extractWordText(buffer, extension) {
  if (extension === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (normalizeText(result.value)) return result.value;
    } catch (error) {
      // 某些旧式或非标准 docx 可以由 word-extractor 继续尝试读取。
    }
  }

  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  return document.getBody();
}

async function extractDocumentText({ filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw documentError('上传的文档为空或无法读取');
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw documentError('文档不能超过 10 MB', 413);
  }

  const extension = getDocumentExtension(filename);
  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) {
    throw documentError('暂不支持该文档格式，请上传 TXT、Markdown、CSV、JSON、Word 或 PDF');
  }

  let extractedText;
  let pageCount;
  if (['txt', 'md', 'csv', 'json'].includes(extension)) {
    extractedText = buffer.toString('utf8').replace(/^\uFEFF/, '');
  } else if (extension === 'doc' || extension === 'docx') {
    extractedText = await extractWordText(buffer, extension);
  } else {
    try {
      const result = await pdfParse(buffer);
      extractedText = result.text;
      pageCount = result.numpages;
    } catch (error) {
      throw documentError('PDF 解析失败，请确认文件未损坏且未加密');
    }
  }

  return {
    extension,
    pageCount,
    ...limitDocumentText(extractedText)
  };
}

export {
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  getDocumentExtension,
  extractDocumentText
};
