import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRecognizedRows, getReviewInputOptions, recognizeReviewWorkbook } from '../api/_lib/reviewWorkbookRecognition.js';
import { readWorkbook } from '../api/_lib/xlsxWorkbook.js';
import { buildReviewWorkbook } from './helpers/review-workbook-fixture.mjs';
import { createReviewRow, rowsFromReviewMapping, suggestReviewInputMapping, validateReviewFormRows } from '../../web/src/app/reviewInputRows.ts';
const matrix = [['导出说明'], ['作品名称', '发布日期', '观看次数', '点赞量', '完播率(%)'], ['真实标题', '2026-10-01', '12500', '0', '0.8'], ['合计', '', '12500', '', '']];
const layout = { orientation: 'rows', headerIndex: 2, dataStart: 3, dataEnd: null, fields: [{ key: 'title', index: 1 }, { key: 'publishedAt', index: 2 }, { key: 'plays', index: 3 }, { key: 'likes', index: 4 }, { key: 'completionRate', index: 5, unit: 'percent' }] };
const extract = (patch = {}) => extractRecognizedRows({ rows: matrix, layout, platform: 'douyin', ...patch });
test('AI 只映射单元格位置，忽略它返回的虚构数值，跳过汇总且保留真实零值', () => {
  const result = extract({ layout: { ...layout, values: { plays: 999999 }, fields: layout.fields.map(f => ({ ...f, value: '伪造' })) } });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].metrics.plays, '12500'); assert.equal(result.rows[0].metrics.likes, '0');
  assert.equal(result.rows[0].metrics.comments, ''); assert.equal(result.rows[0].metrics.completionRate, '0.8%');
  assert.equal(result.rows[0].sourceIndex, 3); assert.match(result.warnings.join(), /跳过/);
  const serial = extract({ rows: [matrix[0], matrix[1], ['真实标题', '46296', '12500', '0', '0.8']] });
  assert.equal(serial.rows[0].publishedAt, '2026-10-01', 'Excel 日期序列按中国日历转换');
});
test('竖排字段、横排视频同样能从原表读取，不能交换视频数值', () => {
  const result = extract({ rows: [['字段', '视频A', '视频B'], ['发布时间', '2026-10-01', '2026-10-02'], ['播放量', '800', '12000'], ['文案', '真实开场A', '真实开场B']], layout: { orientation: 'columns', headerIndex: 1, dataStart: 2, fields: [{ key: 'publishedAt', index: 2 }, { key: 'plays', index: 3 }, { key: 'script', index: 4 }] } });
  assert.deepEqual(result.rows.map(r => r.metrics.plays), ['800', '12000']); assert.equal(result.rows[1].script, '真实开场B');
});
test('没有原表单位证据不能让 AI 自行乘万或改变百分比', () => {
  const result = extract({ layout: { ...layout, fields: [{ key: 'plays', index: 3, unit: 'wan' }, { key: 'likes', index: 4, unit: 'percent' }] } });
  assert.equal(result.rows[0].metrics.plays, '12500'); assert.match(result.warnings.join(), /单位未/);
  const wan = extract({ rows: [['播放量（万）'], ['1.2']], layout: { orientation: 'rows', headerIndex: 1, dataStart: 2, fields: [{ key: 'plays', index: 1, unit: 'wan' }] }, mode: 'single' });
  assert.equal(wan.rows[0].metrics.plays, '1.2万');
});
test('拒绝越界、重复字段、重复位置、未知指标和表头误当数据', () => {
  for (const fields of [[{ key: 'plays', index: 99 }], [{ key: 'plays', index: 3 }, { key: 'likes', index: 3 }], [{ key: 'plays', index: 3 }, { key: 'plays', index: 4 }], [{ key: 'not_real', index: 1 }]]) assert.throws(() => extract({ layout: { ...layout, fields } }), /映射/);
  assert.throws(() => extract({ layout: { ...layout, dataStart: 2 } }), /起始/);
  assert.throws(() => extract({ layout: { ...layout, excludeIndices: [99] } }), /排除/);
  assert.throws(() => extract({ platform: 'wechat_channels', layout: { ...layout, fields: [{ key: 'bounce2sRate', index: 3 }] } }), /映射/);
});
test('缺日期与缺指标明确提示，截断范围明确提示，超过120不静默截断', () => {
  const result = extract({ layout: { ...layout, dataEnd: 3, fields: [{ key: 'title', index: 1 }] } });
  assert.deepEqual(result.missingFields, ['plays', 'publishedAt']); assert.match(result.warnings.join(), /共 4 行/);
  assert.throws(() => extract({ rows: [['播放量'], ...Array.from({ length: 121 }, () => ['1'])], layout: { orientation: 'rows', headerIndex: 1, dataStart: 2, fields: [{ key: 'plays', index: 1 }] } }), /最多 120/);
});
test('真实 xlsx + AI 布局推断贯通，失效模型明确报错并允许人工路径', async () => {
  const body = { fileName: '测试.xlsx', dataBase64: buildReviewWorkbook(matrix).toString('base64'), platform: 'douyin', mode: 'weekly', sheetName: '视频数据' };
  const result = await recognizeReviewWorkbook({ body, agent: async request => { assert.equal(JSON.parse(request.user).totalRows, 4); return layout; } });
  assert.equal(result.rows[0].title, '真实标题');
  await assert.rejects(() => recognizeReviewWorkbook({ body, agent: async () => { throw new Error('offline'); } }), error => error.status === 503 && /手动|直接填写/.test(error.message));
  await assert.rejects(() => recognizeReviewWorkbook({ body: { ...body, sheetName: '不存在' }, agent: async () => layout }), /不存在/);
});
test('百分比单元格格式只在新识别入口启用，默认读取与既有解析保持一致', async () => {
  const styles = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>';
  const rows = [['播放量', '完播率(%)', '5s 完播率(%)'], ['12000', '0.32', '0.008']];
  const buffer = buildReviewWorkbook(rows, { styles, numericCells: { B2: 1, C2: 2 } });
  assert.deepEqual(readWorkbook(buffer)[0].rows[1], ['12000', '0.32', '0.008']);
  assert.deepEqual(readWorkbook(buffer, { preservePercentFormat: true })[0].rows[1], ['12000', '32%', '0.8%']);
  const result = await recognizeReviewWorkbook({ body: { fileName: '样式.xlsx', dataBase64: buffer.toString('base64'), platform: 'douyin', mode: 'single' }, agent: async () => ({ orientation: 'rows', headerIndex: 1, dataStart: 2, fields: [{ key: 'plays', index: 1 }, { key: 'completionRate', index: 2, unit: 'percent' }, { key: 'completion5sRate', index: 3, unit: 'percent' }] }) });
  assert.equal(result.rows[0].metrics.completionRate, '32%');
});
test('表单与普通列映射同一输入形状，无 Excel 也能填零值、标签和日期', () => {
  const options = getReviewInputOptions('douyin');
  const headers = ['标题', '发布日期', '播放量', '三秒类型'];
  const mapping = suggestReviewInputMapping(headers, { 播放量: 'plays' }, options);
  const rows = rowsFromReviewMapping([{ 标题: '示例', 发布日期: '2026-10-01', 播放量: '0', 三秒类型: '恐惧' }], mapping);
  assert.equal(rows[0].structureTags.goldThreeSecondsType, '恐惧'); validateReviewFormRows(rows, 'weekly');
  const manual = createReviewRow('manual'); assert.throws(() => validateReviewFormRows([manual], 'single'), /播放量/);
  manual.metrics.plays = '0'; validateReviewFormRows([manual], 'single');
  assert.throws(() => validateReviewFormRows([manual], 'weekly'), /发布时间/);
  assert.throws(() => validateReviewFormRows([...rows, ...rows], 'weekly'), /重复/);
  assert.ok(!getReviewInputOptions('wechat_channels').metricOptions.some(m => m.key === 'bounce2sRate'));
});
