import { MongoClient, ObjectId } from "mongodb";

/**
 * 客户名册（`customers` 集合）的读取层 —— 模块 2「账号定位」(1.3) 的第一份输入。
 *
 * 🔴 这个集合与其它集合的**隔离规则刻意不同**（2026-09-18 实测定论，别再改）：
 *   - 它在**同一个库**里（`MONGODB_DB_NAME` 为空时就是连接串默认库 `test`，有真实数据），
 *     不在 `ai-project-assistant` 库里 —— 那边只有 employees / invitecodes / projects / tasks。
 *   - `customers` **没有 `ownerId` / `managerId`**：它是公司共用的客户名册，
 *     **绝不能按 managerId 过滤**（按 managerId 过滤会让所有客户都读不到）。
 *     权限收口放在端点层：只做 manager-only。
 *
 * 数据极其稀疏，**别指望字段有值**：实测 5 个客户里只有 1 个有 `ipProfile`，
 * 那一个里 `userProfile` 8 项只填了 1 项、`identity` 只填了 3 项、`product.priceRange` 为空。
 * 所以这里做的只有两件事：**把每个字段归一成去空白的字符串**（永不为 undefined），
 * 以及**如实统计哪些字段是空的** —— 下游（1.3 的报告）要靠这个覆盖率决定
 * 「哪些结论只能是推断、哪些必须落待人工补充」。
 */

const COLLECTION = "customers";

/**
 * 访谈原文的落库上限。
 *
 * 实测完整访谈 4150 字；6000 字足够容纳一份完整访谈，同时防止某天有人把几万字的
 * 逐字稿贴进这个字段、把 1.3 的输入与报告一起撑爆。**超长时如实打 `rawNotesTruncated`
 * 标记**，而不是悄悄截断让下游以为拿到了全文。
 */
export const IP_PROFILE_INTERVIEW_LIMIT = 6000;

/**
 * `ipProfile` 的字段清单 —— 与项目经理录入的《IP账号规划访谈信息采集清单》一一对应。
 * 这份定义是**唯一来源**：报告字段覆盖率的统计、提示词里「哪些字段是空的」的说明、
 * 以及前端展示的分组标题都从它生成，不要再在别处手写一遍。
 */
export const IP_PROFILE_GROUPS = [
  {
    key: "identity",
    label: "一、身份信息",
    fields: [
      { key: "name", label: "姓名" },
      { key: "age", label: "年龄" },
      { key: "mbti", label: "MBTI" },
      { key: "personaContrast", label: "人设反差" },
      { key: "occupation", label: "职业" },
      { key: "yearsExperience", label: "从业年限" },
      { key: "keyCases", label: "代表案例" },
    ],
  },
  {
    key: "product",
    label: "二、产品信息",
    fields: [
      { key: "businessModel", label: "商业模式" },
      { key: "productType", label: "产品类型" },
      { key: "priceRange", label: "价格区间" },
      { key: "coreAdvantages", label: "核心优势" },
    ],
  },
  {
    key: "userProfile",
    label: "三、用户画像",
    fields: [
      { key: "gender", label: "性别" },
      { key: "age", label: "年龄" },
      { key: "occupationIndustry", label: "职业/行业" },
      { key: "incomeLevel", label: "收入水平" },
      { key: "consumptionHabits", label: "消费习惯" },
      { key: "consumptionScenarios", label: "消费场景" },
      { key: "painPoints", label: "痛点" },
      { key: "goalsNeeds", label: "目标/需求" },
    ],
  },
];

let clientPromise;

const asText = value => String(value ?? "").trim();

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

/** 覆盖率统计里展示用的字段值长度上限：报告不该为了「让人看一眼」而背上整段 keyCases。 */
const COVERAGE_VALUE_LIMIT = 300;

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

const customerObjectId = id => {
  const value = asText(id);
  if (!ObjectId.isValid(value)) {
    const error = new Error("Invalid customer id");
    error.status = 400;
    throw error;
  }
  return new ObjectId(value);
};

/**
 * 把 `ipProfile` 归一化成**每个字段都是去空白字符串**的形状。
 *
 * 传 null / undefined / 乱类型都返回一份全空档案（而不是 null）：
 * 下游 4/5 的客户根本没有档案，让它们都去判 null 只会到处漏。
 * 有没有档案由 `coverage.hasAnyValue` 与列表接口的 `hasProfile` 回答。
 */
export const normalizeIpProfile = raw => {
  const source = raw && typeof raw === "object" ? raw : {};
  const groups = {};
  for (const group of IP_PROFILE_GROUPS) {
    const rawGroup = source[group.key] && typeof source[group.key] === "object" ? source[group.key] : {};
    const normalized = {};
    // 逐字段 asText：字段可能整个缺失、可能是 null、可能是数字（年龄常被录成 35）。
    for (const field of group.fields) normalized[field.key] = asText(rawGroup[field.key]);
    groups[group.key] = normalized;
  }

  const interview = source.interview && typeof source.interview === "object" ? source.interview : {};
  const fullNotes = asText(interview.rawNotes);

  return {
    status: asText(source.status),
    schemaVersion: asText(source.schemaVersion),
    profileVersion: asText(source.profileVersion),
    identity: groups.identity,
    product: groups.product,
    userProfile: groups.userProfile,
    interview: {
      rawNotes: fullNotes.slice(0, IP_PROFILE_INTERVIEW_LIMIT),
      source: asText(interview.source),
      completedAt: toIso(interview.completedAt),
      // 原文总长度与截断标记：截了就要说出来，否则下游会以为这是完整访谈。
      rawNotesLength: fullNotes.length,
      rawNotesTruncated: fullNotes.length > IP_PROFILE_INTERVIEW_LIMIT,
    },
    updatedAt: toIso(source.updatedAt),
    confirmedAt: toIso(source.confirmedAt),
  };
};

/**
 * 档案覆盖率：哪些字段填了、哪些是空的。
 *
 * 这是 1.3 诚实性的**开关** —— 报告里凡是以某个 `ipProfile` 字段为依据的结论，
 * 都要先看这里：字段为空时那条结论**最多只能是推断**，内容为空时必须落「待人工补充」。
 */
export const describeIpProfileCoverage = profile => {
  const source = profile && typeof profile === "object" ? profile : {};
  const filled = [];
  const empty = [];

  for (const group of IP_PROFILE_GROUPS) {
    for (const field of group.fields) {
      const value = asText(source[group.key]?.[field.key]);
      const entry = {
        key: field.key,
        path: `${group.key}.${field.key}`,
        label: field.label,
        group: group.key,
        groupLabel: group.label,
        value: value.slice(0, COVERAGE_VALUE_LIMIT),
      };
      (value ? filled : empty).push(entry);
    }
  }

  const totalCount = filled.length + empty.length;
  return {
    filledCount: filled.length,
    emptyCount: empty.length,
    totalCount,
    filled,
    empty,
    hasAnyValue: filled.length > 0,
    note: filled.length > 0
      ? `访谈清单 ${totalCount} 个字段中已填 ${filled.length} 个，其余 ${empty.length} 个为空；以空字段为依据的结论只能是推断或待人工补充。`
      : `访谈清单 ${totalCount} 个字段全部为空：1.3 里所有以客户档案为依据的结论都必须落「待人工补充」，不得编造年龄、性别、收入与定价。`,
  };
};

/**
 * 客户名册（**只给元数据**）。
 *
 * 列表刻意**不取 `ipProfile.interview.rawNotes`**（实测一份就 4150 字）：
 * 调用方只是想「挑一个客户」，把全部访谈原文一起拖回来会让列表白白变慢
 * —— 与报告接口「列表只给元数据、正文按 id 取」是同一条契约（HANDOFF §6.2⑥）。
 * 但**保留 `interview.source` 作为存在性标记**：某些档案可能只填了访谈区，
 * 没有这个标记就会把它误判成「没有档案」。
 */
export async function listCustomers({ limit = 200 } = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTION);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  const documents = await collection
    .find({}, {
      projection: {
        name: 1,
        occupation: 1,
        "ipProfile.status": 1,
        "ipProfile.identity": 1,
        "ipProfile.product": 1,
        "ipProfile.userProfile": 1,
        "ipProfile.interview.source": 1,
      },
    })
    // 名册是人工维护的小集合（实测 5 条），按姓名排序便于在界面上查找；
    // 没有 name 的（空串）排在最前，不影响使用。
    .sort({ name: 1, _id: 1 })
    .limit(safeLimit)
    .toArray();

  return documents.map(document => {
    const profile = normalizeIpProfile(document.ipProfile);
    const coverage = describeIpProfileCoverage(profile);
    return {
      id: String(document._id),
      name: asText(document.name),
      occupation: asText(document.occupation),
      hasProfile: Boolean(document.ipProfile && typeof document.ipProfile === "object"),
      profileStatus: profile.status,
      filledFieldCount: coverage.filledCount,
    };
  });
}

/**
 * 单个客户（含完整 `ipProfile`，含访谈原文）。
 *
 * ⚠️ 这几个非 `ipProfile` 字段（`contact` / `notes` / `benchmarkAccounts` /
 * `ipPositioning` / `contentNeeds`）的**具体类型没有实测过** —— 只实测了 `ipProfile`。
 * 所以这里做宽松归一（字符串直接用、数组用「、」连接、对象序列化），
 * **不假装它们一定是某种结构，也不给不存在的字段编一个值**。
 */
const toDisplayText = value => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(item => toDisplayText(item)).filter(Boolean).join("、");
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value).trim();
};

export async function getCustomer({ id } = {}) {
  const db = await getDb();
  const document = await db.collection(COLLECTION).findOne({ _id: customerObjectId(id) });
  if (!document) return null;

  return {
    id: String(document._id),
    name: asText(document.name),
    occupation: asText(document.occupation),
    contact: toDisplayText(document.contact),
    notes: toDisplayText(document.notes),
    benchmarkAccounts: toDisplayText(document.benchmarkAccounts),
    ipPositioning: toDisplayText(document.ipPositioning),
    contentNeeds: toDisplayText(document.contentNeeds),
    // 有没有真的录过档案（文档里存在 ipProfile）。**不要把「全空档案」当成有档案** ——
    // 归一化后的对象永远是空壳，只有这个布尔值能回答「到底录没录」。
    hasProfile: Boolean(document.ipProfile && typeof document.ipProfile === "object"),
    // 档案始终返回一份归一化后的对象（没有档案时是全空档案），下游不必到处判 null。
    ipProfile: normalizeIpProfile(document.ipProfile),
  };
}
