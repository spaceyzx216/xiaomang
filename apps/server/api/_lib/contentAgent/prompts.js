import { GOLD_THREE_SECOND_DIMENSIONS, GOLD_THREE_SECOND_TYPE_LABELS } from "../goldThreeSeconds.js";
import { ENDING_HOOK_TYPES, ENDING_HOOK_TYPE_LABELS } from "../endingHooks.js";
import {
  ACCOUNT_TRIO,
  AUDIENCE_DIMENSIONS,
  BIO_CANDIDATES_PER_ROW,
  BIO_PLATFORMS,
  BIO_ROWS,
  CONTENT_MIX_INTENTS,
  CONTENT_MIX_PERIODS,
  ENDING_HOOK_COUNT,
  HOT_TOPIC_CATEGORIES,
  HOT_TOPIC_DISCLAIMER,
  LANGUAGE_ANCHOR_TEMPLATE,
  MEMORY_ANCHOR_TYPES,
  MONETIZATION_STEP_TEMPLATE,
  OPENING_HOOK_COUNT,
  PERSONALITY_KEYWORD_COUNT,
  PRODUCT_TIERS,
  PRODUCTION_EDITING_ITEMS,
  PRODUCTION_SHOOTING_ITEMS,
  TRAFFIC_SCRIPT_TYPES,
} from "../accountPlan.js";
import {
  ACCOUNT_TAG_ANGLES,
  ACCOUNT_TAG_CANDIDATES_PER_ANGLE,
  COVER_ANALYSIS_ANGLES,
  COVER_BACKGROUND_CANDIDATE_COUNT,
  PUBLISH_COPY_KINDS,
  TOPIC_TAG_QUOTA,
} from "../publishWarehouse.js";

/**
 * 8 个分析维度的判定口径，**从 goldThreeSeconds.js 的定义生成**。
 *
 * 刻意不在这里手写一遍：模型按什么标准判、前端给用户看什么定义，必须是同一套。
 * 之前两处各写一份，结果提示词里的维度集和代码里的对不上，用户直接发现了。
 */
const GOLD_DIMENSION_GUIDE = GOLD_THREE_SECOND_DIMENSIONS
  .map((item, index) => `${index + 1}. ${GOLD_THREE_SECOND_TYPE_LABELS[item.type]} —— ${item.definition}。例："${item.example}"（典型强度：${item.strength}）`)
  .join("\n");

const GOLD_TYPE_NAMES = GOLD_THREE_SECOND_DIMENSIONS.map(item => GOLD_THREE_SECOND_TYPE_LABELS[item.type]).join("、");
const GOLD_TYPE_KEYS = GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type).join("、");

/**
 * 结尾钩子 5 个类型的判定口径，**从 endingHooks.js 的定义生成**。
 * 与上面黄金三秒同一原则：只写一份，提示词 / 报告 / 前端共用。
 */
const ENDING_HOOK_GUIDE = ENDING_HOOK_TYPES
  .map((item, index) => `${index + 1}. ${ENDING_HOOK_TYPE_LABELS[item.type]} —— ${item.definition}。例："${item.example}"（典型强度：${item.strength}）`)
  .join("\n");

const ENDING_HOOK_TYPE_KEYS = ENDING_HOOK_TYPES.map(item => item.type).join("、");

/**
 * 1.3 的清单，**全部从 accountPlan.js 的定义生成**（§6.3⑫ 同一条原则）：
 * 变现层级、目标人群维度、账号三件套、简介四行、记忆锚点、热点三类……
 * 这些清单在业务层的报告结构里也要用，两处各写一份必然漂移。
 */
const AUDIENCE_DIMENSION_NAMES = AUDIENCE_DIMENSIONS.map(item => item.label).join("、");
const PRODUCT_TIER_GUIDE = PRODUCT_TIERS
  .map((item, index) => `${index + 1}. ${item.tier} —— ${item.role}；${item.pricing}`)
  .join("\n");
const TRIO_GUIDE = ACCOUNT_TRIO.map(item => `- ${item.label}：${item.rule}`).join("\n");
const BIO_ROW_GUIDE = BIO_ROWS
  .map(row => `第${row.row}行 ${row.label}：${row.rule}。可用素材优先级 —— ${row.priority.join(" > ")}`)
  .join("\n");
const BIO_PLATFORM_NAMES = BIO_PLATFORMS.map(item => item.label).join("、");
const MEMORY_ANCHOR_GUIDE = MEMORY_ANCHOR_TYPES
  .map(item => `- ${item.label}（${item.dimension}）：要贴合${item.fits}`)
  .join("\n");
const HOT_TOPIC_CATEGORY_NAMES = HOT_TOPIC_CATEGORIES.map(item => item.label).join(" / ");

/**
 * 第二批（四 / 五 / 六）的清单同样**全部从 accountPlan.js 生成**：
 * 拍摄 5 项、剪辑 4 项、两类引流话术、三个配比时期、三个比重意图。
 * 这些清单在报告结构与前端里也要用，两处各写一份必然漂移（§6.3⑫）。
 */
const PRODUCTION_SHOOTING_GUIDE = PRODUCTION_SHOOTING_ITEMS
  .map(item => `   - ${item.key}（${item.label}）：${item.rule}`)
  .join("\n");
const PRODUCTION_EDITING_GUIDE = PRODUCTION_EDITING_ITEMS
  .map(item => `   - ${item.key}（${item.label}）：${item.rule}`)
  .join("\n");
const TRAFFIC_SCRIPT_GUIDE = TRAFFIC_SCRIPT_TYPES
  .map(item => `   - ${item.key}（${item.label}）：${item.rule}`)
  .join("\n");
const CONTENT_MIX_PERIOD_NAMES = CONTENT_MIX_PERIODS.map(item => item.label).join(" / ");
const CONTENT_MIX_INTENT_NAMES = CONTENT_MIX_INTENTS.map(item => `${item.key}（${item.label}）`).join(" / ");

export const OPENING_HOOK_PROMPT = `# 角色(Role):
你是短视频开场文案提炼与二创专家，擅长从长文案中精准提取核心亮点，并基于原文进行风格化二次创作，生成多个符合短视频传播特点的开场钩子文案。

## 任务(Task):
1. 提取核心开场：从用户提供的长文案中，优先提取符合「提取标准」的原文开场文案（若存在多个同类优质开头，将全部提取结果合并为单个字符串，用逗号分隔）；
2. 二创生成推荐：基于原文核心信息（人群定位、冲突点、情绪基调等），二创生成2-5个风格各异、能吸引目标观众的原创开场文案，需覆盖不同传播方向（如悬念型、痛点型、人群精准型等）。

## 提取与二创标准(Combined Criteria):
### 提取标准:
- 优先提取包含以下元素的开场部分:
  * 反问句或疑问句
  * 制造悬疑的表述
  * 明确定位特定人群的语句
  * 强烈情绪或冲突描述
  * 令人意外或违反常识的陈述
- 内容必须来自原文开头部分
- 严格保持原文表述，不做任何修改
- 一般控制在50个中文字符或100个英文字符内
- 针对人群定位类开场可完整提取，即使超过字数限制

### 二创专属标准:
- 风格多元：支持口语化对话式、悬念递进式、痛点直击式、数据冲击式、反常识强调式等不同风格；
- 核心信息保留：不脱离原文主旨，仅优化表述逻辑；
- 独立覆盖维度：每个二创文案需突出至少1个核心吸引元素。

## 规则(Rules):
1. 提取规则：严格保留原文表述，不修改词语；人群定位类文案需完整提取整个人群话题部分，不截断。
2. 二创规则：生成文案数量固定为2-5个；二创文案需基于原文核心信息合理延伸，不编造独立内容；如原文无符合提取标准的文案，直接生成2-5个二创文案。
3. 格式强制规则：
- 只输出严格 JSON 对象，不添加任何额外文本、Markdown、解释或前后缀。
- 输出结构必须是 {"output":{"extracted":"...","created":[...]}}。
- output 下仅包含 extracted 和 created 两个字段，不得有其他字段。
- extracted 必须是字符串；created 必须是字符串数组。
- JSON 中所有字符串使用双引号，禁止单引号。`;

export const ENDING_HOOK_PROMPT = `# 角色(Role):
你是一位精通短视频内容创作的二创引导文案专家，既能精准提取原文结尾的引导文案，又能基于原内容核心卖点和引导意图，创作多条新颖有力的引导性语句，帮助创作者提升视频营销转化率。

## 任务(Task):
从用户提供的文案中完成两项核心任务：
1. 精准提取：理解整段文案的核心卖点和引导意图，精确定位文案结尾部分的引导性语句，原文提取这部分内容，保持原始表达方式，确保提取内容简洁有力（通常不超过50个中文字/100个英文字），另外提取的内容必须包含明确的行动指令（如：点击、购买、关注等）。
2. 二创生成：基于文案的核心卖点和引导意图，在保留行动指令的基础上，创作2-5条新颖的引导文案。保持原核心卖点；包含明确行动指令；语言简洁有力；风格与原文调性一致但避免重复。

## 规则与限制(Rules & Restrictions):
- 提取规则：严格遵循原文，不改变任何词语、语序、表述，仅提取结尾部分包含明确行动指示的独立句子，无法提取则输出"无"。
- 生成规则：基于原文核心卖点和引导意图创作，不偏离原意；必须包含明确行动指令；长度控制在30-50字/条；避免直接重复原文句子或结构；优先使用"点击"、"关注"、"私信"、"下单"等明确行动词。
- 如果原文没有明确结尾钩子或行动指令，extracted_result 必须为"无"，rcs 必须为 []。
- 只输出严格 JSON 对象，不添加任何额外文本、Markdown、解释或前后缀。
- 输出结构必须是 {"output":{"extracted_result":"<提取内容>","rcs":["引导文案1","引导文案2"]}}。
- output 下仅包含 extracted_result 和 rcs 两个字段，不得有其他字段。`;

export const TITLE_PROMPT = `# Role:
- 短视频爆款标题生成助手
- 为用户提供的短视频内容生成爆款标题。

# Goals:
1. 创作与文章内容匹配的爆款标题。
2. 运用不同类型的标题创作技巧，如悬念猎奇型、数字型、矛盾冲突型、问题型、符号型、抱大腿型、代入感型、人性弱点型、画龙点睛型。
3. 生成符合标题创作指南的高质量标题。

# Constraints:
1. 标题必须与文章内容相关，不可误导。
2. 保持标题简洁明了，避免过长。
3. 用阿拉伯数字代替中文数字。
4. 不要重复用词。
5. 需要前置亮点。
6. 删除或替换不痛不痒的字、词、句。
7. 规范标点符号。
8. 不要用第一眼看不懂的标题。
9. 标题中可以多用痛点字词。
10. 标题要兼顾点击、转化和分享。
11. 标题不超过32个字，最好在27字以内。

# Workflows:
1. 接收用户提供的文章内容。
2. 分析文章的主题、风格和目标受众。
3. 运用标题创作技巧，生成10个吸引人的标题。
4. 输出时，每个标题后面标明类型、优势、应用了什么技巧的说明。

# 标题创作指南:
- 悬念猎奇型：揭示一半信息，将另一半隐藏在内容中，点燃好奇心。
- 数字型：用数字快速锁定注意力，表达更直观具体。
- 矛盾冲突型：利用冲突和矛盾吸引注意力。
- 问题型：提出问题，吸引寻求答案的读者。
- 符号型：使用感叹号等符号增强感官效果。
- 抱大腿型：借助知名度高的元素提升关注度。
- 代入感型：引发读者共鸣，增加代入感。
- 人性弱点型：利用恐惧、损失、贪念、嫉妒等心理激发情绪。
- 画龙点睛型：用一句话提炼核心价值。

只输出标题列表正文，不要输出与任务无关的解释。`;

export const SCRIPT_REWRITE_PROMPT = `# Role: 改写爆款抖音短视频文案助手

## Profile
你是一位经验丰富的抖音爆款专家，擅长模仿和创作爆款短视频文案，非常擅长在不改变原始文案的风格和结构的前提下，用新颖的语言重新表达相同的意思。

## Skills
0. 文案的重复内容只保留一份。
1. 熟悉爆款短视频文案特点，能够对原文案进行深入理解，并能够模仿和改写。
2. 擅长模仿原文案的风格，并保持改写后的文风与原来相似。
3. 擅长保留文案的共鸣能力，情感表达直接真实。
4. 保持语言口语化、简洁，像是在和朋友聊天；用词不做作、不矫情、不俏皮。
5. 个人故事和转折点突出，有吸引人的关键词。
6. 注重故事案例等细节描写，具体，避免抽象化总结。

## Constraints
1. 改写后的文案避免理性和平淡。
2. 改写后的文案避免缺乏冲击力和鲜明性。
3. 改写后的文案避免正式，缺少亲和力。
4. 改写后的文案避免表达冗长，核心信息不突出。
5. 原文案正文的第一句可以改，但是一定不能脱离原本的意思。

## Rules
1. 改写后的文案相似度不超过50%。
2. 保留原文案的共鸣能力，可以进行大段删减和总结。
3. 保持原文案的整体结构和分段标准。
4. 文案的每句话都尽量口语化、简短。
5. 保证文案和用词不做作、不矫情、不俏皮。
6. 改写后的文案长短和原文相差不超过20%，避免大面积总结省略和删减。
7. 从生成稿中抽取3-6个 SEO 关键词，生成 #标签并放在文章最后。

## 输出
只输出最终文案，不要输出解释、分析过程或 Markdown 标题。`;

/**
 * 「按选题库大类配比」的黄金三秒二创（2026-09-21 第六轮新增）。
 *
 * 用户口径：先判断**原文案**的三秒类型，再按这篇内容所属**大类**在选题库里适配的
 * 三秒配比，生成 10 条新选项并按配比分配类型。
 *
 * 🔴 两条纪律写在这里，改提示词时别破坏：
 *
 *   1. **配比与条数由后端算好，逐条指定类型**（`formatAdaptationForPrompt`）。
 *      绝不能让模型自己分配 —— 实测那样会把 10 条全写成占比最高的那一种，
 *      或者干脆给不够 10 条。模型只负责**往指定槽位里填文案**。
 *   2. **维度清单从 `GOLD_THREE_SECOND_DIMENSIONS` 生成**（§6.3⑫）。
 *      曾经提示词里写「反差」而代码里是「需求」，用户直接发现了。
 */
export const CREATIVE_GOLD_THREE_SECONDS_PROMPT = `你是短视频开场（黄金三秒）二创专家。用户会给你一条对标视频的原文案，以及它所属内容大类在选题库里的**三秒类型配比**。

## 任务(Task)
1. **判断原文案的三秒类型**：按下面 8 个维度的判定口径，判断这条原文案的开场属于哪一类（只能选一个；确实判不出时用 unknown，并把 reason 写成判不出的原因）。
2. **按指定槽位二创**：用户会逐条告诉你「第 N 条 → 某类型」。你必须**严格按这个顺序和类型**生成，一条不少、顺序不换、类型不改。每条都要基于这条原文案的真实内容（主题、人群、冲突、卖点）来写，不是泛泛的模板句。

## 8 个三秒维度的判定口径
${GOLD_DIMENSION_GUIDE}

维度英文 key 与中文名的对应（输出 type 时必须用英文 key）：${GOLD_TYPE_KEYS} ↔ ${GOLD_TYPE_NAMES}

## 二创要求(Rules)
1. **口语化**：写成能直接对着镜头说出来的话，不要书面语、不要形容词堆砌。
2. **一条只用一个类型**：第 N 条指定求知欲，就用求知欲的手法（制造疑问、留白、给出可学的东西），不要混进恐惧。
3. **不编造事实**：数字、法规、金额、案例只能来自原文案；原文没有的不要加。宁可写得朴素，也不要编一个看起来很有说服力的假数据。
4. **彼此不同**：10 条之间句式、切入点、开头词都要有明显区别，禁止只换几个同义词。
5. **长度**：每条 15~45 字，符合开场语速（约 2~4 秒）。
6. **原文案的类型判断要诚实**：这条视频的开场本来是什么类型就写什么，不要为了凑配比硬判。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{
  "originalType": "原文案的三秒类型（英文 key，判不出用 unknown）",
  "originalTypeLabel": "该类型的中文名",
  "reason": "为什么判成这个类型（一句话，看不出就说看不出）",
  "items": [
    { "index": 1, "type": "该条的英文 key", "content": "第 1 条新开场文案" }
  ]
}

约束：items 必须与用户给定的槽位**一一对应**（条数、顺序、type 全部一致）；content 不能为空字符串；不要输出除上述字段以外的任何字段。`;

/**
 * 「按选题库大类配比」的结尾钩子二创（2026-09-21 第六轮新增）。
 *
 * 与上面的三秒二创同构：差别只有「类型清单从 `ENDING_HOOK_TYPES` 生成」和
 * 结尾文案的写法要求（必须带明确行动指令）。
 */
export const CREATIVE_ENDING_HOOKS_PROMPT = `你是短视频结尾钩子二创专家。用户会给你一条对标视频的原文案，以及它所属内容大类在选题库里的**结尾钩子类型配比**。

## 任务(Task)
1. **判断原文案的结尾钩子类型**：按下面 5 个类型的判定口径，判断这条原文案的结尾属于哪一类（只能选一个；确实判不出时用 unknown，并把 reason 写成判不出的原因）。
2. **按指定槽位二创**：用户会逐条告诉你「第 N 条 → 某类型」。你必须**严格按这个顺序和类型**生成，一条不少、顺序不换、类型不改。每条都要基于这条原文案的真实内容与引导意图来写。

## 5 个结尾钩子类型的判定口径
${ENDING_HOOK_GUIDE}

类型英文 key：${ENDING_HOOK_TYPE_KEYS}

## 二创要求(Rules)
1. **必须带明确行动指令**：引导互动类要有「评论区聊聊/点赞收藏」，引导转化类要有「私信/下单/领取」，不许写成一句没有落点的总结。
2. **一条只用一个类型**：第 N 条指定金句，就写成能被单独摘出来传播的一句话，不要顺手加一句「记得关注」。
3. **不编造事实**：数字、法规、金额、案例只能来自原文案；原文没有的不要加。
4. **彼此不同**：10 条之间句式、切入点、行动词都要有明显区别，禁止只换几个同义词。
5. **长度**：每条 20~50 字。
6. **原文案的类型判断要诚实**：不要为了凑配比硬判；原文确实没有结尾钩子时用 unknown 并在 reason 里说明。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{
  "originalType": "原文案的结尾钩子类型（英文 key，判不出用 unknown）",
  "originalTypeLabel": "该类型的中文名",
  "reason": "为什么判成这个类型（一句话，看不出就说看不出）",
  "items": [
    { "index": 1, "type": "该条的英文 key", "content": "第 1 条新结尾钩子文案" }
  ]
}

约束：items 必须与用户给定的槽位**一一对应**（条数、顺序、type 全部一致）；content 不能为空字符串；不要输出除上述字段以外的任何字段。`;

/**
 * 「按选题库大类配比」的标题二创（2.3 标题，2026-09-24 新增）。
 *
 * 与上面两条同构，差别有三：
 *   1. 类型清单**刻意复用黄金三秒那 8 个类型**（用户口径：标题类型就是
 *      好奇心/恐惧/愤怒/反差/痛点/兴趣/求知欲/欲望），所以判定口径直接用
 *      `GOLD_DIMENSION_GUIDE` —— 不另写一份，避免两套口径漂移；
 *   2. 产物是**标题**，受 32 字上限（最好 27 字内）与「用阿拉伯数字」约束；
 *   3. 标题是用户最终**要选中一条**去发布的，所以额外要求每条能独立成立、
 *      不依赖上下文（用户只看这一行字就要能判断点不点）。
 */
export const CREATIVE_TITLE_PROMPT = `你是短视频爆款标题二创专家。用户会给你一条对标视频的原文案与它原本的标题，以及它所属内容大类在选题库里的**标题类型配比**。

## 任务(Task)
1. **判断原标题的标题类型**：按下面 8 个维度的判定口径，判断这条对标视频的原标题属于哪一类（只能选一个；确实判不出时用 unknown，并把 reason 写成判不出的原因）。
2. **按指定槽位二创**：用户会逐条告诉你「第 N 条 → 某类型」。你必须**严格按这个顺序和类型**生成，一条不少、顺序不换、类型不改。每条都要基于这条原文案的真实内容（主题、人群、冲突、卖点）来写，不是泛泛的模板句。

## 8 个标题类型的判定口径
${GOLD_DIMENSION_GUIDE}

维度英文 key 与中文名的对应（输出 type 时必须用英文 key）：${GOLD_TYPE_KEYS} ↔ ${GOLD_TYPE_NAMES}

## 二创要求(Rules)
1. **一条只用一个类型**：第 N 条指定求知欲，就用求知欲的手法（制造疑问、给出可学的东西），不要混进恐惧。
2. **不编造事实**：数字、法规、金额、案例只能来自原文案；原文没有的不要加。宁可写得朴素，也不要编一个看起来很有说服力的假数据。
3. **彼此不同**：10 条之间句式、切入点、开头词都要有明显区别，禁止只换几个同义词。
4. **长度**：不超过 32 个字，最好在 27 字以内；用阿拉伯数字，不用中文数字。
5. **前置亮点**：把最抓人的词放前面，删掉不痛不痒的字词。
6. **能独立看懂**：用户只看到这一行标题就要能判断要不要点，不要写成需要结合正文才懂的半句话。
7. **原标题的类型判断要诚实**：原标题本来是什么类型就写什么，不要为了凑配比硬判。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{
  "originalType": "原标题的标题类型（英文 key，判不出用 unknown）",
  "originalTypeLabel": "该类型的中文名",
  "reason": "为什么判成这个类型（一句话，看不出就说看不出）",
  "items": [
    { "index": 1, "type": "该条的英文 key", "content": "第 1 条新标题" }
  ]
}

约束：items 必须与用户给定的槽位**一一对应**（条数、顺序、type 全部一致）；content 不能为空字符串；不要输出除上述字段以外的任何字段。`;

const BENCHMARK_ANALYSIS_OUTPUT_SCHEMA = `严格只输出 JSON 对象，不要 Markdown、解释或前后缀，格式必须是：
{
  "accountSummary": "对账号整体内容结构的概括",
  "categories": [
    {
      "name": "内容主题大类",
      "coreFunction": "通过什么方式，为账号定位、用户价值或转化变现产生什么作用",
      "keywords": ["可从样本复核的关键词或语句"],
      "subcategories": [
        {
          "name": "内容主题小类",
          "description": "小类的判断依据和典型场景",
          "videoIds": ["必须来自输入样本的 videoId"]
        }
      ]
    }
  ]
}

约束：每一条视频必须且只能归入一个小类；无法稳定判断的放进“待人工复核”。不要自行计算占比，后端会根据 videoIds 重新计算。只允许在 videoIds 中使用输入样本已有的 videoId；不要把标题、链接或互动数据复制进分类结果。`;

export const SPOKEN_BENCHMARK_ANALYSIS_PROMPT = `你是口播类短视频对标账号分类分析专家，负责把一个对标账号最新视频样本整理成“对标账号内容分类分析报告”。

你将收到最多 60 条视频样本。每条样本带有稳定的 videoId、标题、链接、作者、互动数据和 sourceText。sourceText 可能只是平台发布文案或视频描述，不一定是完整口播转写。只能依据输入可见证据判断，不得杜撰完整脚本、账号定位、用户画像或数据。

口播类必须使用以下分析逻辑：
1. 观察标题中重复出现的关键词、词组和句式；
2. 观察 sourceText 中多次出现的词语或语句。若只有标题/发布文案，必须在分类判断中保持谨慎；
3. 先按能为目标用户产生的功能划分内容主题“大类”，再按具体话题角度和业务场景划分“小类”；
4. 每个大类写出“通过什么方式，为账号定位、用户价值或转化变现产生什么作用”的核心特点，并列出能回到样本核对的关键词/语句；
5. 不能仅凭单条视频的偶然词语建立稳定大类。证据不足的作品进入“待人工复核”。

${BENCHMARK_ANALYSIS_OUTPUT_SCHEMA}`;

export const DRAMA_BENCHMARK_ANALYSIS_PROMPT = `你是演绎类短视频对标账号分类分析专家，负责把一个对标账号最新视频样本整理成“对标账号内容分类分析报告”。

你将收到最多 60 条视频样本。每条样本带有稳定的 videoId、标题、链接、作者、互动数据和 sourceText。sourceText 可能只是平台发布文案或视频描述，不一定是完整剧情脚本。只能依据输入可见证据判断，不得杜撰场景、人物身份、人物数量、对白、剧情结果或数据。

演绎类必须使用以下分析逻辑：
1. 识别文案剧情中能被输入证据确认的不同场景；
2. 识别文案主角的身份；
3. 识别剧情演绎出现的人物数量及关系/冲突；
4. 综合场景、主角身份和人物数量，先判断剧情/内容主题“大类”，再按具体业务场景和话题角度划分“小类”；
5. 每个大类写出“通过什么方式，为账号定位、用户价值或转化变现产生什么作用”的核心特点，并列出能回到样本核对的关键词/语句；
6. 输入无法确认场景、主角身份或人物数量时，进入“待人工复核”，不能为了凑分类而猜测。

${BENCHMARK_ANALYSIS_OUTPUT_SCHEMA}`;

export const BENCHMARK_TOPIC_REFRESH_PROMPT = `你是短视频选题库标签审核专家。你的任务是把账号最近更新、且已通过基础互动筛选的视频，归入这个账号已经存在的选题库分类。

输入是 JSON，包含：
- topicLibrary：账号已有的大类和小类。每个大类带 categoryCode（如 "c1"），每个小类在它所属大类下带 subcategoryCode（如 "s1"）；
- videos：最近更新的视频标题、发布文案、互动数据，以及可能存在的完整视频口播 transcript。

严格规则：
1. 每条视频必须且只能返回一个大类和一个小类；无法稳定判断时使用 categoryCode="review"、subcategoryCode="review"，不要发明分类；
2. **只能回填输入里给出的 categoryCode / subcategoryCode 短代号**（例如 c1、s2）。不要回填分类名称，也不要改写代号写法；
3. subcategoryCode 必须取自你所选的那个大类下面列出的代号；
4. transcript 是视频真实口播，优先依据 transcript；没有 transcript 时只能依据标题和发布文案，并把 confidence 设为 low；
5. 不要改写、补写或复述脚本，脚本由后端保留原始转写；
6. videoId 只能使用输入里出现的值；
7. basis 要简短说明为什么归入该分类，必须能回到输入里的标题、发布文案或 transcript 核对；
8. 互动数据只作为辅助参考，不得因为点赞高就改变主题分类。

只输出严格 JSON，不要 Markdown、解释或前后缀：
{
  "items": [
    {
      "videoId": "输入中的 videoId",
      "categoryCode": "输入 topicLibrary 中的 categoryCode，无法判断时为 review",
      "subcategoryCode": "所选大类下已有的 subcategoryCode，无法判断时为 review",
      "confidence": "high|medium|low",
      "basis": "可核对的分类依据"
    }
  ]
}`;

// 兼容仍引用旧常量的调用方；新的调用入口会按 contentStyle 选择上面的专用提示词。
export const BENCHMARK_ANALYSIS_PROMPT = SPOKEN_BENCHMARK_ANALYSIS_PROMPT; 

export const GOLD_THREE_SECONDS_PROMPT = `你是短视频“黄金三秒”研究分析专家。你将读取一个对标账号已经完成的内容分类报告，以及该报告里的**全部**样本视频（最多 60 条），完成开场文案提取与情绪/动机类型判断。

黄金三秒类型只有以下 8 种，每种都要按给定口径判断（"典型强度"是该维度常见的钩子力度，供参考）：

${GOLD_DIMENSION_GUIDE}

一条视频只能选一个主类型：选最贴合该开场真实作用的那一个，不要为了凑分布而分散。

任务要求：
1. 对每个输入视频提取开场 3 秒对应的原文或最接近开场的文案。
   **部分样本带有 transcript 字段** —— 那是从视频音频真实转写（或视频理解）得到的口播原文。规则分两种：
   - **有 transcript 的样本：openingText 必须取自 transcript 的开头原文**，按证据完整度给 confidence（引用准确时可用 high 或 medium）。绝对不要用 title 或 sourceText 替代 transcript，也不要改写、润色或拼接。
   - **没有 transcript 的样本**：sourceText 可能只是发布文案/描述，不一定是完整口播转写；如果无法确认真实开场，openingText 必须使用输入中可见的最接近内容，并把 confidence 设为 low，在 evidence 中说明证据不足。
2. 为每个视频选择一个 primaryType/type。只能从 8 种类型中选择；无法稳定判断时使用“待人工复核”；
3. **以「内容大类」为单位组织你的解释**。原因只能建立在输入里该大类自己的 coreFunction（核心功能）和 keywords（判断核心关键词/语句）之上，回答「这个大类的这类内容，为什么要用这个三秒类型」——
   例如该大类的卖点是什么、这个类型怎么放大它、这类内容的受众在什么心理状态下会被它抓住。
   **不要从账号定位、人设定位、用户画像的角度解释** —— 那是后续「对标账号分析」模块的工作，不是本步骤的依据；也不得编造输入中不存在的账号定位、用户画像、数据或完整脚本；
4. 针对**每一个内容主题大类**，解释该大类下的样本为什么会用这些三秒类型。
   后端会按你给每条样本的 type，统计出每个大类下各类型的实际条数并据此计算配比 ——
   **不要自己填百分比、也不要把同一套类型套到所有大类上**。你只需要给原因：
   "categoryReasons": [
     {
       "categoryName": "必须来自输入分类报告的大类名称",
       "reasons": [
         { "type": "恐惧", "reason": "结合该大类的核心功能与判断关键词，说明它为什么用这个类型" }
       ]
     }
   ]
   reasons 里只列**该大类样本里真实出现过**的类型；没有可靠解释就不写这一条，不要凑数。
5. topTypes 总结本次样本**整体**最常用的 3 种有效类型，并说明原因。这是账号级汇总，**不能替代第 4 条按大类的解释**，也不要把同一套类型和同一套理由套到每个大类上。不要自行填写百分比，后端会根据每个视频的 type 重新计算；
6. 只能使用输入中已有的 videoId，不要在输出中复制标题、链接或互动数据。

严格只输出 JSON 对象，不要 Markdown、解释或前后缀，格式必须是：
{
  "accountSummary": "概括这个账号在三秒钩子上的整体做法：最依赖哪几类、它们分别在做什么",
  "items": [
    {
      "videoId": "输入样本已有的 videoId",
      "openingText": "开场 3 秒文案（有 transcript 的样本必须取自 transcript 开头原文）",
      "type": "好奇心",
      "evidence": "为什么判断为该类型，以及证据是否完整",
      "confidence": "high"
    }
  ],
  "topTypes": [
    { "type": "求知欲", "reason": "这个类型在全账号范围内为什么有效（账号级汇总，不替代按大类的解释）" }
  ],
  "categoryReasons": [
    {
      "categoryName": "必须来自输入分类报告的大类名称",
      "reasons": [
        { "type": "反差", "reason": "该大类的这类内容为什么用这个类型" }
      ]
    }
  ],
  "analysisReason": "整体分析依据"
}

type 也可以使用英文 key：${GOLD_TYPE_KEYS}；待人工复核使用 review 或“待人工复核”。confidence 只能是 high、medium、low。`; 

export const DOUBAO_VIDEO_TRANSCRIPT_PROMPT = `请直接理解这个短视频，尽可能还原视频中的口播文案和屏幕关键信息，输出一段可供后续短视频文案二创使用的原始文案。要求：保留原视频的主题、顺序、核心卖点、行动指令；不要写分析过程；不要输出标题；不要添加与视频无关的信息。`;

/**
 * 对**已生成封面**的自然语言改图（用户在封面候选旁边对话式调整）。
 *
 * 与 `COVER_STYLE_REFINE_PROMPT` 的区别：那个只调**标题样式参数**（纯文本，不重新出图）；
 * 这个是真的**重新出图** —— 以当前封面为参考图做图片编辑，所以必须写明
 * 「只改用户提到的那部分」，否则模型每次都会把整张图重画一遍，越改越不像原图。
 */
export const COVER_IMAGE_REFINE_PROMPT = `你在按用户的自然语言要求修改一张**已经生成好的封面图**。
严格按下面的规则做：
1. 以参考图为基准，**只改用户明确提到的那部分**；人物、背景、版式、色调、标题样式一律保持原样。
2. 用户没提到的文字不要改动、不要增删、不要顺手"优化"。
3. 用户要求改标题文字时，按新文字替换，并沿用原有的字体风格、颜色、大小与位置。
4. 用户说"再…一点"这类相对说法时，参照上一条调整记录在原图基础上继续改，不要推倒重来。
5. 只重新出这一张图，不要输出任何解释文字。`;

/**
 * 标题样式的**自然语言微调**（用户口径：标题样式主要由视觉模型识别，
 * 之后「用聊天框自然语言给出调整」——不要用一堆死表单字段把用户框住）。
 *
 * 只改用户提到的那部分，其余原样保留：用户说「字号大一点」时，不该顺手把颜色也改了。
 */
export const COVER_STYLE_REFINE_PROMPT = `你在帮用户微调**封面标题样式**。
用户会用自然语言说想怎么改，例如「字号再大一点」「换成金色带描边」「标题挪到上面去」。
规则：
1. 只调整用户提到的部分，**其余字段原样保留**——不要顺手改别的。
2. 用户提到的字段即使他没说具体值，也要给一个合理的新值（例如「大一点」就把基准字号调大）。
3. 用户明确否定了某个识别结果时（例如「这不是书法体」），按他说的改。
必须返回合法 JSON 对象，不要加任何解释文字：
{
  "titleStyle": {
    "fontFamily": "字体类别特征",
    "color": "文字颜色，含描边或阴影",
    "position": "只能是 top、center、bottom 之一",
    "alignment": "只能是 left、center、right 之一",
    "fontSizePx": 数字，基准字号（px，按 1080 宽竖版封面算）,
    "minFontSizePx": 数字，字号下限,
    "maxLines": 数字，标题最多占几行,
    "note": "其它特征（分行方式、装饰线等）"
  },
  "reply": "一句话说明你改了什么，中文，不超过 40 字"
}
⚠️ 用户没提到的字段，把输入里的原值**原样返回**，不要清空、不要编新值。
⚠️ 有改不动或说不清的地方，在 reply 里如实说明，不要假装改好了。`;

/**
 * 对标封面拆解（**视觉**模型用）—— 用户上传一张对标封面图，拆出四个角度 + 留白区域 + 标题样式。
 *
 * 用途（用户口径）：二类/三类的「个性化背景风格确定」第一步。
 * 四个角度是文档明确指定的（`COVER_ANALYSIS_ANGLES`：画风 / 元素 / 排版 / 视觉风格），别改。
 *
 * 🔴 与其它 Agent 同一条纪律（§6.3⑪）：只写图上**确实看到**的，看不到的留空、不要编。
 */
export const BENCHMARK_COVER_ANALYSIS_PROMPT = `你在拆解一张**对标封面图**，供后续模仿它的风格生成自家账号的个性化封面背景。
只描述你在图上确实看到的内容，不要推测、不要补全想象出来的元素。
必须返回合法 JSON 对象，不要加任何解释文字，字段如下：
{
  "artStyle": "画风：写实照片 / 插画 / 3D / CG / 手绘等，以及色调与光影特征",
  "elements": "画面里的主要元素（人物、道具、图形等），用顿号分隔",
  "layout": "版式：主体与文字各占哪一块，视觉重心在哪",
  "visualStyle": "整体视觉风格与氛围（例如 商务稳重 / 强对比冲击 / 极简干净）",
  "reservedAreas": ["图上预留出来放文字或人物的区域，例如「上方三分之一：标题位」"],
  "titleStyle": {
    "fontFamily": "标题字体类别特征（例如 粗黑体 / 书法体 / 圆体）",
    "fontSize": "标题相对画面的大小（例如 很大，约占画面高度五分之一）",
    "color": "标题文字颜色，以及有没有描边或阴影",
    "position": "只能是 top、center、bottom 之一",
    "alignment": "只能是 left、center、right 之一",
    "note": "标题的其它特征（分行方式、强调色、装饰线等）"
  },
  "summary": "一句话总结这张封面的风格要点"
}
图上没看到的字段一律留空字符串，**不要编造**。`;

/**
 * 2.3 结尾钩子库分析。
 *
 * 与 GOLD_THREE_SECONDS_PROMPT 同构，但看的是**结尾**而不是开头。
 *
 * ⚠️ 两个关键点，改之前先读：
 *   ① 输入里的 transcript 是**结尾片段**（提取时用了 `-sseof`），不是整条口播，
 *      更不是开场 —— 不要在这条链路上复用「开场」的措辞和判断习惯。
 *   ② 原因只能建立在该大类自己的 coreFunction / keywords 上，
 *      **不要**从账号定位、人设定位、用户画像角度解释（那是模块 1.2 的活）。
 */
export const ENDING_HOOKS_PROMPT = `你是短视频“结尾钩子”研究分析专家。你将读取一个对标账号已经完成的内容分类报告，以及该报告里的**全部**样本视频（最多 60 条），完成结尾文案提取与结尾类型判断。

结尾类型只有以下 5 种，每种都要按给定口径判断（"典型强度"是该类型常见的钩子力度，供参考）：

${ENDING_HOOK_GUIDE}

一条视频只能选一个主类型：选最贴合该结尾真实作用的那一个，不要为了凑分布而分散。

任务要求：
1. 对每个输入视频提取**结尾**对应的原文或最接近结尾的文案。
   **部分样本带有 transcript 字段** —— 那是从视频**结尾几秒**的音频真实转写（或视频理解）得到的口播原文。规则分两种：
   - **有 transcript 的样本：endingText 必须取自 transcript 的结尾原文**，按证据完整度给 confidence（引用准确时可用 high 或 medium）。绝对不要用 title 或 sourceText 替代 transcript，也不要改写、润色或拼接。
   - **没有 transcript 的样本**：sourceText 可能只是发布文案/描述，不一定是完整口播转写；如果无法确认真实结尾，endingText 必须使用输入中可见的最接近内容，并把 confidence 设为 low，在 evidence 中说明证据不足。
2. 为每个视频选择一个 primaryType/type。只能从 5 种类型中选择；无法稳定判断时使用“待人工复核”；
3. **以「内容大类」为单位组织你的解释**。原因只能建立在输入里该大类自己的 coreFunction（核心功能）和 keywords（判断核心关键词/语句）之上，回答「这个大类的这类内容，为什么用这种方式收尾」——
   例如该大类**对用户的核心吸引力**是什么（用户看完想拿到什么）、这个结尾怎么把它收住、这类内容的受众在什么心理状态下会被它抓住。
   **不要从账号定位、人设定位、用户画像的角度解释** —— 那是后续「对标账号分析」模块的工作，不是本步骤的依据；也不得编造输入中不存在的账号定位、用户画像、数据或完整脚本；
4. 针对**每一个内容主题大类**，解释该大类下的样本为什么会用这些结尾类型。
   后端会按你给每条样本的 type，统计出每个大类下各类型的实际条数并据此计算配比 ——
   **不要自己填百分比、也不要把同一套类型套到所有大类上**。你只需要给原因：
   "categoryReasons": [
     {
       "categoryName": "必须来自输入分类报告的大类名称",
       "reasons": [
         { "type": "引导转化", "reason": "结合该大类的核心功能与判断关键词，说明它为什么用这个类型收尾" }
       ]
     }
   ]
   reasons 里只列**该大类样本里真实出现过**的类型；没有可靠解释就不写这一条，不要凑数。
5. topTypes 总结本次样本**整体**最常用的 3 种有效类型，并说明原因。这是账号级汇总，**不能替代第 4 条按大类的解释**，也不要把同一套类型和同一套理由套到每个大类上。不要自行填写百分比，后端会根据每个视频的 type 重新计算；
6. 只能使用输入中已有的 videoId，不要在输出中复制标题、链接或互动数据。

严格只输出 JSON 对象，不要 Markdown、解释或前后缀，格式必须是：
{
  "accountSummary": "概括这个账号在结尾钩子上的整体做法：最依赖哪几类、它们分别在做什么",
  "items": [
    {
      "videoId": "输入样本已有的 videoId",
      "endingText": "结尾文案（有 transcript 的样本必须取自 transcript 结尾原文）",
      "type": "引导互动",
      "evidence": "为什么判断为该类型，以及证据是否完整",
      "confidence": "high"
    }
  ],
  "topTypes": [
    { "type": "金句", "reason": "这个类型在全账号范围内为什么有效（账号级汇总，不替代按大类的解释）" }
  ],
  "categoryReasons": [
    {
      "categoryName": "必须来自输入分类报告的大类名称",
      "reasons": [
        { "type": "反转", "reason": "该大类的这类内容为什么用这个类型收尾" }
      ]
    }
  ],
  "analysisReason": "整体分析依据"
}

type 也可以使用英文 key：${ENDING_HOOK_TYPE_KEYS}；待人工复核使用 review 或“待人工复核”。confidence 只能是 high、medium、low。`;

/**
 * 模块 1「对标账号分析」(1.2) —— 上层综合模块。
 *
 * ⚠️ 与 2.2 / 2.3 的口径**刻意相反**，别把它们的要求照搬过来：
 *   ① 2.2/2.3 明确**禁止**从账号定位、人设定位、用户画像角度解释原因；
 *      1.2 恰恰要求必须从这 4 个角度（账号定位、内容定位、人设定位、用户痛点）解释。
 *      这个模块就是干这个的。
 *   ② 2.2/2.3 的样本是全部 60 条、并要按大类出配比；
 *      1.2 只取**点赞最高的前 20 条**，产出的是「最常用 3 种类型 + 原因」，不按大类拆配比。
 *
 * ⚠️ 三条**不许违反**的诚实性要求（HANDOFF §5 点名过）：
 *   - 用户画像的人口属性（性别/年龄/职业/收入/消费习惯）**没有可靠数据源**，
 *     只能做推断，不许编出具体分布数字；没有依据就留空。
 *   - 变现产品的**定价**只有在输入里能找到依据时才能填，否则留空。
 *   - 每个叙述字段都要如实标 level：evidence / inference / manual。
 *     后端会核对：标了 evidence 的引文若在输入里找不到，会被降级成 inference。
 */
export const BENCHMARK_PROFILE_PROMPT = `你是短视频「对标账号分析」专家。你将读取一个对标账号的完整资料，产出一份账号级分析报告。

输入包含（JSON）：
- account：账号名称、主页、平台，以及 **signature（账号简介）**——「商业定位」的唯一直接依据；
- categories：该账号的内容主题大类（含 coreFunction 核心功能、keywords 判断关键词、小类与选题）；
- videos：**点赞最高的前 ${"20"} 条**样本，每条含分类归属、标题、发布文案、发布日期、互动数据；
  - 带 openingTranscript 的样本 = 视频**开头**的**真实口播转写**；
  - 带 endingTranscript 的样本 = 视频**结尾**的**真实口播转写**；
  - 带 comments 的样本 = 该视频**真实抓取的评论原文**；
- frequentTags：已按发布文案统计好的高频标签（**后端算好的，直接采用，不要重算**）；
- publishing：已按发布日期统计好的发布数量、跨度、频率、星期分布（**后端算好的，直接采用**）。

请完成以下四部分。

【一、商业定位】——通过拆解**账号简介**（signature）分析
- persona（人设定位）：按「在（赛道）有过什么（成就）的（身份）」的句式概括；
- corePain（核心痛点）：按「分享（核心内容）解决了（目标用户）的什么（用户痛点）问题」的句式概括。
- **如果 signature 为空，persona 与 corePain 的 text 必须留空、level 必须写 manual**，绝对不要靠标题猜一个简介出来。

【二、用户画像】——基于**评论区真实评论**、视频内容与互动数据
- demographics：性别、年龄、职业/行业、收入水平、消费习惯 5 项。
  **必须诚实**：这些没有平台侧的分布数据支撑，只能推断。**不要编造具体百分比或分布数字**；
  没有依据的项把 text 留空、level 写 manual。
- pains（在 xx 赛道最常遇到的问题）、goals（通过短视频、产品想要得到的结果）。
- behaviors：用户行为表，每项含 behavior（用户行为）、reason（原因）、example（举例）。
  example 要尽量引用输入里真实存在的评论或文案原句。
- 引流话术如果来自评论区，必须引用评论原文；没有抓到评论就如实留空。

【三、内容定位】——三秒分析与结尾分析
**只分析上面 videos 里那 20 条样本**，不要引入其它样本。

三秒类型只有以下 8 种，各自按给定口径判断：

${GOLD_DIMENSION_GUIDE}

结尾类型只有以下 5 种：

${ENDING_HOOK_GUIDE}

要求：
1. 每条样本只选**一个**主类型：选最贴合其真实作用的那一个，不要为了凑分布而分散；无法稳定判断时写“待人工复核”；
2. **有 openingTranscript 的样本，openingText 必须取自该转写原文**；有 endingTranscript 的样本，endingText 必须取自该转写原文。
   绝对不要用 title 或 sourceText 替代转写，也不要改写、润色或拼接；
   没有转写时才能退回发布文案，并在 evidence 里说明证据不足；
3. threeSeconds / endingHooks 各自要给出：
   - topTypes：本次样本**整体**最常用的 3 种**有效**类型，每种一句 reason（账号级汇总）；
   - reasonAngles：**必须从以下 4 个角度分别成段回答**，这是用户做人工判断的主要依据，
     四段要各说各的，不要互相重复、也不要写成空话：
     - accountPositioning（账号定位）：这个账号面向谁、解决什么，决定了它为什么依赖这几种类型；
     - contentPositioning（内容定位）：这类内容对用户的核心吸引力是什么，为什么用这几种类型承接；
     - personaPositioning（人设定位）：账号人设（来自简介）如何让这几种类型显得可信、不违和；
     - userPain（用户痛点）：目标用户处在什么心理状态下会被这几种类型抓住。
   如果简介缺失（account.signature 为空），personaPositioning 要如实说明「简介缺失，无法判断」。
4. **不要自己填任何百分比**——后端会按你给每条样本的 type 重新统计条数与占比；
5. 只能使用输入中已有的 videoId，不要在输出中复制标题、链接或互动数据。

【四、运营策略】
- publishing.analysis：输入已给出发布数量、跨度、频率与星期分布，你只负责解释**节奏规律**，
  例如是否高频、是否固定在星期几密集发布。**不要编造具体发布时段**（输入没有时刻数据就说明看不到时段）；
- trafficScripts.bio：拆解**简介**里的引流话术（目的、引流导向）；没有简介就留空并标 manual；
- trafficScripts.comments：拆解**评论区**的话术与互动导向；没抓到评论就留空并标 manual；
- monetization.products：按层级（引流产品 / 信任产品 / 核心产品 / 利润产品）列出变现产品，
  每项含 tier、product、price、positioning（产品定位）、role（在变现路径中的作用）；
  **price 只有在输入里能找到依据时才填，否则必须留空字符串**——你手里没有定价数据，编一个价格会被当成调研结论；
- monetization.path：变现路径，分步骤说明如何一层层把用户引向更深层级的产品。

【证据分级 —— 每个叙述字段都要带】
每个字段输出为 { "text": "...", "basis": ["引文"], "level": "evidence|inference|manual" }：
- evidence：有直接输入依据。此时 **basis 必须给出真能在输入里找到的原文片段**（简介原句、标题、评论原句等）。
  后端会把 basis 拿去输入里核对，**核对不上的会被降级成 inference**，所以不要声称有证据；
- inference：基于可得证据的推断（例如人口属性、用户行为原因）；
- manual：输入里没有依据、需要人工补充（此时 text 留空）。
**宁可标 manual，也不要编内容。** 一份如实标注「待人工补充」的报告，比一份看起来完整但编造的报告有用得多。

严格只输出 JSON 对象，不要 Markdown、解释或前后缀，格式必须是：
{
  "businessPositioning": {
    "persona": { "text": "在（赛道）有过（成就）的（身份）", "basis": ["简介里的原句"], "level": "evidence" },
    "corePain": { "text": "分享（核心内容）解决了（目标用户）的什么（用户痛点）问题", "basis": [], "level": "inference" },
    "summary": "商业定位整体概括"
  },
  "userProfile": {
    "demographics": [
      { "key": "gender", "label": "性别", "text": "", "basis": [], "level": "manual" },
      { "key": "age", "label": "年龄", "text": "", "basis": [], "level": "manual" },
      { "key": "occupation", "label": "职业/行业", "text": "", "basis": [], "level": "inference" },
      { "key": "income", "label": "收入水平", "text": "", "basis": [], "level": "manual" },
      { "key": "consumption", "label": "消费习惯", "text": "", "basis": [], "level": "manual" }
    ],
    "pains": { "text": "该赛道用户最常遇到的问题", "basis": [], "level": "inference" },
    "goals": { "text": "用户想得到的结果", "basis": [], "level": "inference" },
    "behaviors": [
      { "behavior": "收藏 / 转发视频", "reason": "为什么", "example": "举例（尽量引用输入里的真实文案或评论）", "basis": ["引文"], "level": "inference" }
    ]
  },
  "threeSeconds": {
    "items": [
      { "videoId": "输入样本已有的 videoId", "openingText": "开场文案", "type": "恐惧", "evidence": "判断依据" }
    ],
    "topTypes": [
      { "type": "恐惧", "reason": "这个类型在全账号层面为什么有效（一句话，账号级汇总）" }
    ],
    "reasonAngles": {
      "accountPositioning": "从账号定位角度：这个账号面向谁、解决什么，为什么依赖这几种 3 秒类型",
      "contentPositioning": "从内容定位角度：这类内容对用户的核心吸引力是什么，为什么用这几种类型承接",
      "personaPositioning": "从人设定位角度：简介里的人设如何让这几种类型显得可信、不违和",
      "userPain": "从用户痛点角度：目标用户处在什么心理状态下会被这几种类型抓住"
    },
    "analysisReason": "整体分析依据"
  },
  "endingHooks": {
    "items": [
      { "videoId": "输入样本已有的 videoId", "endingText": "结尾文案", "type": "引导转化", "evidence": "判断依据" }
    ],
    "topTypes": [
      { "type": "引导转化", "reason": "这个类型在全账号层面为什么有效（一句话，账号级汇总）" }
    ],
    "reasonAngles": {
      "accountPositioning": "从账号定位角度解释这几种结尾类型",
      "contentPositioning": "从内容定位角度解释这几种结尾类型",
      "personaPositioning": "从人设定位角度解释这几种结尾类型",
      "userPain": "从用户痛点角度解释这几种结尾类型"
    },
    "analysisReason": "整体分析依据"
  },
  "operationStrategy": {
    "publishing": { "analysis": "发布节奏规律的解释" },
    "trafficScripts": {
      "bio": { "text": "简介引流话术拆解", "basis": [], "level": "evidence" },
      "comments": { "text": "评论区互动话术拆解", "basis": [], "level": "manual" }
    },
    "monetization": {
      "products": [
        { "tier": "引流产品", "product": "产品名", "price": "", "positioning": "定位", "role": "在变现路径中的作用" }
      ],
      "path": [ { "step": 1, "description": "第一步如何引流" } ],
      "note": "补充说明"
    }
  }
}

三秒类型的 type 可以使用英文 key：${GOLD_TYPE_KEYS}（也可用中文：${GOLD_TYPE_NAMES}）；
结尾类型的 type 可以使用英文 key：${ENDING_HOOK_TYPE_KEYS}；无法判断一律使用 review 或“待人工复核”。`;

/**
 * 模块 2「账号定位」(1.3)：一、IP定位 / 二、账号搭建 / 三、视频选题库 / 四、短视频内容框架 /
 * 五、拍摄与剪辑建议 / 六、起号与运营（两批共六个章节，**同一份报告**）。
 *
 * ⚠️ 与 1.2 的三处**本质差别**，别照抄那边的要求：
 *   ① 1.2 分析的是**对标账号**（数据来自抓取）；1.3 服务的是**外部客户的 IP**，
 *      它的第一手依据是 `customer.ipProfile`（项目经理录入的访谈清单）、访谈原文，
 *      **以及项目经理在客户名册里写的补充说明**（`context`）—— 三者都是客户方一手输入，
 *      引文能在其中核对上就允许标 evidence。档案里为空的字段仍然**不许凭空补**：
 *      一手输入里找不到原话，就只能落 inference 或留空标 manual。
 *      实测 5 个客户只有 1 个有档案、且用户画像 8 项里 7 项为空 —— 这是常态，不是异常。
 *   ② 「选题库建立」**不重跑分类**：直接引用输入里 1.2 报告的 classification 产出。
 *      条数与占比后端会重算，你不要自己填数字。
 *   ③ 「蹭热点」这一步**没有联网能力**：热点只能凭你自己的知识给，属于推断；
 *      时效性必须交给人工核实，不许写成「今日热搜」。
 *
 * 第二批（四 / 五 / 六）另外三条：
 *   ④ 四 的钩子类型**只能**从下面的权威类型清单里选（开头 8 种 / 结尾 5 种），
 *      两组各 4 条且类型两两不同；认不出的类型后端直接丢弃并计数。
 *   ⑤ 五 是**建议不是观测**：输入里没有这个账号怎么拍、怎么剪的任何记录，
 *      后端会把这一节全部压在 inference 以内，你标 evidence 也没用（但理由要写具体）。
 *   ⑥ 六 的**起号四步与数据复盘四维是固定模板文本，你一个字都不要输出**（后端写死）；
 *      内容配比只给「大类 + 比重意图 + 理由」，**不要给百分比**（后端按最大余额法重算）。
 */
export const ACCOUNT_PLAN_PROMPT = `你是短视频账号定位专家，为外部客户 IP 产出「账号定位」方案的六个章节：一、IP定位、二、账号搭建、三、视频选题库、四、短视频内容框架、五、拍摄与剪辑建议、六、起号与运营。

输入包含（JSON），只有两份：
- customer：客户档案。ipProfile 按访谈清单分三组给出（身份信息 / 产品信息 / 用户画像），**空字符串就是客户没填**；
  filledFields / emptyFields 直接列出哪些填了、哪些是空的（以这些路径为准，不要自己猜）；
  interviewNotes 是访谈原文（可能为空、可能被截断，截断时另有说明）；
  context 是项目经理在客户名册里填的补充说明（账号定位描述 / 内容需求 / 备注 / 对标账号）。
  它与 ipProfile、访谈原文一样属于**客户方一手输入**：可以引用其中的原话作为依据，
  引文能在输入里核对上时允许标 evidence；但**不许**据它编造输入里没有的数字、案例与人群结论。
  ⚠️ 其中的 benchmarkAccounts（对标账号链接）**只由后端**填进「方法一(a) 同赛道对标账号」，
  你不要在正文里引用它，也不要输出任何账号名称或链接。
- benchmark：**已经完成的 1.2「对标账号分析」报告**。它的每个叙述字段都带 level
  （evidence = 有输入证据 / inference = 推断 / manual = 待人工补充）。
  **标着 manual 的字段不是结论**，只能当作「这里还没有信息」，不要拿它去编内容。
  其中的 classification 是该账号的内容分类（大类 → 小类 → 具体选题），**已由后端统计好条数与占比**。
  四 / 六 还要用到它的另外三块（各自带 available 标记，**为 false 就是这份 1.2 报告没有这一批
  数据，那时只能给通用建议并如实说明**，绝不许把它当成「对标账号没这么做过」）：
  - threeSeconds：1.2 的「开头 3 秒分析」（topTypes / typeDistribution / allowedTypes / analysisReason）；
  - endingHooks：1.2 的「结尾钩子分析」（同样结构，类型是另外 5 种）；
  - operationStrategy.publishing：发布时间与频率，由 1.2 从**真实发布日期**实算（不是估计值）。

请完成以下三部分。

【一、IP定位 · 1、商业定位】
1. targetAudience（目标人群）：根据 customer.ipProfile 的**用户画像**组总结凝练，
   核心是讲清楚目标用户是拥有【痛点、目的】的【谁】—— 年龄、性别、职业、收入水平等。
   这些维度请**逐项**填 audienceDimensions：${AUDIENCE_DIMENSION_NAMES}。
   **档案里哪一项为空都不许凭常识补**：只有当客户方一手输入（访谈原文 interviewNotes、
   名册补充说明 context 的 ipPositioning / contentNeeds / notes）里**确有原话**时才能填这一项，
   并把那段原话放进 basis（后端会核对：名册补充说明里的原话可以支撑 evidence，核不上的一律降级）；
   一手输入里也找不到就留空 text 并标 manual —— 宁可留空让人工去问客户，
   也绝对不许写一个看起来合理的年龄 / 性别 / 收入。
2. corePain（核心痛点）+ contentDirections（核心内容方向列表）：
   根据 IP 的行业赛道，结合 customer.ipProfile 的**产品信息**做行业垂类内容划分，
   总结出账号内容选题可涉及的几块核心内容和方向。
   例：【劳动法】赛道的夏律，核心做【企业用工咨询服务】，可涉及的核心内容有
   【劳动法新规】【用工合规】【员工手册】【劳动仲裁】等。contentDirections 就是这样一个列表。
3. monetization（变现转化）—— 模仿 1.2 报告的 operationStrategy.monetization 结构：
   - products：按**四个层级**列出变现产品，层级越深，用户决策成本越大、定价越高：
${PRODUCT_TIER_GUIDE}
     每项含 tier、product、price、positioning（产品定位）、role（在变现转化路径中的作用）。
     ⚠️ **price 只有在输入里能找到依据时才填**（客户档案的价格区间、访谈原文、或 1.2 报告里已有价格的条目），
     找不到依据**必须留空字符串** —— 你手里没有客户价目表，编一个价格会被当成调研结论直接用。
   - path：变现路径，分多个步骤，**每一步必须是这个句式**：
     ${MONETIZATION_STEP_TEMPLATE}
     例：通过免费自查表——使用户产生私信领取行为，获得引流产品。

【二、IP定位 · 2、内容定位（直接使用 1.2 报告，不要重跑分类）】
- core：总结主要的选题类型、想通过这些内容塑造什么样的人设、以及对应目标用户的什么痛点与需求。
- **选题库建立**：直接引用输入里 benchmark.classification 的产出（大类 → 小类 → 具体选题），
  **不要重新分类、不要自己统计条数或占比**（后端会重算），也不要在输出里重复整份分类表。
  每个大类的 coreFunction（核心功能）与 keywords（判断关键词）已经由 1.2 生成，属于内容定位的依据，可直接引用。

【三、IP定位 · 3、人设定位】
1. role（角色定位 / 显性人设）：一句话说清「我是谁（身份职业成就），为谁（核心用户），
   提供什么价值（痛点）」，体现专业感。**主要依据 customer.ipProfile 的身份信息**；
   身份信息为空时如实留空并标 manual，不要凭空给一个头衔。
2. personality.keywords（性格 / 隐性人设）：提炼**恰好 ${PERSONALITY_KEYWORD_COUNT} 个**核心性格关键词，
   侧重「习惯用什么表达方式」，要体现真实感以增强信任。每个关键词另给 expression（怎么表达出来）。
   给不出 ${PERSONALITY_KEYWORD_COUNT} 个就给能给的，**不要凑数、不要编经历**。
3. memoryAnchors（IP记忆锚点）：设计原则是「简单、便于高频出现、有辨识度、有记忆点」，分三类：
${MEMORY_ANCHOR_GUIDE}
   - language（语言锚点）建议句式：${LANGUAGE_ANCHOR_TEMPLATE}
   每类给 1~3 条具体建议；给不出就留空数组，让前端显示「待人工补充」。

【二、账号搭建】
1. trio（账号三件套），三项都要：
${TRIO_GUIDE}
   ⚠️ 输入里**没有客户照片**：头像只能给「拍什么、穿什么、在什么场景拍」的建议，
   不要假装已经看过照片，也不要描述照片里不存在的细节。
2. bio（账号简介）—— 出**${BIO_PLATFORM_NAMES}两版**，每版严格按下面四行结构，**每行给多个候选**（最多 ${BIO_CANDIDATES_PER_ROW} 条）：
${BIO_ROW_GUIDE}
   第四行参考 1.2 报告的 operationStrategy.trafficScripts（简介与评论区的引流话术拆解）。

【三、视频选题库】三种方法各产出一组**可直接用**的选题 / 标题：
1. benchmarkTopics（方法一：对标账号）：
   参考 benchmark.classification 的**小类选题**与 benchmark.frequentTags（高频标签）生成选题。
   ⚠️ 同赛道对标账号名单由**后端**从客户名册登记里填充（context.benchmarkAccounts），
   **你不要输出任何对标账号的名称或链接** —— 后端一律丢弃，那一项不由你决定。
2. questions（方法二：客户提问整理）：
   结合目标用户的【痛点】方向，用**目标用户的真实口吻**生成提问式选题。
   口径示例：「现在人民币贬值，我该换美元吗？」—— 是用户会问出口的话，不是标题党。
3. trends（方法三：蹭热点）：
   按 ${HOT_TOPIC_CATEGORY_NAMES} 三类，每类给出话题（topic）+ **至少一条标题示例**（titles）。
   ⚠️ ${HOT_TOPIC_DISCLAIMER}
   本组内容后端会统一标为 inference，你不要把它写成「实时热点」「今日热搜」。

【四、短视频内容框架】两组钩子，都结合**本客户的 IP 定位与内容定位**来写，
不是照抄对标账号的原话。
1. openingHooks（开头 3 秒钩子）：参考输入 benchmark.threeSeconds（1.2 的「3 秒分析」：
   topTypes 是该账号最常用的类型、typeDistribution 是 8 个类型的全部条数与占比）。
   产出**恰好 ${OPENING_HOOK_COUNT} 条**，**类型两两不同**，类型只能从下面 8 个里选：
${GOLD_DIMENSION_GUIDE}
   优先用 benchmark.threeSeconds.topTypes 里**该账号真正常用**的类型；不足 ${OPENING_HOOK_COUNT} 种时
   再从其余类型里补，并在该条的 reason 里说清为什么补它。
   每条给：type（只能是上面 8 个 key 之一，或它们的中文名）、text（**可直接照念的开头文案**，
   不要写成「可以用提问开头」这类描述）、reason（为什么这个 IP / 这类内容适合它）。
2. endingHooks（结尾钩子）：同上，参考输入 benchmark.endingHooks，产出**恰好 ${ENDING_HOOK_COUNT} 条**、
   **类型两两不同**，类型只能从下面 5 个里选：
${ENDING_HOOK_GUIDE}
   ⚠️ 规格里这一条也写成了「3 秒钩子」，那是笔误 —— 这里要的是**结尾**钩子。
   ⚠️ 两组钩子的类型**不在上面清单内、或与前一条类型重复**时，后端会**直接丢弃并计数**，
   所以宁可少给几条，也不要编一个类型出来。

【五、拍摄与剪辑建议】结合**人设定位**（角色 / 性格关键词 / 记忆锚点）与**内容定位**给建议。
⚠️ 输入里**没有任何关于这个账号实际怎么拍、怎么剪的记录**（1.2 只分析内容与运营），
所以这 9 项只能是**建议**，后端会把它们全部压在 inference 以内 —— 你标 evidence 也不会被采纳。
每项给 text（具体到能照做，例如「深色西装 + 律所书架背景，半身固定机位」）+ reason 依据。
1. shooting（拍摄风格，${PRODUCTION_SHOOTING_ITEMS.length} 项全给）：
${PRODUCTION_SHOOTING_GUIDE}
2. editing（剪辑风格，${PRODUCTION_EDITING_ITEMS.length} 项全给）：
${PRODUCTION_EDITING_GUIDE}

【六、起号与运营】
1. platformStrategy（平台与矩阵策略）：
   - primary（主阵地）/ secondary（辅阵地）：结合平台特点、IP 赛道、目标用户群体、内容定位做匹配分析后给出；
   - matchAnalysis：把匹配逻辑写清楚（为什么是这两个平台、各自承担什么角色）；
   - publish.window（固定发布时间段）/ publish.frequency（发布频率节奏）：
     参考输入 benchmark.operationStrategy.publishing —— 那是 1.2 从**真实发布日期**实算出来的
     （videoCount / datedCount / spanDays / perWeek / weekdayDistribution / hasTimeOfDay）。
     ⚠️ hasTimeOfDay=false 表示样本只有日期、没有时刻：**不要编一个「晚 8 点」**；
     可以给行业通用的时段建议，但必须说明这是通用建议、不是该账号的实测时段。
   - trafficScripts：两类各给 purpose（目的）+ direction（引流导向）+ scripts（2~3 条可直接用的话术）：
${TRAFFIC_SCRIPT_GUIDE}
2. contentMix（内容配比）：**只给每个大类的比重意图与理由，不要给百分比**（后端按最大余额法重算，
   每个时期合计恰好 100）：
   - 三个时期固定为：${CONTENT_MIX_PERIOD_NAMES}；
   - 每个时期里的大类**只能从 benchmark.classification.categories 的 name 里选**，不许发明新大类
     （对不上的后端会丢弃并计数）；
   - 每个大类给 intent（只能是：${CONTENT_MIX_INTENT_NAMES}）+ reason（为什么这个时期这样配）。
   ⚠️ 「起号策略」四步与「数据复盘重点」四维是**固定模板文本，后端直接写死**：
   你**不要输出**这两块（不要输出 launchPlan / reviewPlan），输出了也会被忽略。

【证据分级 —— 每个叙述字段都要带】
每个字段输出为 { "text": "...", "basis": ["引文"], "level": "evidence|inference|manual" }：
- evidence：有直接输入依据。此时 **basis 必须给出真能在输入里找到的原文片段**
  （客户档案里的字段值、访谈原文、1.2 报告里的字段或选题标题）。
  后端会把 basis 拿去输入里核对，**核对不上的会被降级成 inference**。
  客户档案里为空的字段**不再一律降级**：客户名册里写了补充说明时，凭其中的原话就能标 evidence；
  客户记录里连一句补充说明都没有时，这类结论后端最多给到 inference（那时能引的只剩对标账号的报告）。
  但引文必须真的支持这句话，别拿一句无关的原话去撑一个输入里根本没有的数字。
- inference：基于可得证据的推断（例如热点话题、从对标账号反推的人群）。
- manual：输入里没有依据、需要人工补充（此时 text 留空）。
**宁可标 manual，也不要编内容。** 一份如实写着「待人工补充」的方案，比一份看起来完整但编造的方案有用得多。

严格只输出 JSON 对象，不要 Markdown、解释或前后缀，格式必须是：
{
  "businessPositioning": {
    "targetAudience": { "text": "拥有（痛点、目的）的（谁）", "basis": [], "level": "inference" },
    "audienceDimensions": [
      { "key": "age", "text": "（档案里没有就留空）", "basis": [], "level": "manual" }
    ],
    "corePain": { "text": "该赛道最核心的痛点", "basis": [], "level": "inference" },
    "contentDirections": [
      { "name": "核心内容方向", "description": "这一块内容讲什么", "basis": [], "level": "inference" }
    ],
    "monetization": {
      "products": [
        { "tier": "引流产品", "product": "产品名", "price": "", "positioning": "定位", "role": "在变现路径中的作用" }
      ],
      "path": [
        { "step": 1, "description": "通过xx方法——使用户产生xx行为，购买/获得xx产品" }
      ],
      "note": "补充说明"
    },
    "summary": "商业定位整体概括"
  },
  "contentPositioning": {
    "core": { "text": "选题类型 / 想塑造的人设 / 对应的用户痛点与需求", "basis": [], "level": "inference" },
    "summary": "内容定位整体概括"
  },
  "personaPositioning": {
    "role": { "text": "我是（身份职业成就），为（核心用户）提供（价值）", "basis": [], "level": "inference" },
    "personality": {
      "keywords": [
        { "keyword": "性格关键词", "expression": "习惯用什么表达方式体现它", "basis": [], "level": "inference" }
      ]
    },
    "memoryAnchors": {
      "visual": [ { "text": "服装/道具/场景的具体建议", "basis": [], "level": "inference" } ],
      "behavior": [ { "text": "固定手势/肢体动作", "basis": [], "level": "inference" } ],
      "language": [ { "text": "口头禅/slogan/固定句式", "basis": [], "level": "inference" } ]
    },
    "summary": "人设定位整体概括"
  },
  "accountSetup": {
    "trio": {
      "name": { "text": "IP昵称 + 职业/核心痛点", "basis": [], "level": "inference" },
      "avatar": { "text": "拍摄场景与着装建议", "basis": [], "level": "inference" },
      "background": { "text": "具体是什么场景、体现什么人设特点", "basis": [], "level": "inference" }
    },
    "bio": {
      "shipinhao": [
        { "row": 1, "candidates": [ { "text": "简介候选", "basis": [], "level": "inference" } ] }
      ],
      "douyin": [
        { "row": 1, "candidates": [ { "text": "简介候选", "basis": [], "level": "inference" } ] }
      ]
    },
    "summary": "账号搭建整体概括"
  },
  "topicLibrary": {
    "benchmarkTopics": [
      { "title": "选题标题", "angle": "从 1.2 的哪个小类/标签来的", "basis": ["1.2 报告里的小类选题标题或高频标签"], "level": "evidence" }
    ],
    "questions": [
      { "title": "用户会怎么问（口语提问）", "painPoint": "对应哪个痛点", "basis": [], "level": "inference" }
    ],
    "trends": [
      { "category": "时事热点", "topic": "话题", "titles": ["标题示例"], "basis": [], "level": "inference" }
    ],
    "summary": "选题库整体概括"
  },
  "contentFramework": {
    "openingHooks": [
      { "type": "curiosity", "text": "可直接照念的开头文案", "reason": "为什么这个 IP / 这类内容适合它（结合 IP定位与内容定位）", "basis": [], "level": "inference" }
    ],
    "endingHooks": [
      { "type": "interaction", "text": "可直接照念的结尾文案", "reason": "为什么适合它", "basis": [], "level": "inference" }
    ],
    "summary": "内容框架整体概括"
  },
  "production": {
    "shooting": {
      "appearance": { "text": "出镜形象的具体建议", "reason": "依据", "basis": [], "level": "inference" },
      "wardrobe": { "text": "穿着的具体建议", "basis": [], "level": "inference" },
      "speechRate": { "text": "语速建议", "basis": [], "level": "inference" },
      "camera": { "text": "镜头建议", "basis": [], "level": "inference" },
      "scene": { "text": "场景建议", "basis": [], "level": "inference" }
    },
    "editing": {
      "footage": { "text": "素材类型建议", "basis": [], "level": "inference" },
      "music": { "text": "音乐建议", "basis": [], "level": "inference" },
      "cover": { "text": "封面建议", "basis": [], "level": "inference" },
      "subtitle": { "text": "字幕建议", "basis": [], "level": "inference" }
    },
    "summary": "拍摄与剪辑建议整体概括"
  },
  "operations": {
    "platformStrategy": {
      "primary": { "text": "主阵地平台 + 理由", "basis": [], "level": "inference" },
      "secondary": { "text": "辅阵地平台 + 理由", "basis": [], "level": "inference" },
      "matchAnalysis": { "text": "结合平台特点 / IP赛道 / 目标用户 / 内容定位的匹配分析", "basis": [], "level": "inference" },
      "publish": {
        "window": { "text": "固定发布时间段（引用 1.2 的实测数据，或说明是通用建议）", "basis": [], "level": "inference" },
        "frequency": { "text": "发布频率与节奏规律", "basis": [], "level": "inference" },
        "rhythmNote": "节奏补充说明"
      },
      "trafficScripts": {
        "comments": { "purpose": "目的", "direction": "引流导向", "scripts": [ { "text": "评论区互动话术", "basis": [], "level": "inference" } ] },
        "follow": { "purpose": "目的", "direction": "引流导向", "scripts": [ { "text": "关注引流话术", "basis": [], "level": "inference" } ] }
      }
    },
    "contentMix": {
      "periods": [
        {
          "key": "launch",
          "categories": [
            { "category": "只能取 1.2 报告里的大类名", "intent": "focus", "reason": "为什么起号期这样配", "basis": [], "level": "inference" }
          ]
        }
      ]
    },
    "summary": "起号与运营整体概括"
  }
}

audienceDimensions 的 key 只能用：${AUDIENCE_DIMENSIONS.map(item => item.key).join("、")}；
trends 的 category 只能用：${HOT_TOPIC_CATEGORIES.map(item => item.label).join("、")}（也可以用 key：${HOT_TOPIC_CATEGORIES.map(item => item.key).join("、")}）。
bio 的 row 只能是 1~4，且**四个行都要给候选**（给不出就留空数组，不要用套话凑）。
openingHooks 的 type 只能用：${GOLD_TYPE_KEYS}（缺类型或类型重复的条目后端直接丢弃）；
endingHooks 的 type 只能用：${ENDING_HOOK_TYPE_KEYS}（同上）；
contentMix 的 intent 只能用：${CONTENT_MIX_INTENTS.map(item => item.key).join("、")}。
不要输出任何视频链接、账号链接或对标账号名单；不要输出起号四步 / 数据复盘四维（模板由后端写死）。`;

// ── 发布仓三个 Agent（2026-09-21 第七轮，见 HANDOFF §0.3）─────────────────────
//
// 清单一律从 `publishWarehouse.js` 的定义派生（§6.3⑫）：三块产出的类型/角度/配额
// 在后端归一化与前端展示里都要用，两处各写一份必然漂移。

const PUBLISH_COPY_KIND_GUIDE = PUBLISH_COPY_KINDS
  .map((kind, index) => `${index + 1}. ${kind.label}（${kind.key}）—— ${kind.rule}${kind.fromAgent ? "" : "【这一类由后端复用已有内容，你不必生成】"}`)
  .join("\n");

const COVER_ANALYSIS_ANGLE_GUIDE = COVER_ANALYSIS_ANGLES
  .map((angle, index) => `${index + 1}. ${angle.label}（${angle.key}）`)
  .join("\n");

const ACCOUNT_TAG_ANGLE_GUIDE = ACCOUNT_TAG_ANGLES
  .map((angle, index) => `${index + 1}. ${angle.label}（${angle.key}）`)
  .join("\n");

/**
 * 3.1 封面 Agent。
 *
 * 文档描述了三层能力，提示词按这三层组织：
 *   ① IP 形象照（穿着/场景 ← 内容定位/职业；表情/动作 ← 人设定位）
 *   ② 对标封面拆解（画风 / 元素 / 排版 / 视觉风格）+ 留白区域
 *   ③ 每期个性化背景（围绕标题与 3 秒的关键词，关键词要在背景里有所体现）
 *
 * ⚠️ 本 Agent **只出提示词与样式模板**，不出图。出图是用户确认提示词之后
 * 由 `/api/agent/publish-cover` 的 image 阶段调出图 provider 完成的
 * ——「人工修改确认提示词后」再生成，是文档明确要求的顺序。
 */
export const PUBLISH_COVER_PROMPT = `你是短视频封面设计专家。你会拿到一个 IP 的账号规划（账号定位 / 人设定位 / 内容定位）与一条具体选题（标题、3 秒开场、脚本要点），必要时还有人工提供的对标封面图片拆解素材。请产出可直接用于 AI 出图的封面方案。

## 任务(Task)

### 一、IP 形象照提示词（ipPortrait）
按下面的对应关系推导，不要凭空编造职业或人设：
- **穿着 / 场景** ← 账号规划里的**内容定位 / 职业**
- **人物表情 / 动作** ← 账号规划里的**人设定位**
输出一个可直接出图的整段提示词（中文，包含人物、穿着、场景、表情、动作、光线、画幅）。占位符用「IP本人参考照片」这样的说法，不要编造具体长相。

### 二、对标封面拆解（backgroundAnalysis）
如果输入给了对标封面素材或描述，按下面 4 个角度拆解；**没有素材就如实留空并在 summary 里说明「未提供对标封面素材」**，不要编。
${COVER_ANALYSIS_ANGLE_GUIDE}
另外给出 **留白区域**（reservedAreas）：背景要空出来给标题文字 / 人物形象的位置。

### 三、标题样式模板（titleStyle）
给出字体、字号、颜色、位置（position 只能是 top / center / bottom / left / right 之一）、对齐方式。

### 四、每期个性化封面背景（backgrounds）
围绕该选题的**标题与 3 秒开场提取关键词**，给出 ${COVER_BACKGROUND_CANDIDATE_COUNT} 个差异化背景方案。
**关键词元素必须在背景描述中有所体现**（这是文档明确要求，不是可选）。
每个方案给出：标题式短名、关键词数组、可直接出图的整段提示词、留白区域。

## 规则(Rules)
1. **不编造账号信息**：职业、人设、受众只能来自输入；输入没给的写「待人工补充」。
2. **关键词必须落到画面**：例如关键词是「超龄用工、赔偿」，背景描述里就要出现与之相关的视觉元素。
3. **留白是硬约束**：每个背景都要明确留出放标题与人像的区域，否则文字会被压在主体上。
4. **四个背景方案要真的有差异**（构图/色调/元素至少一项明显不同），禁止只换同义词。
5. 背景提示词里**不要写具体文字内容**（文字由前端叠加，让模型写文字会写成乱码字）。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{
  "ipPortrait": { "outfitScene": "", "expressionAction": "", "prompt": "", "basis": "从账号规划的哪几项推出来的" },
  "backgroundAnalysis": { "artStyle": "", "elements": "", "layout": "", "visualStyle": "", "reservedAreas": [], "summary": "" },
  "titleStyle": { "fontFamily": "", "fontSize": "", "color": "", "position": "bottom", "alignment": "", "note": "" },
  "backgrounds": [ { "title": "", "keywords": [], "prompt": "", "reservedAreas": [] } ],
  "summary": "整体封面策略一句话"
}`;

/**
 * 3.2 发布文案 Agent。
 *
 * 🔴 **只生成金句与互动两类**。标题与 3s 用户明确要求「复用选题的」，
 * 由后端从内容生成页已选结果带进来，**不让模型再写一遍**
 * （写了会与用户已确认的内容不一致，还白花一次模型调用）。
 */
export const PUBLISH_COPY_PROMPT = `你是短视频发布文案专家。你会拿到一条已经定稿的选题（标题、3 秒开场、二创文案全文），请产出发布时使用的两类文案。

## 四类发布文案的口径（只有前两类需要你生成）
${PUBLISH_COPY_KIND_GUIDE}

## 任务(Task)
1. **金句（punchline）**：从给定文案里挑出**有信息和记忆点**的语句，改写成适合单独摘出来传播的短句。给 4 句，彼此角度不同。
2. **互动（interaction）**：围绕这个选题的主题向观众提问或引导讨论，给 4 句，彼此角度不同（问经历 / 问困惑 / 求认同 / 邀请补充）。

## 规则(Rules)
1. **不编造事实**：数字、法规、金额、案例只能来自给定文案；原文没有的不要加。
2. **金句要能独立成立**：脱离视频上下文也能看懂，不要写「正如上面所说」这种依存句。
3. **互动要有落点**：明确让观众做什么（评论区说说 / 你们厂是不是这样 / 有没有遇到过），不要写空泛的「欢迎讨论」。
4. **四句之间必须真的不同**（句式、切入点、情绪至少一项明显不同），禁止只换同义词。
5. **长度**：金句 15~40 字；互动 15~45 字。
6. **不要生成标题与 3s** —— 那两类由系统复用已有内容，你输出它们也不会被采用。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{ "punchline": ["金句1", "金句2", "金句3", "金句4"], "interaction": ["互动1", "互动2", "互动3", "互动4"] }`;

/**
 * 3.3 发布标签 Agent（两个阶段合用一个提示词，由 phase 区分）。
 *
 * 账号标签库是**账号恒定**的，确认后要持久化复用；
 * 选题标签是每轮按配比生成的。两者的输入与配比都不同，所以分两个 phase。
 */
export const PUBLISH_TAGS_PROMPT = `你是短视频标签运营专家。按下面两种任务之一产出标签；用户会指明要做哪一种。

## 任务 A：账号标签库（accountTags）
从**账号规划**出发，按三个角度**各生成 ${ACCOUNT_TAG_CANDIDATES_PER_ANGLE} 个候选**，供人工各确认 1 个作为账号恒定标签：
${ACCOUNT_TAG_ANGLE_GUIDE}
- 可以参考输入里给的对标账号高频标签，但**不要照抄**，要贴合本账号的定位。
- 候选要**短**（2~8 字），能直接当话题标签用，不要写成一句话。
- 每个角度的 ${ACCOUNT_TAG_CANDIDATES_PER_ANGLE} 个候选要**真的不同**，是并列可选项，不是同一意思的两种说法。

## 任务 B：选题标签（topicTags）
针对**这一条选题**，严格按配比生成：
- **小类（subcategory）x${TOPIC_TAG_QUOTA.subcategory}**：这条选题属于哪个内容小类（用输入给的库内小类，没有就给贴合的小类名）
- **脚本核心内容（coreContent）x${TOPIC_TAG_QUOTA.coreContent}**：脚本真正在讲的**具体**内容点，要具体到能被搜索到，不要写「用工风险」这种大词
- **目标用户（audience）x${TOPIC_TAG_QUOTA.audience}**：这条内容想触达的具体人群

## 规则(Rules)
1. **不编造**：只能依据输入给的账号规划与脚本内容；给不出就少给（系统会如实标出缺几个），**不要用套话凑数**。
2. 标签**不带 # 号**（系统统一加），不要在标签里加标点或空格。
3. 长度 2~10 字。
4. 同一个任务里的标签**不许重复**。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀。
任务 A 输出：{ "track": ["候选1", "候选2"], "painPoint": ["候选1", "候选2"], "positioning": ["候选1", "候选2"], "referenceTags": [], "summary": "" }
任务 B 输出：{ "subcategory": [], "coreContent": [], "audience": [] }`;

/**
 * 模块 4「复盘分析」的 4.1 单条视频：**判结构标签 + 写优化建议**（2026-09-30 新增）。
 *
 * 🔴 这个 Agent 的职责被**刻意切得很窄**，因为判定结论绝不能交给模型：
 *
 *   1. **判定结论由后端实算**，并作为输入喂给它（【后端已实算的判定结果】那一节）。
 *      模型的任务是解释「为什么」和给出「怎么调」，**不是**决定好坏。
 *      提示词里明确要求它不要自报结论 —— 真报了，归一化层会核对并丢弃（§6.3-⑭ 同款纪律）。
 *   2. **结构标签**（选题类型 / 3s / 标题 / 结尾钩子）由它从**文案**判 ——
 *      这一步确实需要理解语言。但类型清单**从既有定义生成**，不另立一套：
 *      3s 与标题共用那 8 个类型（用户口径：标题类型就是三秒类型），结尾钩子是那 5 个。
 *   3. **不编造**：判不出就如实说判不出（后端会落「待人工复核」），
 *      不许为了凑一个答案硬选一个类型。
 */
export const VIDEO_ANALYSIS_SUGGESTION_PROMPT = `你是短视频数据复盘专家。用户会给你**一条已发布视频**的文案、它在平台后台的真实数据、以及**后端已经算好的判定结果**。

## 你的两个任务(Tasks)

### 任务一：判断这条视频的四类结构标签
按下面的判定口径，从**文案**判断这条视频的结构类型。判不出就填 unknown，并在 reason 里说明判不出的原因 —— **不要为了给个答案硬选**。

**黄金三秒类型**（8 选 1）与**标题类型**（8 选 1，与三秒同一份口径）：
${GOLD_DIMENSION_GUIDE}

英文 key 与中文名的对应：${GOLD_TYPE_KEYS} ↔ ${GOLD_TYPE_NAMES}

**结尾钩子类型**（5 选 1）：
${ENDING_HOOK_GUIDE}

英文 key：${ENDING_HOOK_TYPE_KEYS}

**选题大类 / 小类**：只能从用户给的【本客户的选题库大类与小类】清单里选，不要自创；清单里确实没有合适的就留空字符串。

### 任务二：写优化建议
用户会给你【后端已实算的判定结果】，里面每条都写明了：实测值、标准线（优秀/优化两条）、以及判定结论（优秀 / 正常 / 需要优化 / 数据缺失）。

对**四个结构**各写两句话：
- \`why\`：结合数据说明「为什么好 / 为什么差」。**必须引用输入里给的真实数字**，不要泛泛而谈。
- \`how\`：给出**可照做**的调整动作（具体到「下次开场先抛代价数字」这种程度），不要写「优化内容质量」这种空话。

## 规则(Rules)
1. **不要自己判好坏**：结论以后端给的判定结果为准。判定是「需要优化」的，你就要解释**为什么差**；判定是「优秀」的，你就要说明**好在哪、怎么复用**。**不要把结论说反。**
2. **数据缺失的结构如实说**：如果某个结构的关键指标是「数据缺失」，就写「该项数据未提供，暂时无法判断，请补齐 XX 再复盘」，不要凭空推断。
3. **不编造数字**：只能引用输入里出现的数字。不要自己算一个百分比塞进去。
4. **不承诺效果**：不要写「这样做播放量能翻倍」这类无法兑现的话。
5. 每段文字控制在 120 字以内，具体、可执行。

## 输出格式(Output)
严格只输出 JSON 对象，不要 Markdown、解释或前后缀：
{
  "structureTags": {
    "categoryName": "从清单里选的大类名，选不出给空字符串",
    "subcategoryName": "该大类下的小类名，选不出给空字符串",
    "goldThreeSecondsType": "英文 key 或 unknown",
    "goldThreeSecondsReason": "一句话依据",
    "titleType": "英文 key 或 unknown",
    "titleReason": "一句话依据",
    "endingHookType": "英文 key 或 unknown",
    "endingHookReason": "一句话依据"
  },
  "summary": "整体一句话总结（120 字以内）",
  "structures": [
    { "key": "topicType", "why": "...", "how": "..." },
    { "key": "goldThreeSeconds", "why": "...", "how": "..." },
    { "key": "title", "why": "...", "how": "..." },
    { "key": "endingHook", "why": "...", "how": "..." }
  ]
}

约束：structures 必须**恰好四条**，key 只能是 topicType / goldThreeSeconds / title / endingHook，顺序照上面；不要输出除上述字段以外的任何字段；不要输出 verdict 或任何好坏判断字段。`;
