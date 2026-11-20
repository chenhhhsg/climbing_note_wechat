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
const ATTEMPTS_WXML = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.wxml');
const ATTEMPTS_WXSS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.wxss');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const LIST_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const SUMMARY_PAGE_JS = path.join(ROOT, 'pages', 'training-summary', 'training-summary.js');
const STATS_JS = path.join(ROOT, 'pages', 'stats', 'stats.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const WISHLIST_KEY = 'climbingNote.training.v1.wishlist';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';

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

const wxLog = { navigations: [], switches: [], toasts: [], backs: [], redirects: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.toasts = [];
  wxLog.backs = [];
  wxLog.redirects = [];
}

// 更正确认弹窗（T042）：默认立刻「确认」；队列里可指定 cancel，用来核对取消不写盘。
const modalLog = { calls: [], queue: [] };

function resetModalLog() {
  modalLog.calls = [];
  modalLog.queue = [];
}

function queueModal(behavior) {
  modalLog.queue.push(behavior);
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
  // 返回与回退落点（T046）：正常路径退回上一页；没有上一页时按入口重建落点。
  navigateBack(options) {
    wxLog.backs.push(options || {});
  },
  redirectTo(options) {
    wxLog.redirects.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  showModal(options) {
    modalLog.calls.push(options);
    const behavior = modalLog.queue.length > 0 ? modalLog.queue.shift() : 'confirm';
    options.success({ confirm: behavior === 'confirm', cancel: behavior !== 'confirm' });
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
const summaryPageDefinition = capturePage(SUMMARY_PAGE_JS);
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
  resetModalLog();
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

test('T050 按钮位置可核：最新一把右侧直接给「撤销」，现场无纠错菜单与恢复按钮', () => {
  // T036：结果、最近一把与撤回/恢复都在单线记录页；场内页只留本场线路列表入口。
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');

  const resultSend = wxml.indexOf('class="result-button result-send"');
  const attemptsStart = wxml.indexOf('id="record-attempts"');
  assert.ok(resultSend !== -1 && attemptsStart !== -1, '单线页有结果按钮与本场本线把次');
  assert.ok(resultSend < attemptsStart, '本场本线把次在结果按钮之后');
  assert.equal(wxml.indexOf('id="record-links"'), -1, '现场入口区已移除');

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

  // T050 返工：最新一把右侧只有一个文字「撤销」，按一下直接撤回这一把；现场没有第二个
  // 菜单，也没有「改为未完成」或撤销后的「恢复」按钮。它带齐原把次 ID、归属、原档案 ID、
  // 预期状态与版本，写入仍走共用实现。
  assert.match(
    wxml,
    /id="record-attempt-withdraw-\{\{item\.id\}\}"[\s\S]{0,600}catchtap="undoLatestAttempt"/,
    '最新一把右侧有直接的「撤销」'
  );
  assert.match(
    wxml,
    /id="record-attempt-withdraw-\{\{item\.id\}\}"[\s\S]{0,600}data-expected-rev="\{\{item\.expectedRev\}\}"[\s\S]{0,80}catchtap="undoLatestAttempt"/,
    '撤销带预期的状态版本，过期的点击不落盘'
  );
  assert.doesNotMatch(wxml, /record-attempt-more|toggleLatestMenu/, '现场不再有「更多」菜单');
  assert.doesNotMatch(wxml, /correct-attempt-|bindtap="correctSend"/, '现场不再有更正入口');
  assert.doesNotMatch(
    wxml,
    /restore-attempt-|bindtap="restoreLatestAttempt"/,
    '现场不再有撤销后的「恢复」按钮'
  );
  assert.doesNotMatch(
    wxml,
    /record-attempt-correct-slot|record-attempt-hint-slot|record-attempt-menu-item/,
    '现场不再留纠错槽或菜单项'
  );
  // 最新与旧把统一走同一个「备注」入口。
  assert.match(wxml, /catchtap="openNoteEditor"[\s\S]{0,80}\{\{item\.noteActionText\}\} ›/);

  // 「撤销」本身有 44×44 的最小命中区，且在普通文档流里，不与整行展开/视频入口抢坐标。
  assert.equal(minHeightOf(wxss, '.record-attempt-withdraw'), '44px', '「撤销」44px 命中区');
  assert.match(declarationsOf(wxss, '.record-attempt-withdraw'), /min-width:\s*44px/);
  assert.equal(
    /record-attempt-more|record-attempt-menu-item|record-attempt-change|record-attempt-correct/.test(wxss),
    false,
    '菜单、更正与恢复样式已移除'
  );

  const handlers = new Set(handlersIn(wxml));
  for (const required of [
    'recordAttempt',
    'retryPendingAttempt',
    'undoLatestAttempt',
    'openNoteEditor',
    'openAttemptVideo',
    'saveNote',
    'cancelNote'
  ]) {
    assert.ok(handlers.has(required), '单线页应绑定：' + required);
    assert.equal(typeof recordDefinition[required], 'function', required + ' 必须有页面方法');
  }
  // T042/T045：单线页不再有独立更正区或行内更正入口；确认接线仍与线路历史/本场逐把
  // 共用同一份 correctSend 实现（现场不渲染）。
  assert.equal(wxml.indexOf('id="route-correction"'), -1, '单线页不再有独立更正区');
  assert.equal(typeof recordDefinition.correctSend, 'function', 'correctSend 确认入口仍存在');

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
  // T050 返工：本页已成功撤销过的原按钮重放不再进共用实现，保留「已撤销第 3 把」。
  assert.match(page.data.notice, /已撤销第 3 把/);
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
    // T043：记录 tab 按原场次一行，读数取同一份只读小结计数。
    const listRow = (listPage.data.sessionDays || [])
      .flatMap(day => (day.gyms || []).flatMap(gym => gym.sessions || []))
      .find(item => item.id === flow.sessionId);
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
      listCountText: listRow && listRow.summaryText
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
  assert.equal(before.listCountText, '2 条线 · 4 把');

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
  assert.equal(afterUndo.listCountText, '2 条线 · 3 把');

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
// T030–T033 返工：有效把次连续显示编号、过期事件与换档后的迟到重试
// ------------------------------------------------------------------ *

test('T033 撤回第 3 把后再记一把：新一把是第 3 把，现场与线路历史连续编号（显示号不吃撤回占位）', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];
  switchTo(page, flow.aId);
  assert.equal(page.data.recentAttempt.expectedRev, 0, '还没动过的这一把版本是 0');

  // 记新一把前先撤回第 3 把：撤回只去掉这一把的有效计数，不再占一个显示号。
  page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCountText, '2 把');
  recordThroughPage(page, 'fail');
  const fourth = attemptsOf(page).at(-1);
  assert.notEqual(fourth.id, thirdId);
  assert.equal(page.data.routeCountText, '3 把', '有效把数是第 1、2 与新的第 3 把，被撤回的那一把不算');

  // 现场「最近一把」与逐把列表都按有效把次顺序标号：新一把显示第 3 把。
  assert.equal(page.data.recentAttempt.attemptId, fourth.id);
  assert.equal(page.data.recentAttempt.titleText, '刚才 · A 线 第 3 把 · 未完成');
  assert.equal(page.data.attempts.at(-1).label, '第 3 把');

  // 跨日线路历史用同一份标号：有效三把连续编号，不跳号。
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ routeId: flow.aId });
  const group = routePage.data.groups.find(item => item.sessionId === flow.sessionId);
  const labels = Object.fromEntries(group.attempts.map(item => [item.id, item.label]));
  assert.equal(labels[fourth.id], '第 3 把');
  assert.equal(labels[thirdId], undefined, '已撤回的那一把不进有效历史');
  assert.equal(group.attempts.length, 3, '历史只列有效把次（第 1、2、新第 3 把）');
  assert.deepEqual(
    group.attempts.map(item => item.label),
    ['第 1 把', '第 2 把', '第 3 把'],
    '显示号按有效顺序连续，不拿撤回占位或可见下标当编号'
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

test('T042 本场逐把：较早的完攀在自己那一行更正结果，取消不写、确认只改这一把', async () => {
  const started = store.startSession({
    gymName: '逐把岩馆',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 9, 0)
  });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const created = store.createRoute({
    sessionId,
    name: '逐把抱石线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;

  const send = store.saveAttempt({
    sessionId,
    routeId,
    result: 'send',
    note: '第一把完攀备注',
    now: new Date(2026, 10, 8, 9, 5)
  });
  assert.equal(send.ok, true, send.error);

  // 两把夹具：完攀之后还有一把（旧版本/导入档案里真实存在的形状），较早的完攀仍是有效把次。
  const raw = JSON.parse(storage.get(ARCHIVE_KEY));
  raw.attempts.push({
    id: 'attempt-later-fail',
    seq: 2,
    sessionId,
    routeId,
    result: 'fail',
    note: '',
    createdAt: '2026-11-08T09:10:00.000Z'
  });
  raw.nextAttemptSeq = 3;
  storage.set(ARCHIVE_KEY, JSON.stringify(raw));

  // 这一把的本机视频关联（只读夹具）：更正前后必须原样保留。
  const archiveId = archiveOf().archiveId;
  const clip = {
    archiveId,
    attemptId: send.attempt.id,
    sessionId,
    routeId,
    clipId: 'clip-t042',
    fileId: 'attempt-video/v1/' + archiveId + '/clip-t042.mp4',
    rev: 1
  };
  storage.set(VIDEO_INDEX_KEY, JSON.stringify({ clips: [clip] }));

  const page = openAttemptsFor(sessionId, routeId);
  assert.deepEqual(page.data.attempts.map(item => item.id), [send.attempt.id, 'attempt-later-fail']);
  assert.equal(page.data.attempts[0].correctable, true, '较早的完攀在自己那一行可更正');
  assert.equal(page.data.attempts[0].correctText, '更正结果');
  assert.equal(page.data.attempts[1].correctable, false, '最近一把是未完成，没有更正入口');
  assert.equal(page.data.attempts[0].hasVideo, true, '视频关联读的是原把次');

  // 取消：确认里能认出原把次与预期结果，一个字节都不写。
  const archiveBeforeCancel = storage.get(ARCHIVE_KEY);
  queueModal('cancel');
  assert.equal(await page.confirmCorrectRow(tapDataset({ attemptId: send.attempt.id })), null);
  const prompt = modalLog.calls.at(-1);
  assert.match(prompt.content, /第 1 把/, '确认里写明原把次');
  assert.match(prompt.content, /完攀/, '确认里写明原结果');
  assert.match(prompt.content, /未完成/, '确认里写明将要改成的结果');
  assert.match(prompt.content, /2026-11-08/, '确认里写明原场次日期');
  assert.match(prompt.content, /逐把岩馆/, '确认里写明原岩馆');
  assert.equal(storage.get(ARCHIVE_KEY), archiveBeforeCancel, '取消不写盘');
  assert.equal(page.data.attempts[0].correctable, true, '取消后入口还在原位');

  // 归属不符的旧点击（伪造线路 / 另一场次）：不弹确认、不写盘。
  resetModalLog();
  const writesBeforeStale = fault.setCount;
  await page.confirmCorrectRow(
    tapDataset({ attemptId: send.attempt.id, routeId: 'route-999' })
  );
  assert.equal(modalLog.calls.length, 0, '线路对不上就不弹确认');
  assert.match(page.data.notice, /没有改动任何记录/);
  await page.confirmCorrectRow(
    tapDataset({ attemptId: send.attempt.id, sessionId: 'session-of-other' })
  );
  assert.equal(modalLog.calls.length, 0, '场次对不上也不弹确认');
  assert.equal(fault.setCount, writesBeforeStale, '旧点击不写盘');

  // 确认：只翻这一把的结果；原 ID、序号、备注、视频关联与另一把都不动。
  const before = archiveOf().attempts.find(item => item.id === send.attempt.id);
  const videoBefore = storage.get(VIDEO_INDEX_KEY);
  await page.confirmCorrectRow(tapDataset({ attemptId: send.attempt.id }));
  const after = archiveOf();
  assert.equal(after.attempts.length, 2, '更正不增把数');
  const corrected = after.attempts.find(item => item.id === send.attempt.id);
  assert.equal(corrected.result, 'fail');
  assert.equal(corrected.seq, before.seq, '原序号不变');
  assert.equal(corrected.createdAt, before.createdAt, '原时间不变');
  assert.equal(corrected.note, '第一把完攀备注', '原备注不变');
  assert.equal(
    store.attemptsFor(after, { sessionId, routeId }).length,
    2,
    '有效把数仍为两把'
  );
  assert.equal(store.routeCompletion(after, routeId).sendCount, 0, '完攀数减一');
  assert.equal(
    after.attempts.find(item => item.id === 'attempt-later-fail').result,
    'fail',
    '另一把不被串改'
  );
  assert.equal(storage.get(VIDEO_INDEX_KEY), videoBefore, '视频索引与本机副本标识逐字节不变');
  assert.equal(page.data.attempts[0].resultText, '未完成');
  assert.match(page.data.attempts[0].correctStatusText, /已改为未完成/);
  assert.equal(page.data.attempts[0].hasVideo, true, '更正后仍从原把次进入视频');
});

test('T042 本场逐把的更正写失败保留同一把的重试入口，重试只改这一把', async () => {
  const started = store.startSession({ gymName: '重试岩馆', date: '2026-11-08' });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const created = store.createRoute({
    sessionId,
    name: '重试抱石线',
    climbType: '抱石',
    grade: 'V4',
    colorName: '红色'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;
  const send = store.saveAttempt({ sessionId, routeId, result: 'send', note: '重试前备注' });
  assert.equal(send.ok, true, send.error);
  const other = store.createRoute({
    sessionId,
    name: '另一条线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色'
  });
  assert.equal(other.ok, true, other.error);
  const otherSaved = store.saveAttempt({
    sessionId,
    routeId: other.route.id,
    result: 'fail',
    note: '另一条线备注'
  });
  assert.equal(otherSaved.ok, true, otherSaved.error);

  const page = openAttemptsFor(sessionId, routeId);
  assert.equal(page.data.attempts[0].correctable, true);

  // 第一段写就失败：不报已保存，按钮改成同一把的重试文案。
  armSetFailAt(1);
  await page.confirmCorrectRow(tapDataset({ attemptId: send.attempt.id }));
  armSetFailAt(0);
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.match(page.data.notice, /更正未保存/);
  assert.equal(page.data.attempts[0].correctable, true, '仍是同一把可更正');
  assert.equal(page.data.attempts[0].correctText, '重试更正结果');
  assert.equal(
    archiveOf().attempts.find(item => item.id === send.attempt.id).result,
    'send',
    '失败不报已保存'
  );

  // 重试：只翻这一把，另一条线的把次与原备注都不动。
  await page.confirmCorrectRow(tapDataset({ attemptId: send.attempt.id }));
  const after = archiveOf();
  assert.equal(after.attempts.find(item => item.id === send.attempt.id).result, 'fail');
  assert.equal(after.attempts.find(item => item.id === send.attempt.id).note, '重试前备注');
  assert.equal(after.attempts.length, 2, '更正不增把数');
  assert.equal(
    after.attempts.find(item => item.id === otherSaved.attempt.id).note,
    '另一条线备注',
    '同场另一条线的把次不被串改'
  );
  assert.equal(page.data.storageError, '');
});

test('T042/T045 可见称呼：本场逐把页标题保留，单线页把次直接同页显示', () => {
  const attemptsJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.json'), 'utf8')
  );
  assert.equal(attemptsJson.navigationBarTitleText, '本场逐把');
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  // T045：现场不再有独立跳转，把次直接在同页列出；可见标题就是「本场逐把」，
  // 与逐把页同一称呼。断言只匹配可见文本节点，不靠注释里的旧说法通过。
  assert.equal(recordWxml.indexOf('id="open-attempts"'), -1, '现场没有独立逐把跳转');
  const attemptsTitle = recordWxml.match(
    /<text class="record-attempts-title">([^<]*)<\/text>/
  );
  assert.ok(attemptsTitle, '现场有可见的把次区标题节点');
  assert.equal(attemptsTitle[1], '本场逐把', '现场把次区可见标题为「本场逐把」');
  assert.match(
    recordWxml,
    /id="edit-note-\{\{item\.id\}\}"[\s\S]{0,400}catchtap="openNoteEditor"[\s\S]{0,120}\{\{item\.noteActionText\}\} ›/,
    '每个有效把次进入同一编辑函数；最新与旧把统一写「备注」'
  );
  assert.doesNotMatch(recordWxml, /编辑 ›/, '现场不再用「编辑」称呼');
  assert.doesNotMatch(recordWxml, /补备注|改备注/, '较早把次不再区分补/改备注');
  assert.doesNotMatch(recordWxml, /逐把明细/, '单线页不再用旧称呼');
  assert.doesNotMatch(recordWxml, /点错了完攀/, '单线页不再有独立更正区');
  const attemptsWxml = fs.readFileSync(ATTEMPTS_WXML, 'utf8');
  assert.doesNotMatch(attemptsWxml, /逐把明细/, '本场逐把页不再用旧称呼');
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

// ------------------------------------------------------------------ *
// T034–T037 独立 QA 返工：事件归属与迟到按钮
// ------------------------------------------------------------------ *

test('T037 返工 原 A 档同 opId 的重试事件不能提交 B 档 pendingSaves', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = openRecordFor(flow.aId, flow.sessionId);
  tick();

  // 第一段「进行中」标记落盘、第二段提交失败：A 档留下带原 opId 的待保存记录。
  armSetFailAt(2);
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.equal(page.data.pendingRows.length, 1);
  const row = page.data.pendingRows[0];
  assert.equal(row.archiveId, archiveOf().archiveId);
  assert.equal(row.sessionId, flow.sessionId);
  assert.equal(row.routeId, flow.aId);

  // 真实重试按钮的 dataset 必须带齐档案与归属（与 WXML 一致）。
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  assert.match(
    wxml,
    /id="retry-\{\{item\.opId\}\}"[\s\S]{0,260}data-archive-id="\{\{item\.archiveId\}\}"[\s\S]{0,160}data-session-id="\{\{item\.sessionId\}\}"[\s\S]{0,160}data-route-id="\{\{item\.routeId\}\}"[\s\S]{0,160}data-op-id="\{\{item\.opId\}\}"[\s\S]{0,100}bindtap="retryPendingAttempt"/
  );

  const aArchive = JSON.parse(storage.get(ARCHIVE_KEY));
  assert.ok(aArchive.pendingSaves.some(op => op.opId === row.opId), 'A 档仍有这条待保存');

  // 换成 B 档：保持同一组 sessionId / routeId / opId，只改档案 ID 与待存备注。
  const bArchive = JSON.parse(storage.get(ARCHIVE_KEY));
  bArchive.archiveId = 'archive-of-another-profile';
  bArchive.pendingSaves.find(op => op.opId === row.opId).note =
    '仅第二份档案可以确认这把';
  const bBytes = JSON.stringify(bArchive);
  storage.set(ARCHIVE_KEY, bBytes);

  // 旧 A 页上的原重试按钮事件现在才到：按 opId 在 B 档里能找到同一条，但归属先被核对。
  page.retryPendingAttempt(
    tapDataset({
      archiveId: row.archiveId,
      sessionId: row.sessionId,
      routeId: row.routeId,
      opId: row.opId
    })
  );

  assert.equal(storage.get(ARCHIVE_KEY), bBytes, 'B 档字节原样保留');
  const after = JSON.parse(storage.get(ARCHIVE_KEY));
  assert.equal(after.pendingSaves.length, 1, 'B 的待保存记录没有被确认掉');
  assert.equal(after.pendingSaves[0].note, '仅第二份档案可以确认这把');
  assert.equal(
    after.attempts.some(item => item.id === row.opId),
    false,
    '没有把 A 的这一把写进 B 档'
  );
  assert.match(page.data.notice, /原来的本机档案/);
});

test('T037 返工 单线与明细缺 archiveId 时只显示原因并拒绝写入', () => {
  const started = store.startSession({ gymName: '缺档案岩馆', date: '2026-11-09' });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const created = store.createRoute({
    sessionId,
    name: '缺档案线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;
  const saved = store.saveAttempt({ sessionId, routeId, result: 'fail' });
  assert.equal(saved.ok, true, saved.error);

  // 先制造一条真正落盘的「进行中」标记，用来核对缺参页面的重试写入口也被拒绝。
  armSetFailAt(2);
  const pending = store.saveAttempt({ sessionId, routeId, result: 'fail' });
  armSetFailAt(0);
  assert.equal(pending.ok, false);
  const originalRaw = storage.get(ARCHIVE_KEY);
  assert.equal(JSON.parse(originalRaw).pendingSaves.length, 1);

  const recordPage = createPage(recordDefinition);
  recordPage.onLoad({ sessionId, routeId });
  assert.match(recordPage.data.contextError, /缺少档案参数/);
  assert.equal(recordPage.data.activeSession, null);
  assert.equal(recordPage.data.attempts.length, 0);
  recordPage.recordAttempt(tapResult('fail'));
  recordPage.retryPendingAttempt(
    tapDataset({ archiveId: '', sessionId, routeId, opId: pending.opId })
  );
  assert.equal(storage.get(ARCHIVE_KEY), originalRaw, '单线缺 archiveId 不写盘');

  const attemptsPage = createPage(attemptsDefinition);
  attemptsPage.onLoad({ sessionId, routeId });
  assert.match(attemptsPage.data.contextError, /缺少档案参数/);
  assert.equal(attemptsPage.data.attempts.length, 0);
  attemptsPage.openNoteEditor(tapDataset({ attemptId: saved.attempt.id }));
  assert.equal(attemptsPage.data.noteEditor, null, '缺参明细页不打开编辑器');
  assert.equal(storage.get(ARCHIVE_KEY), originalRaw, '明细缺 archiveId 不写盘');

  // 同一份档案里带齐 archiveId 的两个入口仍照常打开（不是把所有入口一律关掉）。
  const ready = openRecordFor(routeId, sessionId);
  assert.equal(ready.data.contextError, '');
  assert.equal(ready.data.selectedRoute.id, routeId);
});

test('T036/T045 现场不再有线路历史入口；原线路资料页仍按入口 archiveId 核对归属', () => {
  const flow = trainThroughPages('石间岩馆');
  openRecordFor(flow.aId, flow.sessionId);
  const routeArchiveId = archiveOf().archiveId;

  // T045：现场移除了「线路历史」跳转，也不再保留可点的方法绑定。
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const recordSource = fs.readFileSync(RECORD_JS, 'utf8');
  assert.equal(recordWxml.indexOf('id="open-route-profile"'), -1, '现场没有线路历史入口');
  assert.equal(recordWxml.indexOf('bindtap="openRouteProfile"'), -1);
  assert.doesNotMatch(recordSource, /training-route\/training-route/, '单线页不再直达线路资料页');
  assert.doesNotMatch(recordSource, /training-attempts\/training-attempts/, '单线页不再直达逐把页');

  // 原线路资料页本身仍按入口带的原 archiveId 核对归属（旧入口/旧链接兼容读取）。
  const query = { archiveId: routeArchiveId, routeId: flow.aId };
  const profile = createPage(routeDefinition);
  profile.onLoad(query);
  assert.equal(profile.data.claimError, '');
  assert.equal(profile.data.route.id, flow.aId);

  // 换档后同一 routeId 指向另一份档案：资料页按入口带的原档案拒绝展示。
  const twin = JSON.parse(storage.get(ARCHIVE_KEY));
  twin.archiveId = 'archive-of-another-profile';
  storage.set(ARCHIVE_KEY, JSON.stringify(twin));
  const blocked = createPage(routeDefinition);
  blocked.onLoad(query);
  assert.match(blocked.data.claimError, /另一份本机档案/);
  assert.equal(blocked.data.route, null);
});

test('T036 返工 旧备注保存/取消事件不提交也不清除后来的草稿', () => {
  const started = store.startSession({ gymName: '备注岩馆', date: '2026-11-09' });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const created = store.createRoute({
    sessionId,
    name: '备注线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;
  const saved = ['fail', 'fail', 'fail'].map((result, index) => {
    const outcome = store.saveAttempt({
      sessionId,
      routeId,
      result,
      now: new Date(2026, 10, 9, 10, 0 + index)
    });
    assert.equal(outcome.ok, true, outcome.error);
    return outcome.attempt;
  });

  const page = openAttemptsFor(sessionId, routeId);
  page.openNoteEditor(tapDataset({ attemptId: saved[0].id }));
  const firstEditor = page.data.noteEditor;
  const staleSave = tapDataset({
    attemptId: firstEditor.attemptId,
    editVersion: firstEditor.version
  });
  const staleCancel = tapDataset({
    attemptId: firstEditor.attemptId,
    editVersion: firstEditor.version
  });

  // 取消第一把的编辑，打开第二把并写新草稿。
  page.cancelNote(staleCancel);
  assert.equal(page.data.noteEditor, null);
  page.openNoteEditor(tapDataset({ attemptId: saved[1].id }));
  const secondEditor = page.data.noteEditor;
  assert.notEqual(secondEditor.version, firstEditor.version, '另开一把换编辑代次');
  page.onNoteInput({
    detail: { value: '二号新草稿，尚未确认' },
    currentTarget: {
      dataset: { attemptId: secondEditor.attemptId, editVersion: secondEditor.version }
    }
  });

  const before = storage.get(ARCHIVE_KEY);
  page.saveNote(staleSave);
  assert.equal(storage.get(ARCHIVE_KEY), before, '旧保存不写盘');
  assert.equal(page.data.noteEditor.attemptId, saved[1].id, '旧保存不收新编辑器');
  assert.equal(page.data.noteEditor.text, '二号新草稿，尚未确认', '新草稿不被旧保存提交');
  assert.match(page.data.notice, /之前打开的备注编辑/);

  page.cancelNote(staleCancel);
  assert.equal(page.data.noteEditor.attemptId, saved[1].id, '旧取消不清新编辑器');
  assert.equal(page.data.noteEditor.text, '二号新草稿，尚未确认');

  page.saveNote(
    tapDataset({
      attemptId: page.data.noteEditor.attemptId,
      editVersion: page.data.noteEditor.version
    })
  );
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  const notes = store.attemptsFor(archiveOf(), { sessionId, routeId });
  assert.equal(notes.find(item => item.id === saved[1].id).note, '二号新草稿，尚未确认');
  assert.equal(notes.find(item => item.id === saved[0].id).note, '');
  assert.equal(notes.find(item => item.id === saved[2].id).note, '');

  // 同一把取消后重新打开：旧代次的保存与取消都不能落到新草稿上。
  page.openNoteEditor(tapDataset({ attemptId: saved[2].id }));
  const reopenedFirst = page.data.noteEditor;
  const sameAttemptStaleSave = tapDataset({
    attemptId: reopenedFirst.attemptId,
    editVersion: reopenedFirst.version
  });
  const sameAttemptStaleCancel = tapDataset({
    attemptId: reopenedFirst.attemptId,
    editVersion: reopenedFirst.version
  });
  page.cancelNote(sameAttemptStaleCancel);
  page.openNoteEditor(tapDataset({ attemptId: saved[2].id }));
  const reopenedSecond = page.data.noteEditor;
  assert.notEqual(reopenedSecond.version, reopenedFirst.version);
  page.onNoteInput({ detail: { value: '同一把的新草稿' } });

  const beforeSame = storage.get(ARCHIVE_KEY);
  page.saveNote(sameAttemptStaleSave);
  assert.equal(storage.get(ARCHIVE_KEY), beforeSame);
  assert.equal(page.data.noteEditor.text, '同一把的新草稿');
  page.cancelNote(sameAttemptStaleCancel);
  assert.equal(page.data.noteEditor.text, '同一把的新草稿', '旧取消不清同一把的新草稿');

  page.saveNote(
    tapDataset({
      attemptId: page.data.noteEditor.attemptId,
      editVersion: page.data.noteEditor.version
    })
  );
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId, routeId }).find(
      item => item.id === saved[2].id
    ).note,
    '同一把的新草稿'
  );

  // 真实按钮把原 attemptId 与编辑代次一起带回来。
  const wxml = fs.readFileSync(ATTEMPTS_WXML, 'utf8');
  assert.match(
    wxml,
    /id="cancel-note"[\s\S]{0,260}data-attempt-id="\{\{noteEditor\.attemptId\}\}"[\s\S]{0,160}data-edit-version="\{\{noteEditor\.version\}\}"[\s\S]{0,100}bindtap="cancelNote"/
  );
  assert.match(
    wxml,
    /id="save-note"[\s\S]{0,260}data-attempt-id="\{\{noteEditor\.attemptId\}\}"[\s\S]{0,160}data-edit-version="\{\{noteEditor\.version\}\}"[\s\S]{0,100}bindtap="saveNote"/
  );
});

// ------------------------------------------------------------------ *
// T034–T037 独立 QA 返工：换页后保留原失败操作与原 opId
// ------------------------------------------------------------------ *

/**
 * 让下一次写盘在写前失败（数据一个字没落盘），同时从这次本来要写的档案里读出页面
 * 生成的原 opId。与 QA H07 用一次性拒绝 setStorageSync 取证的方式一致：失败的那一笔
 * 只在当前应用运行期留下记录，档案里看不到它。
 */
function captureFirstStageFailure(collection, matches) {
  let issued = '';
  armRivalWriterAt(1, (key, value) => {
    const next = JSON.parse(value);
    const entry = (next[collection] || []).find(matches);
    if (entry) issued = entry.opId || entry.id || '';
  });
  return () => issued;
}

test('T037 返工 第一笔待保存写入失败后换线再回来，仍按原 opId 补上同一把', () => {
  const flow = trainThroughPages('返工岩馆');
  let page = openRecordFor(flow.aId, flow.sessionId);
  const beforeA = savedAttempts(flow.sessionId, flow.aId).length;

  const issuedOpId = captureFirstStageFailure(
    'pendingSaves',
    entry => entry.sessionId === flow.sessionId && entry.routeId === flow.aId
  );
  tick();
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  const opId = issuedOpId();
  assert.ok(opId, '页面为这一把生成了 opId');
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  const failed = JSON.parse(storage.get(ARCHIVE_KEY));
  assert.equal(failed.pendingSaves.length, 0, '第一笔写失败：档案里没有待保存标记');
  assert.equal(failed.attempts.some(item => item.id === opId), false, '也没有多出一把');
  assert.equal(page.data.pendingRows.length, 1, '本页仍有可重试的待保存行');
  assert.equal(page.data.pendingRows[0].opId, opId);

  // 回列表换 B 正常记一把（新页面实例），再回 A：待保存行还在，opId 不变。
  page = switchTo(page, flow.bId);
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(page.data.storageError, '');
  page = switchTo(page, flow.aId);
  const row = page.data.pendingRows.find(item => item.opId === opId);
  assert.ok(row, '换页回来仍能看到原来那一把待保存');
  assert.equal(row.archiveId, archiveOf().archiveId);
  assert.equal(page.data.resultLocked, true, '有未落盘的一把时先重试，不记下一把');

  page.retryPendingAttempt(
    tapDataset({
      archiveId: row.archiveId,
      sessionId: row.sessionId,
      routeId: row.routeId,
      opId: row.opId
    })
  );
  const after = savedAttempts(flow.sessionId, flow.aId);
  assert.equal(after.length, beforeA + 1, '只补上同一把');
  assert.equal(after.filter(item => item.id === opId).length, 1, '把次 ID 就是原 opId');
  assert.equal(JSON.parse(storage.get(ARCHIVE_KEY)).pendingSaves.length, 0);
  assert.equal(page.data.pendingRows.length, 0);
  assert.equal(page.data.storageError, '');
});
for (const action of ['undo', 'restore']) {
  const handler = action === 'undo' ? 'undoLatestAttempt' : 'restoreLatestAttempt';
  const collection = action === 'undo' ? 'pendingUndos' : 'pendingRestores';
  const effectiveAfter = action === 'undo' ? 2 : 3;

  test(`T037 返工 ${action} 第一段写失败后换线再回来，仍按原 opId 结清一次`, () => {
    const flow = trainThroughPages('返工岩馆');
    let page = openRecordFor(flow.aId, flow.sessionId);
    const targetId = flow.aAttempts[2];
    if (action === 'restore') {
      tick();
      page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
      assert.equal(page.data.storageError, '');
    }
    // 这一次失败事件的原样快照：结清并做反向动作之后重放它，不得逆转。
    const originalEvent = rowEvent(page.data.recentAttempt);

    const issuedOpId = captureFirstStageFailure(collection, entry => entry.attemptId === targetId);
    tick();
    page[handler](originalEvent);
    armSetFailAt(0);
    const opId = issuedOpId();
    assert.ok(opId, '页面为这次动作生成了 opId');
    assert.match(page.data.storageError, /保存本机训练档案失败/);
    const failed = JSON.parse(storage.get(ARCHIVE_KEY));
    assert.equal(failed.pendingUndos.length, 0, '第一段写失败：没有撤回进行中标记');
    assert.equal(failed.pendingRestores.length, 0, '第一段写失败：没有恢复进行中标记');
    const failedAttempt = failed.attempts.find(item => item.id === targetId);
    assert.equal(
      (failedAttempt.settledOps || []).some(item => item.opId === opId),
      false,
      '档案里没有结清这次操作'
    );
    assert.match(page.data.recentAttempt.stateText, /未保存/);
    assert.match(
      action === 'undo' ? page.data.recentAttempt.undoText : page.data.recentAttempt.restoreText,
      /重试/
    );

    // 回列表换 B 记一把，再回 A：新页面实例仍显示这次动作可显式重试。
    page = switchTo(page, flow.bId);
    tick();
    page.recordAttempt(tapResult('fail'));
    page = switchTo(page, flow.aId);
    const row = page.data.recentAttempt;
    assert.equal(row.attemptId, targetId);
    assert.match(row.stateText, /未保存/);
    assert.match(action === 'undo' ? row.undoText : row.restoreText, /重试/);

    tick();
    page[handler](rowEvent(row));
    assert.equal(page.data.storageError, '');
    const settledArchive = JSON.parse(storage.get(ARCHIVE_KEY));
    const settled = settledArchive.attempts.find(item => item.id === targetId).settledOps || [];
    assert.equal(
      settled.filter(item => item.opId === opId && item.undone === (action === 'undo')).length,
      1,
      '原 opId 只结清一次'
    );
    assert.equal(settledArchive.pendingUndos.length, 0);
    assert.equal(settledArchive.pendingRestores.length, 0);
    assert.equal(
      savedAttempts(flow.sessionId, flow.aId).filter(item => !item.undoneAt).length,
      effectiveAfter
    );

    // 先做反向动作，再送回原来那次失败事件：按渲染时的版本拒绝，不逆转。
    tick();
    page[action === 'undo' ? 'restoreLatestAttempt' : 'undoLatestAttempt'](
      rowEvent(page.data.recentAttempt)
    );
    const beforeReplay = storage.get(ARCHIVE_KEY);
    page[handler](originalEvent);
    assert.equal(storage.get(ARCHIVE_KEY), beforeReplay, '迟到重放不改档案');
  });

  test(`T037 返工 ${action} 提交阶段失败（待处理已落盘）后换线再回来，重试沿用原 opId`, () => {
    const flow = trainThroughPages('返工岩馆');
    let page = openRecordFor(flow.aId, flow.sessionId);
    const targetId = flow.aAttempts[2];
    if (action === 'restore') {
      tick();
      page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
      assert.equal(page.data.storageError, '');
    }
    const originalEvent = rowEvent(page.data.recentAttempt);

    // 第一段「进行中」标记落盘、第二段提交失败：档案里留着原 opId 的待处理项。
    armSetFailAt(2);
    tick();
    page[handler](originalEvent);
    armSetFailAt(0);
    assert.match(page.data.storageError, /保存本机训练档案失败/);
    const staged = JSON.parse(storage.get(ARCHIVE_KEY));
    const marker = (staged[collection] || []).find(item => item.attemptId === targetId);
    assert.ok(marker, '待处理阶段已落盘');
    const opId = marker.opId;
    assert.match(page.data.recentAttempt.stateText, /未保存/);

    page = switchTo(page, flow.bId);
    tick();
    page.recordAttempt(tapResult('fail'));
    page = switchTo(page, flow.aId);
    assert.equal(page.data.recentAttempt.attemptId, targetId);
    assert.match(page.data.recentAttempt.stateText, /未保存/);
    assert.match(
      action === 'undo' ? page.data.recentAttempt.undoText : page.data.recentAttempt.restoreText,
      /重试/
    );

    tick();
    page[handler](rowEvent(page.data.recentAttempt));
    assert.equal(page.data.storageError, '');
    const settledArchive = JSON.parse(storage.get(ARCHIVE_KEY));
    assert.equal(settledArchive.pendingUndos.length, 0);
    assert.equal(settledArchive.pendingRestores.length, 0);
    const settled = settledArchive.attempts.find(item => item.id === targetId).settledOps || [];
    assert.equal(
      settled.filter(item => item.opId === opId && item.undone === (action === 'undo')).length,
      1,
      '待处理阶段的原 opId 结清一次'
    );
    assert.equal(
      savedAttempts(flow.sessionId, flow.aId).filter(item => !item.undoneAt).length,
      effectiveAfter
    );

    // 旧请求重放：先做反向动作，再送回原来那次失败事件——不得逆转。
    tick();
    page[action === 'undo' ? 'restoreLatestAttempt' : 'undoLatestAttempt'](
      rowEvent(page.data.recentAttempt)
    );
    const beforeReplay = storage.get(ARCHIVE_KEY);
    page[handler](originalEvent);
    assert.equal(storage.get(ARCHIVE_KEY), beforeReplay, '旧请求重放不得逆转');
  });
}

// ------------------------------------------------------------------ *
// QA B08 返工：第一段写失败的内存请求只按它发出时的版本有效
//
// 失败请求没有落盘凭据，但这一把此后可能被别的写者推进过：撤回 → 恢复走一圈，
// 状态又回到「有效」，只比较状态的话这次失败请求看上去完全合法。重开页面后如果
// 继续显示「重试…」并拿新渲染的 expectedRev 去提交旧 opId，就等于把旧请求升级成
// 一次新版本上的新请求，会逆转别人后来确认的状态。
// ------------------------------------------------------------------ *

for (const action of ['undo', 'restore']) {
  const handler = action === 'undo' ? 'undoLatestAttempt' : 'restoreLatestAttempt';
  const collection = action === 'undo' ? 'pendingUndos' : 'pendingRestores';
  const label = action === 'undo' ? '撤回' : '恢复';

  test(`QA B08 ${label}第一段写失败后经外部${label}→反向往返：旧请求不结清到新版本，当前版本上的新动作可用`, () => {
    const actions = require(path.join(ROOT, 'utils', 'training-record-actions.js'));
    const flow = trainThroughPages('返工岩馆');
    let page = openRecordFor(flow.aId, flow.sessionId);
    const targetId = flow.aAttempts[2];
    const scope = { routeId: flow.aId, sessionId: flow.sessionId };
    if (action === 'restore') {
      tick();
      page.undoLatestAttempt(rowEvent(page.data.recentAttempt));
      assert.equal(page.data.storageError, '');
    }

    // 按钮真实渲染出来的点击参数：带渲染时的状态与原版本（WXML 的 data-expected-rev）。
    const originalEvent = rowEvent(page.data.recentAttempt);
    const originalRev = originalEvent.currentTarget.dataset.expectedRev;
    assert.equal(Number.isInteger(originalRev), true, '点击参数带渲染时的 expectedRev');
    assert.equal(
      store.attemptRev(archiveOf().attempts.find(item => item.id === targetId)),
      originalRev
    );

    // 第一段写「进行中」标记就失败：档案里不留任何凭据，请求只在应用运行期缓存。
    const issuedOpId = captureFirstStageFailure(collection, entry => entry.attemptId === targetId);
    tick();
    page[handler](originalEvent);
    armSetFailAt(0);
    const opId = issuedOpId();
    assert.ok(opId, '页面为这次动作生成了 opId');
    assert.match(page.data.storageError, /保存本机训练档案失败/);
    assert.equal(JSON.parse(storage.get(ARCHIVE_KEY))[collection].length, 0, '第一段失败不留进行中标记');
    // 失败时缓存下来的原请求：opId 与归属；它发出时所依据的版本在重开后核对。
    const recorded = actions.failedChangeEntry(archiveOf(), targetId, action);
    assert.equal(recorded.opId, opId);

    // 另一个写者不经本应用缓存，用正式 store API 带自己的 opId 与各自真实版本
    // 完成同一动作再反向做回来：这一把回到请求发出时的状态，版本前进两次。
    tick();
    assert.equal(
      (action === 'undo' ? store.undoAttempt : store.restoreAttempt)(targetId, {
        ...scope,
        opId: 'external-' + action,
        expectedRev: originalRev
      }).code,
      action === 'undo' ? 'undone' : 'restored'
    );
    tick();
    assert.equal(
      (action === 'undo' ? store.restoreAttempt : store.undoAttempt)(targetId, {
        ...scope,
        opId: 'external-opposite-' + action,
        expectedRev: originalRev + 1
      }).code,
      action === 'undo' ? 'restored' : 'undone'
    );
    const beforeAttempt = archiveOf().attempts.find(item => item.id === targetId);
    assert.equal(store.attemptRev(beforeAttempt), originalRev + 2);
    assert.equal(
      store.isUndoneAttempt(beforeAttempt),
      action === 'restore',
      '往返后回到请求发出时的状态，只看状态已经看不出被取代'
    );

    // 回列表换线再回这条线：过期缓存不再被当作可重试的原请求，显示普通动作。
    page = switchTo(page, flow.bId);
    page = switchTo(page, flow.aId);
    const row = page.data.recentAttempt;
    assert.equal(row.attemptId, targetId);
    assert.equal(row.expectedRev, originalRev + 2, '新渲染带的是当前版本');
    assert.equal(row.stateText, '', '不再显示「未保存」的重试说明');
    assert.equal(action === 'undo' ? row.undoText : row.restoreText, label + '这一把');
    assert.equal(row.canUndo, action === 'undo');
    assert.equal(row.canRestore, action === 'restore');

    // 用户在当前版本上明确再点一次：旧 opId 不会被配上新版本，这一下由档案层生成
    // 新 opId，只推进一个版本、只多一条凭据，也不逆转往返后的状态。
    tick();
    page[handler](rowEvent(row));
    assert.equal(page.data.storageError, '');
    const after = archiveOf().attempts.find(item => item.id === targetId);
    assert.equal(store.attemptRev(after), originalRev + 3, '新动作只推进一个版本');
    assert.equal(store.isUndoneAttempt(after), action === 'undo');
    const settled = after.settledOps || [];
    assert.equal(
      settled.some(item => item.opId === opId),
      false,
      '过期的原请求 opId 没有被结清到新版本'
    );
    assert.equal(
      settled.length,
      (beforeAttempt.settledOps || []).length + 1,
      '新动作只多一条凭据'
    );
    assert.equal(store.attemptSettledOp(after, 'external-' + action).undone, action === 'undo');

    // 缓存侧：原请求曾按发出时的版本记下，版本前进后整条清掉（不再有可沿用的 opId）。
    assert.equal(recorded.expectedRev, originalRev, '缓存保留请求发出时的原版本');
    assert.equal(
      actions.failedChangeEntry(archiveOf(), targetId, action),
      null,
      '版本前进过的失败请求已从运行期缓存清掉'
    );

    // 原来那个带旧版本的迟到事件：仍按 dataset 里的原版本拒绝，一个字都不写。
    const beforeReplay = storage.get(ARCHIVE_KEY);
    page[handler](originalEvent);
    assert.equal(storage.get(ARCHIVE_KEY), beforeReplay, '旧版本事件不改档案');
  });
}

test('T037 返工 运行期记住的未落盘操作按 archiveId 隔离，不写进另一份档案', () => {
  const flow = trainThroughPages('返工岩馆');
  const page = openRecordFor(flow.aId, flow.sessionId);
  const issuedOpId = captureFirstStageFailure('pendingSaves', entry => entry.routeId === flow.aId);
  tick();
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  const opId = issuedOpId();
  const row = page.data.pendingRows[0];
  assert.ok(opId && row && row.opId === opId);

  // 盘上换成另一份档案：同名 sessionId / routeId / opId 全部复用。
  const twin = JSON.parse(storage.get(ARCHIVE_KEY));
  twin.archiveId = 'twin-archive-of-another-profile';
  storage.set(ARCHIVE_KEY, JSON.stringify(twin));
  const twinPage = openRecordFor(flow.aId, flow.sessionId);
  assert.equal(twinPage.data.contextError, '', '另一份档案按它自己的 ID 正常打开');
  assert.equal(twinPage.data.pendingRows.length, 0, '不显示 A 档未落盘的待保存');

  const before = storage.get(ARCHIVE_KEY);
  const event = tapDataset({
    archiveId: row.archiveId,
    sessionId: row.sessionId,
    routeId: row.routeId,
    opId: row.opId
  });
  twinPage.retryPendingAttempt(event);
  page.retryPendingAttempt(event);
  assert.equal(storage.get(ARCHIVE_KEY), before, '旧请求不写进另一份档案');
  assert.equal(
    JSON.parse(before).attempts.some(item => item.id === opId),
    false,
    '没有把 A 的这一把写进新档'
  );
});

test('T037 返工 应用冷启后不伪造未落盘操作，只读打开不改档案', () => {
  const flow = trainThroughPages('返工岩馆');
  const page = openRecordFor(flow.aId, flow.sessionId);
  const issuedOpId = captureFirstStageFailure('pendingSaves', entry => entry.routeId === flow.aId);
  tick();
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.ok(issuedOpId());
  const bytes = storage.get(ARCHIVE_KEY);

  // 新 App 运行：模块重新加载后没有上一次运行的内存记录，档案里也没有这一把。
  const actionsPath = require.resolve(path.join(ROOT, 'utils', 'training-record-actions.js'));
  const cached = require.cache[actionsPath];
  delete require.cache[actionsPath];
  try {
    const fresh = require(actionsPath);
    const archive = store.loadState().archive;
    assert.deepEqual(fresh.failedSaveEntries(archive), [], '冷启后没有「待保存」可显示');
    assert.equal(storage.get(ARCHIVE_KEY), bytes, '只读回读不改档案');
  } finally {
    require.cache[actionsPath] = cached;
  }
});

// ------------------------------------------------------------------ *
// T034/T037 返工 Q10/Q11：列表显示目标钉住原场次
// ------------------------------------------------------------------ *

test('T037 返工 钉住 S1 的列表从小结纯返回仍显示 S1，不写活动场次；点 S1 的线只记回 S1', () => {
  // 同一岩馆同一天两场：S1 先开（A、B 两条线），S2 同日另开（也关联 B）。
  const today = store.todayLocalDate();
  const first = store.startSession({ gymName: '钉住岩馆', date: today });
  assert.equal(first.ok, true, first.error);
  const routeA = store.createRoute({
    sessionId: first.session.id,
    name: 'A 线',
    climbType: '抱石',
    grade: 'V3'
  });
  const routeB = store.createRoute({
    sessionId: first.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(routeA.ok, true, routeA.error);
  assert.equal(routeB.ok, true, routeB.error);

  const second = store.startSession({ gymName: '钉住岩馆', date: today });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.linkRouteToSession(second.session.id, routeB.route.id).ok, true);
  const s2Saved = store.saveAttempt({
    sessionId: second.session.id,
    routeId: routeB.route.id,
    result: 'fail',
    note: 'S2 原备注'
  });
  assert.equal(s2Saved.ok, true, s2Saved.error);

  // 从 S1 列表进入：先让 S1 成为当前场次与当前线路（列表第一次显示的就是它）。
  assert.equal(store.selectSession(first.session.id).ok, true);
  assert.equal(store.selectRoute(routeA.route.id).ok, true);
  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, first.session.id);
  assert.equal(page.data.selectedRoute.id, routeA.route.id);
  assert.equal(page.data.summaryEntrySessionId, first.session.id, '小结入口指向本页这一场');

  // 小结打开期间另一处把活动场次改成 S2；纯返回（onShow）仍显示 S1，且一个字节都不写。
  assert.equal(store.selectSession(second.session.id).ok, true);
  const afterExternal = storage.get(ARCHIVE_KEY);
  page.onShow();
  assert.equal(page.data.activeSession.id, first.session.id, '纯返回仍显示原场次');
  assert.equal(page.data.summaryEntrySessionId, first.session.id, '小结入口不跟着换场');
  assert.equal(storage.get(ARCHIVE_KEY), afterExternal, '纯返回不写活动场次');

  // 从 S1 的原行点 B：打开的单线页必须带 S1 的归属，这一把只记回 S1。
  tick();
  page.openRecord(
    tapDataset({
      archiveId: archiveOf().archiveId,
      sessionId: first.session.id,
      routeId: routeB.route.id
    })
  );
  const navigated = wxLog.navigations.at(-1);
  assert.ok(navigated, '应打开单线记录页');
  assert.match(navigated.url, new RegExp('sessionId=' + first.session.id));
  assert.match(navigated.url, new RegExp('routeId=' + routeB.route.id));

  const record = openRecordFor(routeB.route.id, first.session.id);
  tick();
  record.recordAttempt(tapResult('fail'));
  const saved = archiveOf().attempts.filter(
    attempt => attempt.sessionId === first.session.id && attempt.routeId === routeB.route.id
  );
  assert.equal(saved.length, 1, '这一把归 S1');
  assert.equal(saved[0].result, 'fail');
  // S2 的原把次与备注保持不动，也没有多出第二把。
  const s2Attempts = archiveOf().attempts.filter(
    attempt => attempt.sessionId === second.session.id && attempt.routeId === routeB.route.id
  );
  assert.deepEqual(s2Attempts.map(item => [item.id, item.note]), [
    [s2Saved.attempt.id, 'S2 原备注']
  ]);
  assert.equal(archiveOf().activeSessionId, second.session.id, '点行记一把不改活动场次');

  // 纯返回之后仍停在 S1：再显示一次也不跟着外部活动场次走。
  page.onShow();
  assert.equal(page.data.activeSession.id, first.session.id);
});

test('T037 返工 显式切场次会更新列表显示目标，不靠临时回看标记', () => {
  const today = store.todayLocalDate();
  const first = store.startSession({ gymName: '切换岩馆', date: today });
  assert.equal(first.ok, true, first.error);
  const second = store.startSession({ gymName: '切换岩馆', date: today });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.selectSession(first.session.id).ok, true);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, first.session.id);

  // 同一批场次里的显式切换：显示目标与活动场次一起换到 S2。
  page.switchSession(tapDataset({ sessionId: second.session.id }));
  assert.equal(page.data.activeSession.id, second.session.id);
  assert.equal(archiveOf().activeSessionId, second.session.id);

  // 再显式切回 S1：显示目标跟着回来，档案只有一个活动场次。
  page.switchSession(tapDataset({ sessionId: first.session.id }));
  assert.equal(page.data.activeSession.id, first.session.id);
  assert.equal(archiveOf().activeSessionId, first.session.id);
  assert.equal(archiveOf().sessions.length, 2, '切场次不新建场次');
});

// ------------------------------------------------------------------ *
// T041 现场首屏照片入口
// ------------------------------------------------------------------ *

test('T041 现场首屏：一行照片入口与两种记把动作、同页把次并存', () => {
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  const source = fs.readFileSync(RECORD_JS, 'utf8');

  // 无图给「添加线路照片」（拍照 / 相册），选图后预览确认；有图整行进二级标记页。
  [
    'record-photo',
    'record-photo-entry',
    'record-photo-thumb',
    'record-photo-camera',
    'record-photo-album',
    'record-photo-preview-image',
    'record-photo-confirm',
    'record-photo-cancel',
    'record-photo-retry'
  ].forEach(id => {
    assert.ok(wxml.indexOf('id="' + id + '"') !== -1, '单线首屏缺少 ' + id);
  });
  const handlers = new Set(handlersIn(wxml));
  for (const required of [
    'chooseRecordPhoto',
    'confirmRecordPhoto',
    'cancelRecordPhoto',
    'retryRecordPhoto',
    'dismissRecordPhotoFailure',
    'openRoutePhotoMarks'
  ]) {
    assert.ok(handlers.has(required), '单线首屏应绑定：' + required);
    assert.equal(typeof recordDefinition[required], 'function', required + ' 必须有页面方法');
  }

  // 第一屏仍是现场记录：两种记把动作与本场本线把次都在，照片入口夹在线路头与结果区之间。
  const photoAt = wxml.indexOf('id="record-photo"');
  const failAt = wxml.indexOf('id="record-fail"');
  const sendAt = wxml.indexOf('id="record-send"');
  const attemptsAt = wxml.indexOf('id="record-attempts"');
  assert.ok(photoAt !== -1 && failAt !== -1 && sendAt !== -1 && attemptsAt !== -1);
  assert.ok(photoAt < failAt, '照片入口在结果按钮之前');
  assert.ok(failAt < attemptsAt, '本场本线把次仍在结果按钮之后');

  // 首屏不铺第二套照片卡、标记图层或移除入口：这些仍在二级大图页。
  assert.equal(wxml.indexOf('id="route-photo-card"'), -1);
  assert.equal(wxml.indexOf('id="mark-card"'), -1);
  assert.equal(wxml.indexOf('bindtap="removeRoutePhoto"'), -1);
  // T045：现场不再有线路历史跳转，也不再写「线路资料」。
  assert.equal(wxml.indexOf('id="open-route-profile"'), -1, '现场没有线路历史入口');
  assert.equal(wxml.indexOf('线路历史（照片 · 卡点 · 跨天历史）›'), -1);
  assert.equal(wxml.indexOf('线路资料'), -1);
  assert.equal(source.indexOf('线路资料'), -1);
  assert.equal(fs.readFileSync(SESSION_WXML, 'utf8').indexOf('线路资料'), -1);

  // 紧凑入口的可点区域：照片来源与确认按钮至少 44px；缩略图 56px 小图。
  assert.equal(minHeightOf(wxss, '.record-photo-source'), '44px');
  assert.equal(minHeightOf(wxss, '.record-photo-confirm'), '44px');
  assert.match(declarationsOf(wxss, '.record-photo-thumb'), /width:\s*56px/);
  assert.match(declarationsOf(wxss, '.record-photo-thumb'), /height:\s*56px/);

  // 复用同一份照片控制器与照片服务：本页不另写索引、压缩或文件，也不接云。
  assert.match(source, /utils\/training-photo-controller/);
  assert.match(source, /createTrainingPhotoController/);
  assert.match(source, /utils\/training-photo-marks/);
  assert.doesNotMatch(source, /getFileSystemManager|copyFile|compressImage/);
  assert.doesNotMatch(source, /wx\.cloud/);
});

// ------------------------------------------------------------------ *
// T043 底栏记录：一场一行 → 原场小结 → 原线路与跨日历史（只读）
// ------------------------------------------------------------------ *

test('T043 记录 tab 一行直达原场小结，再回看原线路与跨日历史：当前场与线路不变、零写入', () => {
  const flow = trainThroughPages('石间岩馆');
  const archiveBefore = archiveOf();
  const archiveId = archiveBefore.archiveId;
  const activeBefore = {
    sessionId: archiveBefore.activeSessionId,
    routeId: archiveBefore.activeRouteId
  };
  const rawBefore = storage.get(ARCHIVE_KEY);

  // 记录 tab：本机区是原场次列表，这一场两线四把。
  const listPage = createPage(listDefinition);
  listPage.refreshLocalHistory();
  const rows = (listPage.data.sessionDays || []).flatMap(day =>
    (day.gyms || []).flatMap(gym => gym.sessions || [])
  );
  assert.equal(rows.length, 1, '一次训练一个原场次一行');
  const row = rows[0];
  assert.equal(row.id, flow.sessionId);
  assert.equal(row.label, '第 1 场');
  assert.equal(row.gymName, '石间岩馆');
  assert.equal(row.routeCount, 2);
  assert.equal(row.attemptCount, 4);
  assert.equal(row.summaryText, '2 条线 · 4 把');
  assert.equal(row.archiveId, archiveId);

  // 点行：原档案 ID + 原场次 ID 打开现有小结页。
  resetWxLog();
  listPage.goToSessionSummary(
    tapDataset({ sessionId: row.id, archiveId: row.archiveId })
  );
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-summary/training-summary?sessionId=' +
      flow.sessionId +
      '&archiveId=' +
      archiveId
  ]);

  // 打开小结（真实页面）：读数与该场小结同一份，不展示别的场次。
  const summaryPage = createPage(summaryPageDefinition);
  summaryPage.onLoad({ sessionId: flow.sessionId, archiveId });
  assert.equal(summaryPage.data.summaryReady, true);
  assert.equal(summaryPage.data.summaryError, '');
  assert.equal(summaryPage.data.summarySessionId, flow.sessionId);
  assert.equal(summaryPage.data.summaryCountText, '2 条线 · 4 把');
  assert.equal(summaryPage.data.summaryRows.length, 2);

  // 从小结先看原场逐把（T046）：带原档案 ID、所看这一场的场次 ID 与长期线路 ID，
  // 跨场历史不再由小结直接跳过去。
  resetWxLog();
  summaryPage.openSummaryRoute(
    tapDataset({ archiveId, sessionId: flow.sessionId, routeId: flow.aId })
  );
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-attempts/training-attempts?archiveId=' +
      archiveId +
      '&sessionId=' +
      flow.sessionId +
      '&routeId=' +
      flow.aId +
      '&from=summary'
  ]);

  // 本场逐把（真实页面）：只列这一场这一条线的三把，标明原日期、岩馆与场次。
  const attemptsPage = createPage(attemptsDefinition);
  attemptsPage.onLoad({
    archiveId,
    sessionId: flow.sessionId,
    routeId: flow.aId,
    from: 'summary'
  });
  assert.equal(attemptsPage.data.contextError, '');
  assert.equal(attemptsPage.data.fromSummary, true);
  assert.equal(attemptsPage.data.backLabel, '返回原场小结', '返回文案与实际落点一致');
  assert.equal(attemptsPage.data.activeSession.id, flow.sessionId);
  assert.equal(
    attemptsPage.data.activeSession.dateText,
    archiveBefore.sessions.find(item => item.id === flow.sessionId).date
  );
  assert.equal(attemptsPage.data.activeSession.gymName, '石间岩馆');
  assert.equal(attemptsPage.data.activeSession.label, '第 1 场');
  assert.equal(attemptsPage.data.attempts.length, 3, '只列这一场这一条线的把次');
  assert.equal(attemptsPage.data.attempts[1].note, '第二把备注');

  // 用户主动点「线路历史」才进跨场历史：带原档案 ID 与原长期线路 ID。
  resetWxLog();
  attemptsPage.openRouteHistory();
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-route/training-route?archiveId=' + archiveId + '&routeId=' + flow.aId
  ]);

  // 原线历史仍显示原线路、原场次分组与该场三把（含原备注）。
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ archiveId, routeId: flow.aId });
  assert.equal(routePage.data.notFound, false);
  assert.equal(routePage.data.route.id, flow.aId);
  const group = routePage.data.groups.find(item => item.sessionId === flow.sessionId);
  assert.ok(group, '跨日历史里仍按原场次分组');
  assert.equal(group.attempts.length, 3);
  assert.equal(group.attempts[1].note, '第二把备注');

  // 浏览全过程只读：档案逐字节不变，活动场与活动线路都保持原值。
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '浏览记录、小结与原线不改写档案');
  assert.equal(archiveOf().activeSessionId, activeBefore.sessionId);
  assert.equal(archiveOf().activeRouteId, activeBefore.routeId);

  // 返回首页仍继续原来的活动场与活动线路（浏览不切换当前选择）。
  const home = openHome();
  home.refreshTrainingEntry();
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.id, flow.sessionId);
  assert.equal(home.data.activeSession.routeName, 'B 线');
  assert.equal(home.data.activeSession.attemptCountText, '4 把');

  // 返回落点与文案对应（T046）：正常路径退回上一页（小结）；没有上一页时按原档案
  // 与原场次重建小结页连接，而不是回到场内页。
  resetWxLog();
  attemptsPage.backToList();
  assert.equal(wxLog.backs.length, 1, '正常路径是系统返回上一页');
  assert.equal(wxLog.redirects.length, 0);
  wxLog.backs[0].fail();
  assert.deepEqual(wxLog.redirects.map(item => item.url), [
    '/pages/training-summary/training-summary?archiveId=' +
      archiveId +
      '&sessionId=' +
      flow.sessionId
  ]);
});

// ------------------------------------------------------------------ *
// T046 同一长期线路两场：小结 → 本场逐把 → 线路历史
// ------------------------------------------------------------------ *

test('T046 同一长期线路两场各有把次：从第一场小结只看到第一场原把次，主动进线路历史才看到两场', () => {
  // 第一场：A 线三把（第 2 把带备注）、B 线一把；同日再开第二场，复用同一条 A 线记一把。
  const sessionPage = startTrainingFromHome('石间岩馆');
  const firstSessionId = sessionPage.data.activeSession.id;
  const aId = addRouteThroughPage(sessionPage, 'A 线', { grade: 'V3' });
  let record = openRecordFor(aId, firstSessionId);
  recordThroughPage(record, 'fail');
  recordThroughPage(record, 'fail');
  recordThroughPage(record, 'fail');
  const firstAttemptIds = attemptsOf(record).map(row => row.id);
  addNoteThroughAttempts(firstSessionId, aId, firstAttemptIds[1], '第一场第二把');

  const bId = addRouteThroughPage(sessionPage, 'B 线', { grade: 'V3' });
  record = openRecordFor(bId, firstSessionId);
  recordThroughPage(record, 'fail');
  const bAttemptId = attemptsOf(record)[0].id;

  const secondSessionId = startSessionOnSameDay(sessionPage, '石间岩馆');
  assert.notEqual(secondSessionId, firstSessionId, '同馆同日两场各有原场次 ID');
  // 复用同一条长期线路进第二场：本馆已有线路的正式入口。
  addRouteThroughPage(sessionPage, null, { existing: aId });
  record = openRecordFor(aId, secondSessionId);
  recordThroughPage(record, 'send');
  const secondAttemptId = attemptsOf(record)[0].id;
  assert.equal(attemptsOf(record).length, 1, '第二场自己的一把');

  const archive = archiveOf();
  const archiveId = archive.archiveId;
  const rawBefore = storage.get(ARCHIVE_KEY);
  const keysBefore = [...storage.keys()].sort();
  const activeBefore = {
    sessionId: archive.activeSessionId,
    routeId: archive.activeRouteId
  };
  assert.equal(activeBefore.sessionId, secondSessionId, '当前场是第二场');

  // 记录 tab：同日同馆两场各一行，原场次 ID 与场次序号都能区分。
  const listPage = createPage(listDefinition);
  listPage.refreshLocalHistory();
  const rows = (listPage.data.sessionDays || []).flatMap(day =>
    (day.gyms || []).flatMap(gym => gym.sessions || [])
  );
  const firstRow = rows.find(row => row.id === firstSessionId);
  const secondRow = rows.find(row => row.id === secondSessionId);
  assert.ok(firstRow && secondRow, '同日两场各保留原场次 ID');
  assert.equal(firstRow.label, '第 1 场');
  assert.equal(secondRow.label, '第 2 场');
  assert.equal(firstRow.summaryText, '2 条线 · 4 把');
  assert.equal(secondRow.summaryText, '1 条线 · 1 把 · 完攀 1 把');

  // 第一场小结 → 点 A 线：带第一场的场次 ID，不拿当前（第二场）顶替。
  resetWxLog();
  listPage.goToSessionSummary(tapDataset({ sessionId: firstRow.id, archiveId: firstRow.archiveId }));
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-summary/training-summary?sessionId=' +
      firstSessionId +
      '&archiveId=' +
      archiveId
  ]);
  const summaryPage = createPage(summaryPageDefinition);
  summaryPage.onLoad({ sessionId: firstSessionId, archiveId });
  resetWxLog();
  summaryPage.openSummaryRoute(
    tapDataset({ archiveId, sessionId: firstSessionId, routeId: aId })
  );
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-attempts/training-attempts?archiveId=' +
      archiveId +
      '&sessionId=' +
      firstSessionId +
      '&routeId=' +
      aId +
      '&from=summary'
  ]);

  // 本场逐把：只列第一场这一条线的三把，第二场那一把与同场 B 线都不串进来。
  const firstAttempts = createPage(attemptsDefinition);
  firstAttempts.onLoad({
    archiveId,
    sessionId: firstSessionId,
    routeId: aId,
    from: 'summary'
  });
  assert.equal(firstAttempts.data.contextError, '');
  assert.equal(firstAttempts.data.fromSummary, true);
  assert.equal(firstAttempts.data.backLabel, '返回原场小结');
  assert.equal(firstAttempts.data.activeSession.dateText, firstRow.date);
  assert.equal(firstAttempts.data.activeSession.gymName, '石间岩馆');
  assert.equal(firstAttempts.data.activeSession.label, '第 1 场', '标明原场次序号');
  assert.deepEqual(firstAttempts.data.attempts.map(row => row.id), firstAttemptIds);
  assert.equal(firstAttempts.data.attempts[1].note, '第一场第二把');
  assert.equal(
    firstAttempts.data.attempts.some(row => row.id === secondAttemptId),
    false,
    '第二场的把次不出现在第一场的逐把里'
  );
  assert.equal(
    firstAttempts.data.attempts.some(row => row.id === bAttemptId),
    false,
    '同场另一条线的把次不出现在这一条的逐把里'
  );

  // 第二场小结同样只看到第二场自己那一把：两场各归各的原场次身份。
  const secondAttempts = createPage(attemptsDefinition);
  secondAttempts.onLoad({
    archiveId,
    sessionId: secondSessionId,
    routeId: aId,
    from: 'summary'
  });
  assert.equal(secondAttempts.data.activeSession.label, '第 2 场');
  assert.deepEqual(secondAttempts.data.attempts.map(row => row.id), [secondAttemptId]);

  // 在本场逐把主动点「线路历史」：同一条长期线路的两场记录都在。
  resetWxLog();
  firstAttempts.openRouteHistory();
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-route/training-route?archiveId=' + archiveId + '&routeId=' + aId
  ]);
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ archiveId, routeId: aId });
  assert.equal(routePage.data.notFound, false);
  assert.equal(routePage.data.route.id, aId, '仍按同一长期线路 ID 读主照片与卡点');
  const firstGroup = routePage.data.groups.find(item => item.sessionId === firstSessionId);
  const secondGroup = routePage.data.groups.find(item => item.sessionId === secondSessionId);
  assert.equal(firstGroup.attempts.length, 3);
  assert.equal(firstGroup.attempts[1].note, '第一场第二把');
  assert.equal(secondGroup.attempts.length, 1);
  assert.equal(
    routePage.data.groups.some(group =>
      group.attempts.some(attempt => attempt.id === bAttemptId)
    ),
    false,
    '同场另一条线的把次不并进这一条线的历史'
  );

  // 逐级返回的落点：逐把 → 原场小结（没有上一页时按原档案与原场次重建），
  // 线路历史的正常路径仍是系统返回上一页（逐把）。
  resetWxLog();
  firstAttempts.backToList();
  assert.equal(wxLog.backs.length, 1);
  wxLog.backs[0].fail();
  assert.deepEqual(wxLog.redirects.map(item => item.url), [
    '/pages/training-summary/training-summary?archiveId=' +
      archiveId +
      '&sessionId=' +
      firstSessionId
  ]);

  // 浏览全程零写入：档案逐字节不变，活动场与活动线路保持原值，不新增本机键。
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '小结与逐把、线路历史都不写档案');
  assert.deepEqual([...storage.keys()].sort(), keysBefore, '浏览不新增本机键');
  assert.equal(archiveOf().activeSessionId, activeBefore.sessionId);
  assert.equal(archiveOf().activeRouteId, activeBefore.routeId);

  // 返回首页继续原活动场与原线路（浏览不切换当前选择）。
  const home = openHome();
  home.refreshTrainingEntry();
  assert.equal(home.data.activeSession.id, secondSessionId);
  assert.equal(home.data.activeSession.routeName, 'A 线');
  assert.equal(home.data.activeSession.attemptCountText, '1 把');
});

test('T046 缺归属与旧入口：不从当前场顶替，返回文案按实际入口', () => {
  const sessionPage = startTrainingFromHome('缺参岩馆');
  const sessionId = sessionPage.data.activeSession.id;
  const aId = addRouteThroughPage(sessionPage, '缺参线', { grade: 'V3' });
  const record = openRecordFor(aId, sessionId);
  recordThroughPage(record, 'fail');
  const archiveId = archiveOf().archiveId;
  const rawBefore = storage.get(ARCHIVE_KEY);

  // 小结入口缺档案归属：只给可见原因，不打开任何场次的逐把，也不写盘。
  const summaryPage = createPage(summaryPageDefinition);
  summaryPage.onLoad({ sessionId });
  assert.equal(summaryPage.data.summaryReady, false);
  resetWxLog();
  summaryPage.openSummaryRoute(tapDataset({ routeId: aId }));
  assert.equal(wxLog.navigations.length, 0, '缺档案归属不打开逐把');

  // 逐把页缺档案参数：仿照小结入口，仍只显示原因与「返回原场小结」。
  const missing = createPage(attemptsDefinition);
  missing.onLoad({ sessionId, routeId: aId, from: 'summary' });
  assert.match(missing.data.contextError, /缺少档案参数/);
  assert.equal(missing.data.fromSummary, true);
  assert.equal(missing.data.backLabel, '返回原场小结');
  assert.equal(missing.data.attempts.length, 0);
  missing.openRouteHistory();
  assert.equal(wxLog.navigations.length, 0, '缺参时不打开线路历史');

  // 旧入口（没有 from=summary）保持原返回文案与场内页落点，行为不变。
  const legacy = createPage(attemptsDefinition);
  legacy.onLoad({ archiveId, sessionId, routeId: aId });
  assert.equal(legacy.data.contextError, '');
  assert.equal(legacy.data.fromSummary, false);
  assert.equal(legacy.data.backLabel, '返回单线记录');
  resetWxLog();
  legacy.backToList();
  assert.equal(wxLog.backs.length, 1);
  wxLog.backs[0].fail();
  assert.deepEqual(wxLog.redirects.map(item => item.url), [
    '/pages/training-session/training-session'
  ]);

  // 旧渲染的迟到点击带的是另一条线：只刷新本页，不打开线路历史。
  resetWxLog();
  legacy.openRouteHistory(tapDataset({ archiveId, routeId: 'route-of-another-line' }));
  assert.equal(wxLog.navigations.length, 0, '过期入口不打开线路历史');
  assert.match(legacy.data.notice, /不属于本页这一条线/);

  // 同名异线：别的档案的同名 routeId 不会被拿来展示（串档只给原因）。
  const foreign = createPage(attemptsDefinition);
  foreign.onLoad({
    archiveId: 'archive-of-another-profile',
    sessionId,
    routeId: aId,
    from: 'summary'
  });
  assert.match(foreign.data.contextError, /另一份本机档案/);
  assert.equal(foreign.data.attempts.length, 0);
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '缺参、串档与旧入口都不写档');
});

test('T046 迟到的小结行事件按原场次核对：切到第二场后送达的第一场事件不会误开第二场', () => {
  // 同一长期线路（顶绳可重复记把）在两场各有一把；第二场是当前场次。
  const first = store.startSession({
    gymName: '迟到岩馆',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 9, 0)
  });
  assert.equal(first.ok, true, first.error);
  const created = store.createRoute({
    sessionId: first.session.id,
    name: '共享耐力线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;
  const firstSaved = store.saveAttempt({
    sessionId: first.session.id,
    routeId,
    result: 'fail',
    note: '第一场备注',
    now: new Date(2026, 10, 10, 9, 5)
  });
  assert.equal(firstSaved.ok, true, firstSaved.error);

  const second = store.startSession({
    gymName: '迟到岩馆',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 10, 0)
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.linkRouteToSession(second.session.id, routeId).ok, true);
  const secondSaved = store.saveAttempt({
    sessionId: second.session.id,
    routeId,
    result: 'fail',
    note: '第二场备注',
    now: new Date(2026, 10, 10, 10, 5)
  });
  assert.equal(secondSaved.ok, true, secondSaved.error);

  const archiveId = archiveOf().archiveId;
  const rawBefore = storage.get(ARCHIVE_KEY);

  // 第一场小结渲染出的行事件：原档案 ID、第一场场次 ID 与长期线路 ID 一起带走。
  const page = createPage(summaryPageDefinition);
  page.onLoad({ sessionId: first.session.id, archiveId });
  assert.equal(page.data.summarySessionId, first.session.id);
  const firstRow = page.data.summaryRows.find(row => row.routeId === routeId);
  assert.ok(firstRow, '第一场小结里有这条共享线路');
  assert.equal(firstRow.archiveId, archiveId);
  assert.equal(firstRow.sessionId, first.session.id);
  const firstRowEvent = tapDataset({
    archiveId: firstRow.archiveId,
    sessionId: firstRow.sessionId,
    routeId: firstRow.routeId
  });

  // 用户把小结点到第二场，第一场那一行的点击这时才送达（迟到事件）。
  const secondIndex = page.data.summarySessionOptions.findIndex(
    option => option.id === second.session.id
  );
  assert.notEqual(secondIndex, -1);
  page.onSummarySessionChange({ detail: { value: String(secondIndex) } });
  assert.equal(page.data.summarySessionId, second.session.id);
  // 旧版处理器在这里取 this.data.summarySessionId（此时已是第二场），会把第一场的
  // 行事件当成第二场的入口打开——这正是本条回归要拦住的误开。
  assert.equal(page._viewSessionId, second.session.id, '当前所看场次已切到第二场');

  resetWxLog();
  page.openSummaryRoute(firstRowEvent);
  assert.equal(wxLog.navigations.length, 0, '迟到的第一场行事件被拒绝，不借用第二场');
  assert.match(page.data.notice, /不一致/);
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '拒绝跳转时档案逐字节不变');

  // 正常路径：第一场与第二场各自从自己渲染出的行事件打开自己的原场逐把。
  const firstPage = createPage(summaryPageDefinition);
  firstPage.onLoad({ sessionId: first.session.id, archiveId });
  const liveFirstRow = firstPage.data.summaryRows.find(row => row.routeId === routeId);
  resetWxLog();
  firstPage.openSummaryRoute(
    tapDataset({
      archiveId: liveFirstRow.archiveId,
      sessionId: liveFirstRow.sessionId,
      routeId: liveFirstRow.routeId
    })
  );
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-attempts/training-attempts?archiveId=' +
      archiveId +
      '&sessionId=' +
      first.session.id +
      '&routeId=' +
      routeId +
      '&from=summary'
  ]);

  const secondPage = createPage(summaryPageDefinition);
  secondPage.onLoad({ sessionId: second.session.id, archiveId });
  const liveSecondRow = secondPage.data.summaryRows.find(row => row.routeId === routeId);
  resetWxLog();
  secondPage.openSummaryRoute(
    tapDataset({
      archiveId: liveSecondRow.archiveId,
      sessionId: liveSecondRow.sessionId,
      routeId: liveSecondRow.routeId
    })
  );
  assert.deepEqual(wxLog.navigations.map(item => item.url), [
    '/pages/training-attempts/training-attempts?archiveId=' +
      archiveId +
      '&sessionId=' +
      second.session.id +
      '&routeId=' +
      routeId +
      '&from=summary'
  ]);

  // 行事件在真实 WXML 里带齐三个归属，不是运行时才去猜当前所看场次。
  const summaryWxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-summary', 'training-summary.wxml'),
    'utf8'
  );
  assert.match(
    summaryWxml,
    /data-archive-id="\{\{item\.archiveId\}\}"[\s\S]{0,160}data-session-id="\{\{item\.sessionId\}\}"[\s\S]{0,160}data-route-id="\{\{item\.routeId\}\}"[\s\S]{0,120}bindtap="openSummaryRoute"/
  );
});

test('T046 本场逐把页：只读身份、线路历史入口与按入口的返回文案都在真实绑定里', () => {
  const wxml = fs.readFileSync(ATTEMPTS_WXML, 'utf8');
  const wxss = fs.readFileSync(ATTEMPTS_WXSS, 'utf8');
  const source = fs.readFileSync(ATTEMPTS_JS, 'utf8');

  // 原日期 · 岩馆 · 场次序号仍在本页头部，逐把只在它下面。
  assert.match(
    wxml,
    /id="attempts-session-meta"[\s\S]{0,120}\{\{activeSession\.dateText\}\}[\s\S]{0,60}\{\{activeSession\.gymName\}\}[\s\S]{0,60}\{\{activeSession\.label\}\}/
  );
  // 线路历史入口：用户主动点开，带本页的原档案 ID 与长期线路 ID。
  assert.match(
    wxml,
    /id="open-route-history"[\s\S]{0,300}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,220}bindtap="openRouteHistory"/
  );
  assert.equal(typeof attemptsDefinition.openRouteHistory, 'function');
  assert.match(source, /pages\/training-route\/training-route/);
  // 入口排在把次列表之前、线路头之后：先认归属，再决定要不要进跨场历史。
  const routeAt = wxml.indexOf('id="attempts-route"');
  const historyAt = wxml.indexOf('id="open-route-history"');
  const listAt = wxml.indexOf('id="attempts-list"');
  assert.ok(routeAt !== -1 && historyAt !== -1 && listAt !== -1);
  assert.ok(routeAt < historyAt && historyAt < listAt);

  // 返回文案随入口变化（小结入口 → 返回原场小结），错误卡与页底都用同一份文案。
  assert.match(wxml, /id="attempts-back"[\s\S]{0,120}\{\{backLabel\}\}/);
  assert.match(wxml, /id="attempts-back-foot"[\s\S]{0,120}\{\{backLabel\}\}/);
  assert.match(wxml, /id="attempts-context-error"[\s\S]{0,400}\{\{contextErrorHint\}\}/);
  assert.equal(typeof attemptsDefinition.entryCopy, 'function');

  // 只读页：没有 storage 写入，也没有云与文件系统调用。
  assert.doesNotMatch(source, /setStorageSync|wx\.cloud|getFileSystemManager/);
  // 线路历史入口的命中区与文字样式沿用本页文字按钮（至少 44px）。
  assert.match(
    wxss,
    /\.attempts-history-action \{[\s\S]{0,200}min-height: 44px|\.text-button \{[\s\S]{0,120}min-height: 44px/
  );
});

// ------------------------------------------------------------------ *
// T044 逐把：一把一框
// ------------------------------------------------------------------ *

test('T044 逐把一把一框：完攀深绿、未完成深橙，描边 + 浅底 + 深底白字状态可辨', () => {
  const wxml = fs.readFileSync(ATTEMPTS_WXML, 'utf8');
  const wxss = fs.readFileSync(ATTEMPTS_WXSS, 'utf8');
  const declarationsOf = selector =>
    [...wxss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1].split(',').map(text => text.trim()).includes(selector))
      .map(match => match[2])
      .join('\n');

  // 一眼一框：卡框落在每一把上，卡与卡之间留 12px。
  assert.match(declarationsOf('.attempts-list'), /gap:\s*12px/);
  assert.match(declarationsOf('.attempt-item'), /border:\s*1px solid #D7DED9/, '兜底中性卡框');
  assert.match(declarationsOf('.attempt-item'), /border-radius:\s*8rpx/);
  assert.match(declarationsOf('.attempt-row-tap'), /min-height:\s*44px/, '整卡命中区至少 44 逻辑像素');
  assert.doesNotMatch(declarationsOf('.attempt-item'), /border-bottom/, '不再用连续分隔线');

  // 两种结果各一套：完攀深绿、未完成深橙；描边与浅色底同色系。
  assert.match(declarationsOf('.attempt-item-send'), /border-color:\s*#1F5948/);
  assert.match(declarationsOf('.attempt-item-send'), /background-color:\s*#EAF2EC/);
  assert.match(declarationsOf('.attempt-item-fail'), /border-color:\s*#B04A1C/);
  assert.match(declarationsOf('.attempt-item-fail'), /background-color:\s*#FBEEE3/);
  // 结果是深底白字，并把「完攀 / 未完成」写出来。
  assert.match(declarationsOf('.attempt-result'), /color:\s*#FFFFFF/);
  assert.match(declarationsOf('.attempt-result-send'), /background-color:\s*#1F5948/);
  assert.match(declarationsOf('.attempt-result-fail'), /background-color:\s*#B04A1C/);

  // 行模板把结果映射到卡框与结果块，文字仍取原 resultText。
  assert.match(
    wxml,
    /class="attempt-item \{\{item\.isSend \? 'attempt-item-send' : 'attempt-item-fail'\}\}"/
  );
  assert.match(
    wxml,
    /class="attempt-result \{\{item\.isSend \? 'attempt-result-send' : 'attempt-result-fail'\}\}">\{\{item\.resultText\}\}/
  );

  // 真实数据：未完成与完攀各一把，各占一框，状态文字与结果一一对应。
  const started = store.startSession({
    gymName: '卡框岩馆',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 9, 0)
  });
  assert.equal(started.ok, true, started.error);
  const created = store.createRoute({
    sessionId: started.session.id,
    name: '卡框顶绳线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(created.ok, true, created.error);
  const first = store.saveAttempt({
    sessionId: started.session.id,
    routeId: created.route.id,
    result: 'fail',
    now: new Date(2026, 10, 8, 9, 5)
  });
  const second = store.saveAttempt({
    sessionId: started.session.id,
    routeId: created.route.id,
    result: 'send',
    now: new Date(2026, 10, 8, 9, 10)
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);

  const page = openAttemptsFor(started.session.id, created.route.id);
  assert.deepEqual(page.data.attempts.map(row => row.id), [first.attempt.id, second.attempt.id]);
  assert.deepEqual(page.data.attempts.map(row => row.resultText), ['未完成', '完攀']);
  assert.deepEqual(page.data.attempts.map(row => row.isSend), [false, true]);
});

// ------------------------------------------------------------------ *
// T045 单线同页记把：最新在前、原行编辑、行内更正与撤回/恢复
// ------------------------------------------------------------------ *

/** 现场一次训练：A 线三把（第 3 把完攀带备注）。 */
function seedInlineAttempts() {
  const started = store.startSession({
    gymName: '同页岩馆',
    date: '2026-11-09',
    now: new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const session = started.session;
  const created = store.createRoute({
    sessionId: session.id,
    name: '同页 A 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(created.ok, true, created.error);
  const route = created.route;
  const save = (result, note, at) => {
    const outcome = store.saveAttempt({
      sessionId: session.id,
      routeId: route.id,
      result,
      note: note || '',
      now: at
    });
    assert.equal(outcome.ok, true, outcome.error);
    return outcome.attempt;
  };
  // 完攀会锁住这条抱石线，因此先把前两把交给调用方做异线/另一场的对照，
  // 再在同一份档案上补第三把完攀。
  const attempts = [
    save('fail', '', new Date(2026, 10, 9, 9, 5)),
    save('fail', '第二把现场备注', new Date(2026, 10, 9, 9, 10))
  ];
  return {
    session,
    route,
    attempts,
    saveThird: () =>
      attempts.push(save('send', '第三把现场备注', new Date(2026, 10, 9, 9, 20)))
  };
}

test('T045 现场同页把次：最新在前、原编号稳定，编辑与视频只作用于所点那一把', () => {
  const { session, route, attempts, saveThird } = seedInlineAttempts();

  // 同色同级另一条线、另一场同一长期线路：都不许串进本页。
  const twin = store.createRoute({
    sessionId: session.id,
    name: '同色同级 B 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(twin.ok, true, twin.error);
  const twinSave = store.saveAttempt({
    sessionId: session.id,
    routeId: twin.route.id,
    result: 'fail',
    note: 'B 线备注',
    now: new Date(2026, 10, 9, 9, 30)
  });
  assert.equal(twinSave.ok, true, twinSave.error);
  const other = store.startSession({
    gymName: '另一场馆',
    date: '2026-11-10',
    now: new Date(2026, 10, 10, 8, 0)
  });
  assert.equal(other.ok, true, other.error);
  assert.equal(store.linkRouteToSession(other.session.id, route.id).ok, true);
  const otherSave = store.saveAttempt({
    sessionId: other.session.id,
    routeId: route.id,
    result: 'fail',
    note: '另一场备注',
    now: new Date(2026, 10, 10, 8, 20)
  });
  assert.equal(otherSave.ok, true, otherSave.error);

  // 异线/另一场的对照已落盘，再补本线第三把完攀（抱石只允许一次有效完攀）。
  saveThird();

  const page = openRecordFor(route.id, session.id);
  // 最新在前，原编号不因显示顺序或撤回而改变。
  assert.deepEqual(
    page.data.attemptCards.map(row => row.label),
    ['第 3 把', '第 2 把', '第 1 把']
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [attempts[2].id, attempts[1].id, attempts[0].id]
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.resultText),
    ['完攀', '未完成', '未完成']
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.timeText),
    ['09:20', '09:10', '09:05']
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.note),
    ['第三把现场备注', '第二把现场备注', '']
  );
  // 同色同级异线与另一场不串入。
  assert.equal(
    page.data.attemptCards.some(
      row => row.id === twinSave.attempt.id || row.id === otherSave.attempt.id
    ),
    false,
    '异线与另一场的把次不进入本页'
  );
  assert.equal(
    page.data.attemptCards.some(row => /B 线备注|另一场备注/.test(row.note)),
    false
  );
  // T050 返工：现场只给最新一把一个文字「撤销」；较早把次没有撤销入口。
  assert.equal(page.data.attemptCards[0].canUndo, true);
  assert.equal(page.data.attemptCards[0].undoText, '撤销');
  assert.equal(page.data.attemptCards[0].showWithdraw, true, '最新一把就是最近一把时给「撤销」');
  assert.equal(page.data.attemptCards[1].canUndo, false, '撤销只给最近一把');
  assert.equal(page.data.attemptCards[1].undoText, '');
  assert.equal(page.data.attemptCards[1].showWithdraw, false, '较早把次没有「撤销」');
  // 现场不再派生「更多」菜单与说明槽；更正资格仍是档案层只读数据，现场不渲染入口。
  assert.equal('showMenu' in page.data.attemptCards[0], false, '现场不再有「更多」菜单数据');
  assert.equal('actionHint' in page.data.attemptCards[0], false, '现场不再有纠错说明槽');
  assert.equal(page.data.attemptCards[0].correctable, true, '更正资格仍按原档案层派生');

  // 行内编辑：点哪一把就只打开哪一把，保存只改这一把。
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.attemptId, attempts[0].id);
  assert.equal(page.data.noteEditor.attemptLabel, '第 1 把');
  page.onNoteInput({ detail: { value: '第一把补上的备注' } });
  page.saveNote();
  assert.equal(page.data.noteEditor, null);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    '第一把补上的备注'
  );
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[2].id).note,
    '第三把现场备注',
    '没点的那一把备注不变'
  );

  // 视频沿用原把次视频页：四个 ID 一起带过去。
  page.openAttemptVideo(tapDataset({ attemptId: attempts[1].id }));
  const videoUrl = wxLog.navigations.at(-1).url;
  const params = new URL(videoUrl, 'https://example.invalid').searchParams;
  assert.equal(new URL(videoUrl, 'https://example.invalid').pathname, '/pages/attempt-video/attempt-video');
  assert.equal(params.get('archiveId'), archiveOf().archiveId);
  assert.equal(params.get('sessionId'), session.id);
  assert.equal(params.get('routeId'), route.id);
  assert.equal(params.get('attemptId'), attempts[1].id);
});

test('T045 行内改成未完成与撤回/恢复：总数、编号与备注保持，重开仍按原把次', async () => {
  const { session, route, attempts, saveThird } = seedInlineAttempts();
  saveThird();
  let page = openRecordFor(route.id, session.id);
  const third = attempts[2];

  // 取消更正：一个字节都不写。
  const rawBefore = storage.get(ARCHIVE_KEY);
  queueModal('cancel');
  assert.equal(
    await page.correctSend(tapDataset({ attemptId: third.id })),
    null
  );
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '取消不写盘');

  // 确认更正：把数不变，完攀少一，原编号/备注/时间不动，原行变成只读回读。
  const prompt = modalLog.calls.at(-1);
  assert.match(prompt.content, /第 3 把/);
  assert.match(prompt.content, /完攀/);
  assert.match(prompt.content, /未完成/);
  assert.match(prompt.content, /2026-11-09/);
  await page.correctSend(tapDataset({ attemptId: third.id }));
  assert.equal(page.data.routeCountText, '3 把', '更正保持总数');
  assert.equal(page.data.routeCompleted, false, '完攀减一');
  const corrected = page.data.attemptCards.find(row => row.id === third.id);
  assert.equal(corrected.resultText, '未完成');
  assert.equal(corrected.note, '第三把现场备注', '说明性字段不动');
  assert.equal(corrected.correctable, false);
  assert.match(corrected.correctStatusText, /已改为未完成/);
  assert.deepEqual(
    page.data.attemptCards.map(row => row.label),
    ['第 3 把', '第 2 把', '第 1 把'],
    '原编号保持'
  );

  // 重开：同一份档案读出同样的顺序、编号与备注。
  page = openRecordFor(route.id, session.id);
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [attempts[2].id, attempts[1].id, attempts[0].id]
  );
  assert.equal(page.data.attemptCards[0].note, '第三把现场备注');
  assert.equal(page.data.attemptCards[0].resultText, '未完成');

  // 撤销最近一把（T050 返工）：总数减一，这一把移出本场有效逐把列表，前一把补位；
  // 原把次仍按原 ID、原序号与备注留在档案里（只多一个撤回标记）。
  const row = page.data.attemptCards[0];
  page.undoLatestAttempt(rowEvent(row));
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.notice, '已撤销第 3 把');
  assert.deepEqual(
    page.data.attemptCards.map(item => item.id),
    [attempts[1].id, attempts[0].id],
    '已撤销的一把离开现场列表，前一把补位'
  );
  assert.deepEqual(
    page.data.attemptCards.map(item => item.label),
    ['第 2 把', '第 1 把'],
    '补位的把按有效顺序显示原编号'
  );
  assert.equal(page.data.attemptCards[0].showWithdraw, false, '撤销后前一把不再给撤销入口');
  assert.equal(page.data.attemptCards.some(item => item.id === third.id), false);
  assert.equal(page.data.recentAttempt.attemptId, third.id, '最近一把仍是刚撤销的原把');
  assert.equal(page.data.recentAttempt.canRestore, true, '档案层原恢复能力仍在');
  const persistedUndone = archiveOf().attempts.find(item => item.id === third.id);
  assert.equal(typeof persistedUndone.undoneAt, 'string', '原把按原 ID 留下撤回标记');
  assert.equal(persistedUndone.note, '第三把现场备注', '撤销保留原备注');

  // 恢复原把（走后一个页面的原方法驱动档案层）：编号、备注与时间都回到原样。
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  assert.equal(page.data.routeCountText, '3 把');
  const restored = page.data.attemptCards.find(item => item.id === third.id);
  assert.equal(restored.isUndone, false);
  assert.equal(restored.note, '第三把现场备注');
  assert.equal(restored.timeText, '09:20');
});

// ------------------------------------------------------------------ *
// T048 单线逐把紧凑布局：最新一把置顶、上一把自动收成短行
// ------------------------------------------------------------------ *

/** 一条顶绳线（可重复完攀）＋按顺序记下的把次，全部走正式档案层。 */
function seedRopeAttempts(results, notes, options) {
  const config = options || {};
  const started = store.startSession({
    gymName: config.gymName || '岩馆 T048',
    now: new Date(2026, 10, 10, 18, 0)
  });
  const created = store.createRoute({
    sessionId: started.archive.activeSessionId,
    name: config.routeName || 'T048 顶绳线',
    climbType: '顶绳',
    grade: '5.10a',
    colorName: '蓝色'
  });
  assert.equal(created.ok, true, created.error);
  const attempts = results.map((result, index) => {
    const saved = store.saveAttempt({
      sessionId: started.archive.activeSessionId,
      routeId: created.route.id,
      result,
      note: notes && notes[index] ? notes[index] : '',
      now: new Date(2026, 10, 10, 18, 5 + index * 4)
    });
    assert.equal(saved.ok, true, saved.error);
    return saved.attempt;
  });
  return { session: store.loadState().archive.sessions[0], route: created.route, attempts };
}

function toggleRow(page, row) {
  return page.toggleAttemptRow(
    tapDataset({
      attemptId: row.id || row.attemptId,
      archiveId: archiveOf().archiveId,
      sessionId: page.data.activeSession.id,
      routeId: page.data.selectedRoute.id
    })
  );
}

test('T048 第 4 把保存成功后置顶，第 3 把自动收成短行；展开的旧行随之收起，原编号与备注不变', () => {
  const seeded = seedRopeAttempts(['fail', 'send', 'fail'], ['', '第二把备注', '第三把备注']);
  const page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(page.data.attemptCards.length, 3);

  // 先展开第 1 把：旧行详情按原把次打开。
  toggleRow(page, seeded.attempts[0]);
  assert.equal(page.data.expandedAttemptId, seeded.attempts[0].id);

  // 记第 4 把（页面入口）。
  tick();
  recordThroughPage(page, 'fail');
  const cards = page.data.attemptCards;
  assert.equal(cards.length, 4, '成功保存只多一把');
  assert.equal(cards[0].label, '第 4 把', '第 4 把置顶');
  assert.equal(cards[0].isLatest, true);
  assert.equal(cards[0].expanded, true, '新的一把完整展示');
  assert.equal(cards[1].id, seeded.attempts[2].id, '上一把仍在原位置');
  assert.equal(cards[1].label, '第 3 把', '原编号不变');
  assert.equal(cards[1].note, '第三把备注', '原备注不变');
  assert.equal(cards[1].expanded, false, '上一把自动收成短行');
  assert.equal(cards[1].canToggle, true);
  assert.equal(page.data.expandedAttemptId, '', '新一把落盘后展开态回到只有最新一把');
  assert.equal(
    page.data.attemptCards.filter(row => row.expanded).length,
    1,
    '同一时刻只有最新一把完整展示'
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [cards[0].id, seeded.attempts[2].id, seeded.attempts[1].id, seeded.attempts[0].id],
    '按原序号倒序'
  );
});

test('T048 保存失败与取消不生成新卡、保持原展开；重试成功只切换一次', () => {
  const seeded = seedRopeAttempts(['fail', 'fail', 'fail'], ['', '', '第三把备注']);
  const page = openRecordFor(seeded.route.id, seeded.session.id);
  toggleRow(page, seeded.attempts[0]);
  const expandedBefore = page.data.expandedAttemptId;
  const latestBefore = page.data.attemptCards[0].id;

  // 写前失败：这一把留在「待保存」，不生成第 4 张卡，最新一把与展开态都保持原样。
  tick();
  armSetFailAt(1);
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.equal(page.data.pendingRows.length, 1, '失败的那一把在待保存行');
  assert.equal(page.data.attemptCards.length, 3, '失败不生成新卡');
  assert.equal(page.data.attemptCards[0].id, latestBefore, '最新一把没有换人');
  assert.equal(page.data.expandedAttemptId, expandedBefore, '失败不改展开态');
  assert.equal(page.data.attemptCards.find(row => row.id === expandedBefore).expanded, true);

  // 取消备注编辑：展开的旧行仍留在原处，不写盘、不生成新卡，待保存的一把照旧。
  page.openNoteEditor(tapDataset({ attemptId: seeded.attempts[0].id }));
  assert.equal(page.data.noteEditor.attemptId, seeded.attempts[0].id);
  page.onNoteInput({ detail: { value: '还没保存的草稿' } });
  const bytesBeforeCancel = storage.get(ARCHIVE_KEY);
  page.cancelNote(
    tapDataset({
      attemptId: page.data.noteEditor.attemptId,
      editVersion: page.data.noteEditor.version
    })
  );
  assert.equal(page.data.noteEditor, null);
  assert.equal(page.data.attemptCards.length, 3, '取消不生成新卡');
  assert.equal(page.data.expandedAttemptId, expandedBefore, '取消不改展开态');
  assert.equal(storage.get(ARCHIVE_KEY), bytesBeforeCancel, '取消一个字都不写');

  // 按原待保存行重试成功：第 4 把置顶，上一把收成短行，展开的旧行也收起。
  const opId = page.data.pendingRows[0].opId;
  tick();
  page.retryPendingAttempt(
    tapDataset({
      opId,
      archiveId: archiveOf().archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.hasPending, false);
  assert.equal(page.data.attemptCards.length, 4, '重试成功只多一把');
  assert.equal(page.data.attemptCards[0].isLatest, true);
  assert.equal(page.data.attemptCards[1].id, seeded.attempts[2].id, '原来最新的一把收成短行');
  assert.equal(page.data.attemptCards[1].expanded, false);
  assert.equal(page.data.expandedAttemptId, '');

  // 再刷新（返回本页 / onShow）也不多切一次：最新一把仍是同一把，旧行保持短行。
  const latestAfterRetry = page.data.attemptCards[0].id;
  page.refreshView();
  page.onShow();
  assert.equal(page.data.attemptCards[0].id, latestAfterRetry);
  assert.equal(page.data.attemptCards[1].expanded, false);
  assert.equal(page.data.attemptCards.filter(row => row.expanded).length, 1, '仍然只有最新一把完整');
});

test('T048 撤回第 3 把后再记一把失败：原第 3 把留在原卡，待保存不提升第 2 把，重试成功才切换', () => {
  const seeded = seedRopeAttempts(['fail', 'send', 'fail'], ['', '第二把备注', '第三把备注']);
  let page = openRecordFor(seeded.route.id, seeded.session.id);

  // 撤销最近的第 3 把（T050 返工）：这一把离开现场有效列表，前一把补位；原把与备注
  // 仍按原 ID 留在档案里。
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.notice, '已撤销第 3 把');
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [seeded.attempts[1].id, seeded.attempts[0].id],
    '撤销成功后这一把移出逐把列表，前一把补位'
  );
  assert.equal(page.data.attemptCards[0].label, '第 2 把');
  assert.equal(page.data.attemptCards[0].note, '第二把备注', '补位的前一把备注跟着原把');
  assert.equal(page.data.attemptCards[0].showWithdraw, false, '补位的前一把不给撤销入口');
  assert.equal(page.data.recentAttempt.attemptId, seeded.attempts[2].id);
  assert.equal(page.data.recentAttempt.canRestore, true, '没有待保存时档案层恢复能力可用');
  const withdrawnPersisted = archiveOf().attempts.find(
    item => item.id === seeded.attempts[2].id
  );
  assert.equal(typeof withdrawnPersisted.undoneAt, 'string');
  assert.equal(withdrawnPersisted.note, '第三把备注', '撤销保留原备注');

  // 记新一把未完成，第二段写盘失败：这一把进入待保存，不生成新卡。
  tick();
  armSetFailAt(2); // 第一段待保存标记已落盘，第二段提交失败
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.equal(page.data.pendingRows.length, 1, '失败的那一把在待保存行');
  assert.equal(page.data.hasPending, true);
  assert.equal(page.data.routeCountText, '2 把 · 1 把待保存', '有效计数不变');
  assert.equal(
    page.data.pendingRows[0].label,
    '第 3 把',
    '待保存显示号按有效顺序走：落盘后就是第 3 把'
  );

  const expectOriginalCards = () => {
    assert.deepEqual(
      page.data.attemptCards.map(row => row.label),
      ['第 2 把', '第 1 把'],
      '已撤销的一把不再占现场行，其他有效把次不跳号'
    );
    assert.deepEqual(
      page.data.attemptCards.map(row => row.id),
      [seeded.attempts[1].id, seeded.attempts[0].id],
      '待保存不生成新卡，也不把前一把提前成第 3 把'
    );
    assert.equal(page.data.attemptCards[0].isLatest, true, '补位的第 2 把是完整卡');
    assert.equal(page.data.attemptCards[0].isUndone, false);
    assert.equal(page.data.attemptCards[0].note, '第二把备注', '前一把备注不变');
    assert.equal(page.data.attemptCards.length, 2, '已撤销的一把不在现场列表');
    // pending 门禁仍控制动作：撤销入口不开放。
    assert.equal(page.data.attemptCards[0].canUndo, false);
    assert.equal(page.data.attemptCards[0].showWithdraw, false);
  };

  expectOriginalCards();

  // 冷重开（新页面实例读同一份档案）仍是同一层级：撤回行还是完整卡，新一把仍待保存。
  page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(page.data.pendingRows.length, 1, '待保存意图重开后仍在');
  expectOriginalCards();

  // 按原待保存行重试成功：只有新一把一条置顶；不再处于恢复范围的旧撤回把按原规则离开现场。
  const opId = page.data.pendingRows[0].opId;
  tick();
  page.retryPendingAttempt(
    tapDataset({
      opId,
      archiveId: archiveOf().archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.hasPending, false);
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(page.data.attemptCards.length, 3);
  assert.equal(page.data.attemptCards[0].label, '第 3 把', '新一把按有效顺序显示第 3 把');
  assert.equal(page.data.attemptCards[0].isLatest, true);
  assert.equal(page.data.attemptCards[0].isUndone, false);
  assert.equal(
    page.data.attemptCards.filter(row => row.label === '第 3 把').length,
    1,
    '重试成功只落一把，显示号也只出现一次'
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.id),
    [page.data.attemptCards[0].id, seeded.attempts[1].id, seeded.attempts[0].id],
    '新一把置顶，其后按有效顺序倒序，旧撤回把不再占据现场'
  );
  assert.deepEqual(
    page.data.attemptCards.map(row => row.label),
    ['第 3 把', '第 2 把', '第 1 把'],
    '撤回第 3 把后新记的一把接第 3 把，原第 1、2 把不动'
  );
  assert.equal(
    page.data.attemptCards.some(row => row.id === seeded.attempts[2].id),
    false,
    '已撤回且不再是最近一把的原第 3 把按原规则离开现场'
  );
  // 其他场次/线路与存储不变：原把次仍按原 ID 留在档案里。
  assert.equal(
    archiveOf().attempts.find(item => item.id === seeded.attempts[2].id).note,
    '第三把备注'
  );
});

// ------------------------------------------------------------------ *
// T048/T050 返工：撤回后新记的显示编号按有效顺序连续（各展示端共用一份投影）
// ------------------------------------------------------------------ *

test('T048 撤回第 2 把后重记一把：新 ID 显示第 2 把，原第 1 把、备注与两段视频归属不串', () => {
  const seeded = seedRopeAttempts(['fail', 'fail'], ['第一把备注', '第二把备注'], {
    gymName: '岩馆 T050 重记'
  });
  const firstId = seeded.attempts[0].id;
  const secondId = seeded.attempts[1].id;
  const archiveId = archiveOf().archiveId;
  writeT049VideoClips([
    {
      clipId: 'clip-rework-first',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: firstId
    },
    {
      clipId: 'clip-rework-second',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: secondId
    }
  ]);
  const indexRaw = storage.get(VIDEO_INDEX_KEY);

  const page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.deepEqual(page.data.attemptCards.map(row => row.label), ['第 2 把', '第 1 把']);
  assert.equal(page.data.attemptCards[0].videoEntryText, '回看视频', '第 2 把自己有片');
  assert.equal(page.data.attemptCards[1].note, '第一把备注');

  // 撤销第 2 把（T050 返工）：这一把离开现场有效列表，原第 1 把补位；有效把数只剩 1，
  // 原第 2 把仍按原 ID 与备注留在档案里，视频归属不转移。
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.deepEqual(
    page.data.attemptCards.map(row => [row.id, row.label]),
    [[firstId, '第 1 把']],
    '已撤销的一把移出逐把列表，前一把补位'
  );
  assert.equal(page.data.attemptCards[0].showWithdraw, false, '补位的前一把不给撤销入口');
  assert.equal(page.data.recentAttempt.attemptId, secondId);
  assert.equal(page.data.recentAttempt.canRestore, true);
  const persistedSecondUndone = archiveOf().attempts.find(row => row.id === secondId);
  assert.equal(persistedSecondUndone.note, '第二把备注', '撤销保留原备注');
  assert.equal(typeof persistedSecondUndone.undoneAt, 'string');
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '撤销不改视频索引');

  // 记新一把未完成，第二段写盘失败：只进入待保存，不凭空多出有效把。
  tick();
  armSetFailAt(2);
  page.recordAttempt(tapResult('fail'));
  armSetFailAt(0);
  assert.equal(page.data.routeCountText, '1 把 · 1 把待保存');
  assert.equal(page.data.pendingRows[0].label, '第 2 把', '待保存显示号按落盘后的有效顺序');
  assert.deepEqual(
    page.data.attemptCards.map(row => row.label),
    ['第 1 把'],
    '失败期间只列仍然有效的原第 1 把'
  );

  // 冷重开：待保存意图与编号都不变，已撤销的一把仍不在现场列表。
  let reopened = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(reopened.data.pendingRows.length, 1);
  assert.equal(reopened.data.pendingRows[0].label, '第 2 把');
  assert.deepEqual(
    reopened.data.attemptCards.map(row => row.id),
    [firstId],
    '重开后仍按已保存的有效把次展示'
  );

  // 重试成功：只落一条，新一把显示第 2 把，原第 2 把按规则离开现场。
  const opId = reopened.data.pendingRows[0].opId;
  tick();
  reopened.retryPendingAttempt(
    tapDataset({
      opId,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(reopened.data.hasPending, false);
  assert.equal(reopened.data.routeCountText, '2 把');
  const fresh = reopened.data.attemptCards[0];
  assert.notEqual(fresh.id, secondId, '新一把另取唯一 ID，不复用已撤回的原 ID');
  assert.notEqual(fresh.id, firstId);
  assert.equal(fresh.label, '第 2 把', '新一把显示第 2 把');
  assert.equal(fresh.isUndone, false);
  assert.equal(fresh.videoEntryText, '＋ 添加视频', '新一把没有借用原第 2 把的视频');
  assert.deepEqual(
    reopened.data.attemptCards.map(row => [row.label, row.id]),
    [
      ['第 2 把', fresh.id],
      ['第 1 把', firstId]
    ],
    '有效顺序连续编号，原第 1 把不挪号'
  );
  assert.equal(
    reopened.data.attemptCards.some(row => row.id === secondId),
    false,
    '已撤回且不再是最近一把的原第 2 把离开现场'
  );

  // 原第 1 把的备注与视频、原第 2 把的档案记录都保持原 ID。
  const firstCard = reopened.data.attemptCards.find(row => row.id === firstId);
  assert.equal(firstCard.note, '第一把备注');
  assert.equal(firstCard.videoEntryText, '回看视频');
  const persistedSecond = archiveOf().attempts.find(item => item.id === secondId);
  assert.equal(persistedSecond.note, '第二把备注');
  assert.equal(
    typeof persistedSecond.undoneAt,
    'string',
    '已撤回的原第 2 把仍按原 ID 留在档案里（含撤回标记）'
  );
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '编号变化不写视频索引');

  // 归档逐把与线路历史共用同一份显示编号。
  const attemptsPage = openAttemptsFor(seeded.session.id, seeded.route.id);
  assert.deepEqual(
    attemptsPage.data.attempts.map(row => row.label),
    ['第 1 把', '第 2 把']
  );
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ routeId: seeded.route.id });
  const group = routePage.data.groups.find(item => item.sessionId === seeded.session.id);
  assert.deepEqual(
    group.attempts.map(item => [item.label, item.id]),
    [
      ['第 1 把', firstId],
      ['第 2 把', fresh.id]
    ]
  );
  assert.equal(group.countText, '2 把');
});

test('T048 撤回第 2 把后重记完攀：新一把同样显示第 2 把，直接恢复原第 2 把接回原 ID 与附件', () => {
  const seeded = seedRopeAttempts(['fail', 'send'], ['第一把备注', '第二把备注'], {
    gymName: '岩馆 T050 重记完攀'
  });
  const firstId = seeded.attempts[0].id;
  const secondId = seeded.attempts[1].id;
  writeT049VideoClips([
    {
      clipId: 'clip-rework-send-second',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: secondId
    }
  ]);
  const page = openRecordFor(seeded.route.id, seeded.session.id);

  // 撤回第 2 把后先不重记，直接恢复：接回原 ID、原备注与原视频，编号与把数回到原样。
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '1 把');
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [firstId]);
  page.restoreLatestAttempt(rowEvent(page.data.recentAttempt));
  const restored = page.data.attemptCards[0];
  assert.equal(restored.id, secondId, '恢复接回原第 2 把');
  assert.equal(restored.label, '第 2 把');
  assert.equal(restored.note, '第二把备注');
  assert.equal(restored.videoEntryText, '回看视频', '视频仍按原把次 ID 关联');
  assert.equal(page.data.routeCountText, '2 把');

  // 再撤回第 2 把，换记一把完攀：新一把显示第 2 把，原第 1 把不动。
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  tick();
  recordThroughPage(page, 'send');
  assert.equal(page.data.routeCountText, '2 把');
  const freshSend = page.data.attemptCards[0];
  assert.equal(freshSend.isSend, true);
  assert.equal(freshSend.label, '第 2 把');
  assert.notEqual(freshSend.id, secondId);
  assert.equal(
    page.data.attemptCards.find(row => row.id === firstId).label,
    '第 1 把'
  );

  // 完攀的确认与回读也读同一份显示编号：补记完攀成第 2 把。
  const routePage = createPage(routeDefinition);
  routePage.onLoad({ routeId: seeded.route.id });
  const group = routePage.data.groups.find(item => item.sessionId === seeded.session.id);
  assert.deepEqual(
    group.attempts.map(item => item.label),
    ['第 1 把', '第 2 把']
  );
});

test('T050 撤回第 2 把后重记完攀：纠错确认写明新的第 2 把，原已撤回第 2 把不被顶替', async () => {
  const started = store.startSession({
    gymName: '岩馆 T050 纠错',
    now: new Date(2026, 10, 11, 9, 0)
  });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.archive.activeSessionId;
  const created = store.createRoute({
    sessionId,
    name: 'T050 抱石线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色'
  });
  assert.equal(created.ok, true, created.error);
  const routeId = created.route.id;
  const first = store.saveAttempt({ sessionId, routeId, result: 'fail', note: '第一把' });
  assert.equal(first.ok, true, first.error);
  const second = store.saveAttempt({ sessionId, routeId, result: 'send', note: '第二把完攀' });
  assert.equal(second.ok, true, second.error);

  let page = openRecordFor(routeId, sessionId);
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  assert.equal(page.data.routeCountText, '1 把');
  tick();
  recordThroughPage(page, 'send');
  assert.equal(page.data.routeCountText, '2 把');
  const fresh = page.data.attemptCards[0];
  assert.equal(fresh.label, '第 2 把');
  assert.equal(fresh.correctable, true, '抱石线新的唯一完攀按原资格可更正');

  // 取消：一个字节都不写，确认里写的也是新的第 2 把。
  const rawBefore = storage.get(ARCHIVE_KEY);
  queueModal('cancel');
  await page.correctSend(tapDataset({ attemptId: fresh.id }));
  const prompt = modalLog.calls.at(-1);
  assert.match(prompt.content, /第 2 把/, '确认弹窗用显示编号');
  assert.equal(prompt.content.includes('第一把'), false, '不把原第 1 把说成目标');
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '取消不写盘');

  // 确认更正：只翻这一把，把数不变；原已撤回的第 2 把仍按原 ID 在档案里。
  queueModal('confirm');
  await page.correctSend(tapDataset({ attemptId: fresh.id }));
  assert.equal(page.data.routeCountText, '2 把');
  page = openRecordFor(routeId, sessionId);
  assert.equal(page.data.attemptCards[0].id, fresh.id);
  assert.equal(page.data.attemptCards[0].label, '第 2 把');
  assert.equal(page.data.attemptCards[0].resultText, '未完成');
  const stillUndone = archiveOf().attempts.find(item => item.id === second.attempt.id);
  assert.equal(typeof stillUndone.undoneAt, 'string');
  assert.equal(stillUndone.note, '第二把完攀');
  assert.equal(archiveOf().attempts.find(item => item.id === first.attempt.id).note, '第一把');
});

test('T048 旧把展开：无备注与长备注都只有一个「备注」入口，视频入口按真实关联给，未完成行不留空槽', () => {
  const { session, route, attempts, saveThird } = seedInlineAttempts();
  saveThird();
  const longNote = '第二把左脚先上高，右手换到外侧后再把身体往墙里收，最后一步不要急着伸手。';
  assert.equal(store.setAttemptNote(attempts[1].id, { note: longNote }).ok, true);
  writeT049VideoClips([
    {
      clipId: 'clip-older-has-video',
      sessionId: session.id,
      routeId: route.id,
      attemptId: attempts[0].id
    }
  ]);

  const page = openRecordFor(route.id, session.id);
  const rowOf = id => page.data.attemptCards.find(row => row.id === id);

  // 展开第 1 把（无备注、有片）与第 2 把（长备注、无片），两把各自展示原把详情。
  toggleRow(page, attempts[0]);
  const bare = rowOf(attempts[0].id);
  assert.equal(bare.expanded, true);
  assert.equal(bare.hasNote, false, '没有备注时不渲染原正文');
  assert.equal(bare.noteActionText, '备注', '无备注也显示同一个「备注」入口');
  assert.equal(bare.videoEntryText, '回看视频', '有片用回看入口，不另挂状态文字');
  assert.equal('videoStateText' in bare, true, '状态文字只留作数据，不进入旧详情');

  toggleRow(page, attempts[1]);
  const noted = rowOf(attempts[1].id);
  assert.equal(noted.expanded, true);
  assert.equal(rowOf(attempts[0].id).expanded, false, '同一时刻只展开一把旧行');
  assert.equal(noted.hasNote, true);
  assert.equal(noted.note, longNote, '长备注按原文给出');
  assert.equal(noted.noteActionText, '备注', '有备注也是同一个「备注」入口');
  assert.equal(noted.videoEntryText, '＋ 添加视频', '无片给添加入口');

  // 现场不渲染更正入口与空纠错槽；更正资格仍是档案层只读数据。
  for (const row of [bare, noted]) {
    assert.equal(row.correctionSupported, true, '抱石线仍按原资格支持更正');
    assert.equal(row.correctable, false, '未完成把次不可更正');
    assert.equal(row.showCorrectionSlot, false, '现场不派生更正槽');
    assert.equal('showFix' in row, false, '现场不再派生纠错区');
    assert.equal(row.stateText, '', '没有撤销失败时不留状态文字');
  }

  // 最新一把（已完攀）只在右侧给「撤销」，不再有「更多」菜单。
  const latest = page.data.attemptCards[0];
  assert.equal(latest.isLatest, true);
  assert.equal(latest.showWithdraw, true, '合资格最近一把给「撤销」');
  assert.equal(latest.undoText, '撤销');
  assert.equal('showMenu' in latest, false, '现场不再派生「更多」');
  assert.equal('menuOpen' in latest, false);

  // 打开旧把备注：编辑器只绑这一把；取消不改备注、不改展开态、不写盘。
  const raw = storage.get(ARCHIVE_KEY);
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  assert.equal(page.data.noteEditor.attemptId, attempts[0].id);
  assert.equal(page.data.noteEditor.attemptLabel, '第 1 把');
  page.onNoteInput({ detail: { value: '取消掉的这一句' } });
  page.cancelNote({
    currentTarget: {
      dataset: {
        attemptId: page.data.noteEditor.attemptId,
        editVersion: page.data.noteEditor.version
      }
    }
  });
  assert.equal(page.data.noteEditor, null);
  assert.equal(storage.get(ARCHIVE_KEY), raw, '取消一个字节都不写');
  assert.equal(page.data.expandedAttemptId, attempts[1].id, '取消后仍停在原来展开的旧把');

  // 更早把次上的陈旧保存事件不会写到这一把：代次不符时拒绝。
  page.openNoteEditor(tapDataset({ attemptId: attempts[1].id }));
  const staleVersion = page.data.noteEditor.version;
  page.cancelNote(tapDataset({ attemptId: attempts[1].id, editVersion: staleVersion }));
  page.openNoteEditor(tapDataset({ attemptId: attempts[0].id }));
  page.onNoteInput({ detail: { value: '这一把补上的备注' } });
  page.saveNote(
    tapDataset({ attemptId: attempts[1].id, editVersion: staleVersion })
  );
  assert.match(page.data.notice, /已经失效/);
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[1].id).note,
    longNote,
    '旧编辑器的保存不落到另一把'
  );
  page.saveNote(tapDataset({
    attemptId: page.data.noteEditor.attemptId,
    editVersion: page.data.noteEditor.version
  }));
  assert.equal(
    archiveOf().attempts.find(item => item.id === attempts[0].id).note,
    '这一把补上的备注',
    '保存只改打开时的那一把'
  );
  assert.equal(rowOf(attempts[0].id).note, '这一把补上的备注');
  assert.equal(rowOf(attempts[0].id).noteActionText, '备注', '保存后入口仍是同一个「备注」');
});

test('T048 同线另一场不串入：只列入口那一场这一条线的原把次，各页面展开态互不影响', () => {
  const seeded = seedRopeAttempts(['fail', 'fail'], ['', '第一场第二把备注'], {
    gymName: '岩馆 T048 隔离'
  });
  const archive = archiveOf();
  const firstSessionId = seeded.session.id;
  const firstAttemptIds = seeded.attempts.map(attempt => attempt.id);

  // 开始第二场，把同一条长期线路关联进来，再记两把。
  const second = store.startSession({ gymName: '岩馆 T048 隔离', now: new Date(2026, 10, 10, 20, 0) });
  assert.equal(second.ok, true, second.error);
  const secondSessionId = second.archive.activeSessionId;
  const linked = store.linkRouteToSession(secondSessionId, seeded.route.id);
  assert.equal(linked.ok, true, linked.error);
  const secondAttempts = ['fail', 'send'].map((result, index) => {
    const saved = store.saveAttempt({
      sessionId: secondSessionId,
      routeId: seeded.route.id,
      result,
      note: '第二场第' + (index + 1) + '把',
      now: new Date(2026, 10, 10, 20, 5 + index * 3)
    });
    assert.equal(saved.ok, true, saved.error);
    return saved.attempt;
  });

  const firstPage = openRecordFor(seeded.route.id, firstSessionId);
  toggleRow(firstPage, seeded.attempts[0]);
  assert.equal(firstPage.data.expandedAttemptId, seeded.attempts[0].id);

  // 第二场同一条线：只列第二场自己的两把，原序号从这一场重新数。
  const secondPage = openRecordFor(seeded.route.id, secondSessionId);
  assert.deepEqual(
    secondPage.data.attemptCards.map(row => row.id),
    [secondAttempts[1].id, secondAttempts[0].id],
    '同线另一场不串入'
  );
  assert.deepEqual(secondPage.data.attemptCards.map(row => row.label), ['第 2 把', '第 1 把']);
  assert.equal(secondPage.data.expandedAttemptId, '', '新页面没有继承另一场的展开态');
  assert.equal(
    secondPage.data.attemptCards.some(row => firstAttemptIds.includes(row.id)),
    false,
    '第一场的原把次不出现在这一场'
  );

  // 第二场再记一把：第一场页面刷新后仍是原两把，展开态也留在原来那一把。
  const saved = store.saveAttempt({
    sessionId: secondSessionId,
    routeId: seeded.route.id,
    result: 'fail',
    note: '',
    now: new Date(2026, 10, 10, 20, 20)
  });
  assert.equal(saved.ok, true, saved.error);
  firstPage.refreshView();
  assert.deepEqual(
    firstPage.data.attemptCards.map(row => row.id),
    [seeded.attempts[1].id, seeded.attempts[0].id]
  );
  assert.equal(firstPage.data.expandedAttemptId, seeded.attempts[0].id);
  assert.equal(
    firstPage.data.attemptCards.find(row => row.id === seeded.attempts[0].id).expanded,
    true,
    '另一场新增把次不改这一场的展开态'
  );

  // 同场另一条线同样不串入：它在自己的单线页里按自己的原序号排列。
  const neighbor = store.createRoute({
    sessionId: firstSessionId,
    name: 'T048 隔离旁线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(neighbor.ok, true, neighbor.error);
  const neighborAttempt = store.saveAttempt({
    sessionId: firstSessionId,
    routeId: neighbor.route.id,
    result: 'fail',
    note: '旁线这一把',
    now: new Date(2026, 10, 10, 21, 0)
  });
  assert.equal(neighborAttempt.ok, true, neighborAttempt.error);
  firstPage.refreshView();
  assert.equal(
    firstPage.data.attemptCards.some(row => row.id === neighborAttempt.attempt.id),
    false,
    '同场另一条线的把次不串入'
  );
  const neighborPage = openRecordFor(neighbor.route.id, firstSessionId);
  assert.deepEqual(
    neighborPage.data.attemptCards.map(row => row.label),
    ['第 1 把'],
    '旁线从自己的第 1 把起算'
  );
  assert.equal(neighborPage.data.attemptCards[0].isLatest, true);
});

// ------------------------------------------------------------------ *
// T049 最新卡与旧把详情的视频入口
// ------------------------------------------------------------------ *

/** 往本机视频索引写与这些把次真实归属一致的本机副本（记录页只读索引，不写）。 */
function writeT049VideoClips(items) {
  const archiveId = archiveOf().archiveId;
  storage.set(
    VIDEO_INDEX_KEY,
    JSON.stringify({
      version: 1,
      clips: items.map(item => ({
        clipId: item.clipId,
        archiveId,
        sessionId: item.sessionId,
        routeId: item.routeId,
        attemptId: item.attemptId,
        rev: 1,
        bytes: item.bytes || 1024,
        fileId: 'attempt-video/v1/' + archiveId + '/' + item.clipId + '.mp4'
      }))
    })
  );
}

/** 最近一次跳转的参数：视频入口必须带齐四个原 ID。 */
function lastVideoParams() {
  const nav = wxLog.navigations[wxLog.navigations.length - 1];
  assert.ok(nav, '应有一次页面跳转');
  const url = new URL(nav.url, 'https://example.invalid');
  assert.equal(url.pathname, '/pages/attempt-video/attempt-video');
  return {
    archiveId: url.searchParams.get('archiveId'),
    sessionId: url.searchParams.get('sessionId'),
    routeId: url.searchParams.get('routeId'),
    attemptId: url.searchParams.get('attemptId')
  };
}

test('T049 最新卡无片「＋ 添加视频」、有片同位置「回看视频」；旧行收起仅真有片时出图标', () => {
  const seeded = seedRopeAttempts(['fail', 'fail', 'fail'], ['', '', '第三把备注']);
  const archiveId = archiveOf().archiveId;
  const indexBefore = storage.get(VIDEO_INDEX_KEY);

  // 都还没片：最新一把与旧把都只给「＋ 添加视频」，收起态都没有小视频图标。
  const firstPage = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(firstPage.data.attemptCards[0].isLatest, true);
  for (const row of firstPage.data.attemptCards) {
    assert.equal(row.hasVideo, false);
    assert.equal(row.videoEntryText, '＋ 添加视频');
    assert.equal(row.showVideoIcon, false);
  }
  // 最新一把的入口只带这一把的四个原 ID。
  resetWxLog();
  firstPage.openAttemptVideo(
    tapDataset({
      attemptId: seeded.attempts[2].id,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.deepEqual(lastVideoParams(), {
    archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    attemptId: seeded.attempts[2].id
  });

  // 第二把已有本机副本：只有这一把在收起态带上图标，最新一把仍在同一位置给添加。
  writeT049VideoClips([
    {
      clipId: 'clip-t049-older',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: seeded.attempts[1].id
    }
  ]);
  const indexRaw = storage.get(VIDEO_INDEX_KEY);

  // 从视频页返回（onShow）也按最新索引刷新：同一把变成回看，最新一把仍在同位置给添加。
  firstPage.onShow();
  assert.equal(firstPage.data.attemptCards[0].videoEntryText, '＋ 添加视频');
  const refreshedOlder = firstPage.data.attemptCards.find(
    row => row.id === seeded.attempts[1].id
  );
  assert.equal(refreshedOlder.videoEntryText, '回看视频');
  assert.equal(refreshedOlder.showVideoIcon, true);

  const page = openRecordFor(seeded.route.id, seeded.session.id);

  const latest = page.data.attemptCards[0];
  assert.equal(latest.hasVideo, false);
  assert.equal(latest.videoEntryText, '＋ 添加视频');
  assert.equal(latest.expanded, true);
  assert.equal(latest.showVideoIcon, false, '最新一把完整展示，不出现收起态图标');

  const olderRow = page.data.attemptCards.find(row => row.id === seeded.attempts[1].id);
  assert.equal(olderRow.hasVideo, true);
  assert.equal(olderRow.videoEntryText, '回看视频');
  assert.equal(olderRow.expanded, false);
  assert.equal(olderRow.showVideoIcon, true, '有片的旧行收起时出现小视频图标');

  const bareRow = page.data.attemptCards.find(row => row.id === seeded.attempts[0].id);
  assert.equal(bareRow.hasVideo, false);
  assert.equal(bareRow.videoEntryText, '＋ 添加视频');
  assert.equal(bareRow.showVideoIcon, false, '无片的旧行不出现视频图标');

  // 点开原行后按该把的真实关联给回看入口，图标让位给详情里的入口。
  toggleRow(page, seeded.attempts[1]);
  const opened = page.data.attemptCards.find(row => row.id === seeded.attempts[1].id);
  assert.equal(opened.expanded, true);
  assert.equal(opened.hasVideo, true);
  assert.equal(opened.videoEntryText, '回看视频');
  assert.equal(opened.showVideoIcon, false);

  // 回看入口带的是这一行的四个原 ID，不是最新一把的。
  resetWxLog();
  page.openAttemptVideo(
    tapDataset({
      attemptId: opened.id,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.deepEqual(lastVideoParams(), {
    archiveId,
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    attemptId: seeded.attempts[1].id
  });

  // 打开、展开与进入视频页都只读：索引与档案逐字节不变。
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '视频索引不变');
  assert.notEqual(indexBefore, indexRaw, '夹具确实写入了视频索引');
});

test('T049 新、旧两把各自保存不同视频：换新把后层级切换、重开仍按各自关联，失效点击不打开视频页', () => {
  const seeded = seedRopeAttempts(['fail', 'fail'], ['第一把备注', '']);
  const archiveId = archiveOf().archiveId;
  writeT049VideoClips([
    {
      clipId: 'clip-t049-first',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: seeded.attempts[0].id
    },
    {
      clipId: 'clip-t049-second',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: seeded.attempts[1].id
    }
  ]);
  const indexRaw = storage.get(VIDEO_INDEX_KEY);

  let page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(page.data.attemptCards[0].id, seeded.attempts[1].id, '最新一把置顶');
  assert.equal(page.data.attemptCards[0].videoEntryText, '回看视频');
  assert.equal(page.data.attemptCards[0].showVideoIcon, false);
  assert.equal(page.data.attemptCards[1].videoEntryText, '回看视频');
  assert.equal(page.data.attemptCards[1].showVideoIcon, true);

  // 最新一把回看的是第 2 把自己的副本。
  resetWxLog();
  page.openAttemptVideo(
    tapDataset({
      attemptId: seeded.attempts[1].id,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(lastVideoParams().attemptId, seeded.attempts[1].id);

  // 展开旧行再回看：进入第 1 把，不串到第 2 把。
  toggleRow(page, seeded.attempts[0]);
  resetWxLog();
  page.openAttemptVideo(
    tapDataset({
      attemptId: seeded.attempts[0].id,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(lastVideoParams().attemptId, seeded.attempts[0].id);

  // 记下第 3 把成功后层级切换：新一把置顶且无片，原两把都收成带图标的短行。
  tick();
  recordThroughPage(page, 'fail');
  const cards = page.data.attemptCards;
  assert.equal(cards.length, 3);
  assert.equal(cards[0].hasVideo, false);
  assert.equal(cards[0].videoEntryText, '＋ 添加视频');
  assert.equal(cards[0].expanded, true);
  assert.equal(cards[1].id, seeded.attempts[1].id);
  assert.equal(cards[1].expanded, false);
  assert.equal(cards[1].showVideoIcon, true, '原最新一把收成短行后仍有有片图标');
  assert.equal(cards[2].id, seeded.attempts[0].id);
  assert.equal(cards[2].showVideoIcon, true);

  // 重开：仍按两把各自的关联给回看入口。
  page = openRecordFor(seeded.route.id, seeded.session.id);
  const reopened = page.data.attemptCards;
  assert.deepEqual(
    reopened.map(row => [row.id, row.hasVideo, row.expanded]),
    [
      [cards[0].id, false, true],
      [seeded.attempts[1].id, true, false],
      [seeded.attempts[0].id, true, false]
    ]
  );
  assert.equal(reopened[1].videoEntryText, '回看视频');
  assert.equal(reopened[2].videoEntryText, '回看视频');

  // 失效点击：带别的档案 ID 的一下不打开视频页，只提示并按最新档案刷新。
  const archiveRaw = storage.get(ARCHIVE_KEY);
  resetWxLog();
  page.openAttemptVideo(
    tapDataset({
      attemptId: seeded.attempts[0].id,
      archiveId: 'archive-of-another-profile',
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(wxLog.navigations.length, 0, '串档的点击不打开视频页');
  assert.ok(page.data.notice, '失效点击给出可见提示');
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '失效点击不改视频索引');
  assert.equal(storage.get(ARCHIVE_KEY), archiveRaw, '失效点击不改训练档案');

  // 已撤回的一把先恢复再回看：它已离开现场列表，用档案层的原把身份点视频入口同样不打开。
  page.undoLatestAttempt(rowEvent(page.data.attemptCards[0]));
  const undoneId = page.data.recentAttempt.attemptId;
  assert.equal(undoneId, cards[0].id, '撤销的是刚才置顶的第 3 把');
  assert.equal(
    page.data.attemptCards.some(row => row.id === undoneId),
    false,
    '已撤回的一把移出现场逐把列表'
  );
  assert.equal(
    typeof archiveOf().attempts.find(row => row.id === undoneId).undoneAt,
    'string'
  );
  resetWxLog();
  page.openAttemptVideo(
    tapDataset({
      attemptId: undoneId,
      archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(wxLog.navigations.length, 0, '已撤回的一把不打开视频页');
  assert.match(page.data.notice, /撤回.*恢复/);
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '撤回与失效点击都不改视频索引');
  assert.equal(
    page.data.attemptCards.filter(row => row.hasVideo).length,
    2,
    '另外两把的视频关联保持'
  );
});

// ------------------------------------------------------------------ *
// T050 返工（现场）：最新一把直接「撤销」，原把移出列表，前一把只补位
// ------------------------------------------------------------------ *

/** 最新一把「撤销」的点击参数：只带这一行的原把次 ID、归属与渲染时的状态/版本。 */
function withdrawEvent(row) {
  return tapDataset({
    attemptId: row.id,
    archiveId: row.archiveId,
    sessionId: row.sessionId,
    routeId: row.routeId,
    expected: row.expected,
    expectedRev: row.expectedRev
  });
}

test('T050 返工 撤销最近一把：只减一把、原把移出现场，前一把只补位且不再给撤销入口', () => {
  const seeded = seedRopeAttempts(['fail', 'send', 'fail'], ['第一把备注', '第二把备注', '第三把备注']);
  const firstId = seeded.attempts[0].id;
  const secondId = seeded.attempts[1].id;
  const thirdId = seeded.attempts[2].id;
  writeT049VideoClips([
    {
      clipId: 'clip-withdraw-first',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: firstId
    },
    {
      clipId: 'clip-withdraw-third',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      attemptId: thirdId
    }
  ]);
  const indexRaw = storage.get(VIDEO_INDEX_KEY);

  const page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.deepEqual(page.data.attemptCards.map(row => row.label), ['第 3 把', '第 2 把', '第 1 把']);
  const latest = page.data.attemptCards[0];
  assert.equal(latest.id, thirdId);
  assert.equal(latest.showWithdraw, true, '最新一把就是最近一把时给「撤销」');
  assert.equal(latest.undoText, '撤销');
  assert.equal(page.data.attemptCards[1].showWithdraw, false, '较早把次没有撤销入口');

  const beforeUndo = storage.get(ARCHIVE_KEY);
  page.undoLatestAttempt(withdrawEvent(latest));
  assert.notEqual(storage.get(ARCHIVE_KEY), beforeUndo, '撤销确实落盘一次');
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.notice, '已撤销第 3 把');
  assert.equal(page.data.routeCountText, '2 把');
  assert.deepEqual(
    page.data.attemptCards.map(row => [row.id, row.label]),
    [
      [secondId, '第 2 把'],
      [firstId, '第 1 把']
    ],
    '已撤销的一把移出有效逐把列表，前一把只补位'
  );
  assert.equal(page.data.attemptCards[0].showWithdraw, false, '补位的前一把不给撤销入口');
  assert.equal(page.data.attemptCards[0].note, '第二把备注', '前一把备注不变');
  assert.equal(
    page.data.attemptCards[0].videoEntryText,
    '＋ 添加视频',
    '前一把没有借用撤销那一把的视频'
  );
  assert.equal(page.data.attemptCards[1].videoEntryText, '回看视频', '第一把的视频归属不变');
  assert.equal(page.data.recentAttempt.attemptId, thirdId);
  assert.equal(page.data.recentAttempt.canRestore, true, '档案层仍可按原把恢复');

  // 原把身份与媒体不转移：同 ID、同序号、同场次线路、原备注与撤回标记。
  const persisted = savedAttempts(seeded.session.id, seeded.route.id);
  assert.equal(persisted.length, 3, '撤销不是删除');
  const undone = persisted.find(item => item.id === thirdId);
  assert.equal(undone.seq, seeded.attempts[2].seq);
  assert.equal(undone.sessionId, seeded.session.id);
  assert.equal(undone.routeId, seeded.route.id);
  assert.equal(undone.result, 'fail');
  assert.equal(undone.note, '第三把备注');
  assert.equal(typeof undone.undoneAt, 'string');
  assert.equal(storage.get(VIDEO_INDEX_KEY), indexRaw, '撤销不写视频索引');

  // 同一坐标连点（画面还没重绘时的第二个事件）：不写第二次，也不会撤到第 2 把。
  const writesAfterUndo = fault.setCount;
  page.undoLatestAttempt(withdrawEvent(latest));
  assert.equal(fault.setCount, writesAfterUndo, '重复点按不写盘');
  assert.equal(page.data.routeCountText, '2 把');
  const persistedAgain = savedAttempts(seeded.session.id, seeded.route.id);
  assert.equal(persistedAgain.filter(item => item.undoneAt).length, 1, '只有刚撤销的那一把被撤回');
  assert.equal(
    persistedAgain.find(item => item.id === secondId).undoneAt,
    undefined,
    '前一把没有被连带撤销'
  );

  // 刷新（onShow）后仍按已保存的有效把次展示，撤销入口仍不出现。
  page.onShow();
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [secondId, firstId]);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);
  assert.equal(page.data.routeCountText, '2 把');

  // 再成功记一把：新把次出现，撤销入口才回到新的一把上。
  tick();
  recordThroughPage(page, 'fail');
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(page.data.attemptCards[0].label, '第 3 把', '界面序号按有效把次连续');
  assert.notEqual(page.data.attemptCards[0].id, thirdId, '新一把不复用已撤销的原 ID');
  assert.equal(page.data.attemptCards[0].showWithdraw, true, '再成功记一把后才有新的撤销入口');
  assert.equal(page.data.notice, '');
});

test('T050 返工 撤销失败保留原把与重试；失效点击与过期目标不落盘，成功只扣一次', () => {
  const seeded = seedRopeAttempts(['fail', 'fail'], ['第一把备注', '第二把备注'], {
    gymName: '岩馆 T050 撤销重试'
  });
  const firstId = seeded.attempts[0].id;
  const secondId = seeded.attempts[1].id;
  const page = openRecordFor(seeded.route.id, seeded.session.id);
  assert.equal(page.data.attemptCards[0].id, secondId);
  assert.equal(page.data.attemptCards[0].showWithdraw, true);

  // 失效点击：带另一份档案 ID 的一下不落盘，也不改撤销目标。
  const raw = storage.get(ARCHIVE_KEY);
  page.undoLatestAttempt(
    tapDataset({
      attemptId: secondId,
      archiveId: 'archive-of-another-profile',
      sessionId: seeded.session.id,
      routeId: seeded.route.id,
      expected: 'effective',
      expectedRev: 0
    })
  );
  assert.ok(page.data.notice, '失效点击给出可见提示');
  assert.equal(storage.get(ARCHIVE_KEY), raw, '失效点击不写盘');
  assert.equal(page.data.routeCountText, '2 把');

  // 第一段写就失败：原把仍在，按钮换成同一把的「重试撤销」，计数不减。
  tick();
  armSetFailAt(1);
  page.undoLatestAttempt(withdrawEvent(page.data.attemptCards[0]));
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.equal(page.data.routeCountText, '2 把', '没有落盘就不减把数');
  const failedRow = page.data.attemptCards[0];
  assert.equal(failedRow.id, secondId);
  assert.equal(failedRow.isUndone, false, '原把仍是有效把次');
  assert.equal(failedRow.showWithdraw, true);
  assert.equal(failedRow.undoText, '重试撤销');
  assert.match(failedRow.stateText, /^撤销未保存/);

  // 原坐标（同一把）再点一次：沿用原 opId 重试，只扣这一把。
  const staleSecond = withdrawEvent(failedRow);
  armSetFailAt(0);
  tick();
  page.undoLatestAttempt(withdrawEvent(page.data.attemptCards[0]));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.deepEqual(page.data.attemptCards.map(row => row.id), [firstId]);
  assert.equal(page.data.attemptCards[0].showWithdraw, false);

  // 已经撤回的一把不再结清第二次：重复点按不写盘，前一把仍是有效。
  const bytesAfterUndo = storage.get(ARCHIVE_KEY);
  page.undoLatestAttempt(staleSecond);
  assert.equal(storage.get(ARCHIVE_KEY), bytesAfterUndo, '重复点按不写盘');
  assert.equal(page.data.routeCountText, '1 把');
  // T050 返工：同一原按钮的重复事件不再进共用实现，保留成功提示。
  assert.equal(page.data.notice, '已撤销第 2 把');
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === firstId).undoneAt,
    undefined,
    '前一把没有被连带撤销'
  );

  // 再记一把成功：新把显示第 2 把，撤销入口回到新的一把；旧坐标的迟到目标不落盘。
  tick();
  recordThroughPage(page, 'fail');
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.attemptCards[0].label, '第 2 把', '界面序号按有效把次连续');
  assert.equal(page.data.attemptCards[0].showWithdraw, true, '成功记把后才恢复撤销入口');
  const bytesAfterNew = storage.get(ARCHIVE_KEY);
  page.undoLatestAttempt(staleSecond);
  assert.equal(storage.get(ARCHIVE_KEY), bytesAfterNew, '过期目标不落盘');
  // 迟到的原按钮只被忽略：既不撤新一把，也不改写刚记一把后的现场提示。
  assert.equal(page.data.notice, '', '迟到事件不覆盖当前提示');
  assert.equal(page.data.routeCountText, '2 把');
});

test('T062 U1 跨日已完攀抱石：本馆候选直达原历史，返回后档案与选择零写入', () => {
  const prior = store.startSession({
    gymName: '跨日岩馆',
    date: '2026-11-19',
    now: new Date(2026, 10, 19, 9, 0)
  });
  assert.equal(prior.ok, true, prior.error);
  const route = store.createRoute({
    sessionId: prior.session.id,
    name: '跨日完攀线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(route.ok, true, route.error);
  const sent = store.saveAttempt({
    sessionId: prior.session.id,
    routeId: route.route.id,
    result: 'send'
  });
  assert.equal(sent.ok, true, sent.error);

  const today = store.startSession({
    gymName: '跨日岩馆',
    date: '2026-11-20',
    now: new Date(2026, 10, 20, 9, 0)
  });
  assert.equal(today.ok, true, today.error);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, today.session.id);
  page.openAddRoute();
  const candidate = page.data.gymRoutes.find(item => item.id === route.route.id);
  assert.ok(candidate, '跨日已完攀抱石仍在本馆候选里');
  assert.equal(candidate.stateText, '已完攀');
  assert.equal(candidate.openHistory, true);

  const bytesBefore = storage.get(ARCHIVE_KEY);
  const before = archiveOf();
  page.pickGymRoute(
    tapDataset({
      routeId: candidate.id,
      sessionId: candidate.sessionId,
      archiveId: candidate.archiveId,
      contextPhase: candidate.contextPhase
    })
  );

  // 直达原线路历史：不关联本场、不选中、不新建场次，档案一个字节都不变。
  assert.equal(wxLog.navigations.length, 1);
  assert.match(wxLog.navigations[0].url, /^\/pages\/training-route\/training-route\?/);
  assert.match(wxLog.navigations[0].url, new RegExp('routeId=' + route.route.id));
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '打开历史不写档案');
  const after = archiveOf();
  assert.equal(after.activeSessionId, before.activeSessionId);
  assert.equal(after.activeRouteId, before.activeRouteId);
  assert.equal(after.sessions.length, before.sessions.length);
  assert.equal(after.sessionRoutes.length, before.sessionRoutes.length);
  assert.equal(linkCount(today.session.id, route.route.id), 0);

  // 返回本场：只读重算，候选仍是已完攀，当前场次不变、仍没有关联。
  page.onShow();
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '返回本场也不写盘');
  const afterReturn = page.data.gymRoutes.find(item => item.id === route.route.id);
  assert.equal(afterReturn.stateText, '已完攀');
  assert.equal(afterReturn.openHistory, true);
  assert.equal(page.data.activeSession.id, today.session.id);
  assert.equal(linkCount(today.session.id, route.route.id), 0);
});
