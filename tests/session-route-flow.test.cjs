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
const fault = { setFailAt: 0, setCount: 0, loseResponseAt: 0 };

function resetDevice() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
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

function tapResult(result) {
  return { currentTarget: { dataset: { result } } };
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

/** 「最近一把」这一行渲染出来的点击参数，与 WXML 上的 dataset 一一对应。 */
function rowEvent(row) {
  return tapDataset({
    attemptId: row.attemptId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    expected: row.expected
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
  const before = archiveOf().routes.map(route => route.id);
  page.openAddRoute();
  assert.equal(page.data.addRouteVisible, true);

  if (opts.existing) {
    // 本馆已有线路：复用同一个 routeId 关联进本场（T030 的另一半入口）。
    page.switchAddRouteMode(tapDataset({ mode: 'existing' }));
    page.pickGymRoute(tapDataset({ routeId: opts.existing }));
    assert.equal(page.data.storageError, '');
    assert.equal(page.data.selectedRoute.id, opts.existing, '关联成功后选中同一条线');
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
  assert.equal(page.data.addRouteVisible, false, '保存后面板收起，回到记结果处');

  const created = archiveOf().routes.find(route => !before.includes(route.id));
  assert.ok(created, '新建线路应落盘');
  assert.equal(page.data.selectedRoute.id, created.id, '新建成功即选中');
  return created.id;
}

/** 在结果按钮上记一把（页面入口）。 */
function recordThroughPage(page, result) {
  tick();
  page.recordAttempt(tapResult(result));
  assert.equal(page.data.storageError, '', '这一把应已落盘');
}

/** 换线（结果按钮旁的换线区，走原 selectRoute）。 */
function switchTo(page, routeId) {
  page.selectRoute(tapDataset({ routeId }));
  assert.equal(page.data.selectedRoute.id, routeId);
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
  const page = startTrainingFromHome(gymName || '我自己去的岩馆');
  const sessionId = page.data.activeSession.id;

  const aId = addRouteThroughPage(page, 'A 线', { grade: 'V3' });
  recordThroughPage(page, 'fail');
  recordThroughPage(page, 'fail');
  recordThroughPage(page, 'fail');

  // 第 2、3 把补备注：撤回到第 3 把时，最近有效备注要跳到第 2 把那一句。
  const labels = attemptsOf(page);
  page.openNoteEditor(tapDataset({ attemptId: labels[1].id }));
  page.onNoteInput({ detail: { value: '第二把备注' } });
  page.saveNote();
  page.openNoteEditor(tapDataset({ attemptId: labels[2].id }));
  page.onNoteInput({ detail: { value: '第三把备注' } });
  page.saveNote();

  const bId = addRouteThroughPage(page, 'B 线', { grade: 'V3' });
  recordThroughPage(page, 'fail');

  return {
    page,
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
  assert.equal(page.data.routeSwitchTotal, 2, '「全部 N 条」按真实本场关联计数');

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
  const reopened = openSessionPage({});
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

  // 第二段写成后回执丢失：页面只拿到失败，档案里其实已经恢复。
  const reopened = openSessionPage({});
  armSetLoseResponseAt(2);
  reopened.restoreLatestAttempt(rowEvent(reopened.data.recentAttempt));
  assert.match(reopened.data.storageError, /保存本机训练档案失败/);
  assert.match(reopened.data.notice, /重试恢复这一把/);
  assert.equal(reopened.data.routeCountText, '2 把', '没确认落盘前就把数不动');
  assert.equal(
    JSON.parse(storage.get(ARCHIVE_KEY)).attempts.find(item => item.id === thirdId).undoneAt,
    undefined,
    '回执丢失的这一次其实已经落盘'
  );

  // 再开一次页面：读到的就是档案里的实际状态（已恢复），不需要也不会有第二次恢复。
  armSetLoseResponseAt(0);
  const coldOpen = openSessionPage({});
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

test('T033 按钮位置可核：撤回与恢复是两个控件，行高固定，绑定都带原把次 ID 与预期状态', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const wxss = fs.readFileSync(SESSION_WXSS, 'utf8');

  const resultSend = wxml.indexOf('class="result-button result-send"');
  const recent = wxml.indexOf('id="recent-attempt"');
  const row = wxml.indexOf('class="recent-attempt-row"');
  const recovery = wxml.indexOf('class="recent-attempt-recovery"');
  const photo = wxml.indexOf('id="route-photo-card"');
  assert.ok(resultSend < recent, '撤回区在结果按钮之后');
  assert.ok(recent < photo, '撤回区在结果按钮下方的原位置');
  assert.ok(row < recovery, '恢复入口在这一行下方的独立一行');

  // 撤回按钮与恢复按钮不是同一个控件，也不是同一类按钮（文字按钮 / 实体按钮）。
  assert.match(wxml, /id="undo-attempt-\{\{recentAttempt\.attemptId\}\}"[\s\S]{0,120}class="text-button recent-attempt-action"/);
  assert.match(wxml, /id="restore-attempt-\{\{recentAttempt\.attemptId\}\}"[\s\S]{0,120}class="secondary-button recent-attempt-restore"/);
  // 行高固定：撤回按钮收起后这一行的高度不变，刚才点过的坐标留在空位上。
  const rowStyle = wxss.match(/\.recent-attempt-row\s*\{[^}]*\}/);
  assert.ok(rowStyle && /min-height:88rpx/.test(rowStyle[0]));

  const handlers = new Set(handlersIn(wxml));
  for (const required of [
    'openAddRoute',
    'selectRoute',
    'recordAttempt',
    'undoLatestAttempt',
    'restoreLatestAttempt'
  ]) {
    assert.ok(handlers.has(required), '场内页应绑定：' + required);
    assert.equal(typeof sessionDefinition[required], 'function', required + ' 必须有页面方法');
  }
  // 只看这一批新增的入口：不新增第二套存储，也不接云。
  const source = fs.readFileSync(SESSION_JS, 'utf8');
  assert.match(source, /utils\/training-store/);
  assert.doesNotMatch(source, /wx\.cloud/);
  assert.match(source, /store\.undoAttempt/);
  assert.match(source, /store\.restoreAttempt/);
});

// ------------------------------------------------------------------ *
// 完整训练后的逐项对账（T032 口径）
// ------------------------------------------------------------------ *

test('T030–T033 完整训练逐项对账：撤回后与恢复后，场内/首页/小结/清单/统计/历史同一有效集合', () => {
  const flow = trainThroughPages('石间岩馆');
  const page = flow.page;
  const thirdId = flow.aAttempts[2];

  // 把 A 收进「下次想爬」，让清单也参与对账。
  switchTo(page, flow.aId);
  page.addSelectedToWishlist();
  assert.equal(page.data.selectedWishlist.inList, true);
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
