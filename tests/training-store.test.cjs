/**
 * T016 正式本机训练档案回归测试（R1、R3、R5 的数据层）
 *
 * 用隔离的微信本地存储替身与故障注入驱动真实 utils/training-store.js：
 * 覆盖空档案、稳定 ID、同日多场、同色同级多线、重开一致、落盘失败与重试幂等、
 * 抱石完攀守卫与按把更正、绳攀可重复，以及普通清缓存的保护边界。
 *
 * 同时核对云隔离：没有 wx.cloud 时正式入口模块能加载、本机读写成功，
 * 旧云读请求以可判别错误失败（utils/db.js 的 CLOUD_UNAVAILABLE）。
 *
 * 真机退出恢复与存储空间表现不在本文件，留给整体验收（待验）。
 *
 * 运行：node --test tests/training-store.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const RULES_JS = path.join(ROOT, 'utils', 'training-rules.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const APP_JS = path.join(ROOT, 'app.js');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');

// ---- 微信本地存储替身：只在正式本机命名空间内读写，并按需注入故障 ----
const storage = new Map();
const fault = {
  setFailAt: 0,
  setCount: 0,
  getFail: false,
  removeFail: false,
  infoFail: false
};

function resetStorage() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.getFail = false;
  fault.removeFail = false;
  fault.infoFail = false;
}

function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

// 刻意不带 cloud：T016 要求正式入口在无云能力时也能加载与本机读写。
global.wx = {
  getStorageSync(key) {
    if (fault.getFail) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    storage.set(key, value);
  },
  removeStorageSync(key) {
    if (fault.removeFail) throw new Error('removeStorageSync:fail injected');
    storage.delete(key);
  },
  getStorageInfoSync() {
    if (fault.infoFail) throw new Error('getStorageInfoSync:fail injected');
    return { keys: [...storage.keys()] };
  }
};

const store = require(STORE_JS);
const rules = require(RULES_JS);

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';

function readArchiveRaw() {
  return storage.get(ARCHIVE_KEY);
}

function archiveObject() {
  return JSON.parse(readArchiveRaw());
}

// 一次训练的最常用前置：开一场、建一条线路。
function beginTraining(options = {}) {
  const started = store.startSession({
    gymName: options.gymName || '我自己去的岩馆',
    now: options.now || new Date(2026, 10, 9, 8, 30),
    date: options.date
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

beforeEach(() => {
  resetStorage();
});

// ------------------------------------------------------------------ *
// 空档案与稳定 ID
// ------------------------------------------------------------------ *

test('R1 首次无正式键返回空档案，不报错也不落盘', () => {
  const loaded = store.loadState();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.present, false);
  assert.equal(loaded.error, '');
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.archive.gyms.length, 0);
  assert.equal(loaded.archive.sessions.length, 0);
  assert.equal(loaded.archive.routes.length, 0);
  assert.match(loaded.archive.archiveId, /^archive-/);
  // 只读不落盘：键仍不存在。
  assert.equal(readArchiveRaw(), undefined);
  assert.equal(store.hasArchive(), false);
});

test('R1 用自己输入的岩馆建立场次，重开保持原档案 ID、场次与本地日期', () => {
  const { session } = beginTraining({ now: new Date(2026, 10, 9, 21, 5) });

  // 存进正式命名空间。
  assert.ok(store.NAMESPACE === 'climbingNote.training.v1.');
  assert.equal(store.ARCHIVE_KEY, ARCHIVE_KEY);
  assert.equal(store.PHOTO_INDEX_KEY, PHOTO_KEY);

  const firstArchiveId = archiveObject().archiveId;
  assert.match(firstArchiveId, /^archive-/);

  // 重开：同一档案 ID、同一场次，本地日期按训练所在地（本机）当天。
  const reloaded = store.loadState();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.archive.archiveId, firstArchiveId);
  assert.equal(reloaded.archive.sessions.length, 1);
  assert.equal(reloaded.archive.sessions[0].id, session.id);
  assert.equal(reloaded.archive.sessions[0].date, '2026-11-09');
  assert.equal(reloaded.archive.activeSessionId, session.id);
  assert.equal(reloaded.archive.gyms[0].name, '我自己去的岩馆');
});

test('R1 重开后当前线路选择保持一致', () => {
  const { session, route } = beginTraining();
  const selected = store.selectRoute(route.id);
  assert.equal(selected.ok, true, selected.error);
  assert.equal(selected.archive.activeRouteId, route.id);

  const reloaded = store.loadState();
  assert.equal(reloaded.archive.activeSessionId, session.id);
  assert.equal(reloaded.archive.activeRouteId, route.id);
});

test('R1 同日两场各自独立，主动另开才产生第二场', () => {
  const now = new Date(2026, 10, 9, 9, 0);
  const first = store.startSession({ gymName: '岩馆 A', now });
  const second = store.startSession({ gymName: '岩馆 B', now });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.notEqual(first.session.id, second.session.id);

  const reloaded = store.loadState();
  const today = store.sessionsOnDate(reloaded.archive, '2026-11-09');
  assert.equal(today.length, 2);
  assert.deepEqual(today.map(item => item.id), [first.session.id, second.session.id]);
  assert.equal(store.sessionLabel(reloaded.archive, today[0]), '第 1 场');
  assert.equal(store.sessionLabel(reloaded.archive, today[1]), '第 2 场');
  // 同名岩馆复用同一个岩馆 ID，不会每次新建。
  const third = store.startSession({ gymName: '岩馆 A', now });
  assert.equal(third.session.gymId, first.session.gymId);
});

test('R2 同色同级的两条线路各有独立 ID，互不带把次', () => {
  const { session } = beginTraining({ routeName: '蓝色动态线' });
  const second = store.createRoute({
    sessionId: session.id,
    name: '蓝色平衡线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色'
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.loadState().archive.routes.length, 2);
  // 两条线路的等级与颜色相同，但 ID 不同。
  assert.equal(second.route.grade, 'V3');
  assert.equal(second.route.colorName, '蓝色');
  assert.notEqual(second.route.id, store.loadState().archive.routes[0].id);
  // 第二条线不带第一条的把次。
  assert.equal(store.attemptsFor(store.loadState().archive, { routeId: second.route.id }).length, 0);
});

test('R1 读到损坏的已有数据时可见报错并保留原数据', () => {
  storage.set(ARCHIVE_KEY, '{ 这不是合法 JSON');
  const corruptRaw = readArchiveRaw();

  const loaded = store.loadState();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.corrupt, true);
  assert.equal(loaded.error, store.ARCHIVE_BROKEN);
  assert.equal(readArchiveRaw(), corruptRaw, '损坏数据必须原样保留');

  // 写入口在损坏时拒绝落盘，绝不覆盖原数据。
  const started = store.startSession({ gymName: '新岩馆' });
  assert.equal(started.ok, false);
  assert.equal(started.error, store.ARCHIVE_BROKEN);
  assert.equal(readArchiveRaw(), corruptRaw);
});

test('R1 读到不支持的档案版本时可见报错并保留原数据', () => {
  storage.set(ARCHIVE_KEY, JSON.stringify({ version: 999, archiveId: 'archive-x' }));
  const raw = readArchiveRaw();

  const loaded = store.loadState();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error, store.ARCHIVE_UNSUPPORTED);

  const saved = store.saveAttempt({ routeId: 'route-1', result: 'fail', sessionId: 'session-1' });
  assert.equal(saved.ok, false);
  assert.equal(readArchiveRaw(), raw);
});

test('R1 读取本身失败时返回错误而不是崩溃', () => {
  fault.getFail = true;
  const loaded = store.loadState();
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /读取本机训练档案失败/);
  fault.getFail = false;
});

// ------------------------------------------------------------------ *
// 命名空间、持久化、落盘失败与重试幂等
// ------------------------------------------------------------------ *

test('R3 保存逐把结果与备注，重开后逐项一致', () => {
  const { session, route } = beginTraining({ now: new Date(2026, 10, 9, 10, 0) });
  const first = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    now: new Date(2026, 10, 9, 10, 5)
  });
  assert.equal(first.ok, true, first.error);
  const second = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    note: '抓到后向右摆',
    now: new Date(2026, 10, 9, 10, 8)
  });
  assert.equal(second.ok, true, second.error);

  const reloaded = store.loadState().archive;
  const attempts = store.attemptsFor(reloaded, { sessionId: session.id, routeId: route.id });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].result, 'fail');
  assert.equal(attempts[0].note, '');
  assert.equal(attempts[1].note, '抓到后向右摆');
  assert.deepEqual(attempts.map(item => item.id), [first.attempt.id, second.attempt.id]);
  assert.equal(attempts[0].createdAt, new Date(2026, 10, 9, 10, 5).toISOString());
});

test('R3 落盘失败不报已保存；重试同一操作只提交一次', () => {
  const { session, route } = beginTraining();
  // 第一段写（进行中标记）就失败：没有任何数据落盘。
  armSetFailAt(1);
  const failed = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /保存本机训练档案失败/);
  assert.equal(store.loadState().archive.attempts.length, 0);
  assert.equal(store.loadState().archive.pendingSaves.length, 0);

  // 故障解除后按同一操作 ID 重试：只产生一把，且 ID 与首次操作一致。
  armSetFailAt(0);
  const retried = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    opId: failed.opId
  });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.duplicate, false);
  assert.equal(store.loadState().archive.attempts.length, 1);
  assert.equal(store.loadState().archive.attempts[0].id, failed.opId);
});

test('R3 提交那一把落盘失败时保留进行中标记，重试复用同一 ID 与序号', () => {
  const { session, route } = beginTraining();
  // 第二段写（提交把次）失败：进行中标记已落盘、把次未落盘。
  armSetFailAt(2);
  const failed = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(failed.ok, false);
  const staged = store.loadState().archive;
  assert.equal(staged.attempts.length, 0);
  assert.equal(staged.pendingSaves.length, 1);
  const stagedSeq = staged.pendingSaves[0].seq;

  armSetFailAt(0);
  const retried = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    opId: failed.opId
  });
  assert.equal(retried.ok, true, retried.error);
  const reloaded = store.loadState().archive;
  assert.equal(reloaded.attempts.length, 1, '重试后只应有一把');
  assert.equal(reloaded.attempts[0].id, failed.opId);
  assert.equal(reloaded.attempts[0].seq, stagedSeq, '重试复用原序号，不跳号');
  assert.equal(reloaded.pendingSaves.length, 0);
});

test('R3 同一操作重复提交幂等：只提交一次，不产生第二把', () => {
  const { session, route } = beginTraining();
  const first = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(first.ok, true, first.error);
  const again = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    opId: first.opId
  });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(store.loadState().archive.attempts.length, 1);
});

test('R3 新一次真实尝试拿到新的把次 ID', () => {
  const { session, route } = beginTraining();
  const first = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  const second = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.notEqual(first.opId, second.opId);
  assert.notEqual(first.attempt.id, second.attempt.id);
  assert.equal(store.loadState().archive.attempts.length, 2);
});

test('R5 两个页面的迟到操作与重复提交不覆盖新数据', () => {
  const { session, route } = beginTraining();

  // 页面 A 先读到一份旧快照（模拟它页面上的状态）。
  const pageASnapshot = store.loadState().archive;
  assert.equal(pageASnapshot.attempts.length, 0);

  // 页面 B 提交一把并落盘。
  const fromB = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail', note: 'B 写的' });
  assert.equal(fromB.ok, true, fromB.error);

  // 页面 A 之后才提交自己的一把：增量追加，不覆盖 B 的新数据。
  const fromA = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail', note: 'A 写的' });
  assert.equal(fromA.ok, true, fromA.error);

  const reloaded = store.loadState().archive;
  assert.equal(reloaded.attempts.length, 2);
  const byId = new Map(reloaded.attempts.map(item => [item.id, item]));
  assert.equal(byId.get(fromB.attempt.id).note, 'B 写的', 'B 的结果不能被 A 覆盖');
  assert.equal(byId.get(fromA.attempt.id).note, 'A 写的');

  // 页面 A 又重复提交了 B 的那次操作：幂等，仍是两把。
  const duplicate = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    opId: fromB.opId
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.loadState().archive.attempts.length, 2);
});

// ------------------------------------------------------------------ *
// 抱石完攀语义、按把更正与绳攀可重复
// ------------------------------------------------------------------ *

test('R3 抱石确认完攀后收起新增入口，同一次再记被拒', () => {
  const { session, route } = beginTraining();
  store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  const send = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(send.ok, true, send.error);

  const completion = store.routeCompletion(store.loadState().archive, route.id);
  assert.equal(completion.isBoulder, true);
  assert.equal(completion.hasSend, true);
  assert.equal(completion.closed, true);
  assert.equal(completion.canRecord, false);

  const blocked = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.alreadySent, true);
  assert.equal(store.loadState().archive.attempts.length, 3, '被拒的完攀不落盘');
});

test('R3 抱石按把更正：把数不变，ID/场次/备注保留，之后可再记一次完攀', () => {
  const { session, route } = beginTraining();
  store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  const noted = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'fail',
    note: '第二把备注'
  });
  const send = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send', note: '完攀这把' });
  assert.equal(send.ok, true, send.error);

  const corrected = store.correctAttempt(send.attempt.id, { routeId: route.id, sessionId: session.id });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.code, 'corrected');

  const reloaded = store.loadState().archive;
  const attempts = store.attemptsFor(reloaded, { routeId: route.id });
  assert.equal(attempts.length, 3, '更正不增把数');
  const target = attempts.find(item => item.id === send.attempt.id);
  assert.equal(target.result, 'fail', '原位改成未完成');
  assert.equal(target.sessionId, session.id);
  assert.equal(target.note, '完攀这把', '备注保持');
  assert.equal(attempts.find(item => item.id === noted.attempt.id).note, '第二把备注');
  assert.equal(store.routeCompletion(reloaded, route.id).hasSend, false);
  assert.equal(store.routeCompletion(reloaded, route.id).closed, false);

  // 更正后可以再正常记一次完攀，总把数加一。
  const resend = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(resend.ok, true, resend.error);
  const after = store.loadState().archive;
  assert.equal(after.attempts.length, 4);
  assert.equal(store.routeCompletion(after, route.id).sendCount, 1);
});

test('R3 更正幂等：重复/迟到的「改为未完成」只复用结果', () => {
  const { session, route } = beginTraining();
  const send = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  const first = store.correctAttempt(send.attempt.id, { routeId: route.id });
  assert.equal(first.code, 'corrected');
  const again = store.correctAttempt(send.attempt.id, { routeId: route.id });
  assert.equal(again.ok, true);
  assert.equal(again.code, 'resolved');
  assert.equal(again.duplicate, true);
  assert.equal(store.loadState().archive.attempts.length, 1);
});

test('R3 更正的目标校验：跨线路冲突、非抱石不支持、找不到把次', () => {
  const { session, route } = beginTraining();
  const send = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });

  const conflict = store.correctAttempt(send.attempt.id, { routeId: 'route-999' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
  assert.equal(store.loadState().archive.attempts[0].result, 'send', '冲突时不改动任何数据');

  const missing = store.correctAttempt('op-not-exist');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  // 顶绳线上已完攀的把次不能「改为未完成」。
  const ropeRoute = store.createRoute({
    sessionId: session.id,
    name: '顶绳线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(ropeRoute.ok, true, ropeRoute.error);
  const ropeSend = store.saveAttempt({ sessionId: session.id, routeId: ropeRoute.route.id, result: 'send' });
  const unsupported = store.correctAttempt(ropeSend.attempt.id, { routeId: ropeRoute.route.id });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'unsupported');
});

test('R3 更正落盘失败保留标记，重试后原位改对', () => {
  const { session, route } = beginTraining();
  const send = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });

  armSetFailAt(2); // 第一段写标记成功，第二段翻结果失败
  const failed = store.correctAttempt(send.attempt.id, { routeId: route.id, sessionId: session.id });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  const staged = store.loadState().archive;
  assert.equal(staged.attempts[0].result, 'send', '未落盘时本地仍显示完攀');
  assert.equal(staged.pendingCorrections.length, 1);

  armSetFailAt(0);
  const retried = store.correctAttempt(send.attempt.id, { routeId: route.id, sessionId: session.id });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.code, 'corrected');
  const reloaded = store.loadState().archive;
  assert.equal(reloaded.attempts[0].result, 'fail');
  assert.equal(reloaded.pendingCorrections.length, 0);
});

test('R3 绳攀（顶绳/先锋）完攀后可继续记，不触发抱石守卫', () => {
  const { session } = beginTraining({ climbType: '顶绳', grade: '5.10a', routeName: '顶绳线' });
  const ropeRoute = store.loadState().archive.routes[0];
  const first = store.saveAttempt({ sessionId: session.id, routeId: ropeRoute.id, result: 'send' });
  assert.equal(first.ok, true, first.error);
  const second = store.saveAttempt({ sessionId: session.id, routeId: ropeRoute.id, result: 'send' });
  assert.equal(second.ok, true, second.error);
  const completion = store.routeCompletion(store.loadState().archive, ropeRoute.id);
  assert.equal(completion.isBoulder, false);
  assert.equal(completion.repeatable, true);
  assert.equal(completion.closed, false);
  assert.equal(store.loadState().archive.attempts.length, 2);
});

test('R4 等级必须与类型匹配，错误组合不能落盘', () => {
  const started = store.startSession({ gymName: '岩馆', now: new Date(2026, 10, 9) });
  const bad = store.createRoute({
    sessionId: started.session.id,
    name: '错配线',
    climbType: '顶绳',
    grade: 'V3'
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /适用于该类型/);
  assert.equal(store.loadState().archive.routes.length, 0, '错误组合不落盘');

  const ok = store.createRoute({
    sessionId: started.session.id,
    name: '顶绳线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(ok.ok, true, ok.error);
  // 类型切换后的等级保留/清空判定。
  assert.equal(rules.resolveGradeForType('先锋', '5.10a'), '5.10a');
  assert.equal(rules.resolveGradeForType('顶绳', 'V3'), '');
  assert.equal(rules.resolveGradeForType('抱石', 'V3'), 'V3');
});

test('R3 按把更正目标逐个列出，最近一把在前', () => {
  const { session, route } = beginTraining();
  const sendOne = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  // 抱石首把就完攀：需要先更正才能再记一把完攀，构造两条历史完攀。
  store.correctAttempt(sendOne.attempt.id, { routeId: route.id });
  const sendTwo = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'send' });
  assert.equal(sendTwo.ok, true, sendTwo.error);

  const targets = store.routeCorrectionTargets(store.loadState().archive, route.id);
  assert.equal(targets.length, 1, '只有唯一一把确认完攀');
  assert.equal(targets[0].attemptId, sendTwo.attempt.id);
  assert.match(targets[0].label, /第 2 把/);
  assert.match(targets[0].contextText, /2026-11-09/);
});

// ------------------------------------------------------------------ *
// 云隔离与普通清缓存保护
// ------------------------------------------------------------------ *

test('R5 没有 wx.cloud 时正式档案层照常加载与本机读写', () => {
  assert.equal(typeof global.wx.cloud, 'undefined');
  const started = store.startSession({ gymName: '断网岩馆', now: new Date(2026, 10, 9) });
  assert.equal(started.ok, true, started.error);
  const reloaded = store.loadState();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.archive.sessions.length, 1);
});

test('R5 旧云读请求在无云能力时以可判别错误失败（惰性取得云客户端）', async () => {
  // 顶层加载 utils/db.js 不曾调用 wx.cloud.database()：这里显式删除 cloud 后再 require。
  const db = require(DB_JS);
  await assert.rejects(
    () => db.getRecords(1, 20),
    error => error && error.code === db.CLOUD_UNAVAILABLE
  );
  await assert.rejects(() => db.getRecordById('x'), error => error.code === db.CLOUD_UNAVAILABLE);
  await assert.rejects(() => db.getAllRecords(), error => error.code === db.CLOUD_UNAVAILABLE);
  await assert.rejects(() => db.addRecord({}), error => error.code === db.CLOUD_UNAVAILABLE);

  // 云能力恢复后仍走原契约（返回 Promise），不因之前的失败卡死。
  global.wx.cloud = {
    database() {
      return {
        serverDate: () => new Date('2026-01-01T00:00:00.000Z'),
        collection() {
          return {
            orderBy() { return this; },
            skip() { return this; },
            limit() { return this; },
            get() { return Promise.resolve({ data: [{ _id: 'rec-1' }] }); }
          };
        }
      };
    }
  };
  const ok = await db.getRecords(1, 20);
  assert.equal(ok.data.length, 1);
  delete global.wx.cloud;
});

test('R5 wx.cloud 缺失或初始化失败时 onLaunch 不抛错，仅标记云不可用', () => {
  let appDefinition = null;
  global.App = definition => {
    appDefinition = definition;
  };
  require(APP_JS);
  assert.ok(appDefinition, 'app.js 应注册 App 定义');

  // 场景一：没有 wx.cloud。
  delete global.wx.cloud;
  assert.doesNotThrow(() => appDefinition.onLaunch.call(appDefinition));
  assert.equal(appDefinition.globalData.cloudReady, false);

  // 场景二：有 wx.cloud 但 init 抛错（例如占位云环境）。
  global.wx.cloud = { init() { throw new Error('无效的环境 ID'); } };
  assert.doesNotThrow(() => appDefinition.onLaunch.call(appDefinition));
  assert.equal(appDefinition.globalData.cloudReady, false);

  // 场景三：init 正常。
  global.wx.cloud = { init() {} };
  appDefinition.onLaunch.call(appDefinition);
  assert.equal(appDefinition.globalData.cloudReady, true);
  delete global.wx.cloud;
});

test('R5 普通清缓存只清可重建内容，训练键/照片索引/其他键保持一致', () => {
  const training = '{"version":1,"archiveId":"archive-keep"}';
  const photoIndex = '{"v1":[]}';
  const rebuildableA = 'list-cache';
  const rebuildableB = 'thumb-meta';
  const otherTrial = '{"trial":true}';
  const otherUnknown = 'unrelated';
  storage.set(ARCHIVE_KEY, training);
  storage.set(PHOTO_KEY, photoIndex);
  storage.set('climbingNote.training.v1.cache.list', rebuildableA);
  storage.set('climbingNote.training.v1.thumbs.a', rebuildableB);
  storage.set('climbingNote.gymLogTrial.v1', otherTrial);
  storage.set('someOtherKey', otherUnknown);

  const result = store.clearRebuildableStorage();
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.removed.sort(),
    ['climbingNote.training.v1.cache.list', 'climbingNote.training.v1.thumbs.a']
  );

  // 训练键、照片索引、命名空间外的键全部原样保留。
  assert.equal(readArchiveRaw(), training);
  assert.equal(storage.get(PHOTO_KEY), photoIndex);
  assert.equal(storage.get('climbingNote.gymLogTrial.v1'), otherTrial);
  assert.equal(storage.get('someOtherKey'), otherUnknown);
  assert.equal(storage.has('climbingNote.training.v1.cache.list'), false);
  assert.equal(storage.has('climbingNote.training.v1.thumbs.a'), false);

  // 保护判定：命名空间内默认受保护，可重建前缀除外。
  assert.equal(store.isProtectedKey(ARCHIVE_KEY), true);
  assert.equal(store.isProtectedKey(PHOTO_KEY), true);
  assert.equal(store.isProtectedKey('climbingNote.training.v1.cache.x'), false);
  assert.equal(store.isProtectedKey('climbingNote.gymLogTrial.v1'), false);
});

test('R5 清缓存目录读取失败时返回错误且不动任何键', () => {
  storage.set(ARCHIVE_KEY, '{}');
  storage.set('climbingNote.training.v1.cache.list', 'x');
  fault.infoFail = true;
  const result = store.clearRebuildableStorage();
  assert.equal(result.ok, false);
  assert.match(result.error, /读取本机缓存目录失败/);
  assert.equal(readArchiveRaw(), '{}');
  assert.equal(storage.get('climbingNote.training.v1.cache.list'), 'x');
});

test('R5 正式页不再用 wx.clearStorage，改走受保护的清缓存入口', () => {
  const source = fs.readFileSync(PROFILE_JS, 'utf8');
  assert.doesNotMatch(source, /wx\.clearStorage\b/);
  assert.doesNotMatch(source, /clearStorageSync/);
  assert.match(source, /clearRebuildableStorage/);

  const storeSource = fs.readFileSync(STORE_JS, 'utf8');
  assert.doesNotMatch(storeSource, /clearStorageSync|wx\.clearStorage\b/);
  // 不引用试用键、不接云。
  assert.doesNotMatch(storeSource, /gymLogTrial/);
  assert.doesNotMatch(storeSource, /wx\.cloud/);
});
