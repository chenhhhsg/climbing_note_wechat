/**
 * T030–T033 场内操作简化 · 整项流程回归（离线部分）
 *
 * 从真实入口走完一次完整训练，核对本批四项接在一起以后的行为：
 *   1) 空档从首页「开始训练」进场，首屏「添加第一条线路」新建线（T030）；
 *   2) 有线时在「本场线路」旁继续加线，再从结果按钮旁的换线区换线（T031）；
 *   3) 在 A 记到第 3 把（带备注，记下原把次 ID），在结果按钮下方的「最近一把」
 *      撤回回到 2，切到 B 再切回、退出重开后仍是 2，再在同一操作区主动恢复回到 3（T033）；
 *   4) 撤回后与恢复后各对一次账：场内把数、首页「继续本场」、场次小结、想爬清单、
 *      统计与跨天历史都按同一份**有效把次**读数（T032 的口径）。
 *
 * 直接加载真实页面文件并捕获 Page(...) 定义，用隔离的微信本地存储替身与写入故障注
 * 驱动真实页面处理器；刻意不提供 wx.cloud：场内页与新增训练路径不得有云调用，旧云
 * 读取只作旁证。页面上的「最近一把」一行只认原把次 ID 与归属，因此这里也用 WXML
 * 绑定同一组 dataset（attemptId / routeId / sessionId / expected）来点击。
 *
 * 真机触控、模拟器里的实际坐标命中、微信开发者工具与手机预览留在整项验收（待验）。
 *
 * 运行：node --test tests/session-route-flow.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const SESSION_WXSS = path.join(ROOT, 'pages', 'training-session', 'training-session.wxss');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const RECORD_WXML = path.join(ROOT, 'pages', 'training-record', 'training-record.wxml');
const RECORD_WXSS = path.join(ROOT, 'pages', 'training-record', 'training-record.wxss');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const LIST_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const WISHLIST_KEY = 'climbingNote.training.v1.wishlist';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，可按需注入故障 ----
const storage = new Map();
const fault = { setFailAt: 0, setCount: 0, loseResponseAt: 0, rivalAt: 0, rival: null };

function resetDevice() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
  fault.rivalAt = 0;
  fault.rival = null;
}

/** 第 n 次写盘就失败（数据没写进去）。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

/** 写盘已生效但回执丢失（弱网/超时）：页面只看到失败，键里其实已是新数据。 */
function armSetLoseResponseAt(callNumber) {
  fault.setCount = 0;
  fault.loseResponseAt = callNumber;
}

/**
 * 第 n 次写盘时**另一个写者抢先**：先让 rival(key, incomingJson) 把键改成它自己的结果，
 * 再让本次写盘失败（本页这一笔一个字都没进去）。incomingJson 是本次本来要写的那份档案，
 * 例如可以从它的 pendingUndos 里读到**这次操作自己**的 opId。
 *
 * 这是「写失败 + 盘上恰好等于期望状态」的现实来源：同一份档案里另一个操作完成过、或者
 * 盘上已经被换成了另一份档案。QA 的 field.test.cjs 用同一手法劫持 setStorageSync（F08）。
 */
function armRivalWriterAt(callNumber, rival) {
  fault.setCount = 0;
  fault.rivalAt = callNumber;
  fault.rival = rival;
}

const wxLog = { navigations: [], switches: [], toasts: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.toasts = [];
}

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.rivalAt && fault.setCount === fault.rivalAt) {
      const rival = fault.rival;
      fault.rivalAt = 0;
      fault.rival = null;
      rival(key, value);
      throw new Error('setStorageSync:fail with rival writer interleaved at call ' + fault.setCount);
    }
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    storage.set(key, value);
    if (fault.loseResponseAt && fault.setCount === fault.loseResponseAt) {
      throw new Error('setStorageSync:fail after durable write injected at call ' + fault.setCount);
    }
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo(options) {
    wxLog.navigations.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  stopPullDownRefresh() {}
};

// 可控时钟：同一把按钮的快速双击窗口用 Date.now 判别，这里把两次点击明确分开。
const realNow = Date.now;
let clock = new Date(2026, 10, 10, 19, 0, 0).getTime();
Date.now = () => clock;
function tick(ms) {
  clock += typeof ms === 'number' ? ms : 1000;
}
process.on('exit', () => {
  Date.now = realNow;
});

const db = require(DB_JS);
const store = require(STORE_JS);
const summary = require(SUMMARY_JS);
const wishlist = require(WISHLIST_JS);

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
const attemptsDefinition = capturePage(ATTEMPTS_JS);
const routeDefinition = capturePage(ROUTE_JS);
const listDefinition = capturePage(LIST_JS);
const statsDefinition = capturePage(STATS_JS);

/** 页面实例替身：支持 wx 的 setData 数据路径写法（如 'noteEditor.text'）。 */
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

function openHome() {
  const page = createPage(indexDefinition);
  page.onLoad();
  return page;
}

function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  return page;
}

/**
 * 单线记录页（T036）：按 archiveId + sessionId + routeId 打开一条线在指定场次的记录。
 * 不传 sessionId 时取档案当前场次；routeId 必须显式给出。
 */
function openRecordFor(routeId, sessionId) {
  const archive = archiveOf();
  const page = createPage(recordDefinition);
  page.onLoad({
    archiveId: archive.archiveId,
    sessionId: sessionId || archive.activeSessionId,
    routeId
  });
  assert.equal(page.data.contextError, '', '单线页应能按原归属打开');
  return page;
}

/** 当前场次 + 当前选中线路的单线记录页（模拟退出重开后从列表再点进来）。 */
function openRecordPage() {
  const archive = archiveOf();
  assert.ok(archive.activeRouteId, '应有一条当前线路');
  return openRecordFor(archive.activeRouteId, archive.activeSessionId);
}

/** 逐把明细页（T036）：只列指定场次与线路。 */
function openAttemptsFor(sessionId, routeId) {
  const archive = archiveOf();
  const page = createPage(attemptsDefinition);
  page.onLoad({ archiveId: archive.archiveId, sessionId, routeId });
  assert.equal(page.data.contextError, '', '明细页应能按原归属打开');
  return page;
}

/**
 * 把 page 换成刚打开的那一页（保留测试里的同一个引用）：
 * 旧测试用同一个 page 变量跨线路操作，现在换线就是打开另一条线的单线页。
 */
function swapPageInto(page, fresh) {
  Object.keys(page).forEach(key => delete page[key]);
  Object.setPrototypeOf(page, Object.getPrototypeOf(fresh));
  Object.assign(page, fresh);
  return page;
}

function tapResult(result) {
  return { currentTarget: { dataset: { result } } };
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

/**
 * 「最近一把」这一行渲染出来的点击参数，与 WXML 上的 dataset 一一对应：
 * 原把次 ID、归属、渲染时的档案 ID、预期状态与预期版本（rev）。
 */
function rowEvent(row) {
  return tapDataset({
    attemptId: row.attemptId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    archiveId: row.archiveId,
    expected: row.expected,
    expectedRev: row.expectedRev
  });
}

function archiveOf() {
  return store.loadState().archive;
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
  // 旧云只作旁证：本机读数不得依赖它，这里给可控的空回执。
  db.getAllRecords = () => Promise.resolve({ data: [] });
  db.getRecords = () => Promise.resolve({ data: [], hasMore: false });
  db.getRecentRecords = () => Promise.resolve({ data: [] });
});

// ------------------------------------------------------------------ *
// 走真实入口的驱动小工具
// ------------------------------------------------------------------ *

/**
 * 从首页「开始训练」进场并填岩馆开一场：走的就是正式入口（首页按钮 + 场内页表单）。
 */
function startTrainingFromHome(gymName) {
  const home = openHome();
  assert.equal(home.data.hasActiveSession, false, '空档从首页开始训练');
  home.startTraining();
  assert.equal(
    wxLog.navigations.at(-1).url,
    '/pages/training-session/training-session?start=1'
  );

  const page = openSessionPage({ start: '1' });
  assert.equal(page.data.sessionFormVisible, true);
  page.onGymNameInput({ detail: { value: gymName } });
  page.startSession();
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.activeSession.gymName, gymName);
  return page;
}

/**
 * 从首屏加线面板新建一条线路（正式入口：openAddRoute + 表单 + createRoute）。
 * 返回新建线路的 ID（从档案里读，页面只报「已新建并选中」）。
 */
function addRouteThroughPage(page, name, options) {
  const opts = options || {};
  // 从单线页返回列表后按最新档案刷新行读数，再打开加线面板。
  page.onShow();
  const before = archiveOf().routes.map(route => route.id);
  page.openAddRoute(opts.existing ? tapDataset({ mode: 'existing' }) : tapDataset({ mode: 'new' }));
  assert.equal(page.data.addRouteVisible, true);

  if (opts.existing) {
    // 本馆已有线路：复用同一个 routeId 关联进本场（T030 的另一半入口）。
    page.pickGymRoute(tapDataset({ routeId: opts.existing }));
    assert.equal(page.data.storageError, '');
    assert.equal(page.data.selectedRoute.id, opts.existing, '关联成功后选中同一条线');
    // T036：关联并选中成功即直达那条线的单线记录。
    const nav = wxLog.navigations.at(-1);
    assert.match(nav.url, /^\/pages\/training-record\/training-record\?/);
    assert.match(nav.url, new RegExp('routeId=' + opts.existing));
    return opts.existing;
  }

  page.onNewRouteNameInput({ detail: { value: name } });
  // 类型与等级选择器按索引生效（与 WXML 的 picker 一致），这里把等级名换算成当前
  // 类型的索引；不给就沿用表单默认的抱石 V3。
  if (typeof opts.climbTypeIndex === 'number') {
    page.onNewRouteTypeChange({ detail: { value: opts.climbTypeIndex } });
  }
  if (opts.grade) {
    const gradeIndex = (page.data.newRouteGrades || []).indexOf(opts.grade);
    assert.ok(gradeIndex >= 0, '等级应在当前类型的选项里：' + opts.grade);
    page.onNewRouteGradeChange({ detail: { value: gradeIndex } });
  }
  page.createRoute();
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.addRouteVisible, false, '保存后面板收起');

  const created = archiveOf().routes.find(route => !before.includes(route.id));
  assert.ok(created, '新建线路应落盘');
  assert.equal(page.data.selectedRoute.id, created.id, '新建成功即选中');
  // T036：新建并选中成功即直达这条线的单线记录，带齐档案、场次与长期线路 ID。
  const nav = wxLog.navigations.at(-1);
  assert.match(nav.url, /^\/pages\/training-record\/training-record\?/);
  assert.match(nav.url, new RegExp('routeId=' + created.id));
  assert.match(nav.url, new RegExp('sessionId=' + page.data.activeSession.id));
  return created.id;
}

/** 在结果按钮上记一把（页面入口）。 */
function recordThroughPage(page, result) {
  tick();
  page.recordAttempt(tapResult(result));
  assert.equal(page.data.storageError, '', '这一把应已落盘');
}

/**
 * 换线（T036）：回到本场列表再点另一条线，等于打开那条线的单线记录。
 * 保留同一个 page 引用，便于旧用例跨线继续操作。
 */
function switchTo(page, routeId) {
  const sessionId = page.data.activeSession.id;
  const selected = store.selectRoute(routeId);
  assert.equal(selected.ok, true, selected.error);
  const fresh = openRecordFor(routeId, sessionId);
  swapPageInto(page, fresh);
  assert.equal(page.data.selectedRoute.id, routeId);
  return page;
}

/** 给某一把补/改备注：在逐把明细页上完成，保存/取消只影响这一把。 */
function addNoteThroughAttempts(sessionId, routeId, attemptId, text) {
  const attemptsPage = openAttemptsFor(sessionId, routeId);
  attemptsPage.openNoteEditor(tapDataset({ attemptId }));
  attemptsPage.onNoteInput({ detail: { value: text } });
  attemptsPage.saveNote();
  assert.equal(attemptsPage.data.storageError, '');
  assert.equal(attemptsPage.data.noteEditor, null);
}

function attemptsOf(page) {
  return page.data.attempts.map(row => ({ id: row.id, label: row.label, note: row.note }));
}

function savedAttempts(sessionId, routeId) {
  return store.attemptsFor(archiveOf(), { sessionId, routeId, includeUndone: true });
}

function linkCount(sessionId, routeId) {
  return archiveOf().sessionRoutes.filter(
    link => link.sessionId === sessionId && link.routeId === routeId
  ).length;
}

/**
 * 一次完整训练（全部走页面入口）：岩馆一场，A 线抱石 V3 记三把（第 2、3 把带备注），
 * B 线抱石 V3 记一把；结束时停在 B。返回各线路的 ID 与把次 ID。
 */
function trainThroughPages(gymName) {
  const sessionPage = startTrainingFromHome(gymName || '我自己去的岩馆');
  const sessionId = sessionPage.data.activeSession.id;

  const aId = addRouteThroughPage(sessionPage, 'A 线', { grade: 'V3' });
  let page = openRecordFor(aId, sessionId);
  recordThroughPage(page, 'fail');
  recordThroughPage(page, 'fail');
  recordThroughPage(page, 'fail');

  // 第 2、3 把补备注（明细页）：撤回到第 3 把时，最近有效备注要跳到第 2 把那一句。
  const labels = attemptsOf(page);
  addNoteThroughAttempts(sessionId, aId, labels[1].id, '第二把备注');
  addNoteThroughAttempts(sessionId, aId, labels[2].id, '第三把备注');
  page = openRecordFor(aId, sessionId);

  const bId = addRouteThroughPage(sessionPage, 'B 线', { grade: 'V3' });
  page = openRecordFor(bId, sessionId);
  recordThroughPage(page, 'fail');

  return {
    page,
    sessionPage,
    sessionId,
    aId,
    bId,
    aAttempts: [labels[0].id, labels[1].id, labels[2].id],
    bAttemptId: attemptsOf(page)[0].id
  };
}

// ------------------------------------------------------------------ *
// T030 首屏加线 + T031 换线：走完整流程
// ------------------------------------------------------------------ *

test('T030→T031 空档走完一次训练：首屏加两条线、各自记结果，换线只改当前选择', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;

  // 本场关联与线路：两条线各一次关联，记录各归各的。
  assert.equal(archiveOf().routes.length, 2);
  assert.equal(linkCount(flow.sessionId, flow.aId), 1);
  assert.equal(linkCount(flow.sessionId, flow.bId), 1);
  assert.equal(flow.sessionPage.data.routes.length, 2, '本场线路列表按真实本场关联计数');

  switchTo(page, flow.aId);
  assert.equal(page.data.routeCountText, '3 把');
  assert.deepEqual(
    attemptsOf(page).map(row => row.label),
    ['第 1 把', '第 2 把', '第 3 把']
  );
  assert.equal(page.data.attempts[2].note, '第三把备注');

  switchTo(page, flow.bId);
  assert.equal(page.data.routeCountText, '1 把');
  assert.deepEqual(attemptsOf(page).map(row => row.id), [flow.bAttemptId]);

  // 换线只改当前选择：不新建线路、不新增关联、不产生把次。
  const before = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  switchTo(page, flow.aId);
  switchTo(page, flow.bId);
  assert.equal(archiveOf().routes.length, before.routes);
  assert.equal(archiveOf().sessionRoutes.length, before.links);
  assert.equal(archiveOf().attempts.length, before.attempts);

  // 返回首页：继续本场看到的把数是本场有效把次（A 3 + B 1），当前线保持持久化的 B。
  const home = openHome();
  home.refreshTrainingEntry();
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.id, flow.sessionId);
  assert.equal(home.data.activeSession.attemptCountText, '4 把');
  assert.equal(archiveOf().activeRouteId, flow.bId);
});

// ------------------------------------------------------------------ *
// T033 最近一把的撤回与恢复：切场、重开、同坐标重复点击
// ------------------------------------------------------------------ *

test('T033 A 的第 3 把撤回 3→2、切 B 回 A 与退出重开仍是 2、恢复回到 3，原 ID 与备注保持', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];

  // 「最近一把」写清线路名、原序号与结果，目标就是刚才那一把。
  switchTo(page, flow.aId);
  const row = page.data.recentAttempt;
  assert.equal(row.attemptId, thirdId);
  assert.equal(row.titleText, '刚才 · A 线 第 3 把 · 未完成');
  assert.match(row.metaText, /石间岩馆/);
  const writesBefore = fault.setCount;

  page.undoLatestAttempt(rowEvent(row));
  assert.equal(page.data.routeCountText, '2 把');
  assert.deepEqual(
    attemptsOf(page).map(row => row.label),
    ['第 1 把', '第 2 把']
  );
  assert.equal(page.data.recentAttempt.titleText, '已撤回 · A 线 第 3 把 · 未完成');
  assert.equal(page.data.recentAttempt.canUndo, false, '撤回按钮收起，位置留空');
  assert.equal(page.data.recentAttempt.canRestore, true);

  // 同一坐标再点一次（画面还没重绘时落下来的同一次点击）：不再产生第二次撤回。
  const writesAfterUndo = fault.setCount;
  assert.ok(writesAfterUndo > writesBefore, '这一次撤回确实落盘');
  page.undoLatestAttempt(rowEvent(row));
  assert.equal(fault.setCount, writesAfterUndo, '原坐标重复点击不产生第二次效果');

  // 原记录仍在：ID、序号、结果、备注与时间都不变，只多一个撤回标记。
  const persistedThird = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId);
  assert.ok(persistedThird.undoneAt);
  assert.equal(persistedThird.note, '第三把备注');
  assert.equal(persistedThird.result, 'fail');
  assert.equal(
    savedAttempts(flow.sessionId, flow.aId).find(item => item.id === flow.aAttempts[1]).undoneAt,
    undefined,
    '第 2 把没有被顶替撤回'
  );
  assert.equal(savedAttempts(flow.sessionId, flow.bId).length, 1, 'B 自己的那一把不动');

  // 切到 B 再切回：A 的撤回状态与恢复目标都还在。
  switchTo(page, flow.bId);
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.recentAttempt.attemptId, flow.bAttemptId);
  assert.equal(page.data.recentAttempt.canUndo, true);
  switchTo(page, flow.aId);
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.recentAttempt.attemptId, thirdId);
  assert.equal(page.data.recentAttempt.canRestore, true);

  // 退出重开：新实例读同一份档案，撤回状态与恢复目标可见，恢复目标仍是第 3 把。
  const reopened = openRecordPage();
  assert.equal(reopened.data.selectedRoute.id, flow.aId, '当前线是持久化的 A');
  assert.equal(reopened.data.routeCountText, '2 把');
  assert.equal(reopened.data.recentAttempt.attemptId, thirdId);
  assert.equal(reopened.data.recentAttempt.titleText, '已撤回 · A 线 第 3 把 · 未完成');
  assert.equal(reopened.data.recentAttempt.canRestore, true);

  // 在同一操作区主动点「恢复这一把」：2→3，原序号、原备注与原 ID 都回来。
  const restoreRow = reopened.data.recentAttempt;
  reopened.restoreLatestAttempt(rowEvent(restoreRow));
  assert.equal(reopened.data.routeCountText, '3 把');
  assert.deepEqual(
    attemptsOf(reopened).map(row => row.label),
    ['第 1 把', '第 2 把', '第 3 把']
  );
  assert.equal(reopened.data.attempts[2].id, thirdId, '恢复拿回的仍是原来那一把');
  assert.equal(reopened.data.attempts[2].note, '第三把备注');
  assert.equal(reopened.data.recentAttempt.canRestore, false);
  assert.equal(reopened.data.recentAttempt.canUndo, true);

  // 恢复的原坐标再点一次也只刷新，不产生第二次恢复。
  const writesAfterRestore = fault.setCount;
  reopened.restoreLatestAttempt(rowEvent(restoreRow));
  assert.equal(fault.setCount, writesAfterRestore);
  assert.equal(reopened.data.routeCountText, '3 把');
  assert.equal(savedAttempts(flow.sessionId, flow.aId).length, 3, '档案里始终只有这三把');
});

test('T033 撤回／恢复交错与延迟保存：每个动作各结清一次，重开后只认已落盘状态', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);

  // 撤回 → 恢复 → 再撤回：三次操作各自结清一次，最终停在已撤回。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCountText, '2 把');
  const settled = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId).settledOps;
  assert.equal(settled.filter(op => op.undone === true).length, 2, '两次撤回答各结清一次');
  assert.equal(settled.filter(op => op.undone === false).length, 1, '恢复结清一次');

  // 第二段写成后回执丢失：页面只拿到失败，档案里其实已经恢复。页面这时**重读落盘状态**
  // 再显示：把数、最近一把与恢复/撤回入口都以磁盘为准，不留一个会重复写入的重试入口。
  const reopened = openRecordPage();
  armSetLoseResponseAt(2);
  reopened.restoreLatestAttempt(rowEvent(reopened.data.recentAttempt));
  assert.equal(reopened.data.storageError, '', '回执丢失不当作未保存：先按落盘状态核对');
  assert.match(reopened.data.notice, /回执丢失|已经落盘/);
  assert.equal(reopened.data.routeCountText, '3 把', '把数是重新读到的已落盘状态');
  assert.equal(reopened.data.recentAttempt.attemptId, thirdId);
  assert.equal(reopened.data.recentAttempt.canUndo, true, '恢复入口换成撤回入口');
  assert.equal(
    JSON.parse(storage.get(ARCHIVE_KEY)).attempts.find(item => item.id === thirdId).undoneAt,
    undefined,
    '回执丢失的这一次其实已经落盘'
  );

  // 再开一次页面：读到的就是档案里的实际状态（已恢复），不需要也不会有第二次恢复。
  armSetLoseResponseAt(0);
  const coldOpen = openRecordPage();
  assert.equal(coldOpen.data.routeCountText, '3 把');
  assert.equal(coldOpen.data.recentAttempt.attemptId, thirdId);
  assert.equal(coldOpen.data.recentAttempt.canUndo, true);
  assert.equal(coldOpen.data.recentAttempt.stateText, '', '重开后不显示只在本页的确认文案');

  const writesBefore = fault.setCount;
  coldOpen.restoreLatestAttempt(rowEvent(coldOpen.data.recentAttempt));
  assert.equal(fault.setCount, writesBefore, '已经是有效状态：只刷新，不写第二次');

  // 延迟保存：这一把的完攀写失败后重试，撤回区先收起，待保存的一把不是可撤回项。
  switchTo(coldOpen, flow.bId);
  const staleRow = coldOpen.data.recentAttempt;
  tick();
  armSetLoseResponseAt(1);
  coldOpen.recordAttempt(tapResult('fail'));
  const failedRow = coldOpen.data.pendingRows[0];
  assert.ok(failedRow, '失败的那一把留在「待保存」行');
  assert.equal(coldOpen.data.recentAttempt, null, '有未落盘把次时撤回区收起');
  assert.equal(coldOpen.data.routeCountText, '1 把 · 1 把待保存');

  const writesBeforePending = fault.setCount;
  coldOpen.undoLatestAttempt(rowEvent(staleRow));
  assert.equal(fault.setCount, writesBeforePending, '有待保存把次时不撤回上一条已保存把次');
  assert.match(coldOpen.data.notice, /还有一把没保存/);

  // 按原「待保存」行重试：补上同一把，最近一把随之前移。
  armSetLoseResponseAt(0);
  coldOpen.retryPendingAttempt(tapDataset({ opId: failedRow.opId }));
  assert.equal(coldOpen.data.storageError, '');
  assert.equal(coldOpen.data.hasPending, false);
  assert.equal(coldOpen.data.routeCountText, '2 把');
  assert.equal(coldOpen.data.recentAttempt.canUndo, true);
  assert.notEqual(coldOpen.data.recentAttempt.attemptId, staleRow.attemptId, '最近一把是刚补上的那一把');
  assert.equal(
    savedAttempts(flow.sessionId, flow.bId).filter(item => item.undoneAt).length,
    0,
    '整条流程里 B 一把都没被撤回'
  );
});

// ------------------------------------------------------------------ *
// 按钮位置与绑定约定（离线可核的部分）
// ------------------------------------------------------------------ *

/** 去掉注释后按选择器取声明块（后声明的规则覆盖前面的，与 CSS 一致）。 */
function cssRules(wxss) {
  const clean = wxss.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selectors: match[1].split(',').map(text => text.trim()),
    body: match[2].trim()
  }));
}

function declarationsOf(wxss, selector) {
  return cssRules(wxss)
    .filter(rule => rule.selectors.includes(selector))
    .map(rule => rule.body)
    .join('\n');
}

function minHeightOf(wxss, selector) {
  const found = declarationsOf(wxss, selector).match(/min-height\s*:\s*([^;]+)/);
  return found ? found[1].trim() : '';
}

test('T033 按钮位置可核：撤回与恢复是同一行里两个各占一半的独立槽，命中矩形不相交，绑定都带原把次 ID', () => {
  // T036：结果、最近一把与撤回/恢复都在单线记录页；场内页只留本场线路列表入口。
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');

  const resultSend = wxml.indexOf('class="result-button result-send"');
  const recent = wxml.indexOf('id="recent-attempt"');
  const attemptsLink = wxml.indexOf('id="open-attempts"');
  assert.ok(resultSend !== -1 && recent !== -1, '单线页有结果按钮与最近一把');
  assert.ok(resultSend < recent, '撤回区在结果按钮之后');
  assert.ok(recent < attemptsLink, '撤回区之后才是明细与资料入口');

  // 场内页只有一个「本场线路」统一列表：整行点入单线记录，不在页内再铺一份结果区。
  const sessionRoutesAt = sessionWxml.indexOf('id="session-routes"');
  const routeListAt = sessionWxml.indexOf('id="route-list"');
  assert.ok(sessionRoutesAt !== -1 && routeListAt !== -1, '场内页有本场线路与统一列表');
  assert.ok(sessionRoutesAt < routeListAt, '加线入口在统一列表之前');
  assert.equal(sessionWxml.match(/id="route-list"/g).length, 1, '场内只有这一份线路列表');
  assert.doesNotMatch(sessionWxml, /id="route-switch"/, '不再有第二套换线区');
  assert.match(sessionWxml, /bindtap="openRecord"/);
  assert.doesNotMatch(sessionWxml, /class="result-button result-fail"/, '场内页不再内联结果按钮');
  assert.doesNotMatch(sessionWxml, /id="recent-attempt"/, '场内页不再内联最近一把');

  // 同一行、两个兄弟槽：撤回在前（左槽），恢复在后（右槽）。
  const rowAt = wxml.indexOf('class="recent-attempt-row"');
  const undoSlotAt = wxml.indexOf('class="recent-attempt-slot"');
  const undoAt = wxml.indexOf('id="undo-attempt-{{recentAttempt.attemptId}}"');
  const restoreSlotAt = wxml.indexOf('class="recent-attempt-recovery"');
  const restoreAt = wxml.indexOf('id="restore-attempt-{{recentAttempt.attemptId}}"');
  const rowEndAt = wxml.indexOf('class="recent-attempt-info"');
  assert.ok(rowAt !== -1 && undoSlotAt !== -1 && restoreSlotAt !== -1, '两个槽都在这一行里');
  assert.ok(rowAt < undoSlotAt && undoSlotAt < undoAt, '左槽先放撤回');
  assert.ok(undoAt < restoreSlotAt && restoreSlotAt < restoreAt, '右槽再放恢复');
  assert.ok(restoreAt < rowEndAt, '两个槽都在行内，行外的信息排在后面');

  // 两个动作各在自己的槽里：可用时是按钮，不可用时是**等宽等高的非交互空位**，
  // 因此同一个坐标最多命中其中一个，撤回后也不会被相反动作接管。
  for (const selector of ['.recent-attempt-action', '.recent-attempt-restore']) {
    assert.match(declarationsOf(wxss, selector), /flex:\s*1 1 0/, selector + ' 与同排按钮等分宽度');
  }
  assert.match(declarationsOf(wxss, '.recent-attempt-slot'), /flex:\s*1 1 0/);
  assert.match(declarationsOf(wxss, '.recent-attempt-recovery'), /flex:\s*1 1 0/);
  assert.equal(
    declarationsOf(wxss, '.recent-attempt-slot'),
    declarationsOf(wxss, '.recent-attempt-recovery'),
    '左右两个槽同一套尺寸：各占一半、行高相同'
  );
  // 空位与实体按钮同高：按钮出现或消失都不改这一行的高度。
  const slotHeight = minHeightOf(wxss, '.recent-attempt-slot');
  assert.ok(slotHeight, '这一行有固定行高');
  assert.equal(minHeightOf(wxss, '.recent-attempt-idle'), slotHeight, '空位与整行同高');
  assert.equal(minHeightOf(wxss, '.secondary-button'), slotHeight, '两个动作的按钮基础高度与空位一致');
  assert.match(wxml, /wx:else class="recent-attempt-idle"/);
  const idleViews = [...wxml.matchAll(/<view[^>]*class="recent-attempt-idle"[^>]*>[\s\S]*?<\/view>/g)].map(
    match => match[0]
  );
  assert.equal(idleViews.length, 2, '两个槽各留一块空位（不可用的那一侧）');
  // 空位不是控件：没有 bindtap，也不是 <button>。
  for (const idle of idleViews) {
    assert.doesNotMatch(idle, /bindtap=/, '空位是透明区域，没有任何绑定');
  }

  // 命中矩形不相交的根：这一行是 flex 排布（左一半、右一半），没有任何绝对定位把
  // 两个动作叠到同一个坐标上。
  const recentCss = cssRules(wxss)
    .filter(rule => rule.selectors.some(selector => selector.indexOf('.recent-attempt') === 0))
    .map(rule => rule.body)
    .join('\n');
  assert.match(declarationsOf(wxss, '.recent-attempt-row'), /display:\s*flex/, '这一行是 flex 行');
  assert.doesNotMatch(recentCss, /position\s*:\s*(absolute|fixed)/, '这一行不用绝对定位叠放动作');

  // 统一列表的长名不截断：换行显示，行宽不随名称长短变化。
  assert.match(
    declarationsOf(fs.readFileSync(SESSION_WXSS, 'utf8'), '.route-row-name'),
    /word-break:\s*break-all/,
    '统一列表的长名称换行显示，不省略、不截断'
  );

  // 结果区高度稳定：常规态的两个结果按钮、完攀收起与完攀待确认面板同一高度，所以撤回
  // 唯一一次抱石完攀而解锁、或再次完攀收起时，下方的最近一把不会上下移动。
  const buttonHeight = minHeightOf(wxss, '.result-button');
  assert.ok(buttonHeight, '结果按钮有固定行高');
  assert.equal(minHeightOf(wxss, '.result-footer'), buttonHeight, '结果区整条与按钮同高');
  assert.equal(minHeightOf(wxss, '.route-completed-panel'), buttonHeight, '完攀收起面板与按钮同高');
  assert.equal(minHeightOf(wxss, '.route-pending-panel'), buttonHeight, '完成待确认面板与按钮同高');

  // 绑定与处理器：两个动作都带原把次 ID、归属、原档案 ID、预期状态与版本。
  assert.match(
    wxml,
    /id="undo-attempt-\{\{recentAttempt\.attemptId\}\}"[\s\S]{0,400}data-expected-rev="\{\{recentAttempt\.expectedRev\}\}"[\s\S]{0,80}bindtap="undoLatestAttempt"/
  );
  assert.match(
    wxml,
    /id="restore-attempt-\{\{recentAttempt\.attemptId\}\}"[\s\S]{0,400}data-expected-rev="\{\{recentAttempt\.expectedRev\}\}"[\s\S]{0,80}bindtap="restoreLatestAttempt"/
  );
  const handlers = new Set(handlersIn(wxml));
  for (const required of [
    'recordAttempt',
    'retryPendingAttempt',
    'undoLatestAttempt',
    'restoreLatestAttempt',
    'correctSend',
    'openAttempts',
    'openRouteProfile'
  ]) {
    assert.ok(handlers.has(required), '单线页应绑定：' + required);
    assert.equal(typeof recordDefinition[required], 'function', required + ' 必须有页面方法');
  }
  const sessionHandlers = new Set(handlersIn(sessionWxml));
  for (const required of ['openAddRoute', 'pickGymRoute', 'openRecord']) {
    assert.ok(sessionHandlers.has(required), '场内页应绑定：' + required);
    assert.equal(typeof sessionDefinition[required], 'function', required + ' 必须有页面方法');
  }
  // 写入仍只有档案层一份实现；单线页与明细页共用页面事件模块，不接云。
  const source = fs.readFileSync(RECORD_JS, 'utf8');
  const actionsSource = fs.readFileSync(
    path.join(ROOT, 'utils', 'training-record-actions.js'),
    'utf8'
  );
  assert.match(source, /utils\/training-store/);
  assert.match(source, /utils\/training-record-actions/);
  assert.doesNotMatch(source, /wx\.cloud/);
  assert.match(actionsSource, /store\.undoAttempt/);
  assert.match(actionsSource, /store\.restoreAttempt/);
});

test('T033 同一坐标连点两个方向：撤回只减一次、恢复只加一次，同一把末态与序号都对', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);
  const original = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId);
  /** 这一把上已结清的撤回/恢复凭据。 */
  const settledOpsOf = () =>
    (savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId).settledOps || []).map(
      op => op.opId
    );

  // 两个方向的操作永远只占其中一个槽：一行里不会同时给出撤回与恢复。
  const checkOffered = expected => {
    const row = page.data.recentAttempt;
    assert.equal(row.attemptId, thirdId, '这一行始终指向同一把');
    assert.equal(row.canUndo, expected === 'undo', '撤回槽只在有效态给按钮');
    assert.equal(row.canRestore, expected === 'restore', '恢复槽只在已撤回态给按钮');
    assert.notEqual(row.canUndo && row.canRestore, true, '两个动作不会同时出现在同一行');
  };
  checkOffered('undo');

  // 方向一：撤回。同一个控件（模拟器里就是同一个坐标）连点两次——第二次是同一份渲染
  // 参数的重放，不写盘，也不把这一把翻回有效。
  const undoControl = rowEvent(page.data.recentAttempt);
  page.undoLatestAttempt(undoControl);
  assert.equal(page.data.routeCountText, '2 把');
  const afterUndoBytes = storage.get(ARCHIVE_KEY);
  page.undoLatestAttempt(undoControl);
  assert.equal(page.data.routeCountText, '2 把', '连点撤回只减一把');
  assert.equal(storage.get(ARCHIVE_KEY), afterUndoBytes, '第二次是重复点击，一个字都不写');
  assert.match(page.data.notice, /已经撤回/);
  checkOffered('restore');
  assert.equal(
    savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId).undoneAt !== undefined,
    true,
    '这一把确实处于已撤回'
  );
  assert.equal(settledOpsOf().length, 1, '撤回方向只结清一次');
  assert.equal(page.data.recentAttempt.titleText, '已撤回 · A 线 第 3 把 · 未完成');

  // 方向二：恢复。同样在这个坐标连点两次。
  const restoreControl = rowEvent(page.data.recentAttempt);
  page.restoreLatestAttempt(restoreControl);
  assert.equal(page.data.routeCountText, '3 把');
  const afterRestoreBytes = storage.get(ARCHIVE_KEY);
  page.restoreLatestAttempt(restoreControl);
  assert.equal(page.data.routeCountText, '3 把', '连点恢复只加一把');
  assert.equal(storage.get(ARCHIVE_KEY), afterRestoreBytes, '第二次是重复点击，一个字都不写');
  assert.match(page.data.notice, /不用再恢复|已经在本场里/);
  checkOffered('undo');

  // 同一把的末态：ID、原序号、结果、备注与创建时间都没被连点改掉。
  const landed = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId);
  assert.equal(landed.id, thirdId);
  assert.equal(landed.seq, original.seq);
  assert.equal(landed.result, original.result);
  assert.equal(landed.note, original.note);
  assert.equal(landed.createdAt, original.createdAt);
  assert.equal(landed.undoneAt, undefined, '末态是有效');
  assert.equal(settledOpsOf().length, 2, '撤回与恢复各结清一次，没有多出来的重复写入');
});

test('T033 写盘被另一个写者抢先（同一份档案、另一个 opId）：不认领这次回执，按盘上状态显示冲突', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);
  const row = page.data.recentAttempt;
  const beforeBytes = storage.get(ARCHIVE_KEY);
  let ourOpId = '';

  // 另一个写者：同一份档案、另一个操作，用它自己的 opId 把这一把撤回。然后本次写盘失败
  // （页面这一笔一个字都没进去）。盘上于是恰好等于期望状态，但凭据不是这次操作的。
  armRivalWriterAt(1, (key, incoming) => {
    ourOpId = (JSON.parse(incoming).pendingUndos || []).find(
      item => item.attemptId === thirdId
    ).opId;
    assert.ok(ourOpId, '这次操作自己的 opId 随第一段写盘交给存储层');
    const rival = store.undoAttempt(thirdId, {
      sessionId: row.sessionId,
      routeId: row.routeId,
      archiveId: row.archiveId,
      opId: 'op-of-another-writer'
    });
    assert.equal(rival.ok, true, '另一个写者自己落地成功');
    assert.equal(rival.opId, 'op-of-another-writer');
  });
  page.undoLatestAttempt(rowEvent(row));

  const onDisk = JSON.parse(storage.get(ARCHIVE_KEY));
  const landed = onDisk.attempts.find(item => item.id === thirdId);
  const settled = (landed.settledOps || []).map(op => op.opId);
  assert.deepEqual(settled, ['op-of-another-writer'], '盘上只有另一个写者自己的凭据');
  assert.equal(settled.includes(ourOpId), false, '这次操作其实一个字都没落盘');

  // 状态看起来对了，但那是别人做的：不能说「此前那次已落盘（回执丢失）」。
  assert.doesNotMatch(page.data.notice, /回执丢失|已经落盘/, '不能认领不属于这次操作的回执');
  assert.match(page.data.notice, /不是这次撤回写入的/);
  assert.equal(page.data.storageError, '', '盘上状态是撤回后的有效状态，不是写失败');
  // 按真实盘上状态显示：把数是 2，这一行换成恢复入口，不留会重复写入的重试入口。
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.recentAttempt.canUndo, false);
  assert.equal(page.data.recentAttempt.canRestore, true);
  assert.equal(page.data.recentAttempt.restoreText, '恢复这一把', '不保留这次撤回的重试入口');
  assert.notEqual(storage.get(ARCHIVE_KEY), beforeBytes, '盘上换成了另一个写者的结果');
});

test('T033 写盘被换档抢先（另一份档案复用同样的把次与 opId）：不认领这次回执', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);
  const row = page.data.recentAttempt;
  const twinArchiveId = 'archive-of-another-profile';
  let ourOpId = '';

  // 另一份本机档案（换档/换设备）把把次、场次、线路 ID 乃至**这次操作自己的 opId** 全都
  // 复用一遍：只比状态、归属与 opId 都会把它认成「这次已落盘」。
  armRivalWriterAt(1, (key, incoming) => {
    ourOpId = (JSON.parse(incoming).pendingUndos || []).find(
      item => item.attemptId === thirdId
    ).opId;
    assert.ok(ourOpId, '这次操作自己的 opId 随第一段写盘交给存储层');
    const twin = JSON.parse(storage.get(ARCHIVE_KEY));
    twin.archiveId = twinArchiveId;
    twin.attempts.find(item => item.id === thirdId).note = '另一份档案自己的备注';
    storage.set(ARCHIVE_KEY, JSON.stringify(twin));
    const colliding = store.undoAttempt(thirdId, {
      sessionId: row.sessionId,
      routeId: row.routeId,
      archiveId: twinArchiveId,
      opId: ourOpId
    });
    assert.equal(colliding.ok, true, '另一份档案按同一个 opId 也结清了一次');
  });
  page.undoLatestAttempt(rowEvent(row));

  const onDisk = JSON.parse(storage.get(ARCHIVE_KEY));
  assert.equal(onDisk.archiveId, twinArchiveId, '盘上已经是另一份档案');
  const landed = onDisk.attempts.find(item => item.id === thirdId);
  assert.equal(landed.note, '另一份档案自己的备注');
  assert.ok(
    (landed.settledOps || []).some(op => op.opId === ourOpId),
    '另一份档案确实带着同样的已结清凭据（只看状态/归属/opId 都会被它骗过）'
  );

  assert.doesNotMatch(page.data.notice, /回执丢失|已经落盘/, '盘上不是原来那一份档案，不能认领回执');
  assert.match(page.data.notice, /另一份本机档案/);
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把', '按真实盘上状态显示');
  assert.equal(page.data.recentAttempt.canRestore, true);
});

// ------------------------------------------------------------------ *
// 完整训练后的逐项对账（T032 口径）
// ------------------------------------------------------------------ *

test('T030–T033 完整训练逐项对账：撤回后与恢复后，场内/首页/小结/清单/统计/历史同一有效集合', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];

  // 把 A 收进「下次想爬」，让清单也参与对账（T035 起场内不再铺清单，
  // 加入走同一份清单接口，与线路资料页、小结勾选共用一个入口）。
  switchTo(page, flow.aId);
  const added = wishlist.addWishlist(flow.aId);
  assert.equal(added.ok, true, added.error);
  assert.equal(added.code, 'added');
  const photoBlob = JSON.stringify({ version: 1, photos: [{ routeId: flow.aId }] });
  storage.set(PHOTO_KEY, photoBlob);

  /** 按当前档案读一遍所有读数端，返回可比对的一组数字。 */
  function readings() {
    const archive = archiveOf();
    const home = openHome();
    home.refreshTrainingEntry();
    const statsPage = createPage(statsDefinition);
    statsPage.loadStats();
    const routePage = createPage(routeDefinition);
    routePage.onLoad({ routeId: flow.aId });
    const listPage = createPage(listDefinition);
    listPage.refreshLocalHistory();
    const built = summary.buildSessionSummary(archive, flow.sessionId);
    const rowA = built.routes.find(row => row.routeId === flow.aId);
    const listed = wishlist.listWishlist(archive).items.find(item => item.routeId === flow.aId);
    const listA = listPage.data.localRoutes.find(item => item.id === flow.aId);
    return {
      sessionPage: page,
      homeAttempts: home.data.activeSession.attemptCountText,
      summaryAttempts: built.attemptCount,
      summaryRoutes: built.routeCount,
      summarySends: built.sendCount,
      rowAAttempts: rowA.attemptCount,
      rowALatestNote: rowA.latestNote,
      wishlistAttempts: listed.attemptCount,
      wishlistNote: listed.latestNote,
      statsAttempts: statsPage.data.totalAttempts,
      statsSends: statsPage.data.sendCount,
      routeDetailAttempts: routePage.data.attemptCount,
      listCountText: listA.countText
    };
  }

  // 记录原 ID 与照片归属：整条流程里都不该变。
  const originalThird = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId);
  assert.equal(originalThird.seq, 3);

  // 1) 撤回前：A 3 把 + B 1 把，最近有效备注是第 3 把那一句。
  const before = readings();
  assert.equal(before.sessionPage.data.routeCountText, '3 把');
  assert.equal(before.homeAttempts, '4 把');
  assert.equal(before.summaryAttempts, 4);
  assert.equal(before.summaryRoutes, 2);
  assert.equal(before.summarySends, 0);
  assert.equal(before.rowAAttempts, 3);
  assert.equal(before.rowALatestNote, '第三把备注');
  assert.equal(before.wishlistAttempts, 3);
  assert.equal(before.wishlistNote, '第三把备注');
  assert.equal(before.statsAttempts, 4);
  assert.equal(before.statsSends, 0);
  assert.equal(before.routeDetailAttempts, 3);
  assert.equal(before.listCountText, '1 天 · 1 场 · 3 把');

  // 2) 撤回 A 的第 3 把：所有读数端同步减一，最近有效备注跳到第 2 把。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  const afterUndo = readings();
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(afterUndo.homeAttempts, '3 把');
  assert.equal(afterUndo.summaryAttempts, 3);
  assert.equal(afterUndo.summaryRoutes, 2);
  assert.equal(afterUndo.rowAAttempts, 2);
  assert.equal(afterUndo.rowALatestNote, '第二把备注', '最近有效备注跳过已撤回的那一句');
  assert.equal(afterUndo.wishlistAttempts, 2);
  assert.equal(afterUndo.wishlistNote, '第二把备注');
  assert.equal(afterUndo.statsAttempts, 3);
  assert.equal(afterUndo.routeDetailAttempts, 2);
  assert.equal(afterUndo.listCountText, '1 天 · 1 场 · 2 把');

  // 3) 恢复同一把：全部读数回到撤回前，原 ID、原序号与原备注都在。
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  const afterRestore = readings();
  assert.equal(afterRestore.homeAttempts, before.homeAttempts);
  assert.equal(afterRestore.summaryAttempts, before.summaryAttempts);
  assert.equal(afterRestore.rowAAttempts, before.rowAAttempts);
  assert.equal(afterRestore.rowALatestNote, before.rowALatestNote);
  assert.equal(afterRestore.wishlistAttempts, before.wishlistAttempts);
  assert.equal(afterRestore.statsAttempts, before.statsAttempts);
  assert.equal(afterRestore.routeDetailAttempts, before.routeDetailAttempts);
  assert.equal(afterRestore.listCountText, before.listCountText);

  const restored = savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId);
  assert.equal(restored.id, thirdId, '恢复拿回的是原来那一把');
  assert.equal(restored.seq, originalThird.seq);
  assert.equal(restored.note, '第三把备注');
  assert.equal(restored.result, 'fail');
  assert.equal(restored.createdAt, originalThird.createdAt);
  assert.equal(restored.undoneAt, undefined);

  // 照片按线路关联、备注按原把关联：撤回与恢复只动训练档案键。
  assert.equal(storage.get(PHOTO_KEY), photoBlob, '照片索引保持原字节');
  assert.equal(
    savedAttempts(flow.sessionId, flow.aId).filter(item => item.undoneAt).length,
    0,
    '恢复后这条线没有残留的撤回标记'
  );
  assert.equal(archiveOf().attempts.length, 4, '全流程只新增、不删除把次');
  assert.equal(storage.get(WISHLIST_KEY).includes(flow.aId), true, '想爬清单仍指向原线路 ID');
});


// ------------------------------------------------------------------ *
// T030–T033 返工：稳定原序号、过期事件与换档后的迟到重试
// ------------------------------------------------------------------ *

test('T033 撤回第 3 把后再记一把：新一把是第 4 把，原第 3 把不挪号（场内行与线路历史一致）', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);
  assert.equal(page.data.recentAttempt.expectedRev, 0, '还没动过的这一把版本是 0');

  // 记第 4 把前先撤回第 3 把：撤回的那一把照样占着原序号。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCountText, '2 把');
  recordThroughPage(page, 'fail');
  const fourth = attemptsOf(page).at(-1);
  assert.notEqual(fourth.id, thirdId);
  assert.equal(page.data.routeCountText, '3 把', '有效把数是第 1、2 与新的第 4 把，被撤回的第 3 把不算');

  // 场内「最近一把」与逐把列表都按稳定原序号标号：第 4 把不会被撤回挤成第 3 把。
  assert.equal(page.data.recentAttempt.attemptId, fourth.id);
  assert.equal(page.data.recentAttempt.titleText, '刚才 · A 线 第 4 把 · 未完成');
  assert.equal(page.data.attempts.at(-1).label, '第 4 把');

  // 跨日线路历史用同一份标号：第 4 把仍是第 4 把，原第 3 把的号也不动。
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ routeId: flow.aId });
  const group = routePage.data.groups.find(item => item.sessionId === flow.sessionId);
  const labels = Object.fromEntries(group.attempts.map(item => [item.id, item.label]));
  assert.equal(labels[fourth.id], '第 4 把');
  assert.equal(labels[thirdId], undefined, '已撤回的第 3 把不进有效历史');
  assert.equal(group.attempts.length, 3, '历史只列有效把次（第 1、2、4 把）');
  assert.deepEqual(
    group.attempts.map(item => item.label),
    ['第 1 把', '第 2 把', '第 4 把'],
    '序号是稳定原序号，不拿可见下标当编号'
  );
});

test('T033 旧撤回/恢复事件在 3→2→3 之后才送到：按渲染时的版本拒绝，把数与档案都不动', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);

  // 渲染时的这一份点击参数（版本 0）：它一直没送到，用户先完成了完整的 3→2→3。
  const undeliveredRow = page.data.recentAttempt;
  assert.equal(undeliveredRow.expectedRev, 0);

  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCountText, '2 把');
  const cold = openRecordPage();
  assert.equal(cold.data.selectedRoute.id, flow.aId);
  cold.restoreLatestAttempt(rowEvent(cold.data.recentAttempt));
  assert.equal(cold.data.routeCountText, '3 把');
  assert.equal(cold.data.recentAttempt.expectedRev, 2, '撤回、恢复各让版本加一');

  // 迟到的旧撤回（版本 0）现在才到：状态看起来又变回「有效」，只比状态挡不住，版本能挡。
  const before = storage.get(ARCHIVE_KEY);
  cold.undoLatestAttempt(rowEvent(undeliveredRow));
  assert.equal(storage.get(ARCHIVE_KEY), before, '过期事件一个字都不写');
  assert.equal(cold.data.routeCountText, '3 把', '把数不回退成 2');
  assert.match(cold.data.notice, /状态已经变了|最新档案/);

  // 反向：先撤回（版本 3），再重放当时那一份「恢复」事件（版本 1）也不生效。
  cold.undoLatestAttempt(rowEvent(cold.data.recentAttempt));
  assert.equal(cold.data.routeCountText, '2 把');
  const beforeAgain = storage.get(ARCHIVE_KEY);
  cold.restoreLatestAttempt(rowEvent({ ...undeliveredRow, expected: 'undone', expectedRev: 1 }));
  assert.equal(storage.get(ARCHIVE_KEY), beforeAgain, '过期的恢复事件也不写盘');
  assert.equal(cold.data.routeCountText, '2 把');
  assert.notEqual(
    savedAttempts(flow.sessionId, flow.aId).find(item => item.id === thirdId).undoneAt,
    undefined,
    '已撤回的那一把没有被旧的恢复事件复活'
  );
});

test('T033 换档后的迟到点击：渲染时的档案 ID 与当前档案不符时整条不落盘', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  switchTo(page, flow.aId);
  const staleRow = page.data.recentAttempt;

  // 另一份本机档案（同一账号换档、或另一台设备）与原档同名 ID：整份替换。
  const twin = JSON.parse(storage.get(ARCHIVE_KEY));
  twin.archiveId = 'archive-of-another-profile';
  twin.attempts.find(item => item.id === staleRow.attemptId).note = '另一份档案自己的备注';
  const twinBytes = JSON.stringify(twin);
  storage.set(ARCHIVE_KEY, twinBytes);

  page.undoLatestAttempt(rowEvent(staleRow));
  assert.equal(storage.get(ARCHIVE_KEY), twinBytes, '换档后的迟到点击不改新档案');
  const replaced = JSON.parse(storage.get(ARCHIVE_KEY)).attempts.find(
    item => item.id === staleRow.attemptId
  );
  assert.equal(replaced.undoneAt, undefined, '新档案里这一把没有被撤回');
  assert.equal(replaced.note, '另一份档案自己的备注', '新档案里的备注也没被改写');
  assert.match(page.data.notice, /原来的本机档案/);
});

test('T033 切到 B 之后旧 A 那一行的点击不改任何一把、也不改归属', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  switchTo(page, flow.aId);
  const staleARow = page.data.recentAttempt;
  assert.equal(staleARow.routeId, flow.aId);

  switchTo(page, flow.bId);
  recordThroughPage(page, 'fail');
  const bBefore = JSON.stringify(savedAttempts(flow.sessionId, flow.bId));
  const aBefore = JSON.stringify(savedAttempts(flow.sessionId, flow.aId));
  const bytesBefore = storage.get(ARCHIVE_KEY);

  page.undoLatestAttempt(rowEvent(staleARow));
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '旧 A 事件不写盘');
  assert.equal(JSON.stringify(savedAttempts(flow.sessionId, flow.bId)), bBefore, 'B 这一把不动');
  assert.equal(JSON.stringify(savedAttempts(flow.sessionId, flow.aId)), aBefore, 'A 那一把也不被改');
  assert.equal(page.data.selectedRoute.id, flow.bId, '归属仍是 B');
  assert.equal(page.data.recentAttempt.attemptId, attemptsOf(page).at(-1).id);
  assert.match(page.data.notice, /切到别的场次或线路/);
});

test('T033 待保存的一把绑定发起时的档案：换档之后重试不写进新档案', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  switchTo(page, flow.aId);
  tick();

  // 第一次写就失败：这一把没落盘，留在「待保存」行里，操作 ID 记在页面实例上。
  armSetFailAt(1);
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.equal(page.data.pendingRows.length, 1);
  const opId = page.data.pendingRows[0].opId;

  const twin = JSON.parse(storage.get(ARCHIVE_KEY));
  twin.archiveId = 'archive-of-another-profile';
  const twinBytes = JSON.stringify(twin);
  storage.set(ARCHIVE_KEY, twinBytes);

  page.retryPendingAttempt(tapDataset({ opId }));
  assert.equal(storage.get(ARCHIVE_KEY), twinBytes, '换档后的重试不改新档案');
  assert.equal(
    JSON.parse(storage.get(ARCHIVE_KEY)).attempts.filter(item => item.id === opId).length,
    0,
    '这一把没有被写进新档案'
  );
  assert.match(page.data.notice, /原来的本机档案/);
});

test('T033 复验 切到同日另一场（当前选择被清空）时不冒出别的把次，选回原线后撤回目标仍是原把次', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdAttemptId = flow.aAttempts[2];

  // A 的最近一把仍是第 3 把，撤回目标就是它。
  switchTo(page, flow.aId);
  assert.equal(page.data.recentAttempt.attemptId, thirdAttemptId);
  assert.equal(page.data.recentAttempt.canUndo, true);

  // 同日另开一场（走真实「开始新场次」入口），再点回原来的场次：
  // selectSession 只改归属，当前选择被清空，但本场线路仍在列表里。
  const other = startSessionOnSameDay(flow.sessionPage, '石间岩馆');
  assert.notEqual(other, flow.sessionId);
  flow.sessionPage.switchSession(tapDataset({ sessionId: flow.sessionId }));
  assert.equal(flow.sessionPage.data.activeSession.id, flow.sessionId);
  assert.equal(flow.sessionPage.data.selectedRoute, null, '切场次只改归属：当前选择被清空');
  assert.ok(flow.sessionPage.data.routes.length >= 2, '本场线路还在列表里，不必重新加线');
  assert.equal(
    flow.sessionPage.data.recentAttempt,
    undefined,
    '列表页不再内联「最近一把」，不拿别的场次/别的线的把次来占位'
  );

  // 从列表重开原线：撤回/恢复的目标仍是原来那一把，序号与结果都没变。
  switchTo(page, flow.aId);
  assert.equal(page.data.recentAttempt.attemptId, thirdAttemptId);
  assert.equal(page.data.recentAttempt.canUndo, true);
  assert.equal(page.data.routeCountText, '3 把');

  // 撤回后恢复目标还在同一把上。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.recentAttempt.attemptId, thirdAttemptId);
  assert.equal(page.data.recentAttempt.canRestore, true);
  assert.equal(page.data.recentAttempt.canUndo, false);
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.recentAttempt.attemptId, thirdAttemptId);
  assert.equal(page.data.recentAttempt.canUndo, true);
  assert.equal(page.data.recentAttempt.titleText, '刚才 · A 线 第 3 把 · 未完成');
});

/** 同日另开一场（走页面上的「开始新场次」入口），返回新场次 ID。 */
function startSessionOnSameDay(page, gymName) {
  page.openSessionForm();
  page.onGymNameInput({ detail: { value: gymName } });
  page.startSession();
  assert.equal(page.data.storageError, '');
  return page.data.activeSession.id;
}

// ------------------------------------------------------------------ *
// T036 归属核对、逐把明细与唯一写实现
// ------------------------------------------------------------------ *

test('T036 单线页与明细页按档案/场次/线路核对归属：缺参、串档与不属于本场都不写档', () => {
  const first = store.startSession({ gymName: '归属岩馆', date: '2026-11-08' });
  assert.equal(first.ok, true, first.error);
  const routeA = store.createRoute({
    sessionId: first.session.id,
    name: '同名线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(routeA.ok, true, routeA.error);
  const second = store.startSession({ gymName: '归属岩馆', date: '2026-11-09' });
  assert.equal(second.ok, true, second.error);
  const routeB = store.createRoute({
    sessionId: second.archive.activeSessionId,
    name: '同名线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(routeB.ok, true, routeB.error);

  const archive = archiveOf();
  assert.notEqual(routeA.route.id, routeB.route.id, '两场两条同名同级线按长期 ID 区分');
  const bytesBefore = storage.get(ARCHIVE_KEY);

  const openWith = (definition, query) => {
    const page = createPage(definition);
    page.onLoad(query);
    return page;
  };

  // 缺线路参数：两个页面都只给可见原因，不展示别场别线的把次。
  const missingRoute = openWith(recordDefinition, {
    archiveId: archive.archiveId,
    sessionId: first.session.id,
    routeId: ''
  });
  assert.match(missingRoute.data.contextError, /缺少线路参数/);
  missingRoute.recordAttempt(tapDataset({ result: 'fail' }));
  const missingAttempts = openWith(attemptsDefinition, {
    archiveId: archive.archiveId,
    sessionId: first.session.id,
    routeId: ''
  });
  assert.match(missingAttempts.data.contextError, /缺少线路参数/);
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '缺参入口不写盘');

  // 串档：入口记下的档案 ID 与当前档案不同，不拿同名场次/线路顶替。
  const mismatched = openWith(recordDefinition, {
    archiveId: 'archive-of-another-profile',
    sessionId: first.session.id,
    routeId: routeA.route.id
  });
  assert.match(mismatched.data.contextError, /另一份本机档案/);
  mismatched.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '串档入口不写盘');

  // 线路不属于这一场：A 的线不能挂到第二场下面，B 的线也不能拿第一场的历史。
  const notLinked = openWith(attemptsDefinition, {
    archiveId: archive.archiveId,
    sessionId: second.archive.activeSessionId,
    routeId: routeA.route.id
  });
  assert.match(notLinked.data.contextError, /不属于这一场/);
  const notLinkedRecord = openWith(recordDefinition, {
    archiveId: archive.archiveId,
    sessionId: first.session.id,
    routeId: routeB.route.id
  });
  assert.match(notLinkedRecord.data.contextError, /不属于这一场/);

  // 场次或线路已不在档案里：原因可区分，且不写盘。
  const missingSession = openWith(recordDefinition, {
    archiveId: archive.archiveId,
    sessionId: 'session-does-not-exist',
    routeId: routeA.route.id
  });
  assert.match(missingSession.data.contextError, /这一场已经不在本机档案里/);
  const missingRouteEntity = openWith(recordDefinition, {
    archiveId: archive.archiveId,
    sessionId: first.session.id,
    routeId: 'route-does-not-exist'
  });
  assert.match(missingRouteEntity.data.contextError, /这条线路已经不在本机档案里/);
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '失效入口全程不写盘');

  // 旧详情直达仍可用：同一长期 routeId 的资料页照常读到原线。
  const profile = createPage(routeDefinition);
  profile.onLoad({ routeId: routeA.route.id });
  assert.equal(profile.data.notFound, false);
  assert.equal(profile.data.route.name, '同名线');
});

test('T036 逐把明细只列本场该线；保存、取消与失败重试都只指向原 attemptId', () => {
  const started = store.startSession({ gymName: '明细岩馆', date: '2026-11-08' });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const a = store.createRoute({
    sessionId,
    name: '同名线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  const b = store.createRoute({
    sessionId,
    name: '同名线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);

  const savedA = ['fail', 'fail', 'fail'].map((result, index) => {
    const saved = store.saveAttempt({
      sessionId,
      routeId: a.route.id,
      result,
      now: new Date(2026, 10, 8, 9, 0 + index)
    });
    assert.equal(saved.ok, true, saved.error);
    return saved.attempt;
  });
  const savedB = store.saveAttempt({
    sessionId,
    routeId: b.route.id,
    result: 'send'
  });
  assert.equal(savedB.ok, true, savedB.error);

  const page = openAttemptsFor(sessionId, a.route.id);
  assert.deepEqual(page.data.attempts.map(row => row.id), savedA.map(item => item.id));
  assert.deepEqual(page.data.attempts.map(row => row.label), ['第 1 把', '第 2 把', '第 3 把']);
  assert.equal(
    page.data.attempts.some(row => row.id === savedB.attempt.id),
    false,
    '同场另一条线的把次不出现在这一条的明细里'
  );

  // 取消不写盘：输入的字不留、原备注也不动。
  const bytesBefore = storage.get(ARCHIVE_KEY);
  page.openNoteEditor(tapDataset({ attemptId: savedA[1].id }));
  page.onNoteInput({ detail: { value: '取消掉这一句' } });
  page.cancelNote();
  assert.equal(page.data.noteEditor, null);
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '取消备注不写盘');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId, routeId: a.route.id }).find(
      item => item.id === savedA[1].id
    ).note,
    ''
  );

  // 保存失败：写明未保存、保留同一把的编辑与原输入，可原地重试。
  page.openNoteEditor(tapDataset({ attemptId: savedA[1].id }));
  page.onNoteInput({ detail: { value: '第二把备注' } });
  armSetFailAt(1);
  page.saveNote();
  armSetFailAt(0);
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.match(page.data.notice, /备注未保存/);
  assert.equal(page.data.noteEditor.attemptId, savedA[1].id, '失败后仍指向原来那一把');
  assert.equal(page.data.noteEditor.text, '第二把备注', '输入没有丢');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId, routeId: a.route.id }).find(
      item => item.id === savedA[1].id
    ).note,
    '',
    '失败不报已保存'
  );

  // 重试成功：只改这一把，其他两把与同场另一条线都不动。
  page.saveNote();
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  const after = store.attemptsFor(archiveOf(), { sessionId, routeId: a.route.id });
  assert.equal(after.find(item => item.id === savedA[1].id).note, '第二把备注');
  assert.equal(after.find(item => item.id === savedA[0].id).note, '');
  assert.equal(after.find(item => item.id === savedA[2].id).note, '');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId, routeId: b.route.id })[0].note,
    '',
    '同场另一条线的把次不被串改'
  );

  // 重开明细：按原 attemptId 读回同一句备注，仍只列这三把。
  const reopened = openAttemptsFor(sessionId, a.route.id);
  assert.deepEqual(reopened.data.attempts.map(row => row.id), savedA.map(item => item.id));
  assert.equal(reopened.data.attempts[1].note, '第二把备注');

  // 换档后的迟到保存：编辑器打开时记下了原档案 ID，盘上换成另一份档案后不写进去。
  const originalRaw = storage.get(ARCHIVE_KEY);
  reopened.openNoteEditor(tapDataset({ attemptId: savedA[2].id }));
  reopened.onNoteInput({ detail: { value: '不属于新档案的备注' } });
  const twin = JSON.parse(originalRaw);
  twin.archiveId = 'archive-of-another-profile';
  const twinRaw = JSON.stringify(twin);
  storage.set(ARCHIVE_KEY, twinRaw);
  reopened.saveNote();
  assert.match(reopened.data.notice, /原来的本机档案/);
  assert.equal(storage.get(ARCHIVE_KEY), twinRaw, '换档后的迟到保存不写新档案');
  storage.set(ARCHIVE_KEY, originalRaw);
});

test('T036 新增两页只注册一次，写入仍只有 training-record-actions 一份实现', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  for (const pagePath of [
    'pages/training-record/training-record',
    'pages/training-attempts/training-attempts'
  ]) {
    assert.equal(appJson.pages.filter(item => item === pagePath).length, 1, pagePath + ' 只注册一次');
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      assert.ok(fs.existsSync(path.join(ROOT, pagePath + ext)), '缺少 ' + pagePath + ext);
    }
  }
  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ],
    'tabBar 与图标保持原样'
  );

  const recordSource = fs.readFileSync(RECORD_JS, 'utf8');
  const attemptsSource = fs.readFileSync(ATTEMPTS_JS, 'utf8');
  const routeSource = fs.readFileSync(ROUTE_JS, 'utf8');
  const actionsSource = fs.readFileSync(
    path.join(ROOT, 'utils', 'training-record-actions.js'),
    'utf8'
  );
  assert.match(recordSource, /utils\/training-record-actions/);
  assert.match(attemptsSource, /utils\/training-record-actions/);
  assert.match(routeSource, /utils\/training-record-actions/);
  // 页面不再各自实现写入：写调用只在共用的页面事件模块里出现一次。
  for (const source of [recordSource, attemptsSource, routeSource]) {
    assert.doesNotMatch(source, /store\.(saveAttempt|undoAttempt|restoreAttempt|correctAttempt|setAttemptNote)\s*\(/);
    assert.doesNotMatch(source, /wx\.cloud/);
  }
  // 五个写入口只在共用模块里出现；页面源码里一个都没有（上面的 doesNotMatch 已核对）。
  for (const call of [
    'store.saveAttempt',
    'store.undoAttempt',
    'store.restoreAttempt',
    'store.correctAttempt',
    'store.setAttemptNote'
  ]) {
    assert.equal(actionsSource.includes(call), true, call + ' 应在共用模块里');
  }
});
