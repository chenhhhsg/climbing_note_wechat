/**
 * T032 同一把次撤回、恢复与有效计数回归测试
 *
 * 用隔离的微信本地存储替身与可注入故障（写前失败、写成后回执丢失）驱动真实的
 * utils/training-store.js，并直接加载真实页面（pages/index、pages/training-session、
 * pages/training-route、pages/record-list、pages/stats）与 utils 小结/想爬清单，
 * 逐项对照「持久档案字节」与「各读数端」：
 * - A 线第 3 把撤回 3→2、恢复 2→3：ID、原序号、结果与备注一致，其他把次与同色 B 线不变；
 * - 撤回不物理删除、不改结果、不动照片索引/体测/旧云：只写训练档案这一个键；
 * - 写前失败不落任何数据；写成后回执丢失按原意图重试仍只有一次效果；重开不靠内存去重；
 * - 已撤回后的迟到 saveAttempt(opId) 不复活、不新增；旧的撤回/恢复回调不把状态翻回去；
 *   换档、换场次、换线路的迟到操作一律不落盘；
 * - 抱石完攀守卫：唯一完攀撤回后可再记、恢复后再次锁定；已有别的有效/在途完攀时恢复被拒；
 *   顶绳、先锋沿原规则；原「改为未完成」仍保留一把，与撤回减少一把分别取证；
 * - 首页、场内、线路逐把历史、跨天历史、底部统计、场次小结与想爬清单按同一有效集合计算，
 *   已撤回把次不贡献把数、最近有效备注与完攀；待保存记录不计入；
 * - 基线旧档案（无撤回字段）全部已提交把次默认有效，只读打开不改原字节；
 * - 同日多场、跨天、多档案有同名 ID、撤回后再保存新把各自隔离。
 *
 * 真机触控、按钮矩形与微信模拟器视口在 T033 与整项 QA 另行登记（待验）。
 *
 * 运行：node --test tests/training-attempt-undo.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const RULES_JS = path.join(ROOT, 'utils', 'training-rules.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const LIST_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const WISHLIST_KEY = 'climbingNote.training.v1.wishlist';
const FITNESS_KEY = 'climbingNote.fitness.v1.records';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入故障 ----
const storage = new Map();
const io = { writes: [], reads: [], removals: [] };
const fault = { setFailAt: 0, setCount: 0, loseResponseAt: 0, getFail: false };

function resetFault() {
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
  fault.getFail = false;
}

function resetStorage() {
  storage.clear();
  io.writes = [];
  io.reads = [];
  io.removals = [];
  resetFault();
}

/** 第 N 次写盘失败：数据没有落盘（写前失败）。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

/** 第 N 次写盘已生效但回执丢失：键里已是新数据，调用方只看到失败。 */
function armSetLoseResponseAt(callNumber) {
  fault.setCount = 0;
  fault.loseResponseAt = callNumber;
}

function rawArchive() {
  return storage.has(ARCHIVE_KEY) ? storage.get(ARCHIVE_KEY) : '';
}

function archiveOf() {
  const raw = rawArchive();
  return raw ? JSON.parse(raw) : null;
}

global.wx = {
  getStorageSync(key) {
    io.reads.push(key);
    if (fault.getFail) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    storage.set(key, value);
    io.writes.push(key);
    // 写成功之后才失败：数据已是新的，调用方只看到失败。
    if (fault.loseResponseAt && fault.setCount === fault.loseResponseAt) {
      throw new Error('setStorageSync:fail after durable write injected at call ' + fault.setCount);
    }
  },
  removeStorageSync(key) {
    io.removals.push(key);
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo() {},
  navigateBack() {},
  reLaunch() {},
  switchTab() {},
  showToast() {},
  previewImage() {},
  stopPullDownRefresh() {}
};

const db = require(DB_JS);
const store = require(STORE_JS);
const rules = require(RULES_JS);
const summary = require(SUMMARY_JS);
const wishlist = require(WISHLIST_JS);

// 捕获原生 Page(...) 定义；页面自身的旧云读取在 beforeEach 里换成可控空回执。
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

const indexDefinition = capturePage(INDEX_JS);
const sessionDefinition = capturePage(SESSION_JS);
const recordDefinition = capturePage(RECORD_JS);
const routeDefinition = capturePage(ROUTE_JS);
const listDefinition = capturePage(LIST_JS);
const statsDefinition = capturePage(STATS_JS);

function createPage(definition) {
  const page = Object.create(definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function setData(patch) {
    Object.keys(patch || {}).forEach(key => {
      const parts = key.split('.');
      let node = this.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = patch[key];
    });
  };
  return page;
}

beforeEach(() => {
  resetStorage();
  // 旧云只作旁证：本机读数不得依赖它，这里给可控的空回执。
  db.getAllRecords = () => Promise.resolve({ data: [] });
  db.getRecords = () => Promise.resolve({ data: [], hasMore: false });
  db.getRecentRecords = () => Promise.resolve({ data: [] });
});

// ------------------------------------------------------------------ *
// 取证小工具
// ------------------------------------------------------------------ *

/** 一次训练的最常用前置：开一场、建一条线路（走正式档案层，不经过页面）。 */
function beginTraining(options = {}) {
  const started = store.startSession({
    gymName: options.gymName || '我自己去的岩馆',
    date: options.date,
    now: options.now || new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const route = store.createRoute({
    sessionId: started.session.id,
    name: options.routeName || '蓝色抱石线',
    climbType: options.climbType || '抱石',
    grade: options.grade || 'V3',
    colorName: options.colorName || '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(route.ok, true, route.error);
  return { session: started.session, route: route.route };
}

function addAttempt(session, route, result, note, now) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note,
    now
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

/** 持久档案里的全部把次（含已撤回），按序号排；用来核对「不物理删除」。 */
function allAttempts(routeId) {
  const archive = archiveOf();
  return (archive.attempts || [])
    .filter(item => !routeId || item.routeId === routeId)
    .sort((left, right) => left.seq - right.seq);
}

/** 撤回/恢复不该动的原字段（ID、序号、归属、结果、备注、时间）。 */
function identityOf(attempt) {
  return {
    id: attempt.id,
    seq: attempt.seq,
    sessionId: attempt.sessionId,
    routeId: attempt.routeId,
    result: attempt.result,
    note: attempt.note,
    createdAt: attempt.createdAt
  };
}

function effectiveOn(routeId, sessionId) {
  return store.attemptsFor(store.loadState().archive, {
    routeId,
    sessionId
  });
}

/** 三把未完成的抱石线（第 3 把带备注）＋一条同色同级旁线，用于撤回/恢复取证。 */
function seedThreeAttempts() {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 9, 0) });
  const neighbor = store.createRoute({
    sessionId: session.id,
    name: '蓝色平衡线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色'
  });
  assert.equal(neighbor.ok, true, neighbor.error);

  const first = addAttempt(session, route, 'fail', '', new Date(2026, 10, 9, 9, 5));
  const second = addAttempt(session, route, 'fail', '第二把抓到后向右摆', new Date(2026, 10, 9, 9, 8));
  const third = addAttempt(session, route, 'fail', '第三把改成先挂左脚', new Date(2026, 10, 9, 9, 12));
  const neighborAttempt = addAttempt(
    session,
    neighbor.route,
    'fail',
    '旁线这一把',
    new Date(2026, 10, 9, 9, 15)
  );
  return {
    session,
    route: route,
    neighbor: neighbor.route,
    first,
    second,
    third,
    neighborAttempt
  };
}

// ------------------------------------------------------------------ *
// 撤回、恢复与原值保留
// ------------------------------------------------------------------ *

test('T032 A 线第 3 把撤回 3→2、恢复 2→3：ID、原序号、结果与备注一致，其他把次与同色 B 线不变', () => {
  const seeded = seedThreeAttempts();
  const thirdIdentity = identityOf(
    allAttempts(seeded.route.id).find(item => item.id === seeded.third.id)
  );
  const othersSnapshot = JSON.stringify(
    allAttempts(seeded.route.id).filter(item => item.id !== seeded.third.id)
  );
  const neighborSnapshot = JSON.stringify(allAttempts(seeded.neighbor.id));

  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);

  // 撤回第 3 把：3 → 2。
  const undone = store.undoAttempt(seeded.third.id, {
    routeId: seeded.route.id,
    sessionId: seeded.session.id,
    opId: 'undo-1'
  });
  assert.equal(undone.ok, true, undone.error);
  assert.equal(undone.code, 'undone');
  assert.equal(undone.duplicate, false);
  const afterUndo = effectiveOn(seeded.route.id, seeded.session.id);
  assert.equal(afterUndo.length, 2, '撤回后本线有效把次 3→2');
  assert.deepEqual(afterUndo.map(item => item.id), [seeded.first.id, seeded.second.id]);
  assert.equal(allAttempts(seeded.route.id).length, 3, '撤回不物理删除原把');
  assert.equal(
    JSON.stringify(allAttempts(seeded.route.id).filter(item => item.id !== seeded.third.id)),
    othersSnapshot,
    '其他把次逐项保持原值'
  );
  assert.equal(JSON.stringify(allAttempts(seeded.neighbor.id)), neighborSnapshot, '同色 B 线不变');

  // 恢复：2 → 3，拿回原 ID、原序号、原结果与原备注。
  const restored = store.restoreAttempt(seeded.third.id, {
    routeId: seeded.route.id,
    sessionId: seeded.session.id,
    opId: 'restore-1'
  });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.code, 'restored');
  const afterRestore = effectiveOn(seeded.route.id, seeded.session.id);
  assert.equal(afterRestore.length, 3, '恢复后本线有效把次 2→3');
  assert.deepEqual(afterRestore.map(item => item.id), [
    seeded.first.id,
    seeded.second.id,
    seeded.third.id
  ]);
  assert.deepEqual(identityOf(afterRestore[2]), thirdIdentity, '恢复后 ID/序号/结果/备注逐项一致');
  assert.equal(afterRestore[2].undoneAt, undefined, '恢复后不再带撤回标记');
  assert.equal(JSON.stringify(allAttempts(seeded.neighbor.id)), neighborSnapshot);

  // 重开读取：同一档案、同一读数。
  const reloaded = store.loadState();
  assert.equal(reloaded.ok, true, reloaded.error);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);
});

test('T032 撤回不是删除也不是伪造相反结果：持久记录仍在，只多一个撤回标记', () => {
  const seeded = seedThreeAttempts();
  const before = allAttempts(seeded.route.id).find(item => item.id === seeded.third.id);

  const undone = store.undoAttempt(seeded.third.id, { opId: 'undo-not-delete' });
  assert.equal(undone.code, 'undone');

  const after = allAttempts(seeded.route.id).find(item => item.id === seeded.third.id);
  assert.deepEqual(identityOf(after), identityOf(before), '原把次的每一项都保持不变');
  assert.equal(after.result, 'fail', '没有把结果伪造成相反值');
  assert.match(after.undoneAt, /^\d{4}-\d{2}-\d{2}T/, '只多一个撤回时间戳');
  assert.deepEqual(
    after.settledOps.map(op => op.opId),
    ['undo-not-delete'],
    '记下这次撤回操作的结清凭据'
  );
  assert.equal(after.settledOps[0].undone, true);
  assert.deepEqual(
    identityOf(before),
    identityOf(after),
    '除撤回标记与结清凭据之外，原把次的每一项都保持不变'
  );
  // 线路、场次与档案结构都没有被删改。
  const archive = archiveOf();
  assert.equal(archive.routes.filter(item => item.id === seeded.route.id).length, 1);
  assert.equal(archive.sessions.filter(item => item.id === seeded.session.id).length, 1);
  assert.equal(archive.pendingUndos.length, 0, '撤回完成后不残留进行中标记');
});

test('T032 同一意图重复调用只产生一次效果，且不重复写盘', () => {
  const seeded = seedThreeAttempts();
  const first = store.undoAttempt(seeded.third.id, { opId: 'undo-dup' });
  assert.equal(first.code, 'undone');
  assert.equal(first.duplicate, false);
  const bytes = rawArchive();
  const writes = io.writes.length;

  // 同一 opId 的重试（迟到的同一意图）：认出已结清，不再写盘。
  const sameOp = store.undoAttempt(seeded.third.id, { opId: 'undo-dup' });
  assert.equal(sameOp.ok, true);
  assert.equal(sameOp.code, 'settled');
  assert.equal(sameOp.duplicate, true);
  assert.equal(rawArchive(), bytes, '重复意图不写盘');
  assert.equal(io.writes.length, writes);

  // 不带 opId 的重复点击：按状态幂等，也不写盘。
  const stateAgain = store.undoAttempt(seeded.third.id, {});
  assert.equal(stateAgain.ok, true);
  assert.equal(stateAgain.code, 'undone');
  assert.equal(stateAgain.duplicate, true);
  assert.equal(rawArchive(), bytes);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2, '只有一次效果');

  // 恢复侧同样只产生一次效果。
  const restored = store.restoreAttempt(seeded.third.id, { opId: 'restore-dup' });
  assert.equal(restored.code, 'restored');
  const restoredBytes = rawArchive();
  const restoredWrites = io.writes.length;
  const restoreAgain = store.restoreAttempt(seeded.third.id, { opId: 'restore-dup' });
  assert.equal(restoreAgain.code, 'settled');
  assert.equal(rawArchive(), restoredBytes);
  assert.equal(io.writes.length, restoredWrites);
  const activeAgain = store.restoreAttempt(seeded.third.id, {});
  assert.equal(activeAgain.code, 'active');
  assert.equal(activeAgain.duplicate, true);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);
});

// ------------------------------------------------------------------ *
// 故障、迟到与重开
// ------------------------------------------------------------------ *

test('T032 写前失败：撤回不落任何数据，重试同一意图按原目标补齐', () => {
  const seeded = seedThreeAttempts();
  // 第一段写（进行中标记）就失败：键里没有任何变化。
  armSetFailAt(1);
  const failed = store.undoAttempt(seeded.third.id, { opId: 'undo-fail-1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  assert.match(failed.error, /保存本机训练档案失败/);
  assert.equal(failed.opId, 'undo-fail-1');
  assert.equal(archiveOf().pendingUndos.length, 0, '写前失败不留下进行中标记');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3, '未落盘时仍是三把');

  resetFault();
  const retried = store.undoAttempt(seeded.third.id, { opId: 'undo-fail-1' });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.duplicate, false);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2);
  assert.equal(archiveOf().pendingUndos.length, 0);
});

test('T032 第二段失败：留下可重试的进行中标记，重开后重试同一意图补齐', () => {
  const seeded = seedThreeAttempts();
  armSetFailAt(2); // 第一段写标记成功，第二段提交撤回标记失败
  const failed = store.undoAttempt(seeded.third.id, {
    routeId: seeded.route.id,
    sessionId: seeded.session.id,
    opId: 'undo-fail-2'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');

  // 已持久化的进行中标记：目标、归属与操作凭据都在，重开也读得到。
  const staged = archiveOf();
  assert.equal(staged.pendingUndos.length, 1);
  assert.equal(staged.pendingUndos[0].attemptId, seeded.third.id);
  assert.equal(staged.pendingUndos[0].sessionId, seeded.session.id);
  assert.equal(staged.pendingUndos[0].routeId, seeded.route.id);
  assert.equal(staged.pendingUndos[0].opId, 'undo-fail-2');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3, '未落盘时不报已撤回');

  // 重开（重新读盘）后按同一意图重试。
  resetFault();
  const reopened = store.loadState();
  assert.equal(reopened.ok, true);
  assert.equal(reopened.archive.pendingUndos.length, 1);
  const retried = store.undoAttempt(seeded.third.id, { opId: 'undo-fail-2' });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2);
  assert.equal(archiveOf().pendingUndos.length, 0, '重试后不残留进行中标记');
});

test('T032 写成后回执丢失：同一 opId 重试认出已结清，不会撤两次', () => {
  const seeded = seedThreeAttempts();
  armSetLoseResponseAt(2); // 第二段其实已写成，只是回执丢失
  const lost = store.undoAttempt(seeded.third.id, { opId: 'undo-lost' });
  assert.equal(lost.ok, false, '回执丢失时不得报已撤回');
  assert.match(lost.error, /保存本机训练档案失败/);

  // 键里其实已经撤回：只撤回一次，没有第二条记录。
  const persisted = archiveOf();
  assert.match(persisted.attempts.find(item => item.id === seeded.third.id).undoneAt, /^\d{4}-/);
  assert.equal(persisted.attempts.length, 4);
  assert.equal(store.attemptsFor(persisted, { routeId: seeded.route.id }).length, 2);

  resetFault();
  const retried = store.undoAttempt(seeded.third.id, { opId: 'undo-lost' });
  assert.equal(retried.ok, true);
  assert.equal(retried.code, 'settled');
  assert.equal(retried.duplicate, true);
  assert.equal(store.attemptsFor(archiveOf(), { routeId: seeded.route.id }).length, 2, '只有一次效果');
  assert.equal(allAttempts(seeded.route.id).length, 3, '不产生额外把次');
});

test('T032 恢复的两段写同样可重试：写前失败不落盘，第二段失败后可补齐', () => {
  const seeded = seedThreeAttempts();
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-for-restore' }).code, 'undone');

  armSetFailAt(1);
  const early = store.restoreAttempt(seeded.third.id, { opId: 'restore-fail-1' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'write-failed');
  assert.equal(archiveOf().pendingRestores.length, 0);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2, '写前失败仍保持已撤回');

  armSetFailAt(2);
  const late = store.restoreAttempt(seeded.third.id, { opId: 'restore-fail-1' });
  assert.equal(late.ok, false);
  const staged = archiveOf();
  assert.equal(staged.pendingRestores.length, 1);
  assert.equal(staged.pendingRestores[0].attemptId, seeded.third.id);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2);

  resetFault();
  const retried = store.restoreAttempt(seeded.third.id, { opId: 'restore-fail-1' });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.code, 'restored');
  assert.equal(archiveOf().pendingRestores.length, 0);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);
});

test('T032 已撤回后的迟到 saveAttempt(opId) 不复活、也不新增第二把', () => {
  const seeded = seedThreeAttempts();
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-late-save' }).code, 'undone');

  // 页面迟到的「保存」回执带着原 opId 到达：原 ID 就是去重凭据，撤回后仍然认得。
  const late = store.saveAttempt({
    opId: seeded.third.id,
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail',
    note: '第三把改成先挂左脚'
  });
  assert.equal(late.ok, true);
  assert.equal(late.duplicate, true);
  assert.equal(late.undone, true, '迟到保存要认得这一把已撤回');
  assert.equal(allAttempts(seeded.route.id).length, 3, '不新建第二把');
  assert.match(
    archiveOf().attempts.find(item => item.id === seeded.third.id).undoneAt,
    /^\d{4}-/,
    '迟到保存不能复活已撤回的那一把'
  );
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2);

  // 新一次真实尝试仍是新的持久 ID，且进入有效集合。
  const fresh = store.saveAttempt({
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail',
    note: '撤回后又记的一把'
  });
  assert.equal(fresh.ok, true, fresh.error);
  assert.notEqual(fresh.attempt.id, seeded.third.id);
  const ids = archiveOf().attempts.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '新把的持久 ID 唯一');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);
});

test('T032 旧的撤回回调不撤销后来成功的恢复；旧的恢复回调不撤销后来成功的撤回', () => {
  const seeded = seedThreeAttempts();

  // 撤回结清 → 恢复成功 → 迟到的同一撤回回调到达：不得把恢复翻回去。
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-old' }).code, 'undone');
  assert.equal(store.restoreAttempt(seeded.third.id, { opId: 'restore-old' }).code, 'restored');
  const lateUndo = store.undoAttempt(seeded.third.id, { opId: 'undo-old' });
  assert.equal(lateUndo.ok, true);
  assert.equal(lateUndo.code, 'settled');
  assert.equal(
    effectiveOn(seeded.route.id, seeded.session.id).length,
    3,
    '迟到撤回不能撤销后来成功的恢复'
  );

  // 反向：撤回再次成功 → 迟到的同一恢复回调到达：不得把撤回翻回去。
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-new' }).code, 'undone');
  const lateRestore = store.restoreAttempt(seeded.third.id, { opId: 'restore-old' });
  assert.equal(lateRestore.ok, true);
  assert.equal(lateRestore.code, 'settled');
  assert.equal(
    effectiveOn(seeded.route.id, seeded.session.id).length,
    2,
    '迟到恢复不能撤销后来成功的撤回'
  );

  // 带着原预期状态的迟到回调同样不翻回去。
  const withExpected = store.restoreAttempt(seeded.third.id, {
    opId: 'restore-old',
    expected: 'undone'
  });
  assert.equal(withExpected.code, 'settled');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 2);
});

test('T032 换档、换场次、换线路与预期状态不符的迟到操作一律不落盘', () => {
  const seeded = seedThreeAttempts();
  // 另一场次、另一条线：用于构造「归属不对」的迟到操作。
  const otherGym = store.startSession({
    gymName: '另一家岩馆',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 20, 0)
  });
  assert.equal(otherGym.ok, true, otherGym.error);
  const otherRoute = store.createRoute({
    sessionId: otherGym.session.id,
    name: '另一家岩馆的线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(otherRoute.ok, true, otherRoute.error);

  const bytes = rawArchive();
  const writes = io.writes.length;

  const wrongSession = store.undoAttempt(seeded.second.id, {
    sessionId: otherGym.session.id
  });
  assert.equal(wrongSession.ok, false);
  assert.equal(wrongSession.code, 'conflict');

  const wrongRoute = store.undoAttempt(seeded.second.id, { routeId: otherRoute.route.id });
  assert.equal(wrongRoute.ok, false);
  assert.equal(wrongRoute.code, 'conflict');

  const wrongArchive = store.undoAttempt(seeded.second.id, { archiveId: 'archive-other' });
  assert.equal(wrongArchive.ok, false);
  assert.equal(wrongArchive.code, 'archive-mismatch');

  // 页面以为这一把已撤回，其实仍有效：按预期状态拒绝。
  const staleExpectation = store.undoAttempt(seeded.second.id, { expected: 'undone' });
  assert.equal(staleExpectation.ok, false);
  assert.equal(staleExpectation.code, 'stale');

  // 不认识的预期状态一律拒绝，不猜意图。
  const badExpectation = store.undoAttempt(seeded.second.id, { expected: 'whatever' });
  assert.equal(badExpectation.ok, false);
  assert.equal(badExpectation.code, 'stale');

  const missing = store.undoAttempt('op-not-exist');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  const noId = store.undoAttempt('');
  assert.equal(noId.ok, false);
  assert.equal(noId.code, 'missing');

  const restoreMissing = store.restoreAttempt('op-not-exist');
  assert.equal(restoreMissing.ok, false);
  assert.equal(restoreMissing.code, 'missing');

  assert.equal(rawArchive(), bytes, '以上迟到与非法操作都不落盘');
  assert.equal(io.writes.length, writes, '一次写盘都没有发生');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).length, 3);
});

test('T032 重开（新模块实例）后仍按持久凭据去重，不靠内存', () => {
  const seeded = seedThreeAttempts();
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-restart' }).code, 'undone');
  const bytes = rawArchive();

  // 模拟退出小程序再进入：丢掉模块缓存，重新加载档案层（内存里没有任何去重表）。
  delete require.cache[require.resolve(STORE_JS)];
  const restarted = require(STORE_JS);
  const sameOp = restarted.undoAttempt(seeded.third.id, { opId: 'undo-restart' });
  assert.equal(sameOp.ok, true);
  assert.equal(sameOp.code, 'settled');
  assert.equal(rawArchive(), bytes, '重开后同一意图不再写盘');
  assert.equal(restarted.attemptsFor(restarted.loadState().archive, { routeId: seeded.route.id }).length, 2);

  // 恢复也按持久凭据：重开后同一 opId 只恢复一次。
  assert.equal(restarted.restoreAttempt(seeded.third.id, { opId: 'restore-restart' }).code, 'restored');
  const restoredBytes = rawArchive();
  const again = restarted.restoreAttempt(seeded.third.id, { opId: 'restore-restart' });
  assert.equal(again.code, 'settled');
  assert.equal(rawArchive(), restoredBytes);
  assert.equal(restarted.attemptsFor(restarted.loadState().archive, { routeId: seeded.route.id }).length, 3);
});

// ------------------------------------------------------------------ *
// 抱石完攀守卫、绳攀与原「改为未完成」
// ------------------------------------------------------------------ *

test('T032 唯一一把抱石完攀撤回后可以继续记录，恢复后再次锁定', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 10, 0) });
  const send = addAttempt(session, route, 'send', '唯一完攀', new Date(2026, 10, 9, 10, 5));

  let completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.completed, true);
  assert.equal(completion.closed, true);
  assert.equal(completion.canRecord, false);
  const blockedBefore = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(blockedBefore.ok, false);
  assert.equal(blockedBefore.blocked, true);

  // 撤回唯一完攀：这条线重新可记，结果字段仍是 send（撤回不等于改成未完成）。
  assert.equal(store.undoAttempt(send.id, { opId: 'undo-only-send' }).code, 'undone');
  completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.hasSend, false);
  assert.equal(completion.completed, false);
  assert.equal(completion.closed, false);
  assert.equal(completion.canRecord, true);
  assert.equal(completion.undoneCount, 1);
  assert.equal(allAttempts(route.id)[0].result, 'send', '撤回没有伪造相反结果');

  // 恢复后再次锁定，全档案仍只有一次有效完攀。
  assert.equal(store.restoreAttempt(send.id, { opId: 'restore-only-send' }).code, 'restored');
  completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.completed, true);
  assert.equal(completion.closed, true);
  assert.equal(completion.sendCount, 1);
  const blockedAfter = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(blockedAfter.ok, false);
  assert.equal(blockedAfter.blocked, true);
});

test('T032 存在别的有效完攀时恢复被拒：不制造第二次有效抱石完攀', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 11, 0) });
  const firstSend = addAttempt(session, route, 'send', '第一次完攀', new Date(2026, 10, 9, 11, 5));
  assert.equal(store.undoAttempt(firstSend.id, { opId: 'undo-first-send' }).code, 'undone');

  // 撤回后重新记一把完攀（此刻这条线没有有效完攀，允许记录）。
  const secondSend = addAttempt(session, route, 'send', '撤回后重新记的完攀', new Date(2026, 10, 9, 11, 9));
  assert.equal(store.routeCompletion(store.loadState().archive, route.id).sendCount, 1);

  // 再恢复原来那一把会凑出第二次有效完攀：重新计算后拒绝。
  const conflict = store.restoreAttempt(firstSend.id, { opId: 'restore-first-send' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.blocked, true);
  assert.equal(conflict.conflict, 'second-send');
  assert.match(conflict.error, /第二次完攀/);
  const completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.sendCount, 1, '全档案仍只有一次有效完攀');
  assert.equal(completion.closed, true);
  assert.equal(effectiveOn(route.id, session.id).length, 1, '被拒的恢复不落盘');
  assert.equal(
    archiveOf().attempts.find(item => item.id === firstSend.id).undoneAt !== undefined,
    true,
    '原来那一把仍是已撤回'
  );
  assert.equal(archiveOf().attempts.find(item => item.id === secondSend.id).undoneAt, undefined);
});

test('T032 存在在途完攀时恢复被拒；在途的恢复也先把新增封锁', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 12, 0) });
  const send = addAttempt(session, route, 'send', '唯一完攀', new Date(2026, 10, 9, 12, 5));
  assert.equal(store.undoAttempt(send.id, { opId: 'undo-pending-send' }).code, 'undone');

  // 另一把完攀只落到「进行中」标记（第一段写成功、回执丢失）。
  armSetLoseResponseAt(1);
  const staged = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(staged.ok, false);
  assert.equal(archiveOf().pendingSaves.length, 1);
  resetFault();

  const conflict = store.restoreAttempt(send.id, { opId: 'restore-with-pending' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.conflict, 'pending-send');

  // 反向：在途的「恢复」也先把抱石封锁，重试补齐后才放行。
  const separate = beginTraining({
    gymName: '第二家岩馆',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 9, 0),
    routeName: '第二家抱石线',
    grade: 'V4'
  });
  const secondSend = addAttempt(separate.session, separate.route, 'send', '第二家的完攀', new Date(2026, 10, 10, 9, 5));
  assert.equal(store.undoAttempt(secondSend.id, { opId: 'undo-second' }).code, 'undone');
  armSetFailAt(2);
  const halfDone = store.restoreAttempt(secondSend.id, { opId: 'restore-staged' });
  assert.equal(halfDone.ok, false);
  assert.equal(archiveOf().pendingRestores.length, 1, '恢复进行中标记已落盘');
  resetFault();

  const blocked = store.saveAttempt({
    sessionId: separate.session.id,
    routeId: separate.route.id,
    result: 'send'
  });
  assert.equal(blocked.ok, false, '在途的恢复不能被另一把完攀抢先');
  assert.equal(blocked.blocked, true);

  const done = store.restoreAttempt(secondSend.id, { opId: 'restore-staged' });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.code, 'restored');
  assert.equal(archiveOf().pendingRestores.length, 0);
  assert.equal(store.routeCompletion(store.loadState().archive, separate.route.id).sendCount, 1);
});

test('T032 顶绳、先锋沿原规则：可重复完攀，撤回与恢复只改计数', () => {
  const { session, route } = beginTraining({
    climbType: '顶绳',
    grade: '5.10a',
    routeName: '顶绳线',
    now: new Date(2026, 10, 9, 13, 0)
  });
  const firstSend = addAttempt(session, route, 'send', '第一次完攀', new Date(2026, 10, 9, 13, 5));
  const secondSend = addAttempt(session, route, 'send', '第二次完攀', new Date(2026, 10, 9, 13, 9));

  let completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.isBoulder, false);
  assert.equal(completion.repeatable, true);
  assert.equal(completion.sendCount, 2);
  assert.equal(completion.completed, false, '绳攀可重复完攀，不进入抱石 completed');

  assert.equal(store.undoAttempt(firstSend.id, { opId: 'undo-rope' }).code, 'undone');
  completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.sendCount, 1);
  assert.equal(completion.closed, false);

  // 有别的完攀时恢复也允许（绳攀不套抱石守卫）。
  const restored = store.restoreAttempt(firstSend.id, { opId: 'restore-rope' });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.code, 'restored');
  completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.sendCount, 2);
  assert.equal(effectiveOn(route.id, session.id).length, 2);
  assert.equal(archiveOf().attempts.length, 2);

  // 先锋同样可重复完攀，撤回/恢复只改计数。
  const pioneer = store.createRoute({
    sessionId: session.id,
    name: '先锋线',
    climbType: '先锋',
    grade: '5.11a'
  });
  assert.equal(pioneer.ok, true, pioneer.error);
  const pioneerSend = addAttempt(session, pioneer.route, 'send', '先锋完攀');
  const pioneerFail = addAttempt(session, pioneer.route, 'fail', '先锋第二把');
  assert.equal(store.undoAttempt(pioneerFail.id, { opId: 'undo-pioneer' }).code, 'undone');
  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: pioneer.route.id }).length, 1);
  assert.equal(
    store.routeCompletion(store.loadState().archive, pioneer.route.id).sendCount,
    1
  );
  assert.equal(store.restoreAttempt(pioneerFail.id, { opId: 'restore-pioneer' }).code, 'restored');
  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: pioneer.route.id }).length, 2);
  assert.equal(secondSend.result, 'send');
});

test('T032 原「改为未完成」仍保留一把，与撤回减少一把分别取证', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 14, 0) });
  const send = addAttempt(session, route, 'send', '完攀这把', new Date(2026, 10, 9, 14, 5));

  // 已撤回的完攀不再是「改为未完成」的目标，也不能直接改它。
  assert.equal(store.undoAttempt(send.id, { opId: 'undo-before-correct' }).code, 'undone');
  assert.equal(store.routeCorrectionTargets(store.loadState().archive, route.id).length, 0);
  assert.equal(store.correctAttempt(send.id, { routeId: route.id }).code, 'undone');
  assert.equal(store.setAttemptNote(send.id, { note: '迟到的备注' }).code, 'undone');
  assert.equal(
    archiveOf().attempts.find(item => item.id === send.id).note,
    '完攀这把',
    '已撤回的把次保留原备注'
  );

  // 恢复后仍可按原把次「改为未完成」：保留这一把。
  assert.equal(store.restoreAttempt(send.id, { opId: 'restore-before-correct' }).code, 'restored');
  const corrected = store.correctAttempt(send.id, { routeId: route.id, sessionId: session.id });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.code, 'corrected');
  assert.equal(effectiveOn(route.id, session.id).length, 1, '「改为未完成」保留一把');
  assert.equal(allAttempts(route.id).length, 1);
  assert.equal(allAttempts(route.id)[0].result, 'fail');

  // 撤回同一把：减少一把，但持久记录仍在。
  assert.equal(store.undoAttempt(send.id, { opId: 'undo-after-correct' }).code, 'undone');
  assert.equal(effectiveOn(route.id, session.id).length, 0, '撤回减少一把');
  assert.equal(allAttempts(route.id).length, 1, '撤回也不删除这一把');
});

// ------------------------------------------------------------------ *
// 各读数端同一有效集合
// ------------------------------------------------------------------ *

/**
 * 跨天夹具：
 *  - 第一天（2026-11-09）同一场次两条同色同级抱石线 A、B；
 *    A 记三把（第 3 把带备注「第三把备注」），B 记一把；
 *  - 第二天（2026-11-10）另一场次接上同两条线：A 完攀一把，B 再记一把。
 */
function seedCrossDayFixture() {
  const first = beginTraining({
    gymName: '岩馆 A',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 9, 0),
    routeName: 'A 抱石线'
  });
  const b = store.createRoute({
    sessionId: first.session.id,
    name: 'B 抱石线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色'
  });
  assert.equal(b.ok, true, b.error);

  const a1 = addAttempt(first.session, first.route, 'fail', '', new Date(2026, 10, 9, 9, 5));
  const b1 = addAttempt(first.session, b.route, 'fail', 'B 的备注', new Date(2026, 10, 9, 9, 8));
  const a2 = addAttempt(first.session, first.route, 'fail', '第二把备注', new Date(2026, 10, 9, 9, 12));
  const a3 = addAttempt(first.session, first.route, 'fail', '第三把备注', new Date(2026, 10, 9, 9, 16));

  const second = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 19, 0)
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.linkRouteToSession(second.session.id, first.route.id).ok, true);
  assert.equal(store.linkRouteToSession(second.session.id, b.route.id).ok, true);
  const a4 = addAttempt(second.session, first.route, 'send', '', new Date(2026, 10, 10, 19, 5));
  const b2 = addAttempt(second.session, b.route, 'fail', '第二天的 B 把', new Date(2026, 10, 10, 19, 9));

  return { first, b, second, a1, a2, a3, a4, b1, b2 };
}

test('T032 撤回后首页、场内、线路历史、跨天历史、统计、小结与清单同一有效集合', () => {
  const fixture = seedCrossDayFixture();
  // 撤回第一天 A 线的第 3 把（带备注），以及第二天 B 线的第二把。
  assert.equal(
    store.undoAttempt(fixture.a3.id, {
      opId: 'undo-a3',
      routeId: fixture.first.route.id,
      sessionId: fixture.first.session.id
    }).code,
    'undone'
  );
  assert.equal(
    store.undoAttempt(fixture.b2.id, {
      opId: 'undo-b2',
      routeId: fixture.b.route.id,
      sessionId: fixture.second.session.id
    }).code,
    'undone'
  );

  // 1) 单线记录页：当前场次 = 第二天，当前线路 = A。
  assert.equal(store.selectSession(fixture.second.session.id).ok, true);
  assert.equal(store.selectRoute(fixture.first.route.id).ok, true);
  const sessionPage = createPage(recordDefinition);
  sessionPage.onLoad({
    archiveId: store.loadState().archive.archiveId,
    sessionId: fixture.second.session.id,
    routeId: fixture.first.route.id
  });
  assert.equal(sessionPage.data.selectedRoute.id, fixture.first.route.id);
  assert.equal(sessionPage.data.attempts.length, 1, '场内逐把只列有效把次');
  assert.equal(sessionPage.data.attempts[0].label, '第 1 把');
  assert.equal(sessionPage.data.routeCountText, '1 把');
  // 换回第一天：那条线的第 3 把已撤回，逐把列表与把数同步为 2。
  assert.equal(store.selectSession(fixture.first.session.id).ok, true);
  assert.equal(store.selectRoute(fixture.first.route.id).ok, true);
  const day1Page = createPage(recordDefinition);
  day1Page.onLoad({
    archiveId: store.loadState().archive.archiveId,
    sessionId: fixture.first.session.id,
    routeId: fixture.first.route.id
  });
  assert.equal(day1Page.data.attempts.length, 2);
  assert.deepEqual(day1Page.data.attempts.map(row => row.label), ['第 1 把', '第 2 把']);
  assert.equal(day1Page.data.routeCountText, '2 把');

  // 2) 首页「继续本场」把数（当前场次 = 第一天，两条线的有效把次）。
  const homePage = createPage(indexDefinition);
  homePage.refreshTrainingEntry();
  assert.equal(homePage.data.hasActiveSession, true);
  assert.equal(homePage.data.activeSession.id, fixture.first.session.id);
  assert.equal(homePage.data.activeSession.attemptCountText, '3 把');

  // 3) 场次小结：同一条线、同一把数、最近有效备注跳过已撤回的那一句。
  const archive = store.loadState().archive;
  const summary1 = summary.buildSessionSummary(archive, fixture.first.session.id);
  assert.equal(summary1.attemptCount, 3);
  assert.equal(summary1.routeCount, 2);
  assert.equal(summary1.sendCount, 0);
  const rowA = summary1.routes.find(row => row.routeId === fixture.first.route.id);
  assert.equal(rowA.attemptCount, 2, '已撤回的第 3 把不算本场把数');
  assert.equal(rowA.latestNote, '第二把备注', '最近有效备注跳过已撤回的那一句');
  const summary2 = summary.buildSessionSummary(archive, fixture.second.session.id);
  assert.equal(summary2.attemptCount, 1);
  assert.equal(summary2.sendCount, 1);

  // 4) 线路逐把历史（详情页）。
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ routeId: fixture.first.route.id });
  assert.equal(routePage.data.attemptCount, 3);
  assert.equal(routePage.data.sendCount, 1);
  assert.equal(routePage.data.routeCompleted, true);
  const day1Group = routePage.data.groups.find(group => group.dateText === '2026-11-09');
  assert.equal(day1Group.attempts.length, 2);
  assert.deepEqual(day1Group.attempts.map(item => item.label), ['第 1 把', '第 2 把']);
  assert.equal(day1Group.countText, '2 把');

  // 5) 跨天历史（记录 tab 的本机历史）。
  const listPage = createPage(listDefinition);
  listPage.refreshLocalHistory();
  const listA = listPage.data.localRoutes.find(row => row.id === fixture.first.route.id);
  assert.equal(listA.countText, '2 天 · 2 场 · 3 把');
  assert.equal(listA.sendText, '1 次完攀');
  const listB = listPage.data.localRoutes.find(row => row.id === fixture.b.route.id);
  assert.equal(listB.countText, '1 天 · 1 场 · 1 把', 'B 线只剩第一天那一把');

  // 6) 底部统计（同一分母：本机有效把次）。
  const statsPage = createPage(statsDefinition);
  statsPage.loadStats();
  assert.equal(statsPage.data.totalAttempts, 4);
  assert.equal(statsPage.data.sendCount, 1);
  assert.equal(statsPage.data.failCount, 3);
  assert.equal(statsPage.data.completionRate, 25);
  assert.equal(statsPage.data.boulderMaxGrade, 'V3');
  assert.equal(statsPage.data.isEmpty, false);

  // 7) 想爬清单：累计把数与最近有效备注同源。
  assert.equal(wishlist.addWishlist(fixture.first.route.id).ok, true);
  const listed = wishlist.listWishlist(archive);
  const entryA = listed.items.find(item => item.routeId === fixture.first.route.id);
  assert.equal(entryA.attemptCount, 3);
  assert.equal(entryA.latestNote, '第二把备注');
  assert.equal(entryA.status, wishlist.STATUS_COMPLETED, '有效完攀仍在');
  const stats = wishlist.routeAttemptStats(archive, fixture.first.route.id);
  assert.equal(stats.attemptCount, 3);
  assert.equal(stats.sendCount, 1);
});

test('T032 待保存记录不计入任何读数端', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 15, 0) });
  addAttempt(session, route, 'fail', '已提交的一把', new Date(2026, 10, 9, 15, 5));

  // 第一段落盘、回执丢失：留下一条「进行中」，没有提交。
  armSetLoseResponseAt(1);
  const pending = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(pending.ok, false);
  assert.equal(archiveOf().pendingSaves.length, 1);
  resetFault();

  const archive = store.loadState().archive;
  assert.equal(store.attemptsFor(archive, { routeId: route.id }).length, 1, '待保存不进有效集合');
  const built = summary.buildSessionSummary(archive, session.id);
  assert.equal(built.attemptCount, 1);
  assert.equal(built.pendingCount, 1);
  const statsPage = createPage(statsDefinition);
  statsPage.loadStats();
  assert.equal(statsPage.data.totalAttempts, 1);
  const homePage = createPage(indexDefinition);
  homePage.refreshTrainingEntry();
  assert.equal(homePage.data.activeSession.attemptCountText, '1 把');
});

test('T032 撤回只写训练档案键：照片索引、想爬清单、体测与旧云归属保持原字节', () => {
  const seeded = seedThreeAttempts();
  const photoBlob = JSON.stringify({ photos: [{ routeId: seeded.route.id, file: 'wxfile://a.jpg' }] });
  const fitnessBlob = JSON.stringify({ records: [{ grade: 'V4' }] });
  const wishlistBlob = JSON.stringify({ version: 1, items: [] });
  storage.set(PHOTO_KEY, photoBlob);
  storage.set(FITNESS_KEY, fitnessBlob);
  storage.set(WISHLIST_KEY, wishlistBlob);

  io.writes.length = 0;
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'undo-isolation' }).code, 'undone');
  assert.equal(store.restoreAttempt(seeded.third.id, { opId: 'restore-isolation' }).code, 'restored');

  assert.deepEqual([...new Set(io.writes)], [ARCHIVE_KEY], '只写正式训练档案这一个键');
  assert.equal(storage.get(PHOTO_KEY), photoBlob, '照片索引保持原归属');
  assert.equal(storage.get(FITNESS_KEY), fitnessBlob, '体测记录不动');
  assert.equal(storage.get(WISHLIST_KEY), wishlistBlob, '想爬清单不动');
  assert.equal(io.removals.length, 0, '不删除任何键');

  // 源码边界：本层不接云、不写视频或照片。
  const source = fs.readFileSync(STORE_JS, 'utf8');
  assert.doesNotMatch(source, /wx\.cloud/);
  assert.doesNotMatch(source, /removeStorageSync\(ARCHIVE_KEY\)/);
});

// ------------------------------------------------------------------ *
// 旧档案兼容与隔离
// ------------------------------------------------------------------ *

function legacyAttempt(overrides) {
  return Object.assign(
    {
      id: 'op-legacy-1',
      seq: 1,
      sessionId: 'session-1',
      routeId: 'route-1',
      result: 'fail',
      note: '',
      createdAt: '2025-01-01T10:00:00.000Z'
    },
    overrides || {}
  );
}

function legacyArchive(overrides) {
  return Object.assign(
    {
      version: 1,
      archiveId: 'archive-legacy-undo',
      nextGymSeq: 2,
      nextSessionSeq: 2,
      nextRouteSeq: 2,
      nextAttemptSeq: 3,
      gyms: [{ id: 'gym-1', name: '老岩馆', createdAt: '2025-01-01T09:00:00.000Z' }],
      sessions: [
        {
          id: 'session-1',
          seq: 1,
          gymId: 'gym-1',
          date: '2025-01-01',
          createdAt: '2025-01-01T09:00:00.000Z'
        }
      ],
      routes: [
        {
          id: 'route-1',
          seq: 1,
          gymId: 'gym-1',
          name: '旧 V 级线',
          grade: 'V2',
          createdAt: '2025-01-01T09:05:00.000Z'
        }
      ],
      attempts: [legacyAttempt(), legacyAttempt({ id: 'op-legacy-2', seq: 2, result: 'send', note: '旧完攀' })],
      activeSessionId: 'session-1',
      activeRouteId: 'route-1'
    },
    overrides || {}
  );
}

test('T032 基线旧档案：缺撤回字段时全部已提交把次默认有效，只读打开不改原字节', () => {
  storage.set(ARCHIVE_KEY, JSON.stringify(legacyArchive()));
  const bytes = rawArchive();

  // 只读打开：不写盘、不迁移、不改原字节。
  const readsBefore = io.reads.length;
  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.ok(io.reads.length > readsBefore);
  assert.equal(rawArchive(), bytes, '只读打开不改原字节');
  assert.equal(io.writes.length, 0);

  // 旧档案没有撤回字段：读取按空数组兼容，所有把次默认有效。
  assert.deepEqual(loaded.archive.pendingUndos, []);
  assert.deepEqual(loaded.archive.pendingRestores, []);
  assert.equal(loaded.archive.attempts.every(item => rules.isEffectiveAttempt(item)), true);
  assert.equal(store.attemptsFor(loaded.archive, { routeId: 'route-1' }).length, 2);
  assert.equal(store.routeHistory(loaded.archive, 'route-1').attemptCount, 2);
  assert.equal(store.routeCompletion(loaded.archive, 'route-1').completed, true);
  assert.equal(store.routesWithHistory(loaded.archive).length, 1);

  // 旧把次也能撤回/恢复，且不迁移其他字段。
  const undone = store.undoAttempt('op-legacy-2', { opId: 'undo-legacy' });
  assert.equal(undone.ok, true, undone.error);
  assert.equal(undone.code, 'undone');
  const afterUndo = archiveOf();
  assert.deepEqual(identityOf(afterUndo.attempts[1]), identityOf(legacyArchive().attempts[1]));
  assert.equal(store.attemptsFor(afterUndo, { routeId: 'route-1' }).length, 1);
  assert.equal(afterUndo.pendingUndos.length, 0);
  assert.equal(store.restoreAttempt('op-legacy-2', { opId: 'restore-legacy' }).code, 'restored');
  assert.equal(store.attemptsFor(archiveOf(), { routeId: 'route-1' }).length, 2);
});

test('T032 旧档案里失效的进行中标记读取时丢掉；结构不对才判损坏', () => {
  // 已经撤回的把次上还挂着「撤回进行中」：意图已达成，读取时丢掉标记。
  const doneMarker = legacyArchive({
    attempts: [legacyAttempt({ undoneAt: '2025-01-02T00:00:00.000Z' })],
    pendingUndos: [{ attemptId: 'op-legacy-1', sessionId: 'session-1', routeId: 'route-1' }]
  });
  storage.set(ARCHIVE_KEY, JSON.stringify(doneMarker));
  let loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.archive.pendingUndos.length, 0, '已达成意图的标记被丢掉');
  assert.equal(store.attemptsFor(loaded.archive, { routeId: 'route-1' }).length, 0);

  // 目标把次已不存在：同样丢掉，不猜。
  const orphanMarker = legacyArchive({
    pendingRestores: [{ attemptId: 'op-gone', sessionId: 'session-1', routeId: 'route-1' }]
  });
  storage.set(ARCHIVE_KEY, JSON.stringify(orphanMarker));
  loaded = store.loadState();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.archive.pendingRestores.length, 0);

  // 撤回标记不是字符串：判损坏并保留原字节（写入口拒绝落盘）。
  const badMarker = legacyArchive({ attempts: [legacyAttempt({ undoneAt: 123 })] });
  storage.set(ARCHIVE_KEY, JSON.stringify(badMarker));
  const brokenBytes = rawArchive();
  loaded = store.loadState();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.corrupt, true);
  assert.equal(loaded.error, store.ARCHIVE_BROKEN);
  assert.equal(store.undoAttempt('op-legacy-1').ok, false);
  assert.equal(rawArchive(), brokenBytes, '损坏时保留原数据');

  // 同一把次挂着两条撤回标记：判损坏，不猜哪一条生效。
  const duplicateMarkers = legacyArchive({
    pendingUndos: [
      { attemptId: 'op-legacy-1', sessionId: 'session-1', routeId: 'route-1' },
      { attemptId: 'op-legacy-1', sessionId: 'session-1', routeId: 'route-1' }
    ]
  });
  storage.set(ARCHIVE_KEY, JSON.stringify(duplicateMarkers));
  assert.equal(store.loadState().ok, false);
});

test('T032 同日多场：撤回一场的一把不影响另一场', () => {
  const first = beginTraining({
    gymName: '岩馆 A',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 9, 0),
    routeName: 'A 馆抱石线'
  });
  const second = store.startSession({
    gymName: '岩馆 B',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 18, 0)
  });
  assert.equal(second.ok, true, second.error);
  const secondRoute = store.createRoute({
    sessionId: second.session.id,
    name: 'B 馆顶绳线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(secondRoute.ok, true, secondRoute.error);

  const firstAttempt = addAttempt(first.session, first.route, 'fail', '第一场的一把');
  const secondAttempt = addAttempt(second.session, secondRoute.route, 'fail', '第二场的一把');
  assert.notEqual(first.session.id, second.session.id);

  assert.equal(
    store.undoAttempt(firstAttempt.id, { sessionId: first.session.id, opId: 'undo-day1' }).code,
    'undone'
  );

  assert.equal(store.attemptsFor(archiveOf(), { sessionId: first.session.id }).length, 0);
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: second.session.id }).length,
    1,
    '同日另一场不受影响'
  );
  assert.equal(
    archiveOf().attempts.find(item => item.id === secondAttempt.id).undoneAt,
    undefined
  );
  assert.equal(store.sessionLabel(store.loadState().archive, { date: '2026-11-09', id: second.session.id }), '第 2 场');
});

test('T032 两份档案有同名 ID：撤回不串档，换档后的迟到点击被拒', () => {
  const archiveA = legacyArchive({
    archiveId: 'archive-A',
    attempts: [legacyAttempt({ id: 'op-A-1' })]
  });
  const archiveB = legacyArchive({
    archiveId: 'archive-B',
    attempts: [legacyAttempt({ id: 'op-B-1' })]
  });

  storage.set(ARCHIVE_KEY, JSON.stringify(archiveA));
  assert.equal(store.undoAttempt('op-A-1', { archiveId: 'archive-A' }).code, 'undone');
  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: 'route-1' }).length, 0);

  // 换到另一份档案：同名的 route-1 / session-1 各有自己的把次。
  storage.set(ARCHIVE_KEY, JSON.stringify(archiveB));
  const bytesB = rawArchive();
  const fromA = store.undoAttempt('op-B-1', { archiveId: 'archive-A' });
  assert.equal(fromA.ok, false);
  assert.equal(fromA.code, 'archive-mismatch');
  assert.equal(rawArchive(), bytesB, '换档后的迟到点击不落盘');

  const missing = store.undoAttempt('op-A-1', { archiveId: 'archive-B' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing', '另一份档案里没有这条把次');

  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: 'route-1' }).length, 1);
  assert.equal(store.undoAttempt('op-B-1', { archiveId: 'archive-B' }).code, 'undone');
  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: 'route-1' }).length, 0);
});

test('T032 撤回后再保存新把：新把 ID 唯一；故障后按原意图重试不覆盖其他场的后续写入', () => {
  const first = beginTraining({
    gymName: '岩馆 A',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 9, 0),
    routeName: 'A 线'
  });
  const other = store.startSession({
    gymName: '岩馆 B',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 9, 0)
  });
  assert.equal(other.ok, true, other.error);
  const otherRoute = store.createRoute({
    sessionId: other.session.id,
    name: 'B 馆线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(otherRoute.ok, true, otherRoute.error);

  const target = addAttempt(first.session, first.route, 'fail', '要撤回的这一把', new Date(2026, 10, 9, 9, 5));

  // 撤回第二段失败：只留下进行中标记；随后另一场次照常新增一把。
  armSetFailAt(2);
  const failed = store.undoAttempt(target.id, {
    sessionId: first.session.id,
    routeId: first.route.id,
    opId: 'undo-cross-session'
  });
  assert.equal(failed.ok, false);
  assert.equal(archiveOf().pendingUndos.length, 1);

  const otherAttempt = addAttempt(
    other.session,
    otherRoute.route,
    'fail',
    '另一场后来的一把',
    new Date(2026, 10, 10, 9, 5)
  );
  assert.equal(
    archiveOf().attempts.find(item => item.id === otherAttempt.id).undoneAt,
    undefined,
    '另一场的后续写入已落盘'
  );

  // 故障解除后按原意图重试：只撤回原来那一把，不覆盖其他场的后续写入。
  resetFault();
  const retried = store.undoAttempt(target.id, {
    sessionId: first.session.id,
    routeId: first.route.id,
    opId: 'undo-cross-session'
  });
  assert.equal(retried.ok, true, retried.error);
  const after = archiveOf();
  assert.match(after.attempts.find(item => item.id === target.id).undoneAt, /^\d{4}-/);
  assert.equal(after.attempts.find(item => item.id === otherAttempt.id).undoneAt, undefined);
  assert.equal(store.attemptsFor(after, { sessionId: other.session.id }).length, 1);

  // 撤回后再保存新把：新把是新的持久 ID，且进入有效集合。
  const fresh = addAttempt(first.session, first.route, 'fail', '撤回后新记的一把');
  assert.notEqual(fresh.id, target.id);
  const ids = after.attempts.concat([fresh]).map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '新把的持久 ID 唯一');
  assert.equal(store.attemptsFor(archiveOf(), { sessionId: first.session.id }).length, 1);
});

// ------------------------------------------------------------------ *
// T032 返工：有效状态变更版本（rev）、稳定原序号与自动 ID 唯一
// ------------------------------------------------------------------ *

/** 重新加载一次档案层模块：让本层自己的 ID 计数器归零，模拟「退出重开一次小程序」。 */
function reloadStoreModule() {
  delete require.cache[require.resolve(STORE_JS)];
  return require(STORE_JS);
}

test('T032 有效状态变更版本：旧档缺省 0、撤回与恢复各加一、只读打开不回写', () => {
  const seeded = seedThreeAttempts();
  const thirdId = seeded.third.id;
  const persisted = () => archiveOf().attempts.find(item => item.id === thirdId);

  // 旧档/没动过的把次没有 rev：按 0 读，且只读打开不迁移、不改原字节。
  assert.equal(store.attemptRev(persisted()), 0);
  assert.equal(persisted().rev, undefined, '只读读取不写入 rev');
  const bytesBefore = rawArchive();
  store.loadState();
  store.routeHistory(store.loadState().archive, seeded.route.id);
  store.routeCompletion(store.loadState().archive, seeded.route.id);
  assert.equal(rawArchive(), bytesBefore, '只读打开不改原字节');

  // 撤回加一、恢复再加一：版本随着「有效状态变过几次」单调递增，重开后仍在。
  assert.equal(
    store.undoAttempt(thirdId, {
      opId: 'rev-undo',
      routeId: seeded.route.id,
      sessionId: seeded.session.id
    }).code,
    'undone'
  );
  assert.equal(store.attemptRev(persisted()), 1);
  assert.equal(
    store.restoreAttempt(thirdId, {
      opId: 'rev-restore',
      routeId: seeded.route.id,
      sessionId: seeded.session.id
    }).code,
    'restored'
  );
  assert.equal(store.attemptRev(persisted()), 2);
  assert.equal(store.attemptRev(store.loadState().archive.attempts.find(item => item.id === thirdId)), 2);
});

test('T032 带渲染时版本的撤回/恢复：版本不符按过期事件拒绝，一个字都不写', () => {
  const seeded = seedThreeAttempts();
  const thirdId = seeded.third.id;
  const scope = { routeId: seeded.route.id, sessionId: seeded.session.id };
  const revOf = () => store.attemptRev(store.loadState().archive.attempts.find(item => item.id === thirdId));
  assert.equal(revOf(), 0);

  // 渲染时版本为 0 的撤回：现在版本就是 0，落盘。
  assert.equal(store.undoAttempt(thirdId, { opId: 'v0-undo', ...scope, expectedRev: 0 }).code, 'undone');
  assert.equal(revOf(), 1);

  // 同一份「版本 0 的撤回」再来一次：版本已经变了，按过期事件拒绝，不改档案。
  const afterUndo = rawArchive();
  const replay = store.undoAttempt(thirdId, { opId: 'v0-undo-replay', ...scope, expectedRev: 0 });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'stale');
  assert.equal(rawArchive(), afterUndo);

  // 版本为 1 的恢复：对得上，落盘。
  assert.equal(store.restoreAttempt(thirdId, { opId: 'v1-restore', ...scope, expectedRev: 1 }).code, 'restored');
  assert.equal(revOf(), 2);

  // 现在状态看起来又变回「有效」：一份**从未送达**的旧撤回（版本 0）此时才送到，
  // 只比状态会误判成合法，靠版本认出它已经过期，不落盘。
  const afterRestore = rawArchive();
  const neverSent = store.undoAttempt(thirdId, { opId: 'never-sent-undo', ...scope, expectedRev: 0 });
  assert.equal(neverSent.ok, false);
  assert.equal(neverSent.code, 'stale');
  assert.equal(rawArchive(), afterRestore, '过期事件一个字都不写');
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).some(item => item.id === thirdId), true);

  // 反向同理：已撤回时，一份旧恢复事件（版本 1）也拒绝。
  const undoneAgain = store.undoAttempt(thirdId, { opId: 'v2-undo', ...scope, expected: 'effective', expectedRev: 2 });
  assert.equal(undoneAgain.code, 'undone');
  const afterSecondUndo = rawArchive();
  const staleRestore = store.restoreAttempt(thirdId, { opId: 'stale-restore', ...scope, expectedRev: 1 });
  assert.equal(staleRestore.ok, false);
  assert.equal(staleRestore.code, 'stale');
  assert.equal(rawArchive(), afterSecondUndo);
  assert.equal(effectiveOn(seeded.route.id, seeded.session.id).some(item => item.id === thirdId), false);

  // 旧调用（不带版本）保持兼容：状态一致即按原语义落盘。
  assert.equal(store.restoreAttempt(thirdId, { opId: 'no-version-restore', ...scope }).code, 'restored');
});

test('T032 没带 opId 的新一把另取唯一 ID：不顶替已撤回的同名把次，显式旧 opId 仍去重', () => {
  const seeded = seedThreeAttempts();
  const scope = { sessionId: seeded.session.id, routeId: seeded.route.id };
  const realNow = Date.now;
  const realRandom = Math.random;
  const pages = [];
  try {
    // 固定时钟与熵：两次「重开」会生成一模一样的候选 ID，用来逼出真正的撞名。
    Date.now = () => new Date(2026, 10, 9, 10, 0, 0).getTime();
    Math.random = () => 0.625;

    const firstStore = reloadStoreModule();
    pages.push(firstStore);
    const first = firstStore.saveAttempt({ ...scope, result: 'fail', note: '自动 ID 的第一把' }).attempt;
    assert.equal(
      firstStore.undoAttempt(first.id, { opId: 'undo-auto-id', ...scope }).code,
      'undone',
      '第一把先撤回，留在档案里占着这个 ID'
    );

    // 「退出重开」：本层计数器归零，候选 ID 与刚才完全相同。
    const secondStore = reloadStoreModule();
    const second = secondStore.saveAttempt({ ...scope, result: 'fail', note: '重开后的新一把' }).attempt;
    assert.notEqual(second.id, first.id, '新一把必须另取唯一 ID，不能复用已撤回的那一把');
    assert.equal(second.note, '重开后的新一把');
    const persisted = secondStore.loadState().archive.attempts;
    assert.equal(persisted.filter(item => item.id === first.id).length, 1);
    assert.equal(persisted.filter(item => item.id === second.id).length, 1);
    const firstRow = persisted.find(item => item.id === first.id);
    assert.notEqual(firstRow.undoneAt, undefined, '已撤回的那一把保持撤回，没有被新一把复活');
    assert.equal(firstRow.note, '自动 ID 的第一把');

    // 显式带旧 opId 的延迟保存仍然去重：只复用原记录，不新增、也不复活。
    const before = rawArchive();
    const delayed = secondStore.saveAttempt({ opId: first.id, ...scope, result: 'fail', note: '迟到的旧保存' });
    assert.equal(delayed.ok, true);
    assert.equal(delayed.duplicate, true);
    assert.equal(delayed.undone, true);
    assert.equal(rawArchive(), before, '显式旧 opId 的迟到保存不写盘');
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    delete require.cache[require.resolve(STORE_JS)];
    require(STORE_JS);
  }
});

test('T032 单场单线稳定原序号：撤回第 3 把后新记的一把是第 4 把，历史与更正行共用同一份标号', () => {
  const seeded = seedThreeAttempts();
  const scope = { routeId: seeded.route.id, sessionId: seeded.session.id };
  assert.equal(
    store.undoAttempt(seeded.third.id, { opId: 'ordinal-undo', ...scope }).code,
    'undone'
  );
  const fourth = addAttempt(seeded.session, seeded.route, 'fail', '撤回后的新一把', new Date(2026, 10, 9, 10, 30));

  // 已撤回的那一把照样占着原序号：新一把接第 4 把，不被撤回挤成第 3 把。
  const ordinals = store.attemptOrdinalMap(archiveOf(), seeded.session.id, seeded.route.id);
  assert.equal(ordinals.get(seeded.first.id), 1);
  assert.equal(ordinals.get(seeded.second.id), 2);
  assert.equal(ordinals.get(seeded.third.id), 3, '已撤回的第 3 把仍是第 3 把');
  assert.equal(ordinals.get(fourth.id), 4);
  assert.equal(ordinals.get(seeded.neighborAttempt.id), undefined, '别的线路不参与本线的编号');

  // 跨日历史用同一份标号，且只列有效把次（第 1、2、4 把）。
  const history = store.routeHistory(archiveOf(), seeded.route.id);
  const group = history.groups.find(item => item.sessionId === seeded.session.id);
  assert.deepEqual(
    group.attempts.map(item => [item.id, item.label]),
    [
      [seeded.first.id, '第 1 把'],
      [seeded.second.id, '第 2 把'],
      [fourth.id, '第 4 把']
    ]
  );
  assert.equal(history.attemptCount, 3, '已撤回的那一把不贡献把数');

  // 「改为未完成」的行体（抱石唯一完攀）也用同一份稳定原序号。
  const send = addAttempt(seeded.session, seeded.route, 'send', '第五把完攀', new Date(2026, 10, 9, 10, 40));
  const targets = store.routeCorrectionTargets(archiveOf(), seeded.route.id);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].attemptId, send.id);
  assert.equal(targets[0].label, '第 5 把');
});

test('T032 已结清凭据的只读查询：只认这次操作自己的 opId，别的不认领也不写盘', () => {
  const seeded = seedThreeAttempts();
  const scope = { routeId: seeded.route.id, sessionId: seeded.session.id };

  // 同一把上先撤回一次、再恢复一次：两条结清凭据各带自己的 opId 与意图。
  assert.equal(store.undoAttempt(seeded.third.id, { opId: 'op-undo-1', ...scope }).code, 'undone');
  assert.equal(store.restoreAttempt(seeded.third.id, { opId: 'op-restore-1', ...scope }).code, 'restored');

  const attempt = archiveOf().attempts.find(item => item.id === seeded.third.id);
  const bytes = rawArchive();

  const undoReceipt = store.attemptSettledOp(attempt, 'op-undo-1');
  assert.equal(undoReceipt.opId, 'op-undo-1');
  assert.equal(undoReceipt.undone, true, '这一次凭据记的是撤回');
  assert.ok(undoReceipt.at, '凭据带落盘时间');
  assert.equal(store.attemptSettledOp(attempt, 'op-restore-1').undone, false, '这一次凭据记的是恢复');

  // 返回的是副本：改它不改档案。
  undoReceipt.undone = false;
  assert.equal(store.attemptSettledOp(attempt, 'op-undo-1').undone, true, '查询结果是副本');

  // 别的 operation 的 opId 认不出来：另一个写者不能借用这次的回执。
  assert.equal(store.attemptSettledOp(attempt, 'op-of-another-writer'), null);
  assert.equal(store.attemptSettledOp(attempt, ''), null);
  assert.equal(store.attemptSettledOp(attempt, null), null);
  assert.equal(store.attemptSettledOp(null, 'op-undo-1'), null);
  // 旧档案没有 settledOps：按空读取，也不因此改写原数据。
  assert.equal(store.attemptSettledOp({ id: 'legacy' }, 'op-undo-1'), null);
  assert.equal(rawArchive(), bytes, '只读查询不写盘');
});

// ------------------------------------------------------------------ *
// T037 返工：撤回/恢复完攀时结果区与最近把次区高度稳定
// ------------------------------------------------------------------ *

test('T037 返工 撤回/恢复完攀时更正区留同高惰性行：原坐标只落在原动作或空槽', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 9, 0) });
  addAttempt(session, route, 'fail', '第一把', new Date(2026, 10, 9, 9, 10));
  const send = addAttempt(session, route, 'send', '第三把完攀', new Date(2026, 10, 9, 9, 20));

  const page = createPage(recordDefinition);
  page.onLoad({ archiveId: archiveOf().archiveId, sessionId: session.id, routeId: route.id });
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.correctionRows.length, 1, '完攀时更正区有一行');
  assert.equal(page.data.correctionPlaceholder, false);
  assert.equal(page.data.recentAttempt.canUndo, true);
  assert.equal(page.data.recentAttempt.isSend, true);

  const rowEvent = row => ({
    currentTarget: {
      dataset: {
        attemptId: row.attemptId,
        routeId: row.routeId,
        sessionId: row.sessionId,
        archiveId: row.archiveId,
        expected: row.expected,
        expectedRev: row.expectedRev
      }
    }
  });

  // 撤回完攀：更正区原行不在了，但留一条同编号、同日期场次岩馆的惰性行，
  // 页面高度不缩短；最近一把的撤回半槽变成空槽，恢复半槽才出现按钮。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.correctionRows.length, 0);
  assert.equal(page.data.correctionPlaceholder, true, '撤回后留同高惰性行');
  assert.equal(page.data.recentAttempt.canRestore, true);
  assert.equal(page.data.recentAttempt.isSend, true);
  assert.equal(page.data.recentAttempt.correctionLabel, '第 2 把', '与原更正行同一编号');
  assert.match(page.data.recentAttempt.correctionContextText, /我自己去的岩馆/);
  assert.equal(page.data.recentAttempt.attemptId, send.id);

  // 恢复：惰性行让位给原来的更正行，高度不变。
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.correctionRows.length, 1);
  assert.equal(page.data.correctionPlaceholder, false);
  assert.equal(page.data.correctionRows[0].attemptId, send.id);

  // WXML：惰性行与真实更正行同一结构且没有任何点击绑定；固定槽高由局部样式给出。
  const wxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxml'),
    'utf8'
  );
  assert.match(wxml, /correctionRows\.length > 0 \|\| correctionPlaceholder/);
  const idleStart = wxml.indexOf('id="route-correction-idle"');
  assert.ok(idleStart > 0, '惰性行在模板里');
  const idleBlock = wxml.slice(idleStart, idleStart + 700);
  assert.equal(/bindtap|catchtap/.test(idleBlock), false, '惰性行不可点，不会变成结果按钮');
  assert.match(idleBlock, /route-correction-row/);
  assert.match(idleBlock, /已撤回，暂不可改/);

  const wxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxss'),
    'utf8'
  );
  assert.match(wxss, /\.route-correction-slot \{[^}]*min-height: 44px/, '半槽 44px 固定');
  assert.match(wxss, /\.recent-attempt-guidance-slot \{[^}]*min-height: 32px/, '说明槽固定高度');
  assert.match(wxss, /\.result-button \{[^}]*min-height: 48px/, '结果按钮 48px');
  assert.match(wxss, /\.route-completed-panel,[\s\S]*?min-height: 48px/, '完攀面板同高');
});
