/**
 * T017 正式首页开始/继续场次与场内逐把记录回归测试（R1、R2、R3、R4、R5 的离线部分）
 *
 * 直接加载真实页面文件（pages/index/index.js、pages/training-session/training-session.js），
 * 捕获 Page(...) 定义，用隔离的微信本地存储替身与写入故障注驱动真实页面处理器，
 * 并核对 WXML 里的真实按钮绑定与导航目标。刻意不提供 wx.cloud：
 * 新增训练路径不得有云调用，旧云读取失败也不得遮住训练入口。
 *
 * 真机触控、岩馆实际使用与退出重开留给 T019 集成后的整体验收（待验）。
 *
 * 运行：node --test tests/training-session.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'app.json');
const INDEX_JS = path.join(ROOT, 'pages', 'index', 'index.js');
const INDEX_WXML = path.join(ROOT, 'pages', 'index', 'index.wxml');
const SESSION_JS = path.join(ROOT, 'pages', 'training-session', 'training-session.js');
const SESSION_WXML = path.join(ROOT, 'pages', 'training-session', 'training-session.wxml');
const SESSION_WXSS = path.join(ROOT, 'pages', 'training-session', 'training-session.wxss');
const RECORD_JS = path.join(ROOT, 'pages', 'training-record', 'training-record.js');
const RECORD_WXML = path.join(ROOT, 'pages', 'training-record', 'training-record.wxml');
const RECORD_WXSS = path.join(ROOT, 'pages', 'training-record', 'training-record.wxss');
const ATTEMPTS_JS = path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.js');
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const SUMMARY_JS = path.join(ROOT, 'utils', 'training-session-summary.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';
const PHOTO_KEY = 'climbingNote.training.v1.photos';
const VIDEO_INDEX_KEY = 'climbingNote.training.v1.attempt-video';

// ---- 微信本地存储替身：只在正式本机命名空间内读写，可按需注入故障 ----
const storage = new Map();
const fault = { setFailAt: 0, setCount: 0, loseResponseAt: 0 };

function resetDevice() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.loseResponseAt = 0;
}

function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

// 落盘已生效但回执丢失（弱网/超时）：页面只看到失败，键里其实已是新数据。
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

// 更正确认弹窗（T042）：默认立刻「确认」；队列里可指定 cancel 来核对取消不写盘。
const modalLog = { calls: [], held: [], queue: [] };

function resetModalLog() {
  modalLog.calls = [];
  modalLog.held = [];
  modalLog.queue = [];
}

function queueModal(behavior) {
  modalLog.queue.push(behavior);
}

// 刻意不带 cloud：T017 的新增训练路径不得依赖云能力。
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
    // 写成功之后才失败：数据已是新的，页面却只拿到失败。
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
  showModal(options) {
    modalLog.calls.push(options);
    const behavior = modalLog.queue.length > 0 ? modalLog.queue.shift() : 'confirm';
    if (behavior === 'hold') {
      modalLog.held.push(options);
      return;
    }
    options.success({ confirm: behavior === 'confirm', cancel: behavior !== 'confirm' });
  },
  stopPullDownRefresh() {}
};

// 可控时钟：快速双击窗口用 Date.now 判别，测试用它把两次点击分开或压在同一时刻。
const realNow = Date.now;
let clock = new Date(2026, 10, 9, 9, 0, 0).getTime();
Date.now = () => clock;
function tick(ms) {
  clock += typeof ms === 'number' ? ms : 1000;
}
process.on('exit', () => {
  Date.now = realNow;
});

const db = require(DB_JS);
const realGetRecentRecords = db.getRecentRecords;
const store = require(STORE_JS);
const { buildSessionSummary } = require(SUMMARY_JS);

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

const indexDefinition = capturePage(INDEX_JS);
const sessionDefinition = capturePage(SESSION_JS);
const recordDefinition = capturePage(RECORD_JS);
const attemptsDefinition = capturePage(ATTEMPTS_JS);

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

/** 单线记录页（T036）：按档案 + 场次 + 长期线路 ID 打开。 */
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

/** 当前场次 + 当前线路的单线记录页（模拟退出重开后从列表点进来）。 */
function openRecordPage() {
  const archive = archiveOf();
  assert.ok(archive.activeRouteId, '应有一条当前线路');
  return openRecordFor(archive.activeRouteId, archive.activeSessionId);
}

/** 从场内列表真实点一条线（openRecord），跟着导航打开它的单线记录页。 */
function openRecordThroughPage(sessionPage, routeId) {
  const before = wxLog.navigations.length;
  sessionPage.openRecord(tapDataset({ routeId }));
  assert.equal(wxLog.navigations.length, before + 1, '整行点击应打开单线记录');
  const url = wxLog.navigations.at(-1).url;
  const query = url.split('?')[1] || '';
  const params = new Map(query.split('&').map(pair => pair.split('=')));
  assert.equal(decodeURIComponent(params.get('routeId') || ''), routeId);
  return openRecordFor(routeId, decodeURIComponent(params.get('sessionId') || ''));
}

/** 按原线路切换单线记录（等价于回列表再点那条线；只改当前选择）。 */
function switchRecordTo(routeId, sessionId) {
  const selected = store.selectRoute(routeId);
  assert.equal(selected.ok, true, selected.error);
  return openRecordFor(routeId, sessionId);
}

/** 逐把明细页（T036）：只列指定场次与线路。 */
function openAttemptsFor(sessionId, routeId) {
  const archive = archiveOf();
  const page = createPage(attemptsDefinition);
  page.onLoad({ archiveId: archive.archiveId, sessionId, routeId });
  assert.equal(page.data.contextError, '', '明细页应能按原归属打开');
  return page;
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tapResult(result) {
  return { currentTarget: { dataset: { result } } };
}

function tapDataset(dataset) {
  return { currentTarget: { dataset } };
}

function archiveOf() {
  return store.loadState().archive;
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)tap="([^"]+)"/g)].map(match => match[1]);
}

// 一次训练的最常用前置：开一场、建一条线路（走正式档案层，不经过页面）。
function seedTraining(options = {}) {
  const started = store.startSession({
    gymName: options.gymName || '我自己去的岩馆',
    date: options.date,
    now: options.now || new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const route = store.createRoute({
    sessionId: started.session.id,
    name: options.routeName || '蓝色动态线',
    climbType: options.climbType || '抱石',
    grade: options.grade || 'V3',
    colorName: options.colorName || '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(route.ok, true, route.error);
  return { session: started.session, route: route.route };
}

beforeEach(() => {
  resetDevice();
  resetWxLog();
  resetModalLog();
  db.getRecentRecords = realGetRecentRecords;
});

// ------------------------------------------------------------------ *
// 页面注册、按钮绑定与禁止项
// ------------------------------------------------------------------ *

test('R1 app.json 首页仍为正式首页，场内记录页已注册且四件套齐全', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(appJson.pages[0], 'pages/index/index', '首页必须仍是正式首页');
  assert.ok(
    appJson.pages.includes('pages/training-session/training-session'),
    '场内记录页必须注册进 app.json'
  );
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'pages', 'training-session', 'training-session' + ext)),
      '缺少场内页文件 training-session' + ext
    );
  }
  // 其他 tab 与旧记录入口保持可达。
  assert.deepEqual(
    appJson.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ]
  );
  for (const page of [
    'pages/add-record/add-record',
    'pages/record-list/record-list',
    'pages/record-detail/record-detail'
  ]) {
    assert.ok(appJson.pages.includes(page), page + ' 应保留在页面清单里');
  }
});

test('R1 WXML 里的每个按钮绑定都有真实处理器，导航目标指向正式页面', () => {
  const indexWxml = fs.readFileSync(INDEX_WXML, 'utf8');
  const sessionWxml = fs.readFileSync(SESSION_WXML, 'utf8');

  const indexHandlers = new Set(handlersIn(indexWxml));
  assert.ok(indexHandlers.has('startTraining'), '首页应有「开始训练」绑定');
  assert.ok(indexHandlers.has('continueTraining'), '首页应有「继续本场」绑定');
  assert.ok(indexHandlers.has('goToAddRecord'), '旧「添加记录」入口必须保留');
  for (const handler of indexHandlers) {
    assert.equal(typeof indexDefinition[handler], 'function', '首页绑定缺少处理器：' + handler);
  }

  const sessionHandlers = new Set(handlersIn(sessionWxml));
  for (const required of [
    'startSession',
    'createRoute',
    'pickGymRoute',
    'openRecord',
    'openSessionSummary'
  ]) {
    assert.ok(sessionHandlers.has(required), '场内页应有绑定：' + required);
  }
  for (const handler of sessionHandlers) {
    assert.equal(typeof sessionDefinition[handler], 'function', '场内页绑定缺少处理器：' + handler);
  }

  // T036/T045/T050 返工：记录、待保存重试、行内备注、撤销与视频都在单线页；现场不再有
  // 更正菜单或「恢复」按钮，绑定与处理器必须真实存在。
  const recordHandlers = new Set(handlersIn(fs.readFileSync(RECORD_WXML, 'utf8')));
  for (const required of [
    'recordAttempt',
    'retryPendingAttempt',
    'undoLatestAttempt',
    'openNoteEditor',
    'saveNote',
    'cancelNote',
    'openAttemptVideo'
  ]) {
    assert.ok(recordHandlers.has(required), '单线页应有绑定：' + required);
    assert.equal(typeof recordDefinition[required], 'function', required + ' 必须有页面方法');
  }
  for (const handler of recordHandlers) {
    assert.equal(typeof recordDefinition[handler], 'function', '单线页绑定缺少处理器：' + handler);
  }
  // T042：correctSend 是单线页的确认入口，确认后仍交给共用动作层的同一份写实现。
  assert.equal(typeof recordDefinition.correctSend, 'function', 'correctSend 入口存在');
  const attemptsWxml = fs.readFileSync(
    path.join(ROOT, 'pages', 'training-attempts', 'training-attempts.wxml'),
    'utf8'
  );
  for (const handler of new Set(handlersIn(attemptsWxml))) {
    assert.equal(typeof attemptsDefinition[handler], 'function', '明细页绑定缺少处理器：' + handler);
  }

  // 导航目标是正式页面，引用的是新注册的场内页。
  const indexSource = fs.readFileSync(INDEX_JS, 'utf8');
  assert.match(indexSource, /\/pages\/training-session\/training-session/);
});

test('R1 正式页不引用 devtools、不展示虚构样例/演练开关/重置试用入口，新增路径没有云调用', () => {
  for (const file of [INDEX_JS, INDEX_WXML, SESSION_JS, SESSION_WXML]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(source, /devtools\//, name + ' 不得引用打包时被排除的 devtools 路径');
    assert.doesNotMatch(source, /gymLogTrial|trial-save-server|trial-profile/, name + ' 不得引用试用工程');
    assert.doesNotMatch(source, /虚构|故障演练|演练开关|重置试用|重置本地试用/, name + ' 不得展示演练或重置试用入口');
    assert.doesNotMatch(source, /wx\.clearStorage\b|clearStorageSync/, name + ' 不得整片清空微信存储');
  }

  const sessionSource = fs.readFileSync(SESSION_JS, 'utf8');
  assert.doesNotMatch(sessionSource, /wx\.cloud/, '场内页不得调用云能力');
  assert.doesNotMatch(sessionSource, /require\(['"][^'"]*utils\/db/, '场内页不得引用旧云读写模块');
  assert.doesNotMatch(sessionSource, /addRecord\s*\(/, '场内页不得向旧添加入口写入');
  assert.match(sessionSource, /utils\/training-store/, '场内页必须走正式本机档案层');

  const indexSource = fs.readFileSync(INDEX_JS, 'utf8');
  assert.doesNotMatch(indexSource, /wx\.cloud/, '首页新增路径不得直接调用云能力');
  assert.doesNotMatch(indexSource, /addRecord\s*\(/, '首页不得向旧添加入口写入');
});

// ------------------------------------------------------------------ *
// R1 开始、继续与同日另开
// ------------------------------------------------------------------ *

test('R1 空档从首页开始训练，填岩馆建场次与线路，返回首页继续同一场次并恢复原线', () => {
  const home = openHome();
  assert.equal(home.data.trainingReady, true, '空档案也算可读');
  assert.equal(home.data.archiveError, '');
  assert.equal(home.data.hasActiveSession, false);

  home.startTraining();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(
    wxLog.navigations[0].url,
    '/pages/training-session/training-session?start=1'
  );

  const page = openSessionPage({ start: '1' });
  assert.equal(page.data.ready, true);
  assert.equal(page.data.sessionFormVisible, true, '开始训练直接展开场次表单');

  // 空档不填岩馆不能建场次，也不会落盘。
  page.startSession();
  assert.equal(page.data.formError, '请填写岩馆名称');
  assert.equal(store.loadState().present, false);

  page.onGymNameInput({ detail: { value: '我自己去的岩馆' } });
  // 表单填写期间切后台再回来：填的内容不丢。
  page.onShow();
  assert.equal(page.data.gymName, '我自己去的岩馆');
  assert.equal(page.data.sessionFormVisible, true);

  page.startSession();
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.sessionFormVisible, false);
  assert.equal(page.data.activeSession.gymName, '我自己去的岩馆');
  assert.equal(page.data.activeSession.label, '第 1 场');

  // 新建线路：抱石 V3。
  page.toggleNewRouteForm();
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  // 填写期间切后台再回来：线路名与类型等级不丢。
  page.onShow();
  assert.equal(page.data.newRouteVisible, true);
  assert.equal(page.data.newRouteName, '蓝色动态线');
  assert.equal(page.data.newRouteGrade, 'V3');
  page.createRoute();
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routes.length, 1);
  assert.equal(page.data.selectedRoute.name, '蓝色动态线');
  assert.equal(page.data.selectedRoute.climbType, '抱石');
  assert.equal(page.data.selectedRoute.grade, 'V3');
  // T036：新建成功直达单线记录；那一页上这条线还没有把次。
  const createdId = archiveOf().routes[0].id;
  const recordPage = openRecordFor(createdId, page.data.activeSession.id);
  assert.equal(recordPage.data.selectedRoute.id, createdId);
  assert.equal(recordPage.data.attempts.length, 0);

  // 返回首页：显示「继续本场」与当前线路。
  const homeAgain = openHome();
  assert.equal(homeAgain.data.hasActiveSession, true);
  assert.equal(homeAgain.data.activeSession.gymName, '我自己去的岩馆');
  assert.equal(homeAgain.data.activeSession.routeName, '蓝色动态线');
  assert.equal(homeAgain.data.activeSession.dateText, store.todayLocalDate());
  homeAgain.continueTraining();
  assert.equal(wxLog.navigations.at(-1).url, '/pages/training-session/training-session');

  // 冷启动：新实例继续本场，恢复同一场次与原线，不新建场次。
  const cold = openSessionPage({});
  assert.equal(cold.data.sessionFormVisible, false);
  assert.equal(cold.data.activeSession.id, page.data.activeSession.id);
  assert.equal(cold.data.selectedRoute.id, page.data.selectedRoute.id);
  assert.equal(cold.data.selectedRoute.name, '蓝色动态线');
  assert.equal(archiveOf().sessions.length, 1);
});

test('R1 同日第二场只能由显式「开始新场次」产生，且可复用原线', () => {
  // 本用例比较的是「同一天」的两场：第一场必须落在真实本地今天，
  // 页面开新场次用的也是本地今天；写死固定日期会在跨天后变成两天。
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate });
  const page = openSessionPage({});
  const firstSessionId = page.data.activeSession.id;
  assert.equal(seeded.session.id, firstSessionId);

  // 只是重新打开页面：不新增场次。
  const reopened = openSessionPage({});
  assert.equal(archiveOf().sessions.length, 1);
  assert.equal(reopened.data.sessionFormVisible, false);

  // 显式开始新场次：日期回到本地今天，同日另开一场（同一岩馆当天第二场）。
  page.openSessionForm();
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(page.data.sessionFormTitle, '开始新场次（同日另开）');
  assert.equal(page.data.sessionDate, store.todayLocalDate());
  page.onGymNameInput({ detail: { value: '岩馆 A' } });
  page.startSession();

  const archive = archiveOf();
  assert.equal(archive.sessions.length, 2);
  const today = store.sessionsOnDate(archive, store.todayLocalDate());
  assert.equal(today.length, 2);
  assert.notEqual(page.data.activeSession.id, firstSessionId);
  assert.equal(page.data.sameDaySessions.length, 2);

  // 同日第二场「选原线」：复用同一线路 ID，并建立本场次的关联。
  assert.equal(page.data.routes.length, 0, '新场次默认不带线路');
  assert.equal(page.data.gymRoutes.length, 1, '本岩馆已有的一条线路出现在「选原线」里');
  const originalRouteId = page.data.gymRoutes[0].id;
  assert.equal(originalRouteId, seeded.route.id);
  page.pickGymRoute(tapDataset({ routeId: originalRouteId }));
  assert.equal(page.data.selectedRoute.id, originalRouteId);
  assert.equal(store.routesForSession(archiveOf(), page.data.activeSession.id).length, 1);

  // 切回第一场：只改归属，不新增场次。
  page.switchSession(tapDataset({ sessionId: firstSessionId }));
  assert.equal(page.data.activeSession.id, firstSessionId);
  assert.equal(archiveOf().sessions.length, 2);
});

// ------------------------------------------------------------------ *
// R4 三类线路与等级
// ------------------------------------------------------------------ *

test('R4 抱石随 V 级、类型切换保留/清空，错误组合不落盘，同色同级各自独立', () => {
  seedTraining({ gymName: '岩馆 A' });
  const page = openSessionPage({});
  page.toggleNewRouteForm();

  // 抱石等级随 V 级选择。
  assert.ok(page.data.newRouteGrades.includes('V3'));
  assert.equal(page.data.newRouteGrades.includes('5.10a'), false);
  assert.equal(page.data.newRouteGrade, 'V3');
  assert.equal(page.data.newRouteGradeText, 'V3');

  // 抱石 V3 切顶绳：V3 不适用，必须重选。
  page.onNewRouteTypeChange({ detail: { value: 1 } });
  assert.equal(page.data.newRouteType, '顶绳');
  assert.ok(page.data.newRouteGrades.includes('5.10a'));
  assert.equal(page.data.newRouteGrade, '');
  assert.equal(page.data.newRouteGradeText, '请选择等级');

  // 未选等级就创建：拒绝，不落盘。
  page.onNewRouteNameInput({ detail: { value: '顶绳线' } });
  page.createRoute();
  assert.match(page.data.newRouteError, /请选择等级/);
  assert.equal(archiveOf().routes.length, 1, '只有前置那条抱石线');

  // 顶绳 5.10a 切先锋：保留同一条 YDS 等级。
  const ydsIndex = page.data.newRouteGrades.indexOf('5.10a');
  page.onNewRouteGradeChange({ detail: { value: ydsIndex } });
  assert.equal(page.data.newRouteGrade, '5.10a');
  page.onNewRouteTypeChange({ detail: { value: 2 } });
  assert.equal(page.data.newRouteType, '先锋');
  assert.equal(page.data.newRouteGrade, '5.10a');
  assert.equal(page.data.newRouteGradeText, '5.10a');

  // 切回抱石：失效的 5.10a 清空。
  page.onNewRouteTypeChange({ detail: { value: 0 } });
  assert.equal(page.data.newRouteGrade, '');
  assert.equal(page.data.newRouteGradeText, '请选择等级');

  // 越界索引不静默取首个等级。
  page.onNewRouteGradeChange({ detail: { value: 999 } });
  assert.equal(page.data.newRouteGrade, '');
  assert.equal(page.data.newRouteGradeText, '请选择等级');

  // 同色同级的另一条线各自保存，互不带把次。
  page.onNewRouteGradeChange({ detail: { value: page.data.newRouteGrades.indexOf('V3') } });
  page.onNewRouteNameInput({ detail: { value: '蓝色平衡线' } });
  // 颜色要展开后才生效（T030）：这里显式选第一个颜色。
  assert.equal(page.data.newRouteColorVisible, false, '颜色默认收起');
  page.toggleNewRouteColor();
  assert.equal(page.data.newRouteColorVisible, true);
  page.onNewRouteColorChange({ detail: { value: 0 } });
  assert.equal(page.data.newRouteColorName, '蓝色');
  page.createRoute();
  assert.equal(page.data.storageError, '');
  assert.equal(archiveOf().routes.length, 2);
  const routes = archiveOf().routes;
  assert.equal(routes[1].grade, 'V3');
  assert.equal(routes[1].colorName, '蓝色');
  assert.notEqual(routes[0].id, routes[1].id);
  assert.deepEqual(
    store.attemptsFor(archiveOf(), { routeId: routes[1].id }).map(item => item.id),
    []
  );
  assert.equal(page.data.selectedRoute.id, routes[1].id);

  // 错误组合即使被伪造也进不了档案（类型与等级不匹配）。
  const forged = store.createRoute({
    sessionId: page.data.activeSession.id,
    name: '错配线',
    climbType: '顶绳',
    grade: 'V3'
  });
  assert.equal(forged.ok, false);
  assert.equal(archiveOf().routes.length, 2);
});

test('R4 顶绳与先锋完攀后仍可继续记', () => {
  const seeded = seedTraining({ climbType: '顶绳', grade: '5.10a', routeName: '顶绳线' });
  const page = openSessionPage({});
  assert.equal(page.data.selectedRoute.climbType, '顶绳');

  const recordPage = openRecordPage();
  tick();
  recordPage.recordAttempt(tapResult('send'));
  assert.equal(recordPage.data.routeCompleted, false, '绳攀不进入抱石完攀关闭状态');
  assert.equal(recordPage.data.routeRepeatable, true);
  tick();
  recordPage.recordAttempt(tapResult('send'));
  assert.equal(recordPage.data.attempts.length, 2);
  assert.equal(store.routeCompletion(archiveOf(), seeded.route.id).sendCount, 2);

  // 换先锋线路同样可以重复完攀。
  const pioneer = store.createRoute({
    sessionId: seeded.session.id,
    name: '先锋线',
    climbType: '先锋',
    grade: '5.10a'
  });
  assert.equal(pioneer.ok, true, pioneer.error);
  const page2 = openRecordFor(pioneer.route.id, seeded.session.id);
  assert.equal(page2.data.selectedRoute.grade, '5.10a');
  tick();
  page2.recordAttempt(tapResult('send'));
  tick();
  page2.recordAttempt(tapResult('fail'));
  assert.equal(page2.data.attempts.length, 2);
  assert.equal(page2.data.routeStateText, '');
});

// ------------------------------------------------------------------ *
// T030 首屏加线与补录旧记录
// ------------------------------------------------------------------ *

/** 本场次里这条线路的关联条数（同一线路在本场只能有一条关联）。 */
function linkCount(sessionId, routeId) {
  return (archiveOf().sessionRoutes || []).filter(
    link => link.sessionId === sessionId && link.routeId === routeId
  ).length;
}

test('T030 首屏加线区在结果按钮之前：空场是「添加第一条线路」，有线时是「＋ 加线」', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const routesStart = wxml.indexOf('id="session-routes"');
  const routeList = wxml.indexOf('id="route-list"');
  const addRoute = wxml.indexOf('id="add-route"');
  assert.ok(routesStart !== -1, '场内页应有首屏「本场线路 · 加线」区');
  assert.ok(routeList !== -1, '场内页应有统一线路列表');
  assert.ok(addRoute !== -1 && addRoute < routeList, '加线入口在列表之前，首屏就能找到');
  // T036：结果按钮在单线记录页；场内页整行点入那条线。
  assert.ok(recordWxml.indexOf('class="result-button result-fail"') !== -1);
  assert.match(wxml, /bindtap="openRecord"/);

  // 有线：标题「本场线路」旁的常驻「＋ 加线」。
  assert.match(wxml, /本场线路[\s\S]{0,200}wx:if="\{\{routes\.length > 0\}\}"[\s\S]{0,200}id="add-route"/);
  assert.match(wxml, /id="add-route"[\s\S]{0,200}＋ 加线/);
  // 空场：首屏的「添加第一条线路」。
  assert.match(wxml, /id="add-first-route"[\s\S]{0,200}添加第一条线路/);
  // 加线面板只有两个来源。
  assert.match(wxml, /id="add-route-panel"/);
  assert.match(wxml, /id="add-route-tab-existing"[\s\S]{0,200}本馆已有/);
  assert.match(wxml, /id="add-route-tab-new"[\s\S]{0,200}新建线路/);
  // 本馆已有走原关联路径；新建走原创建表单（名称、类型、等级在首层，颜色可展开）。
  assert.match(wxml, /id="gym-route-\{\{item\.id\}\}"[\s\S]{0,200}bindtap="pickGymRoute"/);
  assert.match(wxml, /id="new-route-name"/);
  assert.match(wxml, /id="new-route-type"/);
  assert.match(wxml, /id="new-route-grade"/);
  assert.match(wxml, /id="toggle-new-route-color"[\s\S]{0,120}bindtap="toggleNewRouteColor"/);
  assert.match(wxml, /wx:if="\{\{newRouteColorVisible\}\}"[\s\S]{0,300}bindchange="onNewRouteColorChange"/);
  assert.match(wxml, /id="create-route"[\s\S]{0,80}bindtap="createRoute"/);
  // 关联成功但选中失败：首屏留可点的重试入口。
  assert.match(wxml, /id="add-route-link-retry"[\s\S]{0,400}bindtap="retryLinkSelection"/);
  assert.match(wxml, /id="cancel-add-route"[\s\S]{0,80}bindtap="cancelAddRoute"/);

  const handlers = new Set(handlersIn(wxml));
  for (const required of [
    'openAddRoute',
    'cancelAddRoute',
    'switchAddRouteMode',
    'retryLinkSelection',
    'toggleNewRouteColor',
    'clearNewRouteColor',
    'pickGymRoute',
    'createRoute',
    'openRecord'
  ]) {
    assert.ok(handlers.has(required), '场内页应绑定：' + required);
    assert.equal(typeof sessionDefinition[required], 'function', required + ' 必须有页面方法');
  }
});

test('T030 空场从首屏加线：取消不新增线路与关联，新建一条抱石即选中并能记结果', () => {
  const started = store.startSession({
    gymName: '岩馆 A',
    now: new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const page = openSessionPage({});
  assert.equal(page.data.routes.length, 0, '空场首屏没有本场线路');
  assert.equal(page.data.addRouteVisible, false);

  // 本馆还没有别的线：打开加线直接进「新建线路」。
  page.openAddRoute();
  assert.equal(page.data.addRouteVisible, true);
  assert.equal(page.data.addRouteMode, 'new');
  assert.equal(page.data.newRouteVisible, true);
  assert.equal(page.data.newRouteColorVisible, false, '颜色默认收起');

  // 取消加线：不写盘，线路、关联与当前选择都与打开前相同。
  const rawBefore = storage.get(ARCHIVE_KEY);
  page.cancelAddRoute();
  assert.equal(page.data.addRouteVisible, false);
  assert.equal(page.data.newRouteVisible, false);
  assert.equal(page.data.routes.length, 0);
  assert.equal(archiveOf().sessionRoutes.length, 0);
  assert.equal(archiveOf().activeRouteId, '');
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '取消加线不得写盘');

  // 再打开，新建一条抱石 V3：颜色收起、没有照片也能保存。
  page.openAddRoute();
  assert.equal(page.data.addRouteMode, 'new');
  page.onNewRouteNameInput({ detail: { value: '蓝色动态线' } });
  assert.equal(page.data.newRouteType, '抱石');
  assert.equal(page.data.newRouteGrade, 'V3');
  assert.equal(page.data.newRouteColorVisible, false);
  page.createRoute();
  assert.equal(page.data.storageError, '');

  const archive = archiveOf();
  assert.equal(archive.routes.length, 1);
  assert.equal(archive.routes[0].climbType, '抱石');
  assert.equal(archive.routes[0].grade, 'V3');
  assert.equal(archive.routes[0].colorName, '', '收起颜色时按「不指定」保存，不替用户填颜色');
  assert.equal(linkCount(started.session.id, archive.routes[0].id), 1);
  // 保存后收起面板并回到记结果处；选中线与可记录目标一致。
  assert.equal(page.data.addRouteVisible, false);
  assert.equal(page.data.selectedRoute.id, archive.routes[0].id);
  assert.equal(archive.activeRouteId, page.data.selectedRoute.id);
  // T036：新建并选中成功直达这条线的单线记录。
  const nav = wxLog.navigations.at(-1);
  assert.match(nav.url, /^\/pages\/training-record\/training-record\?/);
  assert.match(nav.url, new RegExp('routeId=' + archive.routes[0].id));

  const recordPage = openRecordFor(archive.routes[0].id, started.session.id);
  tick();
  recordPage.recordAttempt(tapResult('fail'));
  assert.equal(
    store.attemptsFor(archiveOf(), {
      sessionId: started.session.id,
      routeId: archive.routes[0].id
    }).length,
    1,
    '新建后可直接记这一把'
  );
});

test('T030 从本馆已有加入：复用同一 routeId 与旧备注，本场只关联一次；选中失败留可见重试入口', () => {
  // 早年场次：A 馆有一条线，第一把带备注。
  const first = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 9, 0)
  });
  assert.equal(first.ok, true, first.error);
  const old = store.createRoute({
    sessionId: first.session.id,
    name: '黄色平衡线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '黄色',
    colorHex: '#f0b400'
  });
  assert.equal(old.ok, true, old.error);
  const oldAttempt = store.saveAttempt({
    sessionId: first.session.id,
    routeId: old.route.id,
    result: 'fail',
    note: '起步要贴墙'
  });
  assert.equal(oldAttempt.ok, true, oldAttempt.error);

  // 同一天另开一场：新场次默认不带线路，本馆那条线出现在「本馆已有」里。
  const second = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 10, 0)
  });
  assert.equal(second.ok, true, second.error);
  assert.notEqual(second.session.id, first.session.id);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, second.session.id);
  assert.equal(page.data.routes.length, 0);
  assert.deepEqual(page.data.gymRoutes.map(item => item.id), [old.route.id]);

  // 有本馆旧线时加线默认停在「本馆已有」，不用再点一次。
  page.openAddRoute();
  assert.equal(page.data.addRouteMode, 'existing');
  assert.equal(page.data.newRouteVisible, false);

  page.pickGymRoute(tapDataset({ routeId: old.route.id }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.linkRetry, null);
  const linked = archiveOf();
  assert.equal(linked.routes.length, 1, '加入本馆已有线不新建线路');
  assert.equal(page.data.selectedRoute.id, old.route.id, '选中的就是原来那条线');
  assert.equal(page.data.selectedRoute.name, '黄色平衡线');
  assert.equal(linkCount(second.session.id, old.route.id), 1);
  assert.equal(page.data.addRouteVisible, false, '加入成功后回到记结果处');
  // 旧备注仍按同一个 routeId 读得到（没有复制到本场，也没有被改写）。
  const history = store.attemptsFor(linked, { routeId: old.route.id });
  assert.equal(history.length, 1);
  assert.equal(history[0].note, '起步要贴墙');
  assert.equal(history[0].sessionId, first.session.id);

  // 再点一次同一条线：关联幂等，本场仍然只有一条关联。
  page.pickGymRoute(tapDataset({ routeId: old.route.id }));
  assert.equal(linkCount(second.session.id, old.route.id), 1, '同一线路在本场只关联一次');

  // 第三场：关联成功、选中失败（第一段写成功、第二段写失败）。
  const third = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 11, 0)
  });
  assert.equal(third.ok, true, third.error);
  const failedPage = openSessionPage({});
  assert.equal(failedPage.data.activeSession.id, third.session.id);
  armSetFailAt(2);
  failedPage.pickGymRoute(tapDataset({ routeId: old.route.id }));
  armSetFailAt(0);

  // 界面不给出成功状态：不报「已加入」，也没有选中；关联其实已落盘。
  assert.equal(failedPage.data.storageError, '');
  assert.equal(failedPage.data.notice, '');
  assert.equal(failedPage.data.linkRetry.routeId, old.route.id);
  assert.match(failedPage.data.linkRetry.error, /保存本机训练档案失败/);
  assert.equal(linkCount(third.session.id, old.route.id), 1);
  assert.notEqual(archiveOf().activeRouteId, old.route.id);

  // 重试：按同一个 routeId 再走一次「关联 + 选中」，成功后仍只有一条关联。
  const navBeforeRetry = wxLog.navigations.length;
  failedPage.retryLinkSelection(tapDataset({ routeId: old.route.id }));
  assert.equal(failedPage.data.linkRetry, null);
  assert.equal(linkCount(third.session.id, old.route.id), 1, '重试后仍只有一条关联');
  assert.equal(archiveOf().activeRouteId, old.route.id);
  assert.equal(failedPage.data.selectedRoute.id, old.route.id);
  assert.equal(wxLog.navigations.length, navBeforeRetry + 1, '重试选中成功后直达单线记录');
  assert.match(wxLog.navigations.at(-1).url, /^\/pages\/training-record\/training-record\?/);

  // 重开本页：关联、选中与原线历史都按原 ID 读回。
  const reopened = openSessionPage({});
  assert.equal(reopened.data.selectedRoute.id, old.route.id);
  assert.equal(linkCount(third.session.id, old.route.id), 1);
  assert.equal(store.attemptsFor(archiveOf(), { routeId: old.route.id }).length, 1);
});

test('T030 快速重复点击保存不重复建线，失败后可以立刻原地重试', () => {
  const started = store.startSession({
    gymName: '岩馆 A',
    now: new Date(2026, 10, 9, 8, 30)
  });
  assert.equal(started.ok, true, started.error);
  const page = openSessionPage({});
  page.openAddRoute();
  page.onNewRouteNameInput({ detail: { value: '连点测试线' } });

  // 同一次提交在窗口内被点第二次：只提示，不再建线。
  page.createRoute();
  assert.equal(archiveOf().routes.length, 1);
  page.setData({ newRouteName: '连点测试线' });
  page.createRoute();
  assert.equal(archiveOf().routes.length, 1, '快速重复点击不能建出第二条线');
  assert.match(page.data.notice, /刚提交过这条线路/);

  // 重新打开表单是另一次提交：照常能建第二条。
  page.openAddRoute();
  page.onNewRouteNameInput({ detail: { value: '另一条线' } });
  page.createRoute();
  assert.equal(archiveOf().routes.length, 2);
  assert.equal(archiveOf().activeRouteId, archiveOf().routes[1].id);

  // 落盘失败时不算提交过：同一实例立刻重试只多出预期的一条。
  page.openAddRoute();
  page.onNewRouteNameInput({ detail: { value: '写失败线' } });
  armSetFailAt(1);
  page.createRoute();
  armSetFailAt(0);
  assert.equal(archiveOf().routes.length, 2, '未落盘就不算已建线');
  assert.match(page.data.newRouteError, /保存本机训练档案失败/);
  assert.equal(page.data.newRouteName, '写失败线', '失败保留输入便于重试');
  page.createRoute();
  assert.equal(archiveOf().routes.length, 3);
  assert.equal(archiveOf().routes[2].name, '写失败线');
});

test('T030 切换加线来源保留已输入内容，清除颜色回到「不指定」', () => {
  // 先在本馆留一条已存在的线（上一场），再另开一场：本馆旧线出现在「本馆已有」里。
  const earlier = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 9, 0)
  });
  assert.equal(earlier.ok, true, earlier.error);
  const oldRoute = store.createRoute({
    sessionId: earlier.session.id,
    name: '旧线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(oldRoute.ok, true, oldRoute.error);
  const second = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 10, 0)
  });
  assert.equal(second.ok, true, second.error);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, second.session.id);
  assert.deepEqual(page.data.gymRoutes.map(item => item.id), [oldRoute.route.id]);
  page.openAddRoute();
  assert.equal(page.data.addRouteMode, 'existing');

  // 切到「新建线路」：类型与等级仍是默认组合，名称可填。
  page.switchAddRouteMode(tapDataset({ mode: 'new' }));
  assert.equal(page.data.addRouteMode, 'new');
  assert.equal(page.data.newRouteVisible, true);
  page.onNewRouteNameInput({ detail: { value: '新线' } });
  page.toggleNewRouteColor();
  page.onNewRouteColorChange({ detail: { value: 1 } });
  assert.equal(page.data.newRouteColorName, '绿色');
  assert.equal(page.data.newRouteColorText, '绿色');

  // 切回「本馆已有」再切回来：输入与颜色都留着。
  page.switchAddRouteMode(tapDataset({ mode: 'existing' }));
  assert.equal(page.data.newRouteVisible, false);
  page.switchAddRouteMode(tapDataset({ mode: 'new' }));
  assert.equal(page.data.newRouteName, '新线');
  assert.equal(page.data.newRouteColorName, '绿色');
  assert.equal(page.data.newRouteColorVisible, true);

  // 面板已经开着时再点加线入口：不重置正在填的内容。
  page.openAddRoute();
  assert.equal(page.data.newRouteName, '新线');
  assert.equal(page.data.newRouteColorName, '绿色');
  assert.equal(page.data.addRouteMode, 'new');

  // 清除颜色：回到「不指定」，越界索引也不静默落到首个颜色。
  page.clearNewRouteColor();
  assert.equal(page.data.newRouteColorText, '不指定');
  page.onNewRouteColorChange({ detail: { value: 999 } });
  assert.equal(page.data.newRouteColorName, '');
  assert.equal(page.data.newRouteColorText, '不指定');

  // 收起颜色后仍能创建：保存的是「不指定」。
  page.toggleNewRouteColor();
  assert.equal(page.data.newRouteColorVisible, false);
  assert.equal(page.data.newRouteColorToggleText, '＋ 颜色（可选）');
  page.createRoute();
  const archive = archiveOf();
  assert.equal(archive.routes.length, 2);
  assert.equal(archive.routes[1].name, '新线');
  assert.equal(archive.routes[1].colorName, '');
  assert.equal(archive.routes[1].colorHex, '');
});

test('T030 没有当前场次时首屏加线只提示，不写任何数据', () => {
  const page = openSessionPage({});
  assert.equal(page.data.activeSession, null);
  assert.equal(page.data.sessionFormVisible, true, '空档由场次表单接管首屏');
  const rawBefore = storage.get(ARCHIVE_KEY);
  page.openAddRoute();
  assert.equal(page.data.addRouteVisible, false);
  assert.match(page.data.notice, /请先开始一场训练/);
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore);
});

test('T030 已有线路与当前选择时取消加线：线路、关联与当前选择都与打开前相同', () => {
  const seeded = seedTraining({ gymName: '岩馆 A', routeName: '第一条线' });
  const second = store.createRoute({
    sessionId: seeded.session.id,
    name: '第二条线',
    climbType: '顶绳',
    grade: '5.10a'
  });
  assert.equal(second.ok, true, second.error);

  const page = openSessionPage({});
  assert.equal(page.data.selectedRoute.id, second.route.id);
  const rawBefore = storage.get(ARCHIVE_KEY);
  const routesBefore = archiveOf().routes.length;
  const linksBefore = archiveOf().sessionRoutes.length;

  page.openAddRoute();
  assert.equal(page.data.addRouteVisible, true);
  page.switchAddRouteMode(tapDataset({ mode: 'new' }));
  page.onNewRouteNameInput({ detail: { value: '不该出现的线' } });
  page.cancelAddRoute();

  assert.equal(page.data.addRouteVisible, false);
  assert.equal(page.data.newRouteVisible, false);
  assert.equal(page.data.newRouteName, '', '取消后表单回到默认');
  assert.equal(archiveOf().routes.length, routesBefore, '取消不新增线路');
  assert.equal(archiveOf().sessionRoutes.length, linksBefore, '取消不新增关联');
  assert.equal(page.data.selectedRoute.id, second.route.id, '当前选择不变');
  assert.equal(archiveOf().activeRouteId, second.route.id);
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '取消不写盘');
});

// ------------------------------------------------------------------ *
// T031 结果按钮旁换线
// ------------------------------------------------------------------ *

/** 本场次关联的线路 ID，按本场顺序（与档案里的线路顺序一致）。 */
function sessionRouteIds(sessionId) {
  return store.routesForSession(archiveOf(), sessionId).map(route => route.id);
}

test('T031 统一换线列表在结果按钮之前：整行点线路名走原 selectRoute，多线也全列不折叠', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const listStart = wxml.indexOf('id="route-list"');
  const routesStart = wxml.indexOf('id="session-routes"');
  const failButton = recordWxml.indexOf('class="result-button result-fail"');
  assert.ok(listStart !== -1, '场内页应有统一线路列表');
  assert.ok(failButton !== -1, '单线记录页有结果按钮');
  assert.ok(routesStart < listStart, '加线入口在列表之前');
  // T036/T037：列表整行进入单线记录；结果按钮就在那条线的页面上，不再需要先滚回场内页。
  assert.match(
    wxml,
    /id="route-row-\{\{item\.id\}\}"[\s\S]{0,400}data-route-id="\{\{item\.id\}\}"[\s\S]{0,200}bindtap="openRecord"/
  );
  // 0、1、4 条以上都是同一份列表：没有「短列表 + 全部 N 条」的第二套换线区。
  assert.equal(wxml.match(/id="route-list"/g).length, 1, '场内只有这一份线路列表');
  assert.doesNotMatch(wxml, /id="route-switch"/);
  assert.doesNotMatch(wxml, /routeSwitch/);
  assert.match(wxml, /id="routes-count"[\s\S]{0,80}\{\{routeCountText\}\}/);

  const handlers = new Set(handlersIn(wxml));
  assert.ok(handlers.has('openRecord'), '场内页应绑定 openRecord');
  assert.equal(typeof sessionDefinition.openRecord, 'function', 'openRecord 必须有页面方法');
  assert.equal(typeof sessionDefinition.expandRouteSwitch, 'undefined', '不再有「全部 N 条」展开');
  assert.equal(typeof sessionDefinition.closeRouteSwitch, 'undefined', '不再有「全部 N 条」收起');
});

test('T031 统一列表换线：同色同级 A、B 只换当前线，换线不建线不加关联，记一把与备注只落在 B', () => {
  const a = seedTraining({ gymName: '岩馆 A', routeName: 'A 线', colorName: '蓝色' });
  const b = store.createRoute({
    sessionId: a.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(b.ok, true, b.error);

  // A 先记一把带备注；B 还是空的。
  const aAttempt = store.saveAttempt({
    sessionId: a.session.id,
    routeId: a.route.id,
    result: 'fail',
    note: 'A 的备注',
    now: new Date(2026, 10, 9, 8, 40)
  });
  assert.equal(aAttempt.ok, true, aAttempt.error);

  const page = openSessionPage({});
  assert.equal(page.data.selectedRoute.id, b.route.id, '默认选中最后建的 B');

  // 1–3 条：统一列表直接列出本场全部线路，当前线带已选态。
  assert.deepEqual(page.data.routes.map(row => row.id), [a.route.id, b.route.id]);
  assert.equal(page.data.routes.length, 2);
  assert.equal(page.data.routes[1].isSelected, true);

  // 点 A 的线路名（T036 整行进入单线页）：名称、等级、已选态与把数一起切到 A，
  // 且不产生线路/关联/把次。
  const before = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  const aRecord = openRecordThroughPage(page, a.route.id);
  assert.equal(page.data.selectedRoute.id, a.route.id);
  assert.equal(page.data.selectedRoute.name, 'A 线');
  assert.equal(page.data.selectedRoute.grade, 'V3');
  assert.equal(aRecord.data.routeCountText, '1 把');
  assert.equal(aRecord.data.attempts.length, 1);
  assert.equal(aRecord.data.attempts[0].note, 'A 的备注');
  assert.equal(page.data.routes[0].isSelected, true);
  assert.equal(page.data.routes[1].isSelected, false);
  assert.equal(archiveOf().routes.length, before.routes, '选线不新建线路');
  assert.equal(archiveOf().sessionRoutes.length, before.links, '选线不新增关联');
  assert.equal(archiveOf().attempts.length, before.attempts, '选线不产生把次');

  // 回到 B 记一把并补备注：只改 B，A 的把次与备注不动。
  const bRecord = openRecordThroughPage(page, b.route.id);
  assert.equal(bRecord.data.attempts.length, 0, 'B 还是空的');
  tick();
  bRecord.recordAttempt(tapResult('fail'));
  assert.equal(bRecord.data.attempts.length, 1);
  const bAttemptId = bRecord.data.attempts[0].id;
  const attemptsPage = openAttemptsFor(a.session.id, b.route.id);
  attemptsPage.openNoteEditor(tapDataset({ attemptId: bAttemptId }));
  attemptsPage.onNoteInput({ detail: { value: 'B 的备注' } });
  attemptsPage.saveNote();

  const archive = archiveOf();
  const bAttempts = store.attemptsFor(archive, { sessionId: a.session.id, routeId: b.route.id });
  const aAttempts = store.attemptsFor(archive, { sessionId: a.session.id, routeId: a.route.id });
  assert.equal(bAttempts.length, 1);
  assert.equal(bAttempts[0].note, 'B 的备注');
  assert.equal(aAttempts.length, 1, 'A 仍只有原来那一把');
  assert.equal(aAttempts[0].note, 'A 的备注', 'A 的备注不变');

  // 回到 A：读到的仍是 A 自己的那一把。
  const aAgain = openRecordThroughPage(page, a.route.id);
  assert.equal(aAgain.data.attempts.length, 1);
  assert.equal(aAgain.data.attempts[0].note, 'A 的备注');
});

test('T031 四条以上：统一列表四条全列、按本场关联计数且别的场次不出现，记过把也不重排', () => {
  // 四条线各自带明确的本场关联时间（08:30–08:33），把次时间更晚（见下）。
  const started = store.startSession({
    gymName: '岩馆 A',
    now: new Date(2026, 10, 9, 8, 0)
  });
  assert.equal(started.ok, true, started.error);
  const sessionId = started.session.id;
  const routes = ['线 1', '线 2', '线 3', '线 4'].map((name, index) => {
    const created = store.createRoute({
      sessionId,
      name,
      climbType: '抱石',
      grade: 'V3',
      colorName: '蓝色',
      colorHex: '#2f6fe4',
      now: new Date(2026, 10, 9, 8, 30 + index)
    });
    assert.equal(created.ok, true, created.error);
    return created.route;
  });

  // 另一场次独有的线路：不得出现在本场换线列表里。
  const other = store.startSession({
    gymName: '岩馆 A',
    date: '2026-11-08',
    now: new Date(2026, 10, 8, 9, 0)
  });
  assert.equal(other.ok, true, other.error);
  const otherRoute = store.createRoute({
    sessionId: other.session.id,
    name: '别的场次的线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(otherRoute.ok, true, otherRoute.error);

  // 回到第一场，当前线是最后建的「线 4」；给线 2/3/4 记把次。
  store.selectSession(sessionId);
  store.selectRoute(routes[3].id);
  [
    { route: routes[1], at: new Date(2026, 10, 9, 8, 40) },
    { route: routes[2], at: new Date(2026, 10, 9, 8, 50) },
    { route: routes[3], at: new Date(2026, 10, 9, 9, 0) }
  ].forEach(item => {
    const saved = store.saveAttempt({
      sessionId,
      routeId: item.route.id,
      result: 'fail',
      now: item.at
    });
    assert.equal(saved.ok, true, saved.error);
  });

  const page = openSessionPage({});
  assert.equal(page.data.selectedRoute.id, routes[3].id);
  assert.equal(page.data.routes.length, 4, '四条线一线一行，全部列出');
  assert.equal(page.data.routeCountText, '本场 4 条');
  // 行序固定按本场关联顺序：记过把的线也不会被挪到前面，同一坐标始终是同一行。
  assert.deepEqual(
    page.data.routes.map(row => row.id),
    sessionRouteIds(sessionId),
    '列表顺序就是本场关联顺序'
  );
  assert.equal(page.data.routes[3].isSelected, true);
  assert.equal(page.data.routes.filter(row => row.isSelected).length, 1, '当前线只有一条');
  assert.equal(new Set(page.data.routes.map(row => row.id)).size, 4, '本场线路不重复');
  assert.deepEqual(
    page.data.routes.map(row => row.id).sort(),
    sessionRouteIds(sessionId).sort(),
    '列表就是真实的本场关联'
  );
  assert.equal(
    page.data.routes.some(row => row.id === otherRoute.route.id),
    false,
    '别的场次独有的线不出现'
  );

  // 点当前那一行：不重复写盘、不改当前线（行位置也不动）。
  const rawAtCurrent = storage.get(ARCHIVE_KEY);
  page.selectRoute(tapDataset({ routeId: routes[3].id }));
  assert.equal(storage.get(ARCHIVE_KEY), rawAtCurrent, '点当前线不重复写盘');
  assert.equal(archiveOf().activeRouteId, routes[3].id, '点当前线不改当前线');

  // 从列表点另一条（整行进入单线记录）：换到它；不新建线路、不加关联、不产生把次。
  const counts = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  const recordFirst = openRecordThroughPage(page, routes[0].id);
  assert.equal(page.data.selectedRoute.id, routes[0].id);
  assert.equal(recordFirst.data.selectedRoute.id, routes[0].id);
  assert.equal(page.data.routes[0].isSelected, true, '当前线在原来那一行上标记');
  assert.equal(page.data.routes[3].isSelected, false);
  assert.equal(archiveOf().routes.length, counts.routes, '选线不新建线路');
  assert.equal(archiveOf().sessionRoutes.length, counts.links, '选线不新增关联');
  assert.equal(archiveOf().attempts.length, counts.attempts, '选线不产生把次');
});

test('T031 选线落盘失败：报未保存、当前线不变，换线列表保留可原地重试', () => {
  const a = seedTraining({ gymName: '岩馆 A', routeName: 'A 线' });
  const b = store.createRoute({
    sessionId: a.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(b.ok, true, b.error);

  const page = openSessionPage({});
  assert.equal(page.data.selectedRoute.id, b.route.id);

  armSetFailAt(1);
  const rawBefore = storage.get(ARCHIVE_KEY);
  page.selectRoute(tapDataset({ routeId: a.route.id }));
  assert.ok(page.data.storageError, '落盘失败要明确报出来，不报成功');
  assert.equal(archiveOf().activeRouteId, b.route.id, '失败不改当前线');
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '失败不写盘');
  assert.equal(page.data.selectedRoute.id, b.route.id);
  assert.equal(
    page.data.routes.some(row => row.id === a.route.id),
    true,
    '失败后这条线仍在列表里，可以原地再点一次'
  );

  // 原地重试同一条：成功后才换过去。
  armSetFailAt(0);
  page.selectRoute(tapDataset({ routeId: a.route.id }));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.selectedRoute.id, a.route.id);
  assert.equal(archiveOf().activeRouteId, a.route.id);
});

test('T031 重新打开同一场次恢复持久化的当前线，并按原 ID 读到逐把、小结与清单', () => {
  const a = seedTraining({ gymName: '岩馆 A', routeName: 'A 线' });
  const b = store.createRoute({
    sessionId: a.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(b.ok, true, b.error);

  const aAttempt = store.saveAttempt({
    sessionId: a.session.id,
    routeId: a.route.id,
    result: 'fail',
    note: 'A 的备注',
    now: new Date(2026, 10, 9, 8, 40)
  });
  assert.equal(aAttempt.ok, true, aAttempt.error);
  const bAttempt = store.saveAttempt({
    sessionId: a.session.id,
    routeId: b.route.id,
    result: 'fail',
    note: 'B 的备注',
    now: new Date(2026, 10, 9, 8, 50)
  });
  assert.equal(bAttempt.ok, true, bAttempt.error);

  // 换到 A（列表选线），再按原 ID 打开单线记录。
  store.selectRoute(a.route.id);
  const page = openSessionPage({});
  const first = openRecordThroughPage(page, a.route.id);
  assert.equal(first.data.selectedRoute.id, a.route.id);

  // 重新打开同一场次：当前线是持久化的那一条。
  const reopened = openSessionPage({});
  assert.equal(reopened.data.selectedRoute.id, a.route.id, '重开恢复持久化的当前线');
  assert.equal(reopened.data.selectedRoute.name, 'A 线');
  // 场内不再有清单展示与清单写入口（T035）。
  assert.equal(typeof reopened.refreshWishlist, 'undefined');
  assert.equal(typeof reopened.addSelectedToWishlist, 'undefined');
  assert.equal(typeof reopened.data.selectedWishlist, 'undefined');

  // 逐把记录按原把次 ID 读回，且只读当前线的（在单线记录页）。
  const recordReopened = openRecordPage();
  const expected = store.attemptsFor(archiveOf(), {
    sessionId: a.session.id,
    routeId: a.route.id
  });
  assert.deepEqual(recordReopened.data.attempts.map(row => row.id), expected.map(item => item.id));
  assert.equal(recordReopened.data.attempts[0].note, 'A 的备注');
  assert.equal(recordReopened.data.routeCountText, '1 把');

  // 小结（T034 起在独立页，按原 sessionId 取数）与清单同样按原线路 ID 列出这条线。
  const summary = buildSessionSummary(archiveOf(), a.session.id);
  assert.equal(
    summary.routes.some(row => row.routeId === a.route.id),
    true,
    '小结按原线路 ID 列出当前线'
  );
  // 场内页的小结入口按原 sessionId 指向这一场（打开独立小结页时带过去的就是它）。
  assert.equal(reopened.data.summaryEntrySessionId, a.session.id, '入口指向本场');
  assert.equal(reopened.data.summaryEntryViewingOther, false);
  // B 的记录没有被 A 的换线或重开改动。
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: a.session.id, routeId: b.route.id }).length,
    1
  );
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: a.session.id, routeId: b.route.id })[0].note,
    'B 的备注'
  );
});

test('T030 复验 同日两场：切回已有四条线、当前选择被清空的旧场次，统一线路名册仍在，不必重新加线', () => {
  // 同一天的两场：第一场必须有四条线并把次，第二场是同日另开（用本地今天，跨天不会变味）。
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate, routeName: '原线 A' });
  const session1 = seeded.session.id;
  const routeA = seeded.route.id;

  const extra = [
    store.createRoute({ sessionId: session1, name: 'B 线', climbType: '抱石', grade: 'V3', colorName: '蓝色', colorHex: '#2f6fe4' }),
    store.createRoute({ sessionId: session1, name: 'C 线', climbType: '顶绳', grade: '5.10a' }),
    store.createRoute({ sessionId: session1, name: 'D 线', climbType: '先锋', grade: '5.10b' })
  ];
  extra.forEach(item => assert.equal(item.ok, true, item.error));
  const originalAttempt = store.saveAttempt({
    sessionId: session1,
    routeId: routeA,
    result: 'fail',
    note: '原线的旧备注',
    now: new Date(2026, 10, 9, 8, 40)
  });
  assert.equal(originalAttempt.ok, true, originalAttempt.error);
  assert.equal(sessionRouteIds(session1).length, 4, '旧场次有四条线');
  assert.equal(linkCount(session1, routeA), 1, '原线在本场只有一条关联');

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, session1);
  assert.equal(page.data.sameDaySessions.length, 1);

  // 同日另开第二场：走真实「开始新场次」入口。
  page.openSessionForm();
  page.onGymNameInput({ detail: { value: '岩馆 A' } });
  page.startSession();
  const session2 = page.data.activeSession.id;
  assert.notEqual(session2, session1);
  assert.equal(page.data.sameDaySessions.length, 2);
  assert.equal(page.data.selectedRoute, null, '新场次不继承上一条线路');

  // 第二场关联原线并记一把：只落在第二场。关联成功即直达单线记录。
  page.pickGymRoute(tapDataset({ routeId: routeA }));
  assert.equal(page.data.selectedRoute.id, routeA);
  const record2 = openRecordPage();
  tick();
  record2.recordAttempt(tapDataset({
    result: 'fail',
    sessionId: session2,
    routeId: routeA,
    archiveId: archiveOf().archiveId
  }));
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session2, routeId: routeA }).length,
    1,
    '第二场记下这一把'
  );
  const session1CountBefore = store.attemptsFor(archiveOf(), { sessionId: session1, routeId: routeA }).length;

  // 点回第一场：只改归属（不新建场次），当前选择按档案层 selectSession 契约被清空。
  page.switchSession(tapDataset({ sessionId: session1 }));
  assert.equal(page.data.activeSession.id, session1);
  assert.equal(archiveOf().activeSessionId, session1);
  assert.equal(archiveOf().activeRouteId, '', 'selectSession 只改归属：当前选择被清空');
  assert.equal(page.data.selectedRoute, null);
  assert.equal(archiveOf().sessions.length, 2, '切换场次不新建场次');

  // 关键：本场明明有四条线，统一名册还在，不是只剩一个「＋ 加线」。
  assert.equal(page.data.routes.length, 4);
  assert.equal(page.data.routeCountText, '本场 4 条');
  page.data.routes.forEach(row => assert.equal(row.isSelected, false, '没有当前线时谁都不是已选'));
  assert.deepEqual(
    new Set(page.data.routes.map(row => row.id)),
    new Set(sessionRouteIds(session1)),
    '本场全部线路都在，别的场次独有的线路不在'
  );

  // 从名册点回原线：只改当前选择，不新建线路、不加关联、不产生把次；直达单线页。
  const before = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  const recordA = openRecordThroughPage(page, routeA);
  assert.equal(page.data.selectedRoute.id, routeA, '路线 ID 就是原来那条');
  assert.equal(page.data.selectedRoute.name, '原线 A');
  assert.equal(recordA.data.selectedRoute.name, '原线 A');
  assert.equal(recordA.data.routeCountText, '1 把');
  assert.equal(recordA.data.attempts.length, 1);
  assert.equal(recordA.data.attempts[0].note, '原线的旧备注', '旧备注按同一个 routeId 读回');
  assert.equal(archiveOf().routes.length, before.routes, '选回原线不新建线路');
  assert.equal(archiveOf().sessionRoutes.length, before.links, '选回原线不新增关联');
  assert.equal(archiveOf().attempts.length, before.attempts, '选回原线不产生把次');
  assert.equal(linkCount(session1, routeA), 1, '同一线路在本场仍然只有一条关联');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session1, routeId: routeA }).length,
    session1CountBefore,
    '第二场的把次没有被搬回第一场'
  );
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session2, routeId: routeA }).length,
    1,
    '第二场那一把仍在第二场'
  );
});

test('T030 复验 空场仍能新建：切到空场次时结果区不冒充已选中，新建第一条即选中并可记结果', () => {
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate, routeName: '原线 A' });
  const page = openSessionPage({});

  // 同日另开第二场：空场。
  page.openSessionForm();
  page.onGymNameInput({ detail: { value: '岩馆 A' } });
  page.startSession();
  assert.notEqual(page.data.activeSession.id, seeded.session.id);
  assert.equal(page.data.routes.length, 0);
  assert.equal(page.data.selectedRoute, null);
  assert.equal(page.data.routeCountText, '', '空场没有可换的线');
  assert.equal(page.data.gymRoutes.length, 1, '本馆已有的那条线仍可作为「本馆已有」加入');

  // 空场新建第一条：名称、类型、等级在首层，创建即选中，并直达单线页记这一把。
  page.openAddRoute();
  page.switchAddRouteMode(tapDataset({ mode: 'new' }));
  page.onNewRouteNameInput({ detail: { value: '空场第一条' } });
  page.createRoute();
  assert.ok(page.data.selectedRoute, '新建即选中');
  assert.equal(page.data.selectedRoute.name, '空场第一条');
  assert.equal(page.data.routes.length, 1);
  assert.equal(page.data.routeCountText, '本场 1 条');
  const sessionId = page.data.activeSession.id;
  const routeId = page.data.selectedRoute.id;
  const recordPage = openRecordPage();
  tick();
  recordPage.recordAttempt(tapDataset({ result: 'fail', sessionId, routeId }));
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId, routeId }).length,
    1,
    '空场新建后能直接记结果'
  );
});

test('T030 复验 迟到点击不把这一把写到别场也别线：按钮带渲染时的场次与线路，不一致就整条拒掉', () => {
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate, routeName: 'A 线' });
  const session1 = seeded.session.id;
  const routeA = seeded.route.id;
  const b = store.createRoute({
    sessionId: session1,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(b.ok, true, b.error);

  const listPage = openSessionPage({});
  listPage.openSessionForm();
  listPage.onGymNameInput({ detail: { value: '岩馆 A' } });
  listPage.startSession();
  const session2 = listPage.data.activeSession.id;
  listPage.pickGymRoute(tapDataset({ routeId: routeA }));
  assert.equal(listPage.data.selectedRoute.id, routeA);

  // 当前按钮的 dataset 就是渲染那一刻的那一份：正常记一把落在第二场的原线上。
  const record2 = openRecordPage();
  tick();
  record2.recordAttempt(tapDataset({
    result: 'fail',
    sessionId: session2,
    routeId: routeA,
    archiveId: archiveOf().archiveId
  }));
  assert.equal(store.attemptsFor(archiveOf(), { sessionId: session2, routeId: routeA }).length, 1);

  // 旧页面（第二场）收到一场之外归属的点击：整条拒掉，不写任何场次。
  const totalBefore = archiveOf().attempts.length;
  record2.recordAttempt(tapDataset({ result: 'fail', sessionId: session1, routeId: routeA }));
  assert.equal(archiveOf().attempts.length, totalBefore, '归属不符的旧点击不落盘');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session1, routeId: routeA }).length,
    0,
    '不写进别的场次'
  );
  assert.match(record2.data.notice, /上一场/, '说明这一下是别的场次的按钮');

  // 第一场的 B 线单线页：带 A 线 dataset 的迟到点击不落到 B 上。
  store.selectSession(session1);
  const recordB = openRecordFor(b.route.id, session1);
  const totalBeforeRoute = archiveOf().attempts.length;
  recordB.recordAttempt(tapDataset({ result: 'fail', sessionId: session1, routeId: routeA }));
  assert.equal(archiveOf().attempts.length, totalBeforeRoute, '迟到的旧线路点击不落盘');
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session1, routeId: b.route.id }).length,
    0,
    '不写进当前（B）线'
  );
  assert.match(recordB.data.notice, /上一条线路/, '说明这一下是上一条线路的按钮');

  // 当前按钮（带当前场次与当前线路）仍然正常记一把。
  tick();
  recordB.recordAttempt(tapDataset({
    result: 'fail',
    sessionId: session1,
    routeId: b.route.id,
    archiveId: archiveOf().archiveId
  }));
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: session1, routeId: b.route.id }).length,
    1,
    '当前的按钮照常记一把'
  );
});

test('T030 复验 没有当前线路时结果按钮在位但不可用：点了不写盘，也不顺手新建关联', () => {
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate, routeName: 'A 线' });
  const page = openSessionPage({});

  page.openSessionForm();
  page.onGymNameInput({ detail: { value: '岩馆 A' } });
  page.startSession();
  const session2 = page.data.activeSession.id;
  page.pickGymRoute(tapDataset({ routeId: seeded.route.id }));
  // 切回第一场（同日多场的原生入口）：当前选择被清空，等价于旧数据/重开时的无选中态。
  page.switchSession(tapDataset({ sessionId: seeded.session.id }));
  assert.equal(page.data.selectedRoute, null);
  assert.ok(page.data.routes.length > 0, '本场线路仍在名册里');

  const before = archiveOf().attempts.length;
  // 场内列表本身没有内联结果按钮：记录入口只属于一条具体线路。
  assert.equal(typeof sessionDefinition.recordAttempt, 'undefined');
  // 入口缺参/失效时单线页只报原因，不写任何把次，也不顺手新建关联。
  const missing = createPage(recordDefinition);
  missing.onLoad({
    archiveId: archiveOf().archiveId,
    sessionId: seeded.session.id,
    routeId: ''
  });
  assert.match(missing.data.contextError, /缺少线路参数/);
  missing.recordAttempt(tapDataset({ result: 'fail' }));
  assert.equal(archiveOf().attempts.length, before, '缺参入口不写任何把次');
  assert.equal(
    (archiveOf().sessionRoutes || []).filter(link => link.sessionId === seeded.session.id).length,
    1,
    '也不顺手替用户新建关联'
  );
  // 从列表选中一条之后就能进入单线页记结果。
  const recordPage = openRecordThroughPage(page, seeded.route.id);
  tick();
  recordPage.recordAttempt(tapDataset({
    result: 'fail',
    sessionId: seeded.session.id,
    routeId: seeded.route.id
  }));
  assert.equal(
    store.attemptsFor(archiveOf(), { sessionId: seeded.session.id, routeId: seeded.route.id }).length,
    1,
    '选中后可直接记结果'
  );
});

test('T030 复验 320 首屏层级：主操作区（加线 / 统一线路列表 / 结果）排在训练标题、日期与同日多场之前', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const recordWxml = fs.readFileSync(RECORD_WXML, 'utf8');

  // T036/T045：场内页首屏是「本场线路（加线 / 统一列表）」，点一条线进入单线页；
  // 单线页以结果 + 同页本场本线把次为主，待保存重试紧随结果区。
  const routesStart = wxml.indexOf('id="session-routes"');
  const routeList = wxml.indexOf('id="route-list"');
  const sessionCard = wxml.indexOf('class="card session-card"');
  const summaryStart = wxml.indexOf('id="session-summary"');
  assert.ok(routesStart !== -1 && routeList !== -1 && sessionCard !== -1 && summaryStart !== -1);
  assert.ok(routesStart < routeList, '加线在列表之前');
  assert.ok(routeList < sessionCard, '本场线路列表排在训练标题、日期与同日多场入口之前');
  assert.ok(sessionCard < summaryStart, '场次信息仍在本次小结之前');
  assert.ok(wxml.indexOf('id="session-chip-') > routeList, '同日多场的原生入口仍然保留');

  const resultSend = recordWxml.indexOf('id="record-send"');
  const pendingStart = recordWxml.indexOf('id="pending-{{item.opId}}"');
  const attemptsStart = recordWxml.indexOf('id="record-attempts"');
  assert.ok(resultSend !== -1 && pendingStart !== -1 && attemptsStart !== -1);
  assert.ok(resultSend < pendingStart, '待保存重试紧随结果按钮');
  assert.ok(pendingStart < attemptsStart, '本场本线把次排在待保存行之后');
  // 单线页没有页内换线列表、照片卡与第二套写入：那些都在各自目的地。
  assert.doesNotMatch(recordWxml, /id="route-switch"/);
  assert.doesNotMatch(recordWxml, /id="route-photo-card"/);
  // 结果按钮把渲染时的档案、场次与线路带进 dataset（迟到点击按它对账）。
  assert.match(
    recordWxml,
    /id="record-fail"[\s\S]{0,400}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,200}data-session-id="\{\{activeSession\.id\}\}"[\s\S]{0,200}data-route-id="\{\{selectedRoute\.id\}\}"/
  );
  assert.match(
    recordWxml,
    /id="record-send"[\s\S]{0,400}data-archive-id="\{\{archiveId\}\}"[\s\S]{0,200}data-session-id="\{\{activeSession\.id\}\}"[\s\S]{0,200}data-route-id="\{\{selectedRoute\.id\}\}"/
  );
  // T045：现场独立逐把跳转与线路历史入口已移出。
  assert.equal(recordWxml.indexOf('id="open-attempts"'), -1, '不再有独立逐把跳转');
  assert.equal(recordWxml.indexOf('id="open-route-profile"'), -1, '不再有线路历史入口');
  assert.equal(recordWxml.indexOf('id="record-links"'), -1, '入口区已移除');
});

test('T030 复验 布局滚入视口：新建 / 选中 / 切场次后按现量布局把换线与结果带回可见处，已可见不滚', () => {
  const todayDate = store.todayLocalDate();
  const seeded = seedTraining({ gymName: '岩馆 A', date: todayDate, routeName: 'A 线' });
  const session1 = seeded.session.id;
  // 同日另开一场并给它一条线：从列表切过去时同样有本场线路。
  const second = store.startSession({ gymName: '岩馆 A', date: todayDate });
  assert.equal(second.ok, true, second.error);
  const session2 = second.archive.activeSessionId;
  const secondRoute = store.createRoute({
    sessionId: session2,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3'
  });
  assert.equal(secondRoute.ok, true, secondRoute.error);
  // 页面初始状态：第一场 + 原线已选中。
  assert.equal(store.selectSession(session1).ok, true);
  assert.equal(store.selectRoute(seeded.route.id).ok, true);

  const page = openSessionPage({});
  assert.equal(page.data.activeSession.id, session1);
  assert.equal(page.data.selectedRoute.id, seeded.route.id);

  // 单线记录不再靠滚动露出结果：点一条线直接进入那条线的页面。
  const scrolls = [];
  const realPageScrollTo = global.wx.pageScrollTo;
  global.wx.pageScrollTo = options => scrolls.push(options);
  try {
    const recordA = openRecordThroughPage(page, seeded.route.id);
    assert.equal(recordA.data.activeSession.id, session1);
    assert.equal(recordA.data.selectedRoute.id, seeded.route.id);
    assert.equal(recordA.data.routeCountText, '0 把');
    assert.equal(scrolls.length, 0, '直达单线页，不需要滚动定位');

    // 新建线路成功：同样直接进入新线的单线页。
    page.openAddRoute();
    page.switchAddRouteMode(tapDataset({ mode: 'new' }));
    page.onNewRouteNameInput({ detail: { value: '新线 E' } });
    page.createRoute();
    const createdRoute = archiveOf().routes.find(route => route.name === '新线 E');
    assert.ok(createdRoute, '新线已落盘');
    assert.equal(wxLog.navigations.at(-1).url.includes('routeId=' + createdRoute.id), true);
    assert.equal(scrolls.length, 0, '新建后直达单线页，不需要滚动定位');

    // 同日多场切换：只改列表归属，不靠滚动找回结果按钮。
    page.switchSession(tapDataset({ sessionId: session2 }));
    assert.equal(page.data.activeSession.id, session2);
    assert.equal(page.data.selectedRoute, null, '新场次不继承上一条线路');
    assert.equal(scrolls.length, 0, '切场次不主动滚动');
  } finally {
    global.wx.pageScrollTo = realPageScrollTo;
  }
});

test('T030 复验 撤回与恢复是原地动作：不主动滚动，刚才点过的坐标留在原处', () => {
  const seeded = seedTraining({ gymName: '岩馆 A', routeName: 'A 线' });
  const page = openRecordPage();
  assert.equal(page.data.selectedRoute.id, seeded.route.id);

  // 撤回/恢复与补备注都是原地动作，不主动滚——滚动会挪走用户刚点过的坐标。
  const scrolls = [];
  const realPageScrollTo = global.wx.pageScrollTo;
  global.wx.pageScrollTo = options => scrolls.push(options);
  try {
    tick();
    page.recordAttempt(tapDataset({
      result: 'fail',
      sessionId: page.data.activeSession.id,
      routeId: page.data.selectedRoute.id
    }));
    const recent = page.data.recentAttempt;
    assert.ok(recent && recent.canUndo, '有一条可撤回的最近一把');
    page.undoLatestAttempt(attemptRowEvent(recent));
    assert.equal(page.data.recentAttempt.canRestore, true, '撤回已生效');
    assert.equal(scrolls.length, 0, '撤回不主动滚动');
    page.restoreLatestAttempt(attemptRowEvent(page.data.recentAttempt));
    assert.equal(page.data.recentAttempt.canUndo, true, '恢复已生效');
    assert.equal(scrolls.length, 0, '恢复不主动滚动');
    // 给这一把补备注（明细页）也是原地动作，不滚。
    const attemptsPage = openAttemptsFor(seeded.session.id, seeded.route.id);
    attemptsPage.openNoteEditor(tapDataset({ attemptId: attemptsPage.data.attempts[0].id }));
    attemptsPage.onNoteInput({ detail: { value: '原地补备注' } });
    attemptsPage.saveNote();
    assert.equal(scrolls.length, 0, '补备注不主动滚动');
  } finally {
    global.wx.pageScrollTo = realPageScrollTo;
  }
});

test('R3 两把未完成只给第二把加备注，完攀收起新增入口并在最近一把旁更正', async () => {
  const seeded = seedTraining();
  const page = openRecordPage();
  const routeId = seeded.route.id;
  const sessionId = seeded.session.id;

  // 两把未完成。
  tick();
  page.recordAttempt(tapResult('fail'));
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(page.data.attempts.length, 2);
  assert.deepEqual(page.data.attempts.map(item => item.label), ['第 1 把', '第 2 把']);
  assert.deepEqual(page.data.attempts.map(item => item.resultText), ['未完成', '未完成']);
  assert.equal(page.data.attempts[0].note, '');

  // 仅给第二把加备注（明细页）：第一把不受影响。
  const firstId = page.data.attempts[0].id;
  const secondId = page.data.attempts[1].id;
  const attemptsPage = openAttemptsFor(sessionId, routeId);
  attemptsPage.openNoteEditor(tapDataset({ attemptId: secondId }));
  assert.equal(attemptsPage.data.noteEditor.attemptLabel, '第 2 把');
  assert.equal(attemptsPage.data.noteEditor.text, '');
  attemptsPage.onNoteInput({ detail: { value: '抓到后向右摆' } });
  tick();
  attemptsPage.saveNote();
  assert.equal(attemptsPage.data.noteEditor, null);
  page.onShow();
  assert.equal(page.data.attempts[0].note, '', '备注不能写到第一把');
  assert.equal(page.data.attempts[1].note, '抓到后向右摆');
  assert.equal(store.attemptsFor(archiveOf(), { routeId }).length, 2);

  // 再记抱石完攀：确认后收起新增结果按钮，最近一把旁给出「更正结果」。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routeStateText, '已完攀');
  const sendId = page.data.attempts[2].id;
  const recentSend = page.data.recentAttempt;
  assert.equal(recentSend.attemptId, sendId, '更正入口就在最近这一把旁');
  assert.equal(recentSend.correctionSupported, true);
  assert.equal(recentSend.correctable, true, '给出一把可更正的控件');
  assert.equal(recentSend.correctText, '更正结果');
  assert.match(recentSend.correctLabel, /第 3 把/);
  assert.match(recentSend.correctContextText, /2026-11-09/);
  assert.match(recentSend.correctContextText, /第 1 场/);

  // 完攀后再点结果不会新增（守卫在档案层）。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 3);

  // 先取消一次：确认弹窗里能认出原把次与预期结果，取消时一个字节都不写。
  const archiveBeforeCancel = JSON.stringify(archiveOf());
  queueModal('cancel');
  assert.equal(
    await page.correctSend(
      tapDataset({ attemptId: sendId, routeId, sessionId, archiveId: archiveOf().archiveId })
    ),
    null,
    '取消返回空，不落盘'
  );
  const cancelPrompt = modalLog.calls.at(-1);
  assert.match(cancelPrompt.content, /第 3 把/, '确认里写明原把次');
  assert.match(cancelPrompt.content, /完攀/, '确认里写明原结果');
  assert.match(cancelPrompt.content, /未完成/, '确认里写明将要改成的结果');
  assert.match(cancelPrompt.content, /2026-11-09/, '确认里写明原场次日期');
  assert.equal(JSON.stringify(archiveOf()), archiveBeforeCancel, '取消不写盘');
  assert.equal(page.data.recentAttempt.correctable, true, '取消后按钮还在原位');

  // 确认后改为未完成：把数不变，ID、场次、时间与备注保留。
  const sendAttemptBefore = archiveOf().attempts.find(item => item.id === sendId);
  await page.correctSend(
    tapDataset({ attemptId: sendId, routeId, sessionId, archiveId: archiveOf().archiveId })
  );
  const afterCorrect = archiveOf();
  assert.equal(afterCorrect.attempts.length, 3, '更正不增把数');
  const sendAttemptAfter = afterCorrect.attempts.find(item => item.id === sendId);
  assert.equal(sendAttemptAfter.result, 'fail');
  assert.equal(sendAttemptAfter.sessionId, sendAttemptBefore.sessionId);
  assert.equal(sendAttemptAfter.seq, sendAttemptBefore.seq);
  assert.equal(sendAttemptAfter.createdAt, sendAttemptBefore.createdAt);
  assert.equal(sendAttemptAfter.note, sendAttemptBefore.note);
  assert.equal(afterCorrect.attempts.find(item => item.id === secondId).note, '抓到后向右摆');
  assert.equal(page.data.routeCompleted, false, '更正后收起状态解除');
  assert.equal(page.data.recentAttempt.correctable, false, '这一把已不是可更正的完攀');
  assert.match(page.data.recentAttempt.correctStatusText, /已改为未完成/);

  // 更正后可以再记一次完攀：总把数加一。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 4);
  assert.equal(store.routeCompletion(archiveOf(), routeId).sendCount, 1);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.recentAttempt.correctable, true);

  // 连点同一把（第二个弹窗还开着就再点一次）：只弹一次确认，最终只改这一把。
  const newestSendId = page.data.recentAttempt.attemptId;
  const newestEvent = tapDataset({
    attemptId: newestSendId,
    routeId,
    sessionId,
    archiveId: archiveOf().archiveId
  });
  const modalCallsBefore = modalLog.calls.length;
  queueModal('hold');
  const firstClick = page.correctSend(newestEvent);
  const secondClick = page.correctSend(newestEvent);
  assert.equal(modalLog.calls.length - modalCallsBefore, 1, '连点同一把只弹一次确认');
  const held = modalLog.held[0];
  held.success({ confirm: true });
  await Promise.all([firstClick, secondClick]);
  const finalArchive = archiveOf();
  assert.equal(finalArchive.attempts.length, 4, '连点同一把不增把数');
  assert.equal(store.routeCompletion(finalArchive, routeId).sendCount, 0);
  assert.equal(finalArchive.pendingCorrections.length, 0);
  // 逐把结果没有被别的操作串改：两把未完成与备注仍在原位。
  assert.equal(finalArchive.attempts[0].result, 'fail');
  assert.equal(finalArchive.attempts[1].result, 'fail');
  assert.equal(finalArchive.attempts[1].note, '抓到后向右摆');
  assert.equal(finalArchive.attempts.find(item => item.id === firstId).note, '');
  assert.equal(finalArchive.attempts.find(item => item.id === sendId).result, 'fail');
  assert.equal(finalArchive.attempts.find(item => item.id === newestSendId).result, 'fail');
});

test('T042 两把夹具：最近一把旁更正只翻原把次，有效两把、完攀减一，重开一致', async () => {
  const seeded = seedTraining({ gymName: '两把岩馆', routeName: '两把抱石线' });
  const page = openRecordPage();
  const routeId = seeded.route.id;
  const sessionId = seeded.session.id;
  const archiveId = archiveOf().archiveId;

  tick();
  page.recordAttempt(tapResult('fail'));
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.attempts.length, 2);
  const firstId = page.data.attempts[0].id;
  const sendId = page.data.attempts[1].id;

  // 完攀这一把带备注与本机视频关联：更正前后必须逐项一致。
  const noted = store.setAttemptNote(sendId, {
    note: '这一把完攀备注',
    sessionId,
    routeId
  });
  assert.equal(noted.ok, true, noted.error);
  const clip = {
    archiveId,
    attemptId: sendId,
    sessionId,
    routeId,
    clipId: 'clip-two',
    fileId: 'attempt-video/v1/' + archiveId + '/clip-two.mp4',
    rev: 1
  };
  storage.set(VIDEO_INDEX_KEY, JSON.stringify({ clips: [clip] }));
  page.onShow();

  const before = {
    first: archiveOf().attempts.find(item => item.id === firstId),
    send: archiveOf().attempts.find(item => item.id === sendId),
    video: storage.get(VIDEO_INDEX_KEY)
  };
  assert.equal(page.data.recentAttempt.attemptId, sendId, '更正入口就在最近这一把旁');
  assert.equal(page.data.recentAttempt.correctable, true);
  assert.equal(page.data.routeCountText, '2 把');

  await page.correctSend(tapDataset({ attemptId: sendId, routeId, sessionId, archiveId }));

  const after = archiveOf();
  const corrected = after.attempts.find(item => item.id === sendId);
  assert.equal(corrected.result, 'fail');
  assert.equal(corrected.id, before.send.id, '原把 ID 不变');
  assert.equal(corrected.seq, before.send.seq, '原序号不变');
  assert.equal(corrected.createdAt, before.send.createdAt, '原时间不变');
  assert.equal(corrected.note, '这一把完攀备注', '原备注不变');
  assert.equal(
    after.attempts.find(item => item.id === firstId).result,
    before.first.result,
    '另一把不被串改'
  );
  assert.equal(
    storage.get(VIDEO_INDEX_KEY),
    before.video,
    '视频标识与本机副本关联原样保留'
  );
  assert.equal(store.attemptsFor(after, { sessionId, routeId }).length, 2, '有效把数仍为 2');
  assert.equal(store.routeCompletion(after, routeId).sendCount, 0, '完攀数减一');
  assert.equal(page.data.routeCountText, '2 把', '把数读法不变');
  assert.equal(page.data.routeCompleted, false, '单线锁定状态随更正解除');

  // 重开：按最新档案读到同一把已是未完成，不再给更正入口。
  const reopened = openRecordPage();
  assert.equal(reopened.data.recentAttempt.attemptId, sendId);
  assert.equal(reopened.data.recentAttempt.correctable, false);
  assert.equal(reopened.data.attempts[1].resultText, '未完成');
  assert.equal(reopened.data.attempts[1].note, '这一把完攀备注');
  assert.equal(reopened.data.routeCountText, '2 把');
});

test('T042 更正结果写失败后保留同一把的重试入口，重开与旧按钮都不改别的把次', async () => {
  const seeded = seedTraining({ gymName: '更正重试馆', routeName: '重试抱石线' });
  const page = openRecordPage();
  const routeId = seeded.route.id;
  const sessionId = seeded.session.id;
  const archiveId = archiveOf().archiveId;
  tick();
  page.recordAttempt(tapResult('fail'));
  tick();
  page.recordAttempt(tapResult('send'));
  const firstId = page.data.attempts[0].id;
  const sendId = page.data.attempts[1].id;
  const correctionEvent = tapDataset({ attemptId: sendId, routeId, sessionId, archiveId });

  // 第二段写失败：档案里留下 pendingCorrections 标记，页面不报已保存。
  armSetFailAt(2);
  await page.correctSend(correctionEvent);
  armSetFailAt(0);
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.match(page.data.notice, /更正未保存/);
  assert.equal(page.data.recentAttempt.correctable, true, '仍是同一把可更正');
  assert.equal(page.data.recentAttempt.correctText, '重试更正结果');
  assert.equal(archiveOf().attempts.find(item => item.id === sendId).result, 'send');
  assert.equal(archiveOf().pendingCorrections.length, 1);

  // 重开（新实例）：重试文案来自档案里的进行中标记，仍指向原把次。
  const reopened = openRecordPage();
  assert.equal(reopened.data.recentAttempt.attemptId, sendId);
  assert.equal(reopened.data.recentAttempt.correctText, '重试更正结果');

  // 重试成功：只翻这一把，另一把、原备注与待更正标记都按既有规则收尾。
  await reopened.correctSend(correctionEvent);
  const after = archiveOf();
  assert.equal(after.attempts.find(item => item.id === sendId).result, 'fail');
  assert.equal(after.attempts.find(item => item.id === firstId).result, 'fail');
  assert.equal(after.attempts.length, 2, '重试不增把数');
  assert.equal(after.pendingCorrections.length, 0, '重试结清进行中标记');
  assert.equal(reopened.data.routeCountText, '2 把');
  assert.equal(reopened.data.routeCompleted, false);

  // 旧按钮（同一组 ID）再点一次：这一把已不是可更正的完攀，不弹确认、不写盘。
  const rawAfter = JSON.stringify(archiveOf());
  const modalCallsBefore = modalLog.calls.length;
  assert.equal(await reopened.correctSend(correctionEvent), null);
  assert.equal(modalLog.calls.length, modalCallsBefore, '旧按钮不再弹确认');
  assert.equal(JSON.stringify(archiveOf()), rawAfter, '旧按钮不写盘');
});

test('R3 迟到或跨线路的「更正结果」不改动任何数据，也不弹确认', async () => {
  const seeded = seedTraining();
  const page = openRecordPage();
  tick();
  page.recordAttempt(tapResult('send'));
  const sendId = page.data.attempts[0].id;

  // 归属不符（伪造的线路 ID）：确认都不弹，明确拒绝，不落盘。
  assert.equal(
    await page.correctSend(tapDataset({ attemptId: sendId, routeId: 'route-999' })),
    null
  );
  assert.equal(modalLog.calls.length, 0, '归属不符不弹确认');
  assert.equal(archiveOf().attempts[0].result, 'send');
  assert.match(page.data.notice, /没有改动任何记录/);

  // 找不到的把次：同一把的入口也不打开，不改数据。
  assert.equal(await page.correctSend(tapDataset({ attemptId: 'op-not-exist' })), null);
  assert.equal(modalLog.calls.length, 0);
  assert.equal(archiveOf().attempts[0].result, 'send');
  assert.match(page.data.notice, /没有可更正的完攀/);
});

// ------------------------------------------------------------------ *
// R5 保存边界：快速双击、本机写失败与重试、跨页面迟到操作
// ------------------------------------------------------------------ *

test('R5 同一把按钮快速双击只记一次，隔开时间可以记第二把', () => {
  seedTraining();
  const page = openRecordPage();

  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 1);
  // 同一时刻再点一次同一按钮：视为误触，不新增把次也不影响档案。
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 1, '快速双击不能记成两把');
  assert.match(page.data.notice, /刚记过这一把/);

  // 隔开时间后正常记第二把。
  tick(1500);
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 2);
  assert.deepEqual(page.data.attempts.map(item => item.resultText), ['未完成', '未完成']);
});

test('R5 第一段写入就失败：显示未保存，重试同一操作只多预期的一把', () => {
  seedTraining();
  const page = openRecordPage();

  armSetFailAt(1);
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 0, '未落盘就不能算已保存');
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  assert.match(page.data.notice, /未保存/);
  assert.equal(page.data.hasPending, true);
  assert.equal(page.data.resultLocked, true, '有未保存的把次时先重试，不记下一把');
  assert.match(page.data.resultLockHint, /重试保存/);

  const opId = page.data.pendingRows[0].opId;
  armSetFailAt(0);
  tick();
  page.retryPendingAttempt(tapDataset({ opId }));
  assert.equal(archiveOf().attempts.length, 1, '重试只多预期的一把');
  assert.equal(archiveOf().attempts[0].id, opId);
  assert.equal(page.data.pendingRows.length, 0);
  assert.equal(page.data.resultLocked, false);
  assert.equal(page.data.storageError, '');

  // 同一把重试两次也只提交一次。
  page.retryPendingAttempt(tapDataset({ opId }));
  assert.equal(archiveOf().attempts.length, 1);
});

test('R5 提交段失败：保留待保存行，重试复用同一把与序号', () => {
  seedTraining();
  const page = openRecordPage();

  // 第一段（进行中标记）成功、第二段（提交把次）失败。
  armSetFailAt(2);
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 0);
  assert.equal(archiveOf().pendingSaves.length, 1);
  assert.equal(page.data.pendingRows.length, 1);
  assert.match(page.data.pendingRows[0].label, /第 1 把/, '待保存行占用原序号');
  assert.match(page.data.pendingRows[0].statusText, /未保存/);
  assert.equal(page.data.resultLocked, true);

  const opId = page.data.pendingRows[0].opId;
  armSetFailAt(0);
  tick();
  page.retryPendingAttempt(tapDataset({ opId }));
  const archive = archiveOf();
  assert.equal(archive.attempts.length, 1);
  assert.equal(archive.attempts[0].id, opId);
  assert.equal(archive.pendingSaves.length, 0);
  assert.equal(page.data.pendingRows.length, 0);
});

test('R5 抱石完攀提交段失败后重开场内页：待保存行按原 opId 重试补上唯一一次完攀', () => {
  const { session, route } = seedTraining();
  store.selectRoute(route.id);

  // 第一段（进行中标记）成功、第二段（提交完攀）失败：档案里留下一条在途完攀。
  armSetFailAt(2);
  const failed = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'send',
    note: '完攀这把'
  });
  assert.equal(failed.ok, false);
  assert.equal(archiveOf().pendingSaves.length, 1);

  // 别的操作（换 opId）不能借这条在途完攀新增。
  const competitor = store.saveAttempt({
    sessionId: session.id,
    routeId: route.id,
    result: 'send',
    note: '别的操作'
  });
  assert.equal(competitor.ok, false);
  assert.equal(competitor.blocked, true);
  assert.equal(archiveOf().attempts.length, 0);

  // 重开页面（等价于退出小程序后再进来）：待保存行来自档案本身。
  const page = openRecordPage();
  assert.equal(page.data.pendingRows.length, 1);
  assert.equal(page.data.pendingRows[0].opId, failed.opId);
  assert.equal(page.data.resultLocked, true);
  assert.equal(page.data.routeStateText, '完攀待确认');

  armSetFailAt(0);
  tick();
  page.retryPendingAttempt(tapDataset({ opId: failed.opId }));

  const archive = archiveOf();
  assert.equal(archive.attempts.length, 1, '一条尝试');
  assert.equal(archive.attempts[0].id, failed.opId);
  assert.equal(archive.attempts[0].result, 'send', '一条完攀');
  assert.equal(archive.attempts[0].note, '完攀这把');
  assert.equal(archive.attempts[0].routeId, route.id);
  assert.equal(archive.attempts[0].sessionId, session.id);
  assert.equal(archive.pendingSaves.length, 0, '无残留待保存');
  assert.equal(page.data.pendingRows.length, 0);
  assert.equal(page.data.hasPending, false);
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].resultText, '完攀');
  assert.equal(page.data.routeStateText, '已完攀');
});

test('R5 抱石第一段回执丢失：旧实例本地待保存行与重开页面都只补上同一把，不重复也不抢别人的 opId', () => {
  const { session, route } = seedTraining();
  const stale = openRecordPage();
  assert.equal(stale.data.activeSession.id, session.id);

  // 第一段写已生效但回执丢失：页面只看到失败，档案里其实已有在途完攀。
  armSetLoseResponseAt(1);
  tick();
  stale.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 0, '回执丢失时不能算已保存');
  assert.equal(archiveOf().pendingSaves.length, 1, '进行中标记其实已落盘');
  assert.match(stale.data.storageError, /保存本机训练档案失败/);
  assert.equal(stale.data.hasPending, true, '本实例的本地待保存行仍在');

  // 重开页面：待保存行来自档案，opId 与旧实例本地那一行一致。
  const reopened = openRecordPage();
  assert.equal(reopened.data.pendingRows.length, 1);
  const opId = reopened.data.pendingRows[0].opId;
  assert.equal(opId, stale.data.pendingRows[0].opId, '同一操作只有一个 opId');
  assert.equal(archiveOf().pendingSaves[0].opId, opId);

  armSetLoseResponseAt(0);
  tick();
  reopened.retryPendingAttempt(tapDataset({ opId }));
  const archive = archiveOf();
  assert.equal(archive.attempts.length, 1);
  assert.equal(archive.attempts[0].id, opId);
  assert.equal(archive.attempts[0].result, 'send');
  assert.equal(archive.pendingSaves.length, 0);
  assert.equal(reopened.data.pendingRows.length, 0);

  // 旧实例随后按自己的本地待保存行重试同一 opId：幂等，不产生第二把。
  tick();
  stale.retryPendingAttempt(tapDataset({ opId }));
  assert.equal(archiveOf().attempts.length, 1, '同一操作只提交一次');
  assert.equal(stale.data.pendingRows.length, 0);
  assert.equal(stale.data.storageError, '');

  // 已完攀后同一实例再点「完攀」：走完攀守卫，不新增把次。
  tick(1500);
  stale.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 1);
  assert.match(stale.data.notice, /已完攀/);
});

test('R5 两个页面实例的迟到操作与重复提交不覆盖新数据，重开后逐项一致', () => {
  const seeded = seedTraining();
  const pageA = openRecordPage();
  // 页面 B 是另一个实例（模拟同时打开或返回后的旧快照）。
  const pageB = openRecordPage();
  assert.equal(pageB.data.activeSession.id, pageA.data.activeSession.id);
  assert.equal(pageB.data.attempts.length, 0);

  tick();
  pageA.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 1);
  // B 的界面上仍是旧快照（0 把），但它按最新档案增量追加。
  assert.equal(pageB.data.attempts.length, 0);
  tick();
  pageB.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 2, '两个实例各自的一把都要保留');

  // B 再重复提交 A 的那一次操作：同一操作 ID 幂等，仍是两把。
  const opIdA = archiveOf().attempts[0].id;
  tick();
  const duplicate = store.saveAttempt({
    opId: opIdA,
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(archiveOf().attempts.length, 2);

  // 给第二把补备注（明细页）后重开：线路、场次、结果与第二把备注逐项一致。
  // A 是旧快照，先按最新档案刷新（相当于用户切回本页），再补备注。
  pageA.onShow();
  assert.equal(pageA.data.attempts.length, 2);
  const secondId = archiveOf().attempts[1].id;
  const attemptsPage = openAttemptsFor(seeded.session.id, seeded.route.id);
  attemptsPage.openNoteEditor(tapDataset({ attemptId: secondId }));
  assert.equal(attemptsPage.data.noteEditor.attemptLabel, '第 2 把');
  attemptsPage.onNoteInput({ detail: { value: '第二把备注' } });
  tick();
  attemptsPage.saveNote();
  assert.equal(attemptsPage.data.noteEditor, null);
  assert.equal(archiveOf().attempts[1].note, '第二把备注');

  const cold = openRecordPage();
  assert.equal(cold.data.activeSession.id, seeded.session.id);
  assert.equal(cold.data.selectedRoute.id, seeded.route.id);
  assert.equal(cold.data.selectedRoute.name, '蓝色动态线');
  assert.deepEqual(cold.data.attempts.map(item => item.resultText), ['未完成', '未完成']);
  assert.equal(cold.data.attempts[1].note, '第二把备注');
  assert.equal(cold.data.attempts[0].note, '');
  // 重开后仍留在正式命名空间，且没有云调用。
  assert.equal(typeof global.wx.cloud, 'undefined');
  assert.ok(storage.has(ARCHIVE_KEY));
});

test('R1 旧云请求失败、延迟或迟到返回都不遮住训练入口', async () => {
  seedTraining({ gymName: '岩馆 A' });

  const pending = [];
  db.getRecentRecords = () => {
    const item = deferred();
    pending.push(item);
    return item.promise;
  };

  const home = openHome();
  // 延迟：云请求还没回来，训练入口已经可用。
  assert.equal(home.data.loading, true);
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.gymName, '岩馆 A');

  // 失败：只影响旧记录区，入口与当前场次不变。
  pending[0].reject(Object.assign(new Error('云不可用'), { code: 'CLOUD_UNAVAILABLE' }));
  await flush();
  assert.equal(home.data.cloudState, 'error');
  assert.match(home.data.cloudError, /旧记录暂不可读（云环境不可用）/);
  assert.equal(home.data.loading, false);
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.gymName, '岩馆 A');

  // 迟到返回：先发起的请求后返回，不得覆盖更新的状态。
  const first = home.loadRecentRecords();
  const second = home.loadRecentRecords();
  pending[2].resolve({ data: [{ _id: 'rec-B', date: '2026-11-09' }] });
  await second;
  assert.equal(home.data.recentRecords.length, 1);
  assert.equal(home.data.recentRecords[0]._id, 'rec-B');
  pending[1].resolve({ data: [{ _id: 'rec-A', date: '2026-11-08' }] });
  await first;
  assert.equal(home.data.recentRecords.length, 1, '迟到返回不覆盖新状态');
  assert.equal(home.data.recentRecords[0]._id, 'rec-B');
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);

  db.getRecentRecords = realGetRecentRecords;
});

test('R5 没有 wx.cloud 时首页仍能显示本机训练入口，旧云读给出可判别失败', async () => {
  seedTraining({ gymName: '断网岩馆' });
  assert.equal(typeof global.wx.cloud, 'undefined');

  const home = openHome();
  await flush();
  assert.equal(home.data.cloudState, 'error');
  assert.match(home.data.cloudError, /云环境不可用/);
  assert.equal(home.data.trainingReady, true);
  assert.equal(home.data.hasActiveSession, true);
  assert.equal(home.data.activeSession.gymName, '断网岩馆');

  // 断网下仍可进入单线记录页继续记录。
  const page = openRecordPage();
  page.onShow();
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(archiveOf().attempts.length, 1);
});

test('R1 旧「添加记录」与记录列表、详情入口保持可达', () => {
  seedTraining();
  const home = openHome();

  home.goToAddRecord();
  assert.equal(wxLog.navigations.at(-1).url, '/pages/add-record/add-record');
  home.goToDetail({ currentTarget: { dataset: { id: 'rec-1' } } });
  assert.equal(wxLog.navigations.at(-1).url, '/pages/record-detail/record-detail?id=rec-1');
  home.goToList();
  assert.equal(wxLog.switches.at(-1).url, '/pages/record-list/record-list');
});

test('R5 补改备注只改指定的一把：归属不符、把次不存在与落盘失败都不改数据', () => {
  const seeded = seedTraining();
  const first = store.saveAttempt({
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail'
  });
  const second = store.saveAttempt({
    sessionId: seeded.session.id,
    routeId: seeded.route.id,
    result: 'fail',
    note: '原本的备注'
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);

  // 归属不符：拒绝，两把都不变。
  const conflict = store.setAttemptNote(second.attempt.id, {
    routeId: 'route-999',
    note: '不该写进去'
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');

  // 把次不存在：拒绝。
  const missing = store.setAttemptNote('op-not-exist', { note: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  // 落盘失败：不报已保存，原备注保留。
  armSetFailAt(1);
  const failed = store.setAttemptNote(second.attempt.id, { note: '写不进去' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  armSetFailAt(0);
  assert.equal(
    archiveOf().attempts.find(item => item.id === second.attempt.id).note,
    '原本的备注'
  );

  // 正常补改：只改这一把，第一把与本把的结果、序号、场次都不动。
  const saved = store.setAttemptNote(second.attempt.id, {
    routeId: seeded.route.id,
    sessionId: seeded.session.id,
    note: '抓到后向右摆'
  });
  assert.equal(saved.ok, true, saved.error);
  const archive = archiveOf();
  const secondAfter = archive.attempts.find(item => item.id === second.attempt.id);
  assert.equal(secondAfter.note, '抓到后向右摆');
  assert.equal(secondAfter.result, 'fail');
  assert.equal(secondAfter.seq, second.attempt.seq);
  const firstAfter = archive.attempts.find(item => item.id === first.attempt.id);
  assert.equal(firstAfter.note, '');
  assert.equal(firstAfter.result, 'fail');

  // 档案损坏时不写入、不覆盖。
  storage.set(ARCHIVE_KEY, '{ 坏 JSON');
  const corruptRaw = storage.get(ARCHIVE_KEY);
  const unreadable = store.setAttemptNote(second.attempt.id, { note: '仍然不写' });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, 'unreadable');
  assert.equal(storage.get(ARCHIVE_KEY), corruptRaw);
});

test('R1 本机档案损坏时首页与场内页都可见报错，且不改写原数据', () => {
  storage.set(ARCHIVE_KEY, '{ 这不是合法 JSON');
  const corruptRaw = storage.get(ARCHIVE_KEY);

  const home = openHome();
  assert.equal(home.data.trainingReady, false);
  assert.equal(home.data.archiveError, store.ARCHIVE_BROKEN);

  const page = openSessionPage({ start: '1' });
  assert.equal(page.data.loadError, store.ARCHIVE_BROKEN);
  assert.equal(page.data.sessionFormVisible, false);
  // 页面上的写操作不落盘、不覆盖损坏数据。
  page.onGymNameInput({ detail: { value: '新岩馆' } });
  page.startSession();
  assert.equal(storage.get(ARCHIVE_KEY), corruptRaw);

  // 旧「添加记录」入口仍可达（本机档案损坏不影响旧入口）。
  home.goToAddRecord();
  assert.equal(wxLog.navigations.at(-1).url, '/pages/add-record/add-record');
});

// ------------------------------------------------------------------ *
// T033 最近一把的原地撤回与恢复
// ------------------------------------------------------------------ *

/**
 * 页面这一行渲染出来的点击参数：原把次 ID、原归属与预期状态，与 WXML 里绑定在撤回 /
 * 恢复按钮上的 dataset 一一对应（模拟器里点击作用于真实坐标，取到的就是这几个值）。
 */
function attemptRowEvent(row) {
  return tapDataset({
    attemptId: row.attemptId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    archiveId: row.archiveId,
    expected: row.expected,
    expectedRev: row.expectedRev
  });
}

/** 按顺序给一条线路记若干把（第 n 把可带自己的备注），返回原把次。 */
function saveAttemptSeries(session, route, results, noteOf) {
  return results.map(
    (result, index) =>
      store.saveAttempt({
        sessionId: session.id,
        routeId: route.id,
        result,
        note: noteOf ? noteOf(index) : '',
        now: new Date(2026, 10, 9, 9, 5 + index * 3)
      }).attempt
  );
}

/** 档案里一条线路的全部已提交把次（含已撤回），按序号排。 */
function savedAttempts(sessionId, routeId) {
  return store.attemptsFor(archiveOf(), { sessionId, routeId, includeUndone: true });
}

/** 页面这一行现在指向哪一把、什么状态（撤回/恢复目标核对用）。 */
function rowOf(page) {
  return page.data.recentAttempt;
}

test('T050 返工 最新一把右侧直接给「撤销」：现场无纠错菜单与恢复按钮，动作带齐原把与版本', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  const empty = openRecordPage();
  assert.equal(empty.data.recentAttempt, null, '这条线还没有已提交把次时不显示操作区');

  const saved = saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? '第三把改成先挂左脚' : ''
  );

  // T045：结果按钮在普通文档流里，下面直接是本场本线把次；现场不再有独立跳转。
  const wxml = fs.readFileSync(RECORD_WXML, 'utf8');
  const sendButton = wxml.indexOf('class="result-button result-send"');
  const attemptsStart = wxml.indexOf('id="record-attempts"');
  assert.ok(sendButton !== -1 && attemptsStart !== -1);
  assert.ok(sendButton < attemptsStart, '本场本线把次在结果按钮之后（同一屏里紧跟结果区）');
  assert.equal(wxml.indexOf('id="record-links"'), -1, '现场入口区已移除');
  assert.doesNotMatch(wxml, /id="route-photo-card"/, '单线页不再铺照片卡');

  // T050 返工：最新一把右侧只有一个文字「撤销」，按一下直接撤回这一把；现场没有
  // 「更多」菜单、行内更正或撤销后的「恢复」按钮。动作带齐原把次、归属与渲染时的版本。
  assert.match(
    wxml,
    /id="record-attempt-withdraw-\{\{item\.id\}\}"[\s\S]{0,600}catchtap="undoLatestAttempt"/
  );
  assert.match(
    wxml,
    /id="record-attempt-withdraw-\{\{item\.id\}\}"[\s\S]{0,600}data-attempt-id="\{\{item\.id\}\}"[\s\S]{0,260}data-archive-id="\{\{item\.archiveId\}\}"[\s\S]{0,260}data-expected="\{\{item\.expected\}\}"[\s\S]{0,120}data-expected-rev="\{\{item\.expectedRev\}\}"[\s\S]{0,120}catchtap="undoLatestAttempt"/
  );
  assert.doesNotMatch(wxml, /record-attempt-more|toggleLatestMenu|menuOpen/, '不再有「更多」菜单');
  assert.doesNotMatch(wxml, /correct-attempt-|bindtap="correctSend"/, '不再有更正入口');
  assert.doesNotMatch(wxml, /restore-attempt-|bindtap="restoreLatestAttempt"/, '不再有恢复按钮');
  assert.doesNotMatch(
    wxml,
    /record-attempt-correct-slot|record-attempt-hint-slot/,
    '不再留纠错槽'
  );
  // 最新与旧把统一走同一个「备注」入口。
  assert.match(wxml, /catchtap="openNoteEditor"[\s\S]{0,80}\{\{item\.noteActionText\}\} ›/);

  // 命中区固定：撤销 44×44；结果按钮与文字按钮的 44px 底限仍与这一行一致。
  const wxss = fs.readFileSync(RECORD_WXSS, 'utf8');
  assert.match(wxss, /\.record-attempt-withdraw \{[^}]*min-height:\s*44px/, '「撤销」44px 命中区');
  assert.match(wxss, /\.record-attempt-withdraw \{[^}]*min-width:\s*44px/, '「撤销」44px 命中宽度');
  const buttonRule = wxss.match(
    /\.primary-button,\s*\.secondary-button,\s*\.text-button\s*\{[^}]*\}/
  );
  assert.ok(buttonRule && /min-height:\s*44px/.test(buttonRule[0]), '文字按钮的 44px 底限与这一行一致');
  assert.equal(
    /record-attempt-more|record-attempt-menu-item|record-attempt-correct/.test(wxss),
    false,
    '菜单与更正样式已移除'
  );

  const handlers = new Set(handlersIn(wxml));
  for (const required of ['undoLatestAttempt', 'openNoteEditor']) {
    assert.ok(handlers.has(required), '单线页应绑定：' + required);
    assert.equal(typeof recordDefinition[required], 'function', required + ' 必须有页面方法');
  }
  assert.equal(handlers.has('toggleLatestMenu'), false, '现场不再绑定菜单');
  assert.equal(handlers.has('restoreLatestAttempt'), false, '现场不再绑定恢复');
  // 档案层的恢复能力仍保留在共用实现里（现场不渲染入口）。
  assert.equal(typeof recordDefinition.restoreLatestAttempt, 'function');

  const page = openRecordPage();
  const row = rowOf(page);
  assert.equal(row.attemptId, saved[2].id, '目标是当前线路最新那一把的稳定 ID');
  assert.equal(row.routeId, seeded.route.id);
  assert.equal(row.sessionId, seeded.session.id);
  assert.equal(row.titleText, '刚才 · T033 A 线 第 3 把 · 未完成');
  assert.match(row.metaText, /岩馆 T033/, '写明当前场次与岩馆');
  assert.equal(row.expected, 'effective', '撤销按钮带着渲染这一行时的预期状态');
  assert.equal(row.canUndo, true);
  assert.equal(row.canRestore, false);
  assert.equal(page.data.attemptCards[0].showWithdraw, true, '最新一把渲染出「撤销」');
  assert.equal(page.data.attemptCards[0].undoText, '撤销');
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(page.data.attempts.length, 3);
});

test('T033 在最近一行撤回回到 2、同处主动恢复回到 3：ID、原序号、结果与备注不变，第 2 把不被顶替', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  const saved = saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? '第三把改成先挂左脚' : ''
  );
  const page = openRecordPage();
  const before = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };

  // 撤回：3→2。逐把列表与把数同步，原把次仍在档案里，只多一个撤回标记。
  const undoRow = rowOf(page);
  page.undoLatestAttempt(attemptRowEvent(undoRow));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(page.data.attempts.length, 2);
  assert.deepEqual(
    page.data.attempts.map(item => item.label),
    ['第 1 把', '第 2 把']
  );

  const persisted = savedAttempts(seeded.session.id, seeded.route.id);
  assert.equal(persisted.length, 3, '撤回不是删除：原记录仍在档案里');
  const thirdAfter = persisted.find(item => item.id === saved[2].id);
  assert.ok(thirdAfter.undoneAt, '第 3 把带上了撤回标记');
  assert.deepEqual(
    {
      id: thirdAfter.id,
      seq: thirdAfter.seq,
      sessionId: thirdAfter.sessionId,
      routeId: thirdAfter.routeId,
      result: thirdAfter.result,
      note: thirdAfter.note,
      createdAt: thirdAfter.createdAt
    },
    {
      id: saved[2].id,
      seq: saved[2].seq,
      sessionId: saved[2].sessionId,
      routeId: saved[2].routeId,
      result: saved[2].result,
      note: saved[2].note,
      createdAt: saved[2].createdAt
    }
  );
  const secondUntouched = persisted.find(item => item.id === saved[1].id);
  assert.equal(secondUntouched.undoneAt, undefined, '撤回没有落到第 2 把上');
  assert.equal(secondUntouched.result, 'fail');
  assert.equal(archiveOf().attempts.length, before.attempts, '撤回不新增也不删除把次');
  assert.equal(archiveOf().routes.length, before.routes);
  assert.equal(archiveOf().sessionRoutes.length, before.links);

  // 撤回后这一行留在原处：同一个原序号「第 3 把」，撤回按钮不再渲染、恢复按钮出现。
  const afterUndo = rowOf(page);
  assert.equal(afterUndo.attemptId, saved[2].id, '目标仍是原来那一把，不是第 2 把');
  assert.equal(afterUndo.titleText, '已撤回 · T033 A 线 第 3 把 · 未完成');
  assert.equal(afterUndo.canUndo, false, '撤回按钮收起，位置留空');
  assert.equal(afterUndo.canRestore, true);
  assert.equal(afterUndo.expected, 'undone', '恢复按钮带着已撤回的预期状态');
  assert.equal(afterUndo.restoreText, '恢复这一把');
  assert.equal(afterUndo.stateText, '已撤回这一把 · 本场 2 把');

  // 原坐标再点一次（画面还没重绘时落下来的同一次点击）：只刷新，不再产生一次撤回。
  const writesAfterUndo = fault.setCount;
  page.undoLatestAttempt(attemptRowEvent(undoRow));
  assert.equal(fault.setCount, writesAfterUndo, '原坐标重复点击不产生第二次撤回');
  // T050 返工：同一原按钮的重放不再进共用实现，保留「已撤销第 3 把」。
  assert.equal(page.data.notice, '已撤销第 3 把');
  assert.equal(rowOf(page).attemptId, saved[2].id);
  assert.equal(savedAttempts(seeded.session.id, seeded.route.id).filter(item => item.undoneAt).length, 1);

  // 在同一操作区主动点「恢复这一把」：2→3，原把次逐项回到原样。
  const restoreRow = rowOf(page);
  page.restoreLatestAttempt(attemptRowEvent(restoreRow));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(page.data.attempts.length, 3);
  assert.deepEqual(
    page.data.attempts.map(item => item.label),
    ['第 1 把', '第 2 把', '第 3 把']
  );
  assert.equal(page.data.attempts[2].note, '第三把改成先挂左脚', '备注跟着原把次回来');

  const restored = savedAttempts(seeded.session.id, seeded.route.id).find(
    item => item.id === saved[2].id
  );
  assert.equal(restored.undoneAt, undefined, '撤回标记已清掉');
  assert.equal(restored.note, '第三把改成先挂左脚');
  assert.equal(restored.seq, saved[2].seq);
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === saved[1].id).undoneAt,
    undefined,
    '恢复目标没有悄悄换成第 2 把'
  );

  const afterRestore = rowOf(page);
  assert.equal(afterRestore.attemptId, saved[2].id);
  assert.equal(afterRestore.titleText, '刚才 · T033 A 线 第 3 把 · 未完成');
  assert.equal(afterRestore.canUndo, true);
  assert.equal(afterRestore.canRestore, false);
  assert.equal(afterRestore.stateText, '已恢复这一把 · 本场 3 把');

  // 恢复的原坐标再点一次同样只刷新。
  const writesAfterRestore = fault.setCount;
  page.restoreLatestAttempt(attemptRowEvent(restoreRow));
  assert.equal(fault.setCount, writesAfterRestore, '原坐标重复点击不产生第二次恢复');
  assert.match(page.data.notice, /已经在本场里/);
  assert.equal(page.data.routeCountText, '3 把');
});

test('T033 切到 B 再切回、退出重开后 A 的撤回状态与恢复目标仍在；同序号的 B 不被旧按钮事件改到', () => {
  const a = seedTraining({ gymName: '岩馆 T033', routeName: 'A 线' });
  const b = store.createRoute({
    sessionId: a.session.id,
    name: 'B 线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(b.ok, true, b.error);

  const aSaved = saveAttemptSeries(a.session, a.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? 'A 的第三把' : ''
  );
  const bSaved = saveAttemptSeries(a.session, b.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? 'B 的第三把' : ''
  );

  let page = openRecordPage();
  assert.equal(page.data.selectedRoute.id, b.route.id, '默认选中最后建的 B');
  assert.equal(rowOf(page).attemptId, bSaved[2].id, 'B 有自己的最近一把');

  // 走真实入口切到 A（回列表再点 A），撤回 A 的第 3 把。
  page = switchRecordTo(a.route.id, a.session.id);
  assert.equal(page.data.selectedRoute.id, a.route.id);
  const aRow = rowOf(page);
  assert.equal(aRow.attemptId, aSaved[2].id);
  assert.equal(aRow.titleText, '刚才 · A 线 第 3 把 · 未完成');
  page.undoLatestAttempt(attemptRowEvent(aRow));
  assert.equal(page.data.routeCountText, '2 把');

  // 切到 B：B 的最近一把仍是有效状态，把数还是 3。
  page = switchRecordTo(b.route.id, a.session.id);
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(rowOf(page).attemptId, bSaved[2].id);
  assert.equal(rowOf(page).canUndo, true);

  // 切回 A：撤回状态与恢复目标都从档案里读回来。
  page = switchRecordTo(a.route.id, a.session.id);
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(rowOf(page).attemptId, aSaved[2].id);
  assert.equal(rowOf(page).titleText, '已撤回 · A 线 第 3 把 · 未完成');
  assert.equal(rowOf(page).canRestore, true);

  // A、B 的第 3 把是同一天同一场次里的同序号把次：A 那一行过期的点击参数晚到时，
  // 不能落到 B 的同序号把次上。
  const writesBefore = fault.setCount;
  page.undoLatestAttempt(
    attemptRowEvent({
      attemptId: aSaved[2].id,
      routeId: a.route.id,
      sessionId: a.session.id,
      expected: 'effective'
    })
  );
  assert.equal(fault.setCount, writesBefore, '过期的点击不写盘');
  const bThird = savedAttempts(a.session.id, b.route.id).find(item => item.id === bSaved[2].id);
  assert.equal(bThird.undoneAt, undefined, 'B 的同序号把次没有被改到');
  assert.equal(bThird.note, 'B 的第三把');
  assert.equal(savedAttempts(a.session.id, b.route.id).filter(item => item.undoneAt).length, 0);

  // 补备注仍指向原记录（明细页）：B 的第一把还是写到自己身上，同线其他把次不被串改。
  const bAttemptsPage = openAttemptsFor(a.session.id, b.route.id);
  bAttemptsPage.openNoteEditor(tapDataset({ attemptId: bSaved[0].id }));
  bAttemptsPage.onNoteInput({ detail: { value: 'B 第一把的备注' } });
  bAttemptsPage.saveNote();
  assert.equal(
    savedAttempts(a.session.id, b.route.id).find(item => item.id === bSaved[0].id).note,
    'B 第一把的备注'
  );
  assert.equal(
    savedAttempts(a.session.id, b.route.id).find(item => item.id === bSaved[2].id).note,
    'B 的第三把'
  );

  // 切回 A：当前线是持久化的，退出重开时按它恢复。
  page = switchRecordTo(a.route.id, a.session.id);
  assert.equal(archiveOf().activeRouteId, a.route.id);

  // 退出重开：新实例读同一份档案，仍停在持久化的当前线 A 上，撤回状态与恢复目标可见。
  const reopened = openRecordPage();
  assert.equal(reopened.data.selectedRoute.id, a.route.id, '当前线是持久化的 A');
  assert.equal(reopened.data.routeCountText, '2 把');
  assert.equal(reopened.data.attempts.length, 2);
  assert.equal(rowOf(reopened).attemptId, aSaved[2].id);
  assert.equal(rowOf(reopened).titleText, '已撤回 · A 线 第 3 把 · 未完成');
  assert.equal(rowOf(reopened).canRestore, true, '重开后恢复目标仍在原处');
  assert.equal(rowOf(reopened).stateText, '', '重开后不再显示只在本页的那句确认');

  // 重开后恢复：回到 3，B 与照片索引都不受影响。
  const photoBefore = storage.get(PHOTO_KEY);
  reopened.restoreLatestAttempt(attemptRowEvent(rowOf(reopened)));
  assert.equal(reopened.data.routeCountText, '3 把');
  assert.equal(reopened.data.attempts.length, 3);
  assert.equal(storage.get(PHOTO_KEY), photoBefore, '线路照片索引不动');
  assert.equal(
    savedAttempts(a.session.id, b.route.id).find(item => item.id === bSaved[2].id).undoneAt,
    undefined
  );
});

test('T033 撤回写盘失败显示失败与原操作重试，把数只按已落盘状态显示；待保存的一把不当作可撤回项', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  const saved = saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail']);
  const third = saved[2];
  const page = openRecordPage();

  // 第一段就失败：不落任何数据，把数与逐把列表保持已落盘的样子，原动作留下可重试。
  armSetFailAt(1);
  page.undoLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.match(page.data.storageError, /保存本机训练档案失败/);
  // T050 返工：现场提示与实际控件「重试撤销」用同一个名字。
  assert.match(page.data.notice, /重试撤销/);
  assert.doesNotMatch(page.data.notice, /重试撤回这一把/);
  assert.equal(page.data.routeCountText, '3 把', '没有落盘就不减把数');
  assert.equal(page.data.attempts.length, 3);
  assert.equal(rowOf(page).attemptId, third.id);
  assert.equal(rowOf(page).canUndo, true);
  assert.equal(page.data.attemptCards[0].undoText, '重试撤销');
  assert.match(rowOf(page).stateText, /^撤回未保存/);
  assert.equal(archiveOf().pendingUndos.length, 0, '第一段失败不留进行中标记');
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).filter(item => item.undoneAt).length,
    0
  );

  // 按原动作重试：沿用同一个 opId，只产生一次撤回。
  armSetFailAt(0);
  page.undoLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.routeCountText, '2 把');
  assert.equal(rowOf(page).canRestore, true);
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === third.id).settledOps
      .length,
    1,
    '同一意图只结清一次'
  );
  assert.equal(archiveOf().pendingUndos.length, 0);

  // 第二段写成后回执丢失：页面只拿到失败，档案里其实已经撤回。页面这时重新读一次
  // 落盘状态再显示——把数是确认过的持久数量（2 把），不留会重复写入的「重试撤回」入口。
  assert.equal(
    store.restoreAttempt(third.id, {
      opId: 'restore-before-loss',
      routeId: seeded.route.id,
      sessionId: seeded.session.id
    }).code,
    'restored'
  );
  const pageAgain = openRecordPage();
  assert.equal(pageAgain.data.routeCountText, '3 把');
  assert.equal(rowOf(pageAgain).attemptId, third.id);

  armSetLoseResponseAt(2);
  pageAgain.undoLatestAttempt(attemptRowEvent(rowOf(pageAgain)));
  assert.equal(pageAgain.data.storageError, '', '回执丢失不当作未保存：先按落盘状态核对');
  assert.match(pageAgain.data.notice, /回执丢失|已经落盘/);
  assert.equal(pageAgain.data.routeCountText, '2 把', '把数显示的是这次重新读到的已落盘状态');
  assert.equal(rowOf(pageAgain).canUndo, false);
  assert.equal(rowOf(pageAgain).canRestore, true, '恢复入口仍落在原来那一把上');
  assert.ok(
    JSON.parse(storage.get(ARCHIVE_KEY)).attempts.find(item => item.id === third.id).undoneAt,
    '回执丢失的这一次其实已经落盘'
  );

  const settledBefore = savedAttempts(seeded.session.id, seeded.route.id).find(
    item => item.id === third.id
  ).settledOps.length;
  armSetLoseResponseAt(0);
  const writesBeforeRetry = fault.setCount;
  pageAgain.undoLatestAttempt(attemptRowEvent(rowOf(pageAgain)));
  assert.equal(fault.setCount, writesBeforeRetry, '已经是要的状态：不再写第二次');
  assert.equal(pageAgain.data.storageError, '');
  assert.equal(pageAgain.data.routeCountText, '2 把');
  assert.equal(rowOf(pageAgain).canRestore, true);
  assert.match(pageAgain.data.notice, /已经撤回/);
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === third.id).settledOps
      .length,
    settledBefore,
    '迟到的重试没有结清第二次'
  );

  // 待保存的一把不当作已保存可撤回项：这条线有未落盘的把次时整个操作区收起。
  const pagePending = openRecordPage();
  pagePending.restoreLatestAttempt(attemptRowEvent(rowOf(pagePending)));
  assert.equal(pagePending.data.routeCountText, '3 把');
  const staleRow = rowOf(pagePending);
  assert.equal(staleRow.attemptId, third.id);
  assert.equal(staleRow.canUndo, true, '前置：这时第 3 把是可撤回的');

  armSetLoseResponseAt(1);
  pagePending.recordAttempt(tapResult('fail'));
  assert.equal(pagePending.data.hasPending, true);
  assert.equal(rowOf(pagePending), null, '有未落盘把次时撤回区收起');
  assert.equal(pagePending.data.resultLocked, true);
  assert.equal(pagePending.data.routeCountText, '3 把 · 1 把待保存');

  // 这时拿旧那一行的点击参数来点：不落盘，只说明先在「待保存」行重试。
  const writesBeforePending = fault.setCount;
  pagePending.undoLatestAttempt(attemptRowEvent(staleRow));
  assert.equal(fault.setCount, writesBeforePending, '有待保存把次时不撤回上一条已保存把次');
  assert.match(pagePending.data.notice, /还有一把没保存/);
  assert.equal(rowOf(pagePending), null);
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).filter(item => item.undoneAt).length,
    0,
    '第 3 把没有被撤回'
  );
});

test('T033 抱石唯一完攀撤回后结果按钮可用、恢复后再次锁定；绳线继续记，更正结果仍计一把', async () => {
  const boulder = seedTraining({ gymName: '岩馆 T033', routeName: '抱石线' });
  const send = saveAttemptSeries(boulder.session, boulder.route, ['send'])[0];

  const page = openRecordPage();
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.recentAttempt.canUndo, true, '抱石已完攀时仍能找到撤回');
  assert.equal(rowOf(page).titleText, '刚才 · 抱石线 第 1 把 · 完攀');
  assert.equal(rowOf(page).correctable, true, '抱石完攀旁给出「更正结果」');

  // 撤回唯一一次完攀：结果按钮重新可用，这一行留在原处变成可恢复。
  page.undoLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.resultLocked, false, '撤回后结果按钮可用');
  assert.equal(page.data.routeStateText, '');
  assert.equal(page.data.routeCountText, '0 把');
  assert.equal(rowOf(page).canRestore, true);
  assert.equal(rowOf(page).titleText, '已撤回 · 抱石线 第 1 把 · 完攀');
  assert.equal(rowOf(page).correctable, false, '已撤回的把次不在有效集合里');
  assert.equal(rowOf(page).correctIdleText, '已撤回，暂不可改', '固定槽原位只留提示');

  // 恢复同一把：重新锁定，恢复不会凑出第二次有效完攀。
  page.restoreLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeStateText, '已完攀');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(rowOf(page).canRestore, false);
  assert.equal(rowOf(page).correctable, true, '恢复后更正入口回到原位');

  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.routeCountText, '1 把', '已完攀的抱石不再新增把次');
  assert.match(page.data.notice, /已完攀/);
  assert.equal(
    savedAttempts(boulder.session.id, boulder.route.id).filter(
      item => item.result === 'send' && !item.undoneAt
    ).length,
    1
  );

  // 最近一把旁的「更正结果」保留：只翻这一把的结果，把数不变。
  await page.correctSend(
    tapDataset({
      attemptId: send.id,
      routeId: boulder.route.id,
      sessionId: boulder.session.id,
      archiveId: archiveOf().archiveId
    })
  );
  assert.equal(page.data.routeCountText, '1 把', '更正仍计一把');
  assert.equal(page.data.attempts[0].resultText, '未完成');
  assert.equal(page.data.routeCompleted, false);
  assert.equal(savedAttempts(boulder.session.id, boulder.route.id).length, 1, '更正不新增也不删除把次');
  assert.equal(savedAttempts(boulder.session.id, boulder.route.id)[0].id, send.id);

  // 绳线（顶绳/先锋）可重复完攀：撤回与恢复只改把数。
  const rope = store.createRoute({
    sessionId: boulder.session.id,
    name: '顶绳线',
    climbType: '顶绳',
    grade: '5.10a',
    colorName: '红色'
  });
  assert.equal(rope.ok, true, rope.error);
  const ropePage = openRecordFor(rope.route.id, boulder.session.id);
  tick();
  ropePage.recordAttempt(tapResult('send'));
  tick();
  ropePage.recordAttempt(tapResult('send'));
  assert.equal(ropePage.data.routeCountText, '2 把');
  assert.equal(rowOf(ropePage).titleText, '刚才 · 顶绳线 第 2 把 · 完攀');
  assert.equal(rowOf(ropePage).correctionSupported, false, '绳线不提供更正结果');
  ropePage.undoLatestAttempt(attemptRowEvent(rowOf(ropePage)));
  assert.equal(ropePage.data.routeCountText, '1 把');
  assert.equal(ropePage.data.routeCompleted, false, '绳线不锁完攀入口，仍可继续记');
  assert.equal(ropePage.data.resultLocked, false);
  assert.equal(
    store.routeCompletion(archiveOf(), rope.route.id).sendCount,
    1,
    '绳线的完攀把数跟着撤回一起减'
  );
  assert.equal(rowOf(ropePage).canRestore, true);
  ropePage.restoreLatestAttempt(attemptRowEvent(rowOf(ropePage)));
  assert.equal(ropePage.data.routeCountText, '2 把');
});

test('T033 过时画面的点击不落盘：这一次动作带的是渲染时的预期状态', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  const saved = saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail']);
  const page = openRecordPage();
  assert.equal(rowOf(page).canUndo, true, '前置：这一行现在给的是「撤回这一把」');

  // 这一把在别处已经被恢复过一次（页面手上的还是「已撤回」那一份画面）：
  // 带下来的预期状态与最新档案不符，撤回不落盘。
  const writesBefore = fault.setCount;
  page.undoLatestAttempt(
    attemptRowEvent({
      attemptId: saved[2].id,
      routeId: seeded.route.id,
      sessionId: seeded.session.id,
      expected: 'undone'
    })
  );
  assert.equal(fault.setCount, writesBefore, '过时画面的点击不写盘');
  assert.match(page.data.notice, /状态已经变了/);
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === saved[2].id)
      .undoneAt,
    undefined
  );

  // 这一把在别处被撤回过之后，页面上那份「有效」的画面再点撤回：页面先按最新档案
  // 认出已经是要的状态，不写盘，只说明下一步。
  assert.equal(store.undoAttempt(saved[2].id, { opId: 'other-instance-undo' }).code, 'undone');
  const writesBeforeAgain = fault.setCount;
  page.undoLatestAttempt(
    attemptRowEvent({
      attemptId: saved[2].id,
      routeId: seeded.route.id,
      sessionId: seeded.session.id,
      expected: 'effective'
    })
  );
  assert.equal(fault.setCount, writesBeforeAgain, '别处已经撤回过：这次点击不写盘');
  assert.match(page.data.notice, /已经撤回/);
  assert.equal(page.data.routeCountText, '2 把');

  // 再走这一行自己的恢复入口（带的是已撤回的预期状态）：恢复正常落盘一次，回到 3。
  page.restoreLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(fault.setCount, writesBeforeAgain + 2, '恢复按两段写落盘一次');
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(
    savedAttempts(seeded.session.id, seeded.route.id).find(item => item.id === saved[2].id).undoneAt,
    undefined
  );
});

test('T033 撤回与恢复只写训练档案键，不动照片索引与想爬清单', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? '第三把' : ''
  );
  const photoBlob = JSON.stringify({ version: 1, photos: [{ routeId: seeded.route.id }] });
  storage.set(PHOTO_KEY, photoBlob);
  const wishlistBlob = JSON.stringify({ version: 1, items: [] });
  storage.set('climbingNote.training.v1.wishlist', wishlistBlob);

  const page = openRecordPage();
  page.undoLatestAttempt(attemptRowEvent(rowOf(page)));
  page.restoreLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(page.data.routeCountText, '3 把');
  assert.equal(storage.get(PHOTO_KEY), photoBlob, '照片索引保持原字节');
  assert.equal(storage.get('climbingNote.training.v1.wishlist'), wishlistBlob, '想爬清单不动');
});

test('T033 恢复的第二段写成后回执丢失：页面重读落盘状态，按确认过的把数与恢复目标显示', () => {
  const seeded = seedTraining({ gymName: '岩馆 T033', routeName: 'T033 A 线' });
  const only = saveAttemptSeries(seeded.session, seeded.route, ['fail'])[0];
  const page = openRecordPage();
  page.undoLatestAttempt(attemptRowEvent(rowOf(page)));
  assert.equal(page.data.routeCountText, '0 把');

  const cooled = openRecordPage();
  assert.equal(rowOf(cooled).canRestore, true, '前置：这一行现在给的是「恢复这一把」');
  armSetLoseResponseAt(2);
  cooled.restoreLatestAttempt(attemptRowEvent(rowOf(cooled)));
  assert.equal(cooled.data.storageError, '', '回执丢失不报未保存：先按落盘状态核对');
  assert.match(cooled.data.notice, /回执丢失|已经落盘/);
  assert.equal(cooled.data.routeCountText, '1 把', '把数就是重新读到的、确认过的持久数量');
  assert.equal(cooled.data.attempts.length, 1);
  assert.equal(rowOf(cooled).canUndo, true);
  assert.equal(rowOf(cooled).canRestore, false);

  // 重开一次：读数与刚才那一份完全一致（各读端同一个口径）。
  const reopened = openRecordPage();
  assert.equal(reopened.data.routeCountText, '1 把');
  assert.equal(rowOf(reopened).attemptId, only.id);
  assert.equal(rowOf(reopened).canUndo, true);
});

// ------------------------------------------------------------------ *
// T048 单线逐把紧凑布局：最新一把完整卡，较早把次收成短行
// ------------------------------------------------------------------ *

/** 短行 / 收起事件：带渲染时这一把的原把次 ID 与本页归属。 */
function attemptRowToggleEvent(row, archive, sessionId, routeId) {
  return tapDataset({
    attemptId: row.id || row.attemptId,
    archiveId: archive.archiveId,
    sessionId,
    routeId
  });
}

test('T048 原序号倒序：最新一把完整卡，较早把次默认短行，结果、时间与备注逐把对应', () => {
  const seeded = seedTraining({ gymName: '岩馆 T048', routeName: 'T048 A 线' });
  const longNote = '第三把右脚先踩高，左手换到外侧后再把身体往墙里收，最后一步不要急着伸手。';
  const saved = saveAttemptSeries(seeded.session, seeded.route, ['fail', 'fail', 'fail'], index =>
    index === 2 ? longNote : '第' + (index + 1) + '把现场备注'
  );

  const page = openRecordPage();
  const cards = page.data.attemptCards;
  assert.equal(cards.length, 3);
  assert.deepEqual(
    cards.map(row => row.id),
    [saved[2].id, saved[1].id, saved[0].id],
    '按原序号倒序，最新在前'
  );
  assert.deepEqual(cards.map(row => row.label), ['第 3 把', '第 2 把', '第 1 把']);

  // 最新一把：结果、时间与一行备注完整展示；始终展开，没有收起态。
  assert.equal(cards[0].isLatest, true);
  assert.equal(cards[0].expanded, true);
  assert.equal(cards[0].canToggle, false);
  assert.equal(cards[0].resultText, '未完成');
  assert.equal(cards[0].isSend, false);
  assert.ok(cards[0].timeText, '最新一把带时间');
  assert.equal(cards[0].note, longNote, '备注原文保留，单行摘要由样式负责');
  assert.equal(cards[0].hasNote, true);

  // 较早两把：紧凑短行，保留原编号、结果、时间与备注，默认不展开。
  for (const row of cards.slice(1)) {
    assert.equal(row.isLatest, false);
    assert.equal(row.expanded, false);
    assert.equal(row.canToggle, true);
    assert.equal(row.resultText, '未完成');
    assert.ok(row.timeText, '短行仍带时间');
    assert.ok(row.note, '原备注跟着原把次');
  }
  assert.equal(page.data.expandedAttemptId, '', '打开页面时只有最新一把完整展示');
  assert.equal(page.data.routeCountText, '3 把', '把数口径不变');
});

test('T048 点旧行只展开原把：切换与收起不写盘，最新一把仍完整，过期行事件不改层级', () => {
  const seeded = seedTraining({ gymName: '岩馆 T048', routeName: 'T048 B 线' });
  const saved = saveAttemptSeries(
    seeded.session,
    seeded.route,
    ['fail', 'fail', 'fail'],
    index => '第' + (index + 1) + '把备注'
  );
  const archive = archiveOf();
  const page = openRecordPage();
  const bytesBefore = storage.get(ARCHIVE_KEY);
  const rowOfId = id => page.data.attemptCards.find(row => row.id === id);

  // 展开第 1 把：只这一把展开，第 2 把仍是短行，最新一把保持完整。
  page.toggleAttemptRow(attemptRowToggleEvent(saved[0], archive, seeded.session.id, seeded.route.id));
  assert.equal(page.data.expandedAttemptId, saved[0].id);
  assert.equal(rowOfId(saved[0].id).expanded, true);
  assert.equal(rowOfId(saved[0].id).canEditNote, true, '展开后保留原按把备注入口');
  assert.equal(rowOfId(saved[0].id).note, '第1把备注', '展开后看到这一把的原文');
  assert.equal(rowOfId(saved[1].id).expanded, false);
  assert.equal(rowOfId(saved[2].id).expanded, true, '最新一把始终完整展示');
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '展开不写盘');

  // 点第 2 把：展开态切到所点的那一把，同一时刻只有一把旧行展开。
  page.toggleAttemptRow(attemptRowToggleEvent(saved[1], archive, seeded.session.id, seeded.route.id));
  assert.equal(page.data.expandedAttemptId, saved[1].id);
  assert.equal(rowOfId(saved[0].id).expanded, false);
  assert.equal(rowOfId(saved[1].id).expanded, true);

  // 再点同一把：收起，回到只有最新一把完整的初始层级。
  page.toggleAttemptRow(attemptRowToggleEvent(saved[1], archive, seeded.session.id, seeded.route.id));
  assert.equal(page.data.expandedAttemptId, '');
  assert.equal(rowOfId(saved[1].id).expanded, false);
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '收起也不写盘');

  // 最新一把没有收起态：点它的行不改层级。
  page.toggleAttemptRow(attemptRowToggleEvent(saved[2], archive, seeded.session.id, seeded.route.id));
  assert.equal(page.data.expandedAttemptId, '');
  assert.equal(rowOfId(saved[2].id).expanded, true);

  // 展开旧行后返回本页（onShow）：只是重读档案，展开态与持久字节都不变。
  page.toggleAttemptRow(attemptRowToggleEvent(saved[0], archive, seeded.session.id, seeded.route.id));
  page.onShow();
  assert.equal(page.data.expandedAttemptId, saved[0].id, '返回后仍停在原来展开的那一把');
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '返回也不写盘');
  page.toggleAttemptRow(attemptRowToggleEvent(saved[0], archive, seeded.session.id, seeded.route.id));
  assert.equal(page.data.expandedAttemptId, '');

  // 过期行事件（这一把不属于本页这一条线）：不改层级、不写盘，只提示并按最新档案刷新。
  page.toggleAttemptRow(
    tapDataset({
      attemptId: 'attempt-of-another-route',
      archiveId: archive.archiveId,
      sessionId: seeded.session.id,
      routeId: seeded.route.id
    })
  );
  assert.equal(page.data.expandedAttemptId, '', '过期行不展开别的把次');
  assert.match(page.data.notice, /已经变化|刷新/);
  assert.equal(storage.get(ARCHIVE_KEY), bytesBefore, '过期行事件一个字都不写');
  assert.equal(page.data.attemptCards.length, 3, '列表仍是原三把');
});
