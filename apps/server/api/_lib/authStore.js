import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";

let clientPromise;

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

const normalizeLogin = value => String(value || "").trim();
const normalizeEmail = value => normalizeLogin(value).toLowerCase();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObjectId = value => ObjectId.isValid(String(value || ""));

const safeLegacyCompare = (plain, stored) => {
  const left = Buffer.from(String(plain || ""));
  const right = Buffer.from(String(stored || ""));
  return left.length === right.length && requireTimingSafeEqual(left, right);
};

const requireTimingSafeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
};

const verifyPassword = async (password, passwordHash, legacyPassword = "") => {
  if (passwordHash && /^\$2[aby]?\$\d{2}\$/.test(String(passwordHash))) {
    return bcrypt.compare(String(password), String(passwordHash));
  }
  if (legacyPassword) return safeLegacyCompare(password, legacyPassword);
  return false;
};

const serializeManager = user => ({
  id: String(user._id),
  _id: String(user._id),
  name: String(user.name || ""),
  email: normalizeEmail(user.email),
  role: "manager",
});

const serializeEmployee = employee => ({
  id: String(employee._id),
  _id: String(employee._id),
  employeeId: String(employee._id),
  name: String(employee.name || ""),
  account: String(employee.account || employee.email || ""),
  email: normalizeEmail(employee.email || ""),
  department: String(employee.department || ""),
  role: "employee",
});

const employeeLoginFilter = login => {
  const exact = normalizeLogin(login);
  const insensitive = new RegExp(`^${escapeRegex(exact)}$`, "i");
  return {
    $or: [
      { account: exact },
      { account: insensitive },
      { email: normalizeEmail(exact) },
      { email: insensitive },
    ],
  };
};

export async function authenticateCredentials({ login, password }) {
  const normalizedLogin = normalizeLogin(login);
  const plainPassword = String(password || "");
  if (!normalizedLogin || !plainPassword) return null;

  const db = await getDb();
  const manager = await db.collection("users").findOne({ email: normalizeEmail(normalizedLogin) });
  if (manager) {
    const valid = await verifyPassword(plainPassword, manager.passwordHash);
    return valid ? serializeManager(manager) : null;
  }

  const employee = await db.collection("employees").findOne(employeeLoginFilter(normalizedLogin));
  if (!employee || String(employee.status || "active") === "disabled") return null;

  const valid = await verifyPassword(plainPassword, employee.passwordHash, employee.password);
  return valid ? serializeEmployee(employee) : null;
}

export async function resolveAuthUser(claims) {
  const userId = String(claims?.userId || claims?.sub || "").trim();
  if (!isObjectId(userId)) return null;

  const db = await getDb();
  const id = new ObjectId(userId);
  if (claims?.role === "employee") {
    const employee = await db.collection("employees").findOne({ _id: id });
    if (!employee || String(employee.status || "active") === "disabled") return null;
    return serializeEmployee(employee);
  }

  if (claims?.role === "manager") {
    const manager = await db.collection("users").findOne({ _id: id });
    return manager ? serializeManager(manager) : null;
  }

  // 兼容入口项目已经签发的无 role 字段经理 JWT。
  const manager = await db.collection("users").findOne({ _id: id });
  if (manager) return serializeManager(manager);
  const employee = await db.collection("employees").findOne({ _id: id });
  if (!employee || String(employee.status || "active") === "disabled") return null;
  return serializeEmployee(employee);
}

const isInviteExpired = invite => Boolean(invite?.expiresAt && new Date(invite.expiresAt).getTime() < Date.now());

const consumeInviteCode = async rawCode => {
  const plainCode = normalizeLogin(rawCode);
  if (!plainCode) return false;

  const db = await getDb();
  const collection = db.collection("invitecodes");
  const candidates = await collection.find({ type: "manager", status: "active" }).sort({ createdAt: -1 }).toArray();

  for (const candidate of candidates) {
    if (isInviteExpired(candidate)) {
      await collection.updateOne({ _id: candidate._id, status: "active" }, { $set: { status: "disabled", updatedAt: new Date() } });
      continue;
    }
    if (!candidate.codeHash || !await bcrypt.compare(plainCode, String(candidate.codeHash))) continue;

    const result = await collection.updateOne(
      {
        _id: candidate._id,
        status: "active",
        usedCount: { $lt: Number(candidate.maxUses || 1) },
      },
      [
        {
          $set: {
            usedCount: { $add: [{ $ifNull: ["$usedCount", 0] }, 1] },
            updatedAt: new Date(),
          },
        },
        {
          $set: {
            status: {
              $cond: [
                { $gte: ["$usedCount", Number(candidate.maxUses || 1)] },
                "exhausted",
                "active",
              ],
            },
          },
        },
      ],
    );
    return result.modifiedCount === 1;
  }

  const legacyCode = String(process.env.MANAGER_INVITE_CODE || "").trim();
  return Boolean(legacyCode && plainCode === legacyCode);
};

export async function registerManager({ name, email, password, inviteCode }) {
  const cleanName = normalizeLogin(name);
  const cleanEmail = normalizeEmail(email);
  const cleanPassword = String(password || "");
  if (!cleanName || !cleanEmail || !cleanPassword || !normalizeLogin(inviteCode)) {
    const error = new Error("姓名、邮箱、密码和邀请码均为必填项");
    error.status = 400;
    throw error;
  }
  if (cleanPassword.length < 6) {
    const error = new Error("密码长度不能少于 6 位");
    error.status = 400;
    throw error;
  }
  if (!await consumeInviteCode(inviteCode)) {
    const error = new Error("邀请码无效或已失效");
    error.status = 403;
    throw error;
  }

  const db = await getDb();
  const users = db.collection("users");
  if (await users.findOne({ email: cleanEmail }, { projection: { _id: 1 } })) {
    const error = new Error("该邮箱已注册，请直接登录");
    error.status = 409;
    throw error;
  }

  const user = {
    name: cleanName,
    email: cleanEmail,
    passwordHash: await bcrypt.hash(cleanPassword, 10),
    role: "manager",
    createdAt: new Date(),
  };
  const result = await users.insertOne(user);
  return serializeManager({ ...user, _id: result.insertedId });
}
