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
const DB_JS = path.join(ROOT, 'utils', 'db.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');

const ARCHIVE_KEY = 'climbingNote.training.v1.archive';

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
    'recordAttempt',
    'retryPendingAttempt',
    'openNoteEditor',
    'saveNote',
    'correctSend',
    'pickGymRoute'
  ]) {
    assert.ok(sessionHandlers.has(required), '场内页应有绑定：' + required);
  }
  for (const handler of sessionHandlers) {
    assert.equal(typeof sessionDefinition[handler], 'function', '场内页绑定缺少处理器：' + handler);
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
  assert.equal(page.data.attempts.length, 0);

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

  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.routeCompleted, false, '绳攀不进入抱石完攀关闭状态');
  assert.equal(page.data.routeRepeatable, true);
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.attempts.length, 2);
  assert.equal(store.routeCompletion(archiveOf(), seeded.route.id).sendCount, 2);

  // 换先锋线路同样可以重复完攀。
  const pioneer = store.createRoute({
    sessionId: seeded.session.id,
    name: '先锋线',
    climbType: '先锋',
    grade: '5.10a'
  });
  assert.equal(pioneer.ok, true, pioneer.error);
  const page2 = openSessionPage({});
  page2.selectRoute(tapDataset({ routeId: pioneer.route.id }));
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
  const routesStart = wxml.indexOf('id="session-routes"');
  const failButton = wxml.indexOf('class="result-button result-fail"');
  assert.ok(routesStart !== -1, '场内页应有首屏「本场线路 · 加线」区');
  assert.ok(failButton !== -1);
  assert.ok(routesStart < failButton, '加线入口在结果按钮之前，首屏就能找到');

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
    'selectRoute'
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
  assert.equal(page.data.newRoutePhoto, null);
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
  assert.match(page.data.notice, /已新建并选中/);

  tick();
  page.recordAttempt(tapResult('fail'));
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
  failedPage.retryLinkSelection(tapDataset({ routeId: old.route.id }));
  assert.equal(failedPage.data.linkRetry, null);
  assert.equal(linkCount(third.session.id, old.route.id), 1, '重试后仍只有一条关联');
  assert.equal(archiveOf().activeRouteId, old.route.id);
  assert.equal(failedPage.data.selectedRoute.id, old.route.id);
  assert.match(failedPage.data.notice, /已把「黄色平衡线」加入本场并选中/);

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

test('T031 换线区在结果按钮之前：短列表点线路名走原 selectRoute，多线时「全部 N 条」可展开收起', () => {
  const wxml = fs.readFileSync(SESSION_WXML, 'utf8');
  const switchStart = wxml.indexOf('id="route-switch"');
  const failButton = wxml.indexOf('class="result-button result-fail"');
  assert.ok(switchStart !== -1, '场内页结果按钮旁应有换线区');
  assert.ok(failButton !== -1);
  assert.ok(switchStart < failButton, '换线区在结果按钮之前，记结果前就能换线');
  assert.ok(
    wxml.indexOf('id="session-routes"') < switchStart,
    '换线区在本场记录里，页顶的本场线路列表仍保留'
  );

  // 空场没有换线区；有线时短列表直接点线路名。
  assert.match(wxml, /wx:if="\{\{routes\.length > 0\}\}"[\s\S]{0,80}id="route-switch"/);
  assert.match(wxml, /id="route-switch-\{\{item\.id\}\}"[\s\S]{0,300}bindtap="selectRoute"/);
  // 超过 3 条：短列表留「全部 N 条」（N 是真实本场关联数）。
  assert.match(wxml, /wx:if="\{\{routeSwitchHasMore\}\}"[\s\S]{0,200}id="route-switch-all"/);
  assert.match(wxml, /id="route-switch-all"[\s\S]{0,200}routeSwitchMoreText/);
  // 展开后列出本场全部线路，每条仍是同一个 selectRoute；收起不改当前线。
  assert.match(
    wxml,
    /wx:if="\{\{routeSwitchExpanded\}\}"[\s\S]{0,400}id="route-switch-row-\{\{item\.id\}\}"[\s\S]{0,200}bindtap="selectRoute"/
  );
  assert.match(wxml, /id="route-switch-close"[\s\S]{0,120}bindtap="closeRouteSwitch"/);

  const handlers = new Set(handlersIn(wxml));
  for (const required of ['selectRoute', 'expandRouteSwitch', 'closeRouteSwitch']) {
    assert.ok(handlers.has(required), '场内页应绑定：' + required);
    assert.equal(typeof sessionDefinition[required], 'function', required + ' 必须有页面方法');
  }
});

test('T031 短列表换线：同色同级 A、B 只换当前线，换线不建线不加关联，记一把与备注只落在 B', () => {
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
  assert.equal(page.data.attempts.length, 0);
  assert.equal(page.data.routeCountText, '0 把');

  // 1–3 条：短列表直接列出本场全部线路，当前线带已选态。
  assert.deepEqual(page.data.routeSwitchRows.map(row => row.id), [a.route.id, b.route.id]);
  assert.equal(page.data.routeSwitchTotal, 2);
  assert.equal(page.data.routeSwitchHasMore, false);
  assert.equal(page.data.routeSwitchRows[1].isSelected, true);

  // 点 A 的线路名：名称、等级、已选态与把数一起切到 A，且不产生线路/关联/把次。
  const before = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  page.selectRoute(tapDataset({ routeId: a.route.id }));
  assert.equal(page.data.selectedRoute.id, a.route.id);
  assert.equal(page.data.selectedRoute.name, 'A 线');
  assert.equal(page.data.selectedRoute.grade, 'V3');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].note, 'A 的备注');
  assert.equal(page.data.routeSwitchRows[0].isSelected, true);
  assert.equal(page.data.routeSwitchRows[1].isSelected, false);
  assert.equal(archiveOf().routes.length, before.routes, '选线不新建线路');
  assert.equal(archiveOf().sessionRoutes.length, before.links, '选线不新增关联');
  assert.equal(archiveOf().attempts.length, before.attempts, '选线不产生把次');

  // 回到 B 记一把并补备注：只改 B，A 的把次与备注不动。
  page.selectRoute(tapDataset({ routeId: b.route.id }));
  assert.equal(page.data.attempts.length, 0, 'B 还是空的');
  tick();
  page.recordAttempt(tapResult('fail'));
  assert.equal(page.data.attempts.length, 1);
  const bAttemptId = page.data.attempts[0].id;
  page.openNoteEditor(tapDataset({ attemptId: bAttemptId }));
  page.onNoteInput({ detail: { value: 'B 的备注' } });
  page.saveNote();

  const archive = archiveOf();
  const bAttempts = store.attemptsFor(archive, { sessionId: a.session.id, routeId: b.route.id });
  const aAttempts = store.attemptsFor(archive, { sessionId: a.session.id, routeId: a.route.id });
  assert.equal(bAttempts.length, 1);
  assert.equal(bAttempts[0].note, 'B 的备注');
  assert.equal(aAttempts.length, 1, 'A 仍只有原来那一把');
  assert.equal(aAttempts[0].note, 'A 的备注', 'A 的备注不变');

  // 回到 A：读到的仍是 A 自己的那一把。
  page.selectRoute(tapDataset({ routeId: a.route.id }));
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].note, 'A 的备注');
});

test('T031 四条以上：短列表 = 当前线 + 最多两条近期线，「全部 N 条」按本场关联计数且别的场次不出现', () => {
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

  // 回到第一场，当前线是最后建的「线 4」；按把次时间为线 2/3/4 排出近期顺序。
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
  assert.equal(page.data.routeSwitchTotal, 4);
  assert.equal(page.data.routeSwitchMoreText, '全部 4 条');
  assert.equal(page.data.routeSwitchHasMore, true);
  assert.equal(page.data.routeSwitchExpanded, false);
  // 短列表：当前线在首位，另两条是不重复的近期线路（线 3、线 2）。
  assert.deepEqual(
    page.data.routeSwitchRows.map(row => row.id),
    [routes[3].id, routes[2].id, routes[1].id]
  );
  assert.equal(page.data.routeSwitchRows[0].isSelected, true);
  assert.equal(
    new Set(page.data.routeSwitchAllRows.map(row => row.id)).size,
    4,
    '展开后的本场线路不重复'
  );
  assert.deepEqual(
    page.data.routeSwitchAllRows.map(row => row.id).sort(),
    sessionRouteIds(sessionId).sort(),
    '全部 N 条就是真实的本场关联'
  );

  // 展开：本场全部线路都可选，别的场次独有的线不出现；只切展示不写盘。
  const rawBefore = storage.get(ARCHIVE_KEY);
  page.expandRouteSwitch();
  assert.equal(page.data.routeSwitchExpanded, true);
  assert.equal(storage.get(ARCHIVE_KEY), rawBefore, '展开全部线路不写盘');
  assert.equal(archiveOf().activeRouteId, routes[3].id, '展开不改当前线');
  const allIds = page.data.routeSwitchAllRows.map(row => row.id);
  assert.equal(allIds.indexOf(otherRoute.route.id), -1, '别的场次独有的线不出现');

  // 收起：只切展示，当前线不变。
  page.closeRouteSwitch();
  assert.equal(page.data.routeSwitchExpanded, false);
  assert.equal(archiveOf().activeRouteId, routes[3].id, '收起不改当前线');
  assert.deepEqual(
    page.data.routeSwitchRows.map(row => row.id),
    [routes[3].id, routes[2].id, routes[1].id],
    '收起后仍是包含当前线的短列表'
  );

  // 在全集里点当前那一行「返回」：只收起列表，不重复写盘、不改当前线。
  page.expandRouteSwitch();
  const rawAtCurrent = storage.get(ARCHIVE_KEY);
  page.selectRoute(tapDataset({ routeId: routes[3].id }));
  assert.equal(page.data.routeSwitchExpanded, false, '点当前线回到结果按钮旁');
  assert.equal(storage.get(ARCHIVE_KEY), rawAtCurrent, '点当前线不写盘');
  assert.equal(archiveOf().activeRouteId, routes[3].id);

  // 从全集里选一条：换到它并回到短列表；不新建线路、不加关联、不产生把次。
  const counts = {
    routes: archiveOf().routes.length,
    links: archiveOf().sessionRoutes.length,
    attempts: archiveOf().attempts.length
  };
  page.expandRouteSwitch();
  page.selectRoute(tapDataset({ routeId: routes[0].id }));
  assert.equal(page.data.selectedRoute.id, routes[0].id);
  assert.equal(page.data.routeSwitchExpanded, false, '选完线回到结果按钮旁的短列表');
  assert.equal(page.data.routeSwitchRows[0].id, routes[0].id, '短列表始终含当前线');
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
    page.data.routeSwitchRows.some(row => row.id === a.route.id),
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

  // 换到 A，并把 A 加入下次想爬：换线只改当前选择，清单是另一份记录。
  store.selectRoute(a.route.id);
  const first = openSessionPage({});
  assert.equal(first.data.selectedRoute.id, a.route.id);
  first.addSelectedToWishlist();

  // 重新打开同一场次：当前线是持久化的那一条。
  const reopened = openSessionPage({});
  assert.equal(reopened.data.selectedRoute.id, a.route.id, '重开恢复持久化的当前线');
  assert.equal(reopened.data.selectedRoute.name, 'A 线');

  // 逐把记录按原把次 ID 读回，且只读当前线的。
  const expected = store.attemptsFor(archiveOf(), {
    sessionId: a.session.id,
    routeId: a.route.id
  });
  assert.deepEqual(reopened.data.attempts.map(row => row.id), expected.map(item => item.id));
  assert.equal(reopened.data.attempts[0].note, 'A 的备注');
  assert.equal(reopened.data.routeCountText, '1 把');

  // 小结与清单同样按原线路 ID 列出这条线。
  assert.equal(
    reopened.data.summaryRows.some(row => row.routeId === a.route.id),
    true,
    '小结按原线路 ID 列出当前线'
  );
  assert.equal(
    reopened.data.wishlistWanted.some(row => row.routeId === a.route.id),
    true,
    '清单按原线路 ID 列出当前线'
  );
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

// ------------------------------------------------------------------ *
// R3 逐把结果、备注与按把更正
// ------------------------------------------------------------------ *

test('R3 两把未完成只给第二把加备注，完攀收起新增入口并按把更正', () => {
  const seeded = seedTraining();
  const page = openSessionPage({});
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

  // 仅给第二把加备注：第一把不受影响。
  const firstId = page.data.attempts[0].id;
  const secondId = page.data.attempts[1].id;
  page.openNoteEditor(tapDataset({ attemptId: secondId }));
  assert.equal(page.data.noteEditor.attemptLabel, '第 2 把');
  assert.equal(page.data.noteEditor.text, '');
  page.onNoteInput({ detail: { value: '抓到后向右摆' } });
  tick();
  page.saveNote();
  assert.equal(page.data.noteEditor, null);
  assert.equal(page.data.attempts[0].note, '', '备注不能写到第一把');
  assert.equal(page.data.attempts[1].note, '抓到后向右摆');
  assert.equal(store.attemptsFor(archiveOf(), { routeId }).length, 2);

  // 再记抱石完攀：确认后收起新增结果按钮，保留按把「改为未完成」。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routeStateText, '已完攀');
  assert.equal(page.data.correctionRows.length, 1, '给出一把可更正的控件');
  const sendId = page.data.attempts[2].id;
  assert.equal(page.data.correctionRows[0].attemptId, sendId);
  assert.match(page.data.correctionRows[0].label, /第 3 把/);
  assert.match(page.data.correctionRows[0].contextText, /2026-11-09/);
  assert.match(page.data.correctionRows[0].contextText, /第 1 场/);

  // 完攀后再点结果不会新增（守卫在档案层）。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 3);

  // 改为未完成：把数不变，ID、场次、时间与备注保留。
  const sendAttemptBefore = archiveOf().attempts.find(item => item.id === sendId);
  page.correctSend(tapDataset({ attemptId: sendId, routeId, sessionId }));
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
  assert.equal(page.data.correctionRows.length, 0);

  // 更正后可以再记一次完攀：总把数加一。
  tick();
  page.recordAttempt(tapResult('send'));
  assert.equal(archiveOf().attempts.length, 4);
  assert.equal(store.routeCompletion(archiveOf(), routeId).sendCount, 1);
  assert.equal(page.data.routeCompleted, true);

  // 同一坐标再点一次（连点/双击原位置）：只重复更正同一把，另一把不被碰。
  const newestSendId = archiveOf().attempts[3].id;
  page.correctSend(tapDataset({ attemptId: newestSendId, routeId, sessionId }));
  assert.equal(archiveOf().attempts.length, 4, '连点不增把数');
  page.correctSend(tapDataset({ attemptId: newestSendId, routeId, sessionId }));
  const finalArchive = archiveOf();
  assert.equal(finalArchive.attempts.length, 4, '连点同一把仍不增把数');
  assert.equal(store.routeCompletion(finalArchive, routeId).sendCount, 0);
  assert.equal(finalArchive.pendingCorrections.length, 0);
  // 逐把结果没有被别的操作串改：两把未完成与备注仍在原位。
  assert.equal(finalArchive.attempts[0].result, 'fail');
  assert.equal(finalArchive.attempts[1].result, 'fail');
  assert.equal(finalArchive.attempts[1].note, '抓到后向右摆');
  assert.equal(finalArchive.attempts.find(item => item.id === firstId).note, '');
});

test('R3 迟到或跨线路的「改为未完成」不改动任何数据', () => {
  const seeded = seedTraining();
  const page = openSessionPage({});
  tick();
  page.recordAttempt(tapResult('send'));
  const sendId = page.data.attempts[0].id;

  // 归属不符（伪造的线路 ID）：明确拒绝，不落盘。
  page.correctSend(tapDataset({ attemptId: sendId, routeId: 'route-999' }));
  assert.equal(archiveOf().attempts[0].result, 'send');
  assert.match(page.data.notice, /不属于当前线路/);

  // 找不到的把次：提示回读，不改数据。
  page.correctSend(tapDataset({ attemptId: 'op-not-exist' }));
  assert.equal(archiveOf().attempts[0].result, 'send');
  assert.match(page.data.notice, /找不到这一把/);
});

// ------------------------------------------------------------------ *
// R5 保存边界：快速双击、本机写失败与重试、跨页面迟到操作
// ------------------------------------------------------------------ *

test('R5 同一把按钮快速双击只记一次，隔开时间可以记第二把', () => {
  seedTraining();
  const page = openSessionPage({});

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
  const page = openSessionPage({});

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
  const page = openSessionPage({});

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
  const page = openSessionPage({});
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
  const stale = openSessionPage({});
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
  const reopened = openSessionPage({});
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
  const pageA = openSessionPage({});
  // 页面 B 是另一个实例（模拟同时打开或返回后的旧快照）。
  const pageB = openSessionPage({});
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

  // 给第二把补备注后重开：线路、场次、结果与第二把备注逐项一致。
  // A 是旧快照，先按最新档案刷新（相当于用户切回本页），再给 B 记的那一把补备注。
  pageA.onShow();
  assert.equal(pageA.data.attempts.length, 2);
  const secondId = archiveOf().attempts[1].id;
  pageA.openNoteEditor(tapDataset({ attemptId: secondId }));
  assert.equal(pageA.data.noteEditor.attemptLabel, '第 2 把');
  pageA.onNoteInput({ detail: { value: '第二把备注' } });
  tick();
  pageA.saveNote();
  assert.equal(pageA.data.noteEditor, null);
  assert.equal(archiveOf().attempts[1].note, '第二把备注');

  const cold = openSessionPage({});
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

// ------------------------------------------------------------------ *
// 首页与旧云记录互不影响
// ------------------------------------------------------------------ *

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

  // 断网下仍可进入场内页继续记录。
  const page = openSessionPage({});
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
