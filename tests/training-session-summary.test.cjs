/**
 * T029 本次攀爬小结与下次续爬选择回归测试（R1、R2、R3 的离线部分）
 *
 * 直接加载真实的 utils/training-session-summary.js、utils/training-wishlist.js 与正式
 * 场内页 pages/training-session、底部统计页 pages/stats，用隔离的微信本地存储替身与
 * 写入故障注入驱动真实处理器，并核对 WXML 里的真实按钮绑定。
 *
 * 覆盖任务单的三条验收标准（离线部分）：
 * - 同馆同日两场各自统计：第一场 2 条线 3 把、完攀线路正确，第二场只算它自己那一把；
 *   空场与重复完攀的绳线分别核对「把数」与「不同线路数」；
 * - 把原完攀改为未完成后：小结把数不变、完攀随原记录更新，底部全档案统计各场把数一致；
 *   待保存操作、旧云汇总与自测成绩都不计入；
 * - 未完成线路勾选进本馆「下次想爬」只出现一次，取消与写失败都显示实际保存状态，
 *   其他收藏不丢失；重开与离线回看仍按原 sessionId、原线路 ID 取数；
 * - 小结区里的只读回看入口：两日三场时能直接从控件里选昨天的原场看整份小结，
 *   回到原线路照片后返回仍停在所选场次，也能选回当前场次；选择只换所看的小结，
 *   不改正在记录的 activeSession、不建场次、不写训练，也不挤占上方首屏结果按钮。
 *
 * 刻意不提供 wx.cloud 与本地文件系统：小结与勾选都不得依赖云能力，也不读写照片文件
 * （照片文件本身由 T019/T028 的测试覆盖）。真机触控、手机字体与真实跨日留给负责人整体
 * 验收（待验）。
 *
 * 运行：node --test tests/training-session-summary.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');
const FITNESS_JS = path.join(ROOT, 'utils', 'fitness-test.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTOS_KEY = 'climbingNote.training.v1.photos';
const WISHLIST_KEY = 'climbingNote.training.v1.wishlist';
const FITNESS_KEY = 'climbingNote.fitness.v1.records';

// ---- 微信本地存储替身：记录每次读写与文件系统调用，可按需注入写入故障 ----
const storage = new Map();
const keyWrites = new Map();
const io = { reads: [], writes: [], fsCalls: [], setFailAt: 0, setCount: 0 };

function resetDevice() {
  storage.clear();
  keyWrites.clear();
  io.reads = [];
  io.writes = [];
  io.fsCalls = [];
  io.setFailAt = 0;
  io.setCount = 0;
}

/** 从第 N 次 setStorageSync 开始失败：用于构造「落盘失败」与「留下待保存标记」。 */
function armSetFailAt(callNumber) {
  io.setCount = 0;
  io.setFailAt = callNumber;
}

function disarmSetFail() {
  io.setCount = 0;
  io.setFailAt = 0;
}

function writesOf(key) {
  return keyWrites.get(key) || 0;
}

function rawOf(key) {
  return storage.has(key) ? storage.get(key) : '';
}

const wxLog = { navigations: [], toasts: [], switches: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.toasts = [];
  wxLog.switches = [];
}

// 刻意不带 cloud；小结与勾选也不得碰文件系统（小结只读训练记录）。
global.wx = {
  getStorageSync(key) {
    io.reads.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    io.setCount += 1;
    if (io.setFailAt && io.setCount === io.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + io.setCount);
    }
    keyWrites.set(key, writesOf(key) + 1);
    io.writes.push(key);
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager() {
    io.fsCalls.push('getFileSystemManager');
    throw new Error('T029 小结与勾选不得访问文件系统');
  },
  navigateTo(options) {
    wxLog.navigations.push(options.url);
  },
  switchTab(options) {
    wxLog.switches.push(options.url);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  stopPullDownRefresh() {}
};

const db = require(DB_JS);
const realGetAllRecords = db.getAllRecords;
const store = require(STORE_JS);
const wishlist = require(WISHLIST_JS);
const { buildSessionSummary } = require(SUMMARY_JS);
const fitness = require(FITNESS_JS);

// 捕获原生 Page(...) 定义
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

const sessionDefinition = capturePage(SESSION_JS);
const statsDefinition = capturePage(STATS_JS);

/** 页面实例替身：支持 wx 的 setData 数据路径写法。 */
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

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

/**
 * 照片控制器替身：小结与勾选都不依赖照片文件，这里统一回答「无图」。
 * 页面只按 routeId 取照片状态，替身不改任何文件或索引。
 */
function fakePhotoUi() {
  return {
    init: () => Promise.resolve({ ok: true }),
    load: () => Promise.resolve(),
    clear: () => {},
    view() {
      return {
        status: 'none',
        hasPhoto: false,
        missing: false,
        thumbnailPath: '',
        mainPath: '',
        statusText: '添加线路照片（可选、可稍后添加）'
      };
    }
  };
}

function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  // 照片控制器替身：本文件只验证小结与清单，不读写任何照片文件或索引。
  page._photoUi = fakePhotoUi();
  page.refreshView();
  return page;
}

function openStatsPage() {
  const page = createPage(statsDefinition);
  page.onLoad();
  return page;
}

// ---- 走正式档案层搭建夹具（小结只读，页面只读；夹具一律经 store 注入） ----
const GYM_A = 'A 馆';
const GYM_B = 'B 馆';
const DAY = '2026-11-10';
const YESTERDAY = '2026-11-09';

function startAt(date, gymName) {
  const started = store.startSession({
    gymName,
    date,
    now: new Date(date + 'T09:30:00')
  });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function newRoute(session, options = {}) {
  const created = store.createRoute({
    sessionId: session.id,
    name: options.name || '蓝色动态线',
    climbType: options.climbType || '抱石',
    grade: options.grade || 'V3',
    colorName: options.colorName || '蓝色',
    colorHex: options.colorHex || '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function record(session, route, result, note) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note: note || ''
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveOf() {
  return store.loadState().archive;
}

/**
 * 同馆同日两场：
 * - 第一场两条线三把：抱石线一次未完成 + 一次完攀（完攀线路），顶绳线一把未完成；
 * - 第二场在同一家岩馆同一天另开，记同一条顶绳线的一把（未完成）。
 */
function twoSessionsFixture() {
  const s1 = startAt(DAY, GYM_A);
  const boulder = newRoute(s1, { name: '蓝色动态线', climbType: '抱石', grade: 'V4' });
  const rope = newRoute(s1, {
    name: '黄色耐力线',
    climbType: '顶绳',
    grade: '5.10a',
    colorName: '黄色'
  });
  record(s1, boulder, 'fail', '起步没抓住');
  record(s1, boulder, 'send', '第二次抓到结束点');
  record(s1, rope, 'fail');

  const s2 = startAt(DAY, GYM_A);
  record(s2, rope, 'fail', '第二场再试一次');

  return { s1, s2, boulder, rope };
}

/**
 * 两日三场（回看今天与昨天都要能用的真实形态）：
 * - 昨天一场两线三把：抱石线未完成 + 完攀（完攀线路），顶绳线一把未完成；
 * - 今天两场：第一场记了昨天那条顶绳线一把，第二场是当前场次（还没记）。
 */
function twoDaysFixture() {
  const yesterday = startAt(YESTERDAY, GYM_A);
  const boulder = newRoute(yesterday, {
    name: '蓝色动态线',
    climbType: '抱石',
    grade: 'V4'
  });
  const rope = newRoute(yesterday, {
    name: '黄色耐力线',
    climbType: '顶绳',
    grade: '5.10a',
    colorName: '黄色'
  });
  record(yesterday, boulder, 'fail', '起步没抓住');
  record(yesterday, boulder, 'send', '第二次抓到结束点');
  record(yesterday, rope, 'fail', '顶绳差一点');

  const todayFirst = startAt(DAY, GYM_A);
  record(todayFirst, rope, 'fail', '今天第一场再试');
  const todayActive = startAt(DAY, GYM_A);

  return { yesterday, todayFirst, todayActive, boulder, rope };
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
  db.getAllRecords = realGetAllRecords;
});

// ------------------------------------------------------------------ *
// R1 按场次独立统计
// ------------------------------------------------------------------ *

test('R1 同馆同日两场各自统计：第一场 2 条线 3 把 1 条完攀，第二场只算它自己那一把', () => {
  const { s1, s2, boulder, rope } = twoSessionsFixture();
  const archive = archiveOf();

  const first = buildSessionSummary(archive, s1.id);
  assert.equal(first.known, true);
  assert.equal(first.gymName, GYM_A);
  assert.equal(first.date, DAY);
  assert.equal(first.label, '第 1 场');
  assert.equal(first.sameDayCount, 2, '同一天两场');
  assert.equal(first.isEmpty, false);
  assert.equal(first.routeCount, 2, '两条不同线路');
  assert.equal(first.attemptCount, 3, '三条已提交把次');
  assert.equal(first.sendCount, 1);
  assert.equal(first.sentRouteCount, 1, '完攀的是一条线路');
  assert.equal(first.failCount, 2);
  assert.equal(first.pickableCount, 1, '只有未完成的顶绳线可勾选');
  assert.equal(first.summaryText, '2 条线 · 3 把 · 完攀 1 把');

  const boulderRow = first.routes.find(row => row.routeId === boulder.id);
  assert.equal(boulderRow.attemptCount, 2);
  assert.equal(boulderRow.sendCount, 1);
  assert.equal(boulderRow.completed, true);
  assert.equal(boulderRow.stateText, '已完攀');
  assert.equal(boulderRow.pickable, false, '已完攀的线不在小结里勾选');
  assert.equal(boulderRow.latestNote, '第二次抓到结束点', '最近一条非空备注');

  const ropeRow = first.routes.find(row => row.routeId === rope.id);
  assert.equal(ropeRow.attemptCount, 1);
  assert.equal(ropeRow.sendCount, 0);
  assert.equal(ropeRow.stateText, '');
  assert.equal(ropeRow.pickable, true);

  const second = buildSessionSummary(archive, s2.id);
  assert.equal(second.label, '第 2 场');
  assert.equal(second.routeCount, 1, '第二场只有一条线');
  assert.equal(second.attemptCount, 1, '第二场只算它自己那一把');
  assert.equal(second.sendCount, 0);
  assert.equal(second.sentRouteCount, 0);
  assert.equal(second.summaryText, '1 条线 · 1 把');
  assert.equal(second.routes[0].routeId, rope.id, '同一条长期线路按原 ID 出现');
  assert.equal(second.routes[0].attemptCount, 1);
  assert.equal(second.routes[0].hasSend, false, '第一场的完攀不串到第二场');
  assert.equal(second.routes[0].latestNote, '第二场再试一次');
  // 整条线按档案层判定已完攀（抱石语义不适用顶绳，这里只是确认两场读数互不串）。
  assert.equal(store.routeCompletion(archive, boulder.id).completed, true);
});

test('R1 空场与重复完攀的绳线分别核对把数与不同线路数', () => {
  const empty = startAt(DAY, GYM_A);
  const emptySummary = buildSessionSummary(archiveOf(), empty.id);
  assert.equal(emptySummary.known, true);
  assert.equal(emptySummary.isEmpty, true);
  assert.equal(emptySummary.attemptCount, 0);
  assert.equal(emptySummary.routeCount, 0);
  assert.equal(emptySummary.routes.length, 0);
  assert.equal(emptySummary.summaryText, '0 条线 · 0 把');
  assert.equal(emptySummary.pendingCount, 0);
  assert.equal(emptySummary.sentRouteCount, 0);

  // 先锋线重复完攀：3 把、1 条线、2 把完攀，完攀线路仍是 1 条。
  const session = startAt(DAY, GYM_B);
  const rope = newRoute(session, {
    name: '黑色耐力线',
    climbType: '先锋',
    grade: '5.11a',
    colorName: '黑色'
  });
  record(session, rope, 'send');
  record(session, rope, 'fail');
  record(session, rope, 'send');

  const summary = buildSessionSummary(archiveOf(), session.id);
  assert.equal(summary.attemptCount, 3, '重复完攀各算一把');
  assert.equal(summary.routeCount, 1, '但只算一条线路');
  assert.equal(summary.sendCount, 2);
  assert.equal(summary.sentRouteCount, 1);
  assert.equal(summary.summaryText, '1 条线 · 3 把 · 完攀 2 把');
  assert.equal(summary.routes.length, 1);
  assert.equal(summary.routes[0].stateText, '本场完攀');
  assert.equal(summary.routes[0].completed, false, '顶绳先锋完攀不入档案层 completed');
  assert.equal(summary.routes[0].pickable, false);
});

test('R1 同色同级不同线路各占一行，不按名称颜色等级归并', () => {
  const session = startAt(DAY, GYM_A);
  const routeA = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  const routeB = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, routeA, 'fail');
  record(session, routeB, 'fail');

  const summary = buildSessionSummary(archiveOf(), session.id);
  assert.equal(summary.routeCount, 2);
  assert.equal(summary.attemptCount, 2);
  assert.deepEqual(
    summary.routes.map(row => row.routeId).sort(),
    [routeA.id, routeB.id].sort()
  );
});

test('R1 场次不存在时返回 known:false 的空小结，不猜别的场次', () => {
  const { s1 } = twoSessionsFixture();
  const missing = buildSessionSummary(archiveOf(), 'session-not-here');
  assert.equal(missing.known, false);
  assert.equal(missing.sessionId, 'session-not-here');
  assert.equal(missing.attemptCount, 0);
  assert.equal(missing.routes.length, 0);
  assert.equal(missing.gymName, '');

  const noArchive = buildSessionSummary(null, s1.id);
  assert.equal(noArchive.known, false);
  assert.equal(noArchive.routes.length, 0);
});

test('R1 线路已不在档案里的把次计入把数，但不并进别的线', () => {
  const session = startAt(DAY, GYM_A);
  const kept = newRoute(session, { name: '蓝色动态线', grade: 'V3' });
  record(session, kept, 'fail');
  record(session, kept, 'send');

  // 直接改本机字节：把一个把次指到档案里不存在的线路（旧数据/损坏的极端情况）。
  const raw = JSON.parse(rawOf(ARCHIVE_KEY));
  const ghost = raw.attempts.find(item => item.result === 'send');
  ghost.routeId = 'route-ghost';
  storage.set(ARCHIVE_KEY, JSON.stringify(raw));

  const summary = buildSessionSummary(archiveOf(), session.id);
  assert.equal(summary.attemptCount, 2, '把数仍与底部统计同一口径');
  assert.equal(summary.sendCount, 1);
  assert.equal(summary.routeCount, 1, '只有真实存在的线路进小结');
  assert.equal(summary.orphanAttemptCount, 1);
  assert.equal(summary.routes[0].routeId, kept.id);
  assert.equal(summary.routes[0].sendCount, 0);
});

// ------------------------------------------------------------------ *
// R2 更正与统计口径
// ------------------------------------------------------------------ *

test('R2 把原完攀改为未完成后：小结把数不变、完攀随原记录更新，底部统计各场把数一致', () => {
  const { s1, s2, boulder } = twoSessionsFixture();
  const archive = archiveOf();

  const before = buildSessionSummary(archive, s1.id);
  assert.equal(before.attemptCount, 3);
  assert.equal(before.sentRouteCount, 1);

  const statsBefore = openStatsPage();
  assert.equal(statsBefore.data.totalAttempts, 4, '底部全档案把数＝两场之和');
  assert.equal(statsBefore.data.sendCount, 1);

  const send = archive.attempts.find(
    item => item.routeId === boulder.id && item.result === 'send'
  );
  const corrected = store.correctAttempt(send.id, {
    routeId: boulder.id,
    sessionId: s1.id
  });
  assert.equal(corrected.ok, true, corrected.error);

  const after = buildSessionSummary(archiveOf(), s1.id);
  assert.equal(after.attemptCount, 3, '把数不变');
  assert.equal(after.sendCount, 0, '完攀随原记录更新');
  assert.equal(after.sentRouteCount, 0);
  assert.equal(after.failCount, 3);
  assert.equal(after.pickableCount, 2, '两条线都变回未完成，都可勾选');
  const boulderRow = after.routes.find(row => row.routeId === boulder.id);
  assert.equal(boulderRow.completed, false);
  assert.equal(boulderRow.stateText, '');
  assert.equal(boulderRow.attemptCount, 2);
  assert.equal(boulderRow.sendCount, 0);

  const statsAfter = openStatsPage();
  assert.equal(statsAfter.data.totalAttempts, 4, '更正不改变底部总把数');
  assert.equal(statsAfter.data.sendCount, 0);
  assert.equal(statsAfter.data.failCount, 4);

  // 各场小结把数之和＝底部全档案把数。
  const perSession =
    buildSessionSummary(archiveOf(), s1.id).attemptCount +
    buildSessionSummary(archiveOf(), s2.id).attemptCount;
  assert.equal(perSession, statsAfter.data.totalAttempts);
});

test('R2 待保存操作不计入小结把数，按同一操作重试后才 +1', () => {
  const { s1, rope } = twoSessionsFixture();
  const extra = newRoute(s1, {
    name: '白色斜壁线',
    climbType: '顶绳',
    grade: '5.9',
    colorName: '白色'
  });

  // 第二段写失败：只留下「进行中」标记，把次还没提交。
  armSetFailAt(2);
  const failed = store.saveAttempt({
    sessionId: s1.id,
    routeId: extra.id,
    result: 'fail',
    note: ''
  });
  assert.equal(failed.ok, false, '落盘失败不报已保存');

  const pending = buildSessionSummary(archiveOf(), s1.id);
  assert.equal(pending.attemptCount, 3, '待保存不计入把数');
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.pendingCountText, '本场还有 1 把待保存，未计入小结把数。');
  assert.equal(pending.routeCount, 2, '待保存的线也不进去重线路');
  assert.equal(pending.routes.some(row => row.routeId === extra.id), false);
  assert.equal(pending.routes.some(row => row.routeId === rope.id), true);

  disarmSetFail();
  const retried = store.saveAttempt({
    opId: failed.opId,
    sessionId: s1.id,
    routeId: extra.id,
    result: 'fail',
    note: ''
  });
  assert.equal(retried.ok, true, retried.error);

  const committed = buildSessionSummary(archiveOf(), s1.id);
  assert.equal(committed.attemptCount, 4, '重试补齐成一把');
  assert.equal(committed.pendingCount, 0);
  assert.equal(committed.pendingCountText, '');
  assert.equal(committed.routeCount, 3);
  assert.equal(archiveOf().attempts.filter(item => item.routeId === extra.id).length, 1);
});

test('R2 旧云汇总与自测成绩都不计入小结把数，读小结不写盘也不碰文件系统', () => {
  const { s1 } = twoSessionsFixture();

  // 旧云缓存在本机存储里的痕迹：小结不读也不并进把数。
  storage.set('climbing_records', JSON.stringify([{ _id: 'old-1', attempts: 5 }]));
  storage.set('climbing_sessions', JSON.stringify([{ _id: 'old-session', routes: [] }]));
  const saved = fitness.saveTest({
    date: DAY,
    weightKg: '60',
    finger: 'done',
    fingerExtraKg: '24',
    pull: 'done',
    pullExtraKg: '24',
    coreAction: 'straight',
    coreSeconds: '15',
    hang: '150'
  });
  assert.equal(saved.ok, true, saved.error);
  assert.ok(rawOf(FITNESS_KEY), '自测成绩写在它自己的键上');

  const archive = archiveOf();
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const wishlistBytes = rawOf(WISHLIST_KEY);
  const fitnessBytes = rawOf(FITNESS_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const fitnessWrites = writesOf(FITNESS_KEY);
  io.reads = [];
  io.writes = [];
  io.fsCalls = [];

  const summary = buildSessionSummary(archive, s1.id);
  assert.equal(summary.attemptCount, 3, '9c 自测成绩不计入把数');
  assert.equal(summary.routeCount, 2);
  assert.equal(summary.sendCount, 1);

  // 纯函数：读小结既不读盘也不写盘，更不碰文件系统。
  assert.equal(io.reads.length, 0, '小结本身不读盘');
  assert.equal(io.writes.length, 0, '小结不写盘');
  assert.equal(io.fsCalls.length, 0, '小结不碰文件系统');

  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes);
  assert.equal(rawOf(WISHLIST_KEY), wishlistBytes);
  assert.equal(rawOf(FITNESS_KEY), fitnessBytes);
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites, '旧云与自测不改变训练档案');
  assert.equal(writesOf(FITNESS_KEY), fitnessWrites);
});

test('R2 旧档案（缺后加字段）兼容读取后小结照常', () => {
  const { s1 } = twoSessionsFixture();
  const raw = JSON.parse(rawOf(ARCHIVE_KEY));
  // 模拟 T016 早期档案：没有 sessionRoutes / pendingSaves / pendingCorrections。
  delete raw.sessionRoutes;
  delete raw.pendingSaves;
  delete raw.pendingCorrections;
  storage.set(ARCHIVE_KEY, JSON.stringify(raw));

  const loaded = store.loadState();
  assert.equal(loaded.ok, true, loaded.error);

  const summary = buildSessionSummary(loaded.archive, s1.id);
  assert.equal(summary.attemptCount, 3);
  assert.equal(summary.routeCount, 2);
  assert.equal(summary.sendCount, 1);
  assert.equal(summary.pendingCount, 0);
});

// ------------------------------------------------------------------ *
// R3 页面入口、勾选与只读
// ------------------------------------------------------------------ *

test('R3 场内页小结显示本场读数与完攀状态，未完成线路可勾进本馆「下次想爬」', () => {
  const { s1, boulder, rope } = twoSessionsFixture();
  // 夹具最后 active 是第二场；这里显式只读回看第一场的小结。
  const page = openSessionPage({ sessionId: s1.id });

  assert.equal(page.data.summaryReady, true);
  assert.equal(page.data.summaryError, '');
  assert.equal(page.data.summarySessionId, s1.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(page.data.summarySendText, '完攀 1 把');
  assert.equal(page.data.summaryEmpty, false);
  assert.equal(page.data.summaryRows.length, 2);
  assert.equal(page.data.summaryWishlistError, '');

  const boulderRow = page.data.summaryRows.find(row => row.routeId === boulder.id);
  assert.equal(boulderRow.stateText, '已完攀');
  assert.equal(boulderRow.checked, false);
  assert.equal(boulderRow.pickable, false);

  const ropeRow = page.data.summaryRows.find(row => row.routeId === rope.id);
  assert.equal(ropeRow.pickable, true);
  assert.equal(ropeRow.canPick, true);
  assert.equal(ropeRow.checked, false);
  assert.equal(ropeRow.pickText, '加入下次想爬');

  // 勾选一条未完成线路：回到对应岩馆的「下次想爬」只出现一次。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  const stored = wishlist.listWishlist(archiveOf(), { gymId: page.data.summaryGymId });
  assert.equal(stored.ok, true);
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].routeId, rope.id);
  assert.equal(stored.items[0].status, 'wanted');

  const picked = page.data.summaryRows.find(row => row.routeId === rope.id);
  assert.equal(picked.checked, true);
  assert.equal(picked.pickText, '✓ 已加入下次想爬');
  assert.equal(picked.wishlistStateText, '已在下次想爬');
  assert.equal(page.data.wishlistWanted.filter(row => row.routeId === rope.id).length, 1);
  assert.equal(page.data.notice, '已加入下次想爬；下次进这家岩馆就能从清单里按原线路 ID 续记。');

  // 取消：显示实际保存状态，清单回到空。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.notice, '已撤下这条线的收藏；其他收藏、照片与把次都不变。');
  assert.equal(page.data.summaryRows.find(row => row.routeId === rope.id).checked, false);
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 0);
});

test('R3 重复点击只出现一次，其他收藏不丢失（同馆与别的岩馆都不受影响）', () => {
  const { s1, rope } = twoSessionsFixture();
  // 先收藏本馆另一条线与另一个岩馆的一条线：勾选小结里的线不能动它们。
  const other = newRoute(s1, { name: '灰色线', climbType: '顶绳', grade: '5.9' });
  const otherGymSession = startAt(DAY, GYM_B);
  const otherGymRoute = newRoute(otherGymSession, { name: '别的馆的线', grade: 'V2' });
  assert.equal(wishlist.addWishlist(other.id).ok, true);
  assert.equal(wishlist.addWishlist(otherGymRoute.id).ok, true);

  const page = openSessionPage({ sessionId: s1.id });
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(wishlist.loadWishlist().state.items.length, 3);

  // 连点/迟到重复加入：数据层幂等，这条线仍只有一条，别人的收藏一条不少。
  const again = wishlist.addWishlist(rope.id);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.code, 'duplicate');
  const items = wishlist.loadWishlist().state.items;
  assert.equal(items.length, 3, '重复加入不产生第二条');
  assert.equal(items.filter(item => item.routeId === rope.id).length, 1, '同一条线只出现一次');
  assert.equal(items.filter(item => item.routeId === other.id).length, 1, '其他收藏不丢失');
  assert.equal(items.filter(item => item.routeId === otherGymRoute.id).length, 1);

  const gymA = wishlist.listWishlist(archiveOf(), { gymId: page.data.summaryGymId });
  assert.equal(gymA.items.filter(item => item.routeId === rope.id).length, 1);
  assert.equal(
    gymA.items.some(item => item.routeId === otherGymRoute.id),
    false,
    '不串馆'
  );

  // 取消只撤下这一条。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.notice, '已撤下这条线的收藏；其他收藏、照片与把次都不变。');
  const left = wishlist.loadWishlist().state.items;
  assert.equal(left.length, 2);
  assert.equal(left.some(item => item.routeId === rope.id), false);
  assert.equal(left.some(item => item.routeId === other.id), true);
});

test('R3 勾选写失败时显示实际保存状态并可原地重试', () => {
  const { s1, rope } = twoSessionsFixture();
  const page = openSessionPage({ sessionId: s1.id });
  const before = rawOf(WISHLIST_KEY);

  armSetFailAt(1);
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.notice, '勾选未保存，可再点一次重试。');
  assert.match(page.data.storageError, /保存下次想爬清单失败/);
  assert.equal(rawOf(WISHLIST_KEY), before, '写失败不落盘');
  assert.equal(
    page.data.summaryRows.find(row => row.routeId === rope.id).checked,
    false,
    '显示的是实际保存状态，不是以为点上了'
  );
  assert.equal(page.data.wishlistWanted.length, 0);

  disarmSetFail();
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.summaryRows.find(row => row.routeId === rope.id).checked, true);
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 1);
});

test('R3 清单损坏时小结显示可见错误、收回写入口，且不改动清单原字节', () => {
  const { s1, rope } = twoSessionsFixture();
  storage.set(WISHLIST_KEY, '{this is not json');
  const broken = rawOf(WISHLIST_KEY);
  const page = openSessionPage({ sessionId: s1.id });

  assert.match(page.data.summaryWishlistError, /下次想爬清单格式损坏/);
  assert.equal(page.data.summaryReady, true, '小结数字照常显示');
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  page.data.summaryRows.forEach(row => assert.equal(row.canPick, false));
  assert.equal(writesOf(WISHLIST_KEY), 0);

  // 直接调用入口也不落盘：写入口在清单不可读时一律拒绝，并说明原因。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(rawOf(WISHLIST_KEY), broken, '原清单保持原样');
  assert.equal(writesOf(WISHLIST_KEY), 0);
  assert.match(page.data.notice, /下次想爬清单格式损坏/);
});

test('R3 打开、返回与重开小结都只读：不改场次、不改档案与清单，也不碰文件系统', () => {
  const { s2 } = twoSessionsFixture();
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const photosBytes = rawOf(PHOTOS_KEY);
  const wishlistBytes = rawOf(WISHLIST_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);

  const page = openSessionPage();
  assert.equal(page.data.summarySessionId, s2.id, '默认看当前场次');
  assert.equal(page.data.summaryViewingOther, false);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');

  // 场内页既有的照片服务在初始化时会探测本机照片目录（T019 行为，不属于本单）；
  // 小结与清单自己的重算不得再多碰一次文件系统。
  const fsAfterOpen = io.fsCalls.length;
  page.refreshSummary();
  page.refreshView();
  assert.equal(io.fsCalls.length, fsAfterOpen, '小结重算不碰文件系统');

  page.onShow();
  const reopened = openSessionPage();
  assert.equal(reopened.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(reopened.data.summarySessionId, s2.id);

  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '档案逐字节不变');
  assert.equal(rawOf(PHOTOS_KEY), photosBytes);
  assert.equal(rawOf(WISHLIST_KEY), wishlistBytes);
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites, '打开小结不写档案');
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites, '打开小结不写清单');
  assert.equal(archiveOf().activeSessionId, s2.id, '没有结束也没有新建场次');
  assert.equal(archiveOf().sessions.length, 2);
});

test('R3 用 ?sessionId= 只读回看当天另一场，自己切场次后小结跟着当前场次', () => {
  const { s1, s2 } = twoSessionsFixture();
  const s3 = startAt(DAY, GYM_A); // 第三场：空场，用来验证切场后小结跟着走
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  assert.equal(archiveOf().activeSessionId, s3.id);

  const page = openSessionPage({ sessionId: s1.id });
  assert.equal(page.data.summarySessionId, s1.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(page.data.summaryViewingOther, true, '明确标出正在回看另一场');
  assert.equal(page.data.summaryLabel, '第 1 场');
  assert.equal(archiveOf().activeSessionId, s3.id, '回看本身不改当前场次');
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '回看不写档案');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);

  // 用户显式切场次：小结跟随当前场次，回看目标被清掉。
  page.switchSession(tapDataset({ sessionId: s2.id }));
  assert.equal(page.data.summarySessionId, s2.id);
  assert.equal(page.data.summaryViewingOther, false);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');

  const reopened = openSessionPage();
  assert.equal(reopened.data.summarySessionId, s2.id, '重开后仍指向当前场次');
  assert.equal(reopened.data.summaryCountText, '1 条线 · 1 把');
});

test('R3 小结回看入口：两日三场能直接选昨天的原场，返回仍是所选场次，也能切回当前场', () => {
  const { yesterday, todayFirst, todayActive, boulder } = twoDaysFixture();
  const page = openSessionPage(); // 进入今天的当前场次
  assert.equal(page.data.summarySessionId, todayActive.id, '默认看当前场次');
  assert.equal(page.data.summaryViewingOther, false);
  assert.equal(page.data.summaryCountText, '0 条线 · 0 把');

  // 真实可见的只读选择入口：日期 · 岩馆 · 场次序号，当前场次也在选项里（空场也能选回来）。
  assert.equal(page.data.summarySessionPickerVisible, true);
  assert.deepEqual(
    page.data.summarySessionOptions.map(option => option.label),
    [
      '2026-11-10 · A 馆 · 第 2 场',
      '2026-11-10 · A 馆 · 第 1 场',
      '2026-11-09 · A 馆 · 第 1 场'
    ],
    '按日期新在前、同日序号大在前，并写明岩馆与场次序号'
  );
  assert.equal(page.data.summarySessionOptions[0].isActive, true);
  assert.equal(page.data.summarySessionIndex, 0);
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 2 场');

  const archiveBytes = rawOf(ARCHIVE_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);

  // 从控件里选昨天的原场：读到昨天两线三把的整份小结。
  const yesterdayIndex = page.data.summarySessionOptions.findIndex(
    option => option.id === yesterday.id
  );
  page.onSummarySessionChange({ detail: { value: String(yesterdayIndex) } });
  assert.equal(page.data.summarySessionId, yesterday.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(page.data.summarySendText, '完攀 1 把');
  assert.equal(page.data.summaryRows.length, 2);
  assert.equal(page.data.summaryViewingOther, true);
  assert.equal(page.data.summaryLabel, '第 1 场');
  assert.equal(page.data.summaryDate, YESTERDAY);
  assert.equal(page.data.summarySessionValue, '2026-11-09 · A 馆 · 第 1 场');
  const boulderRow = page.data.summaryRows.find(row => row.routeId === boulder.id);
  assert.equal(boulderRow.stateText, '已完攀');
  assert.equal(boulderRow.pickable, false, '已完攀的线仍不出勾选入口');

  // 选择只换所看的小结：不改当前场次、不建场次、不写训练，也不新建清单条目。
  assert.equal(archiveOf().activeSessionId, todayActive.id);
  assert.equal(archiveOf().sessions.length, 3);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '回看不写档案');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites);

  // 从小结回到昨天那条线的原照片（同一个长期线路 ID）。
  resetWxLog();
  page.openSummaryRoute(tapDataset({ routeId: boulder.id }));
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-route/training-route?routeId=' + boulder.id
  ]);

  // 从详情页返回本页（onShow 重算）：仍停在所选的昨天那一场。
  page.onShow();
  assert.equal(page.data.summarySessionId, yesterday.id, '返回后仍是选中的场次');
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');

  // 同一天里的既有场次切换继续可用：选今天第一场。
  const todayIndex = page.data.summarySessionOptions.findIndex(
    option => option.id === todayFirst.id
  );
  page.onSummarySessionChange({ detail: { value: todayIndex } });
  assert.equal(page.data.summarySessionId, todayFirst.id);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(page.data.summaryViewingOther, true, '与当前场次不同就明确标出');

  // 可回当前场：选回当前那一场，回看标记消失，当前场次始终没变。
  const activeIndex = page.data.summarySessionOptions.findIndex(option => option.isActive);
  page.onSummarySessionChange({ detail: { value: activeIndex } });
  assert.equal(page.data.summarySessionId, todayActive.id);
  assert.equal(page.data.summaryViewingOther, false);
  assert.equal(page.data.summaryCountText, '0 条线 · 0 把');
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 2 场');
  assert.equal(archiveOf().activeSessionId, todayActive.id);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '整个过程一个字节都没写');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
});

test('R3 小结回看入口：只有一场可看时不出现；选中项无效时不改所看场次', () => {
  const only = startAt(DAY, GYM_A);
  record(only, newRoute(only, { name: '蓝色动态线', grade: 'V3' }), 'fail', '只有这一场');

  const page = openSessionPage();
  assert.equal(page.data.summarySessionOptions.length, 1);
  assert.equal(page.data.summarySessionPickerVisible, false, '没有别的场次可回看就不显示选择器');
  assert.equal(page.data.summarySessionIndex, 0);
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 1 场');

  // 越界或空的选中值不换场次、不写盘（选择器事件里只会给合法下标）。
  const before = rawOf(ARCHIVE_KEY);
  page.onSummarySessionChange({ detail: { value: '9' } });
  page.onSummarySessionChange({ detail: {} });
  assert.equal(page.data.summarySessionId, only.id);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(rawOf(ARCHIVE_KEY), before);
});

test('R3 小结回看入口：指定的空场也出现在选择项里，并如实显示正在看哪一场', () => {
  const empty = startAt(DAY, GYM_A); // 空场：还没有已提交把次
  const active = startAt(DAY, GYM_A);
  record(active, newRoute(active, { name: '蓝色动态线', grade: 'V3' }), 'fail', '当前场一把');

  // 用 ?sessionId= 打开空场：选择器里仍如实显示这一场，而不是显示当前场次。
  const page = openSessionPage({ sessionId: empty.id });
  assert.equal(page.data.summarySessionId, empty.id);
  assert.equal(page.data.summaryCountText, '0 条线 · 0 把');
  assert.deepEqual(
    page.data.summarySessionOptions.map(option => option.id),
    [active.id, empty.id]
  );
  assert.equal(page.data.summarySessionIndex, 1);
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 1 场');

  // 从控件里选回当前场次：读数跟着换成当前场那一把。
  page.onSummarySessionChange({ detail: { value: 0 } });
  assert.equal(page.data.summarySessionId, active.id);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(page.data.summarySessionIndex, 0);
  assert.equal(page.data.summaryViewingOther, false);
});

test('R3 小结回看入口接上真实控件：绑定、选项文案与位置都在小结区里', () => {
  const { s1, s2 } = twoSessionsFixture();
  // ?sessionId= 仍是既有入口；控件只是让用户不必手工拼它。
  const page = openSessionPage({ sessionId: s1.id });
  assert.equal(page.data.summarySessionPickerVisible, true);
  assert.equal(page.data.summarySessionOptions.length, 2);
  assert.equal(page.data.summarySessionIndex, 1, '选择器当前值＝正在回看的那一场');
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 1 场');
  assert.equal(page.data.summarySessionOptions[1].id, s1.id);

  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.match(wxml, /id="summary-session-picker"/);
  assert.match(wxml, /range="\{\{summarySessionOptions\}\}"/);
  assert.match(wxml, /range-key="label"/);
  assert.match(wxml, /bindchange="onSummarySessionChange"/);
  assert.match(
    wxml,
    /id="summary-session-value"[\s\S]{0,200}\{\{summarySessionValue\}\}/
  );
  assert.match(
    wxml,
    /<picker[\s\S]{0,300}bindchange="onSummarySessionChange"/,
    '选择器本身绑定真实处理器（选择事件直接接到读数）'
  );
  assert.equal(typeof sessionDefinition.onSummarySessionChange, 'function');

  // 位置：在小结区里、首屏结果按钮之后、清单之前，不挤占上方结果按钮。
  const failButton = wxml.indexOf('class="result-button result-fail"');
  const picker = wxml.indexOf('id="summary-session-picker"');
  const summaryStart = wxml.indexOf('id="session-summary"');
  const wishlistStart = wxml.indexOf('id="wishlist-section"');
  assert.ok(summaryStart !== -1 && failButton !== -1 && wishlistStart !== -1);
  assert.ok(picker > summaryStart, '回看入口在小结区里');
  assert.ok(picker > failButton && picker < wishlistStart, '在结果按钮之后、下次想爬清单之前');

  // 同一场次在页面上的既有入口一个不少（同日场次切换继续可用）。
  assert.equal(typeof sessionDefinition.switchSession, 'function');
  assert.ok(handlersIn(wxml).includes('switchSession'));
  assert.equal(archiveOf().activeSessionId, s2.id, '回看与选择都不改当前场次');
});

test('R3 空场小结显示空态，已完攀的行不出勾选入口', () => {
  const empty = startAt(DAY, GYM_A);
  const emptyPage = openSessionPage();
  assert.equal(emptyPage.data.summarySessionId, empty.id);
  assert.equal(emptyPage.data.summaryReady, true);
  assert.equal(emptyPage.data.summaryEmpty, true);
  assert.equal(emptyPage.data.hasSummaryRows, false);
  assert.equal(emptyPage.data.summaryCountText, '0 条线 · 0 把');
  assert.equal(emptyPage.data.summaryHintText, '');
  assert.equal(emptyPage.data.summaryRows.length, 0);

  // 另一场：只完攀一条抱石线，没有可勾选的线，也不提示勾选。
  const done = startAt(DAY, GYM_A);
  const boulder = newRoute(done, { name: '蓝色动态线', grade: 'V3' });
  record(done, boulder, 'send');
  const page = openSessionPage();
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把 · 完攀 1 把');
  assert.equal(page.data.summaryRows[0].pickable, false);
  assert.equal(page.data.summaryRows[0].canPick, false);
  assert.equal(page.data.summaryRows[0].stateText, '已完攀');
  assert.equal(page.data.summaryHintText, '');

  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.match(
    wxml,
    /wx:if="\{\{item\.pickable\}\}"[\s\S]{0,200}id="summary-pick-\{\{item\.routeId\}\}"/
  );
});

test('R3 小结回看指向原线路详情；场次已不在时显示可见错误而不是空读数', () => {
  const { s1, rope } = twoSessionsFixture();
  const page = openSessionPage({ sessionId: s1.id });
  page.openSummaryRoute(tapDataset({ routeId: rope.id }));
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-route/training-route?routeId=' + rope.id
  ]);
  assert.equal(page.data.loadError, '');

  // 场次 ID 已不在档案里（例如本机档案被重置）：显示可见错误，不拿 0 冒充空场。
  const stale = openSessionPage({ sessionId: 'session-gone' });
  assert.equal(stale.data.summaryReady, false);
  assert.match(stale.data.summaryError, /找不到这场训练/);
  assert.equal(stale.data.summaryRows.length, 0);
  assert.equal(stale.data.hasSummaryRows, false);
});

test('R3 WXML 的小结区块与真实绑定齐全', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.match(wxml, /id="session-summary" class="section session-summary"/);
  assert.match(wxml, /id="summary-count"[\s\S]{0,80}\{\{summaryCountText\}\}/);
  assert.match(wxml, /id="summary-error"/);
  assert.match(wxml, /id="summary-empty"/);
  assert.match(
    wxml,
    /id="summary-pick-state-\{\{item\.routeId\}\}"[\s\S]{0,120}\{\{item\.wishlistStateText\}\}/
  );
  assert.match(
    wxml,
    /data-route-id="\{\{item\.routeId\}\}"\s*bindtap="toggleSummaryPick"/
  );
  assert.match(
    wxml,
    /data-route-id="\{\{item\.routeId\}\}"\s*bindtap="openSummaryRoute"/
  );

  const handlers = handlersIn(wxml);
  assert.ok(handlers.includes('toggleSummaryPick'), '勾选绑定真实处理器');
  assert.ok(handlers.includes('openSummaryRoute'), '回看绑定真实处理器');

  // 小结是加在原有场内页上的：原有入口一个不少。
  ['startSession', 'switchSession', 'selectRoute', 'recordAttempt', 'correctSend'].forEach(name => {
    assert.ok(handlers.includes(name), '原有绑定仍在：' + name);
  });
});

test('R3 小结只读不依赖云：没有 wx.cloud 也照常显示与勾选', async () => {
  const { s1, rope } = twoSessionsFixture();
  assert.equal(typeof global.wx.cloud, 'undefined');
  const page = openSessionPage({ sessionId: s1.id });
  await flush();
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 1);
  assert.equal(wxLog.toasts.length, 0, '勾选不依赖云提示');
});
