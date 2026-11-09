import { MongoClient, ObjectId } from "mongodb";
import { TITLE_STYLE_DEFAULTS, isCoverTierId, normalizeCssColor } from "./publishWarehouse.js";

/**
 * 发布仓的持久化 —— 账号标签库 + 每条选题的发布选择。
 *
 * 用户在发布仓里做三件事（HANDOFF §0.3）：
 *   3.1 选封面（背景候选 + 标题样式，最终出图）
 *   3.2 选发布文案（金句/标题/3s/互动 各勾选）
 *   3.3 选发布标签（账号恒定 3 个 + 每条选题 5 个）
 *
 * ── 三个集合，因为生命周期完全不同 ────────────────────────────────────────
 *
 *   `publish_account_tags`   **账号恒定**（文档原话：「作为账号恒定的标签库」）。
 *                            人工确认一次，之后每轮发布都复用它 —— 所以必须持久化，
 *                            不能每轮重生成（否则用户每轮都要重新确认一遍，且标签会漂）。
 *                            按 `{managerId, customerId}` 唯一。
 *
 *   `publish_cover_bases`    **封面基底**，同样是账号级：IP 形象照、背景风格模板、
 *                            标题样式（用户口径 1–2 个月轮换一次）。按 `{managerId, customerId}` 唯一。
 *                            ⚠️ 别把它并进 `publish_selections` —— 那是每期的，并进去就退化成
 *                            「换一条选题重新面对一遍账号级的素材」，2026-09-23 之前正是这个问题。
 *
 *   `publish_selections`      **每条选题一份**的勾选结果。换一批选题就是新的一份。
 *                            按 `{managerId, customerId, topicId}` 唯一。
 *
 * ── 隔离口径（本项目第四/五种，别和前面几种混）────────────────────────────
 * 两者都按 `managerId` 字段名存，但**实际写的是当前登录用户的 id**
 * （员工也要用发布仓，见 §0.0-B7 与 §0.1「脚本/标签分析对所有登录用户开放」同一条口径）。
 * 字段名沿用 `managerId` 是为了与全项目其它 store 保持一致（`ownerObjectId` 同一套）。
 * **员工之间互不可见**：A 的发布选择 B 读不到。
 */

const ACCOUNT_TAGS_COLLECTION = "publish_account_tags";
const SELECTIONS_COLLECTION = "publish_selections";
const COVER_BASES_COLLECTION = "publish_cover_bases";

/** 一条选题最多留几个封面/文案候选（防止前端塞进来一个巨型数组）。 */
const MAX_COVER_CANDIDATES = 12;
const MAX_COPY_OPTIONS = 12;
// 候选上限按每类计算；选择结果跨四类，不能共用单类的上限。
const MAX_COPY_SELECTIONS = MAX_COPY_OPTIONS * 4;
const MAX_TAGS = 20;
/** 参考图/生成图的 data URL 可能很大 —— 只存 URL 或截断后的 data URL。 */
/**
 * 单张图的 dataUrl 上限（字符数）。
 *
 * ⚠️ 这个值必须能装下**出图网关产出的 2K 图**：实测一张 2K PNG 约 2.86MB，
 *    base64 后约 5MB 字符。原来定 4_000_000 时，生成图会被**截断**成损坏的 base64，
 *    而损坏的图再拿去当参考图就会被网关拒（`invalid_reference_image`，
 *    2026-09-24 实测：候选的 dataUrl 字符数正好卡在 4_000_000）。
 */
const MAX_IMAGE_URL_CHARS = 8_000_000;

/** 图片字段：只接受 url 或 dataUrl。 */
const normalizeImageRef = value => {
  const source = value && typeof value === "object" ? value : {};
  const url = asText(source.url);
  const dataUrl = asText(source.dataUrl);
  if (!url && !dataUrl) return null;
  // 🔴 **绝不截断**：截断出来的 base64 是损坏数据 —— 预览可能还糊得出，发给网关却报
  //    「参考图无效」，排查方向完全错（2026-09-24 实测踩了一整轮）。
  //    也**不静默丢弃**：丢了用户只会看到候选莫名其妙没了图。
  //    超限就直接拒绝保存并说清怎么办 —— 报错是可看见的，截断/静默丢失都看不见。
  //    （前端上传与出图结果都会先压图，正常走不到这里，这是最后一道闸。）
  for (const [label, text] of [["图片链接", url], ["图片数据", dataUrl]]) {
    if (text.length > MAX_IMAGE_URL_CHARS) {
      throw badRequest(
        `${label}超过存储上限（约 ${Math.round(MAX_IMAGE_URL_CHARS / 1024 / 1024)}MB 字符）。`
        + "为避免写入损坏的图片，本次保存被拒绝 —— 请先把图压到长边 1440 以内再试。",
      );
    }
  }
  return { url, dataUrl };
};

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const badRequest = message => Object.assign(new Error(message), { status: 400 });

let clientPromise;
/**
 * 关掉本模块缓存的 MongoClient。
 *
 * ⚠️ **只给测试收尾用**（生产不需要主动关）：
 *    需要真实数据库的 store 测试如果不关它，Node 进程会因为这条 keep-alive 连接
 *    **永远不退出** —— 症状是 `node --test` 挂住不动、既不报错也不结束（实测踩过）。
 *    测试里在 `t.after` 调它即可。
 */
export const closeMongoClient = async () => {
  const pending = clientPromise;
  clientPromise = undefined;
  // ⚠️ 这里**不要**顺手重置索引缓存的 promise：本模块的索引缓存叫
  //    `accountTagIndexPromise` / `selectionIndexPromise` / `coverBaseIndexPromise`
  //    （不是 `indexPromise`），写错名字会在调用时抛 `ReferenceError` —— 而它偏偏在测试收尾才被调到，
  //    于是表现为「测试全过、进程不退出」，极难定位。
  if (!pending) return;
  try {
    const client = await pending;
    await client.close();
  } catch {
    // 连接本来就没建起来 / 已经关了：忽略。
  }
};

const getClient = () => {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }).connect().catch(error => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
};

const getDb = async () => {
  const client = await getClient();
  const dbName = String(process.env.MONGODB_DB_NAME || "").trim();
  return client.db(dbName || undefined);
};

const ownerObjectId = value => {
  const text = asText(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : null;
};

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

const requireOwner = value => {
  const owner = ownerObjectId(value);
  if (!owner) throw badRequest("Invalid owner identity");
  return owner;
};

const requireCustomerId = value => {
  const target = asText(value);
  if (!target) throw badRequest("customerId is required");
  return target;
};

/** 图片字段：只接受 url 或 dataUrl，且长度封顶（避免把几百 MB 写进一个文档）。 */
// ── 账号标签库 ──────────────────────────────────────────────────────────────

const serializeAccountTags = document => ({
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  /** 人工确认后的三个标签（细分赛道 / 用户核心痛点 / 内容核心定位），每角度 1 个。 */
  confirmed: {
    track: cleanText(document.confirmed?.track, 80),
    painPoint: cleanText(document.confirmed?.painPoint, 80),
    positioning: cleanText(document.confirmed?.positioning, 80),
  },
  /** 上一轮生成的候选，恢复界面时用。 */
  angles: (Array.isArray(document.angles) ? document.angles : []).map(angle => ({
    key: asText(angle?.key),
    label: asText(angle?.label),
    candidates: (Array.isArray(angle?.candidates) ? angle.candidates : []).map(item => cleanText(item, 80)).filter(Boolean),
  })),
  referenceTags: (Array.isArray(document.referenceTags) ? document.referenceTags : []).map(item => cleanText(item, 80)).filter(Boolean),
  summary: cleanText(document.summary, 400),
  updatedAt: toIso(document.updatedAt),
});

/**
 * 写账号标签库（幂等 upsert）。
 *
 * `confirmed` 是**人工确认的结果**，`angles` 是候选来源。两者都存：
 * 只存 confirmed 的话，用户下次进来想改选就看不到其它候选了。
 */
export async function saveAccountTags({ ownerId, customerId, customerName = "", angleGroups = [], confirmed = {}, referenceTags = [], summary = "" } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(ACCOUNT_TAGS_COLLECTION);
  await ensureAccountTagIndexes(collection);

  const document = {
    managerId: owner,
    customerId: target,
    customerName: cleanText(customerName, 200),
    // 字段名统一用 `angles`（serialize 也读它）—— 别再引入第二种叫法。
    angles: angleGroups.map(group => ({
      key: asText(group?.key),
      label: asText(group?.label),
      candidates: (Array.isArray(group?.candidates) ? group.candidates : []).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 8),
    })),
    confirmed: {
      track: cleanText(confirmed?.track, 80),
      painPoint: cleanText(confirmed?.painPoint, 80),
      positioning: cleanText(confirmed?.positioning, 80),
    },
    referenceTags: (Array.isArray(referenceTags) ? referenceTags : []).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 20),
    summary: cleanText(summary, 400),
    updatedAt: new Date(),
  };

  await collection.updateOne(
    { managerId: owner, customerId: target },
    {
      $set: {
        customerName: document.customerName,
        angles: document.angles,
        confirmed: document.confirmed,
        referenceTags: document.referenceTags,
        summary: document.summary,
        updatedAt: document.updatedAt,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  const saved = await collection.findOne({ managerId: owner, customerId: target });
  return serializeAccountTags(saved);
}

/** 读账号标签库。没有就返回 null（调用方据此走「首次生成」）。 */
export async function getAccountTags({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(ACCOUNT_TAGS_COLLECTION);
  await ensureAccountTagIndexes(collection);
  const document = await collection.findOne({ managerId: owner, customerId: target });
  return document ? serializeAccountTags(document) : null;
}

/** 清空账号标签库（用户想重新生成时用）。 */
export async function deleteAccountTags({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const db = await getDb();
  const result = await db.collection(ACCOUNT_TAGS_COLLECTION).deleteOne({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount > 0 };
}

let accountTagIndexPromise = null;
function ensureAccountTagIndexes(collection) {
  if (!accountTagIndexPromise) {
    accountTagIndexPromise = collection
      .createIndex({ managerId: 1, customerId: 1 }, { unique: true })
      .catch(() => {});
  }
  return accountTagIndexPromise;
}

// ── 封面基底（账号级，3.1 三类共用）──────────────────────────────────────────
//
// 🔴 为什么单独一个集合：封面基底的生命周期与「每条选题的选择」完全不同。
//    IP 形象照、背景风格模板、标题样式都是**账号级**的（用户口径：1–2 个月轮换一次），
//    而背景提示词/人像表情是**每期**的。放在一起就会出现「换一条选题就要重新面对
//    一遍账号级的东西」—— 这正是 3.1 原来让人觉得别扭的根源。
//    所以这里按 `{managerId, customerId}` 唯一，与账号标签库同一套隔离口径。

const serializeCoverBase = document => ({
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  /** 三类之一：standard | semiCustom | custom。 */
  tier: cleanText(document.tier, 40),
  /** 用户上传的图：一类是固定封面模板；二/三类是对标封面（用于拆解）。 */
  sourceImage: normalizeImageRef(document.sourceImage),
  /** 对标封面拆解（画风/元素/排版/视觉风格 + 留白区域）。一类可为空。 */
  analysis: {
    artStyle: cleanText(document.analysis?.artStyle, 500),
    elements: cleanText(document.analysis?.elements, 500),
    layout: cleanText(document.analysis?.layout, 500),
    visualStyle: cleanText(document.analysis?.visualStyle, 500),
    reservedAreas: (Array.isArray(document.analysis?.reservedAreas) ? document.analysis.reservedAreas : [])
      .map(item => cleanText(item, 300)).filter(Boolean).slice(0, 12),
    summary: cleanText(document.analysis?.summary, 600),
  },
  /** 标题样式模板（三类共用；字号是**模板参数**，逐条最终字号由 computeTitleFontSize 现算）。 */
  titleStyle: {
    fontFamily: cleanText(document.titleStyle?.fontFamily, 120),
    color: cleanText(document.titleStyle?.color, 60),
    colorDescription: cleanText(document.titleStyle?.colorDescription, 200),
    position: cleanText(document.titleStyle?.position, 40) || "bottom",
    alignment: cleanText(document.titleStyle?.alignment, 40),
    note: cleanText(document.titleStyle?.note, 300),
    fontSizePx: Number(document.titleStyle?.fontSizePx) > 0 ? Number(document.titleStyle.fontSizePx) : TITLE_STYLE_DEFAULTS.fontSizePx,
    minFontSizePx: Number(document.titleStyle?.minFontSizePx) > 0 ? Number(document.titleStyle.minFontSizePx) : TITLE_STYLE_DEFAULTS.minFontSizePx,
    maxLines: Number(document.titleStyle?.maxLines) > 0 ? Number(document.titleStyle.maxLines) : TITLE_STYLE_DEFAULTS.maxLines,
  },
  /** 背景风格模板图：一类就是上传的固定模板；二/三类是按拆解生成/确认的模板。 */
  backgroundTemplate: normalizeImageRef(document.backgroundTemplate),
  /** 生成背景时给模型看的模板描述（由拆解派生，可人工改）。 */
  backgroundPrompt: cleanText(document.backgroundPrompt, 1200),
  /** IP 人像：二类沿用固定的一张，三类可由 agent 按脚本更新表情。 */
  portrait: {
    prompt: cleanText(document.portrait?.prompt, 1200),
    basis: cleanText(document.portrait?.basis, 400),
    image: normalizeImageRef(document.portrait?.image),
  },
  updatedAt: toIso(document.updatedAt),
});

/**
 * 写封面基底（幂等 upsert）。
 *
 * `tier` 必须合法：非法就报 400，**不要静默落一个默认类型** ——
 * 类型决定了后面走哪几步，默默改掉会让用户按另一套流程出图。
 */
export async function saveCoverBase({ ownerId, customerId, customerName = "", tier = "", sourceImage = null, analysis = null, titleStyle = null, backgroundTemplate = null, backgroundPrompt = "", portrait = null } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  if (!isCoverTierId(tier)) throw badRequest(`无效的封面类型：${asText(tier) || "(空)"}`);

  const document = {
    managerId: owner,
    customerId: target,
    customerName: cleanText(customerName, 200),
    tier: asText(tier),
    sourceImage: normalizeImageRef(sourceImage),
    analysis: {
      artStyle: cleanText(analysis?.artStyle, 500),
      elements: cleanText(analysis?.elements, 500),
      layout: cleanText(analysis?.layout, 500),
      visualStyle: cleanText(analysis?.visualStyle, 500),
      reservedAreas: (Array.isArray(analysis?.reservedAreas) ? analysis.reservedAreas : []).map(item => cleanText(item, 300)).filter(Boolean).slice(0, 12),
      summary: cleanText(analysis?.summary, 600),
    },
    titleStyle: {
      fontFamily: cleanText(titleStyle?.fontFamily, 120),
      color: cleanText(titleStyle?.color, 60),
      colorDescription: cleanText(titleStyle?.colorDescription, 200),
      position: cleanText(titleStyle?.position, 40) || "bottom",
      alignment: cleanText(titleStyle?.alignment, 40),
      note: cleanText(titleStyle?.note, 300),
      fontSizePx: Number(titleStyle?.fontSizePx) > 0 ? Number(titleStyle.fontSizePx) : TITLE_STYLE_DEFAULTS.fontSizePx,
      minFontSizePx: Number(titleStyle?.minFontSizePx) > 0 ? Number(titleStyle.minFontSizePx) : TITLE_STYLE_DEFAULTS.minFontSizePx,
      maxLines: Number(titleStyle?.maxLines) > 0 ? Number(titleStyle.maxLines) : TITLE_STYLE_DEFAULTS.maxLines,
    },
    backgroundTemplate: normalizeImageRef(backgroundTemplate),
    backgroundPrompt: cleanText(backgroundPrompt, 1200),
    portrait: {
      prompt: cleanText(portrait?.prompt, 1200),
      basis: cleanText(portrait?.basis, 400),
      image: normalizeImageRef(portrait?.image),
    },
    updatedAt: new Date(),
  };

  const db = await getDb();
  const collection = db.collection(COVER_BASES_COLLECTION);
  await ensureCoverBaseIndexes(collection);

  await collection.updateOne(
    { managerId: owner, customerId: target },
    {
      $set: {
        customerName: document.customerName,
        tier: document.tier,
        sourceImage: document.sourceImage,
        analysis: document.analysis,
        titleStyle: document.titleStyle,
        backgroundTemplate: document.backgroundTemplate,
        backgroundPrompt: document.backgroundPrompt,
        portrait: document.portrait,
        updatedAt: document.updatedAt,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  const saved = await collection.findOne({ managerId: owner, customerId: target });
  return serializeCoverBase(saved);
}

/** 读封面基底。没有就返回 null（调用方据此提示「先去封面基底确认类型与素材」）。 */
export async function getCoverBase({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(COVER_BASES_COLLECTION);
  await ensureCoverBaseIndexes(collection);
  const document = await collection.findOne({ managerId: owner, customerId: target });
  return document ? serializeCoverBase(document) : null;
}

/** 清空封面基底（用户想换类型重来时用）。 */
export async function deleteCoverBase({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const db = await getDb();
  const collection = db.collection(COVER_BASES_COLLECTION);
  await ensureCoverBaseIndexes(collection);
  const result = await collection.deleteOne({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount > 0 };
}

let coverBaseIndexPromise = null;
function ensureCoverBaseIndexes(collection) {
  if (!coverBaseIndexPromise) {
    coverBaseIndexPromise = collection
      .createIndex({ managerId: 1, customerId: 1 }, { unique: true })
      .catch(() => {});
  }
  return coverBaseIndexPromise;
}

// ── 每条选题的发布选择 ──────────────────────────────────────────────────────

const normalizeCover = value => {
  const source = value && typeof value === "object" ? value : {};
  const candidates = (Array.isArray(source.candidates) ? source.candidates : [])
    .map((item, index) => {
      const image = normalizeImageRef(item?.image || item);
      if (!image) return null;
      return {
        id: cleanText(item?.id, 80) || `cover-${index + 1}`,
        title: cleanText(item?.title, 120),
        keywords: (Array.isArray(item?.keywords) ? item.keywords : []).map(k => cleanText(k, 60)).filter(Boolean).slice(0, 12),
        prompt: cleanText(item?.prompt, 1200),
        image,
        // 出这张封面时用的是哪一类。用户中途换类型时，旧封面**保留并带上当时的类型**，
        // 不能静默丢弃 —— 否则换一次类型就等于把之前出的图全删了。
        tier: cleanText(item?.tier, 40),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_COVER_CANDIDATES);
  // 🔴 颜色：模型给的是自然语言（实测「白色、橙色，无描边或阴影」），直接当 CSS 会被浏览器
  //    **静默丢弃** —— 不报错，文字只是继承成黑色。这里在**读与写两条路上都**收敛成合法
  //    CSS 值（serializeSelection 也走这个函数），所以修好之后连老数据也能正常显示；
  //    模型的原话留下来给界面当 tooltip。
  const rawColor = cleanText(source.titleStyle?.color, 60);
  const cssColor = normalizeCssColor(rawColor);
  return {
    /** 用户选中的封面 id（空串 = 还没选）。 */
    selectedId: cleanText(source.selectedId, 80),
    candidates,
    titleStyle: source.titleStyle && typeof source.titleStyle === "object" ? {
      fontFamily: cleanText(source.titleStyle.fontFamily, 120),
      color: cssColor,
      position: cleanText(source.titleStyle.position, 40),
      alignment: cleanText(source.titleStyle.alignment, 40),
      note: cleanText(source.titleStyle.note, 300),
      // 🔴 字号是**数字**（模板参数：基准 / 下限 / 行数上限）。
      //    只存旧的 `fontSize` 字符串会把它们剥掉 —— 前端读回来就拿不到基准字号，
      //    叠字只能吃兜底值（实测 48px，在缩略图里大得离谱）。2026-09-23 实测踩到。
      fontSizePx: Number(source.titleStyle.fontSizePx) > 0 ? Number(source.titleStyle.fontSizePx) : null,
      minFontSizePx: Number(source.titleStyle.minFontSizePx) > 0 ? Number(source.titleStyle.minFontSizePx) : null,
      maxLines: Number(source.titleStyle.maxLines) > 0 ? Number(source.titleStyle.maxLines) : null,
      // 模型对颜色/描边的**原始描述**（例如「白色、橙色，无描边」）。
      // 它不能当 CSS 用，但用户需要看到，所以单独留一个字段。
      // 老数据没有这个字段时，把收敛前的原话兜进来，别让信息凭空消失。
      colorDescription: cleanText(source.titleStyle.colorDescription, 200)
        || (cssColor === rawColor ? "" : rawColor),
      // 旧数据里可能只有这个字符串，留着让界面如实显示「待重新识别」。
      fontSize: cleanText(source.titleStyle.fontSize, 40),
    } : null,
  };
};

const normalizePublishCopy = value => {
  const source = value && typeof value === "object" ? value : {};
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(item => ({
      kind: cleanText(item?.kind, 40),
      label: cleanText(item?.label, 40),
      source: cleanText(item?.source, 20),
      options: (Array.isArray(item?.options) ? item.options : []).map(option => cleanText(option, 300)).filter(Boolean).slice(0, MAX_COPY_OPTIONS),
    }))
    .filter(item => item.kind);
  return {
    items,
    /** 勾选的结果：每一类选了哪几句。 */
    selected: (Array.isArray(source.selected) ? source.selected : []).map(item => cleanText(item, 300)).filter(Boolean).slice(0, MAX_COPY_SELECTIONS),
  };
};

const normalizeTags = value => {
  const source = value && typeof value === "object" ? value : {};
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .map(group => ({
      key: cleanText(group?.key, 40),
      label: cleanText(group?.label, 40),
      quota: Math.max(1, Math.min(10, Number(group?.quota) || 1)),
      tags: (Array.isArray(group?.tags) ? group.tags : []).map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, MAX_TAGS),
    }))
    .filter(group => group.key);
  return {
    groups,
    /** 勾选的结果：最终要发布的标签。 */
    selected: (Array.isArray(source.selected) ? source.selected : []).map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, MAX_TAGS),
    missing: (Array.isArray(source.missing) ? source.missing : []).map(item => cleanText(item, 60)).filter(Boolean).slice(0, 10),
  };
};

const serializeSelection = document => ({
  topicId: asText(document.topicId),
  title: cleanText(document.title, 300),
  cover: normalizeCover(document.cover),
  publishCopy: normalizePublishCopy(document.publishCopy),
  topicTags: normalizeTags(document.topicTags),
  updatedAt: toIso(document.updatedAt),
});

/** 保存提供的字段；省略的板块保留，显式 null 清空。封面只传 selectedId 时保留图片。 */
export async function savePublishSelection({ ownerId, customerId, topicId, title, cover, publishCopy, topicTags } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const topic = asText(topicId);
  if (!topic) throw badRequest("topicId is required");

  const db = await getDb();
  const collection = db.collection(SELECTIONS_COLLECTION);
  await ensureSelectionIndexes(collection);

  const now = new Date();
  const updates = { updatedAt: now };
  const defaults = {
    createdAt: now,
    title: "",
    cover: normalizeCover(null),
    publishCopy: normalizePublishCopy(null),
    topicTags: normalizeTags(null),
  };
  if (title !== undefined) {
    updates.title = cleanText(title, 300);
    delete defaults.title;
  }
  if (cover !== undefined) {
    const selectionOnly = cover && typeof cover === "object"
      && Object.keys(cover).length === 1 && Object.hasOwn(cover, "selectedId");
    if (selectionOnly) updates["cover.selectedId"] = cleanText(cover.selectedId, 80);
    else updates.cover = normalizeCover(cover);
    delete defaults.cover;
  }
  if (publishCopy !== undefined) {
    updates.publishCopy = normalizePublishCopy(publishCopy);
    delete defaults.publishCopy;
  }
  if (topicTags !== undefined) {
    updates.topicTags = normalizeTags(topicTags);
    delete defaults.topicTags;
  }
  await collection.updateOne(
    { managerId: owner, customerId: target, topicId: topic },
    {
      $set: updates,
      $setOnInsert: defaults,
    },
    { upsert: true },
  );
  const saved = await collection.findOne({ managerId: owner, customerId: target, topicId: topic });
  return serializeSelection(saved);
}

/** 取某个客户下**全部**选题的发布仓选择（发布仓要一次展示整批）。 */
export async function listPublishSelections({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(SELECTIONS_COLLECTION);
  await ensureSelectionIndexes(collection);
  const documents = await collection
    .find({ managerId: owner, customerId: target })
    .sort({ updatedAt: -1 })
    .limit(120)
    .toArray();
  return documents.map(serializeSelection);
}

/** 只清某一条选题（用户重跑这条）。 */
export async function deletePublishSelection({ ownerId, customerId, topicId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const topic = asText(topicId);
  if (!topic) throw badRequest("topicId is required");
  const db = await getDb();
  const result = await db.collection(SELECTIONS_COLLECTION).deleteOne({ managerId: owner, customerId: target, topicId: topic });
  return { deleted: result.deletedCount > 0 };
}

/** 清空该客户下当前用户的全部发布仓选择。 */
export async function clearPublishSelections({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const db = await getDb();
  const result = await db.collection(SELECTIONS_COLLECTION).deleteMany({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount };
}

let selectionIndexPromise = null;
function ensureSelectionIndexes(collection) {
  if (!selectionIndexPromise) {
    selectionIndexPromise = collection
      .createIndex({ managerId: 1, customerId: 1, topicId: 1 }, { unique: true })
      .catch(() => {});
  }
  return selectionIndexPromise;
}
