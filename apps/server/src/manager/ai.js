import express from 'express';
import https from 'node:https';
import multer from 'multer';
import { findTask, findTasks, shanghaiDay } from '../../api/_lib/manager/tasks.js';
import { getDb, objectId } from '../../api/_lib/manager/db.js';
import { normalizeIpProfileInput } from '../../api/_lib/manager/ipProfile.js';
import { extractDocumentText, MAX_DOCUMENT_BYTES } from '../../api/_lib/manager/documentText.js';

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES }
});

function isAiConfigured() {
  return Boolean(process.env.COZE_BOT_ID && process.env.COZE_ACCESS_TOKEN);
}

function isDeepSeekConfigured() {
  return Boolean((process.env.MANAGER_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY));
}

async function callCozeAI(prompt) {
  const cozeBotId = process.env.COZE_BOT_ID;
  const cozeAccessToken = process.env.COZE_ACCESS_TOKEN;

  if (!cozeBotId || !cozeAccessToken) {
    throw new Error('Missing COZE_BOT_ID or COZE_ACCESS_TOKEN environment variable');
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      bot_id: cozeBotId,
      user_id: `user_${Date.now()}`,
      additional_messages: [{
        role: 'user',
        content: prompt,
        content_type: 'text'
      }],
      stream: false,
      auto_save_history: true
    });

    const options = {
      hostname: 'api.coze.cn',
      path: '/v3/chat',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cozeAccessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0 && result.data) {
            resolve(result.data);
          } else {
            reject(new Error(result.msg || 'API调用失败'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callDeepSeekAI(prompt) {
  const apiKey = (process.env.MANAGER_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY environment variable');
  }

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const endpoint = new URL(`${baseUrl}/chat/completions`);
  const model = (process.env.MANAGER_DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL) || 'deepseek-flash';
  const payload = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: '你是严谨的客户 IP 信息采集助手。只根据用户提供的沟通纪要提取事实，不猜测、不补全、不遗漏字段。必须返回合法 JSON。'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
    max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 4096),
    response_format: { type: 'json_object' },
    stream: false
  });
  const timeoutMs = Math.max(1000, Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000));

  return new Promise((resolve, reject) => {
    const request = https.request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        let result;
        try {
          result = JSON.parse(data);
        } catch (error) {
          const parseError = new Error('DeepSeek 返回内容不是有效 JSON');
          parseError.status = 502;
          reject(parseError);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const apiError = result?.error?.message || result?.message || `DeepSeek API 请求失败（HTTP ${response.statusCode}）`;
          const requestError = new Error(apiError);
          requestError.status = 502;
          reject(requestError);
          return;
        }

        const content = result?.choices?.[0]?.message?.content;
        if (!content) {
          const emptyError = new Error('DeepSeek 未返回可解析的整理结果');
          emptyError.status = 502;
          reject(emptyError);
          return;
        }
        resolve(content);
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('DeepSeek API 请求超时，请稍后重试'));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function buildTaskSummary(task) {
  const period = `${task?.collaborationPeriod?.start ? new Date(task.collaborationPeriod.start).toLocaleDateString('zh-CN') : '未设置'} - ${task?.collaborationPeriod?.end ? new Date(task.collaborationPeriod.end).toLocaleDateString('zh-CN') : '未设置'}`;
  return `客户：${task.customerName || '未知'}｜平台：${task.platformName || '未知'}｜周期：${period}｜内容需求：${task.contentDirection || '无'}｜对标账号：${task.benchmarkAccounts || '无'}｜备注：${task.notes || '无'}`;
}

function extractAiText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractAiText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';

  for (const key of ['content', 'output', 'text', 'answer', 'message']) {
    if (value[key]) {
      const text = extractAiText(value[key]);
      if (text) return text;
    }
  }
  return JSON.stringify(value);
}

function parseJsonObject(value) {
  const text = extractAiText(value)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (nestedError) {
      return null;
    }
  }
}

function buildIpProfilePrompt(rawNotes, supplementary) {
  return `你是客户 IP 信息采集助手。请根据下面的客户沟通纪要和补充说明，整理出结构化 IP 档案草稿。

只返回合法 JSON，不要 Markdown，不要解释。缺少的信息保持空字符串或空数组，不要猜测，不要把推断内容写成事实。
JSON 结构必须包含：
{
  "interview": { "rawNotes": "", "source": "client_interview" },
  "identity": {
    "name": "", "age": "", "mbti": "", "personaContrast": "",
    "occupation": "", "yearsExperience": "", "keyCases": ""
  },
  "product": {
    "businessModel": "", "productType": "", "priceRange": "", "coreAdvantages": ""
  },
  "userProfile": {
    "gender": "", "age": "", "occupationIndustry": "", "incomeLevel": "",
    "consumptionHabits": "", "consumptionScenarios": "", "painPoints": "", "goalsNeeds": ""
  }
}

字段含义对应以下清单：身份信息（姓名/昵称、年龄、MBTI、人设反差点、职业身份、从业年限、关键项目/代表案例）；
产品信息（业务模式、产品类型、产品价格/区间、核心优势）；用户画像（性别、年龄、职业/行业、收入水平、消费习惯、消费场景、痛点、目标/需求）。
只填写纪要中明确提到的内容；每个字段使用简洁的中文字符串，不要输出清单之外的字段。

沟通纪要：
${rawNotes}

补充说明：
${supplementary || '无'}`;
}

const router = express.Router();

router.post('/extract-document', (req, res) => {
  documentUpload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const isTooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(isTooLarge ? 413 : 400).json({
        error: isTooLarge ? '文档不能超过 10 MB' : '文档上传失败，请重新选择文件'
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: '请选择要解析的文档' });
      }

      const result = await extractDocumentText({
        filename: req.file.originalname,
        buffer: req.file.buffer
      });

      return res.json({
        fileName: req.file.originalname,
        text: result.text,
        characterCount: result.characterCount,
        truncated: result.truncated,
        pageCount: result.pageCount || null
      });
    } catch (error) {
      console.error('文档解析失败:', error.message);
      return res.status(error.status || 422).json({ error: error.message || '文档解析失败' });
    }
  });
});

router.post('/organize-ip-profile', async (req, res) => {
  try {
    if (!isDeepSeekConfigured()) {
      return res.status(503).json({ error: 'DeepSeek AI 未配置，请先填写 DEEPSEEK_API_KEY' });
    }

    const rawNotes = String(req.body.rawNotes || '').trim();
    const supplementary = String(req.body.supplementary || '').trim();
    if (!rawNotes) {
      return res.status(400).json({ error: '请先输入原始沟通纪要' });
    }
    if (rawNotes.length > 12000 || supplementary.length > 2000) {
      return res.status(400).json({ error: '输入内容超出长度限制' });
    }

    const result = await callDeepSeekAI(buildIpProfilePrompt(rawNotes, supplementary));
    const parsed = parseJsonObject(result);
    if (!parsed) {
      return res.status(502).json({ error: 'AI 返回内容无法解析，请保留原始纪要并手动整理' });
    }

    const profile = normalizeIpProfileInput(parsed.profile || parsed);
    profile.interview.rawNotes = rawNotes;
    profile.interview.source = 'client_interview';
    res.json({ profile, source: 'deepseek-flash' });
  } catch (err) {
    console.error('IP 档案整理失败:', err.message);
    res.status(err.status || 500).json({ error: `IP 档案整理失败: ${err.message}` });
  }
});

router.post('/analyze-task/:taskId', async (req, res) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({ error: 'AI 功能未启用' });
    }

    const task = await findTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const prompt = `请根据以下任务生成一条今日执行提醒（50~100字，简洁可执行）：\n${buildTaskSummary(task)}`;
    const result = await callCozeAI(prompt);

    task.aiAnalysis = result;
    await (await getDb()).collection('tasks').updateOne({ _id: objectId(task._id) }, { $set: { aiAnalysis: task.aiAnalysis } });

    res.json({ taskId: task._id, analysis: result });
  } catch (err) {
    console.error('AI分析失败:', err.message);
    res.status(500).json({ error: `AI分析失败: ${err.message}` });
  }
});

router.post('/analyze-today', async (req, res) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({ error: 'AI 功能未启用' });
    }

    const { start: today, end: tomorrow } = shanghaiDay();

    const tasks = await findTasks({
      'collaborationPeriod.start': { $lt: tomorrow },
      'collaborationPeriod.end': { $gte: today },
      status: { $ne: 'completed' }
    });

    if (tasks.length === 0) {
      return res.json({ message: '今日暂无任务', results: [] });
    }

    const tasksByEmployee = {};
    tasks.forEach((task) => {
      const ownerKey = task.ownerId?._id?.toString() || 'unknown';
      if (!tasksByEmployee[ownerKey]) {
        tasksByEmployee[ownerKey] = {
          employee: task.ownerId,
          tasks: []
        };
      }
      tasksByEmployee[ownerKey].tasks.push(task);
    });

    const results = [];

    for (const [empId, group] of Object.entries(tasksByEmployee)) {
      const taskList = group.tasks.map((t, i) => `${i + 1}. ${buildTaskSummary(t)}`).join('\n');
      const prompt = `请为员工 ${group.employee?.name || '未知'} 生成今日任务提醒（100~200字，先问候，再列执行重点，再鼓励）：\n${taskList}`;

      try {
        const analysis = await callCozeAI(prompt);
        results.push({
          employeeId: empId,
          employeeName: group.employee?.name,
          tasks: group.tasks.map((t) => t._id),
          analysis
        });
      } catch (e) {
        console.error(`员工 ${empId} 分析失败:`, e.message);
        results.push({
          employeeId: empId,
          employeeName: group.employee?.name,
          error: e.message
        });
      }
    }

    res.json({ date: today.toISOString(), results });
  } catch (err) {
    console.error('批量AI分析失败:', err.message);
    res.status(500).json({ error: `批量AI分析失败: ${err.message}` });
  }
});

router.get('/reminder/:employeeId', async (req, res) => {
  try {
    const { start: today, end: tomorrow } = shanghaiDay();

    const tasks = await findTasks({
      ownerId: objectId(req.params.employeeId),
      'collaborationPeriod.start': { $lt: tomorrow },
      'collaborationPeriod.end': { $gte: today },
      status: { $ne: 'completed' }
    }, { priority: -1, 'collaborationPeriod.end': 1 });

    if (tasks.length === 0) {
      return res.json({
        message: '今日暂无任务',
        tasks: [],
        reminder: '今日暂无待办任务，享受轻松的一天吧！'
      });
    }

    const analyzedTasks = tasks.filter((t) => t.aiAnalysis);
    if (analyzedTasks.length > 0) {
      return res.json({ tasks, reminder: analyzedTasks[0].aiAnalysis });
    }

    const taskSummary = tasks
      .map((t, i) => `${i + 1}. ${t.customerName}（${t.platformName || '未设平台'}）｜需求：${t.contentDirection || '无'}｜对标：${t.benchmarkAccounts || '无'}｜备注：${t.notes || '无'}`)
      .join('；');

    res.json({
      tasks,
      reminder: `今日你有 ${tasks.length} 个任务：${taskSummary}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
