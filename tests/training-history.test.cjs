/**
 * T018 本机训练历史、跨天接续与旧记录只读回看回归测试（R3、R6 的离线部分）
 *
 * 直接加载真实页面文件（pages/record-list、pages/record-detail、pages/training-route，
 * 以及驱动「当天再记」用的 pages/training-session），捕获 Page(...) 定义，用隔离的微信
 * 本地存储替身与写入故障注驱动真实页面处理器，并核对 WXML 里的真实按钮绑定与导航目标。
 *
 * 刻意不提供 wx.cloud：本机历史、线路详情、当天再记与旧记录回看都不得依赖云能力；
 * 旧记录用可替换的 utils/db 响应与夹具注入，覆盖有数据、空库、拒绝访问、云不可用与
 * 读取失败五种情形，并逐字节核对本机档案没有被回写、清空或覆盖。
 *
 * 真机跨日回看、旧云真实权限（T004）与手机构建留给负责人整体验收（待验）。
 *
 * 运行：node --test tests/training-history.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const LIST_JS = path.join(ROOT, 'pages', 'record-list', 'record-list.js');
const LIST_WXML = path.join(ROOT, 'pages', 'record-list', 'record-list.wxml');
const DETAIL_JS = path.join(ROOT, 'pages', 'record-detail', 'record-detail.js');
const DETAIL_WXML = path.join(ROOT, 'pages', 'record-detail', 'record-detail.wxml');
const ROUTE_JS = path.join(ROOT, 'pages', 'training-route', 'training-route.js');
const ROUTE_WXML = path.join(ROOT, 'pages', 'training-route', 'training-route.wxml');
const ROUTE_JSON = path.join(ROOT, 'pages', 'training-route', 'training-route.json');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，可按需注入故障 ----
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

function rawArchive() {
  return storage.has(ARCHIVE_KEY) ? storage.get(ARCHIVE_KEY) : '';
}

const wxLog = { navigations: [], switches: [], toasts: [], previews: [] };

function resetWxLog() {
  wxLog.navigations = [];
  wxLog.switches = [];
  wxLog.toasts = [];
  wxLog.previews = [];
}

// 刻意不带 cloud：T018 的本机回看与新入口不得依赖云能力。
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
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: [...storage.keys()] };
  },
  navigateTo(options) {
    wxLog.navigations.push({ type: 'navigateTo', url: options.url });
  },
  navigateBack(options) {
    wxLog.navigations.push({ type: 'navigateBack', url: options ? options.url : '' });
  },
  reLaunch(options) {
    wxLog.navigations.push({ type: 'reLaunch', url: options.url });
  },
  switchTab(options) {
    wxLog.switches.push(options);
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  previewImage(options) {
    wxLog.previews.push(options);
  },
  stopPullDownRefresh() {}
};

const db = require(DB_JS);
const realDb = {
  getRecords: db.getRecords,
  getRecordById: db.getRecordById,
  deleteRecord: db.deleteRecord,
  deleteImage: db.deleteImage
};
const store = require(STORE_JS);

let deleteCalls = 0;

function useCloudRecords(handler) {
  db.getRecords = (page, pageSize) => handler(page, pageSize);
}

function useCloudRecord(handler) {
  db.getRecordById = id => handler(id);
}

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

const listDefinition = capturePage(LIST_JS);
const detailDefinition = capturePage(DETAIL_JS);
const routeDefinition = capturePage(ROUTE_JS);
const sessionDefinition = capturePage(SESSION_JS);
const recordDefinition = capturePage(RECORD_JS);

/**
 * 页面实例替身：支持 wx 的 setData 数据路径写法（如 'noteEditor.text'）。
 */
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

function tapResult(result) {
  return { currentTarget: { dataset: { result } } };
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

// ---- 页面打开入口 ----
function openRoutePage(routeId) {
  const page = createPage(routeDefinition);
  page.onLoad({ routeId });
  return page;
}

function openListPage() {
  const page = createPage(listDefinition);
  page.onLoad();
  return page;
}

async function openDetailPage(id) {
  const page = createPage(detailDefinition);
  page.onLoad({ id });
  await flush();
  return page;
}

function openSessionPage(query) {
  const page = createPage(sessionDefinition);
  page.onLoad(query || {});
  return page;
}

/** 单线记录页（T036）：按档案 + 场次 + 长期线路 ID 打开。 */
function openRecordFor(sessionId, routeId) {
  const page = createPage(recordDefinition);
  page.onLoad({ archiveId: archiveOf().archiveId, sessionId, routeId });
  assert.equal(page.data.contextError, '', '单线页应能按原归属打开');
  return page;
}

// ---- 走正式档案层搭建夹具（页面只读，夹具一律经 store 或真实档案夹具注入） ----
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

function record(session, route, result, note, at) {
  const saved = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result,
    note: note || '',
    now: at ? new Date(at) : undefined
  });
  assert.equal(saved.ok, true, saved.error);
  return saved.attempt;
}

function archiveOf() {
  return store.loadState().archive;
}

function attemptsOf(routeId) {
  return archiveOf()
    .attempts.filter(item => item.routeId === routeId)
    .sort((left, right) => left.seq - right.seq);
}

/**
 * 真实档案夹具：v1 格式的完整档案，用于复现「多条历史完攀」「旧汇总」等无法由页面
 * 正常操作产生的历史数据（对应任务单要求的夹具验证）。只读，不迁移。
 */
function writeArchiveFixture(spec) {
  const archive = {
    version: 1,
    archiveId: 'archive-fixture',
    nextGymSeq: 2,
    nextSessionSeq: spec.sessions.length + 1,
    nextRouteSeq: spec.routes.length + 1,
    nextAttemptSeq: spec.attempts.length + 1,
    gyms: [{ id: 'gym-1', name: spec.gymName || '夹具岩馆', createdAt: '2020-01-01T00:00:00.000Z' }],
    sessions: spec.sessions,
    routes: spec.routes,
    sessionRoutes: spec.sessionRoutes || [],
    attempts: spec.attempts,
    pendingSaves: [],
    pendingCorrections: [],
    activeSessionId: spec.activeSessionId || '',
    activeRouteId: spec.activeRouteId || ''
  };
  storage.set(ARCHIVE_KEY, JSON.stringify(archive));
  return archive;
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
  deleteCalls = 0;
  db.getRecords = realDb.getRecords;
  db.getRecordById = realDb.getRecordById;
  db.deleteRecord = id => {
    deleteCalls += 1;
    return realDb.deleteRecord(id);
  };
  db.deleteImage = (...args) => {
    deleteCalls += 1;
    return realDb.deleteImage(...args);
  };
});

// ------------------------------------------------------------------ *
// 页面注册、绑定与禁止项
// ------------------------------------------------------------------ *

test('T018-1 app.json 注册长期线路详情页，tabBar 与旧路由保持不变，四件套齐全', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));

  assert.equal(appJson.pages[0], 'pages/index/index', '首页必须仍是正式首页');
  assert.ok(
    appJson.pages.includes('pages/training-route/training-route'),
    '长期线路详情页必须注册进 app.json'
  );
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'pages', 'training-route', 'training-route' + ext)),
      '缺少长期线路详情页文件 training-route' + ext
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
  for (const page of [
    'pages/training-session/training-session',
    'pages/add-record/add-record',
    'pages/record-list/record-list',
    'pages/record-detail/record-detail'
  ]) {
    assert.ok(appJson.pages.includes(page), page + ' 应保留在页面清单里');
  }
});

test('T018-2 WXML 绑定都有真实处理器，两条入口的 ID 路由互不混用', () => {
  const routeWxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  const listWxml = fs.readFileSync(LIST_WXML, 'utf8');
  const detailWxml = fs.readFileSync(DETAIL_WXML, 'utf8');

  const routeHandlers = new Set(handlersIn(routeWxml));
  for (const required of [
    'retryLoad',
    'correctSend',
    'recordAgain',
    'chooseSessionForAgain',
    'cancelSessionPicker'
  ]) {
    assert.ok(routeHandlers.has(required), '线路详情页应有绑定：' + required);
  }
  for (const handler of routeHandlers) {
    assert.equal(typeof routeDefinition[handler], 'function', '线路详情页绑定缺少处理器：' + handler);
  }

  const listHandlers = new Set(handlersIn(listWxml));
  for (const required of ['goToRouteDetail', 'goToDetail', 'retryRefresh', 'retryLoadMore']) {
    assert.ok(listHandlers.has(required), '记录列表应有绑定：' + required);
  }
  for (const handler of listHandlers) {
    assert.equal(typeof listDefinition[handler], 'function', '记录列表绑定缺少处理器：' + handler);
  }

  const detailHandlers = new Set(handlersIn(detailWxml));
  for (const handler of detailHandlers) {
    assert.equal(typeof detailDefinition[handler], 'function', '旧记录详情绑定缺少处理器：' + handler);
  }

  // 本机线路走 routeId（training-route），旧记录走原 _id（record-detail）。
  assert.match(fs.readFileSync(LIST_JS, 'utf8'), /\/pages\/training-route\/training-route\?routeId=/);
  assert.match(fs.readFileSync(LIST_JS, 'utf8'), /\/pages\/record-detail\/record-detail\?id=/);
  assert.match(listWxml, /data-route-id="\{\{item\.id\}\}"/);
  assert.match(listWxml, /data-id="\{\{item\._id\}\}"/);
  // 跨日回看按场次分组，更正控件逐把带自己的原把次与归属
  assert.match(routeWxml, /id="history-group-\{\{item\.sessionId\}\}"/);
  assert.match(routeWxml, /data-attempt-id="\{\{item\.attemptId\}\}"/);
  assert.match(routeWxml, /data-route-id="\{\{item\.routeId\}\}"/);
  assert.match(routeWxml, /data-session-id="\{\{item\.sessionId\}\}"/);

  const routeJson = JSON.parse(fs.readFileSync(ROUTE_JSON, 'utf8'));
  assert.equal(routeJson.navigationBarTitleText, '线路历史');
});

test('T018-3 正式页不引用 devtools/试用工程/虚构样例，线路详情与旧详情都不接云写', () => {
  for (const file of [ROUTE_JS, ROUTE_WXML, LIST_JS, LIST_WXML, DETAIL_JS, DETAIL_WXML]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(source, /devtools\//, name + ' 不得引用打包时被排除的 devtools 路径');
    assert.doesNotMatch(source, /gymLogTrial|trial-save-server|trial-profile/, name + ' 不得引用试用工程');
    assert.doesNotMatch(
      source,
      /虚构|故障演练|演练开关|重置试用|重置本地试用/,
      name + ' 不得展示演练或重置试用入口'
    );
    assert.doesNotMatch(source, /wx\.clearStorage\b|clearStorageSync/, name + ' 不得整片清空微信存储');
  }

  // 长期线路详情页只在正式本机档案上读写，不接云、不动旧集合。
  const routeSource = fs.readFileSync(ROUTE_JS, 'utf8');
  assert.match(routeSource, /utils\/training-store/, '线路详情页必须走正式本机档案层');
  assert.doesNotMatch(routeSource, /wx\.cloud/, '线路详情页不得调用云能力');

  // 旧记录详情只读回看：没有删除或上传入口，也没有直接云写调用。
  const detailSource = fs.readFileSync(DETAIL_JS, 'utf8');
  assert.doesNotMatch(detailSource, /deleteRecord|deleteImage|uploadImage/, '旧记录详情不得删除或上传');
  assert.doesNotMatch(detailSource, /wx\.cloud/, '旧记录详情不得直接调用云能力');
  assert.doesNotMatch(
    fs.readFileSync(DETAIL_WXML, 'utf8'),
    /bindtap="deleteRecord"/,
    '旧记录详情不得保留删除入口'
  );

  // 记录列表：本机历史只读档案，旧记录仍走 utils/db 的既有云接口。
  const listSource = fs.readFileSync(LIST_JS, 'utf8');
  assert.match(listSource, /utils\/training-store/);
  assert.match(listSource, /utils\/db/);
  assert.doesNotMatch(listSource, /wx\.cloud/, '记录列表不得直接调用云能力');
});

// ------------------------------------------------------------------ *
// R3 跨日回看与接续
// ------------------------------------------------------------------ *

test('R3 第一天两把未完成（第二把有备注）：详情按本地日期与场次分组，打开历史不建场次', () => {
  const day1 = '2020-04-02';
  const session = startAt(day1, '粉袋岩馆');
  const route = newRoute(session, { name: '蓝色动态线' });
  record(session, route, 'fail', '', day1 + 'T10:00:00');
  record(session, route, 'fail', '抓到后向右摆', day1 + 'T10:20:00');

  const rawBefore = rawArchive();

  const page = openRoutePage(route.id);

  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.notFound, false);
  assert.equal(page.data.route.id, route.id);
  assert.equal(page.data.route.name, '蓝色动态线');
  assert.equal(page.data.route.gymName, '粉袋岩馆');
  assert.equal(page.data.route.grade, 'V3');
  assert.equal(page.data.summaryText, '1 天 · 1 场 · 2 把');
  assert.equal(page.data.attemptCountText, '2 把');
  assert.equal(page.data.sendCount, 0);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.canRecordAgain, true);
  assert.equal(page.data.groups.length, 1);

  const group = page.data.groups[0];
  assert.equal(group.sessionId, session.id);
  assert.equal(group.dateText, day1);
  assert.equal(group.sessionLabel, '第 1 场');
  assert.equal(group.gymName, '粉袋岩馆');
  assert.equal(group.countText, '2 把');
  assert.deepEqual(group.attempts.map(item => item.label), ['第 1 把', '第 2 把']);
  assert.deepEqual(group.attempts.map(item => item.resultText), ['未完成', '未完成']);
  assert.equal(group.attempts[0].note, '');
  assert.equal(group.attempts[1].note, '抓到后向右摆');
  assert.match(group.attempts[0].timeText, /^\d{2}:\d{2}$/);

  // 打开历史只读：不建场次、不写盘、不跳转。
  assert.equal(rawArchive(), rawBefore, '打开历史不得改写本机档案');
  assert.equal(archiveOf().sessions.length, 1, '打开历史本身不建场次');
  assert.equal(wxLog.navigations.length, 0);
});

test('R3 第二天从历史打开原线，在新场次记完攀：两天两场三把；旁线数据不变', () => {
  const day1 = '2020-04-02';
  const today = store.todayLocalDate();

  const session1 = startAt(day1, '粉袋岩馆');
  const routeA = newRoute(session1, { name: '蓝色动态线' });
  const routeB = newRoute(session1, { name: '同色另一条' });
  record(session1, routeA, 'fail', '', day1 + 'T10:00:00');
  record(session1, routeA, 'fail', '抓到后向右摆', day1 + 'T10:20:00');
  const siblingAttempt = record(session1, routeB, 'fail', '旁线备注', day1 + 'T10:40:00');

  const detail = openRoutePage(routeA.id);
  assert.equal(detail.data.summaryText, '1 天 · 1 场 · 2 把');
  assert.equal(archiveOf().sessions.length, 1, '打开历史不建场次');

  // 「当天再记」：当日该岩馆还没有场次，才在这里新建一场并回到原线。
  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  assert.match(wxLog.navigations.at(-1).url, /^\/pages\/training-record\/training-record\?/);

  const afterAgain = archiveOf();
  assert.equal(afterAgain.sessions.length, 2, '当天再记新建当日一场');
  const todaySession = afterAgain.sessions.find(item => item.date === today);
  assert.ok(todaySession, '应有一场本地今天的场次');
  assert.equal(todaySession.gymId, session1.gymId);
  assert.equal(afterAgain.activeSessionId, todaySession.id);
  assert.equal(afterAgain.activeRouteId, routeA.id);
  assert.equal(afterAgain.attempts.length, 3, '当天再记不凭空生成把次');

  // 在新场次记一次完攀（单线记录页）
  const recordPage = openRecordFor(todaySession.id, routeA.id);
  assert.equal(recordPage.data.activeSession.id, todaySession.id);
  assert.equal(recordPage.data.selectedRoute.id, routeA.id);
  recordPage.recordAttempt(tapResult('send'));
  assert.equal(recordPage.data.attempts.length, 1);
  assert.equal(recordPage.data.attempts[0].resultText, '完攀');

  // 跨天历史按组回到原场次记录：带的是这一组的 sessionId 与当前 routeId。
  const navBefore = wxLog.navigations.length;
  const reopenedForHistory = openRoutePage(routeA.id);  reopenedForHistory.openRecordFromHistory(    tapDataset({ sessionId: todaySession.id, routeId: routeA.id })  );  assert.equal(wxLog.navigations.length, navBefore + 1);  assert.match(    wxLog.navigations.at(-1).url,    new RegExp('sessionId=' + todaySession.id + '.*routeId=' + routeA.id)  );
  const reopened = openRoutePage(routeA.id);
  assert.equal(reopened.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(reopened.data.attemptCount, 3);
  assert.equal(reopened.data.sendCount, 1);
  assert.equal(reopened.data.routeCompleted, true);
  assert.equal(reopened.data.canRecordAgain, false, '抱石已完攀不再给「当天再记」');
  assert.equal(reopened.data.groups.length, 2);
  assert.deepEqual(reopened.data.groups.map(group => group.dateText), [today, day1]);
  assert.deepEqual(
    reopened.data.groups[1].attempts.map(item => item.resultText),
    ['未完成', '未完成']
  );
  assert.equal(reopened.data.groups[1].attempts[1].note, '抓到后向右摆');
  assert.deepEqual(
    reopened.data.groups[0].attempts.map(item => item.resultText),
    ['完攀']
  );

  // 旁线数据不变：把次、备注与归属都保持原样。
  const sibling = attemptsOf(routeB.id);
  assert.equal(sibling.length, 1);
  assert.equal(sibling[0].id, siblingAttempt.id);
  assert.equal(sibling[0].note, '旁线备注');
  assert.equal(sibling[0].sessionId, session1.id);
  const siblingDetail = openRoutePage(routeB.id);
  assert.equal(siblingDetail.data.summaryText, '1 天 · 1 场 · 1 把');
});

test('R3 跨日详情把第三把改为未完成：仍三把零完攀，原时间/场次/备注都在；再完攀后四把一完攀', () => {
  const day1 = '2020-04-02';
  const today = store.todayLocalDate();

  const session1 = startAt(day1, '粉袋岩馆');
  const route = newRoute(session1, { name: '蓝色动态线' });
  record(session1, route, 'fail', '', day1 + 'T10:00:00');
  record(session1, route, 'fail', '抓到后向右摆', day1 + 'T10:20:00');

  const session2 = startAt(today, '粉袋岩馆');
  store.linkRouteToSession(session2.id, route.id);
  const send = record(session2, route, 'send', '第三条备注', today + 'T20:00:00');
  const sendCreatedAt = send.createdAt;

  const detail = openRoutePage(route.id);
  assert.equal(detail.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(detail.data.sendCount, 1);
  assert.equal(detail.data.correctionRows.length, 1);
  assert.equal(detail.data.correctionRows[0].attemptId, send.id);

  detail.correctSend(
    tapDataset({ attemptId: send.id, routeId: route.id, sessionId: session2.id })
  );
  assert.equal(detail.data.storageError, '');
  assert.equal(detail.data.correctionRows[0].state, 'corrected');
  assert.equal(detail.data.summaryText, '2 天 · 2 场 · 3 把', '更正不改变把数');

  // 重开（新实例，重新只读档案）
  const reopened = openRoutePage(route.id);
  assert.equal(reopened.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(reopened.data.attemptCount, 3);
  assert.equal(reopened.data.sendCount, 0);
  assert.equal(reopened.data.routeCompleted, false);
  assert.equal(reopened.data.canRecordAgain, true, '改成未完成后可以再记一次完攀');

  const corrected = attemptsOf(route.id).find(item => item.id === send.id);
  assert.equal(corrected.result, 'fail');
  assert.equal(corrected.sessionId, session2.id, '原场次不变');
  assert.equal(corrected.createdAt, sendCreatedAt, '原时间不变');
  assert.equal(corrected.note, '第三条备注', '原备注不变');
  assert.equal(reopened.data.groups[0].dateText, today);
  assert.deepEqual(
    reopened.data.groups[1].attempts.map(item => item.note),
    ['', '抓到后向右摆']
  );

  // 再记一次完攀：复用当日已有场次，不新建；四把一完攀。
  reopened.recordAgain();
  assert.equal(reopened.data.storageError, '');
  const recordPage = openRecordFor(session2.id, route.id);
  assert.equal(recordPage.data.activeSession.id, session2.id, '当日已有场次直接复用');
  recordPage.recordAttempt(tapResult('send'));

  const after = archiveOf();
  assert.equal(after.sessions.length, 2, '再记不再新建场次');
  assert.equal(attemptsOf(route.id).length, 4);
  assert.equal(attemptsOf(route.id).filter(item => item.result === 'send').length, 1);

  const finalView = openRoutePage(route.id);
  assert.equal(finalView.data.summaryText, '2 天 · 2 场 · 4 把');
  assert.equal(finalView.data.sendCount, 1);
});

test('R3 同一坐标双击只改指定把；多条历史完攀时更正另一把须点其对应记录', () => {
  const day1 = '2020-04-01';
  const day2 = '2020-04-02';
  const send1 = 'attempt-send-1';
  const send2 = 'attempt-send-2';
  writeArchiveFixture({
    gymName: '夹具岩馆',
    sessions: [
      { id: 'session-1', seq: 1, gymId: 'gym-1', date: day1, createdAt: day1 + 'T10:00:00.000Z' },
      { id: 'session-2', seq: 2, gymId: 'gym-1', date: day2, createdAt: day2 + 'T10:00:00.000Z' }
    ],
    routes: [
      {
        id: 'route-1',
        seq: 1,
        gymId: 'gym-1',
        name: '夹具抱石线',
        climbType: '抱石',
        grade: 'V4',
        colorName: '蓝色',
        colorHex: '#2f6fe4',
        createdAt: day1 + 'T10:00:00.000Z'
      }
    ],
    attempts: [
      {
        id: send1,
        seq: 1,
        sessionId: 'session-1',
        routeId: 'route-1',
        result: 'send',
        note: '第一把历史完攀',
        createdAt: day1 + 'T10:05:00.000Z'
      },
      {
        id: send2,
        seq: 2,
        sessionId: 'session-2',
        routeId: 'route-1',
        result: 'send',
        note: '第二把历史完攀',
        createdAt: day2 + 'T10:05:00.000Z'
      }
    ]
  });

  const page = openRoutePage('route-1');
  assert.equal(page.data.summaryText, '2 天 · 2 场 · 2 把');
  assert.equal(page.data.sendCount, 2);
  assert.deepEqual(
    page.data.correctionRows.map(row => row.attemptId),
    [send2, send1],
    '最近的完攀在前，两把各占一行'
  );

  // 同一坐标双击：第二次幂等，只会重复更正这一把，不会改到另一把。
  const row = tapDataset({ attemptId: send2, routeId: 'route-1', sessionId: 'session-2' });
  page.correctSend(row);
  page.correctSend(row);
  assert.equal(page.data.correctionRows[0].state, 'corrected');
  assert.equal(page.data.correctionRows[1].state, 'ready', '另一把仍是可更正状态');

  const afterFirst = attemptsOf('route-1');
  assert.equal(afterFirst.find(item => item.id === send2).result, 'fail');
  assert.equal(afterFirst.find(item => item.id === send1).result, 'send', '另一把未被改动');

  // 更正另一把必须点它自己那一行。
  const reopened = openRoutePage('route-1');
  assert.equal(reopened.data.correctionRows.length, 1, '只剩第一把待更正');
  assert.equal(reopened.data.correctionRows[0].attemptId, send1);
  reopened.correctSend(
    tapDataset({ attemptId: send1, routeId: 'route-1', sessionId: 'session-1' })
  );

  const afterSecond = attemptsOf('route-1');
  assert.equal(afterSecond.filter(item => item.result === 'send').length, 0);
  assert.equal(afterSecond.length, 2, '更正不改把数');
  assert.equal(afterSecond.find(item => item.id === send1).note, '第一把历史完攀');
  assert.equal(
    afterSecond.find(item => item.id === send1).createdAt,
    day1 + 'T10:05:00.000Z',
    '原时间保留'
  );
});

test('R3 同日两场保留原归属：当天再记先显式选场，取消或另选都不改已有把次的归属', () => {
  const today = store.todayLocalDate();

  const sessionA = startAt(today, '同一岩馆');
  const route = newRoute(sessionA, { name: '蓝色动态线' });
  record(sessionA, route, 'fail', '', today + 'T10:00:00');

  const sessionB = startAt(today, '同一岩馆');
  assert.notEqual(sessionB.id, sessionA.id);
  store.linkRouteToSession(sessionB.id, route.id);
  record(sessionB, route, 'fail', '第二场备注', today + 'T11:00:00');

  const page = openRoutePage(route.id);
  assert.equal(page.data.summaryText, '1 天 · 2 场 · 2 把');
  assert.deepEqual(
    page.data.groups.map(group => group.sessionLabel),
    ['第 2 场', '第 1 场']
  );

  const rawBefore = rawArchive();
  page.recordAgain();
  assert.equal(page.data.sessionPicker.sessions.length, 2, '同日两场先让用户明确选一场');
  assert.equal(rawArchive(), rawBefore, '选场前不写盘、不改当前归属');

  // 取消：不改归属，留在详情
  page.cancelSessionPicker();
  assert.equal(page.data.sessionPicker, null);
  assert.equal(rawArchive(), rawBefore);
  assert.equal(wxLog.navigations.length, 0);

  // 显式选中第一场：只改当前场次与线路
  page.recordAgain();
  page.chooseSessionForAgain(tapDataset({ sessionId: sessionA.id }));
  assert.equal(page.data.storageError, '');
  assert.match(wxLog.navigations.at(-1).url, /^\/pages\/training-record\/training-record\?/);

  const after = archiveOf();
  assert.equal(after.sessions.length, 2, '选场不新增场次');
  assert.equal(after.activeSessionId, sessionA.id);
  assert.equal(after.activeRouteId, route.id);
  const rows = attemptsOf(route.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(item => item.sessionId), [sessionA.id, sessionB.id], '原归属不变');
  assert.equal(rows[1].note, '第二场备注');
});

test('R3 当天再记落盘失败：不新建场次、不离开本页，重试后成功', () => {
  const day1 = '2020-04-02';
  const session1 = startAt(day1, '粉袋岩馆');
  const route = newRoute(session1, { name: '蓝色动态线' });
  record(session1, route, 'fail', '', day1 + 'T10:00:00');

  const page = openRoutePage(route.id);
  assert.equal(page.data.summaryText, '1 天 · 1 场 · 1 把');

  armSetFailAt(1);
  page.recordAgain();

  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.equal(archiveOf().sessions.length, 1, '保存失败时不新建场次');
  assert.equal(wxLog.navigations.length, 0, '保存失败时不离开本页');
  assert.equal(page.data.canRecordAgain, true);

  armSetFailAt(0);
  page.dismissStorageError();
  assert.equal(page.data.storageError, '');
  page.recordAgain();
  assert.equal(page.data.storageError, '');
  assert.equal(archiveOf().sessions.length, 2);
  assert.match(wxLog.navigations.at(-1).url, /^\/pages\/training-record\/training-record\?/);
});

test('R3 找不到线路、档案损坏与缺少 routeId 时状态可区分，且不改写原数据', () => {
  const day1 = '2020-04-02';
  const session1 = startAt(day1, '粉袋岩馆');
  const route = newRoute(session1, { name: '蓝色动态线' });

  const missing = openRoutePage('route-does-not-exist');
  assert.equal(missing.data.notFound, true);
  assert.equal(missing.data.route, null);
  assert.equal(missing.data.canRecordAgain, false);

  const noId = openRoutePage('');
  assert.equal(noId.data.notFound, true);

  const noIdAgain = openRoutePage('');
  assert.equal(noIdAgain.data.notFound, true);

  // 缺少把次归属的路由参数不影响已存在的线路
  assert.equal(openRoutePage(route.id).data.notFound, false);

  const corruptRaw = '{ 这不是合法 JSON';
  storage.set(ARCHIVE_KEY, corruptRaw);
  const broken = openRoutePage(route.id);
  assert.equal(broken.data.loadError, store.ARCHIVE_BROKEN);
  assert.equal(broken.data.groups.length, 0);
  assert.equal(storage.get(ARCHIVE_KEY), corruptRaw, '损坏档案保持原样');

  // 页面上唯一的写入口在损坏时也不落盘、不覆盖
  broken.recordAgain();
  assert.equal(storage.get(ARCHIVE_KEY), corruptRaw);
  assert.equal(wxLog.navigations.length, 0);
});

// ------------------------------------------------------------------ *
// 记录 tab：本机训练历史入口与旧记录入口分开
// ------------------------------------------------------------------ *

test('R6 记录 tab 列出本机训练历史并按 routeId 进详情；同字 ID 的旧汇总走原 ID 路由', async () => {
  const today = store.todayLocalDate();
  const session = startAt(today, '粉袋岩馆');
  const route = newRoute(session, { name: '蓝色动态线' });
  assert.equal(route.id, 'route-1', '长期线路 ID 由档案层生成');
  record(session, route, 'fail', '', today + 'T20:00:00');

  // 旧云汇总恰与本机线路 ID 同字
  useCloudRecords(() => Promise.resolve({
    data: [
      {
        _id: 'route-1',
        date: '2020-03-01',
        location: '旧岩馆',
        climbType: '抱石',
        grade: 'V4',
        status: '完成',
        attempts: 5,
        notes: '旧备注',
        images: ['cloud://old-1.jpg']
      }
    ]
  }));

  const rawBefore = rawArchive();
  const page = openListPage();
  await page.onShow();

  assert.equal(page.data.archiveError, '');
  assert.equal(page.data.hasLocalHistory, true);
  assert.equal(page.data.localRoutes.length, 1);
  assert.equal(page.data.localRoutes[0].id, 'route-1');
  assert.equal(page.data.localRoutes[0].name, '蓝色动态线');
  assert.equal(page.data.localRoutes[0].gymName, '粉袋岩馆');
  assert.equal(page.data.localRoutes[0].countText, '1 天 · 1 场 · 1 把');
  assert.equal(page.data.localRoutes[0].lastDateText, today + ' 第 1 场');

  assert.equal(page.data.records.length, 1, '旧记录仍按原 _id 显示');
  assert.equal(page.data.cloudKind, 'ok');

  // 两条入口的路由参数不同：本机线路走 routeId，旧记录走原 _id。
  page.goToRouteDetail(tapDataset({ routeId: 'route-1' }));
  assert.equal(wxLog.navigations.at(-1).url, '/pages/training-route/training-route?routeId=route-1');
  page.goToDetail(tapDataset({ id: 'route-1' }));
  assert.equal(wxLog.navigations.at(-1).url, '/pages/record-detail/record-detail?id=route-1');

  assert.equal(rawArchive(), rawBefore, '浏览记录 tab 不改写本机档案');
});

test('R6 旧云四种状态可区分：有数据 / 空库 / 拒绝访问 / 云不可用 / 读取失败', async () => {
  const today = store.todayLocalDate();
  const session = startAt(today, '粉袋岩馆');
  const route = newRoute(session, { name: '蓝色动态线' });
  record(session, route, 'fail', '', today + 'T20:00:00');

  // 有数据
  useCloudRecords(() => Promise.resolve({
    data: [{ _id: 'old-1', date: '2020-03-01', status: '完成', attempts: 5, images: [] }]
  }));
  const withData = openListPage();
  await withData.onShow();
  assert.equal(withData.data.cloudKind, 'ok');
  assert.equal(withData.data.records.length, 1);
  assert.equal(withData.data.loadError, false);

  // 空库
  useCloudRecords(() => Promise.resolve({ data: [] }));
  const empty = openListPage();
  await empty.onShow();
  assert.equal(empty.data.cloudKind, 'empty');
  assert.equal(empty.data.isEmpty, true);
  assert.equal(empty.data.loadError, false);
  assert.equal(empty.data.localRoutes.length, 1, '空库不影响本机历史');

  // 拒绝访问
  useCloudRecords(() => Promise.reject(Object.assign(new Error('database permission denied'), { errCode: -502003 })));
  const denied = openListPage();
  await denied.onShow();
  assert.equal(denied.data.cloudKind, 'denied');
  assert.equal(denied.data.cloudErrorTitle, '没有访问旧记录的权限');
  assert.match(denied.data.cloudErrorHint, /本机训练历史/);
  assert.equal(denied.data.localRoutes.length, 1);

  // 云环境不可用
  useCloudRecords(() => Promise.reject(db.cloudUnavailable()));
  const unavailable = openListPage();
  await unavailable.onShow();
  assert.equal(unavailable.data.cloudKind, 'unavailable');
  assert.equal(unavailable.data.cloudErrorTitle, '云环境不可用');
  assert.equal(unavailable.data.loadError, true);
  assert.equal(unavailable.data.localRoutes.length, 1);

  // 一般读取失败
  useCloudRecords(() => Promise.reject(new Error('offline')));
  const failed = openListPage();
  await failed.onShow();
  assert.equal(failed.data.cloudKind, 'failed');
  assert.equal(failed.data.cloudErrorTitle, '读取旧记录失败');

  // 五种状态互不相同
  const kinds = [
    withData.data.cloudKind,
    empty.data.cloudKind,
    denied.data.cloudKind,
    unavailable.data.cloudKind,
    failed.data.cloudKind
  ];
  assert.equal(new Set(kinds).size, 5, '有数据、空库、拒绝访问、云不可用与读取失败必须可区分');

  // WXML 空库文案与本机历史文案分开
  const listWxml = fs.readFileSync(LIST_WXML, 'utf8');
  assert.match(listWxml, /还没有旧记录/);
  assert.match(listWxml, /还没有本机训练记录/);
});

test('R6 旧库读失败不触发回写、清空或覆盖本机档案；本机档案损坏时旧记录区照常可用', async () => {
  const today = store.todayLocalDate();
  const session = startAt(today, '粉袋岩馆');
  const route = newRoute(session, { name: '蓝色动态线' });
  record(session, route, 'fail', '本机备注', today + 'T20:00:00');

  const rawBefore = rawArchive();
  useCloudRecords(() => Promise.reject(db.cloudUnavailable()));
  const page = openListPage();
  await page.onShow();
  assert.equal(page.data.loadError, true);
  assert.equal(rawArchive(), rawBefore, '旧库读失败不得回写或清空本机档案');

  await page.retryRefresh();
  assert.equal(rawArchive(), rawBefore);
  assert.equal(page.data.localRoutes.length, 1, '旧库失败时本机历史照常可用');
  assert.equal(page.data.localRoutes[0].countText, '1 天 · 1 场 · 1 把');

  // 本机档案损坏：本机历史区显示可见错误，旧记录区照常按原 _id 读取。
  const corruptRaw = '{ 坏 JSON';
  storage.set(ARCHIVE_KEY, corruptRaw);
  useCloudRecords(() => Promise.resolve({
    data: [{ _id: 'old-2', date: '2020-03-01', status: '完成', attempts: 5, images: [] }]
  }));
  const broken = openListPage();
  await broken.onShow();
  assert.equal(broken.data.archiveError, store.ARCHIVE_BROKEN);
  assert.equal(broken.data.localRoutes.length, 0);
  assert.equal(broken.data.records.length, 1, '本机档案损坏不影响旧记录区');
  assert.equal(storage.get(ARCHIVE_KEY), corruptRaw, '损坏档案保持原样');
});

// ------------------------------------------------------------------ *
// R6 旧记录只读回看
// ------------------------------------------------------------------ *

test('R6 旧详情按原 _id 读原字段与图片：「尝试 5 次、完成」只显示一条汇总，不拆五把、不删除', async () => {
  const legacy = {
    _id: 'legacy-5',
    date: '2020-03-01',
    location: '旧岩馆',
    climbType: '抱石',
    grade: 'V4',
    status: '完成',
    attempts: 5,
    notes: '脚点很滑，最后一步换手',
    images: ['cloud://old-1.jpg', 'cloud://old-2.jpg']
  };
  const requested = [];
  useCloudRecord(id => {
    requested.push(id);
    return Promise.resolve({ data: legacy });
  });

  const rawBefore = rawArchive();
  const page = await openDetailPage('legacy-5');

  assert.deepEqual(requested, ['legacy-5'], '按原 _id 读取');
  assert.equal(page.data.state, 'ready');
  assert.equal(page.data.view.recordId, 'legacy-5');
  assert.equal(page.data.view.date, '2020-03-01');
  assert.equal(page.data.view.location, '旧岩馆');
  assert.equal(page.data.view.climbType, '抱石');
  assert.equal(page.data.view.grade, 'V4');
  assert.equal(page.data.view.status, '完成');
  assert.equal(page.data.view.attempts, 5);
  assert.equal(page.data.view.attemptsText, '5 次');
  assert.equal(page.data.view.summaryText, 'V4 · 尝试 5 次 · 完成');
  assert.equal(page.data.view.notes, '脚点很滑，最后一步换手');
  assert.deepEqual(page.data.view.images, ['cloud://old-1.jpg', 'cloud://old-2.jpg']);
  assert.match(page.data.view.readOnlyHint, /不拆分逐次尝试/);
  assert.match(page.data.view.readOnlyHint, /不计入本机训练统计/);
  assert.equal(page.data.view.hasEmbeddedRoutes, false);

  // 只读：没有删除/上传调用，也不写本机档案。
  assert.equal(deleteCalls, 0, '浏览旧记录不得删除或改动云文件');
  assert.equal(rawArchive(), rawBefore, '浏览旧记录不得改写本机档案');

  // 图片只预览原引用，不改引用。
  page.previewImage({ currentTarget: { dataset: { url: 'cloud://old-1.jpg' } } });
  assert.equal(wxLog.previews.length, 1);
  assert.deepEqual(wxLog.previews[0].urls, ['cloud://old-1.jpg', 'cloud://old-2.jpg']);

  // 旧汇总不计入本机逐把数：本机历史列表不因它而出现。
  useCloudRecords(() => Promise.resolve({ data: [legacy] }));
  const list = openListPage();
  await list.onShow();
  assert.equal(list.data.records.length, 1);
  assert.equal(list.data.localRoutes.length, 0, '旧汇总不计入本机训练历史');
  assert.equal(list.data.hasLocalHistory, false);
});

test('R6 已知 climbing_sessions.routes[] 旧形状：夹具下兼容读取，保留原汇总与原有明细', async () => {
  const legacyWithDetail = {
    _id: 'legacy-detail',
    date: '2020-03-02',
    location: '旧岩馆',
    climbType: '顶绳',
    grade: '5.10a',
    status: '完成',
    attempts: 3,
    notes: '',
    images: [],
    // 已知旧形状：文档自带 routes[] 明细结构，来源未经核实，只按原结构只读保留。
    routes: [
      { routeName: '旧线一', attempts: [{ result: 'fail' }, { result: 'send' }] },
      { routeName: '旧线二', attempts: [{ result: 'fail' }] }
    ]
  };
  useCloudRecord(() => Promise.resolve({ data: legacyWithDetail }));

  const page = await openDetailPage('legacy-detail');
  assert.equal(page.data.state, 'ready');
  assert.equal(page.data.view.summaryText, '5.10a · 尝试 3 次 · 完成');
  assert.equal(page.data.view.hasEmbeddedRoutes, true);
  assert.equal(page.data.view.embeddedRouteCount, 2);
  assert.match(page.data.view.readOnlyHint, /按原结构只读保留/);
  assert.match(page.data.view.readOnlyHint, /不拆成逐把/);
  // 明细只报数量，不生成逐把数组
  assert.equal(page.data.view.attempts, 3, '原次数原样保留');

  // 纯函数层的兼容读取与不伪造：缺字段就是缺，不补 0、不猜次数
  const emptyAttempts = db.legacyRecordView({ _id: 'x', date: '2020-01-01', status: '完成' });
  assert.equal(emptyAttempts.attempts, null);
  assert.equal(emptyAttempts.attemptsText, '');
  assert.equal(emptyAttempts.summaryText, '完成');
  assert.equal(db.legacyRecordView(null).present, false);
  assert.equal(db.legacyRecordView([]).present, false);
  assert.deepEqual(db.legacyRecordView({ _id: 'y', attempts: 5, images: null }).images, []);
});

test('R6 旧详情读取失败按类别显示可区分状态：不存在 / 拒绝访问 / 云不可用 / 读取失败', async () => {
  useCloudRecord(() => Promise.resolve({ data: {} }));
  const empty = await openDetailPage('legacy-empty');
  assert.equal(empty.data.state, 'empty');

  useCloudRecord(() => Promise.reject(Object.assign(new Error('not exist'), { errCode: -502004 })));
  const gone = await openDetailPage('legacy-gone');
  assert.equal(gone.data.state, 'empty');
  assert.equal(gone.data.errorTitle, '这条旧记录不存在');

  useCloudRecord(() => Promise.reject(Object.assign(new Error('permission denied'), { errCode: -502003 })));
  const denied = await openDetailPage('legacy-denied');
  assert.equal(denied.data.state, 'denied');
  assert.equal(denied.data.errorTitle, '没有访问旧记录的权限');

  useCloudRecord(() => Promise.reject(db.cloudUnavailable()));
  const unavailable = await openDetailPage('legacy-unavailable');
  assert.equal(unavailable.data.state, 'unavailable');
  assert.equal(unavailable.data.errorTitle, '云环境不可用');

  useCloudRecord(() => Promise.reject(new Error('offline')));
  const failed = await openDetailPage('legacy-failed');
  assert.equal(failed.data.state, 'failed');
  assert.equal(failed.data.errorTitle, '读取旧记录失败');

  const noIdPage = await openDetailPage('');
  assert.equal(noIdPage.data.state, 'missing');

  // 分类是纯函数，四种类别与未知错误都不猜
  assert.equal(db.classifyCloudError(db.cloudUnavailable()), 'unavailable');
  assert.equal(db.classifyCloudError({ errCode: -502003 }), 'denied');
  assert.equal(db.classifyCloudError({ errMsg: 'permission denied' }), 'denied');
  assert.equal(db.classifyCloudError({ errCode: -502004 }), 'not-found');
  assert.equal(db.classifyCloudError(new Error('offline')), 'failed');
  assert.equal(db.classifyCloudError({ errCode: -505555 }), 'failed', '未知错误码不猜类别');
  assert.deepEqual(db.CLOUD_KINDS, ['unavailable', 'denied', 'not-found', 'failed']);

  // 重试入口：失败后仍可按原 _id 重试，成功后显示记录
  let attempt = 0;
  useCloudRecord(id => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error('offline'));
    return Promise.resolve({ data: { _id: id, date: '2020-03-03', status: '完成', attempts: 1, images: [] } });
  });
  const retryPage = await openDetailPage('legacy-retry');
  assert.equal(retryPage.data.state, 'failed');
  retryPage.retryLoad();
  await flush();
  assert.equal(retryPage.data.state, 'ready');
  assert.equal(retryPage.data.view.recordId, 'legacy-retry');
});

// ------------------------------------------------------------------ *
// 断网可用性
// ------------------------------------------------------------------ *

test('R5 完全没有 wx.cloud 时：本机历史、线路详情与当天再记都可用', async () => {
  assert.equal(typeof global.wx.cloud, 'undefined', '本文件刻意不提供云能力');

  const day1 = '2020-04-02';
  const session = startAt(day1, '断网岩馆');
  const route = newRoute(session, { name: '蓝色动态线' });
  record(session, route, 'fail', '断网也能回看', day1 + 'T10:00:00');

  const list = openListPage();
  await list.onShow();
  assert.equal(list.data.cloudKind, 'unavailable');
  assert.equal(list.data.localRoutes.length, 1, '断网时本机历史照常可用');
  assert.equal(list.data.localRoutes[0].name, '蓝色动态线');

  const detail = openRoutePage(route.id);
  assert.equal(detail.data.loadError, '');
  assert.equal(detail.data.summaryText, '1 天 · 1 场 · 1 把');
  assert.equal(detail.data.groups[0].attempts[0].note, '断网也能回看');

  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  assert.equal(archiveOf().sessions.length, 2, '断网也能当天再记');
});

// ------------------------------------------------------------------ *
// T037 返工：同日选场的旧事件不能改另一份档案的活动场次
// ------------------------------------------------------------------ *

test('T037 返工 原 A 档的旧选场事件不能改 B 档 activeSession', () => {
  const today = store.todayLocalDate();
  const sessionA = startAt(today, '同馆岩馆');
  const route = newRoute(sessionA, { name: '同日选场线' });
  record(sessionA, route, 'fail', '', today + 'T10:00:00');
  const sessionB = startAt(today, '同馆岩馆');
  assert.notEqual(sessionB.id, sessionA.id);
  store.linkRouteToSession(sessionB.id, route.id);
  record(sessionB, route, 'fail', '第二场备注', today + 'T11:00:00');

  const page = openRoutePage(route.id);
  page.recordAgain();
  const picker = page.data.sessionPicker;
  assert.ok(picker, '同日两场先让用户明确选一场');
  assert.ok(picker.archiveId, '选场面板记下原档案 ID');
  assert.ok(picker.pickerKey, '选场面板有本次打开标识');

  // 真实按钮 dataset：原档案、原线路、原面板标识与目标场次一起带回。
  const wxml = fs.readFileSync(ROUTE_WXML, 'utf8');
  assert.match(
    wxml,
    /data-archive-id="\{\{sessionPicker\.archiveId\}\}"[\s\S]{0,200}data-route-id="\{\{sessionPicker\.routeId\}\}"[\s\S]{0,200}data-picker-key="\{\{sessionPicker\.pickerKey\}\}"[\s\S]{0,160}data-session-id="\{\{item\.id\}\}"[\s\S]{0,100}bindtap="chooseSessionForAgain"/
  );
  const captured = {
    archiveId: picker.archiveId,
    routeId: picker.routeId,
    pickerKey: picker.pickerKey,
    sessionId: sessionA.id
  };

  // 换成另一份本机档案：复用同一组场次 / 线路 / 面板 ID，只改档案 ID 与活动场次。
  const twin = JSON.parse(rawArchive());
  twin.archiveId = 'archive-of-another-profile';
  twin.activeSessionId = sessionB.id;
  twin.activeRouteId = route.id;
  const twinBytes = JSON.stringify(twin);
  storage.set(ARCHIVE_KEY, twinBytes);

  page.chooseSessionForAgain(tapDataset(captured));

  assert.equal(storage.get(ARCHIVE_KEY), twinBytes, '旧选场事件不写 B 档');
  const after = archiveOf();
  assert.equal(after.activeSessionId, sessionB.id, 'B 档活动场次不变');
  assert.equal(after.activeRouteId, route.id);
  assert.equal(after.sessions.length, 2, '不新增场次');
  assert.match(page.data.notice, /原来的本机档案|原来的页面/);
});
