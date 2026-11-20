/**
 * T067 文本备份核心回归测试
 *
 * 用隔离的内存存储替身驱动真实 utils/training-store.js、training-wishlist.js 与
 * training-backup.js：覆盖文本往返与摘要实读、严格拒绝（损坏/未来版本/引用错配/超限）、
 * 零写入预演、每个提交点的写前/回执丢失/读回不一致故障、重开补提交、受损原文保留、
 * 恢复后的普通写入与清缓存，以及固定合成夹具的实际 UTF-8 字节与耗时样本。
 *
 * 不访问真实微信存储、云端、文件系统或任何真实用户数据。
 * 运行：node --test tests/training-backup.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');
const BACKUP_JS = path.join(ROOT, 'utils', 'training-backup.js');
const APP_JS = path.join(ROOT, 'app.js');

// ---- 微信本地存储替身：内存 Map + 按键匹配的故障注入 ----
const storage = new Map();
const fault = {
  get: null,
  set: null,
  lose: null,
  mismatch: null,
  infoFail: false,
  setCalls: 0,
  getCalls: 0
};
let fileSystemCalls = 0;

function resetFaults() {
  fault.get = null;
  fault.set = null;
  fault.lose = null;
  fault.mismatch = null;
  fault.infoFail = false;
  fault.setCalls = 0;
  fault.getCalls = 0;
  fileSystemCalls = 0;
}

function arm(kind, match, times) {
  fault[kind] = { match, times: times === undefined ? 1 : times };
}

function consume(kind, key) {
  const rule = fault[kind];
  if (!rule || rule.times <= 0 || !rule.match(key)) return false;
  rule.times -= 1;
  return true;
}

function resetStorage() {
  storage.clear();
  resetFaults();
  store.resetLayoutCache();
}

global.wx = {
  getStorageSync(key) {
    fault.getCalls += 1;
    if (consume('get', key)) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCalls += 1;
    if (consume('set', key)) throw new Error('setStorageSync:fail injected');
    if (consume('lose', key)) {
      storage.set(key, value);
      throw new Error('setStorageSync:fail after durable write injected');
    }
    if (consume('mismatch', key)) {
      storage.set(key, value + '\u0000readback-mismatch');
      return;
    }
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    if (fault.infoFail) throw new Error('getStorageInfoSync:fail injected');
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager() {
    fileSystemCalls += 1;
    throw new Error('测试不得触碰文件系统');
  }
};

const store = require(STORE_JS);
const wishlist = require(WISHLIST_JS);
const backup = require(BACKUP_JS);

const ARCHIVE_KEY = store.ARCHIVE_KEY;
const WISHLIST_KEY = store.WISHLIST_KEY;
const PHOTO_KEY = store.PHOTO_INDEX_KEY;
const FIXED_NOW = new Date(2026, 10, 20, 9, 30, 0);

function snapshot() {
  return [...storage.entries()]
    .map(([key, value]) => [key, value])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

function stageKeyCount() {
  return [...storage.keys()].filter(key => key.indexOf(store.BACKUP_STAGE_PREFIX) === 0).length;
}

// ---- 合成夹具：跨日、同日多馆、抱石/顶绳、逐把备注、撤回与清单归档 ----
function seedFixture() {
  const s1 = store.startSession({
    gymName: '岩馆·东',
    date: '2026-11-18',
    now: new Date(2026, 10, 18, 9, 0)
  });
  assert.equal(s1.ok, true, s1.error);
  const r1 = store.createRoute({
    sessionId: s1.session.id,
    name: '黄色均衡线',
    climbType: '抱石',
    grade: 'V4',
    colorName: '黄',
    colorHex: '#e8c21a',
    now: new Date(2026, 10, 18, 9, 5)
  });
  assert.equal(r1.ok, true, r1.error);
  const a1 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'fail',
    note: '第一把：起手很滑，第二把换右脚。',
    now: new Date(2026, 10, 18, 9, 10)
  });
  assert.equal(a1.ok, true, a1.error);
  const a2 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'fail',
    note: '待撤回的备注：保留原文',
    now: new Date(2026, 10, 18, 9, 15)
  });
  assert.equal(a2.ok, true, a2.error);
  const undone = store.undoAttempt(a2.attempt.id, {
    opId: 'undo-fixture-1',
    now: new Date(2026, 10, 18, 9, 18)
  });
  assert.equal(undone.ok, true, undone.error);
  const a3 = store.saveAttempt({
    sessionId: s1.session.id,
    routeId: r1.route.id,
    result: 'send',
    note: '完成！用了 3 把，关键是“左手侧拉”。',
    now: new Date(2026, 10, 18, 9, 20)
  });
  assert.equal(a3.ok, true, a3.error);

  const s2 = store.startSession({
    gymName: '岩馆·西',
    date: '2026-11-19',
    now: new Date(2026, 10, 19, 18, 0)
  });
  assert.equal(s2.ok, true, s2.error);
  const r2 = store.createRoute({
    sessionId: s2.session.id,
    name: '蓝色耐力线',
    climbType: '顶绳',
    grade: '5.10c',
    colorName: '蓝',
    colorHex: '#2f6fe4',
    now: new Date(2026, 10, 19, 18, 5)
  });
  assert.equal(r2.ok, true, r2.error);
  const linked = store.linkRouteToSession(s2.session.id, r1.route.id);
  assert.equal(linked.ok, true, linked.error);
  const a4 = store.saveAttempt({
    sessionId: s2.session.id,
    routeId: r2.route.id,
    result: 'fail',
    note: '第二场再试蓝色线，还是没跨过第三把。',
    now: new Date(2026, 10, 19, 18, 20)
  });
  assert.equal(a4.ok, true, a4.error);
  const a5 = store.saveAttempt({
    sessionId: s2.session.id,
    routeId: r2.route.id,
    result: 'fail',
    note: '下半段泵了，休息 10 分钟再来。',
    now: new Date(2026, 10, 19, 18, 40)
  });
  assert.equal(a5.ok, true, a5.error);

  const s3 = store.startSession({
    gymName: '岩馆·南',
    date: '2026-11-19',
    now: new Date(2026, 10, 19, 20, 0)
  });
  assert.equal(s3.ok, true, s3.error);
  const r3 = store.createRoute({
    sessionId: s3.session.id,
    name: '黑色小点线',
    climbType: '抱石',
    grade: 'V2',
    now: new Date(2026, 10, 19, 20, 5)
  });
  assert.equal(r3.ok, true, r3.error);

  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  const archiveId = loaded.archive.archiveId;
  const addedA = wishlist.addWishlist(r1.route.id, { archiveId, now: new Date(2026, 10, 19, 19, 0) });
  assert.equal(addedA.ok, true, addedA.error);
  const addedB = wishlist.addWishlist(r2.route.id, { archiveId, now: new Date(2026, 10, 19, 19, 5) });
  assert.equal(addedB.ok, true, addedB.error);
  const archived = wishlist.archiveWishlist(r2.route.id, {
    archiveId,
    now: new Date(2026, 10, 19, 19, 10)
  });
  assert.equal(archived.ok, true, archived.error);

  return { archiveId, routes: [r1.route.id, r2.route.id, r3.route.id] };
}

function exportFixture() {
  const exported = backup.exportText({ now: FIXED_NOW });
  assert.equal(exported.ok, true, exported.error);
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  return { exported, preview };
}

function confirm(text, token) {
  return backup.confirmRestore(text, { confirmed: true, previewToken: token, now: FIXED_NOW });
}

beforeEach(() => {
  resetStorage();
});

// ------------------------------------------------------------------ *
// 往返、摘要实读与媒体隔离
// ------------------------------------------------------------------ *

test('T067-A 样本训练/长期线路/逐把备注/清单文本往返，摘要按实读核对', () => {
  const fixture = seedFixture();
  const beforeWrites = fault.setCalls;
  const exported = backup.exportText({ now: FIXED_NOW });
  assert.equal(exported.ok, true, exported.error);
  assert.equal(fault.setCalls, beforeWrites, '导出只读，不写任何键');

  const parsed = JSON.parse(exported.text);
  const loaded = store.loadState();
  const currentWishlist = wishlist.loadWishlist();
  assert.equal(exported.summary.archiveId, fixture.archiveId);
  assert.equal(exported.summary.gyms, loaded.archive.gyms.length);
  assert.equal(exported.summary.sessions, loaded.archive.sessions.length);
  assert.equal(exported.summary.routes, loaded.archive.routes.length);
  assert.equal(exported.summary.sessionRoutes, loaded.archive.sessionRoutes.length);
  assert.equal(exported.summary.attempts, loaded.archive.attempts.length);
  assert.equal(
    exported.summary.notes,
    loaded.archive.attempts.filter(item => item.note.length > 0).length
  );
  assert.equal(exported.summary.undone, 1);
  assert.equal(
    exported.summary.wishlist,
    currentWishlist.state.items.filter(item => item.archiveId === fixture.archiveId).length
  );
  assert.equal(exported.summary.wishlistArchived, 1);
  assert.equal(exported.summary.trainingBytes, Buffer.byteLength(JSON.stringify(parsed.training), 'utf8'));
  assert.equal(exported.summary.wishlistBytes, Buffer.byteLength(JSON.stringify(parsed.wishlist), 'utf8'));
  assert.equal(exported.summary.auxiliaryBytes, Buffer.byteLength(JSON.stringify(parsed.auxiliary), 'utf8'));
  assert.equal(
    exported.summary.totalBytes,
    exported.summary.trainingBytes + exported.summary.wishlistBytes + exported.summary.auxiliaryBytes
  );
  assert.equal(exported.bytes, Buffer.byteLength(exported.text, 'utf8'));
  assert.deepEqual(parsed.contents.includes, backup.INCLUDED);
  assert.deepEqual(parsed.contents.excludes, backup.EXCLUDED);
  assert.equal(parsed.auxiliary.counters.nextSessionSeq, loaded.archive.nextSessionSeq);
  assert.equal(parsed.auxiliary.activeSelection.sessionId, loaded.archive.activeSessionId);

  // 预演零写入。
  const beforePreview = fault.setCalls;
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.token, backup.previewToken(exported.text));
  assert.equal(fault.setCalls, beforePreview, '预演不写活动键');

  // 恢复到独立空档：新 archiveId、清单归属重绑、备注/撤回/计数一致。
  resetStorage();
  const freshPreview = backup.inspectText(exported.text);
  assert.equal(freshPreview.ok, true, freshPreview.error);
  const photoIndex = JSON.stringify({ version: 1, photos: [], routes: [], operations: [] });
  storage.set(PHOTO_KEY, photoIndex);
  const confirmed = confirm(exported.text, freshPreview.token);
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.committed, true);
  assert.notEqual(confirmed.rebindArchiveId, fixture.archiveId);

  const restored = store.loadState();
  const restoredWishlist = wishlist.loadWishlist();
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.present, true);
  assert.equal(restored.archive.archiveId, confirmed.rebindArchiveId);
  assert.equal(restoredWishlist.ok, true, restoredWishlist.error);
  assert.equal(restored.archive.sessions.length, exported.summary.sessions);
  assert.equal(restored.archive.routes.length, exported.summary.routes);
  assert.equal(restored.archive.attempts.length, exported.summary.attempts);
  assert.equal(
    restored.archive.attempts.filter(item => item.undoneAt).length,
    exported.summary.undone
  );
  assert.deepEqual(
    restored.archive.attempts.map(item => item.note).sort(),
    loaded.archive.attempts.map(item => item.note).sort()
  );
  assert.ok(
    restoredWishlist.state.items.every(item => item.archiveId === confirmed.rebindArchiveId),
    '清单条目必须重绑到新档案归属'
  );
  assert.equal(restoredWishlist.state.items.length, exported.summary.wishlist);
  assert.equal(
    restoredWishlist.state.items.filter(item => item.archivedAt).length,
    exported.summary.wishlistArchived
  );

  // 旧媒体索引原样保留，且整个恢复过程不碰文件系统。
  assert.equal(storage.get(PHOTO_KEY), photoIndex);
  assert.equal(fileSystemCalls, 0);
  assert.equal(storage.has(ARCHIVE_KEY), false, '目标空档的旧键没有被伪造');
  assert.equal(storage.has(WISHLIST_KEY), false);
});

test('T067-B 旧档结构兼容：缺省可选字段可导出/恢复，原键不被改写', () => {
  const oldArchive = {
    version: 1,
    archiveId: 'archive-old-1',
    nextGymSeq: 2,
    nextSessionSeq: 2,
    nextRouteSeq: 2,
    nextAttemptSeq: 3,
    gyms: [{ id: 'gym-1', name: '旧岩馆' }],
    sessions: [
      {
        id: 'session-1',
        seq: 1,
        gymId: 'gym-1',
        date: '2026-11-01',
        createdAt: '2026-11-01T01:00:00.000Z'
      }
    ],
    routes: [{ id: 'route-1', seq: 1, gymId: 'gym-1', name: '旧线', grade: 'V3' }],
    sessionRoutes: [{ sessionId: 'session-1', routeId: 'route-1' }],
    attempts: [
      {
        id: 'op-old-1',
        seq: 1,
        sessionId: 'session-1',
        routeId: 'route-1',
        result: 'send',
        note: '旧版完攀备注',
        createdAt: '2026-11-01T01:10:00.000Z'
      },
      {
        id: 'op-old-2',
        seq: 2,
        sessionId: 'session-1',
        routeId: 'route-1',
        result: 'fail',
        note: '',
        createdAt: '2026-11-01T01:20:00.000Z'
      }
    ]
  };
  const oldArchiveText = JSON.stringify(oldArchive);
  storage.set(ARCHIVE_KEY, oldArchiveText);

  const exported = backup.exportText({ now: FIXED_NOW });
  assert.equal(exported.ok, true, exported.error);
  assert.equal(exported.summary.notes, 1);
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);

  const confirmed = confirm(exported.text, preview.token);
  assert.equal(confirmed.ok, true, confirmed.error);
  const restored = store.loadState().archive;
  assert.equal(restored.archiveId, confirmed.rebindArchiveId);
  assert.equal(restored.attempts.length, 2);
  assert.equal(restored.attempts[0].note, '旧版完攀备注');
  assert.equal(restored.attempts[0].rev, undefined, '不凭空补 rev');
  assert.equal(restored.attempts[0].settledOps, undefined, '不凭空补 settledOps');
  assert.equal(restored.routes[0].climbType, undefined, '不凭空补类型');
  assert.equal(storage.get(ARCHIVE_KEY), oldArchiveText, '旧 archive 键原样保留');
});

test('T067-C 恢复后普通档案/清单写入跟随新代际，旧键与清缓存边界保持不变', () => {
  const fixture = seedFixture();
  const legacyArchiveBefore = storage.get(ARCHIVE_KEY);
  const legacyWishlistBefore = storage.get(WISHLIST_KEY);
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  const confirmed = confirm(exported.text, preview.token);
  assert.equal(confirmed.ok, true, confirmed.error);

  const layout = store.resolveLayout();
  assert.equal(layout.ok, true);
  assert.equal(layout.legacy, false);
  assert.notEqual(layout.archiveKey, ARCHIVE_KEY);

  const started = store.startSession({
    gymName: '岩馆·北',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 10, 0)
  });
  assert.equal(started.ok, true, started.error);
  const added = wishlist.addWishlist(restoredRouteId(), {
    archiveId: confirmed.rebindArchiveId,
    now: new Date(2026, 10, 20, 10, 5)
  });
  assert.equal(added.ok, true, added.error);

  assert.equal(storage.get(ARCHIVE_KEY), legacyArchiveBefore, '旧 archive 键不被普通写入改写');
  assert.equal(storage.get(WISHLIST_KEY), legacyWishlistBefore, '旧 wishlist 键不被普通写入改写');
  assert.equal(storage.has(ARCHIVE_KEY), true);

  // 模拟重开：清进程内布局缓存后仍从提交键选到同一代，并读到刚写的场次。
  store.resetLayoutCache();
  const reloaded = store.loadState();
  assert.equal(reloaded.ok, true, reloaded.error);
  assert.equal(reloaded.archive.archiveId, confirmed.rebindArchiveId);
  assert.equal(reloaded.archive.sessions.some(item => item.id === started.session.id), true);

  // 普通清缓存只清可重建前缀，新代际、提交记录、旧键与照片索引都保留。
  storage.set(store.NAMESPACE + 'cache.list', 'cache');
  storage.set(store.NAMESPACE + 'thumbs.test', 'thumb');
  const photo = JSON.stringify({ version: 1, photos: [], routes: [], operations: [] });
  storage.set(PHOTO_KEY, photo);
  const cleared = store.clearRebuildableStorage();
  assert.equal(cleared.ok, true, cleared.error);
  assert.deepEqual(cleared.removed.sort(), [
    store.NAMESPACE + 'cache.list',
    store.NAMESPACE + 'thumbs.test'
  ]);
  assert.equal(storage.has(layout.archiveKey), true);
  assert.equal(storage.has(layout.wishlistKey), true);
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), true);
  assert.equal(storage.get(ARCHIVE_KEY), legacyArchiveBefore);
  assert.equal(storage.get(WISHLIST_KEY), legacyWishlistBefore);
  assert.equal(storage.get(PHOTO_KEY), photo);
  assert.equal(store.isProtectedKey(layout.archiveKey), true);
  assert.equal(store.isProtectedKey(store.BACKUP_COMMIT_KEY), true);
  assert.equal(store.isProtectedKey(store.BACKUP_PENDING_KEY), true);

  function restoredRouteId() {
    const current = store.loadState();
    assert.equal(current.ok, true, current.error);
    return current.archive.routes[0].id;
  }
});

// ------------------------------------------------------------------ *
// 严格拒绝：零写入
// ------------------------------------------------------------------ *

function assertRejectedWithoutWrites(text, codes) {
  const beforeSnapshot = snapshot();
  const beforeWrites = fault.setCalls;
  const inspected = backup.inspectText(text);
  assert.equal(inspected.ok, false, '预演必须拒绝');
  assert.ok(codes.indexOf(inspected.code) !== -1, 'unexpected code: ' + inspected.code);
  assert.deepEqual(snapshot(), beforeSnapshot, '预演不改存储');
  assert.equal(fault.setCalls, beforeWrites, '预演不写');

  const result = backup.confirmRestore(text, {
    confirmed: true,
    previewToken: backup.previewToken(text)
  });
  assert.equal(result.ok, false, '正式恢复必须拒绝');
  assert.ok(codes.indexOf(result.code) !== -1, 'unexpected code: ' + result.code);
  assert.deepEqual(snapshot(), beforeSnapshot, '拒绝时存储逐键不变');
  assert.equal(fault.setCalls, beforeWrites, '拒绝时零写入');
}

test('T067-D 损坏、未来版本、引用错配、超限与摘要篡改都不写', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const valid = exported.text;
  const base = JSON.parse(valid);

  assertRejectedWithoutWrites(valid.slice(0, valid.length - 1), ['broken-text']);
  assertRejectedWithoutWrites('x'.repeat(backup.MAX_BACKUP_BYTES + 1), ['too-large']);

  const future = JSON.parse(valid);
  future.version = 2;
  assertRejectedWithoutWrites(JSON.stringify(future), ['unsupported-version']);

  const badAttemptRef = JSON.parse(valid);
  badAttemptRef.training.attempts[0].sessionId = 'session-missing';
  assertRejectedWithoutWrites(JSON.stringify(badAttemptRef), ['reference-error']);

  const badActive = JSON.parse(valid);
  badActive.auxiliary.activeSelection.sessionId = 'session-missing';
  assertRejectedWithoutWrites(JSON.stringify(badActive), ['reference-error']);

  const badListOwnership = JSON.parse(valid);
  badListOwnership.wishlist.items[0].archiveId = 'archive-other';
  assertRejectedWithoutWrites(JSON.stringify(badListOwnership), ['wishlist-ownership']);

  const badListRef = JSON.parse(valid);
  badListRef.wishlist.items[0].routeId = 'route-missing';
  assertRejectedWithoutWrites(JSON.stringify(badListRef), ['reference-error']);

  const badCounter = JSON.parse(valid);
  badCounter.auxiliary.counters.nextSessionSeq = 1;
  assertRejectedWithoutWrites(JSON.stringify(badCounter), ['invalid-schema']);

  const badSummary = JSON.parse(valid);
  badSummary.summary.notes += 1;
  assertRejectedWithoutWrites(JSON.stringify(badSummary), ['summary-mismatch']);

  // 不补写缺失 ID：缺 archiveId 直接拒绝，不生成替代身份。
  const noId = JSON.parse(valid);
  delete noId.training.archiveId;
  assertRejectedWithoutWrites(JSON.stringify(noId), ['invalid-schema']);

  const duplicateId = base;
  duplicateId.training.attempts[1].id = duplicateId.training.attempts[0].id;
  assertRejectedWithoutWrites(JSON.stringify(duplicateId), ['invalid-schema']);
});

test('T067-E 原型字段/额外字段不污染对象，也不触发写入', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const poisoned = exported.text.replace('"format":', '"__proto__":{"polluted":true},"format":');
  assertRejectedWithoutWrites(poisoned, ['invalid-schema']);
  assert.equal({}.polluted, undefined, '原型未被污染');
  assert.equal(Object.prototype.polluted, undefined);
});

test('T067-F 未确认、令牌不符与独立预演都不写活动键', () => {
  const fixture = seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);

  const before = snapshot();
  const beforeWrites = fault.setCalls;
  // 独立预演：只读，不写当前键。
  backup.inspectText(exported.text);
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites);

  const unconfirmed = backup.confirmRestore(exported.text, { previewToken: preview.token });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'confirmation-required');
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites);

  const wrongToken = backup.confirmRestore(exported.text, {
    confirmed: true,
    previewToken: 'bkp1-0000000000000000'
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.code, 'preview-required');
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites);
  assert.equal(store.loadState().archive.archiveId, fixture.archiveId, '当前档案未变');
});

// ------------------------------------------------------------------ *
// 提交点故障：写前失败、回执丢失、读回不一致
// ------------------------------------------------------------------ *

function prepareBackup() {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  // 先把当前档案清回旧档布局，再做预演：令牌绑定的是恢复发生时的代际。
  resetStorage();
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  return { text: exported.text, token: preview.token };
}

test('T067-G 恢复计划写前失败：没有任何 stage/commit，旧档可读', () => {
  const prepared = prepareBackup();
  storage.set(ARCHIVE_KEY, JSON.stringify({ version: 1, archiveId: 'archive-legacy', gyms: [], sessions: [], routes: [], attempts: [] }));
  const legacyBefore = storage.get(ARCHIVE_KEY);
  // 当前旧档是在预演之后落位的：按新规则需以这份旧档重新预演。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);
  arm('set', key => key === store.BACKUP_PENDING_KEY, 1);
  const result = confirm(prepared.text, fresh.token);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pending-write-failed');
  assert.equal(storage.has(store.BACKUP_PENDING_KEY), false);
  assert.equal(stageKeyCount(), 0);
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(storage.get(ARCHIVE_KEY), legacyBefore);
  assert.equal(store.resetLayoutCache() === undefined, true);
  assert.equal(store.loadState().archive.archiveId, 'archive-legacy');

  // 写调用成功但读回不一致：同样停在提交点之前，不产生 stage。
  arm('mismatch', key => key === store.BACKUP_PENDING_KEY, 1);
  const mismatched = confirm(prepared.text, fresh.token);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'pending-write-failed');
  assert.equal(stageKeyCount(), 0);
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(storage.get(ARCHIVE_KEY), legacyBefore);
});

test('T067-H 恢复计划回执丢失但已落盘：继续完成提交', () => {
  const prepared = prepareBackup();
  arm('lose', key => key === store.BACKUP_PENDING_KEY, 1);
  const result = confirm(prepared.text, prepared.token);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.receipt.pending, 'receipt-lost');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), true);
  assert.equal(store.loadState().ok, true);
  const pending = JSON.parse(storage.get(store.BACKUP_PENDING_KEY));
  assert.equal(store.loadState().archive.archiveId, pending.rebindArchiveId);
});

test('T067-I stage 档案写前失败/读回不一致：不提交，旧档可读且重试复用同一代', () => {
  const prepared = prepareBackup();
  arm('set', key => key.endsWith('.archive'), 1);
  const failed = confirm(prepared.text, prepared.token);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'stage-archive-write-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(store.loadState().ok, true);
  assert.equal(store.loadState().present, false, '旧档仍是首次为空');
  const pendingAfterFailure = JSON.parse(storage.get(store.BACKUP_PENDING_KEY));

  arm('mismatch', key => key.endsWith('.archive'), 1);
  const mismatched = confirm(prepared.text, prepared.token);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'stage-archive-write-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  const pendingAfterMismatch = JSON.parse(storage.get(store.BACKUP_PENDING_KEY));
  assert.equal(pendingAfterMismatch.generation, pendingAfterFailure.generation, '失败重试复用同一代');

  const retried = confirm(prepared.text, prepared.token);
  assert.equal(retried.ok, true, retried.error);
  assert.equal(stageKeyCount(), 2, '失败尝试不累积额外 stage 键');
  assert.equal(store.loadState().ok, true);
});

test('T067-J  stage 清单写前失败（第二个键）：档案与清单都不露出半提交', () => {
  const prepared = prepareBackup();
  arm('set', key => key.endsWith('.wishlist'), 1);
  const failed = confirm(prepared.text, prepared.token);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'stage-wishlist-write-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(store.loadState().ok, true);
  assert.equal(store.loadState().present, false);
  assert.equal(wishlist.loadWishlist().ok, true);
  assert.equal(wishlist.loadWishlist().present, false);
  assert.equal(stageKeyCount(), 1, '清单写前失败：只留下不可见的档案 stage，不产生提交点');

  // 重开时证据不完整：不补提交，也不删除未完成的 stage。
  store.resetLayoutCache();
  const recovered = backup.recoverPending();
  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'pending-incomplete');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(stageKeyCount(), 1);

  // 清单 stage 写调用成功但读回不一致：仍不提交；重开按校验不一致拒绝补提交。
  arm('mismatch', key => key.endsWith('.wishlist'), 1);
  const mismatched = confirm(prepared.text, prepared.token);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'stage-wishlist-write-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  store.resetLayoutCache();
  const incomplete = backup.recoverPending();
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'pending-incomplete');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(stageKeyCount(), 2);
});

test('T067-J2 stage 档案/清单回执丢失但已落盘：读回确认后继续提交', () => {
  let prepared = prepareBackup();
  arm('lose', key => key.endsWith('.archive'), 1);
  let result = confirm(prepared.text, prepared.token);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.receipt.archive, 'receipt-lost');
  assert.equal(store.loadState().ok, true);

  prepared = prepareBackup();
  arm('lose', key => key.endsWith('.wishlist'), 1);
  result = confirm(prepared.text, prepared.token);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.receipt.wishlist, 'receipt-lost');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), true);
  assert.equal(store.loadState().ok, true);
});


test('T067-K 提交键写前失败：旧档完全可读；冷启动不自动启用，显式重新预演后才恢复', () => {
  const prepared = prepareBackup();
  arm('set', key => key === store.BACKUP_COMMIT_KEY, 1);
  const failed = confirm(prepared.text, prepared.token);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'commit-write-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(store.loadState().ok, true);
  assert.equal(store.loadState().present, false);
  assert.equal(wishlist.loadWishlist().ok, true);

  // 模拟进程重开：布局缓存清空，真实启动入口只核对，不补写提交键。
  store.resetLayoutCache();
  fault.setCalls = 0;
  let app;
  global.App = page => {
    app = page;
  };
  delete require.cache[require.resolve(APP_JS)];
  require(APP_JS);
  app.onLaunch();
  assert.equal(fault.setCalls, 0, '冷启动不写任何键');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(stageKeyCount(), 2, '两份 stage 原文保留');
  assert.equal(store.loadState().present, false, '未提交的 stage 不参与读取');

  const recovered = backup.recoverPending({ now: FIXED_NOW });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.code, 'pending-staged');
  assert.equal(recovered.action, 'none');

  // 用户重新预演并显式确认后才生效，并复用失败时留下的同一代 stage。
  const pendingBefore = JSON.parse(storage.get(store.BACKUP_PENDING_KEY));
  const again = backup.inspectText(prepared.text);
  assert.equal(again.ok, true, again.error);
  const retried = confirm(prepared.text, again.token);
  assert.equal(retried.ok, true, retried.error);
  const pendingAfter = JSON.parse(storage.get(store.BACKUP_PENDING_KEY));
  assert.equal(pendingAfter.generation, pendingBefore.generation, '重试复用同一代');
  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.archive.archiveId, retried.rebindArchiveId);
});

test('T067-K2 提交失败后继续普通写入：重开不自动覆盖较新档案，重新确认仍可用', () => {
  const prepared = prepareBackup();
  arm('set', key => key === store.BACKUP_COMMIT_KEY, 1);
  const failed = confirm(prepared.text, prepared.token);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'commit-write-failed');

  // 失败后用户继续记录：普通写入落回旧键（当前仍可读）。
  const started = store.startSession({
    gymName: '提交失败后新开的馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 11, 0)
  });
  assert.equal(started.ok, true, started.error);
  const newerArchive = storage.get(ARCHIVE_KEY);

  store.resetLayoutCache();
  fault.setCalls = 0;
  const recovered = backup.recoverPending({ now: FIXED_NOW });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.code, 'pending-stale');
  assert.equal(fault.setCalls, 0, '旧档有新写入时重开不补提交');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(storage.get(ARCHIVE_KEY), newerArchive, '较新的普通写入没有被覆盖');
  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.archive.sessions.some(item => item.id === started.session.id), true);

  // 普通写入发生在预演之后：旧令牌必须失效且零写入，新场次不能被静默丢弃。
  const stale = confirm(prepared.text, prepared.token);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'preview-stale');
  assert.equal(fault.setCalls, 0, '失效令牌不写任何键');
  assert.equal(storage.get(ARCHIVE_KEY), newerArchive, '未重新预演前不覆盖较新的普通写入');

  // 用户重新预演并以确认时的当前旧档为「上一代」，正常完成恢复。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);
  const confirmed = confirm(prepared.text, fresh.token);
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.previous.archiveChecksum, backup.hashText(newerArchive));
  assert.equal(storage.get(ARCHIVE_KEY), newerArchive, '旧键仍原样保留');
});

test('T067-K3 提交键写前失败后继续普通写入：冷启动仍读旧档且新场次可见', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  const oldId = store.loadState().archive.archiveId;

  arm('set', key => key === store.BACKUP_COMMIT_KEY, 1);
  const failed = confirm(exported.text, preview.token);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'commit-write-failed');

  // 失败后用户继续记录：普通写入仍落在旧档。
  const started = store.startSession({
    gymName: '失败后新开的馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 11, 0)
  });
  assert.equal(started.ok, true, started.error);
  const newerArchive = storage.get(ARCHIVE_KEY);

  // 实际启动入口重走一遍：不启用未提交的 stage，也不覆盖较新的旧档。
  store.resetLayoutCache();
  fault.setCalls = 0;
  let app;
  global.App = page => {
    app = page;
  };
  delete require.cache[require.resolve(APP_JS)];
  require(APP_JS);
  app.onLaunch();
  assert.equal(fault.setCalls, 0, '冷启动不写任何键');
  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.archive.archiveId, oldId);
  assert.equal(loaded.archive.sessions.some(item => item.id === started.session.id), true);
  assert.equal(storage.get(ARCHIVE_KEY), newerArchive);
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
  assert.equal(stageKeyCount(), 2, '未提交的 stage 只保留原文，不参与读取');

  const recovered = backup.recoverPending({ now: FIXED_NOW });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.code, 'pending-stale');
  assert.equal(fault.setCalls, 0, '旧档变化后冷启动仍不写');
});

test('T067-K4 提交键已落盘但读回暂时失败：不退回旧档，普通写入与冷读跟随同一新代', () => {
  const prepared = prepareBackup();
  arm('get', key => key === store.BACKUP_COMMIT_KEY, 1);
  const uncertain = confirm(prepared.text, prepared.token);
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.code, 'commit-unknown');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), true, '提交键实际已持久化');

  // 提交点写出过（即使回执读不到），旧令牌已作废。
  const replay = confirm(prepared.text, prepared.token);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'preview-stale');

  // 读回恢复正常后，同进程公开读取按持久提交选代；随后普通写入落在新代。
  const warm = store.resolveLayout();
  assert.equal(warm.ok, true, warm.error);
  assert.equal(warm.legacy, false);
  const started = store.startSession({
    gymName: '回执不确定后新开的馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 12, 0)
  });
  assert.equal(started.ok, true, started.error);

  // 冷读（清布局缓存）与热读选择同一代，并读得到刚写的场次。
  store.resetLayoutCache();
  const cold = store.loadState();
  assert.equal(cold.ok, true, cold.error);
  assert.equal(cold.archive.archiveId, warm.record.archiveId);
  assert.equal(cold.archive.sessions.some(item => item.id === started.session.id), true);
  assert.equal(storage.has(ARCHIVE_KEY), false, '不把未提交的半成品写回旧键');
});

test('T067-V 已使用的预演令牌不能重复恢复；重新预演后可再次恢复', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  const first = confirm(exported.text, preview.token);
  assert.equal(first.ok, true, first.error);

  const before = snapshot();
  const beforeWrites = fault.setCalls;
  const replay = confirm(exported.text, preview.token);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'preview-stale');
  assert.deepEqual(snapshot(), before, '重复确认零写入');
  assert.equal(fault.setCalls, beforeWrites, '重复确认零写入');

  // 用户重新预演并确认是允许的，且会得到新的隔离归属。
  const next = backup.inspectText(exported.text);
  assert.equal(next.ok, true, next.error);
  const latest = confirm(exported.text, next.token);
  assert.equal(latest.ok, true, latest.error);
  assert.notEqual(first.rebindArchiveId, latest.rebindArchiveId);
});

test('T067-W 同一代际内活动档案在预演后普通写入：旧令牌失效且零写入，重新预演可恢复', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  const layout = store.resolveLayout();
  assert.equal(layout.ok, true, layout.error);
  assert.equal(layout.legacy, true, '本用例覆盖未恢复的旧键代际');
  const archiveBefore = storage.get(layout.archiveKey);

  // 预演之后、确认之前发生普通写入：同代际，不触发代际切换。
  const started = store.startSession({
    gymName: '预演后同代际新馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 13, 0)
  });
  assert.equal(started.ok, true, started.error);
  const archiveAfter = storage.get(layout.archiveKey);
  assert.notEqual(archiveAfter, archiveBefore);

  const before = snapshot();
  const beforeWrites = fault.setCalls;
  const stale = confirm(exported.text, preview.token);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'preview-stale');
  assert.deepEqual(snapshot(), before, '令牌失效时存储逐键不变');
  assert.equal(fault.setCalls, beforeWrites, '令牌失效时零写入');
  assert.equal(storage.get(layout.archiveKey), archiveAfter, '新写入的档案原文原样保留');
  const stillThere = store.loadState();
  assert.equal(stillThere.ok, true, stillThere.error);
  assert.equal(
    stillThere.archive.sessions.some(item => item.id === started.session.id),
    true,
    '预演后的新场次没有被静默丢弃'
  );

  // 以更新后的当前数据重新预演：确认成功，旧原文作为上一代逐字保护。
  const fresh = backup.inspectText(exported.text);
  assert.equal(fresh.ok, true, fresh.error);
  const restored = confirm(exported.text, fresh.token);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.previous.archivePresent, true);
  assert.equal(restored.previous.archiveBytes, backup.utf8Bytes(archiveAfter));
  assert.equal(restored.previous.archiveChecksum, backup.hashText(archiveAfter));
});

test('T067-X 同一代际内清单在预演后普通写入：旧令牌失效且零写入，重新预演可恢复', () => {
  const fixture = seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  const layout = store.resolveLayout();
  assert.equal(layout.legacy, true);
  const archiveBefore = storage.get(layout.archiveKey);
  const wishlistBefore = storage.get(layout.wishlistKey);

  // 只改清单：档案原文保持不变。
  const archiveId = store.loadState().archive.archiveId;
  const added = wishlist.addWishlist(fixture.routes[2], {
    archiveId,
    now: new Date(2026, 10, 20, 13, 10)
  });
  assert.equal(added.ok, true, added.error);
  const wishlistAfter = storage.get(layout.wishlistKey);
  assert.notEqual(wishlistAfter, wishlistBefore);
  assert.equal(storage.get(layout.archiveKey), archiveBefore, '档案原文未变');

  const before = snapshot();
  const beforeWrites = fault.setCalls;
  const stale = confirm(exported.text, preview.token);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'preview-stale');
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites);
  assert.equal(storage.get(layout.wishlistKey), wishlistAfter, '新写入的清单原文原样保留');

  const fresh = backup.inspectText(exported.text);
  assert.equal(fresh.ok, true, fresh.error);
  const restored = confirm(exported.text, fresh.token);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.previous.wishlistPresent, true);
  assert.equal(restored.previous.wishlistBytes, backup.utf8Bytes(wishlistAfter));
  assert.equal(restored.previous.wishlistChecksum, backup.hashText(wishlistAfter));
  assert.equal(restored.previous.archiveChecksum, backup.hashText(archiveBefore));
});

test('T067-Y 已恢复代际内普通写入同样要求重新预演', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  const firstPreview = backup.inspectText(exported.text);
  assert.equal(firstPreview.ok, true, firstPreview.error);
  const first = confirm(exported.text, firstPreview.token);
  assert.equal(first.ok, true, first.error);

  const layout = store.resolveLayout();
  assert.equal(layout.ok, true, layout.error);
  assert.equal(layout.legacy, false, '本用例覆盖恢复后的新代际');
  const preview = backup.inspectText(exported.text);
  assert.equal(preview.ok, true, preview.error);
  const archiveBefore = storage.get(layout.archiveKey);

  const started = store.startSession({
    gymName: '恢复后同代际新馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 13, 20)
  });
  assert.equal(started.ok, true, started.error);
  const archiveAfter = storage.get(layout.archiveKey);
  assert.notEqual(archiveAfter, archiveBefore);

  const before = snapshot();
  const beforeWrites = fault.setCalls;
  const stale = confirm(exported.text, preview.token);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'preview-stale');
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites);
  assert.equal(storage.get(layout.archiveKey), archiveAfter);
  const stillThere = store.loadState();
  assert.equal(stillThere.ok, true, stillThere.error);
  assert.equal(stillThere.archive.sessions.some(item => item.id === started.session.id), true);

  const fresh = backup.inspectText(exported.text);
  assert.equal(fresh.ok, true, fresh.error);
  const restored = confirm(exported.text, fresh.token);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.previous.archiveChecksum, backup.hashText(archiveAfter));
});

test('T067-L 提交回执丢失但已落盘：按读回确认成功，重开不重复写', () => {
  const prepared = prepareBackup();
  arm('lose', key => key === store.BACKUP_COMMIT_KEY, 1);
  const result = confirm(prepared.text, prepared.token);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.code, 'restored-receipt-lost');
  assert.equal(result.receipt.commit, 'receipt-lost');
  assert.equal(store.loadState().ok, true);

  store.resetLayoutCache();
  fault.setCalls = 0;
  const recovered = backup.recoverPending({ now: FIXED_NOW });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.code, 'already-committed');
  assert.equal(fault.setCalls, 0, '已提交时重开不再写');
});

test('T067-M 提交键读回不一致：不暴露半提交，旧键保留，读取返回可见错误', () => {
  const prepared = prepareBackup();
  storage.set(ARCHIVE_KEY, '{"old":true}');
  storage.set(WISHLIST_KEY, '{"oldWishlist":true}');
  const legacyArchive = storage.get(ARCHIVE_KEY);
  const legacyWishlist = storage.get(WISHLIST_KEY);
  // 旧键是在预演之后落位的：以这份当前旧档重新预演。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);

  arm('mismatch', key => key === store.BACKUP_COMMIT_KEY, 1);
  const result = confirm(prepared.text, fresh.token);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'commit-unverified');

  // 提交点已经写出（哪怕读回不一致），旧令牌立即作废，不能用来重复尝试。
  const replay = confirm(prepared.text, fresh.token);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'preview-stale');

  store.resetLayoutCache();
  const loaded = store.loadState();
  const listed = wishlist.loadWishlist();
  assert.equal(loaded.ok, false, '提交记录损坏时不回退旧档冒充当前状态');
  assert.equal(loaded.present, false);
  assert.equal(listed.ok, false);
  assert.equal(storage.get(ARCHIVE_KEY), legacyArchive);
  assert.equal(storage.get(WISHLIST_KEY), legacyWishlist);

  // 诊断仍能原样给出旧键与当前代际的错误。
  const diagnostics = backup.exportDiagnostics({ now: FIXED_NOW });
  assert.equal(diagnostics.ok, true, diagnostics.error);
  const doc = JSON.parse(diagnostics.text);
  assert.equal(doc.layout.ok, false);
  assert.equal(doc.legacy.archive.text, legacyArchive);
  assert.equal(doc.legacy.wishlist.text, legacyWishlist);
});

test('T067-N 已有活动代际时的第二次恢复失败：两个读取入口仍选同一旧代', () => {
  const prepared = prepareBackup();
  const first = confirm(prepared.text, prepared.token);
  assert.equal(first.ok, true, first.error);

  const currentLayout = store.resolveLayout();
  const currentArchive = storage.get(currentLayout.archiveKey);
  const currentWishlist = storage.get(currentLayout.wishlistKey);
  arm('set', key => key.endsWith('.wishlist'), 1);
  // 上一次成功恢复已经消耗旧令牌：重新预演后再做第二次尝试。
  const secondPreview = backup.inspectText(prepared.text);
  assert.equal(secondPreview.ok, true, secondPreview.error);
  const second = confirm(prepared.text, secondPreview.token);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'stage-wishlist-write-failed');

  store.resetLayoutCache();
  const loaded = store.loadState();
  const listed = wishlist.loadWishlist();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(loaded.archive.archiveId, first.rebindArchiveId);
  assert.equal(storage.get(store.resolveLayout().archiveKey), currentArchive);
  assert.equal(storage.get(store.resolveLayout().wishlistKey), currentWishlist);
});

test('T067-O 进程重开时提交记录损坏/启动失败：读取报错而不露出半提交', () => {
  const prepared = prepareBackup();
  const first = confirm(prepared.text, prepared.token);
  assert.equal(first.ok, true, first.error);
  store.resetLayoutCache();

  fault.infoFail = true;
  const blocked = store.loadState();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.present, false, '无法确定代际时不拿旧档充数');
  const recovery = backup.recoverPending();
  assert.equal(recovery.ok, false);
  assert.equal(recovery.code, 'layout-unreadable');

  fault.infoFail = false;
  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.archive.archiveId, first.rebindArchiveId);
});

// ------------------------------------------------------------------ *
// 受损原文、独立验证与恢复保护
// ------------------------------------------------------------------ *

test('T067-P 当前原文损坏时：诊断逐字保留，显式确认仍可恢复，旧键不被覆盖', () => {
  const prepared = prepareBackup();
  const brokenArchive = '{"version":1,"archiveId":"archive-broken"';
  const brokenWishlist = 'not-json\u0000tail';
  storage.set(ARCHIVE_KEY, brokenArchive);
  storage.set(WISHLIST_KEY, brokenWishlist);

  const diagnostics = backup.exportDiagnostics({ now: FIXED_NOW });
  assert.equal(diagnostics.ok, true, diagnostics.error);
  const beforeDoc = JSON.parse(diagnostics.text);
  assert.equal(beforeDoc.current.archive.text, brokenArchive);
  assert.equal(beforeDoc.current.archive.parseOk, false);
  assert.equal(beforeDoc.current.wishlist.text, brokenWishlist);
  assert.equal(beforeDoc.current.wishlist.parseOk, false);

  const beforeWrites = fault.setCalls;
  // 受损原文在预演之后落位：以这份「可读但损坏」的当前旧档重新预演，仍应允许显式恢复。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);
  const result = confirm(prepared.text, fresh.token);
  assert.equal(result.ok, true, result.error);
  assert.ok(fault.setCalls > beforeWrites);
  assert.equal(storage.get(ARCHIVE_KEY), brokenArchive, '受损原文逐字保留');
  assert.equal(storage.get(WISHLIST_KEY), brokenWishlist);

  const afterDiagnostics = backup.exportDiagnostics({ now: FIXED_NOW });
  const afterDoc = JSON.parse(afterDiagnostics.text);
  assert.equal(afterDoc.current.archive.parseOk, true);
  assert.equal(afterDoc.previous.archive.text, brokenArchive, '诊断仍能导出上一代受损原文');
  assert.equal(afterDoc.previous.wishlist.text, brokenWishlist);
  assert.equal(store.loadState().archive.archiveId, result.rebindArchiveId);
});

test('T067-Q 当前原文读取失败：不假定为空、不写入，诊断如实报告读取失败', () => {
  const prepared = prepareBackup();
  storage.set(ARCHIVE_KEY, '{"damaged":true}');
  // 当前旧档在预演之后落位：先以这份旧档重新预演，再单独注入读取故障。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);
  const before = snapshot();
  const beforeWrites = fault.setCalls;
  arm('get', key => key === ARCHIVE_KEY, 1);
  const result = confirm(prepared.text, fresh.token);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'current-read-failed');
  assert.deepEqual(snapshot(), before);
  assert.equal(fault.setCalls, beforeWrites, '读取失败时零写入');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);

  fault.get = null;
  arm('get', key => key === WISHLIST_KEY, 1);
  const wishlistFailed = confirm(prepared.text, fresh.token);
  assert.equal(wishlistFailed.ok, false);
  assert.equal(wishlistFailed.code, 'current-read-failed');
  assert.equal(storage.has(store.BACKUP_COMMIT_KEY), false);
});

test('T067-R 单独验证的备份可在之后显式恢复；未确认时当前数据不变', () => {
  const prepared = prepareBackup();
  const inspected = backup.inspectText(prepared.text);
  assert.equal(inspected.ok, true, inspected.error);

  // 验证之后当前数据发生变化（另一份合法档案），恢复仍以已验证文本为准。
  store.startSession({
    gymName: '验证后新开的馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 8, 0)
  });
  const currentBefore = storage.get(ARCHIVE_KEY);
  const unconfirmed = backup.confirmRestore(prepared.text, {
    confirmed: false,
    previewToken: inspected.token
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'confirmation-required');
  assert.equal(storage.get(ARCHIVE_KEY), currentBefore);

  // 单独验证之后当前数据发生变化：旧令牌必须失效，且不写任何键。
  const stale = confirm(prepared.text, inspected.token);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'preview-stale');
  assert.equal(storage.get(ARCHIVE_KEY), currentBefore, '重新预演前不覆盖当前档案');

  // 以更新后的当前数据重新预演，显式确认后仍按备份文本恢复。
  const fresh = backup.inspectText(prepared.text);
  assert.equal(fresh.ok, true, fresh.error);
  const result = confirm(prepared.text, fresh.token);
  assert.equal(result.ok, true, result.error);
  assert.notEqual(store.loadState().archive.archiveId, 'archive-broken');
  assert.equal(store.loadState().archive.gyms.length, inspected.summary.gyms);
});

// ------------------------------------------------------------------ *
// 固定合成夹具的实际字节与耗时样本
// ------------------------------------------------------------------ *

test('T067-S 固定合成夹具：报告实际 UTF-8 字节与隔离恢复耗时样本', () => {
  seedFixture();
  const exported = backup.exportText({ now: FIXED_NOW });
  assert.equal(exported.ok, true, exported.error);
  const parsed = JSON.parse(exported.text);
  const textBytes = Buffer.byteLength(exported.text, 'utf8');
  assert.equal(exported.bytes, textBytes);
  assert.equal(exported.summary.trainingBytes, Buffer.byteLength(JSON.stringify(parsed.training), 'utf8'));
  assert.equal(exported.summary.wishlistBytes, Buffer.byteLength(JSON.stringify(parsed.wishlist), 'utf8'));

  const previewTimes = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = process.hrtime.bigint();
    const preview = backup.inspectText(exported.text);
    previewTimes.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(preview.ok, true, preview.error);
  }

  const restoreTimes = [];
  for (let index = 0; index < 3; index += 1) {
    resetStorage();
    // 令牌一次性：每次恢复前都重新预演，计时只覆盖确认本身。
    const fresh = backup.inspectText(exported.text);
    assert.equal(fresh.ok, true, fresh.error);
    const startedAt = process.hrtime.bigint();
    const result = confirm(exported.text, fresh.token);
    restoreTimes.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.summary.attempts, exported.summary.attempts);
  }

  const summarize = samples => {
    const sorted = samples.slice().sort((left, right) => left - right);
    return {
      min: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      samples
    };
  };
  const previewStats = summarize(previewTimes);
  const restoreStats = summarize(restoreTimes);

  // 报告真实数值；这些是本机夹具样本，不作为产品上限或耗时承诺。
  console.log(
    'T067 evidence fixture: text=' +
      textBytes +
      'B training=' +
      exported.summary.trainingBytes +
      'B wishlist=' +
      exported.summary.wishlistBytes +
      'B auxiliary=' +
      exported.summary.auxiliaryBytes +
      'B attempts=' +
      exported.summary.attempts +
      ' notes=' +
      exported.summary.notes
  );
  console.log(
    'T067 evidence preview ms: min=' +
      previewStats.min.toFixed(3) +
      ' median=' +
      previewStats.median.toFixed(3) +
      ' max=' +
      previewStats.max.toFixed(3) +
      ' samples=' +
      previewTimes.map(value => value.toFixed(3)).join(',')
  );
  console.log(
    'T067 evidence restore ms: min=' +
      restoreStats.min.toFixed(3) +
      ' median=' +
      restoreStats.median.toFixed(3) +
      ' max=' +
      restoreStats.max.toFixed(3) +
      ' samples=' +
      restoreTimes.map(value => value.toFixed(3)).join(',')
  );

  assert.ok(textBytes > 0);
  assert.ok(exported.summary.trainingBytes > 0);
  assert.ok(exported.summary.auxiliaryBytes > 0);
});

// ------------------------------------------------------------------ *
// 启动接线与模块边界
// ------------------------------------------------------------------ *

test('T067-T app.js 冷启动接入文本恢复补提交，且不依赖启动成功', () => {
  const source = fs.readFileSync(APP_JS, 'utf8');
  assert.match(source, /recoverLocalTextRestore/);
  assert.match(source, /training-backup\.js/);
  assert.match(source, /recoverPending/);
  const launchCall = source.indexOf('this.recoverLocalTextRestore()');
  const attemptCall = source.indexOf('this.recoverLocalAttemptDeletes()');
  assert.ok(launchCall !== -1 && attemptCall !== -1);
  assert.ok(launchCall < attemptCall, '文本恢复检查先于删除清理');
  assert.doesNotMatch(source, /wx\.setStorageSync/);

  // 备份核心不直接引用旧云/试用/照片/视频模块。
  const backupSource = fs.readFileSync(BACKUP_JS, 'utf8');
  assert.doesNotMatch(backupSource, /wx\.cloud/);
  assert.doesNotMatch(backupSource, /gymLogTrial/);
  assert.doesNotMatch(backupSource, /training-photos|attempt-video/);
  assert.match(fs.readFileSync(WISHLIST_JS, 'utf8'), /store\.resolveLayout\(\)/);
  assert.match(fs.readFileSync(STORE_JS, 'utf8'), /BACKUP_COMMIT_KEY/);
});
