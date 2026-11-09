import { REVIEW_CATEGORY_NAME } from "./benchmarkAnalysis.js";
// 证据助手（分级、引文核对、价格核对、等级标签）与 1.2 **共用一份实现**，实现见 `evidence.js`。
import {
  PROFILE_EVIDENCE_LEVELS,
  asCount,
  asText,
  cleanText,
  joinEvidenceParts,
  normalizeBasisField,
  normalizePrice,
  ratio,
  stripForMatch,
} from "./evidence.js";
import { IP_PROFILE_GROUPS, describeIpProfileCoverage, normalizeIpProfile } from "./ipProfileStore.js";
// 四 的两组钩子**只认这两份权威类型清单**（8 种开头类型 / 5 种结尾类型），
// 连同它们的归一化与中文标签一起 import —— 类型体系绝不在本文件里再抄一遍（§6.3⑫）。
import {
  GOLD_THREE_SECOND_DIMENSIONS,
  GOLD_THREE_SECOND_TYPE_LABELS,
  normalizeGoldThreeSecondType,
} from "./goldThreeSeconds.js";
import {
  ENDING_HOOK_TYPES,
  ENDING_HOOK_TYPE_LABELS,
  normalizeEndingHookType,
} from "./endingHooks.js";
// 最大余额法与 2.2 / 2.3 的配比**同一份实现**（`apportionRatios`）：六 的内容配比也要求
// 「每个时期合计恰好 100」，各写一份迟早会出现某一处算出 33+33+98 = 164 的老问题。
import { apportionRatios } from "./categoryTypeBreakdown.js";

/**
 * 模块 2「账号定位」(1.3) 的核心：一、IP定位 / 二、账号搭建 / 三、视频选题库（第一批）
 * 与 四、短视频内容框架 / 五、拍摄与剪辑建议 / 六、起号与运营（第二批）。
 *
 * ⚠️ **两批是同一份报告，不是两种报告类型**（2026-09-20 用户确认）：第二批只是把
 * `ACCOUNT_PLAN_SECTIONS` 从 3 节扩到 6 节、把批次号推到 2。存储、接口、前端步骤都不新增 ——
 * 因此第一批存下来的旧报告仍然原样可读，**第二批的六个小节在报告里全部是可选字段**：
 * 前端必须用 `?.` 兜住（缺字段时整节不渲染），后端也必须容忍一份缺 `threeSeconds` /
 * `endingHooks` 的旧 1.2 报告（那时只剩通用口径，报告要如实这么写）。
 *
 * 它与 1.2 的关系是「上层再上一层」：
 *   模块 3（2.1/2.2/2.3）产出选题库素材 → 1.2 把对标账号分析成一份报告 →
 *   1.3 把**外部客户的 IP 访谈档案**与 **1.2 的报告**合成一份可审核的账号定位方案。
 *
 * ── 三条硬性不变量（与 1.2 完全同一套，改之前先读 HANDOFF §5 / §6.3）──────────────
 *
 * ① **证据必须分级，不许编造。** 每个叙述字段都带 `level`：
 *      evidence（输入证据）/ inference（推断）/ manual（待人工补充）。
 *    模型自报的 level **不采信**：声明 evidence 时必须给出能在输入里核对上的 `basis` 引文，
 *    核对不上就压到 inference；没有内容的字段一律 manual。
 *
 * ② **`ipProfile` 里为空的字段，对应结论能不能标 evidence，看客户本人有没有留下一手输入。**
 *    （本模块特有，比 1.2 更严；2026-09-19 用户确认放宽）
 *    旧口径只看 `ipProfile`：档案里那一项为空 ⇒ 最多 inference，模型就算逐字引用了项目经理
 *    写在客户名册里的原话也不算证据。现在**客户名册里的补充说明（`ipPositioning` /
 *    `contentNeeds` / `notes`）与档案字段同等算数** —— 它们都是项目经理写下来的客户诉求，
 *    引用其中的原话不是编造，所以写了补充说明的客户，其结论可以凭引文升到 evidence。
 *    这条上限真正防的事仍然保留：**别拿对标账号的东西冒充客户自己的事实**。客户记录里
 *    连一句补充说明都没有时，唯一能引的只剩 1.2 报告，而它讲的是那个对标账号 ——
 *    那时年龄 / 性别 / 收入这类结论仍然最多 inference。
 *    **绝不允许编造年龄 / 性别 / 收入。**
 *
 * ③ **定价不得编造。** `ipProfile.product.priceRange` 常为空，模型手里也没有价目表：
 *    只有在输入（档案字段或访谈原文）里能找到依据时才填价格，否则留空 + 待人工补充。
 *    与 1.2 的 `normalizePrice` 同一做法（现在是同一个函数）。
 *
 * ── 后端重算（不信模型自己填的数字）────────────────────────────────────────────
 *   - 「选题库建立」**直接透传 1.2 报告 `contentPositioning.classification` 的产出**，
 *     不重跑分类；大类条数、占比、小类条数全部由后端按 topics 条数重算。
 *   - 每种选题方法的条数由后端按数组长度重算，模型写的数量一概不采信。
 *   - 变现路径逐步校验「通过xx方法——使用户产生xx行为，购买/获得xx产品」句式，
 *     不合规的**保留并标记 `patternOk: false`**（不丢弃内容，但必须让人看见它要改）。
 *   - 方法一(a) 的同赛道对标账号取客户档案登记（`customers.benchmarkAccounts`），
 *     模型自己提议的账号一律丢弃（它给不出可核对的来源）。
 *
 * ── 第二批（四、五、六）额外守住的三件事 ───────────────────────────────────────
 *   - **五 拍摄与剪辑建议没有输入数据。** 1.2 报告只分析内容与运营，一个字都没讲这个账号
 *     实际怎么拍、怎么剪，所以这 9 项**最高只能是 inference**（`levelCap` 强制），
 *     并随报告带一句「是建议、不是观测」，绝不允许标 evidence。
 *   - **六 的起号四步与数据复盘四维是行业通用模板，不是针对该客户的推断。**
 *     两块表**由后端写死**（`LAUNCH_STEPS` / `REVIEW_DIMENSIONS`），模型改不了也加不了，
 *     并带 `template: true` + 说明，读者不会把它当成对这家客户的调研结论。
 *   - **四 的钩子类型必须来自权威定义**（8 种 / 5 种）。认不出的类型、重复的类型一律丢弃
 *     并计数；条数由后端重算，模型自报的数量不采信。
 */

export const ACCOUNT_PLAN_REPORT_TYPE = "account_plan";

/**
 * 批次号写进报告，前端据此判断该渲染哪几节。
 * **第二批是同一份报告的扩展**（3 节 → 6 节），不是第二种报告类型 ——
 * 存储、接口、前端步骤都不新增，第一批的旧报告照旧能读能渲染。
 */
export const ACCOUNT_PLAN_BATCH = 2;

/**
 * 六个章节。**只在这里定义一次** ——
 * `producedSectionCount`、提示词的章节清单、前端的分节标题都从它生成。
 */
export const ACCOUNT_PLAN_SECTIONS = [
  { key: "ipPositioning", label: "一、IP定位" },
  { key: "accountSetup", label: "二、账号搭建" },
  { key: "topicLibrary", label: "三、视频选题库" },
  { key: "framework", label: "四、短视频内容框架" },
  { key: "production", label: "五、拍摄与剪辑建议" },
  { key: "operations", label: "六、起号与运营" },
];

export const ACCOUNT_PLAN_BATCH_LABEL = ACCOUNT_PLAN_SECTIONS.map(section => section.label).join(" / ");

/**
 * 变现产品的四个层级。**只写一份**，提示词由它生成（§6.3⑫）：
 * 每深一层级，用户的决策成本越大、定价越高。
 */
export const PRODUCT_TIERS = [
  { tier: "引流产品", role: "门槛最低，把内容观众变成私域里的一个联系人", pricing: "通常免费或极低价" },
  { tier: "信任产品", role: "在私域里证明专业能力，建立信任", pricing: "低价，决策成本小" },
  { tier: "核心产品", role: "主要利润来源，对应 IP 的核心交付能力", pricing: "中高价，需要一次较重的决策" },
  { tier: "利润产品", role: "一对一定制或深度服务，筛选出高价值客户", pricing: "最高价，决策成本最大" },
];

export const PRODUCT_TIER_NAMES = PRODUCT_TIERS.map(item => item.tier);

/**
 * 「目标人群」的固定维度，以及与 `ipProfile.userProfile` 的来源绑定关系。
 *
 * `sourceKey` 是**诚实性开关的一半**（见文件头不变量②）：档案里这一项为空、且客户名册里
 * 也没有补充说明时，对应维度最多只能是推断；写了补充说明的客户则可以凭其中的原话升到
 * evidence（`dimension.note` 会如实说清是哪一种）。前端同时拿它显示「档案里填的是什么」。
 * 消费场景 / 消费习惯没有额外的画像数据源，所以与其它维度同一口径处理。
 */
export const AUDIENCE_DIMENSIONS = [
  { key: "age", label: "年龄", sourceKey: "userProfile.age" },
  { key: "gender", label: "性别", sourceKey: "userProfile.gender" },
  { key: "occupationIndustry", label: "职业/行业", sourceKey: "userProfile.occupationIndustry" },
  { key: "incomeLevel", label: "收入水平", sourceKey: "userProfile.incomeLevel" },
  { key: "consumptionHabits", label: "消费习惯", sourceKey: "userProfile.consumptionHabits" },
  { key: "consumptionScenarios", label: "消费场景", sourceKey: "userProfile.consumptionScenarios" },
];

/** 账号三件套。头像、背景图**必须写清具体场景**，否则用户拿到手没法执行。 */
export const ACCOUNT_TRIO = [
  { key: "name", label: "名字", rule: "IP昵称 + 职业/核心痛点" },
  {
    key: "avatar",
    label: "头像",
    rule: "根据客户提供的照片，修改场景和着装，加深人设印象、建立专业感与信任感（职业证件照 / 场景职业照）",
  },
  {
    key: "background",
    label: "背景图",
    rule: "结合人设定位给出建议，必须写清「具体是什么场景」以及「体现什么人设特点」",
  },
];

/**
 * 账号简介的四行结构。**顺序就是信息重要程度**，提示词与前端都从这里生成。
 * 第一行只挑最重要的一条；第二行把行业年限（>5 年是加分项）**加在核心业绩后面**。
 */
export const BIO_ROWS = [
  {
    row: 1,
    key: "identity",
    label: "身份头衔",
    rule: "只挑最重要的一条，按信息重要程度排序",
    priority: [
      "大厂背景（世界500强高管、头部MCN合伙人）",
      "官方机构（XX协会理事、人社部认证XX师）",
      "创始人/主理人（XX品牌创始人、XX公司CEO）",
      "知名企业背景（上市公司前VP）",
    ],
  },
  {
    row: 2,
    key: "achievement",
    label: "成就背书",
    rule: "核心业绩/成功案例放前面，行业年限/实战经验（超过 5 年是加分项）加在核心业绩后面",
    priority: [
      "核心业绩/成功案例（客户案例为大厂或知名企业、销售额上千万、服务数量上百家）",
      "行业专业身份（官方认证：高级XX师）",
      "个人荣誉",
    ],
  },
  {
    row: 3,
    key: "advantage",
    label: "优势/产品/服务/价值观",
    rule: "产品服务、核心内容标签（对着用户痛点）、价值观，三者按客户实际情况取舍",
    priority: [
      "产品服务（业务范围/产品名）",
      "核心内容标签（分享关于XX的底层逻辑、手把手教你XX）",
      "价值观",
    ],
  },
  {
    row: 4,
    key: "callToAction",
    label: "行动引导/转化入口",
    rule: "参考 1.2 报告的 operationStrategy.trafficScripts（简介与评论区话术拆解）",
    priority: [
      "私域引流（领取资料、进入社群）",
      "直播预约/固定时间（固定排期、合作通道、直播钩子）",
      "关注/合集引导（关注理由、主页引导、情感信任）",
    ],
  },
];

/** 简介要出两版：视频号在前（规格里的顺序），抖音在后。 */
export const BIO_PLATFORMS = [
  { key: "shipinhao", label: "视频号" },
  { key: "douyin", label: "抖音" },
];

export const BIO_CANDIDATES_PER_ROW = 3;

/** 人设定位：性格关键词固定 5 个，侧重「习惯用什么表达方式」并体现真实感。 */
export const PERSONALITY_KEYWORD_COUNT = 5;

/** IP 记忆锚点的三类。设计原则：简单、便于高频出现、有辨识度、有记忆点。 */
export const MEMORY_ANCHOR_TYPES = [
  { key: "visual", label: "视觉锚点", dimension: "服装 / 道具 / 场景", fits: "角色定位与性格" },
  { key: "behavior", label: "行为锚点", dimension: "固定手势 / 肢体动作", fits: "内容定位与情绪表达" },
  { key: "language", label: "语言锚点", dimension: "口头禅 / slogan / 固定句式", fits: "角色定位与核心内容" },
];

/** 语言锚点的建议句式（规格原文），提示词与报告共用这一份。 */
export const LANGUAGE_ANCHOR_TEMPLATE = "如果你有xxx（用户核心痛点），关注xxx（IP角色定位），一起xxx（核心内容定位）";

/** 选题库的三种方法。 */
export const TOPIC_METHODS = [
  { key: "benchmark", label: "方法一：对标账号" },
  { key: "questions", label: "方法二：客户提问整理" },
  { key: "trends", label: "方法三：蹭热点" },
];

/** 蹭热点的三个方向。后端**固定输出这三组**（没命中的也列出来，用户才知道缺哪一组）。 */
export const HOT_TOPIC_CATEGORIES = [
  { key: "current", label: "时事热点" },
  { key: "policy", label: "政策热点" },
  { key: "calendar", label: "时间节点" },
];

/**
 * 热点时效性提示。⚠️ 这一步**无法联网**，热点是模型凭自身知识推断的，
 * 不是当天的热搜榜 —— 不写清楚，用户会把它当成实时数据直接用。
 */
export const HOT_TOPIC_DISCLAIMER = "本组热点由模型基于自身知识推断，不是实时榜单数据（该步骤无法联网），时效性需人工核实后再使用。";

/** 变现路径的规定句式，逐步校验。 */
export const MONETIZATION_STEP_TEMPLATE = "通过xx方法——使用户产生xx行为，购买/获得xx产品";

const MONETIZATION_STEP_PATTERN = /^通过.+?(?:——|—|--|－).+?用户产生.+?行为.+?(?:购买|获得)/;

// ── 四、短视频内容框架 ────────────────────────────────────────────────────────

/**
 * 开头 3 秒 / 结尾钩子各要 **4 种不同类型**（规格原文）。
 *
 * ⚠️ 规格在「结尾钩子」那一条里也写成了「3 秒钩子」，那是笔误：它指的是结尾钩子，
 * 类型取 `ENDING_HOOK_TYPES`（5 种）。两组数量都是 4，所以共用一个常量里的两个字段，
 * **不要**把开头的 8 种类型套到结尾上（反过来也不行）。
 */
export const OPENING_HOOK_COUNT = 4;
export const ENDING_HOOK_COUNT = 4;

/**
 * 四 的说明：钩子是**现写的创作建议**，不是对账号的观测。
 *
 * 每个钩子仍然带 `level`（与其它字段同一套 `normalizeBasisField` 语义）——
 * 它描述的是「这条建议的依据强度」：理由能对回客户档案 / 1.2 报告的是输入证据，
 * 编不出依据的降成推断。**但读的人必须知道它不是「这个账号确实这么做」的记录**，
 * 否则一句带「输入证据」徽章的开头文案会被当成调研结论直接照抄。
 */
export const HOOK_SECTION_NOTE = "两组钩子都是结合 1.2 的开头 / 结尾分析与本客户的 IP 定位、内容定位**现写的创作建议**；每条右上角的等级说的是「这条建议的依据强度」，不是对该账号实际做法的观测。";

/** 钩子类型不在权威清单里、或类型重复时的丢弃说明（前端与导出都要显示丢弃数）。 */
export const HOOK_DISCARD_NOTE = "类型不在后端权威清单内、或与前一条类型重复的钩子会被直接丢弃（数量如实记录），不写入报告。";

// ── 五、拍摄与剪辑建议 ────────────────────────────────────────────────────────

/**
 * ⚠️ **本节没有输入数据。** 1.2 报告只分析内容与运营，没有一句提到这个账号实际怎么拍、
 * 怎么剪；输入的其它部分（客户档案、访谈原文）也不含拍摄信息。
 * 所以这 9 项是**基于人设定位与内容定位的建议**，不是观测 —— `levelCap` 一律压到 inference，
 * 模型就算引用了能核对上的原话也不许标 evidence（见 `PRODUCTION_LEVEL_CAP_NOTE`）。
 */
export const PRODUCTION_ADVICE_NOTE = "以下是结合「人设定位」与「内容定位」给出的拍摄与剪辑**建议**：1.2 报告与客户档案里都没有这个账号实际怎么拍、怎么剪的记录，所以它是建议，**不是对该账号实际拍摄方式的观测**。";

export const PRODUCTION_LEVEL_CAP_NOTE = "本节各项的证据上限被后端强制为「Agent 推断」：输入里没有任何可核对的拍摄 / 剪辑事实，即使模型给出引文也不会升级成「输入证据」。";

/** 五 的拍摄风格 5 项（规格原文的 5 个维度，顺序即规格顺序）。 */
export const PRODUCTION_SHOOTING_ITEMS = [
  { key: "appearance", label: "人物形象", rule: "出镜形象要贴合人设定位的角色：职业感 / 亲和力、神态与肢体语言" },
  { key: "wardrobe", label: "穿着", rule: "服装与身份职业、内容场景匹配，形成稳定的视觉记忆（对应视觉锚点）" },
  { key: "speechRate", label: "语速", rule: "语速与停顿贴合目标用户的接受习惯；口播与演绎用的节奏不一样" },
  { key: "camera", label: "镜头", rule: "景别、机位、运镜怎么配合内容：讲干货与讲故事要的不是同一套镜头" },
  { key: "scene", label: "场景", rule: "在哪些场景拍、场景如何强化人设与信任感（对应视觉锚点）" },
];

/** 五 的剪辑风格 4 项。 */
export const PRODUCTION_EDITING_ITEMS = [
  { key: "footage", label: "素材类型", rule: "口播 / 实拍 / 图文 / 录屏 / 案例素材各占多少、怎么穿插" },
  { key: "music", label: "音乐", rule: "BGM 的情绪与音量、在哪些位置起音乐（不要盖过口播）" },
  { key: "cover", label: "封面", rule: "封面画面 + 标题字怎么排，保证信息一眼可读、风格统一" },
  { key: "subtitle", label: "字幕", rule: "字幕样式、关键词强调、花字与位置（口播类尤其重要）" },
];

// ── 六、起号与运营 ────────────────────────────────────────────────────────────

/**
 * 起号策略四步与数据复盘四维：**行业通用模板，不是针对该客户的推断**。
 *
 * 客户明确说「按照模板生成就好」，所以这两块**由后端写死**：模型既不能改写这四步 / 四维，
 * 也不能加出第五步、第五维。两块表随报告带 `template: true` + `note`，
 * 读的人一眼就知道这是通用模板建议，不是对这家客户的调研结论。
 */
export const LAUNCH_STEPS = [
  { step: 1, name: "养号+基建工作", action: "给同行作品点赞/评论，搭建昵称、简介、照片等基建，完成实名认证" },
  { step: 2, name: "储备素材", action: "一次性攒 3-5 条视频（不同选题类型）" },
  { step: 3, name: "日更测试", action: "每天发 1 条，时间固定，测试哪个时间段数据最好" },
  { step: 4, name: "复制爆款", action: "哪条数据跑出来（关注完播、3s、点赞收藏），立刻用同选题结构复制" },
];

export const LAUNCH_TEMPLATE_NOTE = "这是行业通用的起号四步模板，**不是针对该客户的推断或观测**；执行时按客户实际情况取舍。";

export const REVIEW_DIMENSIONS = [
  { key: "completionRate", label: "完播率", focus: "哪一秒开始下滑严重？开头 3 秒是否不够吸引？" },
  { key: "interaction", label: "互动比", focus: "评论多说明有争议/共鸣，要放大这类内容" },
  { key: "followerGrowth", label: "涨粉速度", focus: "单条视频涨粉多，说明内容有价值，立刻复制同类" },
  { key: "title", label: "标题", focus: "点击率低就换标题格式，测试不同钩子" },
];

export const REVIEW_TEMPLATE_NOTE = "这是行业通用的数据复盘四维模板，**不是针对该客户的推断**；它规定的是复盘时看哪几个指标，与该账号的实际数据无关。";

/** 两块模板表的来源标记：固定文本，不由模型产出。 */
export const TEMPLATE_SOURCE_NOTE = "固定模板文本（后端写死，模型不能改写或增删条目）。";

/** 六 的引流话术两类（规格原文）。 */
export const TRAFFIC_SCRIPT_TYPES = [
  { key: "comments", label: "评论区互动话术", rule: "目的是把沉默观众拉进评论区、把评论变成二次曝光；引流导向是主页与合集" },
  { key: "follow", label: "关注引流话术", rule: "目的是给出关注理由（后续会讲什么、错过会怎样）；引流导向是关注与私域" },
];

/** 内容配比的三个时期（规格原文，稳定期括号里的话也照写）。 */
export const CONTENT_MIX_PERIODS = [
  { key: "launch", label: "起号期" },
  { key: "growth", label: "增长期" },
  { key: "stable", label: "稳定期（内容成型）" },
];

/**
 * 六 内容配比的**比重意图**：模型只给每个大类一个意图与理由，
 * 真正的百分比由后端按这里的权重用最大余额法分配（`apportionRatios`），
 * **模型填的百分比一概不采信**（与 1.2 的分类占比、2.2/2.3 的类型配比同一原则）。
 */
export const CONTENT_MIX_INTENTS = [
  { key: "focus", label: "重点", weight: 3 },
  { key: "normal", label: "常规", weight: 2 },
  { key: "light", label: "少量", weight: 1 },
];

/** 模型没给意图时按「常规」参与分配，并在该行如实标注（不静默补一个数字）。 */
export const CONTENT_MIX_DEFAULT_INTENT = "normal";

export const CONTENT_MIX_NOTE = "配比由后端按每个大类的「比重意图」用最大余额法重算（与 1.2 的分类占比、2.2/2.3 的类型配比同一口径），每个时期合计恰好 100；模型填的百分比一概不采信。大类只能来自 1.2 报告的内容大类，对不上的丢弃并计数。";

/** 六 的整体说明：哪两块是模板、哪两块是本客户的建议。 */
export const OPERATIONS_SECTION_NOTE = "「起号策略」与「数据复盘重点」是行业通用模板（固定文本，后端写死，带 template 标记）；「平台与矩阵策略」与「内容配比」才是按本客户的 IP 定位与 1.2 报告生成的建议，其中引用 1.2 operationStrategy（发布时间、频率、话术）的字段沿用它们原有的证据等级。";

/** 档案里一旦为空就该提醒的「关键字段」（用于 missingInputs）：缺了它们，相关结论多数只能落推断或待人工补充。 */
const CRITICAL_PROFILE_PATHS = new Set([
  "identity.name",
  "identity.occupation",
  "identity.yearsExperience",
  "identity.keyCases",
  "product.productType",
  "product.coreAdvantages",
  "product.priceRange",
  "userProfile.gender",
  "userProfile.age",
  "userProfile.occupationIndustry",
  "userProfile.incomeLevel",
  "userProfile.painPoints",
  "userProfile.goalsNeeds",
]);

const objectOrEmpty = value => (value && typeof value === "object" ? value : {});

/** 「未归类」大类不进选题库（与 1.2 / 2.2 / 2.3 同一口径）。 */
const isReviewCategory = category => asText(category?.name) === REVIEW_CATEGORY_NAME;

/** 用已经拆好的 text / basis / level 去评级（用于把模型的候选条目逐个过一遍）。 */
const gradeText = ({ text, basis, level }, options) => normalizeBasisField({
  raw: { text, basis, level },
  ...options,
});

/** 校验变现路径是否用了规定句式。不合规不丢弃内容，但要如实标出来让人改。 */
export const checkMonetizationStep = value => {
  const text = cleanText(value, 400);
  if (!text) return { ok: false, note: "变现路径为空，待人工补充。" };
  // 允许「第一步：」这类前缀，句式本身仍要求以「通过」开头。
  const stripped = text.replace(/^第[一二三四五六七八九十\d]+步[：:、.]?\s*/, "");
  if (MONETIZATION_STEP_PATTERN.test(stripped)) return { ok: true, note: "" };
  return { ok: false, note: `未按标准句式（${MONETIZATION_STEP_TEMPLATE}），需人工改写。` };
};

/** 前端可能直接传 1.2 的正文，也可能传报告接口返回的 `{ id, report }` 外壳 —— 两种都认。 */
const unwrapBenchmarkReport = value => {
  const source = objectOrEmpty(value);
  if (source.report && typeof source.report === "object") return { id: asText(source.id), report: objectOrEmpty(source.report) };
  return { id: asText(source.id), report: source };
};

/**
 * 1.2 报告的「选题库」透传。
 *
 * ⚠️ 这里**只做透传 + 重算，不重跑分类**（规格原文：「直接透传 1.2 报告的产出」）。
 * 条数与占比一律由后端按 topics 条数算，**不采信 1.2 报告里已经写着的 count/percentage，
 * 更不采信模型自己填的数字** —— 与 §6.3⑬「配比由后端按条数统计」同一条原则。
 *
 * 1.2 的 `topics` 在库里只存 `{ id, title }`（§6.2⑨），所以 link / stats 通常是空的；
 * 但旧形状里可能是完整对象，两种都认，读不到就留空，**绝不补零**。
 */
export const buildClassificationPassthrough = benchmarkReport => {
  const report = objectOrEmpty(benchmarkReport);
  const classification = objectOrEmpty(report.contentPositioning?.classification);
  const rawCategories = Array.isArray(classification.categories) ? classification.categories : [];

  const normalizeTopic = rawTopic => {
    if (typeof rawTopic === "string") return { id: "", title: cleanText(rawTopic, 200), link: "", stats: null };
    const topic = objectOrEmpty(rawTopic);
    const stats = objectOrEmpty(topic.stats);
    const hasStats = Object.keys(stats).length > 0;
    return {
      id: asText(topic.id || topic.videoId),
      title: cleanText(topic.title || topic.name, 200),
      link: asText(topic.link || topic.url),
      // 没有互动数据时是 null，不是 { likes: 0 }：编一个 0 会被读成「真实互动为 0」。
      stats: hasStats ? stats : null,
    };
  };

  const categories = rawCategories
    .filter(category => !isReviewCategory(category))
    .map((category, index) => {
      const rawSubcategories = Array.isArray(category?.subcategories) ? category.subcategories : [];
      const subcategories = rawSubcategories.map((rawSub, subIndex) => {
        const sub = objectOrEmpty(rawSub);
        const topics = (Array.isArray(sub.topics) ? sub.topics : []).map(normalizeTopic).filter(topic => topic.title);
        return {
          id: asText(sub.id) || `subcategory-${index + 1}-${subIndex + 1}`,
          name: cleanText(sub.name, 100),
          description: cleanText(sub.description, 320),
          topics,
          topicCount: topics.length,
        };
      }).filter(sub => sub.topics.length > 0);

      // 大类的选题以扁平列表为准（1.2 报告里它就是各小类的合集）；旧报告没有扁平列表时
      // 才从小类里兜回来，避免两种形状下条数不一致。
      const flatTopics = Array.isArray(category?.topics) && category.topics.length > 0
        ? category.topics.map(normalizeTopic).filter(topic => topic.title)
        : subcategories.flatMap(sub => sub.topics);

      return {
        id: asText(category?.id) || `category-${index + 1}`,
        name: cleanText(category?.name, 100),
        // coreFunction 与 keywords 是 1.2 生成的、客户明确说「仅在生成对标账号分析和账号定位中需要」的两项，
        // 必须原样保留，不能因为「只透传标题」就把它们丢掉。
        coreFunction: cleanText(category?.coreFunction, 500),
        keywords: (Array.isArray(category?.keywords) ? category.keywords : []).map(item => cleanText(item, 40)).filter(Boolean).slice(0, 12),
        subcategories,
        topics: flatTopics,
        topicCount: flatTopics.length,
        percentage: 0,
      };
    })
    .filter(category => category.name || category.topics.length > 0);

  // 占比**按条数重算**：合计由最大余额之外的自然取整决定，最后一项用总量减去前面，
  // 保证「所有大类占比合计恰好 100%」——与 1.2 的分类报告同一口径。
  const topicTotal = categories.reduce((sum, category) => sum + category.topicCount, 0);
  categories.forEach((category, index) => {
    category.percentage = index === categories.length - 1
      ? Math.round((100 - categories.slice(0, index).reduce((sum, item) => sum + item.percentage, 0)) * 10) / 10
      : ratio(category.topicCount, topicTotal);
  });
  categories.forEach(category => {
    category.subcategories.forEach(sub => {
      sub.percentage = ratio(sub.topicCount, topicTotal);
    });
  });

  return {
    source: "直接透传 1.2 报告 contentPositioning.classification 的产出，未重跑分类。",
    contentStyle: asText(classification.contentStyle),
    contentStyleLabel: asText(classification.contentStyleLabel),
    benchmarkSourceNote: asText(classification.source),
    benchmarkAnalyzedCount: asCount(classification.analyzedCount),
    sampleWindow: asText(classification.sampleWindow),
    summary: cleanText(classification.summary, 800),
    categoryCount: categories.length,
    subcategoryCount: categories.reduce((sum, category) => sum + category.subcategories.length, 0),
    topicTotal,
    recomputeNote: `大类条数、占比与小类条数均由后端按 topics 条数重算（合计 ${topicTotal} 条选题）；1.2 报告或模型自填的数字一概不采信。`,
    categories,
  };
};

/** 把 1.2 报告里带分级的字段转成一句可读文本，**连 level 一起给**（待人工补充的不能当结论）。 */
const describeGradedField = raw => {
  const source = objectOrEmpty(raw);
  const text = cleanText(source.text || raw, 600);
  const level = asText(source.level);
  if (!text) return { text: "", level: level || "manual", note: "1.2 报告里这一项没有内容。" };
  return { text, level, note: level === "manual" ? "1.2 报告里这一项标着「待人工补充」，不要当作已验证的结论。" : "" };
};

/**
 * 1.2 报告的字段**原样透传**：等级沿用 1.2 自己判定的那一级，
 * 不重新核对引文、也不在这里升级或降级（不变量⑥）。
 *
 * ⚠️ 与 `normalizeBasisField` 的分工：那个函数是「模型新写的叙述 → 重新定级」，
 * 这个函数是「1.2 已经定过级的字段 → 照抄等级」。1.2 报告是同一套规则产出的，
 * 再拿 1.3 的 haystack 去核对一遍只会把它的等级改掉 —— 那就成了「一律降级」。
 */
const passthroughGraded = raw => {
  const source = objectOrEmpty(raw);
  const text = cleanText(source.text || raw, 600);
  const claimed = asText(source.level).toLowerCase();
  const level = text && ["evidence", "inference", "manual"].includes(claimed) ? claimed : "manual";
  return {
    text,
    basis: (Array.isArray(source.basis) ? source.basis : []).map(item => cleanText(item, 160)).filter(Boolean).slice(0, 5),
    level,
    levelLabel: PROFILE_EVIDENCE_LEVELS[level],
    note: text ? "" : "1.2 报告里这一项没有内容。",
  };
};

/**
 * 四 要参考的两块 1.2 产出：`contentPositioning.threeSeconds`（3 秒分析）与
 * `contentPositioning.endingHooks`（结尾钩子分析）。
 *
 * ⚠️ 两份都必须**如实带上「有没有这一块」**：
 *   - 1.2 报告（以及 1.1/手动拼出来的旧报告）可能压根没有这两个字段 —— 那时
 *     `available: false` + 一句说明，前端与提示词都据此降级成「按通用口径给，需人工核对」，
 *     绝不能因为读不到就当成「对标账号没这么用过」；
 *   - `topTypes` / `typeDistribution` 里的类型仍然过一遍权威归一化，**认不出的丢掉**；
 *   - `allowedTypes` 永远是后端权威清单（8 种 / 5 种）——类型体系只有这一份，1.2 报告里的
 *     `dimensions` / `types` 只是它的镜像，所以这里连镜像一起给出来做对照。
 */
const describeHookReference = ({ block, definitions, typeLabelOf, normalizeType, label }) => {
  const source = objectOrEmpty(block);
  const known = new Set(definitions.map(item => item.type));
  const typeDistribution = (Array.isArray(source.typeDistribution) ? source.typeDistribution : [])
    .map(item => {
      const type = normalizeType(item?.type || item?.name);
      if (!known.has(type)) return null;
      return {
        type,
        typeLabel: typeLabelOf[type],
        count: asCount(item?.count),
        percentage: Number(item?.percentage) || 0,
      };
    })
    .filter(Boolean);
  const topTypes = (Array.isArray(source.topTypes) ? source.topTypes : [])
    .map(item => {
      const type = normalizeType(item?.type || item?.name);
      if (!known.has(type)) return null;
      return {
        type,
        typeLabel: typeLabelOf[type],
        count: asCount(item?.count),
        percentage: Number(item?.percentage) || 0,
        reason: cleanText(item?.reason, 600),
      };
    })
    .filter(Boolean);
  // 1.2 报告里那份定义数组（三秒分析叫 dimensions、结尾钩子叫 types），旧报告可能没有。
  const reportDefinitions = (Array.isArray(source.dimensions) ? source.dimensions : Array.isArray(source.types) ? source.types : [])
    .map(item => {
      const type = asText(item?.type);
      if (!type) return null;
      return {
        type,
        label: asText(item?.label) || typeLabelOf[type] || type,
        definition: cleanText(item?.definition, 300),
        example: cleanText(item?.example, 200),
        strength: asText(item?.strength),
      };
    })
    .filter(Boolean);
  const available = typeDistribution.length > 0 || topTypes.length > 0;
  return {
    available,
    itemCount: asCount(source.itemCount),
    topTypes,
    typeDistribution,
    analysisReason: cleanText(source.analysisReason, 1200),
    // 后端权威类型清单：模型只能从 `type` 里选（校验用的也是同一份）。
    allowedTypes: definitions.map(item => ({
      type: item.type,
      label: typeLabelOf[item.type],
      definition: item.definition,
      example: item.example,
      strength: item.strength,
    })),
    reportDefinitions,
    note: available
      ? "以上来自 1.2 报告，可直接引用；类型仍然只能从 allowedTypes 里选。"
      : `1.2 报告里没有「${label}」的分析结果（旧报告缺这一批字段）：这一节只能按通用口径给，需人工核对。`,
  };
};

/**
 * 组装送给模型的输入。
 *
 * 两份输入都**如实带上「哪些是空的」**：
 *   - 客户档案：19 个字段逐项给出值，空的就是空串；另附 filledFields / emptyFields；
 *   - 1.2 报告：每个叙述字段连它自己的 `level` 一起给 —— 标着「待人工补充」的字段
 *     在 1.3 里同样不是结论（HANDOFF：不要把待人工补充当成已验证的结论）。
 *
 * 第二批（四、五、六）另外要三块 1.2 产出，都是**这一批才接进输入**的：
 * `contentPositioning.threeSeconds`（开头 3 秒分析）、`contentPositioning.endingHooks`
 * （结尾钩子分析）、`operationStrategy.publishing`（发布时间与频率，由 1.2 从真实发布日实算）。
 * 前两块各自带 `available` 标记 —— 旧 1.2 报告没有它们时如实说明，不许当成「对标账号没用过」。
 */
export const buildAccountPlanInput = ({ customer, benchmarkReport } = {}) => {
  const source = objectOrEmpty(customer);
  const profile = normalizeIpProfile(source.ipProfile);
  const coverage = describeIpProfileCoverage(profile);
  const { report } = unwrapBenchmarkReport(benchmarkReport);
  const classification = buildClassificationPassthrough(report);
  const business = objectOrEmpty(report.businessPositioning);
  const userProfile = objectOrEmpty(report.userProfile);
  const operation = objectOrEmpty(report.operationStrategy);

  const threeSeconds = describeHookReference({
    block: report.contentPositioning?.threeSeconds,
    definitions: GOLD_THREE_SECOND_DIMENSIONS,
    typeLabelOf: GOLD_THREE_SECOND_TYPE_LABELS,
    normalizeType: normalizeGoldThreeSecondType,
    label: "开头 3 秒分析",
  });
  const endingHooks = describeHookReference({
    block: report.contentPositioning?.endingHooks,
    definitions: ENDING_HOOK_TYPES,
    typeLabelOf: ENDING_HOOK_TYPE_LABELS,
    normalizeType: normalizeEndingHookType,
    label: "结尾钩子分析",
  });
  const publishing = objectOrEmpty(operation.publishing);

  // 用清单里的中文标签作键，模型读起来比 group.key 直接；空串就是「客户没填」。
  const profileFields = {};
  for (const group of IP_PROFILE_GROUPS) {
    const fields = {};
    for (const field of group.fields) fields[field.label] = asText(profile[group.key]?.[field.key]);
    profileFields[group.label] = fields;
  }

  return {
    customer: {
      id: asText(source.id),
      name: asText(source.name),
      occupation: asText(source.occupation),
      hasProfile: coverage.hasAnyValue,
      profileStatus: profile.status,
      // 逐字段给值：空串就是「客户档案里没填」，**不要拿它当线索去猜**。
      ipProfile: profileFields,
      filledFields: coverage.filled.map(item => item.path),
      emptyFields: coverage.empty.map(item => item.path),
      interviewNotes: profile.interview.rawNotes,
      interviewNote: profile.interview.rawNotesTruncated
        ? `访谈原文超过 ${profile.interview.rawNotesLength} 字，已截断到 ${profile.interview.rawNotes.length} 字后再送入分析。`
        : "",
      // 客户名册里项目经理填的补充说明（实测 5 个客户里有 4 个只有这些、没有正式档案）。
      // **它们和 ipProfile 一样是客户方一手输入**：项目经理自己写下来的客户诉求，模型逐字引用
      // 不算编造，所以允许据此标 evidence（引文仍然要能在输入里核对上，核对不上照样降级成推断）。
      // ⚠️ `benchmarkAccounts` 例外：那串对标账号链接只用来填方法一(a) 的同赛道账号，
      // **不给正文结论当证据**（它也不进 `buildEvidenceHaystack`）。
      context: {
        ipPositioning: cleanText(source.ipPositioning, 600),
        contentNeeds: cleanText(source.contentNeeds, 1200),
        notes: cleanText(source.notes, 1200),
        benchmarkAccounts: cleanText(source.benchmarkAccounts, 600),
        note: "项目经理在客户名册里填写的补充说明，属于客户方一手输入：可以引用其中的原话作为输入证据（basis 必须能在输入里核对上），但不许据它编造档案里没有的数字与事实。",
      },
    },
    benchmark: {
      reportType: asText(report.reportType),
      accountName: asText(report.account?.name),
      accountUrl: asText(report.account?.url),
      signature: cleanText(report.account?.signature, 1000),
      contentStyleLabel: asText(report.contentStyleLabel),
      businessPositioning: {
        persona: describeGradedField(business.persona),
        corePain: describeGradedField(business.corePain),
        summary: cleanText(business.summary, 800),
      },
      userProfile: {
        demographics: (Array.isArray(userProfile.demographics) ? userProfile.demographics : []).map(item => ({
          label: asText(item?.label),
          text: cleanText(item?.text, 300),
          level: asText(item?.level),
        })),
        pains: describeGradedField(userProfile.pains),
        goals: describeGradedField(userProfile.goals),
      },
      classification: {
        contentStyleLabel: classification.contentStyleLabel,
        summary: classification.summary,
        categories: classification.categories.map(category => ({
          name: category.name,
          coreFunction: category.coreFunction,
          keywords: category.keywords,
          topicCount: category.topicCount,
          percentage: category.percentage,
          subcategories: category.subcategories.map(sub => ({
            name: sub.name,
            description: sub.description,
            // ⚠️ 必须带上**互动数据**，不能只给标题。
            //
            // 用户 2026-09-18 明确：1.3 除「内容定位」直接复用 1.2 外，其余部分要
            // **结合 IP 信息 + 之前抓取的 60 条视频的基础数据**重新分析。
            // 只给标题的话，模型无法判断「这个大类里哪类选题更跑得动」，
            // 而选题库与商业定位恰恰依赖这个判断。
            //
            // 链接不送：模型用不上，白占 token；报告输出里链接仍然完整保留。
            topics: sub.topics.map(topic => ({
              title: asText(topic?.title),
              ...(topic?.stats && ["likes", "comments", "shares", "bookmarks"].some(key => Number(topic.stats[key]) > 0)
                ? {
                  stats: {
                    likes: asCount(topic.stats.likes),
                    comments: asCount(topic.stats.comments),
                    shares: asCount(topic.stats.shares),
                    bookmarks: asCount(topic.stats.bookmarks),
                  },
                }
                : {}),
            })),
          })),
        })),
      },
      frequentTags: (Array.isArray(report.frequentTags) ? report.frequentTags : []).map(item => ({
        tag: asText(item?.tag),
        count: asCount(item?.count),
        percentage: Number(item?.percentage) || 0,
      })).filter(item => item.tag),
      // 四 的两组钩子要参考这两块（1.2 的 3 秒分析与结尾钩子分析）。
      threeSeconds,
      endingHooks,
      operationStrategy: {
        // 发布时间与频率：1.2 从真实发布日实算出来的，六 的发布建议要参考它。
        // ⚠️ 等级照抄 1.2 自己的判定（有发布日期就是 evidence、没有就是 manual）——
        // 旧报告缺 level 时按同一条规则补，绝不在这里升级或降级。
        publishing: {
          available: Boolean(asCount(publishing.videoCount) || asCount(publishing.datedCount) || asText(publishing.analysis)),
          videoCount: asCount(publishing.videoCount),
          datedCount: asCount(publishing.datedCount),
          spanDays: asCount(publishing.spanDays),
          perWeek: Number(publishing.perWeek) || 0,
          weekdayDistribution: (Array.isArray(publishing.weekdayDistribution) ? publishing.weekdayDistribution : []).map(item => ({
            weekday: asText(item?.weekday),
            count: asCount(item?.count),
          })).filter(item => item.weekday),
          hasTimeOfDay: Boolean(publishing.hasTimeOfDay),
          note: cleanText(publishing.note, 400),
          analysis: cleanText(publishing.analysis, 800),
          level: ["evidence", "inference", "manual"].includes(asText(publishing.level))
            ? asText(publishing.level)
            : (asCount(publishing.datedCount) > 0 ? "evidence" : "manual"),
        },
        trafficScripts: {
          bio: describeGradedField(operation.trafficScripts?.bio),
          comments: describeGradedField(operation.trafficScripts?.comments),
        },
        monetization: {
          // 「模仿 1.2 的变现产品」：把 1.2 已经产出的结构原样给模型做参照，
          // 连同 priceNote（哪些定价当时就没有依据）一起给。
          products: (Array.isArray(operation.monetization?.products) ? operation.monetization.products : []).map(item => ({
            tier: asText(item?.tier),
            product: asText(item?.product),
            price: asText(item?.price),
            priceNote: asText(item?.priceNote),
            positioning: cleanText(item?.positioning, 400),
            role: cleanText(item?.role, 400),
            level: asText(item?.level),
          })),
          path: (Array.isArray(operation.monetization?.path) ? operation.monetization.path : []).map(item => ({
            step: asCount(item?.step),
            description: cleanText(item?.description, 400),
          })),
        },
      },
    },
  };
};

/** 把档案里的取值读出来（`userProfile.age` 这样的路径）。 */
const readProfilePath = (profile, path) => {
  const [group, key] = asText(path).split(".");
  return asText(profile?.[group]?.[key]);
};

/**
 * 输入证据索引：客户名 + 档案 19 个字段 + 访谈原文 + 客户名册的补充说明 + 1.2 报告全文
 * （含选题标题与分类关键词）。模型引用的原句必须能在这一份索引里找到，才允许标 evidence。
 *
 * 名册补充说明（`ipPositioning` / `contentNeeds` / `notes`）与访谈原文一样是**客户方一手输入**，
 * 所以它们既进索引、也允许支撑 evidence（不变量②）。唯一不进索引的是
 * `benchmarkAccounts` —— 那是一串对标账号链接，只用来填方法一(a) 的同赛道账号，
 * 不能给任何正文结论当证据，否则模型抄一个链接就能把叙述升成「输入证据」。
 */
const buildEvidenceHaystack = ({ customer, benchmarkReport, classification }) => {
  const parts = [customer.name, customer.occupation];
  const profile = customer.ipProfile;
  for (const group of IP_PROFILE_GROUPS) {
    for (const field of group.fields) parts.push(asText(profile[group.key]?.[field.key]));
  }
  parts.push(profile.interview.rawNotes);
  parts.push(
    asText(customer.ipPositioning),
    asText(customer.contentNeeds),
    asText(customer.notes),
  );

  const report = objectOrEmpty(benchmarkReport);
  parts.push(report.account?.name, report.account?.signature);
  const pushGraded = value => {
    const source = objectOrEmpty(value);
    parts.push(asText(source.text), ...(Array.isArray(source.basis) ? source.basis : []));
  };
  pushGraded(report.businessPositioning?.persona);
  pushGraded(report.businessPositioning?.corePain);
  parts.push(report.businessPositioning?.summary);
  parts.push(report.contentPositioning?.core);
  for (const item of Array.isArray(report.userProfile?.demographics) ? report.userProfile.demographics : []) {
    parts.push(asText(item?.text), ...(Array.isArray(item?.basis) ? item.basis : []));
  }
  pushGraded(report.userProfile?.pains);
  pushGraded(report.userProfile?.goals);
  for (const category of classification.categories) {
    parts.push(category.name, category.coreFunction, ...category.keywords);
    for (const sub of category.subcategories) {
      parts.push(sub.name, sub.description, ...sub.topics.map(topic => topic.title));
    }
  }
  for (const tag of Array.isArray(report.frequentTags) ? report.frequentTags : []) parts.push(asText(tag?.tag));
  pushGraded(report.operationStrategy?.trafficScripts?.bio);
  pushGraded(report.operationStrategy?.trafficScripts?.comments);
  for (const product of Array.isArray(report.operationStrategy?.monetization?.products) ? report.operationStrategy.monetization.products : []) {
    parts.push(asText(product?.tier), asText(product?.product), asText(product?.price), asText(product?.positioning), asText(product?.role));
  }
  for (const step of Array.isArray(report.operationStrategy?.monetization?.path) ? report.operationStrategy.monetization.path : []) {
    parts.push(asText(step?.description));
  }
  // 第二批新接进输入的两块（三秒 / 结尾分析）与发布节奏：模型的理由引用它们时，
  // 引文必须同样能在这里核对上，否则「引用了 1.2 的结论」就成了一句空话。
  const pushHookBlock = block => {
    const source = objectOrEmpty(block);
    parts.push(asText(source.analysisReason));
    for (const angle of Array.isArray(source.reasonAngles) ? source.reasonAngles : []) parts.push(asText(angle?.text));
    for (const item of Array.isArray(source.topTypes) ? source.topTypes : []) parts.push(asText(item?.reason));
    for (const item of Array.isArray(source.items) ? source.items : []) {
      parts.push(asText(item?.title), asText(item?.openingText), asText(item?.endingText), asText(item?.evidence));
    }
  };
  pushHookBlock(report.contentPositioning?.threeSeconds);
  pushHookBlock(report.contentPositioning?.endingHooks);
  const publishing = objectOrEmpty(report.operationStrategy?.publishing);
  parts.push(asText(publishing.note), asText(publishing.analysis));
  for (const item of Array.isArray(publishing.weekdayDistribution) ? publishing.weekdayDistribution : []) {
    parts.push(asText(item?.weekday));
  }
  return joinEvidenceParts(parts);
};

const normalizeItems = (value, limit = 20) => (Array.isArray(value) ? value.slice(0, limit) : []);

/**
 * 拆客户档案里登记的 `benchmarkAccounts`（方法一(a) 的同赛道对标账号）。
 *
 * 实测这个字段是**项目经理手工粘贴进来的多行文本**：有的换行、有的逗号或分号，
 * 也有人直接空格隔开，偶尔还带着「1.」这种手工编号（`ipProfileStore.getCustomer` 还会把
 * 数组型的值用「、」连起来）。所以四种分隔符一起拆，顺带去掉列表编号、去重、丢掉空项。
 *
 * **只拆不改**：不是链接的项原样保留成 `title`（`url` 留空），既不补全也不猜域名 ——
 * 编一个链接比留空更糟，前端也只给真正像链接的项加跳转。
 */
const splitBenchmarkAccounts = value => {
  const seen = new Set();
  const items = [];
  for (const raw of asText(value).split(/[\s,，;；、|]+/)) {
    const text = raw.replace(/^(?:\d+[.、)）]|[-–—•·*])/, "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({ title: text, url: /^https?:\/\//i.test(text) ? text : "" });
  }
  return items;
};

/** 按标题去重（去标点后比较），并如实报出去掉了几条。 */
const dedupeByTitle = items => {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const item of items) {
    const key = stripForMatch(item.title);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return { items: unique, duplicates };
};

/** 选题条目：标题 + 角度/痛点 + 引文 + 分级。标题为空的一律丢弃（不编标题）。 */
const normalizeTopicEntries = (rawList, { haystack, levelCap, maxLength = 200, withPainPoint = false }) => normalizeItems(rawList, 40)
  .map(item => {
    const source = typeof item === "string" ? { title: item } : objectOrEmpty(item);
    const title = cleanText(source.title || source.text || source.question || source.name, maxLength);
    const angle = cleanText(source.angle || source.direction || source.reason, 160);
    const painPoint = withPainPoint ? cleanText(source.painPoint || source.pain || source.painPoints, 200) : "";
    const graded = gradeText(
      { text: title, basis: source.basis || source.evidence, level: source.level },
      { haystack, levelCap, maxLength },
    );
    return { title: graded.text, angle, painPoint, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
  })
  .filter(item => item.title);

/**
 * 四 的一组钩子（开头 3 秒 / 结尾钩子）。两组结构完全一样，只有权威类型清单不同。
 *
 * 两条硬约束（不变量④）：
 *   ① **类型只能来自后端权威清单**（8 种开头类型 / 5 种结尾类型）。归一化后仍认不出的
 *      （`normalizeXxxType` 落到 `review`）一律**丢弃**：留一条「类型：其它」在这里，
 *      用户的「4 种不同类型」就成了一句空话。
 *   ② **类型必须两两不同**：重复类型的后一条丢弃，绝不用同一个类型凑数。
 * 丢弃的分类计数一并带出去（未知类型 / 重复类型 / 空文案 / 超出 4 条），
 * 数量一律由后端按数组重算。
 */
const buildHookGroup = ({
  key,
  label,
  rawList,
  definitions,
  typeLabelOf,
  normalizeType,
  requiredCount,
  benchmarkTopTypes,
  benchmarkAvailable,
  haystack,
}) => {
  const known = new Set(definitions.map(item => item.type));
  const definitionOf = new Map(definitions.map(item => [item.type, item]));
  const seenTypes = new Set();
  const hooks = [];
  const discardedTypes = [];
  const discarded = { unknownType: 0, duplicateType: 0, emptyText: 0, overflow: 0 };

  for (const item of normalizeItems(rawList, 16)) {
    const source = typeof item === "string" ? { text: item } : objectOrEmpty(item);
    const rawType = asText(source.type || source.hookType || source.name);
    const type = normalizeType(rawType);
    // 类型缺省 / 认不出（含归一化落到 review 的）→ 丢弃并计数。
    if (!known.has(type)) {
      discarded.unknownType += 1;
      if (rawType) discardedTypes.push(rawType);
      continue;
    }
    if (seenTypes.has(type)) {
      discarded.duplicateType += 1;
      discardedTypes.push(rawType || typeLabelOf[type]);
      continue;
    }
    const text = cleanText(source.text || source.opening || source.openingText || source.ending || source.endingText || source.copy || source.content, 200);
    if (!text) {
      discarded.emptyText += 1;
      continue;
    }
    if (hooks.length >= requiredCount) {
      discarded.overflow += 1;
      continue;
    }
    seenTypes.add(type);
    const reason = cleanText(source.reason || source.why || source.rationale, 300);
    // 等级挂在「这一条建议」上：理由能对回客户档案 / 1.2 报告（引文可核对）时是输入证据，
    // 编不出依据的由 normalizeBasisField 降级 —— 与其它字段**同一套实现**，不另写一份。
    const graded = normalizeBasisField({
      raw: { text: reason || text, basis: source.basis || source.evidence, level: source.level },
      haystack,
      maxLength: 300,
    });
    const benchmarkUsed = benchmarkTopTypes.some(entry => entry.type === type);
    hooks.push({
      type,
      typeLabel: typeLabelOf[type],
      definition: asText(definitionOf.get(type)?.definition),
      example: asText(definitionOf.get(type)?.example),
      text,
      reason,
      basis: graded.basis,
      level: graded.level,
      levelLabel: graded.levelLabel,
      benchmarkUsed,
      typeNote: benchmarkUsed
        ? ""
        : "该类型不在 1.2 统计出的对标账号常用类型里，属于补充类型（补充原因见本条理由）。",
    });
  }

  const discardedCount = discarded.unknownType + discarded.duplicateType + discarded.emptyText + discarded.overflow;
  const benchmarkMatchedCount = hooks.filter(hook => hook.benchmarkUsed).length;
  const discardParts = [
    discarded.unknownType ? `类型不在权威清单内 ${discarded.unknownType} 条` : "",
    discarded.duplicateType ? `类型重复 ${discarded.duplicateType} 条` : "",
    discarded.emptyText ? `没有文案 ${discarded.emptyText} 条` : "",
    discarded.overflow ? `超出 ${requiredCount} 条上限 ${discarded.overflow} 条` : "",
  ].filter(Boolean);
  const typeNote = !benchmarkAvailable
    ? `1.2 报告里没有「${label}」的统计（旧报告缺这一批字段），本次 ${hooks.length} 种类型按通用口径给出，需人工核对。`
    : benchmarkTopTypes.length === 0
      ? `1.2 报告里这一块没有统计出可用的类型（有效样本为 0），本次 ${hooks.length} 种类型按通用口径给出，需人工核对。`
      : `对标账号最常用的${label}类型是：${benchmarkTopTypes.map(item => item.typeLabel).join("、")}；本次 ${hooks.length} 条里 ${benchmarkMatchedCount} 条命中这些类型，其余 ${hooks.length - benchmarkMatchedCount} 条为补充类型。`;

  return {
    key,
    label,
    requiredCount,
    count: hooks.length,
    hooks,
    // 权威类型全清单随报告一起给：前端展示「可选的类型有哪些」，提示词也从同一份常量生成。
    types: definitions.map(item => ({
      type: item.type,
      label: typeLabelOf[item.type],
      definition: item.definition,
      example: item.example,
      strength: item.strength,
    })),
    benchmarkAvailable,
    benchmarkTopTypes,
    benchmarkMatchedCount,
    discardedCount,
    discarded,
    discardedTypes: discardedTypes.slice(0, 8),
    discardedNote: discardParts.length > 0
      ? `${HOOK_DISCARD_NOTE}本次丢弃：${discardParts.join("、")}。`
      : HOOK_DISCARD_NOTE,
    typeNote,
    note: hooks.length === requiredCount
      ? ""
      : `规格要求 ${requiredCount} 种不同类型的${label}，本次产出 ${hooks.length} 种；不自动补齐，差额待人工补充。`,
  };
};

/**
 * 六 的内容配比：模型只给「大类 + 比重意图 + 理由」，**百分比由后端重算**。
 *
 * 三条规则（不变量⑤）：
 *   ① 大类只能来自 1.2 报告 `classification.categories`，对不上的**丢弃并计数**（不许发明大类）；
 *   ② 每个时期合计**恰好 100**（最大余额法，`apportionRatios` 与 2.2/2.3 同一份实现）；
 *   ③ 模型一个意图都没给的时期**不填默认配比**，整段落 manual 待人工补充 ——
 *      用「常规」把 100% 铺满就是编数字。
 * 模型漏给某一个大类的意图时，它按「常规」参与分配，但那一行会如实标注「需人工确认」。
 */
const buildContentMix = ({ rawMix, categories, haystack }) => {
  const rawPeriods = Array.isArray(rawMix?.periods) ? rawMix.periods : [];
  const categoryNames = categories.map(category => category.name).filter(Boolean);
  const defaultIntent = CONTENT_MIX_INTENTS.find(item => item.key === CONTENT_MIX_DEFAULT_INTENT) || CONTENT_MIX_INTENTS[0];
  let unmatchedTotal = 0;

  const periods = CONTENT_MIX_PERIODS.map(definition => {
    const rawPeriod = rawPeriods.find(item => {
      const source = objectOrEmpty(item);
      const candidate = asText(source.key || source.period || source.label);
      return candidate === definition.key || candidate === definition.label;
    });
    const rawItems = Array.isArray(rawPeriod?.categories)
      ? rawPeriod.categories
      : Array.isArray(rawPeriod?.items) ? rawPeriod.items : [];
    const matched = new Map();
    const discardedCategories = [];
    for (const item of rawItems) {
      const source = typeof item === "string" ? { category: item } : objectOrEmpty(item);
      const name = cleanText(source.category || source.name || source.type, 100);
      if (!name) continue;
      // 1.2 报告里没有的大类一律丢弃 —— 编一个「行业干货」出来，配比就没法核对了。
      if (!categoryNames.includes(name)) {
        discardedCategories.push(name);
        continue;
      }
      if (!matched.has(name)) matched.set(name, source);
    }
    unmatchedTotal += discardedCategories.length;

    if (matched.size === 0) {
      return {
        key: definition.key,
        label: definition.label,
        rows: [],
        total: 0,
        level: "manual",
        levelLabel: PROFILE_EVIDENCE_LEVELS.manual,
        discardedCount: discardedCategories.length,
        discardedCategories,
        discardedNote: discardedCategories.length > 0
          ? `模型给的 ${discardedCategories.length} 个分类不在 1.2 报告的内容大类里，已丢弃。`
          : "",
        note: categoryNames.length === 0
          ? "1.2 报告里没有可用的内容大类，内容配比无法生成，待人工补充。"
          : discardedCategories.length > 0
            // 模型给了，但给的分类 1.2 里一个都没有 —— 不能拿它凑配比。
            ? "Agent 给的分类都不在 1.2 报告的内容大类里（已丢弃并计数），这一时期的配比待人工补充。"
            : "Agent 没有给出这一时期的配比意图，配比待人工补充（不自动填默认值）。",
      };
    }

    const weighted = categoryNames.map(name => {
      const source = matched.get(name);
      const rawIntent = asText(source?.intent || source?.weight);
      const intentKey = asText(source?.key || rawIntent).toLowerCase();
      const intent = CONTENT_MIX_INTENTS.find(item => item.key === intentKey || item.label === rawIntent) || defaultIntent;
      const graded = normalizeBasisField({
        raw: { text: source?.reason || source?.note || source?.description, basis: source?.basis || source?.evidence, level: source?.level },
        haystack,
        maxLength: 300,
      });
      return {
        category: name,
        intent: intent.key,
        intentLabel: intent.label,
        weight: intent.weight,
        percentage: 0,
        reason: graded.text,
        basis: graded.basis,
        level: graded.level,
        levelLabel: graded.levelLabel,
        intentNote: !source
          ? "Agent 没有给出这一大类的配比意图，按「常规」参与分配，需人工确认。"
          : CONTENT_MIX_INTENTS.some(item => item.key === intentKey || item.label === rawIntent)
            ? ""
            : `Agent 给的比重意图「${rawIntent || "空"}」不在 ${CONTENT_MIX_INTENTS.map(item => item.label).join(" / ")} 内，按「常规」参与分配。`,
      };
    });
    // ⚠️ 模型自报的百分比一概不采信：这里用意图权重过一遍最大余额法，合计恰好 100。
    const shares = apportionRatios(weighted.map(row => ({ ratio: row.weight })));
    const rows = weighted.map((row, index) => ({ ...row, percentage: shares[index]?.ratio ?? 0 }));
    return {
      key: definition.key,
      label: definition.label,
      rows,
      total: rows.reduce((sum, row) => sum + row.percentage, 0),
      // 配比本身是后端按「比重意图」分配出来的建议，不是输入里的事实，所以整段最高 inference；
      // 每一行理由的等级单独标注（它可以凭引文升到输入证据）。
      level: "inference",
      levelLabel: PROFILE_EVIDENCE_LEVELS.inference,
      discardedCount: discardedCategories.length,
      discardedCategories,
      discardedNote: discardedCategories.length > 0
        ? `模型给的 ${discardedCategories.length} 个分类不在 1.2 报告的内容大类里，已丢弃。`
        : "",
      note: "",
    };
  });

  return {
    source: "大类来自 1.2 报告 contentPositioning.classification；比重意图与理由来自 Agent，占比由后端重算。",
    recomputeNote: CONTENT_MIX_NOTE,
    categories: categoryNames,
    categoryCount: categoryNames.length,
    periods,
    unmatchedCount: unmatchedTotal,
    unmatchedNote: unmatchedTotal > 0
      ? `模型给出的 ${unmatchedTotal} 个分类不在 1.2 报告的内容大类里，已丢弃并计数，未写入配比。`
      : "",
    note: categoryNames.length === 0
      ? "1.2 报告里没有可用的内容大类：内容配比整块待人工补充。"
      : "",
  };
};

export const normalizeAccountPlan = ({
  customer,
  benchmarkReport,
  agentOutput = {},
  analysisSource = "agent",
  warnings = [],
  // 这份 1.2 报告是「本次请求传进来的」还是「按 id 从库里读的」——报告里要如实写明。
  benchmarkSource = "",
} = {}) => {
  const customerSource = objectOrEmpty(customer);
  const profile = normalizeIpProfile(customerSource.ipProfile);
  const coverage = describeIpProfileCoverage(profile);
  const { id: benchmarkId, report: benchmark } = unwrapBenchmarkReport(benchmarkReport);
  const classification = buildClassificationPassthrough(benchmark);
  const haystack = buildEvidenceHaystack({ customer: { ...customerSource, ipProfile: profile }, benchmarkReport: benchmark, classification });

  // ── 证据上限：**客户方一手输入里有没有依据**（不变量②，2026-09-19 用户确认放宽）──────
  //
  // 旧实现只看 `ipProfile` 的 19 个字段：档案里那一项为空 ⇒ 该结论最多 inference，
  // 模型就算逐字引用了项目经理写在客户名册里的原话也不许当输入证据。
  //
  // 现在把名册补充说明（`ipPositioning` / `contentNeeds` / `notes`）也算成一手输入：
  // 它们和访谈原文一样是项目经理自己写下来的一手材料，引用其中的原话不是编造，
  // 所以**只要写了补充说明，上限就抬到 evidence**，由引文核对（`normalizeBasisField` 里
  // 「自称 evidence 却给不出可核对引文 → 降级 inference」）来把关。
  // ⚠️ 本次放宽的正是这三项（用户批准的也是它们）：`interview.rawNotes` 仍按旧口径只参与
  // 「引文能不能核对」，不单独抬高上限 —— 将来若要一起放宽，改下面这一个常量即可。
  //
  // 保留的那一半是这条上限真正要防的事：**别拿对标账号的东西冒充客户自己的事实**。
  // 客户记录里连一句补充说明都没有时（实测 1/5 的客户连名册都是空的），唯一能引的只剩 1.2 报告，
  // 而 1.2 报告讲的是那个**对标账号**——那时年龄 / 性别 / 收入这类结论仍然最多 inference。
  // ⚠️ `benchmarkAccounts` **不算一手说明**：它是一串对标账号链接，只用来填方法一(a)。
  const hasCustomerBrief = Boolean(
    asText(customerSource.ipPositioning) || asText(customerSource.contentNeeds) || asText(customerSource.notes),
  );

  /** 来源字段填了、或名册补充说明写了 ⇒ 上限 evidence；两者都没有 ⇒ 最多 inference。 */
  const capOf = (...paths) => (
    hasCustomerBrief || paths.some(path => readProfilePath(profile, path)) ? "evidence" : "inference"
  );

  const caps = {
    identity: capOf("identity.name", "identity.occupation", "identity.yearsExperience", "identity.keyCases"),
    product: capOf("product.businessModel", "product.productType", "product.coreAdvantages"),
    // 「行业赛道」的依据既可能是身份信息里的职业，也可能是产品信息 —— 两处都空才降级。
    industry: capOf("identity.occupation", "identity.keyCases", "product.businessModel", "product.productType", "product.coreAdvantages"),
    userProfile: capOf(...IP_PROFILE_GROUPS.find(group => group.key === "userProfile").fields.map(field => `userProfile.${field.key}`)),
    // 第四行「行动引导」的依据是 1.2 报告的引流话术，客户档案里没有对应字段。
    callToAction: hasCustomerBrief
      || asText(benchmark?.operationStrategy?.trafficScripts?.bio?.text)
      || asText(benchmark?.operationStrategy?.trafficScripts?.comments?.text)
      ? "evidence"
      : "inference",
  };

  /**
   * 简介每一行的证据上限。
   * 第一、二行讲的是「我是谁、我做成过什么」，依据只能是**身份信息**（或名册补充说明）；
   * 第三行讲产品与优势，看**产品信息**；第四行看 1.2 的引流话术。
   * 一行一判，别用一个上限套四行 —— 那会让「没有任何客户方输入」的客户也拿到 evidence 的头衔。
   */
  const bioRowCap = definition => {
    if (definition.key === "identity" || definition.key === "achievement") return caps.identity;
    if (definition.key === "advantage") return caps.product;
    return caps.callToAction;
  };

  const autoWarnings = [];
  const rawBusiness = objectOrEmpty(agentOutput?.businessPositioning);
  const rawPersona = objectOrEmpty(agentOutput?.personaPositioning);
  const rawSetup = objectOrEmpty(agentOutput?.accountSetup);
  const rawTopics = objectOrEmpty(agentOutput?.topicLibrary);
  // 第二批：四 / 五 / 六 的模型输出。**三个键都可能整块缺失**（旧报告的 agentOutput、
  // 或规则兜底的空壳），下面每一处都要能空着走完，不许在这里崩。
  const rawFramework = objectOrEmpty(agentOutput?.contentFramework);
  const rawProduction = objectOrEmpty(agentOutput?.production);
  const rawOperations = objectOrEmpty(agentOutput?.operations);
  const rawPlatform = objectOrEmpty(rawOperations.platformStrategy);
  // 四 要参考的 1.2 两块（3 秒分析 / 结尾钩子分析）。模型没给 1.2 报告时同样是「不可用」。
  const hookReference = {
    threeSeconds: describeHookReference({
      block: benchmark?.contentPositioning?.threeSeconds,
      definitions: GOLD_THREE_SECOND_DIMENSIONS,
      typeLabelOf: GOLD_THREE_SECOND_TYPE_LABELS,
      normalizeType: normalizeGoldThreeSecondType,
      label: "开头 3 秒分析",
    }),
    endingHooks: describeHookReference({
      block: benchmark?.contentPositioning?.endingHooks,
      definitions: ENDING_HOOK_TYPES,
      typeLabelOf: ENDING_HOOK_TYPE_LABELS,
      normalizeType: normalizeEndingHookType,
      label: "结尾钩子分析",
    }),
  };

  // ── 一、IP定位 · 1、商业定位 ────────────────────────────────────────────────
  const targetAudience = normalizeBasisField({
    raw: rawBusiness.targetAudience,
    haystack,
    levelCap: caps.userProfile,
    maxLength: 600,
  });

  const rawDimensionList = rawBusiness.audienceDimensions;
  const audienceDimensions = AUDIENCE_DIMENSIONS.map(dimension => {
    const raw = Array.isArray(rawDimensionList)
      ? rawDimensionList.find(item => asText(item?.key) === dimension.key || asText(item?.label) === dimension.label)
      : objectOrEmpty(rawDimensionList)[dimension.key];
    const profileValue = readProfilePath(profile, dimension.sourceKey);
    const graded = normalizeBasisField({
      raw,
      haystack,
      maxLength: 400,
      // 不变量②：档案这一项为空时，名册补充说明里写了也算有依据；两者都没有 ⇒ 最多 inference。
      levelCap: capOf(dimension.sourceKey),
    });
    return {
      key: dimension.key,
      label: dimension.label,
      // sourceKey / profileValue 仍然带着：前端要显示「档案里这一项填的是什么」，
      // 项目经理才能一眼看出这条结论该去哪儿核对。
      sourceKey: dimension.sourceKey,
      profileValue,
      ...graded,
      // 空档案的说明分两种：名册里写了补充说明的，可以引用它升成输入证据；连名册都空的就只能推断。
      note: profileValue
        ? ""
        : hasCustomerBrief
          ? `客户档案 ${dimension.sourceKey} 为空：这一项目前只能靠客户名册的补充说明支撑，标「输入证据」时必须引用其中的原话，并需人工向客户确认。`
          : `客户档案 ${dimension.sourceKey} 为空，客户名册里也没有补充说明：此处最多是推断，需人工向客户确认（不得当作输入证据）。`,
    };
  });

  const corePain = normalizeBasisField({ raw: rawBusiness.corePain, haystack, levelCap: caps.industry, maxLength: 600 });

  const contentDirections = normalizeItems(rawBusiness.contentDirections, 12)
    .map(item => {
      const source = typeof item === "string" ? { name: item } : objectOrEmpty(item);
      const name = cleanText(source.name || source.title || source.text, 60);
      const description = cleanText(source.description || source.detail, 400);
      const graded = gradeText(
        { text: name || description, basis: source.basis || source.evidence, level: source.level },
        { haystack, levelCap: caps.industry, maxLength: 500 },
      );
      return {
        name: name || graded.text,
        description,
        basis: graded.basis,
        level: graded.level,
        levelLabel: graded.levelLabel,
      };
    })
    .filter(item => item.name || item.description);

  const rawProducts = normalizeItems(rawBusiness.monetization?.products, 12);
  let clearedPriceCount = 0;
  const monetizationProducts = rawProducts
    .map(item => {
      const source = objectOrEmpty(item);
      const tier = cleanText(source.tier, 40);
      const product = cleanText(source.product, 160);
      const positioning = cleanText(source.positioning, 400);
      const role = cleanText(source.role, 400);
      const price = normalizePrice(source.price, haystack);
      if (asText(source.price) && !price.price) clearedPriceCount += 1;
      const graded = normalizeBasisField({
        raw: source,
        haystack,
        fallbackText: [product, positioning, role].filter(Boolean).join(" "),
        maxLength: 600,
        // 定价没有输入依据时不许标 evidence —— 价格另由 normalizePrice 校验。
        levelCap: price.grounded ? "evidence" : "inference",
      });
      // 价格能在输入里核对上时，这一行整体算「输入证据」；否则最多是推断。
      const level = price.grounded ? "evidence" : graded.level;
      return {
        tier,
        product,
        price: price.price,
        priceNote: price.price ? "" : "输入中没有定价依据，待人工补充",
        positioning,
        role,
        level,
        levelLabel: PROFILE_EVIDENCE_LEVELS[level],
        basis: graded.basis,
      };
    })
    .filter(item => item.product || item.positioning || item.role);

  const monetizationPath = normalizeItems(rawBusiness.monetization?.path, 10)
    .map((item, index) => {
      const source = objectOrEmpty(item);
      const description = cleanText(source.description || source.text, 400);
      if (!description) return null;
      const pattern = checkMonetizationStep(description);
      const graded = gradeText(
        { text: description, basis: source.basis || source.evidence, level: source.level },
        { haystack, levelCap: caps.product, maxLength: 500 },
      );
      return {
        step: asCount(source.step) || index + 1,
        description,
        patternOk: pattern.ok,
        patternNote: pattern.note,
        level: graded.level,
        levelLabel: graded.levelLabel,
        basis: graded.basis,
      };
    })
    .filter(Boolean);

  if (clearedPriceCount > 0) {
    autoWarnings.push({
      code: "PRICE_NOT_GROUNDED",
      error: `Agent 给出的 ${clearedPriceCount} 条定价在输入（客户档案价格区间 / 访谈原文 / 1.2 报告）里找不到依据，已清空，待人工补充。`,
    });
  }
  if (monetizationPath.some(step => !step.patternOk)) {
    autoWarnings.push({
      code: "MONETIZATION_PATH_PATTERN",
      error: `变现路径有 ${monetizationPath.filter(step => !step.patternOk).length} 步未按标准句式「${MONETIZATION_STEP_TEMPLATE}」书写，已保留原文并标记待人工改写。`,
    });
  }

  const businessPositioning = {
    targetAudience,
    audienceDimensions,
    corePain,
    contentDirections,
    monetization: {
      products: monetizationProducts,
      path: monetizationPath,
      note: cleanText(rawBusiness.monetization?.note, 600),
      tierGuide: PRODUCT_TIERS,
    },
    summary: cleanText(rawBusiness.summary, 800),
  };

  // ── 一、IP定位 · 2、内容定位（直接使用 1.2 报告）────────────────────────────
  const contentPositioning = {
    core: normalizeBasisField({
      raw: objectOrEmpty(agentOutput?.contentPositioning).core,
      haystack,
      levelCap: hasCustomerBrief || classification.categoryCount > 0 ? "evidence" : "inference",
      maxLength: 800,
    }),
    // 选题库建立：透传，不重跑分类。
    classification,
    // 高频标签同样是 1.2 已经按发布文案统计好的，原样透传（方法一(b) 要用）。
    frequentTags: (Array.isArray(benchmark?.frequentTags) ? benchmark.frequentTags : []).map(item => ({
      tag: asText(item?.tag),
      count: asCount(item?.count),
      percentage: Number(item?.percentage) || 0,
    })).filter(item => item.tag),
    frequentTagsNote: "高频标签来自 1.2 报告（已按发布文案 + 后端统计），这里原样透传，不重算。",
    summary: cleanText(objectOrEmpty(agentOutput?.contentPositioning).summary, 800),
  };

  // ── 一、IP定位 · 3、人设定位 ───────────────────────────────────────────────
  const role = normalizeBasisField({ raw: rawPersona.role, haystack, levelCap: caps.identity, maxLength: 400 });

  const rawKeywords = Array.isArray(rawPersona.personality?.keywords)
    ? rawPersona.personality.keywords
    : Array.isArray(rawPersona.personality) ? rawPersona.personality : [];
  const personalityKeywords = normalizeItems(rawKeywords, 8)
    .map(item => {
      const source = typeof item === "string" ? { keyword: item } : objectOrEmpty(item);
      const keyword = cleanText(source.keyword || source.name || source.text, 30);
      const expression = cleanText(source.expression || source.reason || source.description, 300);
      if (!keyword) return null;
      const graded = gradeText(
        { text: expression || keyword, basis: source.basis || source.evidence, level: source.level },
        { haystack, levelCap: caps.identity, maxLength: 300 },
      );
      return { keyword, expression, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
    })
    .filter(Boolean);

  if (personalityKeywords.length !== PERSONALITY_KEYWORD_COUNT) {
    autoWarnings.push({
      code: "PERSONALITY_KEYWORD_COUNT",
      error: `规格要求 ${PERSONALITY_KEYWORD_COUNT} 个核心性格关键词，本次产出 ${personalityKeywords.length} 个；不自动补齐，差额待人工补充。`,
    });
  }

  const rawAnchors = objectOrEmpty(rawPersona.memoryAnchors);
  const memoryAnchors = MEMORY_ANCHOR_TYPES.map(type => {
    const rawItems = Array.isArray(rawAnchors[type.key])
      ? rawAnchors[type.key]
      : Array.isArray(rawAnchors[type.label]) ? rawAnchors[type.label] : [];
    const items = normalizeItems(rawItems, 5)
      .map(item => {
        const source = typeof item === "string" ? { text: item } : objectOrEmpty(item);
        const text = cleanText(source.text || source.suggestion || source.content, 300);
        const graded = gradeText(
          { text, basis: source.basis || source.evidence, level: source.level },
          { haystack, levelCap: caps.identity, maxLength: 300 },
        );
        return { text: graded.text, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
      })
      .filter(item => item.text);
    return {
      key: type.key,
      label: type.label,
      dimension: type.dimension,
      fits: type.fits,
      // 语言锚点带上规格给的建议句式，前端直接展示。
      ...(type.key === "language" ? { template: LANGUAGE_ANCHOR_TEMPLATE } : {}),
      items,
      count: items.length,
      note: items.length > 0 ? "" : "本类锚点暂无内容，待人工补充。",
    };
  });

  const personaPositioning = {
    role,
    personality: {
      expectedCount: PERSONALITY_KEYWORD_COUNT,
      count: personalityKeywords.length,
      keywords: personalityKeywords,
      note: personalityKeywords.length === PERSONALITY_KEYWORD_COUNT
        ? ""
        : `规格要求 ${PERSONALITY_KEYWORD_COUNT} 个，当前 ${personalityKeywords.length} 个，差额待人工补充（不自动补齐）。`,
    },
    memoryAnchors,
    summary: cleanText(rawPersona.summary, 800),
  };

  // ── 二、账号搭建 · 1、账号三件套 ───────────────────────────────────────────
  const rawTrio = objectOrEmpty(rawSetup.trio);
  const trio = ACCOUNT_TRIO.map(definition => {
    const graded = normalizeBasisField({
      raw: rawTrio[definition.key],
      haystack,
      levelCap: caps.identity,
      maxLength: 600,
    });
    return { key: definition.key, label: definition.label, rule: definition.rule, ...graded };
  });

  // ── 二、账号搭建 · 2、账号简介（视频号 / 抖音，四行结构）────────────────────
  const rawBio = objectOrEmpty(rawSetup.bio);
  const bioPlatforms = BIO_PLATFORMS.map(platform => {
    const rawRows = Array.isArray(rawBio[platform.key])
      ? rawBio[platform.key]
      : Array.isArray(rawBio[platform.label]) ? rawBio[platform.label] : [];
    const rows = BIO_ROWS.map(definition => {
      const rawRow = rawRows.find(item => Number(item?.row) === definition.row
        || asText(item?.key) === definition.key
        || asText(item?.label) === definition.label);
      const rawCandidates = Array.isArray(rawRow?.candidates)
        ? rawRow.candidates
        : Array.isArray(rawRow?.items) ? rawRow.items : [];
      const candidates = normalizeItems(rawCandidates, BIO_CANDIDATES_PER_ROW)
        .map(candidate => {
          const source = typeof candidate === "string" ? { text: candidate } : objectOrEmpty(candidate);
          const text = cleanText(source.text || source.content, 300);
          const graded = gradeText(
            { text, basis: source.basis || source.evidence, level: source.level },
            { haystack, levelCap: bioRowCap(definition), maxLength: 300 },
          );
          return { text: graded.text, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
        })
        .filter(item => item.text);
      return {
        row: definition.row,
        key: definition.key,
        label: definition.label,
        rule: definition.rule,
        priority: definition.priority,
        candidates,
        candidateCount: candidates.length,
        note: candidates.length > 0 ? "" : "本行暂无候选，待人工补充。",
      };
    });
    return {
      key: platform.key,
      label: platform.label,
      rows,
      candidateCount: rows.reduce((sum, row) => sum + row.candidateCount, 0),
    };
  });

  const accountSetup = {
    trio,
    // 客户照片不在 1.3 的输入里：客户档案与 1.2 报告都没有照片字段。
    photoNote: "输入中没有客户照片（客户档案与 1.2 报告都不含照片），头像只能给拍摄/着装建议，具体改图待人工提供照片后补充。",
    bio: {
      platforms: bioPlatforms,
      structureNote: `严格按四行结构输出：${BIO_ROWS.map(row => `第${row.row}行 ${row.label}`).join(" → ")}；每行给出多个候选供项目经理挑选。`,
    },
    summary: cleanText(rawSetup.summary, 800),
  };

  // ── 三、视频选题库 ─────────────────────────────────────────────────────────
  // 方法一(a)：同赛道对标账号。**输入里其实有这个数据** —— 客户档案
  // （`customers.benchmarkAccounts`）登记的就是同赛道对标账号，实测 5 个客户里有 3 个填了。
  // 它是客户方一手输入，所以按证据分级应当标 evidence（basis 就是那段原文）。
  // 没有登记时仍然是人工补充位；**模型自己提议的账号一律丢弃** —— 它给不出可核对的来源，
  // 采纳就等于把编造的账号名和链接写进交付物（丢了几条由 `discardedCount` 如实带出）。
  const rawAccounts = normalizeItems(rawTopics.sameTrackAccounts || rawTopics.benchmarkAccounts, 20);
  const registeredAccounts = splitBenchmarkAccounts(customerSource.benchmarkAccounts);
  const sameTrackAccounts = registeredAccounts.length > 0
    ? {
      items: registeredAccounts,
      count: registeredAccounts.length,
      discardedCount: rawAccounts.length,
      level: "evidence",
      levelLabel: PROFILE_EVIDENCE_LEVELS.evidence,
      // 引文就是名册里那段原文 —— 项目经理可以照着回查是哪几个账号。
      basis: [cleanText(customerSource.benchmarkAccounts, 600)],
      note: "来自客户档案登记的对标账号，可按需补充其他同赛道账号。",
    }
    : {
      items: [],
      count: 0,
      discardedCount: rawAccounts.length,
      level: "manual",
      levelLabel: PROFILE_EVIDENCE_LEVELS.manual,
      basis: [],
      note: rawAccounts.length > 0
        ? `客户名册里没有登记对标账号（本步骤也不抓取账号），Agent 本次给出的 ${rawAccounts.length} 条建议无法核对、已全部丢弃；此项为人工补充项。`
        : "客户名册里没有登记对标账号（本步骤也不抓取账号），此项为人工补充项。",
    };

  // 方法一(b)：参考 1.2 报告的小类选题 + 高频标签。
  const benchmarkTopicResult = dedupeByTitle(normalizeTopicEntries(rawTopics.benchmarkTopics, {
    haystack,
    levelCap: "evidence",
  }));

  // 方法二：客户提问整理 —— 用目标用户的真实口吻提问。
  const questionResult = dedupeByTitle(normalizeTopicEntries(rawTopics.questions, {
    haystack,
    levelCap: "evidence",
    withPainPoint: true,
  }));

  // 方法三：蹭热点 —— **整体上限 inference**，并带时效性提示。
  const rawTrends = normalizeItems(rawTopics.trends, 24);
  const trendEntry = (item, fallbackCategory) => {
    const source = objectOrEmpty(item);
    const topic = cleanText(source.topic || source.name || source.title, 120);
    const titles = (Array.isArray(source.titles) ? source.titles : Array.isArray(source.examples) ? source.examples : [])
      .map(title => cleanText(title, 200))
      .filter(Boolean)
      .slice(0, 5);
    const graded = gradeText(
      { text: topic, basis: source.basis || source.evidence, level: source.level },
      // ⚠️ 热点是模型知识推断、无法联网核实：**上限 inference**，模型自称 evidence 也不认。
      { haystack, levelCap: "inference", maxLength: 300 },
    );
    return {
      topic: graded.text,
      titles,
      titleCount: titles.length,
      basis: graded.basis,
      level: graded.level,
      levelLabel: graded.levelLabel,
      timelinessNote: HOT_TOPIC_DISCLAIMER,
      category: fallbackCategory,
    };
  };
  const matchedTrendIndexes = new Set();
  const trendGroups = HOT_TOPIC_CATEGORIES.map(definition => {
    const items = rawTrends
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const label = asText(item?.category || item?.type || item?.label);
        return label === definition.label || label === definition.key;
      })
      .map(({ item, index }) => {
        matchedTrendIndexes.add(index);
        return trendEntry(item, definition.key);
      })
      .filter(item => item.topic);
    return {
      key: definition.key,
      label: definition.label,
      items,
      count: items.length,
      note: items.length > 0 ? "" : "本组暂无内容，待人工补充。",
    };
  });
  // 模型返回了规格外的分类：**如实带出来并标注**，不要静默丢掉。
  const unmappedTrends = rawTrends
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !matchedTrendIndexes.has(index))
    .map(({ item }) => trendEntry(item, "unmapped"))
    .filter(item => item.topic);
  if (unmappedTrends.length > 0) {
    trendGroups.push({
      key: "unmapped",
      label: "规格外分类",
      items: unmappedTrends,
      count: unmappedTrends.length,
      note: "模型返回的分类不在「时事热点 / 政策热点 / 时间节点」三类内，原样保留待人工归类。",
    });
  }
  const trendTitleCount = trendGroups.reduce((sum, group) => sum + group.items.reduce((inner, item) => inner + item.titleCount, 0), 0);

  const methods = [
    {
      key: TOPIC_METHODS[0].key,
      label: TOPIC_METHODS[0].label,
      sameTrackAccounts,
      topics: benchmarkTopicResult.items,
      topicCount: benchmarkTopicResult.items.length,
      duplicateCount: benchmarkTopicResult.duplicates,
      note: sameTrackAccounts.level === "manual"
        ? "同赛道对标账号为人工补充项；选题参考 1.2 报告的小类选题与高频标签生成。"
        : `同赛道对标账号取自客户档案登记（${sameTrackAccounts.count} 个，可按需补充）；选题参考 1.2 报告的小类选题与高频标签生成。`,
    },
    {
      key: TOPIC_METHODS[1].key,
      label: TOPIC_METHODS[1].label,
      topics: questionResult.items,
      topicCount: questionResult.items.length,
      duplicateCount: questionResult.duplicates,
      note: "用目标用户的真实口吻提问（例：「现在人民币贬值，我该换美元吗？」），不要写成标题党。",
    },
    {
      key: TOPIC_METHODS[2].key,
      label: TOPIC_METHODS[2].label,
      groups: trendGroups,
      topicCount: trendTitleCount,
      titleCount: trendTitleCount,
      disclaimer: HOT_TOPIC_DISCLAIMER,
      note: "分时事热点 / 政策热点 / 时间节点三类，每类给出话题 + 至少一条标题示例。",
    },
  ];

  const topicLibrary = {
    methods,
    // 条数一律后端重算：模型自报的数量一概不采信（§6.3⑬）。
    topicTotal: methods.reduce((sum, method) => sum + method.topicCount, 0),
    classificationTopicTotal: classification.topicTotal,
    classificationTopicNote: "「选题库建立」的正式产出是 1.2 报告的分类选题库（见 ipPositioning.contentPositioning.classification），这里只是透传，不重跑分类。",
    summary: cleanText(rawTopics.summary, 800),
  };

  // ── 四、短视频内容框架 ─────────────────────────────────────────────────────
  // 开头 3 秒钩子参考 1.2 的「3 秒分析」，结尾钩子参考「结尾钩子分析」，
  // 两组都结合本客户的 IP 定位与内容定位生成；类型只能来自权威清单（见 buildHookGroup）。
  const openingHooks = buildHookGroup({
    key: "opening",
    label: "开头 3 秒钩子",
    rawList: rawFramework.openingHooks || rawFramework.opening,
    definitions: GOLD_THREE_SECOND_DIMENSIONS,
    typeLabelOf: GOLD_THREE_SECOND_TYPE_LABELS,
    normalizeType: normalizeGoldThreeSecondType,
    requiredCount: OPENING_HOOK_COUNT,
    benchmarkTopTypes: hookReference.threeSeconds.topTypes,
    benchmarkAvailable: hookReference.threeSeconds.available,
    haystack,
  });
  const endingHooks = buildHookGroup({
    key: "ending",
    // 规格在结尾钩子那一条里也写成了「3 秒钩子」，那是笔误 —— 这里是**结尾**钩子。
    label: "结尾钩子",
    rawList: rawFramework.endingHooks || rawFramework.ending,
    definitions: ENDING_HOOK_TYPES,
    typeLabelOf: ENDING_HOOK_TYPE_LABELS,
    normalizeType: normalizeEndingHookType,
    requiredCount: ENDING_HOOK_COUNT,
    benchmarkTopTypes: hookReference.endingHooks.topTypes,
    benchmarkAvailable: hookReference.endingHooks.available,
    haystack,
  });

  const contentFramework = {
    note: HOOK_SECTION_NOTE,
    openingHooks,
    endingHooks,
    // 1.2 的两块参照也随报告带出去：读的人才能核对「类型是不是照着对标账号选的」。
    benchmarkReference: {
      threeSeconds: {
        available: hookReference.threeSeconds.available,
        itemCount: hookReference.threeSeconds.itemCount,
        topTypes: hookReference.threeSeconds.topTypes,
        typeDistribution: hookReference.threeSeconds.typeDistribution,
        analysisReason: hookReference.threeSeconds.analysisReason,
        note: hookReference.threeSeconds.note,
      },
      endingHooks: {
        available: hookReference.endingHooks.available,
        itemCount: hookReference.endingHooks.itemCount,
        topTypes: hookReference.endingHooks.topTypes,
        typeDistribution: hookReference.endingHooks.typeDistribution,
        analysisReason: hookReference.endingHooks.analysisReason,
        note: hookReference.endingHooks.note,
      },
      note: "以上是 1.2 报告里对标账号的开头 / 结尾分析，原样带出供核对；它讲的是那个对标账号，不是本客户。",
    },
    summary: cleanText(rawFramework.summary, 800),
  };

  // ── 五、拍摄与剪辑建议 ─────────────────────────────────────────────────────
  // ⚠️ 本节没有输入数据：1.2 报告与客户档案都不含拍摄 / 剪辑信息，
  // 所以 9 项一律**上限 inference**（模型自称 evidence 也不认），并带「是建议不是观测」的说明。
  const buildProductionGroup = (definitions, rawGroup, groupLabel, groupKey) => {
    const source = objectOrEmpty(rawGroup);
    const items = definitions.map(definition => {
      // 键名或中文标签都认（模型偶尔用中文标签当键）。
      const graded = normalizeBasisField({
        raw: source[definition.key] ?? source[definition.label],
        haystack,
        levelCap: "inference",
        maxLength: 600,
      });
      return { key: definition.key, label: definition.label, rule: definition.rule, ...graded };
    });
    const filledCount = items.filter(item => item.text).length;
    const missingCount = definitions.length - filledCount;
    return {
      key: groupKey,
      label: groupLabel,
      requiredCount: definitions.length,
      count: filledCount,
      items,
      levelCap: "inference",
      // 缺哪几项要如实报出来（不自动补一套通用话术把版面填满）。
      note: missingCount === 0
        ? ""
        : filledCount === 0
          ? `${groupLabel}暂无内容，待人工补充（不自动补一套通用话术）。`
          : `规格要求 ${definitions.length} 项，本次 ${filledCount} 项有内容，差额 ${missingCount} 项待人工补充（不自动补齐）：${items.filter(item => !item.text).map(item => item.label).join("、")}。`,
    };
  };

  const production = {
    note: PRODUCTION_ADVICE_NOTE,
    levelCapNote: PRODUCTION_LEVEL_CAP_NOTE,
    shooting: buildProductionGroup(PRODUCTION_SHOOTING_ITEMS, rawProduction.shooting, "拍摄风格", "shooting"),
    editing: buildProductionGroup(PRODUCTION_EDITING_ITEMS, rawProduction.editing, "剪辑风格", "editing"),
    summary: cleanText(rawProduction.summary, 800),
  };

  // ── 六、起号与运营 ─────────────────────────────────────────────────────────
  // 1、平台与矩阵策略：平台建议由模型给（引文可核对时可标 evidence）；
  //    与 1.2 operationStrategy 对应的字段（发布节奏、引流话术）**沿用它们自己的等级**。
  const benchmarkPublishing = objectOrEmpty(benchmark?.operationStrategy?.publishing);
  const benchmarkPublishingLevel = ["evidence", "inference", "manual"].includes(asText(benchmarkPublishing.level))
    ? asText(benchmarkPublishing.level)
    : (asCount(benchmarkPublishing.datedCount) > 0 ? "evidence" : "manual");
  const publishingAvailable = Boolean(asCount(benchmarkPublishing.videoCount) || asCount(benchmarkPublishing.datedCount) || asText(benchmarkPublishing.analysis));
  const platformPublishBenchmark = {
    available: publishingAvailable,
    videoCount: asCount(benchmarkPublishing.videoCount),
    datedCount: asCount(benchmarkPublishing.datedCount),
    spanDays: asCount(benchmarkPublishing.spanDays),
    perWeek: Number(benchmarkPublishing.perWeek) || 0,
    weekdayDistribution: (Array.isArray(benchmarkPublishing.weekdayDistribution) ? benchmarkPublishing.weekdayDistribution : [])
      .map(item => ({ weekday: asText(item?.weekday), count: asCount(item?.count) }))
      .filter(item => item.weekday),
    hasTimeOfDay: Boolean(benchmarkPublishing.hasTimeOfDay),
    note: cleanText(benchmarkPublishing.note, 400),
    analysis: cleanText(benchmarkPublishing.analysis, 800),
    // ⚠️ 等级**照抄 1.2 自己的判定**，不在这里升级或降级（不变量⑥）。
    level: benchmarkPublishingLevel,
    levelLabel: PROFILE_EVIDENCE_LEVELS[benchmarkPublishingLevel],
    sourceNote: "以上来自 1.2 报告 operationStrategy.publishing（由后端从真实发布日期实算），证据等级沿用 1.2 报告自己的判定。",
    missingNote: publishingAvailable ? "" : "1.2 报告里没有发布节奏数据（旧报告缺这一项，或样本没有可解析的发布日期）：发布时间与频率只能给通用建议，需人工补充实测数据。",
  };

  const rawPublish = objectOrEmpty(rawPlatform.publish);
  const publishWindow = normalizeBasisField({
    raw: rawPublish.window || rawPlatform.publishWindow,
    haystack,
    maxLength: 400,
  });
  const publishFrequency = normalizeBasisField({
    raw: rawPublish.frequency || rawPlatform.publishFrequency,
    haystack,
    maxLength: 400,
  });

  const benchmarkTrafficScripts = {
    bio: passthroughGraded(benchmark?.operationStrategy?.trafficScripts?.bio),
    comments: passthroughGraded(benchmark?.operationStrategy?.trafficScripts?.comments),
    note: "以上两条来自 1.2 报告 operationStrategy.trafficScripts，证据等级沿用 1.2 报告自己的判定。",
  };

  const rawTrafficScripts = rawPlatform.trafficScripts;
  const trafficScripts = TRAFFIC_SCRIPT_TYPES.map(definition => {
    const raw = Array.isArray(rawTrafficScripts)
      ? rawTrafficScripts.find(item => asText(item?.key || item?.type || item?.label) === definition.key || asText(item?.label) === definition.label)
      : objectOrEmpty(rawTrafficScripts)[definition.key];
    const source = objectOrEmpty(raw);
    const scripts = normalizeItems(source.scripts || source.lines || source.items, 6)
      .map(item => {
        const entry = typeof item === "string" ? { text: item } : objectOrEmpty(item);
        const text = cleanText(entry.text || entry.script || entry.content, 200);
        const graded = gradeText(
          { text, basis: entry.basis || entry.evidence, level: entry.level },
          { haystack, maxLength: 200 },
        );
        return { text: graded.text, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
      })
      .filter(item => item.text);
    return {
      key: definition.key,
      label: definition.label,
      rule: definition.rule,
      purpose: cleanText(source.purpose || source.goal, 300),
      direction: cleanText(source.direction || source.leadTo || source.target, 300),
      scripts,
      scriptCount: scripts.length,
      note: scripts.length > 0 ? "" : "这一类暂无可直接使用的话术，待人工补充。",
    };
  });

  const platformStrategy = {
    primary: normalizeBasisField({ raw: rawPlatform.primary, haystack, maxLength: 400 }),
    secondary: normalizeBasisField({ raw: rawPlatform.secondary, haystack, maxLength: 400 }),
    matchAnalysis: normalizeBasisField({ raw: rawPlatform.matchAnalysis || rawPlatform.match, haystack, maxLength: 800 }),
    publish: {
      window: publishWindow,
      frequency: publishFrequency,
      rhythmNote: cleanText(rawPublish.rhythmNote || rawPublish.note, 400),
      benchmark: platformPublishBenchmark,
    },
    trafficScripts: {
      types: trafficScripts,
      benchmark: benchmarkTrafficScripts,
    },
    note: "主阵地 / 辅阵地的匹配分析由 Agent 给出（引文可核对时是输入证据）；发布节奏与引流话术参照 1.2 报告，那一部分沿用 1.2 自己的等级。",
  };

  // 2、起号策略 / 3、数据复盘：**固定模板文本**，模型改不了也加不了（不变量③）。
  const launchPlan = {
    key: "launchPlan",
    label: "起号策略",
    template: true,
    source: TEMPLATE_SOURCE_NOTE,
    note: LAUNCH_TEMPLATE_NOTE,
    steps: LAUNCH_STEPS.map(item => ({ ...item })),
    stepCount: LAUNCH_STEPS.length,
  };
  const reviewPlan = {
    key: "reviewPlan",
    label: "数据复盘重点",
    template: true,
    source: TEMPLATE_SOURCE_NOTE,
    note: REVIEW_TEMPLATE_NOTE,
    dimensions: REVIEW_DIMENSIONS.map(item => ({ ...item })),
    dimensionCount: REVIEW_DIMENSIONS.length,
  };

  // 4、内容配比：模型只给大类 + 比重意图 + 理由，百分比由后端按最大余额法重算。
  const contentMix = buildContentMix({ rawMix: rawOperations.contentMix, categories: classification.categories, haystack });

  const operations = {
    note: OPERATIONS_SECTION_NOTE,
    platformStrategy,
    launchPlan,
    reviewPlan,
    contentMix,
    summary: cleanText(rawOperations.summary, 800),
  };

  // ── 覆盖率 / 缺失输入 ─────────────────────────────────────────────────────
  const missingInputs = [];
  const pushMissing = (key, label, note) => {
    if (missingInputs.some(item => item.key === key)) return;
    missingInputs.push({ key, label, note });
  };

  if (!coverage.hasAnyValue) {
    pushMissing("ipProfile", "IP 访谈档案", "该客户没有 ipProfile（实测 5 个客户里只有 1 个有档案），IP 定位只能基于 1.2 报告或名册补充说明推断，需项目经理确认。");
  } else {
    for (const entry of coverage.empty) {
      if (!CRITICAL_PROFILE_PATHS.has(entry.path)) continue;
      pushMissing(entry.path, entry.label, `客户档案 ${entry.path} 为空，相关结论只能落推断或待人工补充（引用访谈原文或名册补充说明的除外）。`);
    }
  }
  if (!monetizationProducts.some(product => product.price)) {
    pushMissing("product.priceRange", "变现产品定价", "客户档案价格区间为空，且输入里找不到任何定价依据，变现产品价格留空待人工补充。");
  }
  pushMissing("customerPhoto", "客户照片", "输入里没有客户照片，头像只能给拍摄与着装建议，改图待人工补充。");
  // 客户名册里登记了对标账号时这一项就不缺了 —— 不能一边填着账号一边报「缺账号」。
  if (sameTrackAccounts.level === "manual") {
    pushMissing("sameTrackAccounts", "同赛道对标账号", "客户名册里没有登记对标账号，本步骤也不抓取账号，需人工补充账号名单后再生成对应选题。");
  }
  // 第二批：1.2 缺开头 / 结尾分析时，四 的两组钩子只剩通用口径 —— 如实列进缺失输入。
  if (!hookReference.threeSeconds.available || !hookReference.endingHooks.available) {
    const missingBlocks = [
      hookReference.threeSeconds.available ? "" : "开头 3 秒分析",
      hookReference.endingHooks.available ? "" : "结尾钩子分析",
    ].filter(Boolean);
    pushMissing("benchmarkHookAnalysis", `1.2 的${missingBlocks.join(" / ")}`,
      `1.2 报告里没有${missingBlocks.join(" / ")}（旧报告缺这一批字段），四 的钩子只能按通用口径给，需人工核对后再用。`);
  }

  // ── 自动告警（把「这份报告哪里不完整、为什么」讲清楚）──────────────────────
  if (!coverage.hasAnyValue) {
    autoWarnings.push({
      code: "IP_PROFILE_MISSING",
      error: "该客户没有 IP 访谈档案（ipProfile 缺失或全空）：IP 定位相关结论只能基于 1.2 报告或名册补充说明，声明输入证据时必须给出能核对上的引文。",
    });
  }
  if (profile.interview.rawNotesTruncated) {
    autoWarnings.push({
      code: "IP_PROFILE_NOTES_TRUNCATED",
      error: `访谈原文共 ${profile.interview.rawNotesLength} 字，超过上限已截断到 ${profile.interview.rawNotes.length} 字后再送入分析。`,
    });
  }
  if (classification.categoryCount === 0) {
    autoWarnings.push({
      code: "BENCHMARK_CLASSIFICATION_MISSING",
      error: "1.2 报告里没有可透传的分类产出：选题库建立需要先跑完 1.2（或确认传入的是对标账号分析报告而不是分类报告）。",
    });
  }
  if (asText(benchmark?.reportType) && asText(benchmark?.reportType) !== "benchmark_profile") {
    autoWarnings.push({
      code: "BENCHMARK_REPORT_TYPE_MISMATCH",
      error: `传入的报告 reportType=${asText(benchmark.reportType)}，不是 1.2 的对标账号分析报告（benchmark_profile），内容定位与选题库可能取不到数据。`,
    });
  }
  // 对标账号由**客户档案**决定，不由 Agent 决定：登记了几个就用几个（见方法一(a)），
  // Agent 自己提议的账号一概不写入报告 —— 它给不出可核对的来源。
  autoWarnings.push({
    code: "SAME_TRACK_ACCOUNTS_MANUAL",
    error: sameTrackAccounts.level === "manual"
      ? "同赛道对标账号为人工补充项：客户名册里没有登记该数据，Agent 给出的账号一律不写入报告。"
      : `同赛道对标账号取自客户档案登记（${sameTrackAccounts.count} 个）；Agent 给出的账号一律不写入报告。`,
  });
  autoWarnings.push({
    code: "HOT_TOPICS_NOT_REALTIME",
    error: HOT_TOPIC_DISCLAIMER,
  });
  // ── 第二批的告警：钩子类型被丢、条数不足、配比里出现了 1.2 没有的大类 ────────────
  if (openingHooks.discardedCount > 0 || endingHooks.discardedCount > 0) {
    autoWarnings.push({
      code: "HOOK_TYPES_DISCARDED",
      error: `四 的钩子有 ${openingHooks.discardedCount + endingHooks.discardedCount} 条被丢弃（开头 ${openingHooks.discardedCount} 条 / 结尾 ${endingHooks.discardedCount} 条）：类型不在权威清单内、类型重复、没有文案或超出 ${OPENING_HOOK_COUNT} 条上限。`,
    });
  }
  if (openingHooks.count !== OPENING_HOOK_COUNT || endingHooks.count !== ENDING_HOOK_COUNT) {
    autoWarnings.push({
      code: "HOOK_TYPE_COUNT",
      error: `规格要求每类 ${OPENING_HOOK_COUNT} 种不同类型的钩子，本次产出：开头 ${openingHooks.count} 条 / 结尾 ${endingHooks.count} 条；不自动补齐，差额待人工补充。`,
    });
  }
  if (contentMix.unmatchedCount > 0) {
    autoWarnings.push({
      code: "CONTENT_MIX_CATEGORY_MISMATCH",
      error: contentMix.unmatchedNote,
    });
  }
  // 五 是建议不是观测：这一点必须出现在告警里，别让它只躺在正文里。
  autoWarnings.push({
    code: "PRODUCTION_ADVICE_NOT_OBSERVED",
    error: PRODUCTION_LEVEL_CAP_NOTE,
  });

  const producedSections = ACCOUNT_PLAN_SECTIONS
    .filter(section => {
      if (section.key === "ipPositioning") {
        return Boolean(targetAudience.text || corePain.text || contentDirections.length
          || monetizationProducts.length > 0 || monetizationPath.length > 0
          || role.text || personalityKeywords.length > 0 || memoryAnchors.some(anchor => anchor.count > 0));
      }
      if (section.key === "accountSetup") {
        return trio.some(item => item.text) || bioPlatforms.some(platform => platform.candidateCount > 0);
      }
      if (section.key === "framework") {
        return openingHooks.count > 0 || endingHooks.count > 0;
      }
      if (section.key === "production") {
        return production.shooting.items.some(item => item.text) || production.editing.items.some(item => item.text);
      }
      if (section.key === "operations") {
        // ⚠️ 起号四步与复盘四维是**固定模板**，不参与「本章节有没有内容」的判断 ——
        // 否则 Agent 失败时也会报「六 有内容」，把一份空报告说成完整的。
        return Boolean(
          platformStrategy.primary.text || platformStrategy.secondary.text || platformStrategy.matchAnalysis.text
          || publishWindow.text || publishFrequency.text
          || trafficScripts.some(item => item.scriptCount > 0)
          || contentMix.periods.some(period => period.rows.length > 0),
        );
      }
      return methods.some(method => method.topicCount > 0);
    })
    .map(section => section.key);

  return {
    version: "1.0",
    reportType: ACCOUNT_PLAN_REPORT_TYPE,
    batch: ACCOUNT_PLAN_BATCH,
    batchLabel: ACCOUNT_PLAN_BATCH_LABEL,
    sections: ACCOUNT_PLAN_SECTIONS.map(section => section.key),
    customer: {
      id: asText(customerSource.id),
      name: asText(customerSource.name),
      occupation: asText(customerSource.occupation),
      hasProfile: coverage.hasAnyValue,
      profileStatus: profile.status,
      // 客户名册里的原始诉求（账号定位描述 / 内容需求 / 备注 / 对标账号）原样带上，
      // 项目经理审核时能一眼对照「客户当初要的是什么」。
      // ⚠️ `benchmarkAccounts` 现在就是方法一(a) 同赛道对标账号的**数据来源**（见 topicLibrary）：
      // 有登记就按 evidence 填充，没有才落人工补充位；它不参与正文结论的证据核对。
      ipPositioning: asText(customerSource.ipPositioning),
      contentNeeds: asText(customerSource.contentNeeds),
      notes: asText(customerSource.notes),
      benchmarkAccounts: asText(customerSource.benchmarkAccounts),
    },
    // 结构化档案 + 覆盖率如实透传。⚠️ 访谈原文**不落进报告**（最长 6000 字，
    // 且它已经在客户档案里可回查）：报告只记长度与截断标记，正文参与分析但不重复存储。
    ipProfile: {
      status: profile.status,
      schemaVersion: profile.schemaVersion,
      identity: profile.identity,
      product: profile.product,
      userProfile: profile.userProfile,
      interview: {
        source: profile.interview.source,
        completedAt: profile.interview.completedAt,
        rawNotesLength: profile.interview.rawNotesLength,
        rawNotesTruncated: profile.interview.rawNotesTruncated,
      },
      coverage,
      note: "访谈原文不落进报告，仍可在客户档案里回查；它参与本次分析并计入证据核对范围。",
    },
    benchmark: {
      reportId: benchmarkId,
      reportType: asText(benchmark?.reportType),
      accountName: asText(benchmark?.account?.name),
      accountUrl: asText(benchmark?.account?.url),
      contentStyle: asText(benchmark?.contentStyle),
      contentStyleLabel: asText(benchmark?.contentStyleLabel),
      analyzedAt: asText(benchmark?.analyzedAt),
      source: benchmarkSource,
      evidenceNote: "1.2 报告里标「待人工补充」的字段在 1.3 里同样不是结论；报告同时带上每一项的证据等级。",
    },
    ipPositioning: {
      businessPositioning,
      contentPositioning,
      personaPositioning,
    },
    accountSetup,
    topicLibrary,
    // 第二批（四 / 五 / 六）。⚠️ 这三节在报告里**全是可选字段**：第一批存下来的旧报告没有它们，
    // 前端必须用 `?.` 兜住（缺哪节就不渲染哪节），后端也不要求它们有内容。
    contentFramework,
    production,
    operations,
    missingInputs,
    dataCoverage: {
      profileFilledFieldCount: coverage.filledCount,
      profileTotalFieldCount: coverage.totalCount,
      profileHasAnyValue: coverage.hasAnyValue,
      interviewRawNotesLength: profile.interview.rawNotesLength,
      audienceDimensionFilledCount: audienceDimensions.filter(item => item.profileValue).length,
      benchmarkCategoryCount: classification.categoryCount,
      benchmarkSubcategoryCount: classification.subcategoryCount,
      benchmarkTopicTotal: classification.topicTotal,
      benchmarkFrequentTagCount: contentPositioning.frequentTags.length,
      producedSectionCount: producedSections.length,
      producedSections,
      topicCount: {
        benchmark: methods[0].topicCount,
        questions: methods[1].topicCount,
        trends: methods[2].topicCount,
        total: topicLibrary.topicTotal,
      },
      // 第二批的覆盖率：条数同样由后端重算，模型自报的数量不采信。
      openingHookCount: openingHooks.count,
      endingHookCount: endingHooks.count,
      hookDiscardedCount: openingHooks.discardedCount + endingHooks.discardedCount,
      productionItemCount: [...production.shooting.items, ...production.editing.items].filter(item => item.text).length,
      contentMixPeriodCount: contentMix.periods.filter(period => period.rows.length > 0).length,
    },
    analysisSource,
    warnings: [...(Array.isArray(warnings) ? warnings : []), ...autoWarnings],
    analyzedAt: new Date().toISOString(),
  };
};

/**
 * 规则兜底：Agent 不可用时也要给出一份**诚实**的报告 ——
 * 能透传的照透传（1.2 的分类选题库、高频标签、证据等级），
 * 不能算的一律落「待人工补充」，绝不用套话把版面填满。
 *
 * 第二批同样遵守这条：四 的两组钩子与五 的 9 项都是**模型产物**，兜底时全部落 manual；
 * 六 里只有「起号四步」与「数据复盘四维」照常输出 —— 它们是固定模板文本，本来就不依赖模型
 * （`LAUNCH_STEPS` / `REVIEW_DIMENSIONS` 由后端写入），而平台矩阵与内容配比落 manual。
 */
export const buildHeuristicAccountPlan = () => ({
  businessPositioning: {
    targetAudience: { text: "", basis: [], level: "manual" },
    audienceDimensions: [],
    corePain: { text: "", basis: [], level: "manual" },
    contentDirections: [],
    monetization: { products: [], path: [], note: "" },
    summary: "Agent 暂时不可用：IP 商业定位待人工补充；1.2 报告的分类选题库与高频标签仍原样透传。",
  },
  contentPositioning: {
    core: { text: "", basis: [], level: "manual" },
    summary: "Agent 暂时不可用：内容定位待人工补充；下方选题库为 1.2 报告原样透传。",
  },
  personaPositioning: {
    role: { text: "", basis: [], level: "manual" },
    personality: { keywords: [] },
    memoryAnchors: {},
    summary: "Agent 暂时不可用：人设定位待人工补充。",
  },
  accountSetup: {
    trio: {},
    bio: {},
    summary: "Agent 暂时不可用：账号三件套与账号简介待人工补充。",
  },
  topicLibrary: {
    benchmarkTopics: [],
    questions: [],
    trends: [],
    summary: "Agent 暂时不可用：三种方法的选题待人工补充；1.2 报告的选题库见内容定位一节。",
  },
  contentFramework: {
    openingHooks: [],
    endingHooks: [],
    summary: "Agent 暂时不可用：开头 3 秒钩子与结尾钩子待人工补充；1.2 报告的开头 / 结尾分析仍随报告带出，供人工参照。",
  },
  production: {
    shooting: {},
    editing: {},
    summary: "Agent 暂时不可用：拍摄与剪辑建议待人工补充（本节本来就是建议，不自动补一套通用话术）。",
  },
  operations: {
    // 平台矩阵与内容配比是模型产物：不给就是不给，落 manual。
    platformStrategy: {},
    contentMix: { periods: [] },
    // 起号四步与复盘四维由后端写死，这里给空对象即可 —— 模板照常输出。
    launchPlan: {},
    reviewPlan: {},
    summary: "Agent 暂时不可用：平台与矩阵策略、内容配比待人工补充；起号策略四步与数据复盘四维是固定模板，照常输出。",
  },
});
