import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const { code } = transformSync(readFileSync(new URL('../../web/src/app/publishSelectionDraft.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node20' });
const { PublishSelectionDrafts } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const memory = () => {
  const map = new Map();
  return { map, getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
};
const topic = { id: 't1', title: 'Topic' };
const initial = () => ({
  topicId: topic.id, title: topic.title, updatedAt: '',
  cover: { selectedId: 'old', candidates: [{ id: 'old', title: 'cover', image: { dataUrl: 'data:image/png;base64,DO_NOT_CACHE', url: '' } }], titleStyle: null },
  publishCopy: { items: [{ kind: 'quote', options: ['a', 'b', 'c'] }], selected: [] },
  topicTags: { groups: [], selected: [], missing: [] },
});
const merge = (selection, patch) => ({ ...selection, ...patch, cover: { ...selection.cover, ...patch.cover } });
const scope = { userId: 'user1', customerId: 'customer1' };
const turn = () => new Promise(resolve => setImmediate(resolve));
const copy = selected => ({ publishCopy: { items: initial().publishCopy.items, selected } });

test('immediate state, serial requests, coalesced latest snapshots and stale response protection', async () => {
  let remote = initial();
  const requests = [];
  const deferred = [];
  const drafts = new PublishSelectionDrafts(scope, [topic], memory(), async (id, title, patch) => {
    requests.push(structuredClone(patch));
    await new Promise(resolve => deferred.push(resolve));
    remote = merge(remote, patch);
    return structuredClone(remote);
  });
  drafts.hydrate([remote]);
  const first = drafts.update(topic.id, copy(['a']));
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a']);
  await turn();
  const second = drafts.update(topic.id, current => copy([...current.publishCopy.selected, 'b']));
  const third = drafts.update(topic.id, current => copy([...current.publishCopy.selected, 'c']));
  const cover = drafts.update(topic.id, { cover: { selectedId: 'new' } });
  assert.equal(requests.length, 1);
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a', 'b', 'c']);
  deferred.shift()();
  await turn();
  assert.equal(requests.length, 2);
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a', 'b', 'c']);
  assert.equal(drafts.get(topic.id).cover.selectedId, 'new');
  assert.deepEqual(requests[1].cover, { selectedId: 'new' });
  deferred.shift()();
  await Promise.all([first, second, third, cover]);
  assert.deepEqual(remote.publishCopy.selected, ['a', 'b', 'c']);
  assert.equal(drafts.snapshot().unsaved.length, 0);
  drafts.hydrate([initial()]);
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a', 'b', 'c']);
});

test('failed save retains safe draft; refresh overlays only changed fields; retry clears cache', async () => {
  const storage = memory();
  let fail = true;
  let remote = initial();
  const requests = [];
  const save = async (id, title, patch) => {
    requests.push(patch);
    if (fail) throw new Error('temporary failure');
    remote = merge(remote, patch);
    return structuredClone(remote);
  };
  const drafts = new PublishSelectionDrafts(scope, [topic], storage, save);
  drafts.hydrate([remote]);
  await assert.rejects(drafts.update(topic.id, copy(['a'])), /temporary failure/);
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a']);
  assert.equal(drafts.snapshot().unsaved.length, 1);
  assert.equal(storage.map.size, 1);
  assert.ok(![...storage.map.values()][0].includes('DO_NOT_CACHE'));
  assert.deepEqual(Object.keys(requests[0]), ['publishCopy']);
  const restored = new PublishSelectionDrafts(scope, [topic], storage, save);
  const latest = initial();
  latest.cover.candidates.push({ id: 'new-remote', image: { url: 'https://example.test/new.png' } });
  restored.hydrate([latest]);
  assert.deepEqual(restored.get(topic.id).publishCopy.selected, ['a']);
  assert.equal(restored.get(topic.id).cover.candidates.length, 2);
  fail = false;
  await restored.flush();
  assert.equal(storage.map.size, 0);
  assert.equal(Object.keys(restored.snapshot().errors).length, 0);
});

test('cached text and selected cover id are isolated by user, customer and topic', async () => {
  const storage = memory();
  const save = async () => { throw new Error('offline'); };
  const drafts = new PublishSelectionDrafts(scope, [topic], storage, save);
  drafts.hydrate([initial()]);
  await assert.rejects(drafts.update(topic.id, {
    cover: { selectedId: 'chosen' }, ...copy(['a']), topicTags: { groups: [], selected: ['tag'], missing: [] },
  }));
  assert.deepEqual(JSON.parse([...storage.map.values()][0]).patch.cover, { selectedId: 'chosen' });
  assert.ok(![...storage.map.values()][0].includes('base64'));
  for (const other of [{ ...scope, userId: 'user2' }, { ...scope, customerId: 'customer2' }]) {
    const isolated = new PublishSelectionDrafts(other, [topic], storage, save);
    assert.deepEqual(isolated.get(topic.id).publishCopy.selected, []);
  }
  const otherTopic = new PublishSelectionDrafts(scope, [{ ...topic, id: 't2' }], storage, save);
  assert.deepEqual(otherTopic.get('t2').publishCopy.selected, []);
});

test('storage quota failure is visible while network persistence still succeeds', async () => {
  let release;
  const badStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const drafts = new PublishSelectionDrafts(scope, [topic], badStorage, async (id, title, patch) => {
    await new Promise(resolve => { release = resolve; });
    return merge(initial(), patch);
  });
  const saved = drafts.update(topic.id, copy(['a']));
  assert.match(drafts.snapshot().cacheError, /缓存/);
  await turn();
  release();
  await saved;
  assert.equal(drafts.snapshot().cacheError, '');
});

test('flush rejects while save fails, preserving drafts for navigation/export guards', async () => {
  const drafts = new PublishSelectionDrafts(scope, [topic], memory(), async () => { throw new Error('offline'); });
  await assert.rejects(drafts.update(topic.id, copy(['a'])));
  await assert.rejects(drafts.flush(), /offline/);
  assert.deepEqual(drafts.get(topic.id).publishCopy.selected, ['a']);
});

test('global flush includes new edits to an already-finished topic while another is pending', async () => {
  const releases = new Map();
  const topics = [topic, { id: 't2', title: 'Other topic' }];
  const drafts = new PublishSelectionDrafts(scope, topics, memory(), async (id, title, patch) => {
    await new Promise(resolve => releases.set(id, resolve));
    return merge({ ...initial(), topicId: id, title }, patch);
  });
  const first = drafts.update('t1', copy(['a']));
  const second = drafts.update('t2', copy(['b']));
  let finished = false;
  const all = drafts.flush().then(() => { finished = true; });
  await turn();
  releases.get('t1')();
  await first;
  const next = drafts.update('t1', copy(['a', 'c']));
  await turn();
  releases.get('t2')();
  await second;
  await turn();
  assert.equal(finished, false, 'new edit must keep the global barrier waiting');
  releases.get('t1')();
  await Promise.all([all, next]);
  assert.equal(finished, true);
  assert.equal(drafts.snapshot().unsaved.length, 0);
});

test('unmounted queue cannot overwrite the cache of a newly mounted page', async () => {
  const storage = memory();
  let release;
  let oldWrites = 0;
  const old = new PublishSelectionDrafts(scope, [topic], storage, async (id, title, patch) => {
    oldWrites += 1;
    await new Promise(resolve => { release = resolve; });
    return merge(initial(), patch);
  });
  const unsubscribe = old.subscribe(() => {});
  const inFlight = old.update(topic.id, copy(['a']));
  const rejected = assert.rejects(inFlight, /页面已切换/);
  await turn();
  const queued = old.update(topic.id, copy(['a', 'b']));
  const queuedRejected = assert.rejects(queued, /页面已切换/);
  unsubscribe();
  const current = new PublishSelectionDrafts(scope, [topic], storage, async (id, title, patch) => merge(initial(), patch));
  await current.update(topic.id, copy(['c']));
  assert.equal(storage.map.size, 0);
  release();
  await Promise.all([rejected, queuedRejected]);
  assert.equal(oldWrites, 1, 'old queue must not send its second request');
  assert.equal(storage.map.size, 0, 'old queue must not rewrite the new page cache');
  const restored = new PublishSelectionDrafts(scope, [topic], storage, async () => initial());
  assert.deepEqual(restored.get(topic.id).publishCopy.selected, []);
  // React StrictMode reuses the instance after effect cleanup.
  const stop = old.subscribe(() => {});
  assert.equal(old.snapshot().unsaved.length, 1);
  stop();
});

test('failed generated cover cannot be restored as an orphan selection id', async () => {
  const storage = memory();
  const drafts = new PublishSelectionDrafts(scope, [topic], storage, async () => { throw new Error('offline'); });
  drafts.hydrate([initial()]);
  await assert.rejects(drafts.update(topic.id, {
    cover: { selectedId: 'unsaved-cover', candidates: [{ id: 'unsaved-cover', image: { dataUrl: 'data:image/png;base64,DO_NOT_CACHE' } }], titleStyle: null },
    ...copy(['a']),
  }));
  const cached = JSON.parse([...storage.map.values()][0]);
  assert.equal(cached.coverNotCached, true);
  assert.equal(cached.patch.cover, undefined);
  assert.ok(!JSON.stringify(cached).includes('DO_NOT_CACHE'));
  const restored = new PublishSelectionDrafts(scope, [topic], storage, async (id, title, patch) => merge(initial(), patch));
  restored.hydrate([initial()]);
  assert.equal(restored.get(topic.id).cover.selectedId, 'old');
  assert.match(restored.snapshot().cacheError, /无法恢复/);
  await restored.flush();
  assert.equal(restored.get(topic.id).cover.selectedId, 'old');
  assert.match(restored.snapshot().cacheError, /无法恢复/);
});
