import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MongoClient, BSON } from 'mongodb';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

// Opt-in, process-local lookup for networks whose DNS returns proxy fake-IP records.
// Node still connects with the original hostname for TLS certificate verification.
const dnsCache = new Map();
function migrationLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (!dnsCache.has(hostname)) dnsCache.set(hostname, (async () => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Migration DNS lookup failed');
    const payload = await response.json();
    const records = (payload.Answer || []).filter(record => record.type === 1).map(record => ({ address: record.data, family: 4 }));
    if (!records.length) throw new Error(`No A records for source host ${hostname}`);
    return records;
  })());
  dnsCache.get(hostname).then(records => options?.all ? callback(null, records) : callback(null, records[0].address, 4), callback);
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceConfig = dotenv.parse(await fs.readFile(path.join(root, '.migration/source.env')));
const targetConfig = dotenv.parse(await fs.readFile(path.join(root, 'apps/server/.env')));
const source = new MongoClient(sourceConfig.MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  ...(process.env.MIGRATION_DNS_OVER_HTTPS === '1' ? { lookup: migrationLookup } : {}),
  ...(process.env.MIGRATION_SOCKS_HOST ? { proxyHost: process.env.MIGRATION_SOCKS_HOST, proxyPort: Number(process.env.MIGRATION_SOCKS_PORT || 1080) } : {}),
});
const target = new MongoClient(targetConfig.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const sourceDb = source.db(sourceConfig.MONGODB_DB_NAME);
const targetDb = target.db(targetConfig.MONGODB_DB_NAME);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(root, '.migration', `mongo-${stamp}`);
const serialize = value => BSON.EJSON.stringify(value, { relaxed: false });

async function fingerprint(db, name) {
  const hash = createHash('sha256');
  let count = 0;
  for await (const doc of db.collection(name).find().sort({ _id: 1 })) {
    hash.update(serialize(doc) + '\n');
    count++;
  }
  return { count, sha256: hash.digest('hex') };
}

try {
  if (!/^mongodb:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):/.test(targetConfig.MONGODB_URI)) {
    throw new Error('This migration only writes to a local MongoDB target.');
  }
  await Promise.all([source.connect(), target.connect()]);
  if ((await targetDb.listCollections().toArray()).length) {
    throw new Error('Target database is not empty; refusing to overwrite existing data.');
  }
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const collections = (await sourceDb.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name));
  if (collections.some(c => c.type !== 'collection')) throw new Error('Views require an explicit migration plan.');
  const manifest = { sourceDatabase: sourceDb.databaseName, targetDatabase: targetDb.databaseName, createdAt: stamp, collections: [], verified: false };
  // Export the complete source before any target writes. BSON types and collection options are retained.
  for (const [i, collection] of collections.entries()) {
    const file = `${i}.ejsonl`;
    const handle = await fs.open(path.join(backup, file), 'wx', 0o600);
    const hash = createHash('sha256');
    let count = 0;
    try {
      for await (const document of sourceDb.collection(collection.name).find().sort({ _id: 1 })) {
        const line = serialize(document) + '\n';
        await handle.write(line);
        hash.update(line);
        count++;
      }
    } finally { await handle.close(); }
    manifest.collections.push({ name: collection.name, file, options: collection.options, indexes: await sourceDb.collection(collection.name).listIndexes().toArray(), count, sha256: hash.digest('hex') });
  }
  const manifestPath = path.join(backup, 'manifest.ejson');
  await fs.writeFile(manifestPath, serialize(manifest), { mode: 0o600 });
  for (const item of manifest.collections) {
    const sourceNow = await fingerprint(sourceDb, item.name);
    if (sourceNow.sha256 !== item.sha256 || sourceNow.count !== item.count) throw new Error(`Source changed during export: ${item.name}`);
    await targetDb.createCollection(item.name, item.options);
    const data = await fs.readFile(path.join(backup, item.file), 'utf8');
    if (createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(`Backup checksum mismatch: ${item.name}`);
    const docs = data.split('\n').filter(Boolean).map(line => BSON.EJSON.parse(line, { relaxed: false }));
    for (let offset = 0; offset < docs.length; offset += 500) await targetDb.collection(item.name).insertMany(docs.slice(offset, offset + 500));
    const indexes = item.indexes.filter(index => index.name !== '_id_').map(({ v, ns, ...index }) => index);
    if (indexes.length) await targetDb.collection(item.name).createIndexes(indexes);
    const actual = await fingerprint(targetDb, item.name);
    if (actual.count !== item.count || actual.sha256 !== item.sha256) throw new Error(`Target reconciliation failed: ${item.name}`);
    console.log(JSON.stringify({ collection: item.name, count: item.count, contentMatch: true }));
  }
  // A second source check detects writers while the copy was being restored.
  for (const item of manifest.collections) {
    const actual = await fingerprint(sourceDb, item.name);
    if (actual.sha256 !== item.sha256 || actual.count !== item.count) throw new Error(`Source changed during restore: ${item.name}`);
  }
  manifest.verified = true;
  manifest.passwordMigrations = [];
  for await (const employee of targetDb.collection('employees').find({ password: { $exists: true } })) {
    const legacy = String(employee.password || '');
    const existingHash = String(employee.passwordHash || '');
    if (!existingHash && !legacy) throw new Error(`Employee has no usable credential: ${employee._id}`);
    if (existingHash && !/^\$2[aby]\$\d{2}\$/.test(existingHash)) throw new Error(`Unknown password hash format: ${employee._id}`);
    const passwordHash = existingHash || await bcrypt.hash(legacy, 12);
    if (!existingHash && !await bcrypt.compare(legacy, passwordHash)) throw new Error('Password migration verification failed');
    await targetDb.collection('employees').updateOne({ _id: employee._id }, { $set: { passwordHash }, $unset: { password: '' } });
    manifest.passwordMigrations.push(String(employee._id));
  }
  manifest.completedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, serialize(manifest), { mode: 0o600 });
  await fs.writeFile(path.join(root, '.migration/latest.json'), JSON.stringify({ backup, collections: manifest.collections.length, documents: manifest.collections.reduce((n, c) => n + c.count, 0), verified: true, passwordMigrations: manifest.passwordMigrations.length }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ backup, collections: manifest.collections.length, reconciled: true, passwordMigrations: manifest.passwordMigrations.length }));
} finally {
  await Promise.allSettled([source.close(), target.close()]);
}
