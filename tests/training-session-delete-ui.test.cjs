/**
 * T053 本机历史整卡 / 本日场次长按删除 · 两页共用交互
 *
 * 直接加载真实页面与真实模块：
 * - pages/record-list（本机训练历史整卡）与 pages/training-session（本日场次按钮）；
 * - utils/training-session-delete-actions.js（两页共用菜单/确认/刷新/重试）；
 * - utils/training-session-delete.js（T052 协调器）与 utils/training-store.js（T051）。
 *
 * 原生 showActionSheet / showModal 用严格参数对象替身：缺字段、缺 success/fail 视为
 * 测试失败；菜单取消与原生失败分开核对。覆盖整卡/整按钮（含框内空白对应的同一原生
 * view）绑定、单场按钮、短按守卫、确认范围（含已撤回把次的视频关联）、重复长按、
 * 过期确认重新读取、待办阻塞、待清理重试、历史/小结/首页/统计重读，以及旧云区与
 * 下拉刷新不受影响。
 *
 * 真机触点、原生弹窗外观与相册原片另在整项 QA / 手机验收（待验）。
 *
 * 运行：node --test tests/training-session-delete-ui.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const RECORD_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const RECORD_WXML = path.join(ROOT, 'pages', 'record-list', 'record-list.wxml');
const RECORD_WXSS = path.join(ROOT, 'pages', 'record-list', 'record-list.wxss');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const SESSION_WXSS = path.join(ROOT, 'pages', 'training-session', 'training-session.wxss');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SESSION_DELETE_UTIL = path.join(ROOT, 'utils', 'training-session-delete.js');
const ACTIONS_UTIL = path.join(ROOT, 'utils', 'training-session-delete-actions.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';
const SESSION_DELETE_KEY = 'climbingNote.training.v1.session-delete';
const D1 = '2026-11-20';
const D2 = '2026-11-21';

// ---- 隔离存储 ----
const storage = new Map();

// ---- 原生弹窗替身：严格检查参数对象 ----
const actionLog = { calls: [], held: [], queue: [] };
const modalLog = { calls: [], held: [], queue: [] };
const wxLog = { navigations: [], toasts: [], stopPullDownRefresh: 0 };

function resetNativeLog() {
  actionLog.calls = [];
  actionLog.held = [];
  actionLog.queue = [];
  modalLog.calls = [];
  modalLog.held = [];
  modalLog.queue = [];
  wxLog.navigations = [];
  wxLog.toasts = [];
  wxLog.stopPullDownRefresh = 0;
}

function queueAction(behavior) {
  actionLog.queue.push(behavior);
}

function queueModal(behavior) {
  modalLog.queue.push(behavior);
}

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  // 严格替身：菜单只能有一个「删除场次」，回调必须齐全。
  showActionSheet(options) {
    assert.equal(typeof options, 'object', 'showActionSheet 必须收到参数对象');
    assert.ok(Array.isArray(options.itemList), 'itemList 必须是数组');
    assert.equal(options.itemList.length, 1, '菜单只显示一项');
    assert.equal(options.itemList[0], '删除场次', '菜单项只能是「删除场次」');
    assert.equal(typeof options.success, 'function');
    assert.equal(typeof options.fail, 'function');
    actionLog.calls.push(options);
    const behavior = actionLog.queue.length > 0 ? actionLog.queue.shift() : 'choose';
    if (behavior === 'hold') {
      actionLog.held.push(options);
      return;
    }
    if (behavior === 'cancel') {
      options.fail({ errMsg: 'showActionSheet:fail cancel' });
      return;
    }
    if (behavior === 'fail') {
      options.fail({ errMsg: 'showActionSheet:fail system error' });
      return;
    }
    if (typeof behavior === 'function') {
      behavior(options);
      return;
    }
    options.success({ tapIndex: 0 });
  },
  // 严格替身：标题/正文/按钮文案与回调都必须由共用流程给出。
  showModal(options) {
    assert.equal(typeof options, 'object', 'showModal 必须收到参数对象');
    assert.equal(typeof options.title, 'string');
    assert.ok(options.title.length > 0);
    assert.equal(typeof options.content, 'string');
    assert.ok(options.content.length > 0);
    assert.equal(options.confirmText, '删除');
    assert.equal(options.cancelText, '取消');
    assert.equal(typeof options.success, 'function');
    assert.equal(typeof options.fail, 'function');
    modalLog.calls.push(options);
    const behavior = modalLog.queue.length > 0 ? modalLog.queue.shift() : 'confirm';
    if (behavior === 'hold') {
      modalLog.held.push(options);
      return;
    }
    if (behavior === 'cancel') {
      options.success({ confirm: false, cancel: true });
      return;
    }
    if (behavior === 'fail') {
      options.fail({ errMsg: 'showModal:fail system error' });
      return;
    }
    if (typeof behavior === 'function') {
      behavior(options);
      return;
    }
    options.success({ confirm: true, cancel: false });
  },
  navigateTo(options) {
    wxLog.navigations.push(options);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  stopPullDownRefresh() {
    wxLog.stopPullDownRefresh += 1;
  }
};

// 页面测试的可控时钟：短按守卫窗口用 Date.now 判别。
const realNow = Date.now;
let clock = new Date(2026, 10, 20, 12, 0, 0).getTime();
Date.now = () => clock;
function tick(ms) {
  clock += typeof ms === 'number' ? ms : 1000;
}
process.on('exit', () => {
  Date.now = realNow;
});

const db = require(DB_JS);
const store = require(STORE_JS);
const sessionDelete = require(SESSION_DELETE_UTIL);
const actions = require(ACTIONS_UTIL);

let currentRecords = [];
db.getRecords = () => Promise.resolve({ data: currentRecords });
db.getRecentRecords = () => Promise.resolve({ data: [] });
db.getAllRecords = () => Promise.resolve({ data: [] });

// ---- 捕获原生 Page 定义 ----
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

const recordDefinition = capturePage(RECORD_JS);
const sessionDefinition = capturePage(SESSION_JS);
const indexDefinition = capturePage(INDEX_JS);
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

async function openRecordList() {
  const page = createPage(recordDefinition);
  page.onLoad();
  await page.onShow();
  return page;
}

function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  return page;
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

// ---- 合成档案 ----
function startTraining(gymName, date, now) {
  const started = store.startSession({ gymName, date, now });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function addRoute(sessionId, name, climbType, grade) {
  const created = store.createRoute({ sessionId, name, climbType, grade });
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function addAttempt(sessionId, routeId, result, note) {
  const saved = store.saveAttempt({ sessionId, routeId, result, note });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveOf() {
  const raw = storage.get(ARCHIVE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function writeArchive(archive) {
  storage.set(ARCHIVE_KEY, JSON.stringify(archive));
}

function indexOf() {
  const raw = storage.get(VIDEO_INDEX_KEY);
  return raw ? JSON.parse(raw) : { version: 1, nextClipSeq: 1, clips: [], pending: [] };
}

let clipSeq = 0;
function seedClip(attempt, options) {
  const config = options || {};
  const archive = archiveOf();
  clipSeq += 1;
  const clipId = config.clipId || 'clip-ui-' + clipSeq;
  const fileId = 'attempt-video/v1/' + archive.archiveId + '/' + clipId + '.mp4';
  const index = indexOf();
  index.clips.push({
    clipId,
    archiveId: archive.archiveId,
    sessionId: attempt.sessionId,
    routeId: attempt.routeId,
    attemptId: attempt.id,
    attemptSeq: attempt.seq,
    rev: config.rev || 1,
    bytes: 1024,
    fileId,
    markers: [],
    createdAt: '2026-11-20T01:00:00.000Z'
  });
  index.nextClipSeq = Math.max(index.nextClipSeq || 1, clipSeq + 1);
  storage.set(VIDEO_INDEX_KEY, JSON.stringify(index));
  return { clipId, fileId };
}

function sessionById(sessionId) {
  return ((archiveOf() || {}).sessions || []).find(item => item.id === sessionId) || null;
}

function rowsOf(page) {
  return (page.data.sessionDays || []).flatMap(day =>
    (day.gyms || []).flatMap(gym => gym.sessions || [])
  );
}

beforeEach(() => {
  storage.clear();
  currentRecords = [];
  resetNativeLog();
  sessionDelete.resetRuntime();
  clipSeq = 0;
  clock = new Date(2026, 10, 20, 12, 0, 0).getTime();
});

// ------------------------------------------------------------------ *
// 双入口绑定 / 单场按钮 / 短按守卫
// ------------------------------------------------------------------ *

test('T053 WXML 与状态：历史整卡和本日整个按钮都挂长按，单场也保留按钮，旧短按与重试链接仍在', () => {
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const recordWxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const sessionWxss = fs.readFileSync(SESSION_WXSS, 'utf8');

  // 记录页：整张场次卡（同一个原生 view）同时有短按、长按与两项原身份。
  assert.match(
    recordWxml,
    /id="local-session-\{\{session\.id\}\}"[\s\S]{0,500}bindtap="goToSessionSummary"[\s\S]{0,200}bindlongpress="requestDeleteSession"[\s\S]{0,300}data-session-id="\{\{session\.id\}\}"[\s\S]{0,200}data-archive-id="\{\{session\.archiveId\}\}"/
  );
  assert.match(recordWxml, /id="session-delete-notice"/);
  assert.match(recordWxml, /id="session-delete-error"/);
  assert.match(
    recordWxml,
    /id="session-cleanup"[\s\S]{0,200}bindtap="retrySessionCleanup">重试清理</
  );
  assert.doesNotMatch(recordWxml, /bindlongpress="[^"]*goToSessionSummary/);

  // 场内页：整个场次按钮根节点同时有短按、长按与原档案/原场次；只有一场也渲染。
  assert.match(
    sessionWxml,
    /id="session-chip-\{\{item\.id\}\}"[\s\S]{0,300}data-session-id="\{\{item\.id\}\}"[\s\S]{0,200}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,200}bindtap="switchSession"[\s\S]{0,200}bindlongpress="requestDeleteSession"/
  );
  assert.match(sessionWxml, /wx:if="\{\{sameDaySessions\.length > 0\}\}"/);
  assert.doesNotMatch(sessionWxml, /sameDaySessions\.length > 1/);
  assert.match(sessionWxml, /本日场次/);
  assert.match(
    sessionWxml,
    /id="session-cleanup"[\s\S]{0,200}bindtap="retrySessionCleanup">重试清理</
  );

  // 320/390：命中区不靠小文字，卡/按钮至少 44px；窄屏行内提示自动换行。
  const declarationsOf = (css, selector) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1].split(',').map(text => text.trim()).includes(selector))
      .map(match => match[2])
      .join('\n');
  assert.match(declarationsOf(recordWxss, '.local-session-row'), /min-height:\s*44px/);
  assert.match(declarationsOf(sessionWxss, '.chip'), /min-height:\s*44px/);
  assert.match(declarationsOf(sessionWxss, '.chip-row'), /flex-wrap:\s*wrap/);
  assert.match(declarationsOf(recordWxss, '.inline-notice-text'), /word-break:\s*break-all/);
  assert.match(declarationsOf(sessionWxss, '.retry-link'), /min-height:\s*44px/);

  for (const methodName of [
    'requestDeleteSession',
    'goToSessionSummary',
    'retrySessionCleanup',
    'retryRefresh',
    'retryLoadMore'
  ]) {
    assert.equal(typeof recordDefinition[methodName], 'function', '记录页缺少 ' + methodName);
  }
  for (const methodName of [
    'requestDeleteSession',
    'switchSession',
    'retrySessionCleanup',
    'openSessionSummary'
  ]) {
    assert.equal(typeof sessionDefinition[methodName], 'function', '场内页缺少 ' + methodName);
  }
});

test('T053 长按整卡：菜单只显示「删除场次」，取消菜单/取消确认都零写入，松手补发的 tap 不导航', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '一');
  seedClip(a1);
  const before = storage.get(ARCHIVE_KEY);
  currentRecords = [{ _id: 'old-1', date: '2026-01-01' }];
  const page = await openRecordList();
  assert.equal(page.data.sessionDays.length, 1);

  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });
  queueAction('cancel');
  const answer = await page.requestDeleteSession(event);
  assert.equal(answer.cancelled, true);
  assert.equal(answer.code, 'cancelled-menu');
  assert.equal(actionLog.calls.length, 1);
  assert.deepEqual(actionLog.calls[0].itemList, ['删除场次']);
  assert.equal(modalLog.calls.length, 0, '取消菜单不打开二次确认');
  assert.equal(page.data.sessionDeleteError, '');
  assert.equal(page.data.sessionDeleteNotice, '');
  assert.equal(storage.get(ARCHIVE_KEY), before, '取消菜单不改档案');

  // 长按松手后基础库补一个 tap：同一原场次不导航。
  const navBefore = wxLog.navigations.length;
  page.goToSessionSummary(event);
  assert.equal(wxLog.navigations.length, navBefore, '长按补发的 tap 不得导航');
  // 窗口之后的下一次独立短按照常打开原场小结。
  tick(actions.LONG_PRESS_TAP_GUARD_MS + 1);
  page.goToSessionSummary(event);
  assert.equal(wxLog.navigations.length, navBefore + 1);
  assert.match(wxLog.navigations.at(-1).url, /pages\/training-summary\/training-summary\?sessionId=/);

  // 取消二次确认同样零写入，且不改变当前数据。
  queueAction('choose');
  queueModal('cancel');
  const cancelled = await page.requestDeleteSession(event);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.code, 'cancelled-confirm');
  assert.equal(modalLog.calls.length, 1);
  assert.equal(storage.get(ARCHIVE_KEY), before, '取消确认不改档案');
  assert.equal(sessionById(s1.id) !== null, true);
  assert.equal(sessionDelete.pendingStatus(archiveOf().archiveId).pending, 0);
});

test('T053 历史空场卡与今日有记录按钮：空场只需确认删除，今日按钮取消确认零写入', async () => {
  const empty = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const recorded = startTraining('B馆', D2, new Date(2026, 10, 21, 8));
  const route = addRoute(recorded.id, 'B线', '顶绳', '5.10a');
  addAttempt(recorded.id, route.id, 'send', '有记录');
  store.selectSession(recorded.id);
  const before = storage.get(ARCHIVE_KEY);

  // 历史整卡：空场确认文案只说明删除这一场。
  const list = await openRecordList();
  queueAction('choose');
  queueModal('cancel');
  await list.requestDeleteSession(
    tapDataset({ sessionId: empty.id, archiveId: archiveOf().archiveId })
  );
  assert.match(modalLog.calls[0].content, /空场没有线路、把次或视频关联/);
  assert.equal(storage.get(ARCHIVE_KEY), before, '空场取消确认也零写入');
  assert.equal(sessionById(empty.id) !== null, true);

  queueAction('choose');
  queueModal('confirm');
  const removedEmpty = await list.requestDeleteSession(
    tapDataset({ sessionId: empty.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(removedEmpty.ok, true, removedEmpty.code);
  assert.equal(sessionById(empty.id), null, '历史空场按原 ID 删除');

  // 今日按钮：有记录的场取消二次确认零写入，当前场不变；确认后才删。
  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, recorded.id);
  const chip = tapDataset({ sessionId: recorded.id, archiveId: archiveOf().archiveId });
  const beforeCancel = storage.get(ARCHIVE_KEY);
  queueAction('choose');
  queueModal('cancel');
  const cancelled = await page.requestDeleteSession(chip);
  assert.equal(cancelled.cancelled, true);
  assert.equal(storage.get(ARCHIVE_KEY), beforeCancel);
  assert.equal(page.data.activeSession.id, recorded.id);

  queueAction('choose');
  queueModal('confirm');
  const removed = await page.requestDeleteSession(chip);
  assert.equal(removed.ok, true, removed.code);
  assert.equal(sessionById(recorded.id), null);
  assert.equal(page.data.activeSession, null);
});

test('T053 长按本日按钮：同一原场次的补发 tap 不切场，窗口后的独立短按照常切场', () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const s2 = startTraining('A馆', D1, new Date(2026, 10, 20, 9));
  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, s2.id);
  assert.equal(page.data.sameDaySessions.length, 2);

  // 长按非当前场按钮后取消菜单；松手补发的 tap 不应把当前场切走。
  queueAction('cancel');
  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });
  page.requestDeleteSession(event);
  page.switchSession(event);
  assert.equal(page.data.activeSession.id, s2.id, '长按补发的 tap 不切场');
  assert.equal(archiveOf().activeSessionId, s2.id);

  tick(actions.LONG_PRESS_TAP_GUARD_MS + 1);
  page.switchSession(event);
  assert.equal(page.data.activeSession.id, s1.id, '窗口后的独立短按照常切场');
  assert.equal(archiveOf().activeSessionId, s1.id);
});

// ------------------------------------------------------------------ *
// 确认范围 / 原生失败
// ------------------------------------------------------------------ *

test('T053 二次确认写明原日期、岩馆、场次、有效/已撤回把数与含撤回的视频关联', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  const r2 = addRoute(s1.id, 'B线', '顶绳', '5.10a');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '有效一把');
  const a2 = addAttempt(s1.id, r1.id, 'send', '后来撤回');
  const a3 = addAttempt(s1.id, r2.id, 'send', '完攀');
  const undone = store.undoAttempt(a2.id, { sessionId: s1.id, routeId: r1.id });
  assert.equal(undone.ok, true, undone.error);
  seedClip(a1);
  seedClip(a2, { clipId: 'clip-ui-undone' });
  const before = storage.get(ARCHIVE_KEY);
  const page = await openRecordList();

  queueAction('choose');
  queueModal('cancel');
  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.code, 'cancelled-confirm');
  assert.equal(modalLog.calls.length, 1);
  const content = modalLog.calls[0].content;
  assert.match(modalLog.calls[0].title, /删除这一场训练/);
  assert.match(content, /日期：2026-11-20/);
  assert.match(content, /岩馆：A馆/);
  assert.match(content, /场次：第 1 场/);
  assert.match(content, /线路 2 条 · 有效 2 把 · 完攀 1 把/);
  assert.match(content, /已撤回 1 把也在删除范围/);
  assert.match(content, /本场视频关联 2 个（含已撤回把次）/);
  assert.match(content, /没有剩余引用的攀笔视频副本/);
  assert.equal(storage.get(ARCHIVE_KEY), before, '只显示确认内容，不写档案');
});

test('T053 菜单/确认框原生失败与取消分开：失败给可见反馈，取消静默；两者都零写入', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  addRoleAttempt(s1.id);
  const before = storage.get(ARCHIVE_KEY);
  const page = await openRecordList();
  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });

  queueAction('fail');
  const menuFailed = await page.requestDeleteSession(event);
  assert.equal(menuFailed.code, 'menu-failed');
  assert.match(page.data.sessionDeleteError, /操作菜单打开失败/);

  queueAction('cancel');
  const menuCancelled = await page.requestDeleteSession(event);
  assert.equal(menuCancelled.cancelled, true);
  assert.equal(page.data.sessionDeleteError, '', '取消菜单不显示失败');

  queueAction('choose');
  queueModal('fail');
  const modalFailed = await page.requestDeleteSession(event);
  assert.equal(modalFailed.code, 'modal-failed');
  assert.match(page.data.sessionDeleteError, /删除确认框没有正常返回/);

  // 环境没有原生弹窗：同样有可见失败，不当作取消。
  const realSheet = global.wx.showActionSheet;
  const realModal = global.wx.showModal;
  delete global.wx.showActionSheet;
  const noSheet = await page.requestDeleteSession(event);
  assert.equal(noSheet.code, 'menu-unavailable');
  assert.match(page.data.sessionDeleteError, /操作菜单没有打开/);
  global.wx.showActionSheet = realSheet;

  queueAction('choose');
  delete global.wx.showModal;
  const noModal = await page.requestDeleteSession(event);
  assert.equal(noModal.code, 'modal-unavailable');
  assert.match(page.data.sessionDeleteError, /删除确认框没有打开/);
  global.wx.showModal = realModal;

  assert.equal(storage.get(ARCHIVE_KEY), before, '所有失败/取消都不写档案');
  assert.equal(sessionDelete.pendingStatus(archiveOf().archiveId).pending, 0);
});

function addRoleAttempt(sessionId) {
  const route = addRoute(sessionId, '占位线', '抱石', 'V2');
  return addAttempt(sessionId, route.id, 'fail', '');
}

// ------------------------------------------------------------------ *
// 删除后的列表 / 编号 / 当前场 / 首页 / 统计
// ------------------------------------------------------------------ *

test('T053 从历史整卡删除中间场：只删原 ID，历史编号顺延，旧云区与下拉刷新不受影响', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  addAttempt(s1.id, r1.id, 'fail', '第一场');
  const s2 = startTraining('A馆', D1, new Date(2026, 10, 20, 9));
  addRoleAttempt(s2.id);
  const s3 = startTraining('A馆', D1, new Date(2026, 10, 20, 10));
  const r3 = addRoute(s3.id, 'C线', '顶绳', '5.10a');
  addAttempt(s3.id, r3.id, 'send', '当前场');
  store.selectSession(s3.id);

  currentRecords = [{ _id: 'old-1', date: '2026-01-01' }];
  const page = await openRecordList();
  assert.deepEqual(rowsOf(page).map(row => row.id), [s3.id, s2.id, s1.id]);
  assert.deepEqual(rowsOf(page).map(row => row.label), ['第 3 场', '第 2 场', '第 1 场']);
  const oldRecordJson = JSON.stringify(page.data.records);
  assert.equal(page.data.records.length, 1);
  const dbCallsBefore = page.data.records.length;

  queueAction('choose');
  queueModal('confirm');
  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s2.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.ok, true, answer.code);
  assert.equal(answer.code, 'removed');

  const after = archiveOf();
  assert.equal(after.sessions.some(item => item.id === s2.id), false, '只删原目标场');
  assert.equal(after.sessions.some(item => item.id === s1.id), true);
  assert.equal(after.sessions.some(item => item.id === s3.id), true);
  assert.equal(after.attempts.some(item => item.sessionId === s2.id), false);

  // 历史两处列表按同一档案重读：剩余两场的原 ID 不变，同日编号补位。
  assert.deepEqual(rowsOf(page).map(row => row.id), [s3.id, s1.id]);
  assert.deepEqual(rowsOf(page).map(row => row.label), ['第 2 场', '第 1 场']);
  assert.equal(sessionById(s3.id).seq, after.sessions.find(item => item.id === s3.id).seq);
  assert.match(page.data.sessionDeleteNotice, /已删除 2026-11-20 · A馆 · 第 2 场/);

  // 删除后剩余场次的原有短按仍按原档案 ID + 原场次 ID 打开小结。
  page.goToSessionSummary(
    tapDataset({ sessionId: s3.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(
    wxLog.navigations.at(-1).url,
    '/pages/training-summary/training-summary?sessionId=' +
      s3.id +
      '&archiveId=' +
      archiveOf().archiveId
  );

  // 旧云区没有因长按删除而重新分页或改写。
  assert.equal(JSON.stringify(page.data.records), oldRecordJson, '旧云列表保持原样');
  assert.equal(page.data.loading, false);
  assert.equal(page.data.page, 1);
  assert.equal(page.data.loadError, false);
  assert.equal(page.data.refreshError, false);
  assert.ok(dbCallsBefore >= 1);

  // 旧入口仍可下拉刷新并正常结束动画。
  await page.onPullDownRefresh();
  assert.equal(wxLog.stopPullDownRefresh, 1);
});

test('T053 删除当前场：接续同馆同日最近一场，首页继续本场与本次小结一致，同日另一馆不自动接续', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  addAttempt(s1.id, r1.id, 'fail', '旧场');
  const s2 = startTraining('A馆', D1, new Date(2026, 10, 20, 9));
  const r2 = addRoute(s2.id, 'B线', '顶绳', '5.10a');
  addAttempt(s2.id, r2.id, 'send', '被删的当前场');
  const b1 = startTraining('B馆', D1, new Date(2026, 10, 20, 10));
  const rb = addRoute(b1.id, 'B馆线', '抱石', 'V2');
  addAttempt(b1.id, rb.id, 'send', '另一馆');
  store.selectSession(s2.id);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, s2.id);
  assert.equal(page.data.summaryEntrySessionId, s2.id);
  const statsPage = createPage(statsDefinition);
  await statsPage.loadStats();
  const beforeTotal = statsPage.data.totalAttempts;

  queueAction('choose');
  queueModal('confirm');
  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s2.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.ok, true, answer.code);
  assert.equal(answer.code, 'removed');

  const after = archiveOf();
  assert.equal(after.sessions.some(item => item.id === s2.id), false);
  assert.equal(after.activeSessionId, s1.id, '接续同馆同日最近一场');
  assert.notEqual(after.activeSessionId, b1.id, '同日另一馆不被自动接续');

  // 本页当前场、本日按钮与本次小结都指向接续场；编号按剩余场次重算。
  assert.equal(page.data.activeSession.id, s1.id);
  assert.equal(page.data.summaryEntrySessionId, s1.id);
  assert.match(page.data.summaryEntryLabel, new RegExp(D1 + ' · A馆 · 第 1 场'));
  assert.deepEqual(
    page.data.sameDaySessions.map(item => [item.id, item.label, item.isActive]),
    [
      [s1.id, '第 1 场', true],
      [b1.id, '第 2 场', false]
    ]
  );

  // 首页每次 onShow 重读档案：继续本场就是接续场，不是被删场、也不是另一馆。
  const home = createPage(indexDefinition);
  home.onLoad();
  home.onShow();
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.id, s1.id);
  assert.equal(home.data.archiveError, '');

  // 统计同样按最新档案重算：被删场的有效把数与完攀不再计入。
  await statsPage.loadStats();
  assert.equal(statsPage.data.totalAttempts, beforeTotal - 1);
  assert.equal(statsPage.data.sendCount, 1, '只留下两场的完攀');
});

test('T053 单场也有入口：只有一场时长按按钮可删，删后回到待开始且按钮随空场消失', () => {
  const s1 = startTraining('单场馆', D2, new Date(2026, 10, 21, 8));
  const page = openSessionPage({});
  assert.equal(page.data.sameDaySessions.length, 1, '当日只有一场也保留按钮');
  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });

  queueAction('choose');
  queueModal('confirm');
  const answer = page.requestDeleteSession(event);
  assert.equal(storage.get(ARCHIVE_KEY).includes(s1.id), true, '确认前档案未变');
  return answer.then(result => {
    assert.equal(result.ok, true, result.code);
    assert.equal(archiveOf().sessions.length, 0);
    assert.equal(page.data.activeSession, null);
    assert.equal(page.data.sameDaySessions.length, 0);
    assert.equal(page.data.sessionFormVisible, true, '回到待开始，仍需用户主动开场');
    assert.equal(page.data.summaryEntryReady, false);
  });
});

// ------------------------------------------------------------------ *
// 待办 / 过期确认 / 目标消失
// ------------------------------------------------------------------ *

test('T053 本场有待保存时只给可见原因，不打开确认、不写档案', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  addRoleAttempt(s1.id);
  const archive = archiveOf();
  const routeId = archive.routes[0].id;
  archive.pendingSaves = [
    {
      opId: 'op-pending',
      seq: archive.nextAttemptSeq || 1,
      sessionId: s1.id,
      routeId,
      result: 'fail',
      note: '',
      createdAt: '2026-11-20T00:00:00.000Z'
    }
  ];
  archive.nextAttemptSeq = (archive.nextAttemptSeq || 1) + 1;
  writeArchive(archive);
  const before = storage.get(ARCHIVE_KEY);
  const page = await openRecordList();

  queueAction('choose');
  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.code, 'pending');
  assert.equal(modalLog.calls.length, 0, '待办时不打开二次确认');
  assert.match(page.data.sessionDeleteError, /没保存|撤回、恢复或更正/);
  assert.equal(storage.get(ARCHIVE_KEY), before);
  assert.equal(sessionDelete.pendingStatus(archiveOf().archiveId).pending, 0);
});

test('T053 确认框打开后本场数量变化：提交返回 stale 后按原目标重新读取并再次确认，不沿用旧范围', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  addAttempt(s1.id, r1.id, 'fail', '原有一把');
  const other = startTraining('A馆', D1, new Date(2026, 10, 20, 9));
  addRoleAttempt(other.id);
  store.selectSession(other.id);
  const page = await openRecordList();

  let first = true;
  queueAction('choose');
  queueModal(options => {
    if (first) {
      first = false;
      // 确认框已经打开后内容变化：同场新增一把，旧快照必须作废。
      const added = store.saveAttempt({
        sessionId: s1.id,
        routeId: r1.id,
        result: 'send',
        note: '确认框打开后新增'
      });
      assert.equal(added.ok, true, added.error);
      options.success({ confirm: true, cancel: false });
      return;
    }
    options.success({ confirm: true, cancel: false });
  });

  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.ok, true, answer.code);
  assert.equal(modalLog.calls.length, 2, '过期确认后必须再次确认最新范围');
  assert.match(modalLog.calls[0].content, /有效 1 把/);
  assert.match(modalLog.calls[1].content, /有效 2 把/);
  assert.match(modalLog.calls[1].content, /完攀 1 把/);
  assert.equal(archiveOf().sessions.some(item => item.id === s1.id), false);
  assert.equal(archiveOf().sessions.some(item => item.id === other.id), true, '不误删其他场次');
});

test('T053 目标在确认期间已不存在：结束当次操作，不把确认改到别的场次', async () => {
  const target = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  addRoleAttempt(target.id);
  const other = startTraining('A馆', D1, new Date(2026, 10, 20, 9));
  addRoleAttempt(other.id);
  store.selectSession(other.id);
  const page = await openRecordList();

  queueAction('choose');
  queueModal(options => {
    // 用另一条路径把目标场删干净，模拟确认期间外部删除。
    const archive = archiveOf();
    archive.sessions = archive.sessions.filter(item => item.id !== target.id);
    archive.sessionRoutes = archive.sessionRoutes.filter(item => item.sessionId !== target.id);
    archive.attempts = archive.attempts.filter(item => item.sessionId !== target.id);
    writeArchive(archive);
    options.success({ confirm: true, cancel: false });
  });

  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: target.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.ok, true, answer.code);
  assert.equal(answer.code, 'removed');
  assert.equal(modalLog.calls.length, 1, '目标消失后不再打开第二个确认');
  assert.equal(archiveOf().sessions.some(item => item.id === other.id), true, '没有改删另一场');
  assert.deepEqual(rowsOf(page).map(row => row.id), [other.id]);
});

// ------------------------------------------------------------------ *
// 提交成功但视频副本待清理 / 可见重试
// ------------------------------------------------------------------ *

test('T053 已确认删除但视频副本清理失败：两页共用状态显示重试，按本档案恢复后结清', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '带视频');
  seedClip(a1);
  currentRecords = [{ _id: 'old-keep', date: '2026-01-01' }];

  sessionDelete.configure({
    createService: () => ({
      removeDeletedClip: async () => ({
        ok: false,
        code: 'file-cleanup-failed',
        error: '模拟文件删除失败'
      })
    })
  });

  const page = await openRecordList();
  queueAction('choose');
  queueModal('confirm');
  const answer = await page.requestDeleteSession(
    tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId })
  );
  assert.equal(answer.ok, true, answer.code);
  assert.equal(answer.code, 'removed-media-pending');
  assert.equal(sessionById(s1.id), null, '档案删除已确认');
  assert.equal(page.data.sessionCleanupVisible, true);
  assert.match(page.data.sessionCleanupText, /待清理/);
  assert.match(page.data.sessionDeleteNotice, /本机视频副本尚未清理/);
  // 旧云与旧重试链接保留。
  assert.deepEqual(page.data.records.map(item => item._id), ['old-keep']);
  assert.equal(typeof page.retryRefresh, 'function');
  assert.equal(typeof page.retryLoadMore, 'function');

  // 可见重试只恢复本档案的场次 journal；成功后同一条待清理状态消失。
  const realRecover = sessionDelete.recoverPending;
  let scoped = null;
  sessionDelete.recoverPending = options => {
    scoped = options;
    return realRecover(options);
  };
  sessionDelete.configure({
    createService: () => ({
      removeDeletedClip: async () => ({ ok: true, removed: true, kept: false })
    })
  });
  try {
    await page.retrySessionCleanup();
  } finally {
    sessionDelete.recoverPending = realRecover;
  }
  assert.equal(scoped.archiveId, archiveOf().archiveId, '只按当前档案范围恢复');
  assert.equal(sessionDelete.pendingStatus(archiveOf().archiveId).pending, 0);
  assert.equal(page.data.sessionCleanupVisible, false);
  assert.match(page.data.sessionDeleteNotice, /已清理完成/);
  assert.deepEqual(page.data.records.map(item => item._id), ['old-keep'], '旧云区未被改写');
});

test('T053 场内页同样显示待清理重试；短按原切换、小结入口与既有链接保持', () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  const r1 = addRoute(s1.id, 'A线', '抱石', 'V3');
  const a1 = addAttempt(s1.id, r1.id, 'fail', '带视频');
  seedClip(a1);
  const page = openSessionPage({});

  sessionDelete.configure({
    createService: () => ({
      removeDeletedClip: async () => ({ ok: false, error: '模拟文件删除失败' })
    })
  });
  queueAction('choose');
  queueModal('confirm');
  return page
    .requestDeleteSession(tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId }))
    .then(answer => {
      assert.equal(answer.ok, true, answer.code);
      assert.equal(page.data.sessionCleanupVisible, true);
      assert.match(page.data.sessionCleanupText, /待清理/);

      // 删除最后一场后回到待开始；原有“开始场次/小结/加线”逻辑仍在页面上。
      assert.equal(page.data.activeSession, null);
      assert.equal(page.data.sessionFormVisible, true);
      assert.equal(page.data.summaryEntryReady, false);
      assert.match(page.data.notice, /本机视频副本尚未清理/);
      assert.equal(typeof page.openSessionForm, 'function');
      assert.equal(typeof page.openSessionSummary, 'function');
      assert.equal(typeof page.openAddRoute, 'function');
    });
});

// ------------------------------------------------------------------ *
// 重复长按只执行一次
// ------------------------------------------------------------------ *

test('T053 连续长按同一场只打开一次菜单，第二个调用复用同一结果', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  addRoleAttempt(s1.id);
  const page = await openRecordList();
  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });

  queueAction('hold');
  const first = page.requestDeleteSession(event);
  const second = page.requestDeleteSession(event);
  assert.equal(actionLog.calls.length, 1, '连续长按只弹一次菜单');
  assert.equal(actionLog.held.length, 1);

  // 用户取消已经打开的那一次：两个调用得到同一个结果，且都不写盘。
  queueModal('cancel');
  actionLog.held[0].success({ tapIndex: 0 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, b.code);
  assert.equal(a.cancelled, true);
  assert.equal(modalLog.calls.length, 1);
  assert.equal(sessionById(s1.id) !== null, true);
  assert.equal(sessionDelete.pendingStatus(archiveOf().archiveId).pending, 0);
});

test('T053 确认期间档案已切换：结束当次操作，不把旧确认交给另一份档案，也不更新旧页面', async () => {
  const s1 = startTraining('A馆', D1, new Date(2026, 10, 20, 8));
  addRoleAttempt(s1.id);
  const before = storage.get(ARCHIVE_KEY);
  const page = await openRecordList();
  const event = tapDataset({ sessionId: s1.id, archiveId: archiveOf().archiveId });

  queueAction('choose');
  queueModal(options => {
    // 确认期间换了档案：原确认不能落到新档案上，也不更新旧页面。
    page._archiveId = 'archive-other';
    options.success({ confirm: true, cancel: false });
  });
  const answer = await page.requestDeleteSession(event);
  assert.equal(answer.code, 'context-changed');
  assert.equal(storage.get(ARCHIVE_KEY), before, '换档后不提交旧确认');
  assert.equal(sessionById(s1.id) !== null, true, '原档案目标保持原值');
  assert.match(page.data.sessionDeleteError, /档案或页面已经切换/);
});
