/**
 * T029/T034 本次攀爬小结与下次续爬选择回归测试（R1、R2、R3 的离线部分）
 *
 * 直接加载真实的 utils/training-session-summary.js、utils/training-wishlist.js、正式
 * 场内页 pages/training-session、独立小结页 pages/training-summary 与底部统计页
 * pages/stats，用隔离的微信本地存储替身与写入故障注入驱动真实处理器，并核对 WXML 里的
 * 真实按钮绑定。
 *
 * 覆盖任务单的三条验收标准（离线部分）：
 * - 同馆同日两场各自统计：第一场 2 条线 3 把、完攀线路正确，第二场只算它自己那一把；
 *   空场与重复完攀的绳线分别核对「把数」与「不同线路数」；
 * - 把原完攀改为未完成后：小结把数不变、完攀随原记录更新，底部全档案统计各场把数一致；
 *   待保存操作、旧云汇总与自测成绩都不计入；
 * - 未完成线路勾选进本馆「下次想爬」只出现一次，取消与写失败都显示实际保存状态，
 *   其他收藏不丢失；重开与离线回看仍按原 sessionId、原线路 ID 取数；
 * - T034：小结搬到独立页 pages/training-summary，场内只留小结入口。入口传 archiveId 与
 *   sessionId；小结页按原 sessionId 取数，重显、返回与查看另一场都读指定场次；未知或
 *   串档的 sessionId 给出可见状态而不展示另一场；只读回看不改档案、不改清单，回看入口
 *   （日期 · 岩馆 · 第 N 场）可以换看别的场次，也能回到当前场次小结。
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
const RECORD_WXML = path.join(ROOT, 'pages', 'training-record', 'training-record.wxml');
const SUMMARY_PAGE_JS = path.join(ROOT, 'pages', 'training-summary', 'training-summary.js');
const SUMMARY_PAGE_WXML = path.join(
  ROOT,
  'pages',
  'training-summary',
  'training-summary.wxml'
);
const SUMMARY_PAGE_WXSS = path.join(
  ROOT,
  'pages',
  'training-summary',
  'training-summary.wxss'
);
const APP_JSON = path.join(ROOT, 'app.json');
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

const wxLog = { navigations: [], toasts: [], switches: [], backs: [], relaunches: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.toasts = [];
  wxLog.switches = [];
  wxLog.backs = [];
  wxLog.relaunches = [];
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
  navigateBack(options) {
    wxLog.backs.push(options || {});
  },
  reLaunch(options) {
    wxLog.relaunches.push(options.url);
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
const { buildSessionSummary, buildSessionList } = require(SUMMARY_JS);
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
const summaryPageDefinition = capturePage(SUMMARY_PAGE_JS);
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

/**
 * 打开独立小结页（T034）：走真实 onLoad，参数就是场内入口传下来的 archiveId 与 sessionId。
 * 该页不接照片服务，因此不需要照片替身。
 */
function openSummaryPage(query) {
  const page = createPage(summaryPageDefinition);
  page.onLoad(query || {});
  return page;
}

/** 场内页小结入口的完整导航 URL（场内入口按渲染时的场次与档案 ID 拼出来）。 */
function summaryEntryUrl(page) {
  const params = ['sessionId=' + encodeURIComponent(page.data.summaryEntrySessionId)];
  const archiveId = page.archive && page.archive.archiveId;
  if (archiveId) params.push('archiveId=' + encodeURIComponent(archiveId));
  return '/pages/training-summary/training-summary?' + params.join('&');
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
// R3 场内入口、独立小结页、勾选与只读（T034）
// ------------------------------------------------------------------ *

const SUMMARY_PAGE_FILE = 'pages/training-summary/training-summary';

test('R3 场内只留小结入口：跳转带上 archiveId 与 sessionId，打开本身不写任何数据', () => {
  const { s2 } = twoSessionsFixture();
  const archiveId = archiveOf().archiveId;
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const wishlistBytes = rawOf(WISHLIST_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);

  const page = openSessionPage();
  assert.equal(page.data.summaryEntryReady, true);
  assert.equal(page.data.summaryEntrySessionId, s2.id, '默认入口指向当前场次');
  assert.equal(page.data.summaryEntryViewingOther, false);
  assert.match(page.data.summaryEntryLabel, /^2026-11-10 · A 馆 · 第 2 场$/);

  // 入口不读清单、不算把数：场内页不再有小结行与勾选状态。
  assert.equal(page.data.summaryRows, undefined, '场内页不再持有一份小结行');
  assert.equal(page.data.summaryCountText, undefined);
  assert.equal(page.data.summaryWishlistError, undefined);

  resetWxLog();
  page.openSessionSummary();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(wxLog.navigations[0], summaryEntryUrl(page));
  assert.equal(
    wxLog.navigations[0],
    '/pages/training-summary/training-summary?sessionId=' +
      s2.id +
      '&archiveId=' +
      archiveId,
    '入口按渲染时的场次与档案 ID 跳转'
  );

  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '打开小结不写档案');
  assert.equal(rawOf(WISHLIST_KEY), wishlistBytes, '打开小结不写清单');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites);
  assert.equal(archiveOf().activeSessionId, s2.id, '打开小结不结束也不新建场次');
});

test('R3 场内小结入口保留既有入口：?sessionId= 指向另一场，自己切场次后入口回到当前场', () => {
  const { s1, s2 } = twoSessionsFixture();
  const s3 = startAt(DAY, GYM_A); // 第三场：空场，用来验证切场后入口跟着走
  assert.equal(archiveOf().activeSessionId, s3.id);

  const page = openSessionPage({ sessionId: s1.id });
  assert.equal(page.data.summaryEntryReady, true);
  assert.equal(page.data.summaryEntrySessionId, s1.id, '?sessionId= 指定入口指向哪一场');
  assert.equal(page.data.summaryEntryViewingOther, true, '明确标出入口指向另一场');
  assert.equal(archiveOf().activeSessionId, s3.id, '指定入口本身不改当前场次');

  // 用户显式切场次：入口跟随当前场次，指定目标被清掉。
  page.switchSession(tapDataset({ sessionId: s2.id }));
  assert.equal(page.data.summaryEntrySessionId, s2.id);
  assert.equal(page.data.summaryEntryViewingOther, false);

  // 目标场次已不在档案里时不显示入口（不把不存在的场次带进小结页）。
  page._summarySessionId = 'session-gone';
  page.refreshSummaryEntry();
  assert.equal(page.data.summaryEntryReady, false);
  assert.equal(page.data.summaryEntrySessionId, '');

  // 同一场次在页面上的既有入口一个不少（同日场次切换继续可用）。
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.equal(typeof sessionDefinition.switchSession, 'function');
  assert.ok(handlersIn(wxml).includes('switchSession'));
});

test('R3 独立小结页显示指定场次读数与完攀状态，未完成线路可勾进本馆「下次想爬」', () => {
  const { s1, s2, boulder, rope } = twoSessionsFixture();
  // 夹具最后 active 是第二场；小结页按入口传下来的 sessionId 只读回看第一场。
  const page = openSummaryPage({ sessionId: s1.id, archiveId: archiveOf().archiveId });

  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, '');
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
  assert.equal(ropeRow.attemptCountText, '1 把', '各线分项按本场自己的把数');
  assert.equal(ropeRow.sendCount, 0);

  // 同日另一场（S2）：读数、线路数与分项都与 S1 各自独立，不串场。
  const second = openSummaryPage({ sessionId: s2.id, archiveId: archiveOf().archiveId });
  assert.equal(second.data.summarySessionId, s2.id);
  assert.equal(second.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(second.data.summaryRows.length, 1);
  assert.equal(
    second.data.summaryRows.some(row => row.routeId === boulder.id),
    false,
    'S1 独有的线不出现在 S2'
  );
  const secondRope = second.data.summaryRows.find(row => row.routeId === rope.id);
  assert.equal(secondRope.attemptCountText, '1 把');
  assert.equal(secondRope.sendCount, 0, 'S1 的完攀不串到 S2');
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
  assert.equal(page.data.notice, '已加入下次想爬；下次进这家岩馆就能从清单里按原线路 ID 续记。');

  // 取消：显示实际保存状态，清单回到空。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.notice, '已撤下这条线的收藏；其他收藏、照片与把次都不变。');
  assert.equal(page.data.summaryRows.find(row => row.routeId === rope.id).checked, false);
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 0);

  // 重复点击（迟到回调）：同一原 routeId 仍只有一条。
  page.toggleSummaryPick(tapDataset({ routeId: rope.id })); // 加入
  page.toggleSummaryPick(tapDataset({ routeId: rope.id })); // 撤下
  page.toggleSummaryPick(tapDataset({ routeId: rope.id })); // 再加入
  assert.equal(
    wishlist.loadWishlist().state.items.filter(item => item.routeId === rope.id).length,
    1,
    '同一原 routeId 只出现一条'
  );
});

test('R3 独立小结页：同日两场与跨天夹具按指定场次取数，重显与返回都读同一场', () => {
  const { yesterday, todayActive, boulder } = twoDaysFixture();
  const archiveId = archiveOf().archiveId;
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const wishlistBytes = rawOf(WISHLIST_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);
  io.fsCalls = [];

  // 打开昨天那一场：入口传下来的场次决定读数，不跟着当前场次走。
  const page = openSummaryPage({ sessionId: yesterday.id, archiveId });
  assert.equal(page.data.summarySessionId, yesterday.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(page.data.summaryDate, YESTERDAY);
  assert.equal(page.data.summaryLabel, '第 1 场');
  assert.equal(page.data.summaryViewingOther, true);
  assert.equal(archiveOf().activeSessionId, todayActive.id, '当前场次没有被改');

  // 重显（onShow）：仍读同一场，读数一致。
  page.onShow();
  assert.equal(page.data.summarySessionId, yesterday.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');

  // 返回后再进来（重开页面）：仍按入口传下来的原 sessionId 取数。
  const reopened = openSummaryPage({ sessionId: yesterday.id, archiveId });
  assert.equal(reopened.data.summarySessionId, yesterday.id);
  assert.equal(reopened.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(
    reopened.data.summaryRows.find(row => row.routeId === boulder.id).stateText,
    '已完攀'
  );

  // 单纯打开、重显与返回前后档案与清单逐字节一致，且不碰文件系统。
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '档案逐字节不变');
  assert.equal(rawOf(WISHLIST_KEY), wishlistBytes, '清单逐字节不变');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites);
  assert.equal(io.fsCalls.length, 0, '小结页不碰文件系统');
});

test('R3 独立小结页：只读回看入口能换看别的场次，也能回到当前场次', () => {
  const { yesterday, todayFirst, todayActive, boulder } = twoDaysFixture();
  const archiveId = archiveOf().archiveId;
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);
  const wishlistWrites = writesOf(WISHLIST_KEY);

  const page = openSummaryPage({ sessionId: todayActive.id, archiveId });
  assert.equal(page.data.summarySessionId, todayActive.id, '默认看入口指定的当前场次');
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

  // 从控件里选昨天的原场：读到昨天两线三把的整份小结。
  const yesterdayIndex = page.data.summarySessionOptions.findIndex(
    option => option.id === yesterday.id
  );
  page.onSummarySessionChange({ detail: { value: String(yesterdayIndex) } });
  assert.equal(page.data.summarySessionId, yesterday.id);
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  assert.equal(page.data.summaryViewingOther, true);
  assert.equal(page.data.summaryLabel, '第 1 场');
  assert.equal(page.data.summaryDate, YESTERDAY);
  assert.equal(page.data.summarySessionValue, '2026-11-09 · A 馆 · 第 1 场');
  const boulderRow = page.data.summaryRows.find(row => row.routeId === boulder.id);
  assert.equal(boulderRow.stateText, '已完攀');
  assert.equal(boulderRow.pickable, false, '已完攀的线仍不出勾选入口');

  // 从小结先看昨天那条线的原场逐把（T046）：带原档案、所看这一场与长期线路 ID，
  // 且标明入口来自小结；跨场历史改由逐把页主动点「线路历史」进入。
  resetWxLog();
  page.openSummaryRoute(tapDataset({ routeId: boulder.id }));
  assert.deepEqual(wxLog.navigations, [
    '/pages/training-attempts/training-attempts?archiveId=' +
      archiveId +
      '&sessionId=' +
      yesterday.id +
      '&routeId=' +
      boulder.id +
      '&from=summary'
  ]);

  // 从逐把页返回本页（onShow 重算）：仍停在所选的昨天那一场。
  page.onShow();
  assert.equal(page.data.summarySessionId, yesterday.id, '返回后仍是所看的场次');
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');

  // 同一天里的既有场次切换继续可用：选今天第一场。
  const todayIndex = page.data.summarySessionOptions.findIndex(
    option => option.id === todayFirst.id
  );
  page.onSummarySessionChange({ detail: { value: todayIndex } });
  assert.equal(page.data.summarySessionId, todayFirst.id);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(page.data.summaryViewingOther, true, '与当前场次不同就明确标出');

  // 「回到本场小结」：换回正在记录的那一场，当前场次始终没变。
  page.returnToActiveSession();
  assert.equal(page.data.summarySessionId, todayActive.id);
  assert.equal(page.data.summaryViewingOther, false);
  assert.equal(page.data.summaryCountText, '0 条线 · 0 把');
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 2 场');

  // 选择只换所看的小结：不改当前场次、不建场次、不写训练，也不新建清单条目。
  assert.equal(archiveOf().activeSessionId, todayActive.id);
  assert.equal(archiveOf().sessions.length, 3);
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes, '回看不写档案');
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
  assert.equal(writesOf(WISHLIST_KEY), wishlistWrites);
});

test('R3 独立小结页回看入口：只有一场可看时不出现；越界或空的选中值不换所看场次', () => {
  const only = startAt(DAY, GYM_A);
  record(only, newRoute(only, { name: '蓝色动态线', grade: 'V3' }), 'fail', '只有这一场');

  const page = openSummaryPage({ sessionId: only.id, archiveId: archiveOf().archiveId });
  assert.equal(page.data.summarySessionOptions.length, 1);
  assert.equal(page.data.summarySessionPickerVisible, false, '没有别的场次可回看就不显示选择器');
  assert.equal(page.data.summarySessionIndex, 0);
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 1 场');

  const before = rawOf(ARCHIVE_KEY);
  page.onSummarySessionChange({ detail: { value: '9' } });
  page.onSummarySessionChange({ detail: {} });
  assert.equal(page.data.summarySessionId, only.id);
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把');
  assert.equal(rawOf(ARCHIVE_KEY), before);
});

test('R3 独立小结页：指定的空场显示空态，已完攀的行不出勾选入口', () => {
  const empty = startAt(DAY, GYM_A);
  const emptyPage = openSummaryPage({ sessionId: empty.id, archiveId: archiveOf().archiveId });
  assert.equal(emptyPage.data.summaryReady, true);
  assert.equal(emptyPage.data.summarySessionId, empty.id);
  assert.equal(emptyPage.data.summaryEmpty, true);
  assert.equal(emptyPage.data.hasSummaryRows, false);
  assert.equal(emptyPage.data.summaryCountText, '0 条线 · 0 把');
  assert.equal(emptyPage.data.summaryHintText, '');
  assert.equal(emptyPage.data.summaryRows.length, 0);

  // 另一场：只完攀一条抱石线，没有可勾选的线，也不提示勾选。
  const done = startAt(DAY, GYM_A);
  const boulder = newRoute(done, { name: '蓝色动态线', grade: 'V3' });
  record(done, boulder, 'send');
  const page = openSummaryPage({ sessionId: done.id, archiveId: archiveOf().archiveId });
  assert.equal(page.data.summaryCountText, '1 条线 · 1 把 · 完攀 1 把');
  assert.equal(page.data.summaryRows[0].pickable, false);
  assert.equal(page.data.summaryRows[0].canPick, false);
  assert.equal(page.data.summaryRows[0].stateText, '已完攀');
  assert.equal(page.data.summaryHintText, '');
});

test('R3 独立小结页：未知 sessionId 与串档 archiveId 都给出可见状态，不展示另一场', () => {
  const { s1, rope } = twoSessionsFixture();
  const archiveId = archiveOf().archiveId;

  // 未知场次（例如本机档案被重置）：显示可见错误，不拿 0 冒充空场。
  const stale = openSummaryPage({ sessionId: 'session-gone', archiveId });
  assert.equal(stale.data.ready, true);
  assert.equal(stale.data.summaryReady, false);
  assert.match(stale.data.summaryError, /找不到这场训练/);
  assert.equal(stale.data.summaryRows.length, 0);
  assert.equal(stale.data.hasSummaryRows, false);
  assert.equal(stale.data.summaryCountText, '');

  // 串档：入口记下的档案 ID 与本机现在这一份不同 → 不展示任何场次（哪怕同名 ID 就在本档案里）。
  const crossed = openSummaryPage({ sessionId: s1.id, archiveId: 'archive-other' });
  assert.equal(crossed.data.summaryReady, false);
  assert.match(crossed.data.summaryError, /另一份本机档案/);
  assert.equal(crossed.data.summarySessionId, '', '不把同名场次展示出来');
  assert.equal(crossed.data.summaryRows.length, 0);
  assert.equal(crossed.data.hasSummaryRows, false);
  assert.equal(crossed.data.summaryCountText, '');

  // 串档时勾选也不落盘：没有可点的行。
  crossed.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(wishlist.loadWishlist().state.items.length, 0, '串档时不写清单');
});

test('R3 独立小结页：撤回、恢复与改为未完成后分别对账，待保存把次不计入', () => {
  const session = startAt(DAY, GYM_A);
  // 抱石线：只有抱石的已完攀把次能「改为未完成」，因此这段对账用抱石。
  const route = newRoute(session, { name: '蓝色动态线', climbType: '抱石', grade: 'V4' });
  const first = record(session, route, 'fail', '第一把没到顶');
  record(session, route, 'fail', '第二把力竭');
  const third = record(session, route, 'send', '第三把完攀');
  const archiveId = archiveOf().archiveId;

  const before = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(before.data.summaryCountText, '1 条线 · 3 把 · 完攀 1 把');
  assert.equal(before.data.summaryRows[0].attemptCountText, '3 把');

  // 撤回第三把（那一把完攀）：把数、完攀与分项同步减一。
  const undone = store.undoAttempt(third.id, { routeId: route.id, sessionId: session.id });
  assert.equal(undone.ok, true, undone.error);
  const afterUndo = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(afterUndo.data.summaryCountText, '1 条线 · 2 把');
  assert.equal(afterUndo.data.summaryRows[0].attemptCountText, '2 把');
  assert.equal(afterUndo.data.summaryRows[0].sendCount, 0);
  assert.equal(
    afterUndo.data.summaryRows[0].latestNote,
    '第二把力竭',
    '最近有效备注跳过已撤回的那一句'
  );

  // 恢复：回到撤回前的读数（原 ID、原序号与原备注）。
  const restored = store.restoreAttempt(third.id, { routeId: route.id, sessionId: session.id });
  assert.equal(restored.ok, true, restored.error);
  const afterRestore = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(afterRestore.data.summaryCountText, '1 条线 · 3 把 · 完攀 1 把');
  assert.equal(afterRestore.data.summaryRows[0].latestNote, '第三把完攀');

  // 把原完攀改为未完成：把数不变，完攀随原记录更新，这条线变回可勾选。
  const send = archiveOf().attempts.find(
    item => item.routeId === route.id && item.result === 'send'
  );
  const corrected = store.correctAttempt(send.id, { routeId: route.id, sessionId: session.id });
  assert.equal(corrected.ok, true, corrected.error);
  const afterCorrect = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(afterCorrect.data.summaryCountText, '1 条线 · 3 把');
  assert.equal(afterCorrect.data.summarySendText, '');
  assert.equal(afterCorrect.data.summaryRows[0].sendCount, 0);
  assert.equal(afterCorrect.data.summaryRows[0].pickable, true, '没有完攀后回到可勾选');

  // 待保存的一把不计入小结，只给一句待保存提示。
  const extra = newRoute(session, { name: '白色斜壁线', climbType: '顶绳', grade: '5.9' });
  armSetFailAt(2);
  const failed = store.saveAttempt({
    sessionId: session.id,
    routeId: extra.id,
    result: 'fail',
    note: ''
  });
  assert.equal(failed.ok, false, '落盘失败不报已保存');
  const pending = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(pending.data.summaryCountText, '1 条线 · 3 把');
  assert.equal(pending.data.summaryPendingText, '本场还有 1 把待保存，未计入小结把数。');
  assert.equal(
    pending.data.summaryRows.some(row => row.routeId === extra.id),
    false,
    '待保存的线不进小结行'
  );
  disarmSetFail();

  // 按同一操作重试补齐后才 +1，并且仍然只算一条线路。
  const retried = store.saveAttempt({
    opId: failed.opId,
    sessionId: session.id,
    routeId: extra.id,
    result: 'fail',
    note: ''
  });
  assert.equal(retried.ok, true, retried.error);
  const committed = openSummaryPage({ sessionId: session.id, archiveId });
  assert.equal(committed.data.summaryCountText, '2 条线 · 4 把');
  assert.equal(committed.data.summaryPendingText, '');
  assert.equal(first.id !== third.id, true);
});

test('R3 独立小结页：勾选写失败显示实际保存状态并可原地重试；清单损坏时收回写入口', () => {
  const { s1, rope } = twoSessionsFixture();
  const archiveId = archiveOf().archiveId;

  // 写失败：不报已保存，勾选框显示的是实际保存状态。
  const page = openSummaryPage({ sessionId: s1.id, archiveId });
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

  disarmSetFail();
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.summaryRows.find(row => row.routeId === rope.id).checked, true);
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 1);

  // 清单损坏：小结数字照常显示，写入口收回，不改动清单原字节。
  resetDevice();
  const { s1: broken1, rope: brokenRope } = twoSessionsFixture();
  storage.set(WISHLIST_KEY, '{this is not json');
  const brokenBytes = rawOf(WISHLIST_KEY);
  const brokenPage = openSummaryPage({ sessionId: broken1.id, archiveId: archiveOf().archiveId });
  assert.match(brokenPage.data.summaryWishlistError, /下次想爬清单格式损坏/);
  assert.equal(brokenPage.data.summaryReady, true, '小结数字照常显示');
  assert.equal(brokenPage.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  brokenPage.data.summaryRows.forEach(row => assert.equal(row.canPick, false));
  brokenPage.toggleSummaryPick(tapDataset({ routeId: brokenRope.id }));
  assert.equal(rawOf(WISHLIST_KEY), brokenBytes, '原清单保持原样');
  assert.equal(writesOf(WISHLIST_KEY), 0);
  assert.match(brokenPage.data.notice, /下次想爬清单格式损坏/);
});

test('R3 独立小结页：重复点击只出现一次，其他收藏不丢失（同馆与别的岩馆都不受影响）', () => {
  const { s1, rope } = twoSessionsFixture();
  // 先收藏本馆另一条线与另一个岩馆的一条线：勾选小结里的线不能动它们。
  const other = newRoute(s1, { name: '灰色线', climbType: '顶绳', grade: '5.9' });
  const otherGymSession = startAt(DAY, GYM_B);
  const otherGymRoute = newRoute(otherGymSession, { name: '别的馆的线', grade: 'V2' });
  assert.equal(wishlist.addWishlist(other.id).ok, true);
  assert.equal(wishlist.addWishlist(otherGymRoute.id).ok, true);

  const page = openSummaryPage({ sessionId: s1.id, archiveId: archiveOf().archiveId });
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
  const left = wishlist.loadWishlist().state.items;
  assert.equal(left.length, 2);
  assert.equal(left.some(item => item.routeId === rope.id), false);
  assert.equal(left.some(item => item.routeId === other.id), true);
});

test('R3 独立小结页只读不依赖云：没有 wx.cloud 也照常显示与勾选', async () => {
  const { s1, rope } = twoSessionsFixture();
  assert.equal(typeof global.wx.cloud, 'undefined');
  const page = openSummaryPage({ sessionId: s1.id, archiveId: archiveOf().archiveId });
  await flush();
  assert.equal(page.data.summaryCountText, '2 条线 · 3 把 · 完攀 1 把');
  page.toggleSummaryPick(tapDataset({ routeId: rope.id }));
  assert.equal(wishlist.listWishlist(archiveOf(), {}).items.length, 1);
  assert.equal(wxLog.toasts.length, 0, '勾选不依赖云提示');
});

test('R3 独立小结页：返回本场记录的入口可用（正常返回到场内页）', () => {
  const { s1 } = twoSessionsFixture();
  const page = openSummaryPage({ sessionId: s1.id, archiveId: archiveOf().archiveId });
  resetWxLog();
  page.goBackToSession();
  assert.equal(wxLog.backs.length, 1, '返回上一页（场内页）');
  assert.equal(wxLog.relaunches.length, 0, '有可返回的页面时不重建页面栈');

  const wxml = fs.readFileSync(SUMMARY_PAGE_WXML, 'utf8');
  assert.match(wxml, /bindtap="goBackToSession"/);
});

test('R3 独立小结页 WXML 区块与真实绑定齐全；新页在正式 app.json 中恰好注册一次', () => {
  const { s1, s2 } = twoSessionsFixture();
  const page = openSummaryPage({ sessionId: s1.id, archiveId: archiveOf().archiveId });
  assert.equal(page.data.summarySessionPickerVisible, true);
  assert.equal(page.data.summarySessionIndex, 1, '选择器当前值＝正在看的那一场');
  assert.equal(page.data.summarySessionValue, '2026-11-10 · A 馆 · 第 1 场');

  const wxml = fs.readFileSync(SUMMARY_PAGE_WXML, 'utf8');
  assert.match(wxml, /id="session-summary"/);
  assert.match(wxml, /id="summary-count"[\s\S]{0,80}\{\{summaryCountText\}\}/);
  assert.match(wxml, /id="summary-error"/);
  assert.match(wxml, /id="summary-empty"/);
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
  assert.match(
    wxml,
    /id="summary-pick-state-\{\{item\.routeId\}\}"[\s\S]{0,120}\{\{item\.wishlistStateText\}\}/
  );
  assert.match(
    wxml,
    /data-route-id="\{\{item\.routeId\}\}"[\s\S]{0,160}bindtap="toggleSummaryPick"/
  );
  assert.match(
    wxml,
    /data-route-id="\{\{item\.routeId\}\}"\s*bindtap="openSummaryRoute"/
  );
  assert.match(
    wxml,
    /wx:if="\{\{item\.pickable\}\}"[\s\S]{0,200}id="summary-pick-\{\{item\.routeId\}\}"/
  );

  const handlers = handlersIn(wxml);
  ['toggleSummaryPick', 'openSummaryRoute', 'returnToActiveSession', 'goBackToSession'].forEach(
    name => {
      assert.ok(handlers.includes(name), '小结页绑定真实处理器：' + name);
      assert.equal(typeof summaryPageDefinition[name], 'function', name + ' 应为页面方法');
    }
  );
  assert.equal(typeof summaryPageDefinition.onSummarySessionChange, 'function');

  // 正式 app.json：新页恰好注册一次，四件套齐全，原页面与 tabBar 不变。
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(
    appJson.pages.filter(item => item === SUMMARY_PAGE_FILE).length,
    1,
    '新页在正式 app.json 中恰好注册一次'
  );
  assert.equal(new Set(appJson.pages).size, appJson.pages.length, '正式页面不得重复注册');
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, SUMMARY_PAGE_FILE + ext)),
      '缺少小结页文件 ' + SUMMARY_PAGE_FILE + ext
    );
  }
  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ],
    'tabBar 相对基线不变'
  );
  assert.equal(archiveOf().activeSessionId, s2.id, '核对注册与绑定都不改当前场次');
});

test('R3 场内页 WXML：小结只留入口，其余训练操作一个不少，且入口排在结果按钮之后（场内不再铺清单）', () => {
  const { s1, s2 } = twoSessionsFixture();
  // ?sessionId= 仍是既有入口；入口只决定打开哪一场小结。
  const page = openSessionPage({ sessionId: s1.id });
  assert.equal(page.data.summaryEntrySessionId, s1.id);

  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  assert.match(wxml, /id="session-summary" class="section session-summary"/);
  assert.match(wxml, /bindtap="openSessionSummary"/);
  assert.match(wxml, /id="summary-entry-target"[\s\S]{0,80}\{\{summaryEntryLabel\}\}/);

  // 内联小结整块（读数、行、勾选、回看原线与选择器）已经不在场内页。
  assert.doesNotMatch(wxml, /id="summary-count"/);
  assert.doesNotMatch(wxml, /id="summary-pick-/);
  assert.doesNotMatch(wxml, /id="summary-session-picker"/);
  assert.doesNotMatch(wxml, /bindtap="toggleSummaryPick"/);
  assert.doesNotMatch(wxml, /bindtap="openSummaryRoute"/);
  assert.doesNotMatch(wxml, /bindchange="onSummarySessionChange"/);
  assert.equal(typeof sessionDefinition.toggleSummaryPick, 'undefined');
  assert.equal(typeof sessionDefinition.summaryPickNotice, 'undefined');
  assert.equal(typeof sessionDefinition.openSummaryRoute, 'undefined');
  assert.equal(typeof sessionDefinition.onSummarySessionChange, 'undefined');
  assert.equal(typeof sessionDefinition.openSessionSummary, 'function');

  // 位置：在小结区里、本场线路列表之后。
  // T035 起「下次想爬」整份清单已搬到独立页（pages/training-wishlist），
  // 场内不再铺清单，也不再有当前线路的清单状态与加入/撤下/归档入口。
  const entry = wxml.indexOf('id="summary-entry"');
  const summaryStart = wxml.indexOf('id="session-summary"');
  const routeList = wxml.indexOf('id="route-list"');
  assert.ok(summaryStart !== -1 && entry !== -1 && routeList !== -1);
  assert.ok(entry > summaryStart, '入口在小结区里');
  assert.ok(summaryStart > routeList, '小结入口在本场线路列表之后');
  // T036：结果与记录操作在单线记录页，场内页不再内联结果按钮。
  assert.doesNotMatch(wxml, /class="result-button result-fail"/);
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  assert.match(recordWxml, /class="result-button result-fail"/);
  assert.match(recordWxml, /bindtap="recordAttempt"/);
  assert.match(recordWxml, /bindtap="correctSend"/);

  assert.doesNotMatch(wxml, /id="wishlist-section"/);
  assert.doesNotMatch(wxml, /id="selected-wishlist"/);
  assert.doesNotMatch(wxml, /id="wishlist-row-/);
  assert.doesNotMatch(wxml, /bindtap="addSelectedToWishlist"/);
  assert.equal(typeof sessionDefinition.refreshWishlist, 'undefined');
  assert.equal(typeof sessionDefinition.addSelectedToWishlist, 'undefined');
  assert.equal(typeof sessionDefinition.removeSelectedFromWishlist, 'undefined');
  assert.equal(typeof sessionDefinition.archiveSelectedWishlist, 'undefined');

  // 场内保留的绑定：开场、切场、本场线路入口与加线、小结。
  const handlers = handlersIn(wxml);
  ['startSession', 'switchSession', 'openRecord', 'createRoute'].forEach(name => {
    assert.ok(handlers.includes(name), '场内绑定仍在：' + name);
  });
  // 记录与更正按原目的地迁移到单线页，绑定与处理器都在。
  assert.equal(typeof sessionDefinition.recordAttempt, 'undefined');
  assert.equal(typeof sessionDefinition.correctSend, 'undefined');
  const recordHandlers = handlersIn(recordWxml);
  ['recordAttempt', 'retryPendingAttempt', 'undoLatestAttempt', 'restoreLatestAttempt', 'correctSend']
    .forEach(name => assert.ok(recordHandlers.includes(name), '单线页绑定：' + name));
  assert.equal(archiveOf().activeSessionId, s2.id, '打开小结与读取入口都不改当前场次');
});

// ------------------------------------------------------------------ *
// T043 底栏记录的原场次列表：复用小结计数，只读
// ------------------------------------------------------------------ *

test('T043 场次列表按日期倒序、同日按原岩馆 ID 分组、组内场次倒序，行取小结同一份计数', () => {
  const { yesterday, todayFirst, todayActive } = twoDaysFixture();
  const archive = archiveOf();
  const archiveBytes = rawOf(ARCHIVE_KEY);
  const archiveWrites = writesOf(ARCHIVE_KEY);

  const listed = buildSessionList(archive);
  assert.equal(listed.sessionCount, 3);
  assert.equal(listed.dayCount, 2);
  assert.deepEqual(listed.days.map(day => day.date), [DAY, YESTERDAY]);

  // 同日同馆两场：原场次顺序倒序，空场也占一行并沿用空场小结口径。
  const today = listed.days[0];
  assert.equal(today.gyms.length, 1);
  assert.equal(today.gyms[0].gymId, archive.sessions.find(s => s.id === todayActive.id).gymId);
  assert.deepEqual(
    today.gyms[0].sessions.map(row => row.id),
    [todayActive.id, todayFirst.id]
  );
  const activeRow = today.gyms[0].sessions[0];
  assert.equal(activeRow.label, '第 2 场');
  assert.equal(activeRow.isEmpty, true);
  assert.equal(activeRow.stateText, '空场');
  assert.equal(activeRow.summaryText, '0 条线 · 0 把');
  const firstRow = today.gyms[0].sessions[1];
  assert.equal(firstRow.label, '第 1 场');
  assert.equal(firstRow.summaryText, '1 条线 · 1 把');

  // 昨天的场次与今天分开，读数与 buildSessionSummary 完全一致。
  const yesterdayRow = listed.days[1].gyms[0].sessions[0];
  assert.equal(yesterdayRow.id, yesterday.id);
  assert.equal(yesterdayRow.summaryText, '2 条线 · 3 把 · 完攀 1 把');
  [...listed.days[0].gyms[0].sessions, yesterdayRow].forEach(row => {
    const summary = buildSessionSummary(archive, row.id);
    assert.equal(row.routeCount, summary.routeCount);
    assert.equal(row.attemptCount, summary.attemptCount);
    assert.equal(row.summaryText, summary.summaryText);
    assert.equal(row.archiveId, archive.archiveId);
  });

  // 每个原场次 ID 恰好一行。
  const ids = listed.days.flatMap(day => day.gyms.flatMap(gym => gym.sessions.map(row => row.id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, archive.sessions.length);

  // 只读：读取列表不写档案。
  assert.equal(rawOf(ARCHIVE_KEY), archiveBytes);
  assert.equal(writesOf(ARCHIVE_KEY), archiveWrites);
});

test('T043 同日两家同名岩馆按原岩馆 ID 各成一组，不按名字并组', () => {
  const s1 = startAt(DAY, '同名岩馆');
  const s2 = startAt(DAY, '另一家');
  // 把第二家的展示名改成与第一家相同：同名不等于同一家，仍按原岩馆 ID 分组。
  const raw = archiveOf();
  raw.gyms = raw.gyms.map(gym => Object.assign({}, gym, { name: '同名岩馆' }));
  assert.equal(store.saveArchive(raw).ok, true);

  const listed = buildSessionList(store.loadState().archive);
  assert.equal(listed.days.length, 1);
  assert.equal(listed.days[0].gyms.length, 2, '两家同名岩馆仍是两组');
  assert.deepEqual(
    listed.days[0].gyms.map(gym => gym.gymName),
    ['同名岩馆', '同名岩馆']
  );
  // 组序由组内最新场次决定：第二场（seq 更大）所在岩馆在前。
  assert.deepEqual(
    listed.days[0].gyms.flatMap(gym => gym.sessions.map(row => row.id)),
    [s2.id, s1.id]
  );
});

test('T043 撤回与恢复后场次列表的把数同步变化，恢复拿回原计数', () => {
  const { s1, s2, boulder } = twoSessionsFixture();
  const before = buildSessionList(archiveOf());
  const findRow = listed =>
    listed.days
      .flatMap(day => day.gyms.flatMap(gym => gym.sessions))
      .find(row => row.id === s1.id);
  assert.equal(findRow(before).summaryText, '2 条线 · 3 把 · 完攀 1 把');

  const sendAttempt = archiveOf().attempts.find(
    item => item.sessionId === s1.id && item.result === 'send'
  );
  const undone = store.undoAttempt(sendAttempt.id, {
    opId: 't043-undo',
    sessionId: s1.id,
    routeId: boulder.id
  });
  assert.equal(undone.code, 'undone');

  const afterUndo = buildSessionList(archiveOf());
  const undoneRow = findRow(afterUndo);
  assert.equal(undoneRow.summaryText, '2 条线 · 2 把', '已撤回的那一把不算本场把数');
  assert.equal(undoneRow.sendCount, 0);
  // 第二场自己那一把不受影响。
  assert.equal(
    afterUndo.days
      .flatMap(day => day.gyms.flatMap(gym => gym.sessions))
      .find(row => row.id === s2.id).summaryText,
    '1 条线 · 1 把'
  );

  const restored = store.restoreAttempt(sendAttempt.id, {
    opId: 't043-restore',
    sessionId: s1.id,
    routeId: boulder.id
  });
  assert.equal(restored.code, 'restored');
  assert.equal(findRow(buildSessionList(archiveOf())).summaryText, '2 条线 · 3 把 · 完攀 1 把');
});

// ------------------------------------------------------------------ *
// T044 小结：一线一卡
// ------------------------------------------------------------------ *

test('T044 小结一线一卡：每条线一张中性细边框卡并留卡间间距，行身份与顺序不变', () => {
  const wxml = fs.readFileSync(SUMMARY_PAGE_WXML, 'utf8');
  const wxss = fs.readFileSync(SUMMARY_PAGE_WXSS, 'utf8');
  const declarationsOf = selector =>
    [...wxss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1].split(',').map(text => text.trim()).includes(selector))
      .map(match => match[2])
      .join('\n');

  // 卡框在每一条线上：中性细边框、圆角与卡间 12px 间距；长名在卡内换行。
  const rowCss = declarationsOf('.summary-row');
  assert.match(rowCss, /border:\s*1px solid #D7DED9/, '每条线一条中性细边框');
  assert.match(rowCss, /border-radius:\s*8rpx/);
  assert.match(rowCss, /margin-top:\s*12px/, '卡与卡之间留 12px 间距');
  assert.match(declarationsOf('.summary-name'), /word-break:\s*break-all/);
  assert.match(declarationsOf('.summary-meta'), /word-break:\s*break-all/);

  // 只有一份行模板，行的键与身份仍是原长期 routeId（点行回原线不变）。
  assert.equal(wxml.match(/class="summary-row"/g).length, 1, '只有一份小结行模板');
  assert.match(wxml, /wx:for="\{\{summaryRows\}\}"[\s\S]{0,160}wx:key="routeId"/);
  assert.match(wxml, /id="summary-row-\{\{item\.routeId\}\}"/);
  assert.match(
    wxml,
    /data-route-id="\{\{item\.routeId\}\}"\s*bindtap="openSummaryRoute"/
  );

  // 同色同级同名两条线各占一张卡，顺序与小结数据一致，没有并成一行。
  const session = startAt(DAY, '卡框岩馆');
  const a = newRoute(session, {
    name: '同色同级线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  const b = newRoute(session, {
    name: '同色同级线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  record(session, a, 'fail');
  record(session, b, 'fail');

  const page = openSummaryPage({ sessionId: session.id, archiveId: archiveOf().archiveId });
  const expectedOrder = buildSessionSummary(archiveOf(), session.id).routes.map(row => row.routeId);
  assert.equal(page.data.summaryRows.length, 2);
  assert.deepEqual(page.data.summaryRows.map(row => row.routeId), expectedOrder);
  assert.deepEqual(
    [...page.data.summaryRows.map(row => row.routeId)].sort(),
    [a.id, b.id].sort(),
    '两条同色同级线都在小结里，各占一张卡'
  );
});

// ------------------------------------------------------------------ *
// T046 小结点线先进本场逐把
// ------------------------------------------------------------------ *

test('T046 小结点线先进本场逐把：入口文案与绑定一致，跨场历史不再由小结直达', () => {
  const wxml = fs.readFileSync(SUMMARY_PAGE_WXML, 'utf8');
  const source = fs.readFileSync(SUMMARY_PAGE_JS, 'utf8');

  // 每条线的入口写的是「本场逐把」，绑定的仍是原长期 routeId。
  assert.match(
    wxml,
    /id="summary-open-\{\{item\.routeId\}\}"[\s\S]{0,200}本场逐把 ›/
  );
  assert.match(wxml, /data-route-id="\{\{item\.routeId\}\}"\s*bindtap="openSummaryRoute"/);
  // 同一位置说明：跨场历史在逐把页里主动点开。
  assert.match(wxml, /id="summary-route-hint"[\s\S]{0,120}线路历史/);

  // 小结页只带原档案、所看场次与线路 ID 进入本场逐把，不再直接打开跨场历史。
  assert.match(source, /pages\/training-attempts\/training-attempts/);
  assert.match(source, /from=summary/);
  assert.doesNotMatch(source, /training-route\/training-route/, '跨场历史改由逐把页主动打开');
});
