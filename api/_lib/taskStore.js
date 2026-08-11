import { MongoClient, ObjectId } from "mongodb";

let clientPromise;

const getClient = () => {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }).connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
};

const shanghaiTodayWindow = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const start = new Date(`${value.year}-${value.month}-${value.day}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
};

const normalizeTask = (task) => ({
  _id: String(task._id),
  customerName: String(task.customerName || ""),
  customerOccupation: String(task.customerOccupation || ""),
  contact: String(task.contact || ""),
  ownerName: String(task.owner?.name || "未分配"),
  platformName: String(task.platformName || "未设置"),
  collaborationPeriod: task.collaborationPeriod || {},
  notes: String(task.notes || ""),
  ipPositioning: String(task.ipPositioning || ""),
  contentDirection: String(task.contentDirection || ""),
  benchmarkAccounts: String(task.benchmarkAccounts || ""),
  contentRequirements: Array.isArray(task.contentRequirements) ? task.contentRequirements.filter(Boolean) : [],
  priority: ["low", "medium", "high"].includes(task.priority) ? task.priority : "medium",
  status: ["pending", "in_progress", "completed"].includes(task.status) ? task.status : "pending",
});

export const isTaskUserId = (value) => ObjectId.isValid(String(value || ""));

export async function isActiveTaskUser(userId) {
  if (!isTaskUserId(userId)) return false;
  const client = await getClient();
  const mongoDbName = String(process.env.MONGODB_DB_NAME || "").trim();
  const employee = await client.db(mongoDbName || undefined).collection("employees").findOne(
    { _id: new ObjectId(String(userId)), status: { $ne: "disabled" } },
    { projection: { _id: 1 } },
  );
  return Boolean(employee);
}

export async function getTodayTasksForUser(userId) {
  if (!isTaskUserId(userId)) throw new Error("Invalid task user identity");

  const client = await getClient();
  const mongoDbName = String(process.env.MONGODB_DB_NAME || "").trim();
  const db = client.db(mongoDbName || undefined);
  const { start, end } = shanghaiTodayWindow();
  const tasks = await db.collection("tasks").aggregate([
    {
      $match: {
        ownerId: new ObjectId(String(userId)),
        status: "pending",
        "collaborationPeriod.start": { $lte: end },
        "collaborationPeriod.end": { $gte: start },
      },
    },
    {
      $lookup: {
        from: "employees",
        localField: "ownerId",
        foreignField: "_id",
        as: "owner",
      },
    },
    { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
    { $sort: { priority: -1, createdAt: -1 } },
    {
      $project: {
        customerName: 1,
        customerOccupation: 1,
        contact: 1,
        "owner.name": 1,
        platformName: 1,
        collaborationPeriod: 1,
        notes: 1,
        ipPositioning: 1,
        contentDirection: 1,
        benchmarkAccounts: 1,
        contentRequirements: 1,
        priority: 1,
        status: 1,
      },
    },
  ]).toArray();

  return tasks.map(normalizeTask);
}
