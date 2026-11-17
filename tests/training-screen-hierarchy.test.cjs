/**
 * T037 训练页信息层级：本场统一线路列表、回列表换线与各目的地归属回归
 *
 * 直接加载真实页面文件（场内页、单线记录、小结、想爬清单、线路资料），捕获 Page(...)
 * 定义，用隔离的微信本地存储替身与写入故障注驱动真实页面处理器。所有断言都从
 * WXML 里真实的 data-* 绑定与渲染数据出发，经过页面函数调用核对结果；不模拟业务规则。
 *
 * 覆盖：
 * - 0 / 1 / 4 条以上都是同一份一行一条的列表；零把、文字状态与长名；
 * - 加线：本馆已有、新建、取消、重复关联、选中失败按原 routeId 重试、创建失败重试；
 * - 整行点入单线、返回列表换线、无选中旧场可重选、同坐标连点只开一次、导航失败重试；
 * - 三类线路：抱石跨天完攀锁定，绳攀跨天可再次完攀；
 * - 缺必需 ID、换档后同 ID 的旧事件不打开、不写档；
 * - 小结按入口原 sessionId 打开，换看只读，缺归属不拿当前场次顶替；
 * - 想爬清单按原 archiveId + routeId 回资料，返回后活动场次与清单不变。
 *
 * 真机触控、原生矩形与截图由独立 QA 在整合 SHA 采集（待验）。
 *
 * 运行：node --test tests/training-screen-hierarchy.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const SESSION_WXSS = path.join(ROOT, 'pages', 'training-session', 'training-session.wxss');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const SUMMARY_JS_PAGE = path.join(ROOT, 'pages', 'training-summary', 'training-summary.js');
const WISHLIST_JS_PAGE = path.join(ROOT, 'pages', 'training-wishlist', 'training-wishlist.js');
const WISHLIST_WXML = path.join(ROOT, 'pages', 'training-wishlist', 'training-wishlist.wxml');
const ROUTE_JS_PAGE = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const WISHLIST_JS = path.join(ROOT, 'utils', 'training-wishlist.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const RECORD_URL = '/pages/training-record/training-record';
const ROUTE_URL = '/pages/training-route/training-route';
const USER_ROOT = '/tmp/zcode-t037';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，可按需注入写入失败 ----
const storage = new Map();
const fault = { setFailAt: 0, setCount: 0 };

function resetDevice() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
}

function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

const wxLog = { navigations: [], backs: [], relaunches: [], toasts: [] };
let navFailNext = false;

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.backs = [];
  wxLog.relaunches = [];
  wxLog.toasts = [];
  navFailNext = false;
}

// 照片层只需要一个不会抛错的空文件系统：本测试不拍照、不读写照片。
const emptyFileSystem = {
  accessSync() {
    throw new Error('no such file');
  },
  mkdirSync() {},
  statSync() {
    throw new Error('no such file');
  },
  readFileSync() {
    throw new Error('no such file');
  },
  writeFileSync() {},
  unlinkSync() {},
  readdirSync() {
    return [];
  },
  copyFileSync() {},
  saveFileSync(filePath) {
    return filePath;
  }
};

global.wx = {
  env: { USER_DATA_PATH: USER_ROOT },
  getStorageSync(key) {
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
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  getFileSystemManager() {
    return emptyFileSystem;
  },
  navigateTo(options) {
    if (navFailNext) {
      navFailNext = false;
      if (options && typeof options.fail === 'function') {
        options.fail({ errMsg: 'navigateTo:fail injected' });
      }
      return;
    }
    wxLog.navigations.push(options);
  },
  redirectTo(options) {
    wxLog.navigations.push(options);
  },
  reLaunch(options) {
    wxLog.relaunches.push(options);
  },
  navigateBack(options) {
    wxLog.backs.push(options);
  },
  switchTab(options) {
    wxLog.navigations.push(options);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  pageScrollTo() {},
  stopPullDownRefresh() {}
};

// 可控时钟：同一坐标的连点窗口与新建提交窗口都用 Date.now 判别。
const realNow = Date.now;
let clock = new Date(2026, 10, 11, 9, 0, 0).getTime();
Date.now = () => clock;
function tick(ms) {
  clock += typeof ms === 'number' ? ms : 1000;
}
process.on('exit', () => {
  Date.now = realNow;
});

const store = require(STORE_JS);
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

const sessionDefinition = capturePage(SESSION_JS);
const recordDefinition = capturePage(RECORD_JS);
const summaryDefinition = capturePage(SUMMARY_JS_PAGE);
const wishlistDefinition = capturePage(WISHLIST_JS_PAGE);
const routeDefinition = capturePage(ROUTE_JS_PAGE);

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

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

function archiveOf() {
  return store.loadState().archive;
}

function rawArchive() {
  return storage.get(ARCHIVE_KEY) || '';
}

function seedSession(gymName, date) {
  const started = store.startSession({ gymName, date });
  assert.equal(started.ok, true, started.error);
  return started.session;
}

function seedRoute(sessionId, input) {
  const created = store.createRoute(Object.assign({ sessionId }, input));
  assert.equal(created.ok, true, created.error);
  return created.route;
}

function linkCount(sessionId, routeId) {
  return (archiveOf().sessionRoutes || []).filter(
    link => link.sessionId === sessionId && link.routeId === routeId
  ).length;
}

function attemptsOf(sessionId, routeId) {
  return store.attemptsFor(archiveOf(), { sessionId, routeId });
}

function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  return page;
}

function openRecordPage(routeId, sessionId) {
  const archive = archiveOf();
  const page = createPage(recordDefinition);
  page.onLoad({
    archiveId: archive.archiveId,
    sessionId: sessionId || archive.activeSessionId,
    routeId
  });
  return page;
}

function openSummaryPage(query) {
  const page = createPage(summaryDefinition);
  page.onLoad(query || {});
  return page;
}

function openWishlistPage(query) {
  const page = createPage(wishlistDefinition);
  page.onLoad(query || {});
  return page;
}

function openRoutePage(routeId, archiveId) {
  const page = createPage(routeDefinition);
  page.onLoad({ archiveId: archiveId || archiveOf().archiveId, routeId });
  return page;
}

function lastNavUrl() {
  assert.ok(wxLog.navigations.length > 0, '应发出一次导航');
  return wxLog.navigations[wxLog.navigations.length - 1].url;
}

function queryOf(url) {
  const raw = (url || '').split('?')[1] || '';
  const params = new Map();
  raw
    .split('&')
    .filter(Boolean)
    .forEach(pair => {
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? '' : pair.slice(index + 1);
      params.set(key, decodeURIComponent(value));
    });
  return params;
}

function assertRecordNav(url, sessionId, routeId) {
  const params = queryOf(url);
  const archive = archiveOf();
  assert.equal(url.split('?')[0], RECORD_URL);
  assert.equal(params.get('archiveId'), archive.archiveId);
  assert.equal(params.get('sessionId'), sessionId);
  assert.equal(params.get('routeId'), routeId);
}

/** 从场内页真实「新建线路」表单建一条线；返回创建后的 routeId。 */
function addNewRouteThroughPage(page, input) {
  // 越过上一次「创建并选中」的提交窗口。
  tick(1000);
  page.openAddRoute(tapDataset({ mode: 'new' }));
  assert.equal(page.data.addRouteVisible, true, '加线面板应打开');
  assert.equal(page.data.addRouteMode, 'new');
  page.onNewRouteNameInput({ detail: { value: input.name } });
  if (typeof input.typeIndex === 'number') {
    page.onNewRouteTypeChange({ detail: { value: String(input.typeIndex) } });
  }
  if (typeof input.gradeIndex === 'number') {
    page.onNewRouteGradeChange({ detail: { value: String(input.gradeIndex) } });
  }
  const before = wxLog.navigations.length;
  page.createRoute();
  assert.equal(page.data.newRouteError, '', '新建线路不应报错：' + page.data.newRouteError);
  assert.equal(wxLog.navigations.length, before + 1, '创建并选中后直达这条线的单线记录');
  const sessionId = page.data.activeSession.id;
  const routeId = queryOf(lastNavUrl()).get('routeId');
  assertRecordNav(lastNavUrl(), sessionId, routeId);
  return routeId;
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
});

// ------------------------------------------------------------------ *
// 统一线路列表：0 / 1 / 4+
// ------------------------------------------------------------------ *

test('T037 统一线路列表：0/1/4+ 行、零把与文字状态都由真实行绑定与数据产生', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const wxss = fs.readFileSync(SESSION_WXSS, 'utf8');

  // 真实绑定：空场是「添加第一条线路」，有线时标题行里是「＋ 加线」，两者都走 openAddRoute。
  assert.match(wxml, /id="add-first-route"[\s\S]{0,200}bindtap="openAddRoute"/);
  assert.match(wxml, /id="add-route"[\s\S]{0,160}bindtap="openAddRoute"/);
  // 每一行都带渲染时的档案、场次、长期线路 ID 与唯一的整行入口。
  assert.match(wxml, /id="route-row-\{\{item\.id\}\}"/);
  assert.match(
    wxml,
    /id="route-row-\{\{item\.id\}\}"[\s\S]{0,400}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,160}data-session-id="\{\{activeSession\.id\}\}"[\s\S]{0,160}data-route-id="\{\{item\.id\}\}"[\s\S]{0,120}bindtap="openRecord"/
  );
  // 一行的内容：名称、等级、类型、本场有效把数与适用的文字状态。
  assert.match(wxml, /class="route-row-name">\{\{item\.name\}\}/);
  assert.match(wxml, /class="route-grade">\{\{item\.grade\}\}/);
  assert.match(wxml, /class="route-row-type">\{\{item\.climbType\}/);
  assert.match(wxml, /class="route-row-count">本场 \{\{item\.attemptCountText\}\}/);
  assert.match(wxml, /wx:if="\{\{item\.stateText\}\}"[\s\S]{0,200}\{\{item\.stateText\}\}/);
  // 只有这一份列表，没有第二套换线区。
  assert.equal(wxml.match(/id="route-list"/g).length, 1);
  assert.doesNotMatch(wxml, /id="route-switch"|routeSwitch/);
  // 长名换行显示，不截断、不省略；行宽不随名称长短变化。
  assert.match(wxss, /\.route-row-name\s*\{[\s\S]*?word-break:\s*break-all/);

  const session = seedSession('层级岩馆', '2026-11-09');
  const page = openSessionPage({});

  // 0 条：首屏只有空态与「添加第一条线路」，不写成 0 条冒充列表。
  assert.equal(page.data.activeSession.id, session.id);
  assert.equal(page.data.routes.length, 0);
  assert.equal(page.data.routeCountText, '');
  assert.equal(page.data.selectedRoute, null);

  // 1 条：默认抱石 V3，创建即选中；返回本场后是同一份一行零把的列表。
  const firstId = addNewRouteThroughPage(page, { name: '第一条线' });
  page.onShow();
  assert.equal(page.data.routes.length, 1);
  assert.equal(page.data.routeCountText, '本场 1 条');
  assert.equal(page.data.routes[0].id, firstId);
  assert.equal(page.data.routes[0].grade, 'V3');
  assert.equal(page.data.routes[0].climbType, '抱石');
  assert.equal(page.data.routes[0].attemptCountText, '0 把', '零把照实显示');
  assert.equal(page.data.routes[0].stateText, '', '没有适用状态时不出字');
  assert.equal(page.data.routes[0].isSelected, true);

  // 4 条：抱石长名、顶绳、先锋各占一行；所有行仍是同一套数据与绑定。
  const longName = '很长的线路名称'.repeat(5);
  const longId = addNewRouteThroughPage(page, { name: longName });
  const ropeId = addNewRouteThroughPage(page, {
    name: '顶绳线',
    typeIndex: 1,
    gradeIndex: 0
  });
  const leadId = addNewRouteThroughPage(page, {
    name: '先锋线',
    typeIndex: 2,
    gradeIndex: 1
  });

  const rows = page.data.routes;
  assert.equal(rows.length, 4);
  assert.equal(page.data.routeCountText, '本场 4 条');
  assert.deepEqual(
    rows.map(row => row.id),
    store.routesForSession(archiveOf(), session.id).map(route => route.id),
    '行顺序就是本场关联顺序，固定不重排'
  );
  assert.deepEqual(rows.map(row => row.climbType), ['抱石', '抱石', '顶绳', '先锋']);
  assert.deepEqual(rows.map(row => row.name), ['第一条线', longName, '顶绳线', '先锋线']);
  assert.equal(rows.find(row => row.id === longId).grade, 'V3');
  assert.equal(rows.find(row => row.id === ropeId).grade, archiveOf().routes.find(r => r.id === ropeId).grade);
  assert.equal(rows.find(row => row.id === leadId).grade, archiveOf().routes.find(r => r.id === leadId).grade);
  assert.ok(rows.every(row => row.attemptCountText === '0 把'), '新建的四条线都还是零把');
  assert.equal(rows.filter(row => row.isSelected).length, 1);
  assert.equal(rows[3].isSelected, true);

  // 记一把完攀之后回列表：只有那一行的读数与文字状态变化，别的行不动。
  const record = openRecordPage(longId, session.id);
  record.recordAttempt(
    tapDataset({
      result: 'send',
      archiveId: archiveOf().archiveId,
      sessionId: session.id,
      routeId: longId
    })
  );
  assert.equal(record.data.attempts.length, 1);
  page.onShow();
  const doneRow = page.data.routes.find(row => row.id === longId);
  assert.equal(doneRow.attemptCountText, '1 把');
  assert.equal(doneRow.stateText, '已完攀', '适用的完攀状态以文字给出');
  assert.equal(doneRow.stateKind, 'done');
  assert.equal(page.data.routes.find(row => row.id === firstId).attemptCountText, '0 把');
  assert.equal(page.data.routes.find(row => row.id === firstId).stateText, '');
});

// ------------------------------------------------------------------ *
// 加线：已有 / 新建 / 取消 / 重复 / 失败重试
// ------------------------------------------------------------------ *

test('T037 加线四条路径：已有复用、新建、取消不写盘、重复不新增、失败按原 routeId 重试', () => {
  const first = seedSession('加线岩馆', '2026-11-09');
  const existing = seedRoute(first.id, { name: '已有线', climbType: '抱石', grade: 'V3' });
  const second = seedSession('加线岩馆', '2026-11-09');

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, second.id);
  assert.equal(page.data.routes.length, 0);
  assert.equal(
    page.data.gymRoutes.some(route => route.id === existing.id),
    true,
    '同馆另一场的线可作为「本馆已有」加入'
  );

  // 打开与取消加线都不写盘、不改本场线路。
  const rawBeforeCancel = rawArchive();
  page.openAddRoute();
  assert.equal(page.data.addRouteVisible, true);
  assert.equal(page.data.addRouteMode, 'existing');
  page.cancelAddRoute();
  assert.equal(page.data.addRouteVisible, false);
  assert.equal(rawArchive(), rawBeforeCancel, '打开与取消加线不写盘');
  assert.equal(page.data.routes.length, 0);

  // 已有线：关联成功但选中落盘失败 → 不报成功，留原 routeId 的重试入口。
  page.openAddRoute();
  armSetFailAt(2);
  page.pickGymRoute(tapDataset({ routeId: existing.id }));
  assert.equal(linkCount(second.id, existing.id), 1, '关联已经落盘，只多这一条');
  assert.equal(page.data.linkRetry.routeId, existing.id, '重试沿用原 routeId');
  assert.ok(page.data.linkRetry.error, '选中失败要明确原因');
  assert.equal(page.data.storageError, '');
  assert.equal(archiveOf().activeRouteId, '', '选中失败不改当前线');
  assert.equal(wxLog.navigations.length, 0, '选中失败不打开单线页');

  // 重试同一个 routeId：只补选中，不新增关联，成功后直达这条线。
  armSetFailAt(0);
  page.retryLinkSelection(tapDataset({ routeId: page.data.linkRetry.routeId }));
  assert.equal(linkCount(second.id, existing.id), 1, '重试不新增第二条关联');
  assert.equal(archiveOf().activeRouteId, existing.id);
  assert.equal(wxLog.navigations.length, 1);
  assertRecordNav(lastNavUrl(), second.id, existing.id);

  // 重复关联同一条线：关联幂等，列表不出现第二行。
  page.onShow();
  page.openAddRoute();
  page.pickGymRoute(tapDataset({ routeId: existing.id }));
  assert.equal(linkCount(second.id, existing.id), 1, '重复加入不新增关联');
  assert.equal(page.data.routes.length, 1);
  assert.equal(page.data.routes[0].id, existing.id);

  // 新建：建线落盘失败不虚报成功，输入保留；重试成功且只多一条。
  page.onShow();
  tick(1000);
  resetWxLog();
  page.openAddRoute(tapDataset({ mode: 'new' }));
  page.onNewRouteNameInput({ detail: { value: '失败重试线' } });
  const routesBeforeFail = archiveOf().routes.length;
  armSetFailAt(1);
  page.createRoute();
  assert.ok(page.data.newRouteError, '创建落盘失败要明确报错');
  assert.equal(archiveOf().routes.length, routesBeforeFail, '失败不产生幻影线路');
  assert.equal(page.data.newRouteName, '失败重试线', '失败后保留输入，可原地重试');
  assert.equal(wxLog.navigations.length, 0, '失败不打开单线页');

  armSetFailAt(0);
  page.createRoute();
  assert.equal(archiveOf().routes.length, routesBeforeFail + 1, '重试只多一条线路');
  assert.equal(
    archiveOf().routes.filter(route => route.name === '失败重试线').length,
    1,
    '同一操作重试不产生第二条同名线路'
  );
  assert.equal(wxLog.navigations.length, 1);
  assertRecordNav(lastNavUrl(), second.id, queryOf(lastNavUrl()).get('routeId'));

  // 重复点击「创建并选中」：窗口内的第二次不再建线。
  tick(301);
  const routesAtDuplicate = archiveOf().routes.length;
  page.onNewRouteNameInput({ detail: { value: '重复提交线' } });
  page.createRoute();
  assert.equal(archiveOf().routes.length, routesAtDuplicate + 1);
  page.onNewRouteNameInput({ detail: { value: '重复提交线' } });
  page.createRoute();
  assert.match(page.data.notice, /刚提交过/);
  assert.equal(archiveOf().routes.length, routesAtDuplicate + 1, '连点不建第二条线');
});

// ------------------------------------------------------------------ *
// 点行进入单线、返回换线、无选中旧场、连点与导航失败
// ------------------------------------------------------------------ *

test('T037 整行点入单线、返回列表换线、无选中旧场可重选；同一坐标连点只开一次', () => {
  const session = seedSession('换线岩馆', '2026-11-09');
  const a = seedRoute(session.id, { name: 'A 线', climbType: '抱石', grade: 'V3' });
  const b = seedRoute(session.id, { name: 'B 线', climbType: '抱石', grade: 'V3' });
  const c = seedRoute(session.id, { name: 'C 线', climbType: '顶绳', grade: '5.10a' });
  const archiveId = archiveOf().archiveId;

  // A 先记两把；B、C 还是空的。
  ['fail', 'fail'].forEach(() => {
    const saved = store.saveAttempt({ sessionId: session.id, routeId: a.id, result: 'fail' });
    assert.equal(saved.ok, true, saved.error);
  });

  const page = openSessionPage({});
  const orderBefore = page.data.routes.map(row => row.id);
  assert.deepEqual(orderBefore, [a.id, b.id, c.id]);

  // 点 B 那一行：事件参数就是 WXML 渲染时带下来的归属。
  resetWxLog();
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: b.id }));
  assert.equal(wxLog.navigations.length, 1);
  assertRecordNav(lastNavUrl(), session.id, b.id);
  assert.equal(page.data.selectedRoute.id, b.id);
  const recordB = openRecordPage(b.id, session.id);
  assert.equal(recordB.data.selectedRoute.id, b.id);
  assert.equal(recordB.data.attempts.length, 0, 'B 没有拿到 A 的把次');

  // 系统返回本场（onShow）再点 A：只换当前线，行序不变，不新建线路/关联/把次。
  page.onShow();
  assert.deepEqual(page.data.routes.map(row => row.id), orderBefore, '返回列表行序不变');
  const counts = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: a.id }));
  assertRecordNav(lastNavUrl(), session.id, a.id);
  assert.equal(page.data.selectedRoute.id, a.id);
  assert.equal(page.data.routes.find(row => row.id === a.id).isSelected, true);
  assert.equal(page.data.routes.find(row => row.id === b.id).isSelected, false);
  const recordA = openRecordPage(a.id, session.id);
  assert.equal(recordA.data.attempts.length, 2, 'A 仍读到自己的两把');
  assert.equal(attemptsOf(session.id, b.id).length, 0, '换线没有把把次写到 B');
  assert.equal(archiveOf().routes.length, counts.routes, '换线不新建线路');
  assert.equal(archiveOf().sessionRoutes.length, counts.links, '换线不新增关联');
  assert.equal(archiveOf().attempts.length, counts.attempts, '换线不产生把次');

  // 同日另开一场再切回旧场：当前选择被清空，但本场三行仍在，可以直接再选原线。
  page.openSessionForm();
  page.onGymNameInput({ detail: { value: '换线岩馆' } });
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, session.id);
  page.switchSession(tapDataset({ sessionId: session.id }));
  assert.equal(page.data.activeSession.id, session.id);
  assert.equal(page.data.selectedRoute, null, '切场次只改归属：当前选择被清空');
  assert.equal(archiveOf().activeRouteId, '');
  assert.equal(page.data.routes.length, 3, '旧场的三行仍在，不必重新加线');
  assert.equal(page.data.routes.some(row => row.isSelected), false, '没有当前线时谁都不是已选');
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: a.id }));
  assert.equal(page.data.selectedRoute.id, a.id, '无选中旧场可以直接再选原线');
  assertRecordNav(lastNavUrl(), session.id, a.id);

  // 同一坐标快速连点：窗口内只发出一次导航；过窗后同一条线可以再点开。
  page.onShow();
  tick(1000);
  resetWxLog();
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: c.id }));
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: c.id }));
  assert.equal(wxLog.navigations.length, 1, '同一行的第二次点击不再打开第二个单线页');
  tick(301);
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: c.id }));
  assert.equal(wxLog.navigations.length, 2, '过窗后同一条线可以再点开');

  // 导航失败：留在本场、给出可重试提示；同一条线马上再点可以成功。
  page.onShow();
  tick(1000);
  resetWxLog();
  navFailNext = true;
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: b.id }));
  assert.equal(wxLog.navigations.length, 0);
  assert.match(page.data.notice, /没有打开/);
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: b.id }));
  assert.equal(wxLog.navigations.length, 1, '导航失败后按原 routeId 重试可以打开');
  assertRecordNav(lastNavUrl(), session.id, b.id);
});

// ------------------------------------------------------------------ *
// 三类线路：跨天锁定与绳攀重复
// ------------------------------------------------------------------ *

test('T037 三类线路：抱石跨天完攀锁定，绳攀跨天可再次完攀，状态只落对应行', () => {
  const day1 = seedSession('三类岩馆', '2026-11-09');
  const boulder = seedRoute(day1.id, { name: '抱石线', climbType: '抱石', grade: 'V4' });
  const rope = seedRoute(day1.id, { name: '顶绳线', climbType: '顶绳', grade: '5.10a' });
  const lead = seedRoute(day1.id, { name: '先锋线', climbType: '先锋', grade: '5.10b' });
  const archiveId = archiveOf().archiveId;

  // 第一天：抱石与顶绳各完攀一把，先锋只记一把未完成。
  const boulderDay1 = openRecordPage(boulder.id, day1.id);
  boulderDay1.recordAttempt(
    tapDataset({ result: 'send', archiveId, sessionId: day1.id, routeId: boulder.id })
  );
  const ropeDay1 = openRecordPage(rope.id, day1.id);
  ropeDay1.recordAttempt(
    tapDataset({ result: 'send', archiveId, sessionId: day1.id, routeId: rope.id })
  );
  const leadDay1 = openRecordPage(lead.id, day1.id);
  leadDay1.recordAttempt(
    tapDataset({ result: 'fail', archiveId, sessionId: day1.id, routeId: lead.id })
  );
  assert.equal(store.routeCompletion(archiveOf(), boulder.id).completed, true);
  assert.equal(store.routeCompletion(archiveOf(), rope.id).sendCount, 1);

  // 第二天同一岩馆另开一场，把三条线都关联进来。
  const day2 = seedSession('三类岩馆', '2026-11-10');
  [boulder, rope, lead].forEach(route => {
    const linked = store.linkRouteToSession(day2.id, route.id);
    assert.equal(linked.ok, true, linked.error);
  });
  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, day2.id);
  assert.equal(page.data.routes.length, 3);
  const boulderRow = page.data.routes.find(row => row.id === boulder.id);
  const ropeRow = page.data.routes.find(row => row.id === rope.id);
  const leadRow = page.data.routes.find(row => row.id === lead.id);
  assert.equal(boulderRow.stateText, '已完攀', '抱石跨天仍显示已完攀');
  assert.equal(ropeRow.stateText, '', '绳攀完攀不锁定，也不冒充抱石完攀');
  assert.equal(leadRow.attemptCountText, '0 把', '新场次自己的有效把数是 0');

  // 抱石第二天再记：跨天锁定，不改任何把次。
  const boulderCountBefore = attemptsOf(day2.id, boulder.id).length;
  const boulderDay2 = openRecordPage(boulder.id, day2.id);
  assert.equal(boulderDay2.data.routeClosed, true);
  assert.equal(boulderDay2.data.routeRepeatable, false);
  boulderDay2.recordAttempt(
    tapDataset({ result: 'send', archiveId, sessionId: day2.id, routeId: boulder.id })
  );
  assert.ok(boulderDay2.data.notice, '抱石已完攀要说明不能重复记');
  assert.equal(attemptsOf(day2.id, boulder.id).length, boulderCountBefore);

  // 顶绳第二天再完攀：绳攀可重复，第二天的这一把单独落盘。
  const ropeDay2 = openRecordPage(rope.id, day2.id);
  assert.equal(ropeDay2.data.routeRepeatable, true);
  ropeDay2.recordAttempt(
    tapDataset({ result: 'send', archiveId, sessionId: day2.id, routeId: rope.id })
  );
  assert.equal(ropeDay2.data.notice, '');
  assert.equal(attemptsOf(day2.id, rope.id).length, 1);
  assert.equal(store.routeCompletion(archiveOf(), rope.id).sendCount, 2, '两次完攀各自保留');

  // 回到第一天看：三行的把数与状态仍按各自场次读，没有串。
  page.switchSession(tapDataset({ sessionId: day1.id }));
  assert.equal(page.data.routes.length, 3);
  assert.equal(page.data.routes.find(row => row.id === boulder.id).attemptCountText, '1 把');
  assert.equal(page.data.routes.find(row => row.id === rope.id).attemptCountText, '1 把');
  assert.equal(page.data.routes.find(row => row.id === lead.id).attemptCountText, '1 把');
});

// ------------------------------------------------------------------ *
// 缺必需 ID 与换档后的旧事件
// ------------------------------------------------------------------ *

test('T037 缺必需 ID、串场与换档后同 ID 的旧事件：不打开、不写档', () => {
  const session = seedSession('归属岩馆', '2026-11-09');
  const route = seedRoute(session.id, { name: '归属线', climbType: '抱石', grade: 'V3' });
  const archiveId = archiveOf().archiveId;
  const saved = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(saved.ok, true, saved.error);

  // 单线页缺 routeId / sessionId：显示上下文错误，结果按钮的点击不写档。
  const missingAll = createPage(recordDefinition);
  missingAll.onLoad({});
  assert.ok(missingAll.data.contextError, '缺必需归属要明确报错');
  const rawBefore = rawArchive();
  missingAll.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(rawArchive(), rawBefore, '缺参页面不写档');

  const missingSession = createPage(recordDefinition);
  missingSession.onLoad({ archiveId, routeId: route.id });
  assert.ok(missingSession.data.contextError, '缺 sessionId 也拒绝打开');
  assert.equal(missingSession.data.attempts.length, 0);

  // 场内页：另一场 / 另一份档案 / 已不在本场的线路，都只提示不改数据。
  const page = openSessionPage({});
  page.openSessionForm();
  page.onGymNameInput({ detail: { value: '归属岩馆' } });
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  page.switchSession(tapDataset({ sessionId: session.id }));

  resetWxLog();
  const attemptsAtStale = archiveOf().attempts.length;
  page.openRecord(
    tapDataset({ archiveId, sessionId: secondSessionId, routeId: route.id })
  );
  assert.equal(wxLog.navigations.length, 0, '上一场的旧点击不打开单线页');
  assert.match(page.data.notice, /上一场/);
  page.openRecord(
    tapDataset({ archiveId: 'archive-of-another-profile', sessionId: session.id, routeId: route.id })
  );
  assert.equal(wxLog.navigations.length, 0, '另一份档案的旧点击不打开单线页');
  assert.match(page.data.notice, /档案/);
  page.openRecord(tapDataset({ archiveId, sessionId: session.id, routeId: 'route-not-in-session' }));
  assert.equal(wxLog.navigations.length, 0, '不在本场的线路不打开');
  assert.match(page.data.notice, /不在本场/);
  assert.equal(archiveOf().attempts.length, attemptsAtStale, '这些旧点击都不产生把次');

  // 换档后同一个 routeId：单线页发起时的档案已不是现在这一份，整条不写进新档。
  const record = openRecordPage(route.id, session.id);
  const rawCurrent = JSON.parse(rawArchive());
  const attemptsBeforeSwap = rawCurrent.attempts.length;
  rawCurrent.archiveId = 'archive-b';
  const swapped = JSON.stringify(rawCurrent);
  storage.set(ARCHIVE_KEY, swapped);
  assert.equal(archiveOf().archiveId, 'archive-b');
  record.recordAttempt(
    tapDataset({ result: 'fail', archiveId, sessionId: session.id, routeId: route.id })
  );
  assert.equal(storage.get(ARCHIVE_KEY), swapped, '换档后的旧事件不改新档案');
  assert.equal(JSON.parse(storage.get(ARCHIVE_KEY)).attempts.length, attemptsBeforeSwap);
  assert.match(record.data.notice, /原来的本机档案/);
});

// ------------------------------------------------------------------ *
// 小结按原 session 打开
// ------------------------------------------------------------------ *

test('T037 小结按入口原 sessionId 打开：换看只读，缺归属不拿当前场次顶替', () => {
  const session1 = seedSession('小结岩馆', '2026-11-10');
  const routeA = seedRoute(session1.id, { name: '小结 A 线', climbType: '抱石', grade: 'V3' });
  ['fail', 'fail'].forEach(() => {
    const saved = store.saveAttempt({ sessionId: session1.id, routeId: routeA.id, result: 'fail' });
    assert.equal(saved.ok, true, saved.error);
  });
  const session2 = seedSession('小结岩馆', '2026-11-10');
  const routeB = seedRoute(session2.id, { name: '小结 B 线', climbType: '顶绳', grade: '5.10a' });
  const savedB = store.saveAttempt({ sessionId: session2.id, routeId: routeB.id, result: 'fail' });
  assert.equal(savedB.ok, true, savedB.error);
  const archiveId = archiveOf().archiveId;
  assert.equal(archiveOf().activeSessionId, session2.id);

  // 场内页带着原 sessionId 进入：入口明确指向 S1，即使当前活动场次是 S2。
  const page = openSessionPage({ sessionId: session1.id });
  assert.equal(page.data.summaryEntrySessionId, session1.id);
  assert.equal(page.data.summaryEntryViewingOther, true);
  resetWxLog();
  const rawBefore = rawArchive();
  page.openSessionSummary();
  assert.equal(wxLog.navigations.length, 1);
  const params = queryOf(lastNavUrl());
  assert.equal(params.get('sessionId'), session1.id);
  assert.equal(params.get('archiveId'), archiveId);
  assert.equal(rawArchive(), rawBefore, '打开小结入口不写档');

  // 独立小结页按同一组参数打开：只读 S1 的两把，不掺 S2。
  const summary = openSummaryPage({
    sessionId: params.get('sessionId'),
    archiveId: params.get('archiveId')
  });
  assert.equal(summary.data.summaryReady, true, summary.data.summaryError);
  assert.equal(summary.data.summarySessionId, session1.id);
  assert.equal(summary.data.summaryCountText, '1 条线 · 2 把');
  assert.deepEqual(summary.data.summaryRows.map(row => row.routeId), [routeA.id]);
  assert.equal(
    summary.data.summaryRows.some(row => row.routeId === routeB.id),
    false,
    'S2 的线不出现在 S1 的小结里'
  );
  assert.equal(summary.data.activeSessionId, session2.id, '当前场次仍是 S2');

  // 换看另一场只读：所看场次与读数变，当前场次与档案都不变。
  const s2Index = summary.data.summarySessionOptions.findIndex(option => option.id === session2.id);
  assert.ok(s2Index >= 0, 'S2 也在可回看的场次里');
  summary.onSummarySessionChange({ detail: { value: String(s2Index) } });
  assert.equal(summary.data.summarySessionId, session2.id);
  assert.equal(summary.data.summaryCountText, '1 条线 · 1 把');
  assert.deepEqual(summary.data.summaryRows.map(row => row.routeId), [routeB.id]);
  assert.equal(summary.data.activeSessionId, session2.id);
  assert.equal(rawArchive(), rawBefore, '换看小结不写档');

  // 缺 archiveId：说明无法核对归属，不展示任何场次（不拿当前 S2 顶替）。
  const noArchive = openSummaryPage({ sessionId: session1.id });
  assert.equal(noArchive.data.summaryReady, false);
  assert.equal(noArchive.data.summarySessionId, '');
  assert.match(noArchive.data.summaryError, /档案|archiveId/);
  assert.deepEqual(noArchive.data.summaryRows, []);

  // 缺 sessionId：说明这个入口没带要看哪一场，同样不回落当前场次。
  const noSession = openSummaryPage({ archiveId });
  assert.equal(noSession.data.summaryReady, false);
  assert.equal(noSession.data.summarySessionId, '');
  assert.match(noSession.data.summaryError, /sessionId|哪一场/);
  assert.deepEqual(noSession.data.summaryRows, []);
});

// ------------------------------------------------------------------ *
// 想爬清单回资料
// ------------------------------------------------------------------ *

test('T037 想爬清单按原 archiveId + routeId 回资料，同名异馆不串，返回后活动场次不变', () => {
  const sessionA = seedSession('同名 A 馆', '2026-11-09');
  const routeA = seedRoute(sessionA.id, { name: '同名线', climbType: '抱石', grade: 'V3' });
  const sessionB = seedSession('同名 B 馆', '2026-11-09');
  const routeB = seedRoute(sessionB.id, { name: '同名线', climbType: '顶绳', grade: '5.10a' });
  const savedB = store.saveAttempt({ sessionId: sessionB.id, routeId: routeB.id, result: 'fail' });
  assert.equal(savedB.ok, true, savedB.error);
  assert.equal(wishlist.addWishlist(routeA.id).ok, true);
  assert.equal(wishlist.addWishlist(routeB.id).ok, true);
  assert.notEqual(routeA.id, routeB.id);

  const archiveId = archiveOf().archiveId;
  const activeBefore = archiveOf().activeSessionId;
  const page = openWishlistPage({ archiveId });
  assert.equal(page.data.claimError, '');
  assert.equal(page.data.itemCount, 2);
  assert.deepEqual(page.data.groups.map(group => group.gymName), ['同名 A 馆', '同名 B 馆']);

  // 清单行真实绑定：档案 ID 与长期线路 ID 一起带进 dataset，整行走 openRoute。
  const wxml = fs.readFileSync(WISHLIST_WXML, 'utf8');
  assert.match(
    wxml,
    /id="wishlist-row-\{\{route\.routeId\}\}"[\s\S]{0,240}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,120}data-route-id="\{\{route\.routeId\}\}"[\s\S]{0,80}bindtap="openRoute"/
  );

  // 点 B 馆那一行：导航带原档案与原 routeId，按 B 的长期 ID 打开资料。
  resetWxLog();
  page.openRoute(tapDataset({ archiveId: page.data.archiveId, routeId: routeB.id }));
  assert.equal(wxLog.navigations.length, 1);
  const navUrl = lastNavUrl();
  assert.equal(navUrl.split('?')[0], ROUTE_URL);
  const params = queryOf(navUrl);
  assert.equal(params.get('archiveId'), archiveId);
  assert.equal(params.get('routeId'), routeB.id);
  assert.equal(rawArchive(), rawArchive(), '单纯导航不改档案');

  const routePageB = openRoutePage(params.get('routeId'), params.get('archiveId'));
  assert.equal(routePageB.data.route.id, routeB.id);
  assert.equal(routePageB.data.route.name, '同名线');
  assert.equal(routePageB.data.route.climbType, '顶绳');
  assert.equal(routePageB.data.attemptCountText, '1 把', '资料页读到 B 自己的把次');
  assert.equal(routePageB.data.wishlistState.status, 'wanted');

  // A 馆同名线仍是自己那一条：ID、类型与把数都不借用 B 的。
  const routePageA = openRoutePage(routeA.id, archiveId);
  assert.equal(routePageA.data.route.id, routeA.id);
  assert.equal(routePageA.data.route.climbType, '抱石');
  assert.equal(routePageA.data.attemptCountText, '0 把');
  assert.equal(routePageA.data.wishlistState.status, 'wanted');

  // 返回清单：条目与分组不变，活动场次不变。
  page.onShow();
  assert.equal(page.data.itemCount, 2);
  assert.deepEqual(page.data.groups.map(group => group.gymName), ['同名 A 馆', '同名 B 馆']);
  assert.equal(archiveOf().activeSessionId, activeBefore, '清单点开与返回都不改活动场次');

  // 换档后的旧行：带的是上一份档案 ID，只说明原因，不按同名 routeId 打开新档。
  resetWxLog();
  page.openRoute(tapDataset({ archiveId: 'archive-of-another-profile', routeId: routeA.id }));
  assert.equal(wxLog.navigations.length, 0);
  assert.match(page.data.entryNotice, /上一份档案/);

  // 缺档案归属的旧行同样不打开。
  page.openRoute(tapDataset({ routeId: routeA.id }));
  assert.equal(wxLog.navigations.length, 0);
});

test('T037 资料页归属不符：不展示、不受理写入，只留回到本场的出口', () => {
  const session = seedSession('资料归属馆', '2026-11-09');
  const route = seedRoute(session.id, { name: '资料归属线', climbType: '抱石', grade: 'V3' });
  const saved = store.saveAttempt({ sessionId: session.id, routeId: route.id, result: 'fail' });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(wishlist.addWishlist(route.id).ok, true);

  const rawBefore = rawArchive();
  resetWxLog();
  // 入口带的是另一份档案：同名的 routeId 不能顶替本档里那一条线。
  const page = openRoutePage(route.id, 'archive-of-another-profile');
  assert.match(page.data.claimError, /另一份本机档案/);
  assert.equal(page.data.route, null, '不展示任何线路内容');
  assert.equal(page.data.wishlistState, null);
  assert.equal(page.data.canRecordAgain, false);
  assert.equal(page.data.routePhoto, null);

  // 写入口与离开本页的记录入口都不受理。
  page.recordAgain();
  page.openRecordFromHistory(tapDataset({ sessionId: session.id, routeId: route.id }));
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '归属不符时任何操作都不写档');
  assert.equal(wxLog.navigations.length, 0, '不打开单线页');

  // WXML 只留「返回本场线路」这一个出口，且绑定真实处理器。
  const wxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  assert.match(
    wxml,
    /id="claim-error"[\s\S]{0,500}id="claim-back"[\s\S]{0,120}bindtap="backToList"/
  );
  assert.equal(typeof routeDefinition.backToList, 'function');
  page.backToList();
  assert.equal(wxLog.backs.length, 1, '正常路径是系统返回');
});

// ------------------------------------------------------------------ *
// T037 返工：原生视觉（V01/V02/V03/V05）与 4px 主间距（O01）
// ------------------------------------------------------------------ *

test('T037 返工 训练页页底/内容区、44px 清单命中、设备黑体与 4px 主间距', () => {
  const read = file => fs.readFileSync(path.join(ROOT, 'pages', file), 'utf8');
  const pages = {
    session: { wxss: read('training-session/training-session.wxss') },
    record: { wxss: read('training-record/training-record.wxss') },
    attempts: { wxss: read('training-attempts/training-attempts.wxss') },
    route: { wxss: read('training-route/training-route.wxss') },
    summary: { wxss: read('training-summary/training-summary.wxss') },
    wishlist: { wxss: read('training-wishlist/training-wishlist.wxss') }
  };

  // V01：六个训练页局部页底浅灰 #F2F4F3；逐把明细的记录行回到白色内容区，
  // 不再透明露出 app.wxss 的旧米色页底。
  Object.entries(pages).forEach(([name, page]) => {
    assert.match(page.wxss, /#F2F4F3/, name + ' 局部页底为 #F2F4F3');
  });
  assert.match(
    pages.attempts.wxss,
    /\.attempt-item \{[^}]*background-color: #FFFFFF/,
    '明细行是白色内容区'
  );
  assert.match(pages.attempts.wxss, /\.card \{[^}]*background-color: #FFFFFF/);

  // V02：卡点清单行是图片小编号的替代选择入口，行至少 44px；图片编号保持原定位大小。
  assert.match(pages.route.wxss, /\.mark-item \{[^}]*min-height: 44px/, '清单行 44px');
  assert.match(pages.route.wxss, /\.mark-item-index \{[^}]*height: 44rpx/, '图片编号仍小');
  // V03：当天再记的真实选场行至少 44px。
  assert.match(
    pages.route.wxss,
    /\.session-option \{[^}]*min-height: 44px/,
    '选场行 44px'
  );

  // V05：训练页标题/计数一律设备中文黑体；app.wxss 的全局规则保持不动。
  Object.entries(pages).forEach(([name, page]) => {
    assert.equal(
      /Songti|SimSun|Noto Serif/.test(page.wxss),
      false,
      name + ' 不再显式使用宋体'
    );
  });
  assert.match(pages.session.wxss, /\.card-title \{[^}]*PingFang SC/);
  assert.match(pages.session.wxss, /\.section-title \{[^}]*PingFang SC/);
  assert.match(pages.summary.wxss, /\.summary-count \{[^}]*PingFang SC/);
  assert.match(pages.route.wxss, /\.route-name \{[^}]*PingFang SC/);
  assert.match(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8'), /Songti SC/);

  // O01：主 page/card 间距用 4px 设计令牌（文本高度与响应式宽不在此列）。
  assert.match(pages.session.wxss, /\.page \{[^}]*padding: 12px 12px 32px/);
  assert.match(pages.session.wxss, /\.card \{[^}]*padding: 16px/);
  assert.match(pages.record.wxss, /\.page \{[^}]*padding: 12px 12px 32px/);
  assert.match(pages.attempts.wxss, /\.page \{[^}]*padding: 12px 16px 28px/);
  assert.match(pages.route.wxss, /\.page \{ padding:12px 12px 28px/);
  assert.match(pages.summary.wxss, /\.page \{ padding: 12px 12px 28px/);
  assert.match(pages.wishlist.wxss, /\.page \{[^}]*padding: 12px 12px 32px/);
  Object.entries(pages).forEach(([name, page]) => {
    assert.match(page.wxss, /\.card \{[^}]*padding: 16px/, name + ' 卡片 16px');
  });
});

// ------------------------------------------------------------------ *
// T044 本场线路：一线一卡
// ------------------------------------------------------------------ *

/** 去掉注释后按选择器取声明块（同一选择器出现多次时按 CSS 顺序合并）。 */
function declarationsOf(wxss, selector) {
  const clean = wxss.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').map(text => text.trim()).includes(selector))
    .map(match => match[2])
    .join('\n');
}

test('T044 本场一线一卡：每行中性卡框并留卡间间距，当前线有短文字标记，行身份与顺序不变', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const wxss = fs.readFileSync(SESSION_WXSS, 'utf8');

  // 卡框在每一行上，列表只负责纵向排布与卡间距；不再用一个大边框包住所有行。
  const listCss = declarationsOf(wxss, '.route-list');
  assert.match(listCss, /display:\s*flex/);
  assert.match(listCss, /gap:\s*12px/, '卡与卡之间留 12px 间距');
  assert.doesNotMatch(listCss, /border:\s*1px solid/, '列表本身不再是一张大卡');
  const rowCss = declarationsOf(wxss, '.route-row');
  assert.match(rowCss, /border:\s*1px solid #D7DED9/, '每一条线一条中性细边框');
  assert.match(rowCss, /border-radius:\s*8rpx/);
  assert.doesNotMatch(wxss, /\.route-row\s*\+\s*\.route-row/, '相邻线路不再靠分隔线区分');

  // 当前线：标题旁短文字「当前」+ 左侧墨绿边缘标记，标记跟着行而非另起控件。
  assert.match(
    wxml,
    /class="route-row-title">[\s\S]{0,160}class="route-row-name">\{\{item\.name\}\}[\s\S]{0,260}wx:if="\{\{item\.isSelected\}\}"[\s\S]{0,160}class="route-row-current"[\s\S]{0,40}>当前</
  );
  assert.match(wxss, /\.route-row-on\s*\{[^}]*box-shadow:\s*inset 8rpx 0 0 #1F5948/);
  // 整行仍是唯一的打开入口，点行带的是原档案、场次与长期线路 ID。
  assert.match(
    wxml,
    /id="route-row-\{\{item\.id\}\}"[\s\S]{0,400}data-route-id="\{\{item\.id\}\}"[\s\S]{0,160}bindtap="openRecord"/
  );

  // 同色同级两条线各占一张卡，顺序就是本场关联顺序；长名照原样留在卡内。
  const session = seedSession('卡框岩馆', '2026-11-11');
  const first = seedRoute(session.id, {
    name: '同色同级线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  const second = seedRoute(session.id, {
    name: '同色同级线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  const longName = '很长的线路名称'.repeat(5);
  const long = seedRoute(session.id, {
    name: longName,
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });

  const page = openSessionPage({});
  assert.deepEqual(
    page.data.routes.map(row => row.id),
    [first.id, second.id, long.id],
    '同色同级也按原关联顺序各占一张卡，不按名称颜色归并'
  );
  assert.equal(page.data.routes.filter(row => row.isSelected).length, 1);
  assert.equal(page.data.routes[2].isSelected, true, '刚建的那张卡是当前线');
  assert.equal(page.data.routes[2].name, longName, '长名完整保留在卡内');
});

// ------------------------------------------------------------------ *
// T048 单线逐把紧凑布局：窄屏单列层级
// ------------------------------------------------------------------ *

test('T048 320/390 窄屏：本场逐把仍是单列文档流，最新卡与旧行高度分层，不靠固定宽度或横向滚动', () => {
  const recordWxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxml'),
    'utf8'
  );
  const recordWxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxss'),
    'utf8'
  );

  // 列表是一列纵向排布：三个宽度共用同一套布局，不做按宽度的分栏。
  const listCss = declarationsOf(recordWxss, '.record-attempts');
  assert.match(listCss, /display:\s*flex/);
  assert.match(listCss, /flex-direction:\s*column/);
  assert.doesNotMatch(recordWxss, /@media[^{]*\{[^}]*record-attempt/, '紧凑布局不按屏宽分支出第二套');

  // 最新一把完整、更早的把次短行：两者都在同一列，各自宽度随屏宽，不写死 px 宽度。
  for (const selector of ['.record-attempt-latest', '.record-attempt-compact']) {
    const css = declarationsOf(recordWxss, selector);
    assert.ok(css, '缺少 ' + selector);
    assert.doesNotMatch(css, /(^|;)\s*width\s*:/, selector + ' 不写死宽度');
    assert.doesNotMatch(css, /position\s*:\s*(absolute|fixed)/, selector + ' 不用绝对定位');
    assert.doesNotMatch(css, /overflow-x\s*:\s*scroll/, selector + ' 不横向滚动');
  }
  const t048MinHeight = selector => {
    const found = declarationsOf(recordWxss, selector).match(/min-height\s*:\s*([^;]+)/);
    return found ? found[1].trim() : '';
  };
  assert.equal(t048MinHeight('.record-attempt-latest'), '100px');
  assert.equal(t048MinHeight('.record-attempt-compact'), '48px');

  // 旧行整行可点：行首 44px 命中区，序号、结果与时间都留在行内，不收起。
  assert.equal(t048MinHeight('.record-attempt-headline'), '44px');
  const compactCss = declarationsOf(recordWxss, '.record-attempt-compact');
  assert.doesNotMatch(compactCss, /display:\s*none/, '短行只压缩高度，不隐藏内容');
  const headlineAt = recordWxml.indexOf('class="record-attempt-headline');
  const headline = recordWxml.slice(
    headlineAt,
    recordWxml.indexOf('wx:if="{{item.expanded}}"', headlineAt)
  );
  assert.match(headline, /record-attempt-label/);
  assert.match(headline, /record-attempt-result/);
  assert.match(headline, /record-attempt-time/);

  // 长备注不会把窄屏撑出横向滚动：摘要行内省略，宽度跟随容器。
  assert.match(declarationsOf(recordWxss, '.record-attempt-note-summary'), /overflow:\s*hidden/);
  assert.doesNotMatch(recordWxml.slice(recordWxml.indexOf('id="record-attempts"')), /<scroll-view/);

  // 三把夹具的数据层级：第 3 把完整，第 2、1 把短行；原编号、结果、时间逐把对应。
  const session = seedSession('窄屏岩馆', '2026-11-12');
  const route = seedRoute(session.id, {
    name: '窄屏顶绳线',
    climbType: '顶绳',
    grade: '5.10a',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  const saved = ['fail', 'send', 'fail'].map((result, index) => {
    const outcome = store.saveAttempt({
      sessionId: session.id,
      routeId: route.id,
      result,
      note: index === 2 ? '长备注'.repeat(12) : '第' + (index + 1) + '把',
      now: new Date(2026, 10, 12, 9, 10 + index * 5)
    });
    assert.equal(outcome.ok, true, outcome.error);
    return outcome.attempt;
  });

  const page = openRecordPage(route.id, session.id);
  const cards = page.data.attemptCards;
  assert.deepEqual(
    cards.map(row => row.label),
    ['第 3 把', '第 2 把', '第 1 把'],
    '三把夹具按原序号倒序'
  );
  assert.deepEqual(cards.map(row => row.expanded), [true, false, false]);
  assert.equal(cards[0].id, saved[2].id);
  assert.equal(cards[0].note, '长备注'.repeat(12), '长备注原文保留，摘要单行由样式收口');
  assert.equal(cards[0].isSend, false);
  assert.equal(cards[1].isSend, true, '第 2 把完攀仍带墨绿状态文字');
  assert.ok(cards.every(row => row.timeText), '每把都有时间');
  assert.equal(page.data.expandedAttemptId, '');
});

test('T048 返工 320 窄屏：旧把备注入口与视频入口同排不换行，编辑区按 rpx 缩放约两行', () => {
  const recordWxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxml'),
    'utf8'
  );
  const recordWxss = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-record', 'training-record.wxss'),
    'utf8'
  );

  // 旧把展开后：备注入口靠左、视频入口靠右，同排不换行，两个宽度都够点。
  const olderActions = declarationsOf(
    recordWxss,
    '.record-attempt-detail-older .record-attempt-detail-actions'
  );
  assert.match(olderActions, /flex-wrap:\s*nowrap/);
  assert.match(olderActions, /justify-content:\s*space-between/);
  assert.doesNotMatch(olderActions, /(^|;)\s*width\s*:\s*\d+px/, '不写死 px 宽度');
  assert.match(
    declarationsOf(recordWxss, '.record-attempt-detail-older .record-attempt-edit'),
    /white-space:\s*nowrap/
  );
  assert.match(
    declarationsOf(recordWxss, '.record-attempt-video-action'),
    /min-height:\s*44px/,
    '视频入口保留 44px 可点高度'
  );

  // 备注输入约两行：行内高度用 rpx 随屏宽缩放，不再回到原生 150px。
  assert.match(recordWxml, /style="height: 132rpx;"/, '行内高度按 rpx 缩放');
  assert.doesNotMatch(
    recordWxss,
    /\.note-input\s*\{[^}]*height:\s*\d+px/,
    '输入高度不写死 px'
  );
  const section = recordWxml.slice(recordWxml.indexOf('id="record-attempts"'));
  assert.doesNotMatch(section, /<scroll-view/, '展开区仍在普通文档流里');
});
