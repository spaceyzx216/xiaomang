import { apiUrl, fetchWithRetry, parseApiJson } from './api';
import type { ReviewMetricOption, ReviewPlatform } from './reviewApi';
import type { WeeklyOptions, WeeklyRow } from './weeklyReviewApi';
export type ReviewInputOptions = { metricOptions: ReviewMetricOption[]; structures: WeeklyOptions['structures']; videoFields: Array<{ key: string; label: string; aliases: string[] }>; maxRows: number };
export type RecognizedWorkbook = { fileName: string; sheetName: string; rows: Array<WeeklyRow & { sourceIndex: number }>; fields: Array<{ key: string; label: string; sourceLabel: string; index: number; unit: string }>; warnings: string[]; missingFields: string[]; orientation: 'rows' | 'columns' };
const request = async (path: string, body?: unknown) => {
  const response = await fetchWithRetry(apiUrl(path), { retries: 0, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await parseApiJson(response);
  if (!response.ok || data.success === false) throw new Error(String(data.error || '表格识别请求失败'));
  return data;
};
export const getReviewInputOptions = async (platform: ReviewPlatform): Promise<ReviewInputOptions> => await request(`/api/review/workbook-recognition?platform=${platform}`) as ReviewInputOptions;
export const recognizeReviewWorkbook = async (file: File, platform: ReviewPlatform, mode: 'single' | 'weekly', sheetName: string): Promise<RecognizedWorkbook> => {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('读取 Excel 失败，请重新选择')); reader.readAsDataURL(file);
  });
  return await request('/api/review/workbook-recognition', { fileName: file.name, dataBase64, platform, mode, sheetName }) as RecognizedWorkbook;
};
