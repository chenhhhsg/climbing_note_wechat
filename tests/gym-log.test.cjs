/**
 * 今日攀爬本地试用工程离线测试（G01–G09）
 *
 * 直接加载独立工程的真实页面和数据层，只替换微信本地缓存，
 * 验证场次、线路、尝试、备注与错误提示的真实数据逻辑。
 *
 * 运行：node --test tests/gym-log.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEV_PROJECT = path.join(ROOT, 'devtools', 'gym-log');
const PAGE_DIR = path.join(DEV_PROJECT, 'pages', 'today');
const PAGE_JS = path.join(PAGE_DIR, 'today.js');
const PAGE_WXML = path.join(PAGE_DIR, 'today.wxml');
const PAGE_WXSS = path.join(PAGE_DIR, 'today.wxss');
const APP_JS = path.join(DEV_PROJECT, 'app.js');
const APP_WXSS = path.join(DEV_PROJECT, 'app.wxss');
const STORE_JS = path.join(DEV_PROJECT, 'utils', 'store.js');

const ROUTE_BLUE = 'route-chalkbox-blue-dyn';
const ROUTE_BLUE_BALANCE = 'route-chalkbox-blue-balance';
const ROUTE_YELLOW = 'route-northshore-yellow-small';

const storage = new Map();
const wxLog = {
  getKeys: [],
  setKeys: [],
  setShouldThrow: false,
  setError: null
};

// ---- wx 模拟：必须在加载页面和 store 之前就绪 ----
global.wx = {
  getStorageSync(key) {
    wxLog.getKeys.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    if (wxLog.setShouldThrow) {
      throw wxLog.setError || { errMsg: 'setStorageSync:fail mock storage error' };
    }
    storage.set(key, value);
  }
};

const store = require(STORE_JS);
const STORE_KEY = store.STORE_KEY;

// 捕获原生 Page(...) 定义
let pageDefinition = null;
global.Page = definition => {
  pageDefinition = definition;
};
require(PAGE_JS);

function resetHarness() {
  storage.clear();
  wxLog.getKeys = [];
  wxLog.setKeys = [];
  wxLog.setShouldThrow = false;
  wxLog.setError = null;
}

beforeEach(resetHarness);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function createPage() {
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = function setData(patch) {
    Object.keys(patch).forEach(key => {
      const value = patch[key];
      if (key.indexOf('.') === -1) {
        this.data[key] = value;
        return;
      }
      const parts = key.split('.');
      let target = this.data;
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!target[parts[index]] || typeof target[parts[index]] !== 'object') {
          target[parts[index]] = {};
        }
        target = target[parts[index]];
      }
      target[parts[parts.length - 1]] = value;
    });
  };
  page.onLoad();
  return page;
}

function tapStart(page, gymIndex, date) {
  if (gymIndex !== undefined) {
    page.onGymChange({ detail: { value: gymIndex } });
  }
  if (date !== undefined) {
    page.onDateChange({ detail: { value: date } });
  }
  page.startSession();
}

function tapRoute(page, routeId) {
  page.selectRoute({ currentTarget: { dataset: { routeId } } });
}

function tapResult(page, result) {
  page.recordAttempt({ currentTarget: { dataset: { result } } });
}

function tapSession(page, sessionId) {
  page.switchSession({ currentTarget: { dataset: { sessionId } } });
}

function tapNote(page, attemptId) {
  page.openNoteEditor({ currentTarget: { dataset: { attemptId } } });
}

function typeNote(page, text) {
  page.onNoteInput({ detail: { value: text } });
}

function savedState() {
  const raw = storage.get(STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function localToday() {
  return store.todayLocalDate();
}

// ---- G01 ----
test('G01 首次进入默认今天，场次表单与虚构数据标识可见', () => {
  const page = createPage();

  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(page.data.formDate, localToday());
  assert.equal(page.data.formGymName, store.GYMS[0].name);
  assert.equal(page.data.sessionFormTitle, '开始今日场次');
  assert.equal(page.data.trialBadge, '本地试用 · 虚构数据');
  assert.match(page.data.trialNote, /仅保存在本机/);
  assert.equal(page.data.activeSession, null);
  assert.deepEqual(
    page.data.gyms.map(gym => gym.id),
    store.GYMS.map(gym => gym.id)
  );

  assert.deepEqual(wxLog.getKeys, [STORE_KEY], '只读取专用缓存键');
  assert.equal(wxLog.setKeys.length, 0, '首次进入不写缓存');
  assert.match(STORE_KEY, /gymLogTrial/, '缓存键必须与正式数据分开');
});

test('G01 日期按本地时间生成，不因 UTC 偏移跨天', () => {
  const midnight = new Date(2026, 10, 6, 0, 30);
  const lateNight = new Date(2026, 10, 6, 23, 30);

  assert.equal(store.formatLocalDate(midnight), '2026-11-06');
  assert.equal(store.formatLocalDate(lateNight), '2026-11-06');
  assert.equal(store.isDateString('2026-11-06'), true);
  assert.equal(store.isDateString('2026-02-30'), false);
  assert.equal(store.isDateString(''), false);
});

// ---- G02 ----
test('G02 开始场次写入专用缓存，重新进入读回同一场次与线路', () => {
  const page = createPage();
  tapStart(page);

  const session = page.data.activeSession;
  assert.ok(session);
  assert.equal(session.dateText, localToday());
  assert.equal(session.gymName, store.GYMS[0].name);
  assert.equal(session.label, '第 1 场');
  assert.equal(page.data.sessionFormVisible, false);
  assert.equal(page.data.storageError, '');

  const savedAfterStart = savedState();
  assert.equal(savedAfterStart.sessions.length, 1);
  assert.equal(savedAfterStart.activeSessionId, session.id);
  assert.equal(savedAfterStart.activeRouteId, '');
  assert.ok(wxLog.setKeys.every(key => key === STORE_KEY), '只写专用缓存键');

  assert.ok(
    page.data.routes.some(route => route.id === ROUTE_BLUE),
    '开始场次后展示该岩馆的已有线路'
  );
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);

  const reentered = createPage();
  assert.equal(reentered.data.loadError, '');
  assert.equal(reentered.data.activeSession.id, session.id);
  assert.equal(reentered.data.activeSession.dateText, localToday());
  assert.equal(reentered.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(reentered.data.sessionFormVisible, false);
});

// ---- G03 ----
test('G03 可选历史日期回放跨天，同日显式开始第二场并切换归属', () => {
  const page = createPage();
  tapStart(page, 0, '2026-10-30');
  const firstSession = page.data.activeSession.id;
  assert.equal(page.data.activeSession.dateText, '2026-10-30');

  tapRoute(page, ROUTE_BLUE);
  tapResult(page, 'fail');

  page.openSessionForm();
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(page.data.formDate, localToday(), '新场次默认本地今天');
  assert.equal(page.data.sessionFormTitle, '开始新场次');
  page.onDateChange({ detail: { value: '2026-10-30' } });
  tapStart(page);

  const secondSession = page.data.activeSession.id;
  assert.notEqual(secondSession, firstSession);
  assert.equal(page.data.activeSession.dateText, '2026-10-30');
  assert.equal(page.data.activeSession.label, '第 2 场');
  assert.deepEqual(
    page.data.sameDaySessions.map(item => item.label),
    ['第 1 场', '第 2 场']
  );
  assert.equal(page.data.selectedRoute, null, '新场次不继承上一条线路');

  tapRoute(page, ROUTE_BLUE);
  tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].resultText, '完攀');

  tapSession(page, firstSession);
  assert.equal(page.data.activeSession.id, firstSession);
  assert.equal(page.data.selectedRoute, null);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 1, '第一场的尝试只归属第一场');
  assert.equal(page.data.attempts[0].resultText, '未完成');

  tapSession(page, secondSession);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 1, '第二场的尝试只归属第二场');
  assert.equal(page.data.attempts[0].resultText, '完攀');

  const saved = savedState();
  assert.equal(saved.sessions.length, 2);
  assert.equal(saved.attempts.length, 2);
  assert.deepEqual(
    saved.sessions.map(session => session.date),
    ['2026-10-30', '2026-10-30']
  );
  assert.equal(new Set(saved.attempts.map(attempt => attempt.sessionId)).size, 2);

  const reentered = createPage();
  assert.equal(reentered.data.activeSession.id, secondSession);
  assert.equal(reentered.data.sameDaySessions.length, 2);
  assert.equal(reentered.data.sameDaySessions[1].isActive, true);
});

// ---- G03 复现（QA）----
test('G03 历史场次后显式开始新场次默认本地今天，历史场次仍可恢复', () => {
  const page = createPage();
  page.onDateChange({ detail: { value: '2020-04-02' } });
  page.startSession();
  const historySession = page.data.activeSession.id;
  assert.equal(page.data.activeSession.dateText, '2020-04-02');

  page.openSessionForm();
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(
    page.data.formDate,
    localToday(),
    '显式开始新场次默认本地今天，不沿用历史场次日期'
  );
  assert.equal(page.data.sessionFormTitle, '开始新场次');
  tapStart(page);

  assert.equal(page.data.activeSession.dateText, localToday());
  assert.notEqual(page.data.activeSession.id, historySession);
  assert.equal(page.data.allSessions.length, 2, '历史场次保留在已开始场次中');

  tapSession(page, historySession);
  assert.equal(page.data.activeSession.dateText, '2020-04-02', '历史场次可恢复');
  assert.equal(page.data.activeSession.label, '第 1 场');

  const saved = savedState();
  assert.deepEqual(
    saved.sessions.map(session => session.date),
    ['2020-04-02', localToday()]
  );
});

// ---- G04 ----
test('G04 已有线路按岩馆筛选，同色同级靠固定 ID 区分', () => {
  const page = createPage();
  tapStart(page, 0);

  assert.ok(page.data.routes.every(route => route.gymId === 'gym-chalkbox'));
  assert.ok(!page.data.routes.some(route => route.id === ROUTE_YELLOW));

  const twins = page.data.routes.filter(
    route => route.colorHex === '#2f6fe4' && route.grade === 'V3'
  );
  assert.equal(twins.length, 2, '样例包含两条同色同级线路');
  assert.notEqual(twins[0].id, twins[1].id);
  assert.notEqual(twins[0].name, twins[1].name);

  tapRoute(page, ROUTE_BLUE);
  tapResult(page, 'fail');
  tapRoute(page, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.attempts.length, 0, '同色同级的另一条线不带第一条的尝试');
  tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 1);

  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].resultText, '未完成');

  page.openSessionForm();
  page.onGymChange({ detail: { value: 1 } });
  page.onDateChange({ detail: { value: '2026-11-01' } });
  page.startSession();

  assert.ok(page.data.routes.every(route => route.gymId === 'gym-northshore'));
  assert.ok(page.data.routes.some(route => route.id === ROUTE_YELLOW));
  assert.ok(!page.data.routes.some(route => route.id === ROUTE_BLUE));
});

// ---- G05 ----
test('G05 快速新建命名线路使用固定 ID，重进可读回', () => {
  const page = createPage();
  tapStart(page, 0);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '  屋檐小点线  ' } });
  page.onQuickRouteColorChange({ detail: { value: 2 } });
  page.onQuickRouteGradeChange({ detail: { value: 4 } });
  page.createQuickRoute();

  const created = page.data.selectedRoute;
  assert.ok(created);
  assert.match(created.id, /^route-local-\d+$/, '新建线路也有稳定 ID');
  assert.equal(created.name, '屋檐小点线');
  assert.equal(created.gymId, 'gym-chalkbox');
  assert.equal(created.colorName, '黄色');
  assert.equal(created.grade, 'V4');
  assert.equal(page.data.quickRouteVisible, false);
  assert.equal(page.data.quickRouteError, '');

  tapResult(page, 'fail');

  const reentered = createPage();
  assert.equal(reentered.data.selectedRoute.id, created.id);
  assert.equal(reentered.data.selectedRoute.name, '屋檐小点线');
  assert.equal(reentered.data.selectedRoute.grade, 'V4');
  assert.equal(reentered.data.attempts.length, 1);
  assert.ok(reentered.data.routes.some(route => route.id === created.id));
});

test('G05 快速新建线路必须命名，未命名不会写入缓存', () => {
  const page = createPage();
  tapStart(page, 0);
  const routeCount = savedState().routes.length;

  page.toggleQuickRoute();
  page.createQuickRoute();

  assert.match(page.data.quickRouteError, /名字/);
  assert.equal(page.data.selectedRoute, null);
  assert.equal(savedState().routes.length, routeCount);
});

// ---- G06 ----
test('G06 两次未完成形成两条独立尝试，第二把备注单独保存并可重进读回', () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  tapResult(page, 'fail');
  tapResult(page, 'fail');

  assert.equal(page.data.attempts.length, 2);
  assert.notEqual(page.data.attempts[0].id, page.data.attempts[1].id);
  assert.deepEqual(
    page.data.attempts.map(attempt => attempt.label),
    ['第 1 把', '第 2 把']
  );
  assert.ok(page.data.attempts.every(attempt => attempt.resultText === '未完成'));
  assert.ok(page.data.attempts.every(attempt => attempt.note === ''));
  assert.equal(page.data.attemptCountText, '2 把');
  assert.equal(page.data.hasAttempts, true);

  tapNote(page, page.data.attempts[1].id);
  assert.ok(page.data.noteEditor, '补备注时显示对应线路与尝试');
  assert.equal(page.data.noteEditor.routeName, '蓝色动态线');
  assert.equal(page.data.noteEditor.attemptLabel, '第 2 把');
  assert.equal(page.data.noteEditor.resultText, '未完成');

  typeNote(page, '抓到后向右摆');
  page.saveNote();

  assert.equal(page.data.noteEditor, null);
  assert.equal(page.data.attempts[1].note, '抓到后向右摆');
  assert.equal(page.data.attempts[0].note, '');
  assert.equal(page.data.attempts[1].hasNote, true);

  const sessionId = page.data.activeSession.id;
  const reentered = createPage();
  assert.equal(reentered.data.activeSession.id, sessionId);
  assert.equal(reentered.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(reentered.data.attempts.length, 2);
  assert.equal(reentered.data.attempts[0].note, '');
  assert.equal(reentered.data.attempts[1].note, '抓到后向右摆');
  assert.equal(reentered.data.attempts[1].label, '第 2 把');
  assert.equal(reentered.data.attempts[1].resultText, '未完成');
});

// ---- G07 ----
test('G07 尝试保存失败显示可见错误，不产生幻影记录，重试后成功', () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0);

  wxLog.setShouldThrow = true;
  wxLog.setError = { errMsg: 'setStorageSync:fail exceed storage limit' };
  tapResult(page, 'fail');

  assert.match(page.data.storageError, /本地保存失败/);
  assert.match(page.data.storageError, /exceed storage limit/);
  assert.equal(page.data.attempts.length, 0, '保存失败的尝试不得显示为已记录');
  assert.equal(savedState().attempts.length, 0);

  wxLog.setShouldThrow = false;
  tapResult(page, 'fail');

  assert.equal(page.data.storageError, '');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(savedState().attempts.length, 1);
});

test('G07 开始场次保存失败时保留表单并显示错误，重试后写入', () => {
  const page = createPage();
  wxLog.setShouldThrow = true;

  page.startSession();

  assert.match(page.data.storageError, /本地保存失败/);
  assert.equal(page.data.activeSession, null);
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(storage.has(STORE_KEY), false, '保存失败时缓存保持原样');

  wxLog.setShouldThrow = false;
  page.startSession();

  assert.ok(page.data.activeSession);
  assert.equal(page.data.storageError, '');
  assert.equal(savedState().sessions.length, 1);
});

test('G07 备注保存失败保留编辑内容与原备注，重试后写入', () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  tapResult(page, 'fail');
  tapResult(page, 'fail');

  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '抓到后向右摆');
  wxLog.setShouldThrow = true;
  page.saveNote();

  assert.match(page.data.storageError, /本地保存失败/);
  assert.ok(page.data.noteEditor, '失败后编辑界面保留');
  assert.equal(page.data.noteEditor.text, '抓到后向右摆');
  assert.equal(page.data.attempts[1].note, '', '原备注不被半途覆盖');
  assert.equal(savedState().attempts[1].note, '');

  wxLog.setShouldThrow = false;
  page.saveNote();

  assert.equal(page.data.storageError, '');
  assert.equal(page.data.noteEditor, null);
  assert.equal(page.data.attempts[1].note, '抓到后向右摆');
  assert.equal(savedState().attempts[1].note, '抓到后向右摆');
});

// ---- G08 ----
test('G08 缓存损坏时显示可见错误，重置后可重新开始', () => {
  storage.set(STORE_KEY, '{not-json');

  const page = createPage();
  assert.match(page.data.loadError, /格式损坏/);
  assert.equal(page.data.sessionFormVisible, false);
  assert.equal(page.data.activeSession, null);

  page.retryLoad();
  assert.match(page.data.loadError, /格式损坏/);

  page.resetTrialData();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.sessionFormVisible, true);
  assert.equal(savedState().sessions.length, 0);

  tapStart(page);
  assert.ok(page.data.activeSession);
  assert.equal(savedState().sessions.length, 1);
});

test('G08 读取缓存抛错时显示可见错误', () => {
  const original = global.wx.getStorageSync;
  global.wx.getStorageSync = () => {
    throw { errMsg: 'getStorageSync:fail permission denied' };
  };

  let page;
  try {
    page = createPage();
  } finally {
    global.wx.getStorageSync = original;
  }

  assert.match(page.data.loadError, /读取本地试用数据失败/);
  assert.match(page.data.loadError, /permission denied/);
  assert.equal(page.data.sessionFormVisible, false);
});

// ---- G09 ----
test('G09 独立工程配置、页面绑定与视觉要求齐全', () => {
  const devProject = JSON.parse(
    read(path.join(DEV_PROJECT, 'project.config.json'))
  );
  const devApp = JSON.parse(read(path.join(DEV_PROJECT, 'app.json')));
  const rootProject = JSON.parse(read(path.join(ROOT, 'project.config.json')));
  const rootApp = JSON.parse(read(path.join(ROOT, 'app.json')));

  assert.equal(devProject.compileType, 'miniprogram');
  assert.equal(devProject.miniprogramRoot, './');
  assert.equal(devProject.libVersion, '2.25.4');
  assert.equal(devProject.appid, rootProject.appid, '试用工程复用项目可用 AppID');
  assert.equal(devProject.cloudbaseRoot, undefined, '试用工程不接云开发');
  assert.equal(devProject.cloudfunctionRoot, undefined);
  assert.deepEqual(devApp.pages, ['pages/today/today']);
  assert.equal(devApp.window.navigationBarTitleText, '今日攀爬');

  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(
      fs.existsSync(path.join(PAGE_DIR, `today.${ext}`)),
      `缺少页面文件 today.${ext}`
    );
  }

  assert.doesNotMatch(read(APP_JS), /wx\.cloud/, '启动时不应初始化云服务');
  assert.doesNotMatch(read(PAGE_JS), /wx\.cloud/, '页面不应访问云服务');
  assert.doesNotMatch(
    read(STORE_JS),
    /climbing_records|climbing_sessions|wx\.cloud/,
    '试用数据层不得读取正式记录'
  );
  assert.match(read(STORE_JS), /climbingNote\.gymLogTrial\.v1/);

  const wxml = read(PAGE_WXML);
  for (const binding of [
    'bindtap="startSession"',
    'bindtap="openSessionForm"',
    'bindtap="switchSession"',
    'bindtap="selectRoute"',
    'bindtap="recordAttempt"',
    'bindtap="openNoteEditor"',
    'bindtap="saveNote"',
    'bindtap="createQuickRoute"',
    'bindchange="onDateChange"',
    'bindchange="onGymChange"'
  ]) {
    assert.ok(wxml.includes(binding), `WXML 应包含 ${binding}`);
  }
  assert.match(wxml, /mode="date"/, '场次日期可选择');
  assert.match(wxml, /data-session-id="\{\{item\.id\}\}"/, '同日场次可选归属');
  assert.match(wxml, /data-result="fail"/);
  assert.match(wxml, /data-result="send"/);
  assert.match(wxml, /\{\{storageError\}\}/, '存储错误提示必须可见');
  assert.match(wxml, /\{\{loadError\}\}/, '读取错误提示必须可见');
  assert.match(wxml, /\{\{noteEditor\.routeName\}\}/, '补备注显示对应线路');
  assert.match(wxml, /\{\{noteEditor\.attemptLabel\}\}/, '补备注显示对应尝试');
  assert.match(wxml, /trialBadge/, '页面上有本地试用标识');
  assert.match(wxml, /class="route-swatch"/, '线路色标与名称搭配');

  const wxss = read(PAGE_WXSS) + read(APP_WXSS);
  assert.match(wxss, /font-family:[^;]*(PingFang SC|Heiti SC)/, '中文黑体');
  assert.match(wxss, /#f7f4ec/i, '粉笔白底色');
  assert.match(wxss, /#23241f/i, '炭黑文字');
  assert.match(wxss, /env\(safe-area-inset-bottom\)/, '底部安全区');
  assert.match(wxss, /\.result-button/, '结果大按钮');
  assert.match(wxss, /height:\s*116rpx/, '结果按钮拇指可及');

  for (const method of [
    'loadTrial',
    'retryLoad',
    'refreshView',
    'openSessionForm',
    'cancelSessionForm',
    'onGymChange',
    'onDateChange',
    'startSession',
    'switchSession',
    'selectRoute',
    'recordAttempt',
    'openNoteEditor',
    'onNoteInput',
    'saveNote',
    'cancelNote',
    'toggleQuickRoute',
    'onQuickRouteNameInput',
    'onQuickRouteColorChange',
    'onQuickRouteGradeChange',
    'createQuickRoute',
    'dismissStorageError',
    'resetTrialData',
    'commit'
  ]) {
    assert.equal(typeof pageDefinition[method], 'function', `${method} 应为页面方法`);
  }

  const ignore = rootProject.packOptions.ignore;
  assert.ok(
    ignore.some(item => item.type === 'folder' && item.value === 'devtools/media-check'),
    '保留既有 media-check 排除'
  );
  assert.ok(
    ignore.some(item => item.type === 'folder' && item.value === 'devtools/gym-log'),
    '正式工程打包应排除 devtools/gym-log'
  );
  assert.equal(ignore.length, 2, '根配置只追加一项打包排除');
  assert.equal(rootProject.appid, 'wx9ea86e9d7aa04c2f', 'AppID 不得变更');
  assert.equal(rootProject.cloudbaseRoot, 'cloudbase/');
  assert.equal(rootProject.cloudfunctionRoot, 'cloudfunctions/');

  assert.deepEqual(rootApp.pages, [
    'pages/index/index',
    'pages/add-record/add-record',
    'pages/record-list/record-list',
    'pages/record-detail/record-detail',
    'pages/stats/stats',
    'pages/profile/profile'
  ]);
  assert.deepEqual(
    rootApp.tabBar.list.map(item => item.pagePath),
    [
      'pages/index/index',
      'pages/record-list/record-list',
      'pages/stats/stats',
      'pages/profile/profile'
    ]
  );
  assert.doesNotMatch(JSON.stringify(rootApp), /gym-log/);
});
