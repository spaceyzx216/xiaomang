import { appendQuery, fetchJson } from "./contentAgent/http.js";

/**
 * 抖音「热榜」粉丝画像 —— 模块 1 用户画像的**真实数据源**。
 *
 * ── 为什么是这一个接口（2026-09-18 实测结论，改之前先读）────────────────────────
 *
 * 用户规格要求用户画像「通过评论区和粉丝，结合平台用户画像进行分析」。曾经评估过
 * 星图接口（`get_author_fans_distribution`），数据更细（10 维），但**只对入驻星图的
 * 达人有效** —— 实测真实账号「胥子讲老板用工风险」返回 `exist=false`，
 * 而星图是抖音的商单平台，普通对标账号基本不会入驻。所以星图只能算增强，不能当主力。
 *
 * 热榜这条链路**只要求 sec_uid**，实测对上述同一个未入驻星图的账号完全可用：
 * 性别 78.3%/21.7%、年龄 41-50 占 38.5%、手机价格、城市等级、省份、兴趣标签全部有值。
 * 这才是主力数据源。
 *
 * ⚠️ **一次调用只能拿一个维度**（实测：不带 option 只回 option=1；传 "2,3" 或 "[2,3]"
 * 都是 HTTP 422）。响应体固定是 `{ user_id, option, portrait, portrait_tgi }`，
 * `option` 是单值。所以 8 个维度要 8 次 GET —— 并发跑，约 1~2 秒。
 *
 * ⚠️ 返回的 `value` 是 **0~1 的比例**，不是百分数（星图那边给的是绝对条数）。
 * 展示前必须乘 100，否则界面上会出现「男性 0.78%」这种错得很难看的数字。
 */

/** 8 个维度。`specField` 标明它供给用户画像的哪一项。 */
export const PORTRAIT_DIMENSIONS = [
  { option: 2, key: "gender", label: "性别分布", specField: "gender", specLabel: "性别" },
  { option: 3, key: "age", label: "年龄分布", specField: "age", specLabel: "年龄" },
  { option: 1, key: "mobilePrice", label: "手机价格分布", specField: "income", specLabel: "收入水平" },
  { option: 6, key: "cityLevel", label: "城市等级分布", specField: "region", specLabel: "地域" },
  { option: 7, key: "mobileBrand", label: "手机品牌分布", specField: "consumption", specLabel: "消费习惯" },
  { option: 8, key: "interest", label: "兴趣标签分析", specField: "interest", specLabel: "兴趣" },
  { option: 4, key: "province", label: "地域分布（省份）", specField: "region", specLabel: "地域" },
  { option: 5, key: "city", label: "地域分布（城市）", specField: "region", specLabel: "地域" },
];

/** 用户画像里**能由真实画像数据支撑**的字段。职业/行业没有直接数据源，不在其中。 */
export const PORTRAIT_BACKED_DEMOGRAPHICS = ["gender", "age", "income", "consumption"];

export const PORTRAIT_PATH = "/api/v1/douyin/billboard/fetch_hot_account_fans_portrait_list";

const asText = value => String(value ?? "").trim();

/**
 * 上游返回的分类名有几处直接展示会很难读，统一在这里转成中文/人话。
 * 只做**展示层**转换：`portrait.key`（上游给的占比最高项）比对时仍用原始名。
 */
const VALUE_LABELS = {
  gender: { male: "男性", female: "女性" },
  age: { "50-": "50 岁以上", "18-23": "18-23 岁", "24-30": "24-30 岁", "31-40": "31-40 岁", "41-50": "41-50 岁" },
  cityLevel: { 新一线: "新一线城市", 二线: "二线城市", 三线: "三线城市", 四线: "四线城市", 五线: "五线城市" },
};

const displayName = (key, name) => VALUE_LABELS[key]?.[name] || name;

const asRatio = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  // 已实测上游给 0~1；但万一某天改成百分数（>1），这里不能把它放大 100 倍。
  return number > 1 ? Math.round(number * 10) / 10 : Math.round(number * 1000) / 10;
};

/**
 * 找出真正装着画像的那个对象。
 *
 * ⚠️ 这里**刻意按「哪个对象真的有 portrait」来找，而不是写死层数**。
 * 上游把结果套了好几层（HTTP body → `data:{code,data}` → 真正的画像），
 * 而 `fetchJson` 又把它包成 `{ response, data, text }`，实测真实层数是
 * `result.data.data.data`。层数一旦写死，上游或 fetchJson 任一侧调整包装就会静默变空
 * —— 本文件第一次跑就是这么 8 个维度全空的。按内容找则对包装层免疫。
 */
const pickPortraitPayload = raw => {
  const candidates = [raw?.data?.data?.data, raw?.data?.data, raw?.data, raw];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && (candidate.portrait || candidate.portrait_data)) {
      return candidate;
    }
  }
  return null;
};

/**
 * 归一化一个维度的返回。
 *
 * 结构：`{ user_id, option, portrait: { portrait_data: [{name, value}], key }, portrait_tgi: {...} }`
 * 注意 `code: 0` 表示业务成功 —— 与 HTTP 200 是两件事。
 */
export const normalizePortraitDimension = (raw, dimension) => {
  const payload = pickPortraitPayload(raw);
  const portraitData = payload?.portrait?.portrait_data ?? payload?.portrait_data ?? [];
  if (!Array.isArray(portraitData)) return null;

  const items = portraitData
    .map(item => ({ name: displayName(dimension.key, asText(item?.name)), percentage: asRatio(item?.value) }))
    .filter(item => item.name)
    .sort((left, right) => right.percentage - left.percentage);
  if (items.length === 0) return null;

  // `portrait.key` 是上游给的「占比最高那一项」，比自己猜更可靠；缺失时用排序首项。
  const dominantRaw = asText(payload?.portrait?.key);
  const dominantName = dominantRaw ? displayName(dimension.key, dominantRaw) : items[0].name;
  const dominant = items.find(item => item.name === dominantName) || items[0];

  const tgiData = payload?.portrait_tgi?.portrait_data;
  const tgi = Array.isArray(tgiData)
    ? tgiData
      .map(item => ({ name: displayName(dimension.key, asText(item?.name)), index: Math.round(Number(item?.value) * 10) / 10 }))
      .filter(item => item.name)
    : [];

  return {
    option: dimension.option,
    key: dimension.key,
    label: dimension.label,
    specField: dimension.specField,
    specLabel: dimension.specLabel,
    items,
    dominant: { name: dominant.name, percentage: dominant.percentage },
    tgi,
  };
};

/** 一句话结论，用于报告里做 `basis` 引用（模型与人工都能直接读）。 */
export const describePortraitDimension = dimension => {
  if (!dimension) return "";
  const top = dimension.items.slice(0, 3).map(item => `${item.name}(${item.percentage}%)`).join("、");
  return `${dimension.label}：${top}`;
};

/**
 * 拉全部维度。**单个维度失败不影响其余** —— 画像少一维仍可用，不该整条失败。
 *
 * @param options 只取其中一部分维度（默认 8 个全取）
 */
export const fetchFansPortrait = async ({ secUserId, config, logger, options } = {}) => {
  const userId = asText(secUserId);
  if (!userId) return { ok: false, reason: "missing_sec_user_id", dimensions: [], failed: [] };

  // ⚠️ 凭证在**调用时**读，不从 api/_lib/common 里 import。
  // common 那份是 TypeScript（common.ts），本地 Express 是纯 ESM、不经 TS 编译，
  // 静态 import 它会让 `node server/index.js` 直接起不来。
  // 与 videoComments.js 同一处理方式。
  const token = asText(config?.tikhubApiToken) || asText(process.env.TIKHUB_API_TOKEN);
  const baseUrl = asText(config?.tikhubBaseUrl) || asText(process.env.TIKHUB_BASE_URL) || "https://api.tikhub.io";
  if (!token) return { ok: false, reason: "missing_token", dimensions: [], failed: [] };

  const wanted = Array.isArray(options) && options.length > 0
    ? PORTRAIT_DIMENSIONS.filter(item => options.includes(item.option))
    : PORTRAIT_DIMENSIONS;

  const dimensions = [];
  const failed = [];
  // 8 个 GET 彼此独立，串行会白白多花几秒；并发上限取 4，避免瞬时打满上游限流。
  const concurrency = Math.max(1, Math.min(4, wanted.length));
  let cursor = 0;

  const worker = async () => {
    while (cursor < wanted.length) {
      const dimension = wanted[cursor];
      cursor += 1;
      try {
        const response = await fetchJson(
          appendQuery(`${baseUrl}${PORTRAIT_PATH}`, { sec_uid: userId, option: dimension.option }),
          {
            timeoutMs: Math.max(5_000, Number(config?.requestTimeoutMs) || 20_000),
            retries: 1,
            retryBaseDelayMs: Number(config?.apiRetryBaseDelayMs) || 800,
            logger,
            interfaceName: `tikhub:douyin:billboard:fans_portrait:${dimension.option}`,
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const normalized = normalizePortraitDimension(response, dimension);
        if (normalized) dimensions.push(normalized);
        else failed.push({ option: dimension.option, label: dimension.label, error: "没有可用的分布数据" });
      } catch (error) {
        // 单个维度失败是常态（上游偶发空数据），记下来继续跑其余维度。
        failed.push({
          option: dimension.option,
          label: dimension.label,
          error: error instanceof Error ? error.message : "获取失败",
        });
        logger?.warn("fans_portrait.dimension_failed", {
          option: dimension.option,
          label: dimension.label,
          error: error instanceof Error ? error.message : "获取失败",
        });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  dimensions.sort((left, right) => left.option - right.option);
  return {
    ok: dimensions.length > 0,
    reason: dimensions.length > 0 ? "" : "no_dimensions",
    secUserId: userId,
    dimensions,
    failed,
    fetchedAt: new Date().toISOString(),
  };
};

/**
 * 把画像数据映射成用户画像的固定字段。
 *
 * **只对有真实分布的字段给出结论**：职业/行业没有对应维度，这里不产出，
 * 仍然由 Agent 推断或标「待人工补充」。返回的每一项都带 `basis`（可核对的分布原文），
 * 业务层据此把证据等级升为 `evidence`。
 */
export const buildDemographicsFromPortrait = portrait => {
  const dimensions = Array.isArray(portrait?.dimensions) ? portrait.dimensions : [];
  const byKey = new Map(dimensions.map(item => [item.key, item]));

  const result = {};
  const take = (demoKey, dimensionKeys, render) => {
    const used = dimensionKeys.map(key => byKey.get(key)).filter(Boolean);
    if (used.length === 0) return;
    result[demoKey] = {
      text: render(used),
      basis: used.map(describePortraitDimension).filter(Boolean),
    };
  };

  // 性别 / 年龄：一个维度即可给出结论。
  // ⚠️ 年龄的取值已经带了「岁」（如「41-50 岁」），这里不要再补一个「岁」。
  take("gender", ["gender"], ([d]) => `${d.dominant.name}居多，占比 ${d.dominant.percentage}%`);
  take("age", ["age"], ([d]) => `${d.dominant.name}居多，占比 ${d.dominant.percentage}%`);
  // 收入：手机价格是消费能力的常用代理，城市等级做补充。
  // 带上维度名再给结论 —— 只说「以 1000~1999 为主」，读者不知道这是手机价格还是收入。
  take(
    "income",
    ["mobilePrice", "cityLevel"],
    used => used.map(d => `${d.label}以 ${d.dominant.name} 为主（${d.dominant.percentage}%）`).join("；"),
  );
  // 消费习惯：手机品牌 + 价格带。
  take(
    "consumption",
    ["mobileBrand", "mobilePrice"],
    used => used.map(d => `${d.label}占比最高的是 ${d.dominant.name}（${d.dominant.percentage}%）`).join("；"),
  );

  return result;
};
