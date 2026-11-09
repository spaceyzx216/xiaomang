/**
 * 1.2「对标账号分析」与 1.3「账号定位」共用的**证据助手**。
 *
 * ── 为什么会有这个文件 ────────────────────────────────────────────────────────
 *
 * 下面这些助手（`asText` / `cleanText` / `ratio` / `stripForMatch` / `normalizeBasisField` /
 * `normalizePrice` / 证据标签表）本来就是**同一份代码被抄了两遍**：1.3 落地时 1.2 已经验收完、
 * 那一批不许改动 1.2，于是只能在 `accountPlan.js` 里整段复制一份，并在注释里写下
 * 「改动时两处必须同步」—— 而靠注释维持的同步不叫同步：复制过去的那一份已经悄悄漂移了
 * （1.3 的 `asNumber` 被加了 `Math.round`，1.2 靠它读 `33.3%` 这种真实小数，取整就会算错）。
 *
 * 更关键的是：**报告诚实性规则只能有一份实现**。同一个「引文能不能核对上」的判断，
 * 如果 1.2 与 1.3 各写一份，迟早会出现「同一句原话在 1.2 里是输入证据、在 1.3 里核对不上」
 * 的自相矛盾 —— 而这两份报告是并排给同一个项目经理审核的（HANDOFF §5 / §6.3⑭）。
 * 所以：**分级与取证的实现只放这里**，两个模块 import 使用，不再各留一份。
 *
 * ⚠️ 各模块的 `buildEvidenceHaystack`（证据全文索引）**刻意不抽到一起**：
 * 1.2 的取材是账号简介 / 视频文案 / 评论 / 分类，1.3 的取材是客户档案 / 访谈原文 /
 * 1.2 报告 / 分类透传 —— 输入域不同，硬合成一个函数只会变成到处判空的分支堆。
 * 真正共用的只有「若干段原文 → 拼接 → 去标点」这一小段（见 `joinEvidenceParts`）。
 */

/** 证据分级。前端直接渲染 levelLabel，不要在组件里再写一份中文。 */
export const PROFILE_EVIDENCE_LEVELS = {
  evidence: "输入证据",
  inference: "Agent 推断",
  manual: "待人工补充",
};

export const asText = value => String(value ?? "").trim();

/**
 * 读一个非负数字，读不出来（含负数、NaN）就是 0。
 *
 * ⚠️ **这里不取整**：1.2 的占比是真的小数（33.3%），一取整报告里的占比就和分类报告对不上了。
 * 只要整数条数的调用方用 `asCount`，别在这里悄悄改口径。
 */
export const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

/**
 * 计数专用：条数 / 步数一律取整。
 *
 * 这是 1.3 原本的 `asNumber` 口径（`asNumber` + `Math.round`）——它数的是选题条数、产品条数、
 * 变现步骤，取整是对的。抽公共层时**特意保留成两个函数**而不是二选一：
 * 合掉哪一个都会改变另一边的报告数字。
 */
export const asCount = value => Math.round(asNumber(value));

export const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

export const ratio = (count, total) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

// 比对时先去掉空白和标点：模型引用原文时标点几乎不可能和输入完全一致。
export const stripForMatch = value => asText(value).replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]…—-]/g, "");

/** haystack 的公共尾巴：若干段原文 → 拼接 → 去标点。**取材范围仍由各模块自己决定**（见文件头）。 */
export const joinEvidenceParts = parts => stripForMatch((Array.isArray(parts) ? parts : []).filter(Boolean).join(" "));

const LEVEL_ORDER = { manual: 0, inference: 1, evidence: 2 };

/**
 * 把模型给的一段叙述规范化成带证据分级的字段。
 *
 * **不采信模型自报的 level**：它说 evidence 就必须给出真能在输入里找到的引文，
 * 否则一律降级成 inference。识别不了的 level 也降级（宁可比模型自称的更保守）。
 *
 * `levelCap` 是调用方给的硬上限（1.2 里没有粉丝画像时的人口属性、1.3 里无法联网核实的蹭热点
 * 都靠它封顶），**默认不设上限** —— 只有在「这一项本质上无法在输入里核对」时才该传。
 */
export const normalizeBasisField = ({ raw, haystack, fallbackText = "", maxLength = 900, levelCap = "evidence" }) => {
  // 模型偶尔直接把整段话当字符串返回，而不是 { text, basis, level }。两种都认。
  const source = typeof raw === "string" ? { text: raw } : (raw && typeof raw === "object" ? raw : {});
  const text = cleanText(source.text || source.value || source.summary || fallbackText, maxLength);
  const basis = (Array.isArray(source.basis) ? source.basis : Array.isArray(source.evidence) ? source.evidence : [])
    .map(item => cleanText(item, 160))
    .filter(Boolean)
    .slice(0, 5);

  const cap = LEVEL_ORDER[levelCap] ?? LEVEL_ORDER.evidence;
  const claimed = asText(source.level).toLowerCase();
  let level = ["evidence", "inference", "manual"].includes(claimed) ? claimed : "inference";

  // 声明「输入证据」却给不出能在输入里核对的引文 —— 降级。
  if (level === "evidence") {
    const grounded = basis.some(quote => haystack.includes(stripForMatch(quote)));
    if (!grounded) level = "inference";
  }
  // 没有任何内容时是「待人工补充」，不是「模型推断」。
  if (!text) level = "manual";
  if (LEVEL_ORDER[level] > cap) level = levelCap;

  return { text, basis, level, levelLabel: PROFILE_EVIDENCE_LEVELS[level] };
};

/**
 * 价格必须能在输入里找到依据，否则整个清空。
 *
 * 模型手里没有任何产品定价数据，HANDOFF §5 点名禁止「输出看似完整但没有数据依据的
 * 变现产品价格」。注意**「免费」「面议」这类没有数字的说法同样要核对** ——
 * 一个凭空的「0 元」和一个凭空的「29800 元」一样会被项目经理当成调研结论。
 * 宁可空着让人工填，也不给一个编出来的价。
 */
export const normalizePrice = (rawPrice, haystack) => {
  const price = cleanText(rawPrice, 60);
  if (!price) return { price: "", grounded: false };
  const digits = price.replace(/[^\d]/g, "");
  // 有数字就核对数字；没数字就核对原话 —— 两条路径都是「必须在输入里找得到」。
  const grounded = digits ? haystack.includes(digits) : haystack.includes(stripForMatch(price));
  return { price: grounded ? price : "", grounded };
};
