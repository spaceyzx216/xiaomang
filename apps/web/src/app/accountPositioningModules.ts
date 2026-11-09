/**
 * 账号定位板块的模块结构 —— 全项目唯一的一份定义。
 *
 * 这个板块是「四个模块、两层」，不是一条平级的阶段直线：
 *
 *   模块 1  对标账号分析 (1.2)  ┐
 *   模块 2  账号规划     (1.3)  ┘ 复用模块 3 的产出
 *   模块 3  选题库构建          ← 2.1 / 2.2 / 2.3 / 2.4 是它的内部子步骤
 *           ├── 2.1 对标账号分类分析
 *           ├── 2.2 黄金三秒库分析
 *           ├── 2.3 结尾钩子库分析
 *           └── 2.4 正式选题库与更新筛选
 *   模块 4  复盘分析            ← 4.1 / 4.2，把真实数据倒回上游
 *           ├── 4.1 视频数据分析
 *           └── 4.2 账号数据分析
 *
 * 2026-09-17 之前这里被误解成「5 个平级阶段」，按 2.1→2.2→2.3→1.2→1.3 的顺序排成
 * 一条直线，于是 2.1～2.3 看起来像是 1.2/1.3 的前序阶段。实际上 2.x 是模块 3 的
 * 内部步骤，1.2/1.3 是复用模块 3 的上层模块 —— 编号先 2 后 1 本身就是提示。
 *
 * 同一份清单原本在 AccountPositioningPage 和 ManagerHomePage 里各写了一遍（还会各自
 * 漂移：2.3 上线时要记得同时改两处）。现在统一从这里读。
 */

export type ModuleId = "benchmark-analysis" | "account-plan" | "topic-library" | "review";
export type StepId = "classification" | "gold" | "ending" | "library" | "video-review" | "account-review";

/** 模块 3「选题库构建」内部的子步骤。 */
export type ModuleStep = {
  id: StepId;
  code: string;
  title: string;
  summary: string;
  available: boolean;
  inputs: string[];
  outputs: string[];
};

export type PositioningModule = {
  id: ModuleId;
  code: string;
  title: string;
  summary: string;
  /** 该模块复用了谁的产出；模块 3 本身是被复用的那一层，所以为空串。 */
  reuses: string;
  available: boolean;
  inputs: string[];
  outputs: string[];
  /** 只有模块 3 有子步骤；其余模块是单体功能。 */
  steps: ModuleStep[];
};

/** 选题库构建模块的 id —— 多个地方要判断「现在是不是在模块 3 里」。 */
export const TOPIC_LIBRARY_MODULE_ID: ModuleId = "topic-library";

/** 模块 1「对标账号分析」的 id。与上面同理：不要在页面里硬编码这个字符串。 */
export const BENCHMARK_ANALYSIS_MODULE_ID: ModuleId = "benchmark-analysis";

/** 模块 2「账号定位」的 id。同理：页面渲染与「已完成」标记都从这里取。 */
export const ACCOUNT_PLAN_MODULE_ID: ModuleId = "account-plan";

/** 模块 4「复盘分析」的 id。同理：不要在页面里硬编码这个字符串。 */
export const REVIEW_MODULE_ID: ModuleId = "review";

export const POSITIONING_MODULES: PositioningModule[] = [
  {
    id: "benchmark-analysis",
    code: "1.2",
    title: "对标账号分析",
    summary: "综合 IP 档案与选题库构建的产出，输出商业定位、用户画像、内容定位、高频标签与运营策略。",
    reuses: "复用「选题库构建」的产出",
    available: true,
    inputs: ["外部客户 / IP 档案", "账号基础信息", "选题库构建的产出（分类、黄金三秒、结尾钩子三份报告）"],
    outputs: ["商业定位与核心痛点", "用户画像", "内容定位", "高频标签", "运营策略与变现路径"],
    steps: [],
  },
  {
    id: "account-plan",
    code: "1.3",
    title: "账号规划",
    summary: "把 IP 档案与对标账号分析合成项目经理可审核、可修改的账号规划。",
    // 1.3 的直接输入是「客户 IP 档案 + 对标账号分析报告」，**不是**模块 3 的产出
    // （那一条是从 1.2 复制过来的错误文案，HANDOFF §4.3 第 6 条）。经 1.2 间接用到
    // 模块 3 的结果，但这里如实写它的直接输入。
    reuses: "复用「客户 IP 档案」与「对标账号分析」的产出",
    available: true,
    inputs: ["外部客户 / IP 档案", "对标账号分析报告"],
    outputs: ["账号规划（可人工审核修改）"],
    steps: [],
  },
  {
    id: "topic-library",
    code: "2.x",
    title: "选题库构建",
    summary: "抓取对标账号最新 60 条作品，依次完成分类分析、黄金三秒库分析、结尾钩子库分析，产出正式选题库。",
    reuses: "",
    available: true,
    inputs: ["对标账号主页链接", "口播类 / 演绎类分析模式"],
    outputs: ["正式选题库"],
    steps: [
      {
        id: "classification",
        code: "2.1",
        title: "对标账号分类分析",
        summary: "抓取最新 60 条作品，按口播 / 演绎两套逻辑拆分内容主题大类与小类。",
        available: true,
        inputs: ["对标账号主页链接", "口播类 / 演绎类分析模式"],
        outputs: ["分类分析报告（大类 → 小类 → 具体视频）", "重点研究样本标记"],
      },
      {
        id: "gold",
        code: "2.2",
        title: "黄金三秒库分析",
        summary: "对分类报告的全部样本（最新 60 条）逐条判断八类三秒类型，并按内容大类统计配比与原因。",
        available: true,
        inputs: ["已保存的分类分析报告"],
        outputs: ["每条样本的开场文案与三秒类型", "最常用 3 种类型", "按内容大类的推荐配比"],
      },
      {
        id: "ending",
        code: "2.3",
        title: "结尾钩子库分析",
        summary: "提取每条样本结尾几秒的真实口播，判断引导互动、引导转化、反转、金句、共鸣＋IP 符号 5 类结尾类型。",
        available: true,
        inputs: ["已保存的分类分析报告"],
        outputs: ["每条样本的结尾文案与结尾类型", "最常用 3 种结尾类型", "按内容大类的配比与原因"],
      },
      {
        // 2.4 是模块 3 的产出落地步骤：把前面几步的分析结果沉淀成客户的正式选题库，
        // 再用这个库给「近期新更新」的视频打标签。它渲染在全宽的第二行（见
        // AccountPositioningPage），与其他步骤共用同一份步骤清单。
        id: "library",
        code: "2.4",
        title: "正式选题库与更新筛选",
        summary: "把分类分析结果按客户沉淀成正式选题库（可纳入多个对标账号），再用库内的大类/小类给近期新更新、点赞达标的视频打标签。",
        available: true,
        inputs: ["已保存的分类分析报告", "客户（选题库归属）", "对标账号链接"],
        outputs: ["正式选题库（客户级，多账号各自独立分类）", "新视频完整脚本与库内大类/小类标签", "可勾选的选题列表"],
      },
    ],
  },
  {
    // 模块 4 是这条流程的**闭环**：前面三个模块都是「往里灌」（档案 → 选题库 → 规划），
    // 只有它把**自己账号的真实数据**倒回上游，纠正下一轮的选题配比与文案结构配比。
    //
    // 🔴 数据来源要说清楚：分析的是**客户自己发布的视频**，不是选题库里的对标视频。
    //    所以系统拿不到这些数据，由用户填写或从平台后台 Excel 导入。
    id: "review",
    code: "4.x",
    title: "复盘分析",
    summary: "用自己账号的真实数据反推选题与文案结构的优化方向，把人工确认的结论变成下一轮的配比。",
    reuses: "复用「选题库构建」的分类与配比",
    available: true,
    inputs: ["客户（复盘要用它的选题库做结构标签）", "真实视频数据（表单填写或 Excel 导入 / AI 识别）", "视频文案"],
    outputs: ["单条视频数据分析报告与优化建议", "一周账号数据分析周报与配比调整方案"],
    steps: [
      {
        id: "video-review",
        code: "4.1",
        title: "视频数据分析",
        summary: "填写或导入单条视频的数据与文案，按平台标准值判断哪个结构拖了后腿，产出数据分析报告与优化建议。",
        available: true,
        inputs: ["视频文案", "该视频的平台后台数据（直接填写或从 Excel 导入 / AI 识别后核对）"],
        outputs: ["数据分析报告（哪个指标高/低于标准值、对应哪个结构）", "四条文案结构的优化建议方案"],
      },
      {
        id: "account-review",
        code: "4.2",
        // 4.2 复用 4.1 的 Excel 解析与平台规则，确认后的记忆回流选题与二创。
        title: "账号数据分析",
        summary: "填写或导入一周账号数据，按流量池分层与结构标签拆解，产出周报与下周的选题/文案结构配比方案。",
        available: true,
        inputs: ["一周账号视频数据（直接填写或从 Excel 导入 / AI 识别后核对）", "每条视频的选题类型与文案结构标签"],
        outputs: ["数据分析周报（绝对数据 / 相对数据 / 流量池分层）", "下周选题配比与三类结构配比（人工确认后生效）"],
      },
    ],
  },
];

/** 按 id 取模块；取不到时回落到模块 3（唯一可执行的模块）。 */
export const findModule = (id: string) => (
  POSITIONING_MODULES.find(module => module.id === id)
  || POSITIONING_MODULES.find(module => module.id === TOPIC_LIBRARY_MODULE_ID)!
);

/** 按 id 取子步骤；取不到时回落到第一个子步骤，绝不让调用方拿到 undefined 去渲染。 */
export const findStep = (steps: ModuleStep[], id: string) => (
  steps.find(step => step.id === id) || steps[0]
);

/** 模块 3 的可执行子步骤数 / 总数，用于在模块卡片上显示完成度。 */
export const stepProgress = (module: PositioningModule, completedIds: string[]) => {
  const total = module.steps.length;
  const done = module.steps.filter(step => completedIds.includes(step.id)).length;
  return { done, total };
};
