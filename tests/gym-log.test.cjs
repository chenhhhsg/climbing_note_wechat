/**
 * 岩馆快速记录本地试用工程离线测试（G01–G27）
 *
 * 直接加载独立工程的两个真实页面（今日攀爬、线路详情）和数据层，
 * 只替换微信本地缓存与页面导航，验证场次、线路、尝试、备注、
 * 跨天回看、旧汇总只读样例、弱网回执丢失与幂等重试的真实数据逻辑。
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
const SERVER_JS = path.join(DEV_PROJECT, 'utils', 'trial-save-server.js');
const DETAIL_DIR = path.join(DEV_PROJECT, 'pages', 'route-detail');
const DETAIL_JS = path.join(DETAIL_DIR, 'route-detail.js');
const DETAIL_WXML = path.join(DETAIL_DIR, 'route-detail.wxml');
const DETAIL_WXSS = path.join(DETAIL_DIR, 'route-detail.wxss');

const ROUTE_BLUE = 'route-chalkbox-blue-dyn';
const ROUTE_BLUE_BALANCE = 'route-chalkbox-blue-balance';
const ROUTE_RED = 'route-chalkbox-red-overhang';
const ROUTE_YELLOW = 'route-northshore-yellow-small';
const LEGACY_ROUTE = 'route-legacy-summary-v3';

const storage = new Map();
const wxLog = {
  getKeys: [],
  setKeys: [],
  setShouldThrow: false,
  setError: null,
  failKeys: new Set(),
  navigations: []
};

// ---- wx 模拟：必须在加载页面和 store 之前就绪 ----
global.wx = {
  getStorageSync(key) {
    wxLog.getKeys.push(key);
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    wxLog.setKeys.push(key);
    if (wxLog.setShouldThrow || wxLog.failKeys.has(key)) {
      throw wxLog.setError || { errMsg: 'setStorageSync:fail mock storage error' };
    }
    storage.set(key, value);
  },
  navigateTo(options) {
    wxLog.navigations.push({ type: 'navigateTo', url: options && options.url });
  },
  navigateBack(options) {
    wxLog.navigations.push({
      type: 'navigateBack',
      delta: options && options.delta
    });
  },
  reLaunch(options) {
    wxLog.navigations.push({ type: 'reLaunch', url: options && options.url });
  }
};

const store = require(STORE_JS);
const STORE_KEY = store.STORE_KEY;
const server = require(SERVER_JS);
const LEDGER_KEY = server.LEDGER_KEY;

// 捕获原生 Page(...) 定义
let pageDefinition = null;
global.Page = definition => {
  pageDefinition = definition;
};
require(PAGE_JS);

let detailDefinition = null;
global.Page = definition => {
  detailDefinition = definition;
};
require(DETAIL_JS);

function resetHarness() {
  storage.clear();
  wxLog.getKeys = [];
  wxLog.setKeys = [];
  wxLog.setShouldThrow = false;
  wxLog.setError = null;
  wxLog.failKeys = new Set();
  wxLog.navigations = [];
}

beforeEach(resetHarness);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function attachSetData(page) {
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
}

function createPage() {
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  attachSetData(page);
  page.onLoad();
  // 离线测试默认不留出模拟网络延迟；需要观察「保存中」的用例会单独调大。
  page._saveDelayMs = 0;
  return page;
}

function createDetailPage(routeId) {
  const page = Object.create(detailDefinition);
  page.data = JSON.parse(JSON.stringify(detailDefinition.data));
  attachSetData(page);
  page.onLoad(routeId === undefined ? {} : { routeId });
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

async function tapResult(page, result) {
  await page.recordAttempt({ currentTarget: { dataset: { result } } });
}

async function retryPending(page, opId) {
  await page.retryPendingAttempt({
    currentTarget: { dataset: { opId } }
  });
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

// 模拟保存端账本与客户端状态分开读取，便于分别断言。
function ledgerState() {
  const raw = storage.get(LEDGER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function localToday() {
  return store.todayLocalDate();
}

// ---- G01 ----
test('G01 首次进入默认今天，场次表单与虚构数据标识可见', async () => {
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

  assert.deepEqual(
    wxLog.getKeys,
    [STORE_KEY, LEDGER_KEY],
    '只读取试用工程的两个专用键'
  );
  assert.ok(
    wxLog.getKeys.every(key => key.indexOf('climbingNote.gymLogTrial.') === 0),
    '缓存键必须与正式数据分开'
  );
  assert.equal(wxLog.setKeys.length, 0, '首次进入不写缓存');
  assert.match(STORE_KEY, /gymLogTrial/, '缓存键必须与正式数据分开');
});

test('G01 日期按本地时间生成，不因 UTC 偏移跨天', async () => {
  const midnight = new Date(2026, 10, 6, 0, 30);
  const lateNight = new Date(2026, 10, 6, 23, 30);

  assert.equal(store.formatLocalDate(midnight), '2026-11-06');
  assert.equal(store.formatLocalDate(lateNight), '2026-11-06');
  assert.equal(store.isDateString('2026-11-06'), true);
  assert.equal(store.isDateString('2026-02-30'), false);
  assert.equal(store.isDateString(''), false);
});

// ---- G02 ----
test('G02 开始场次写入专用缓存，重新进入读回同一场次与线路', async () => {
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
test('G03 可选历史日期回放跨天，同日显式开始第二场并切换归属', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-10-30');
  const firstSession = page.data.activeSession.id;
  assert.equal(page.data.activeSession.dateText, '2026-10-30');

  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

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
  await tapResult(page, 'send');
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
test('G03 历史场次后显式开始新场次默认本地今天，历史场次仍可恢复', async () => {
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
test('G04 已有线路按岩馆筛选，同色同级靠固定 ID 区分', async () => {
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
  await tapResult(page, 'fail');
  tapRoute(page, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.attempts.length, 0, '同色同级的另一条线不带第一条的尝试');
  await tapResult(page, 'send');
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
test('G05 快速新建命名线路使用固定 ID，重进可读回', async () => {
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

  await tapResult(page, 'fail');

  const reentered = createPage();
  assert.equal(reentered.data.selectedRoute.id, created.id);
  assert.equal(reentered.data.selectedRoute.name, '屋檐小点线');
  assert.equal(reentered.data.selectedRoute.grade, 'V4');
  assert.equal(reentered.data.attempts.length, 1);
  assert.ok(reentered.data.routes.some(route => route.id === created.id));
});

test('G05 快速新建线路必须命名，未命名不会写入缓存', async () => {
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
test('G06 两次未完成形成两条独立尝试，第二把备注单独保存并可重进读回', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');

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
test('G07 尝试保存失败显示可见错误，不产生幻影记录，重试后成功', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0);

  wxLog.setShouldThrow = true;
  wxLog.setError = { errMsg: 'setStorageSync:fail exceed storage limit' };
  await tapResult(page, 'fail');

  assert.match(page.data.storageError, /本地保存失败/);
  assert.match(page.data.storageError, /exceed storage limit/);
  assert.equal(page.data.attempts.length, 0, '保存失败的尝试不得显示为已记录');
  assert.equal(
    page.data.pendingAttempts.length,
    0,
    '连待确认都没落盘时不产生幻影行'
  );
  assert.equal(savedState().attempts.length, 0);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(ledgerState(), null, '本地待确认未落盘就不派发到保存端');

  wxLog.setShouldThrow = false;
  await tapResult(page, 'fail');

  assert.equal(page.data.storageError, '');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(savedState().attempts.length, 1);
});

test('G07 开始场次保存失败时保留表单并显示错误，重试后写入', async () => {
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

test('G07 备注保存失败保留编辑内容与原备注，重试后写入', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');

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
test('G08 缓存损坏时显示可见错误，重置后可重新开始', async () => {
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

test('G08 读取缓存抛错时显示可见错误', async () => {
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
test('G09 独立工程配置、页面绑定与视觉要求齐全', async () => {
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
  assert.deepEqual(devApp.pages, [
    'pages/today/today',
    'pages/route-detail/route-detail'
  ]);
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
    'commit',
    'onShow',
    'openRouteDetail',
    'openLegacySample'
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

// ---- G10 ----
test('G10 线路详情页已注册，今日页按稳定 ID 进入并显示线路名称、颜色与难度', async () => {
  const devApp = JSON.parse(read(path.join(DEV_PROJECT, 'app.json')));
  assert.deepEqual(devApp.pages, [
    'pages/today/today',
    'pages/route-detail/route-detail'
  ]);
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(
      fs.existsSync(path.join(DETAIL_DIR, `route-detail.${ext}`)),
      `缺少页面文件 route-detail.${ext}`
    );
  }

  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE_BALANCE);

  const before = wxLog.navigations.length;
  page.openRouteDetail({
    currentTarget: { dataset: { routeId: ROUTE_BLUE_BALANCE } }
  });
  assert.equal(wxLog.navigations.length, before + 1);
  assert.equal(wxLog.navigations[before].type, 'navigateTo');
  assert.equal(
    wxLog.navigations[before].url,
    '/pages/route-detail/route-detail?routeId=' + ROUTE_BLUE_BALANCE
  );

  const writesBefore = wxLog.setKeys.length;
  const detail = createDetailPage(ROUTE_BLUE_BALANCE);
  assert.equal(detail.data.ready, true);
  assert.equal(detail.data.loadError, '');
  assert.equal(detail.data.notFound, false);
  assert.equal(detail.data.isLegacy, false);
  assert.equal(detail.data.route.id, ROUTE_BLUE_BALANCE);
  assert.equal(detail.data.route.name, '蓝色平衡线');
  assert.equal(detail.data.route.colorName, '蓝色');
  assert.equal(detail.data.route.colorHex, '#2f6fe4');
  assert.equal(detail.data.route.grade, 'V3');
  assert.equal(detail.data.route.gymName, store.GYMS[0].name);
  assert.equal(detail.data.summaryText, '0 天 · 0 场 · 0 把');
  assert.equal(detail.data.hasAttempts, false);
  assert.equal(wxLog.setKeys.length, writesBefore, '只查看详情不写缓存');
});

// ---- G11 ----
test('G11 历史两天两场三把：第二把备注保留，今天再爬回到原线路', async () => {
  // 场景中的周四：用固定历史日期，避免与运行当天重合
  const historyDate = '2020-04-02';

  const page = createPage();
  tapStart(page, 0, historyDate);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');

  const historySessionId = page.data.activeSession.id;
  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '抓到后向右摆');
  page.saveNote();
  const noteAttemptId = page.data.attempts[1].id;

  let detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '1 天 · 1 场 · 2 把');
  assert.equal(detail.data.groups.length, 1);
  assert.equal(detail.data.groups[0].sessionId, historySessionId);
  assert.equal(detail.data.groups[0].dateText, historyDate);
  assert.equal(detail.data.groups[0].sessionLabel, '第 1 场');
  assert.deepEqual(
    detail.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['未完成', '未完成']
  );
  assert.equal(detail.data.groups[0].attempts[0].note, '');
  assert.equal(detail.data.groups[0].attempts[1].note, '抓到后向右摆');
  assert.equal(detail.data.groups[0].attempts[1].label, '第 2 把');

  // 「今天再爬」：新建今天的场次并回到原线路
  const writesBefore = wxLog.setKeys.length;
  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  assert.ok(wxLog.setKeys.length > writesBefore, '今天再爬写入当前场次');
  const nav = wxLog.navigations[wxLog.navigations.length - 1];
  assert.equal(nav.type, 'navigateBack');

  const afterRecordAgain = savedState();
  assert.equal(afterRecordAgain.sessions.length, 2);
  assert.equal(afterRecordAgain.attempts.length, 2, '今天再爬不凭空生成尝试');
  const todaySession = afterRecordAgain.sessions.find(
    session => session.id !== historySessionId
  );
  assert.ok(todaySession);
  assert.equal(todaySession.date, localToday());
  assert.equal(todaySession.gymId, 'gym-chalkbox');
  assert.equal(afterRecordAgain.activeSessionId, todaySession.id);
  assert.equal(afterRecordAgain.activeRouteId, ROUTE_BLUE);

  // 回到今日页后自动同步到今天场次与原线路，再记一次完攀
  page.onShow();
  assert.equal(page.data.activeSession.id, todaySession.id);
  assert.equal(page.data.activeSession.dateText, localToday());
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0);
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].resultText, '完攀');

  detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(detail.data.groups.length, 2);
  assert.equal(detail.data.sendCount, 1);
  assert.equal(detail.data.attemptCount, 3);

  assert.equal(detail.data.groups[0].dateText, localToday());
  assert.equal(detail.data.groups[0].sessionLabel, '第 1 场');
  assert.deepEqual(
    detail.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['完攀']
  );

  assert.equal(detail.data.groups[1].dateText, historyDate);
  assert.equal(detail.data.groups[1].sessionLabel, '第 1 场');
  assert.deepEqual(
    detail.data.groups[1].attempts.map(attempt => attempt.resultText),
    ['未完成', '未完成']
  );
  assert.equal(detail.data.groups[1].attempts[0].note, '');
  assert.equal(detail.data.groups[1].attempts[1].id, noteAttemptId);
  assert.equal(detail.data.groups[1].attempts[1].label, '第 2 把');
  assert.equal(detail.data.groups[1].attempts[1].note, '抓到后向右摆');

  assert.equal(savedState().attempts.length, 3);
});

// ---- G12 ----
test('G12 同日两个场次在详情中分开分组，归属与结果不串', async () => {
  const day = '2020-04-02';
  const page = createPage();
  tapStart(page, 0, day);
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  page.openSessionForm();
  page.onDateChange({ detail: { value: day } });
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');

  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '1 天 · 2 场 · 2 把');
  assert.equal(detail.data.groups.length, 2);
  assert.deepEqual(
    detail.data.groups.map(group => group.sessionLabel),
    ['第 2 场', '第 1 场']
  );
  assert.ok(detail.data.groups.every(group => group.dateText === day));
  assert.deepEqual(
    detail.data.groups.map(group => group.sessionId),
    [secondSessionId, firstSessionId]
  );
  assert.deepEqual(
    detail.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['完攀']
  );
  assert.deepEqual(
    detail.data.groups[1].attempts.map(attempt => attempt.resultText),
    ['未完成']
  );
});

// ---- G13 ----
test('G13 同色同级与同名线路按稳定 ID 独立统计', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  tapRoute(page, ROUTE_BLUE_BALANCE);
  await tapResult(page, 'send');
  await tapResult(page, 'fail');

  const blue = createDetailPage(ROUTE_BLUE);
  assert.equal(blue.data.route.grade, 'V3');
  assert.equal(blue.data.route.colorName, '蓝色');
  assert.equal(blue.data.attemptCount, 1);
  assert.equal(blue.data.sendCount, 0);
  assert.deepEqual(
    blue.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['未完成']
  );

  const balance = createDetailPage(ROUTE_BLUE_BALANCE);
  assert.equal(balance.data.route.grade, 'V3');
  assert.equal(balance.data.attemptCount, 2);
  assert.equal(balance.data.sendCount, 1);
  assert.deepEqual(
    balance.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['完攀', '未完成']
  );

  // 同名、同色、同级的快速新建线路也各自独立
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '同名线' } });
  page.createQuickRoute();
  const firstQuickRouteId = page.data.selectedRoute.id;
  await tapResult(page, 'fail');

  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '同名线' } });
  page.createQuickRoute();
  const secondQuickRouteId = page.data.selectedRoute.id;
  assert.notEqual(secondQuickRouteId, firstQuickRouteId);
  assert.equal(page.data.selectedRoute.name, '同名线');
  assert.equal(page.data.selectedRoute.colorName, '蓝色');
  assert.equal(page.data.selectedRoute.grade, 'V3');
  await tapResult(page, 'send');

  const quickOne = createDetailPage(firstQuickRouteId);
  assert.equal(quickOne.data.route.name, '同名线');
  assert.equal(quickOne.data.attemptCount, 1);
  assert.deepEqual(
    quickOne.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['未完成']
  );

  const quickTwo = createDetailPage(secondQuickRouteId);
  assert.equal(quickTwo.data.route.name, '同名线');
  assert.equal(quickTwo.data.attemptCount, 1);
  assert.deepEqual(
    quickTwo.data.groups[0].attempts.map(attempt => attempt.resultText),
    ['完攀']
  );
});

// ---- G14 ----
test('G14 旧汇总只读样例可读，不生成五条尝试、不计入逐次统计', async () => {
  const page = createPage();
  assert.equal(page.data.legacySample.id, LEGACY_ROUTE);
  assert.equal(page.data.legacySample.legacy.summaryText, 'V3 / 尝试 5 次 / 完成');

  const before = wxLog.navigations.length;
  page.openLegacySample();
  assert.equal(wxLog.navigations.length, before + 1);
  assert.equal(wxLog.navigations[before].type, 'navigateTo');
  assert.equal(
    wxLog.navigations[before].url,
    '/pages/route-detail/route-detail?routeId=' + LEGACY_ROUTE
  );

  const writesBefore = wxLog.setKeys.length;
  const detail = createDetailPage(LEGACY_ROUTE);
  assert.equal(detail.data.loadError, '');
  assert.equal(detail.data.isLegacy, true);
  assert.equal(detail.data.notFound, false);
  assert.equal(detail.data.route.id, LEGACY_ROUTE);
  assert.equal(detail.data.route.name, '旧汇总样例线');
  assert.equal(detail.data.route.grade, 'V3');
  assert.equal(detail.data.route.colorName, '蓝色');
  assert.equal(detail.data.legacySummary.label, '旧汇总 · 虚构只读样例');
  assert.equal(
    detail.data.legacySummary.summaryText,
    'V3 / 尝试 5 次 / 完成'
  );
  assert.match(detail.data.legacySummary.hint, /不生成 5 条逐次尝试/);
  assert.match(detail.data.legacySummary.hint, /不计入逐次统计/);
  assert.equal(detail.data.groups.length, 0);
  assert.equal(detail.data.hasAttempts, false);
  assert.equal(detail.data.attemptCount, 0);
  assert.equal(detail.data.attemptCountText, '0 把');
  assert.equal(detail.data.summaryText, '0 天 · 0 场 · 0 把');
  assert.equal(wxLog.setKeys.length, writesBefore, '查看旧汇总不写缓存');

  // 只读样例没有「今天再爬」写入口；误触发也不产生场次或五条尝试
  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  assert.equal(wxLog.setKeys.length, writesBefore);
  assert.equal(storage.has(STORE_KEY), false);
  assert.equal(savedState(), null);
  assert.equal(detail.data.attemptCount, 0);
  assert.equal(detail.data.groups.length, 0);
});

// ---- G15 ----
test('G15 详情页读取损坏缓存、找不到线路与保存失败均可见且可恢复', async () => {
  storage.set(STORE_KEY, '{not-json');
  const broken = createDetailPage(ROUTE_BLUE);
  assert.match(broken.data.loadError, /格式损坏/);
  assert.equal(broken.data.route, null);
  assert.equal(broken.data.groups.length, 0);

  storage.clear();
  const missing = createDetailPage('route-does-not-exist');
  assert.equal(missing.data.loadError, '');
  assert.equal(missing.data.notFound, true);
  assert.equal(missing.data.route, null);

  const noId = createDetailPage();
  assert.equal(noId.data.notFound, true);

  const page = createPage();
  tapStart(page, 0, '2020-04-02');
  tapRoute(page, ROUTE_BLUE);

  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '0 天 · 0 场 · 0 把');

  wxLog.setShouldThrow = true;
  wxLog.setError = { errMsg: 'setStorageSync:fail quota exceeded' };
  detail.recordAgain();
  assert.match(detail.data.storageError, /本地保存失败/);
  assert.match(detail.data.storageError, /quota exceeded/);
  assert.equal(savedState().sessions.length, 1, '保存失败时不新建场次');
  assert.equal(
    wxLog.navigations.filter(item => item.type === 'navigateBack').length,
    0,
    '保存失败时不离开详情页'
  );

  detail.dismissStorageError();
  assert.equal(detail.data.storageError, '');

  wxLog.setShouldThrow = false;
  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  assert.equal(savedState().sessions.length, 2);
  assert.equal(
    wxLog.navigations.filter(item => item.type === 'navigateBack').length,
    1
  );
});

// ---- G16 ----
test('G16 详情页 WXML 绑定、跨天分组与视觉要求齐全', async () => {
  const detailJson = JSON.parse(read(path.join(DETAIL_DIR, 'route-detail.json')));
  assert.equal(detailJson.navigationBarTitleText, '线路详情');

  const todayWxml = read(PAGE_WXML);
  for (const binding of [
    'bindtap="openRouteDetail"',
    'catchtap="openRouteDetail"',
    'bindtap="openLegacySample"'
  ]) {
    assert.ok(todayWxml.includes(binding), `今日页应包含 ${binding}`);
  }
  assert.match(todayWxml, /\{\{legacySample\.legacy\.summaryText\}\}/);

  const wxml = read(DETAIL_WXML);
  for (const binding of [
    'bindtap="recordAgain"',
    'bindtap="chooseSessionForAgain"',
    'bindtap="cancelSessionPicker"',
    'bindtap="retryLoad"',
    'bindtap="goBackToToday"',
    'bindtap="dismissStorageError"'
  ]) {
    assert.ok(wxml.includes(binding), `详情页应包含 ${binding}`);
  }
  for (const binding of [
    '{{item.dateText}}',
    '{{item.sessionLabel}}',
    '{{attempt.resultText}}',
    '{{attempt.note}}',
    '{{summaryText}}',
    '{{route.colorHex}}',
    '{{route.name}}',
    '{{route.grade}}',
    '{{legacySummary.label}}',
    '{{legacySummary.summaryText}}',
    '{{legacySummary.hint}}'
  ]) {
    assert.ok(wxml.includes(binding), `详情页应显示 ${binding}`);
  }
  assert.ok(wxml.includes('旧汇总'), '旧汇总必须明确标注');
  assert.ok(
    wxml.includes('wx:if="{{!isLegacy && route}}"'),
    '旧汇总只读样例不显示「今天再爬」'
  );
  assert.match(wxml, /wx:if="\{\{sessionPicker\}\}"/, '同日多场显示选择面板');
  assert.ok(wxml.includes('{{sessionPicker.dateText}}'), '选择面板显示日期');
  assert.ok(wxml.includes('{{sessionPicker.gymName}}'), '选择面板显示岩馆');
  assert.ok(wxml.includes('{{item.label}}'), '选择面板显示场次编号');
  assert.ok(wxml.includes('{{item.timeText}}'), '选择面板显示场次时刻');
  assert.ok(wxml.includes('{{item.isCurrent}}'), '选择面板标出当前场次');
  assert.ok(wxml.includes('当前'), '当前场次有可辨认文字');
  assert.ok(
    wxml.includes('取消，保持当前场次'),
    '取消入口明确说明不改变归属'
  );

  const wxss = read(DETAIL_WXSS) + read(APP_WXSS);
  assert.match(wxss, /font-family:[^;]*(PingFang SC|Heiti SC)/, '中文黑体');
  assert.match(wxss, /#f7f4ec/i, '粉笔白底色');
  assert.match(wxss, /#23241f/i, '炭黑文字');
  assert.match(wxss, /env\(safe-area-inset-bottom\)/, '底部安全区');
  assert.match(wxss, /\.record-again-button/, '主要操作「今天再爬」');
  assert.match(wxss, /height:\s*116rpx/, '主按钮拇指可及');

  for (const method of [
    'load',
    'retryLoad',
    'refreshView',
    'recordAgain',
    'chooseSessionForAgain',
    'cancelSessionPicker',
    'goBackToToday',
    'dismissStorageError'
  ]) {
    assert.equal(
      typeof detailDefinition[method],
      'function',
      `${method} 应为详情页方法`
    );
  }
});

// ---- G17 ----
test('G17 重新进入后新建线路仍有有效稳定 ID，旧缓存从中断的序号恢复', async () => {
  const first = createPage();
  tapStart(first, 0);
  first.toggleQuickRoute();
  first.onQuickRouteNameInput({ detail: { value: '第一条自建线' } });
  first.createQuickRoute();
  const firstId = first.data.selectedRoute.id;
  assert.match(firstId, /^route-local-\d+$/);
  assert.equal(typeof savedState().nextRouteSeq, 'number');
  assert.ok(savedState().nextRouteSeq > 0, '线路序号必须是有效数字');

  const reentered = createPage();
  assert.equal(reentered.data.loadError, '');
  reentered.toggleQuickRoute();
  reentered.onQuickRouteNameInput({ detail: { value: '第二条自建线' } });
  reentered.createQuickRoute();
  const secondId = reentered.data.selectedRoute.id;
  assert.match(secondId, /^route-local-\d+$/, '重新进入后仍生成数字 ID');
  assert.notEqual(secondId, firstId);

  const saved = savedState();
  assert.equal(typeof saved.nextRouteSeq, 'number');
  assert.ok(saved.nextRouteSeq > 0);
  const ids = saved.routes.map(route => route.id);
  assert.equal(new Set(ids).size, ids.length, '线路 ID 不重复');
  assert.equal(createPage().data.loadError, '', '再次进入不应判定缓存损坏');

  const detail = createDetailPage(secondId);
  assert.equal(detail.data.notFound, false);
  assert.equal(detail.data.route.name, '第二条自建线');

  // 模拟旧缓存：自建线路没有 seq，计数曾被序列化为 null
  const legacy = store.createInitialState();
  legacy.routes.push({
    id: 'route-local-1',
    gymId: 'gym-chalkbox',
    name: '旧自建线',
    colorName: '蓝色',
    colorHex: '#2f6fe4',
    grade: 'V3'
  });
  legacy.nextRouteSeq = null;
  const normalized = store.normalizeState(legacy);
  assert.ok(normalized, '旧缓存结构仍应可读');
  assert.equal(normalized.nextRouteSeq, 2, '从 route-local-1 恢复下一个序号');
  assert.equal(typeof normalized.nextSessionSeq, 'number');
  assert.equal(typeof normalized.nextAttemptSeq, 'number');
});

// ---- G18（QA 复现）----
test('G18 同日两场从详情「今天再爬」先显式选场，取消或选当前场次不改归属', async () => {
  const page = createPage();
  tapStart(page, 0);
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  page.openSessionForm();
  tapStart(page, 0);
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');

  // QA 复现起点：同一岩馆今天已有两场，当前明确选中第 1 场
  tapSession(page, firstSessionId);
  assert.equal(page.data.activeSession.id, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  const writesBefore = wxLog.setKeys.length;
  const navBefore = wxLog.navigations.length;

  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '1 天 · 2 场 · 3 把');

  detail.recordAgain();

  assert.ok(detail.data.sessionPicker, '同日多场必须显示场次选择');
  assert.equal(detail.data.sessionPicker.sessions.length, 2);
  assert.deepEqual(
    detail.data.sessionPicker.sessions.map(item => item.label),
    ['第 1 场', '第 2 场'],
    '场次选项带可辨认编号'
  );
  assert.deepEqual(
    detail.data.sessionPicker.sessions.map(item => item.id),
    [firstSessionId, secondSessionId]
  );
  assert.equal(
    detail.data.sessionPicker.sessions[0].isCurrent,
    true,
    '当前场次必须有明确标记'
  );
  assert.equal(detail.data.sessionPicker.sessions[1].isCurrent, false);
  assert.ok(
    detail.data.sessionPicker.sessions.every(item =>
      /^\d{2}:\d{2}$/.test(item.timeText)
    ),
    '场次选项带开始时刻'
  );
  assert.equal(detail.data.sessionPicker.dateText, localToday());
  assert.equal(detail.data.sessionPicker.gymName, store.GYMS[0].name);
  assert.equal(detail.data.storageError, '');
  assert.equal(wxLog.setKeys.length, writesBefore, '未选场前不写缓存');
  assert.equal(wxLog.navigations.length, navBefore, '未选场前不返回');
  assert.equal(
    savedState().activeSessionId,
    firstSessionId,
    '不能静默切到第 2 场'
  );

  // 取消：保持原场次、原线路和详情数据
  detail.cancelSessionPicker();
  assert.equal(detail.data.sessionPicker, null);
  assert.equal(wxLog.setKeys.length, writesBefore, '取消不写缓存');
  assert.equal(wxLog.navigations.length, navBefore, '取消不返回');
  assert.equal(savedState().activeSessionId, firstSessionId);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);
  assert.equal(savedState().attempts.length, 3, '取消不改动尝试');
  assert.equal(detail.data.summaryText, '1 天 · 2 场 · 3 把', '详情数据保持原样');

  // 明确选中当前场次：不改归属，但按用户选择返回今日页
  detail.recordAgain();
  detail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: firstSessionId } }
  });
  assert.equal(detail.data.sessionPicker, null);
  assert.equal(detail.data.storageError, '');
  assert.equal(savedState().activeSessionId, firstSessionId);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);
  assert.equal(savedState().attempts.length, 3);
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  // 明确选中另一场：切换归属后返回，尝试归属不串
  const nextDetail = createDetailPage(ROUTE_BLUE);
  nextDetail.recordAgain();
  assert.ok(nextDetail.data.sessionPicker);
  nextDetail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });
  assert.equal(nextDetail.data.sessionPicker, null);
  assert.equal(savedState().activeSessionId, secondSessionId);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);
  assert.equal(savedState().attempts.length, 3, '切场次不复制或删除尝试');
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  page.onShow();
  assert.equal(page.data.activeSession.id, secondSessionId);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 1, '第 2 场只显示自己的尝试');
  assert.equal(page.data.attempts[0].resultText, '完攀');
});

// ---- G19 ----
test('G19 今天同岩馆只有一场直接复用；其他岩馆同日场次不算匹配', async () => {
  const page = createPage();
  tapStart(page, 0);
  const chalkboxSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 同日再开另一岩馆场次：今天共有两场，但该线路所属岩馆只有一场
  page.openSessionForm();
  page.onGymChange({ detail: { value: 1 } });
  tapStart(page, 1);
  const northshoreSessionId = page.data.activeSession.id;
  assert.notEqual(northshoreSessionId, chalkboxSessionId);
  assert.equal(page.data.activeSession.gymName, store.GYMS[1].name);

  const detail = createDetailPage(ROUTE_BLUE);
  detail.recordAgain();

  assert.equal(detail.data.sessionPicker, null, '该岩馆只有一场，不弹选择');
  let saved = savedState();
  assert.equal(saved.sessions.length, 2, '只有一场时复用，不新建');
  assert.equal(saved.activeSessionId, chalkboxSessionId, '复用粉笔盒的场次');
  assert.equal(saved.activeRouteId, ROUTE_BLUE);
  assert.equal(saved.attempts.length, 1);
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  // 全新缓存：今天没有该岩馆场次，只有另一岩馆场次时仍新建
  resetHarness();
  const fresh = createPage();
  tapStart(fresh, 1);
  const freshNorthshoreId = fresh.data.activeSession.id;

  const freshDetail = createDetailPage(ROUTE_BLUE);
  freshDetail.recordAgain();

  assert.equal(freshDetail.data.sessionPicker, null);
  saved = savedState();
  assert.equal(saved.sessions.length, 2);
  const created = saved.sessions.find(
    session => session.id !== freshNorthshoreId
  );
  assert.ok(created);
  assert.equal(created.gymId, 'gym-chalkbox', '为线路所属岩馆新建');
  assert.equal(created.date, localToday());
  assert.equal(saved.activeSessionId, created.id);
  assert.equal(saved.activeRouteId, ROUTE_BLUE);
});

// ---- G20 ----
test('G20 同日多场选中后保存失败：提示可见、不切换不返回，重试成功', async () => {
  const page = createPage();
  tapStart(page, 0);
  const firstSessionId = page.data.activeSession.id;

  page.openSessionForm();
  tapStart(page, 0);
  const secondSessionId = page.data.activeSession.id;
  tapSession(page, firstSessionId);

  const detail = createDetailPage(ROUTE_BLUE);
  detail.recordAgain();
  assert.ok(detail.data.sessionPicker);

  const navBefore = wxLog.navigations.length;
  wxLog.setShouldThrow = true;
  wxLog.setError = { errMsg: 'setStorageSync:fail quota exceeded' };

  detail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });

  assert.match(detail.data.storageError, /本地保存失败/);
  assert.match(detail.data.storageError, /quota exceeded/);
  assert.ok(detail.data.sessionPicker, '保存失败保留场次选择');
  assert.equal(wxLog.navigations.length, navBefore, '保存失败不返回');
  assert.equal(
    savedState().activeSessionId,
    firstSessionId,
    '保存失败不切换当前场次'
  );

  wxLog.setShouldThrow = false;
  detail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });

  assert.equal(detail.data.storageError, '');
  assert.equal(detail.data.sessionPicker, null);
  assert.equal(savedState().activeSessionId, secondSessionId);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );
});

// ---- G21 ----
test('G21 回执丢失：账本已入账、待确认保留，重试复用同一 ID 不重复', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);

  assert.equal(page.data.faultInjectionArmed, false);
  page.toggleReceiptLossArm();
  assert.equal(page.data.faultInjectionArmed, true);
  assert.equal(page.data.faultInjectionError, '');
  assert.equal(ledgerState().loseNextReceipt, true);

  await tapResult(page, 'fail');
  const opId = page.data.pendingAttempts[0] && page.data.pendingAttempts[0].opId;
  assert.ok(opId);

  // 页面计数：待确认不计入已保存
  assert.equal(page.data.attempts.length, 0);
  assert.equal(page.data.pendingAttempts.length, 1);
  assert.equal(page.data.hasPending, true);
  assert.equal(page.data.attemptCountText, '0 把');
  assert.equal(page.data.pendingCountText, '1 把待确认');
  assert.equal(page.data.routeCountText, '0 把 · 1 把待确认');
  assert.equal(page.data.pendingAttempts[0].resultText, '未完成');
  assert.equal(page.data.pendingAttempts[0].label, '第 1 把');
  assert.match(page.data.pendingAttempts[0].timeText, /^\d{2}:\d{2}$/);
  assert.match(page.data.pendingAttempts[0].statusText, /保存失败/);
  assert.match(page.data.pendingAttempts[0].statusText, /回执丢失/);
  assert.match(page.data.saveNotice, /回执丢失/);
  assert.equal(page.data.savingOpId, '');

  // 故障注入只作用于这一次保存
  assert.equal(page.data.faultInjectionArmed, false);
  assert.equal(ledgerState().loseNextReceipt, false);

  // 持久账本：保存端已入账一条
  assert.equal(ledgerState().records.length, 1);
  assert.equal(ledgerState().records[0].opId, opId);
  assert.equal(ledgerState().records[0].result, 'fail');
  assert.equal(ledgerState().records[0].sessionId, savedState().activeSessionId);
  assert.equal(ledgerState().records[0].routeId, ROUTE_BLUE);

  // 客户端待确认状态单独持久化
  assert.equal(savedState().attempts.length, 0);
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(savedState().pendingSaves[0].opId, opId);
  assert.equal(savedState().pendingSaves[0].seq, 1);
  assert.equal(savedState().nextAttemptSeq, 2);

  // 在该行重试：同一操作 ID，账本不新增
  await retryPending(page, opId);

  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.hasPending, false);
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].id, opId, '重试复用同一 ID');
  assert.equal(page.data.attempts[0].label, '第 1 把');
  assert.equal(page.data.attempts[0].resultText, '未完成');
  assert.equal(page.data.attemptCountText, '1 把');
  assert.equal(page.data.routeCountText, '1 把');
  assert.equal(page.data.saveNotice, '');
  assert.equal(ledgerState().records.length, 1, '同一操作 ID 只入账一次');
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().attempts[0].id, opId);

  // 成功后再点结果：新操作 ID、新尝试
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 2);
  assert.equal(savedState().attempts.length, 2);
  assert.equal(ledgerState().records.length, 2);
  assert.notEqual(page.data.attempts[1].id, opId);
  assert.equal(page.data.attemptCountText, '2 把');
  assert.equal(new Set(ledgerState().records.map(record => record.opId)).size, 2);
});

// ---- G22 ----
test('G22 保存中不可重复派发；页面重进与并发重试同一操作都不重复', async () => {
  const page = createPage();
  page._saveDelayMs = 40;
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  page.toggleReceiptLossArm();

  const originalSubmit = server.submitOperation;
  let submitCalls = 0;
  server.submitOperation = operation => {
    submitCalls += 1;
    return originalSubmit(operation);
  };

  try {
    const first = page.recordAttempt({
      currentTarget: { dataset: { result: 'fail' } }
    });
    const opId = page.data.pendingAttempts[0].opId;

    // 保存中：行可见，同一行的重复点击不会发第二个请求
    assert.equal(page.data.savingOpId, opId);
    assert.equal(page.data.pendingAttempts[0].isSaving, true);
    assert.equal(page.data.pendingAttempts[0].canRetry, false);
    assert.match(page.data.pendingAttempts[0].statusText, /保存中/);

    await page.retryPendingAttempt({
      currentTarget: { dataset: { opId } }
    });
    assert.equal(submitCalls, 0, '保存中不得重复派发同一次');
    assert.equal(page.data.savingOpId, opId, '重复点击不改变进行中的操作');

    await first;
    assert.equal(submitCalls, 1);
    assert.equal(page.data.savingOpId, '');
    assert.equal(page.data.pendingAttempts.length, 1);
    assert.match(page.data.pendingAttempts[0].statusText, /回执丢失/);
    assert.equal(ledgerState().records.length, 1);

    // 页面重进后待确认行仍在，重试不重复入账
    const reentered = createPage();
    assert.equal(reentered.data.pendingAttempts.length, 1);
    assert.equal(reentered.data.pendingAttempts[0].opId, opId);
    assert.equal(reentered.data.pendingAttempts[0].label, '第 1 把');
    assert.equal(reentered.data.pendingAttempts[0].resultText, '未完成');
    assert.match(reentered.data.pendingAttempts[0].timeText, /^\d{2}:\d{2}$/);
    assert.equal(reentered.data.attempts.length, 0);
    assert.equal(reentered.data.attemptCountText, '0 把');
    assert.equal(reentered.data.pendingCountText, '1 把待确认');
    await retryPending(reentered, opId);
    assert.equal(reentered.data.attempts.length, 1);
    assert.equal(reentered.data.attempts[0].id, opId);
    assert.equal(ledgerState().records.length, 1, '页面重进后重试不重复入账');
    assert.equal(savedState().pendingSaves.length, 0);

    // 再制造一条回执丢失，两个页面实例并发重试同一操作
    const writer = createPage();
    writer._saveDelayMs = 0;
    writer.toggleReceiptLossArm();
    await tapResult(writer, 'send');
    const secondOpId = writer.data.pendingAttempts[0].opId;
    assert.ok(secondOpId);
    assert.notEqual(secondOpId, opId);
    assert.equal(ledgerState().records.length, 2);

    const pageA = createPage();
    const pageB = createPage();
    pageA._saveDelayMs = 20;
    pageB._saveDelayMs = 20;
    await Promise.all([
      pageA.retryPendingAttempt({
        currentTarget: { dataset: { opId: secondOpId } }
      }),
      pageB.retryPendingAttempt({
        currentTarget: { dataset: { opId: secondOpId } }
      })
    ]);

    assert.equal(
      ledgerState().records.filter(record => record.opId === secondOpId).length,
      1,
      '并发重试同一操作只入账一次'
    );
    assert.equal(pageA.data.attempts.filter(item => item.id === secondOpId).length, 1);
    assert.equal(pageB.data.attempts.filter(item => item.id === secondOpId).length, 1);

    const finalState = savedState();
    assert.equal(finalState.pendingSaves.length, 0);
    assert.equal(finalState.attempts.length, 2);
    assert.equal(
      finalState.attempts.filter(item => item.id === secondOpId).length,
      1
    );
  } finally {
    server.submitOperation = originalSubmit;
  }
});

// ---- G23 ----
test('G23 周四两把＋周日一把：故障注入第二把，重试后仍三把且备注正确', async () => {
  const historyDate = '2020-04-02';
  const page = createPage();
  tapStart(page, 0, historyDate);
  const historySessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  assert.equal(page.data.attempts.length, 1);

  page.toggleReceiptLossArm();
  await tapResult(page, 'fail');
  const secondOpId = page.data.pendingAttempts[0].opId;
  assert.ok(secondOpId);
  assert.equal(page.data.attempts.length, 1, '第二把确认前不计入已保存');
  assert.equal(page.data.pendingAttempts.length, 1);
  assert.equal(ledgerState().records.length, 2);
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().pendingSaves.length, 1);

  // 其他场次、线路不串：另开同日第二场后看不到这条待确认
  page.openSessionForm();
  page.onDateChange({ detail: { value: historyDate } });
  tapStart(page, 0);
  const otherSessionId = page.data.activeSession.id;
  assert.notEqual(otherSessionId, historySessionId);
  assert.equal(page.data.pendingAttempts.length, 0, '待确认不串到其他场次');
  assert.equal(page.data.attempts.length, 0);

  tapRoute(page, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.pendingAttempts.length, 0, '待确认不串到其他线路');
  assert.equal(page.data.hasPending, false);

  // 回到原场次原线路，待确认仍在
  tapSession(page, historySessionId);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.pendingAttempts.length, 1);
  assert.equal(page.data.pendingAttempts[0].opId, secondOpId);

  // 重试并给第二把补备注
  await retryPending(page, secondOpId);
  assert.equal(page.data.attempts.length, 2);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(ledgerState().records.length, 2, '重试不新增账本记录');
  assert.equal(page.data.attempts[1].id, secondOpId);
  assert.equal(page.data.attempts[1].label, '第 2 把');
  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '第二把换左脚');
  page.saveNote();
  assert.equal(page.data.attempts[1].note, '第二把换左脚');

  // 详情：周四一天一场两把，第二把备注保留
  let detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '1 天 · 1 场 · 2 把');
  assert.equal(detail.data.groups.length, 1);
  assert.equal(detail.data.groups[0].sessionId, historySessionId);
  assert.equal(detail.data.groups[0].attempts[1].id, secondOpId);
  assert.equal(detail.data.groups[0].attempts[1].note, '第二把换左脚');

  // 周日从历史回同一线路再记一把
  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  page.onShow();
  assert.equal(page.data.activeSession.dateText, localToday());
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0, '今天场次只显示自己的尝试');
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 1);

  detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.summaryText, '2 天 · 2 场 · 3 把');
  assert.equal(detail.data.sendCount, 1);
  assert.equal(detail.data.attemptCount, 3);
  assert.equal(detail.data.groups[1].dateText, historyDate);
  assert.equal(detail.data.groups[1].attempts[1].note, '第二把换左脚');

  // 账本、待确认状态与页面计数分别对齐
  const records = ledgerState().records;
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.opId)).size, 3);
  assert.equal(savedState().attempts.length, 3);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(new Set(savedState().attempts.map(item => item.id)).size, 3);
  assert.equal(page.data.attemptCountText, '1 把');
  assert.equal(page.data.pendingCountText, '');
});
// ---- G24 ----
test('G24 页面提供演练与重试入口，故障注入不进入正式页面', async () => {
  const wxml = read(PAGE_WXML);
  for (const binding of [
    'bindtap="toggleReceiptLossArm"',
    'bindtap="retryPendingAttempt"',
    'bindtap="dismissSaveNotice"'
  ]) {
    assert.ok(wxml.includes(binding), `今日页应包含 ${binding}`);
  }
  assert.match(wxml, /id="arm-receipt-loss"/);
  assert.match(wxml, /模拟下一次保存回执丢失/);
  assert.match(wxml, /已就绪：下一次保存会写入模拟账本/);
  assert.match(wxml, /wx:for="\{\{pendingAttempts\}\}"/);
  assert.match(wxml, /data-op-id="\{\{item\.opId\}\}"/);
  assert.match(wxml, /\{\{item\.statusText\}\}/);
  assert.match(wxml, /\{\{saveNotice\}\}/);
  assert.match(wxml, /重试保存/);
  assert.match(wxml, /\{\{faultInjectionArmed\}\}/);

  for (const method of [
    'recordAttempt',
    'dispatchPending',
    'finishDispatch',
    'retryPendingAttempt',
    'toggleReceiptLossArm',
    'refreshFaultInjection',
    'dismissSaveNotice'
  ]) {
    assert.equal(typeof pageDefinition[method], 'function', `${method} 应为页面方法`);
  }

  // 模拟保存端只写独立账本，不接云、不读正式数据
  const serverSource = read(SERVER_JS);
  assert.match(serverSource, /climbingNote\.gymLogTrial\.saveLedger\.v1/);
  assert.doesNotMatch(
    serverSource,
    /wx\.cloud|climbing_records|climbing_sessions/,
    '模拟保存端不得访问云或正式记录'
  );

  // 根工程正式页面不得出现故障注入入口或模拟账本
  const formalRoot = path.join(ROOT, 'pages');
  const formalFiles = fs
    .readdirSync(formalRoot, { recursive: true })
    .filter(entry => /\.(js|json|wxml|wxss)$/.test(entry));
  assert.ok(formalFiles.length > 0);
  for (const entry of formalFiles) {
    const source = read(path.join(formalRoot, entry));
    assert.doesNotMatch(
      source,
      /saveLedger|模拟下一次保存回执丢失|trial-save-server/,
      `正式页面 ${entry} 不得包含故障注入`
    );
  }

  // 开发者工具复现入口记录在试用工程说明里
  const readme = read(path.join(DEV_PROJECT, 'README.md'));
  assert.match(readme, /模拟下一次保存回执丢失/);
  assert.match(readme, /重试保存/);
  assert.match(readme, /climbingNote\.gymLogTrial\.saveLedger\.v1/);
});
// ---- G25 ----
test('G25 模拟保存端按操作 ID 幂等，写账本失败不消耗回执丢失注入', async () => {
  const base = {
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    result: 'fail',
    note: ''
  };

  const first = server.submitOperation({ ...base, opId: 'attempt-1' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(ledgerState().records.length, 1);

  const duplicate = server.submitOperation({ ...base, opId: 'attempt-1' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(ledgerState().records.length, 1, '同一操作 ID 只入账一次');

  const other = server.submitOperation({
    ...base,
    opId: 'attempt-2',
    result: 'send'
  });
  assert.equal(other.ok, true);
  assert.equal(ledgerState().records.length, 2);

  // 回执丢失：先入账、再返回失败；注入只用一次
  assert.equal(server.armReceiptLoss().ok, true);
  assert.equal(ledgerState().loseNextReceipt, true);
  const lost = server.submitOperation({ ...base, opId: 'attempt-3' });
  assert.equal(lost.ok, false);
  assert.equal(lost.receiptLost, true);
  assert.equal(ledgerState().records.length, 3);
  assert.equal(ledgerState().loseNextReceipt, false);

  const retried = server.submitOperation({ ...base, opId: 'attempt-3' });
  assert.equal(retried.ok, true);
  assert.equal(retried.duplicate, true);
  assert.equal(ledgerState().records.length, 3, '重试不重复入账');

  // 账本写入失败：不入账，也不消耗下一次注入
  assert.equal(server.armReceiptLoss().ok, true);
  wxLog.failKeys.add(LEDGER_KEY);
  const failed = server.submitOperation({ ...base, opId: 'attempt-4' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /模拟保存账本写入失败/);
  assert.equal(ledgerState().records.length, 3);
  assert.equal(ledgerState().loseNextReceipt, true, '写失败不消耗注入');

  wxLog.failKeys.delete(LEDGER_KEY);
  const recovered = server.submitOperation({ ...base, opId: 'attempt-4' });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.receiptLost, true);
  assert.equal(ledgerState().records.length, 4);
  assert.equal(ledgerState().loseNextReceipt, false);

  // 账本与客户端键完全分开
  assert.equal(storage.has(STORE_KEY), false);

  const invalid = server.submitOperation({
    opId: '',
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    result: 'fail'
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /操作 ID/);
});
// ---- G26 ----
test('G26 保存端已入账但本地确认写入失败：保留待确认，重试拿到重复确认', async () => {
  const page = createPage();
  page._saveDelayMs = 30;
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);

  const originalSubmit = server.submitOperation;
  let submitCalls = 0;
  server.submitOperation = operation => {
    submitCalls += 1;
    return originalSubmit(operation);
  };

  try {
    const saving = page.recordAttempt({
      currentTarget: { dataset: { result: 'fail' } }
    });
    const opId = page.data.pendingAttempts[0].opId;
    // 待确认已落盘后，只让客户端状态写入失败；模拟账本仍可写
    wxLog.failKeys.add(STORE_KEY);
    await saving;

    assert.equal(submitCalls, 1);
    assert.match(page.data.storageError, /本地保存失败/);
    assert.match(page.data.saveNotice, /保存端已确认，但本地写入失败/);
    assert.equal(page.data.attempts.length, 0, '本地未确认不得显示为已保存');
    assert.equal(page.data.pendingAttempts.length, 1);
    assert.equal(page.data.savingOpId, '');
    assert.equal(ledgerState().records.length, 1);
    assert.equal(ledgerState().records[0].opId, opId);
    assert.equal(savedState().pendingSaves.length, 1);
    assert.equal(savedState().attempts.length, 0);

    wxLog.failKeys.delete(STORE_KEY);
    await retryPending(page, opId);

    assert.equal(page.data.storageError, '');
    assert.equal(page.data.attempts.length, 1);
    assert.equal(page.data.attempts[0].id, opId);
    assert.equal(page.data.pendingAttempts.length, 0);
    assert.equal(ledgerState().records.length, 1, '重复确认不再入账');
    assert.equal(savedState().attempts.length, 1);
    assert.equal(savedState().pendingSaves.length, 0);
  } finally {
    server.submitOperation = originalSubmit;
  }
});
// ---- G27 ----
test('G27 T007 旧缓存没有 pendingSaves 字段时仍可读，不判定损坏', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 模拟 T007 写下的缓存：没有待确认数组
  const legacyCache = savedState();
  delete legacyCache.pendingSaves;
  storage.set(STORE_KEY, JSON.stringify(legacyCache));

  const reentered = createPage();
  assert.equal(reentered.data.loadError, '', '旧缓存不得判定为损坏');
  assert.equal(reentered.data.attempts.length, 1);
  assert.equal(reentered.data.attempts[0].resultText, '未完成');
  assert.equal(reentered.data.pendingAttempts.length, 0);

  // 新流程继续记录时补回待确认字段
  await tapResult(reentered, 'send');
  assert.equal(reentered.data.attempts.length, 2);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(ledgerState().records.length, 2);
});

// ---- G28 ----
test('G28 旧实例卸载后延迟回执不覆盖新实例：两把保留且序号不回退', async () => {
  const pageA = createPage();
  tapStart(pageA, 0);
  tapRoute(pageA, ROUTE_BLUE);

  // 确定性控制 A 的回执时机：先扣住定时器，等 B 完成全部操作后再放行。
  const originalSetTimeout = global.setTimeout;
  const heldTimers = [];
  let savingA;
  global.setTimeout = (fn, ms) => {
    heldTimers.push({ fn, ms });
    return heldTimers.length;
  };
  try {
    pageA._saveDelayMs = 80;
    savingA = pageA.recordAttempt({
      currentTarget: { dataset: { result: 'fail' } }
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const firstOpId = pageA.data.pendingAttempts[0].opId;
  assert.equal(firstOpId, 'attempt-1');
  assert.equal(pageA.data.savingOpId, firstOpId);
  assert.equal(pageA.data.resultLocked, true);
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(ledgerState(), null, 'A 的回执尚未到，账本还没有记录');

  // 用户离开今日页（旧实例卸载），再从缓存重进
  pageA.onUnload();
  const pageB = createPage();
  pageB._saveDelayMs = 0;
  assert.equal(pageB.data.pendingAttempts.length, 1);
  assert.equal(pageB.data.pendingAttempts[0].opId, firstOpId);
  assert.equal(pageB.data.resultLocked, true);

  // B 重试第一把成功，再正常记第二把
  await retryPending(pageB, firstOpId);
  assert.equal(ledgerState().records.length, 1);
  assert.equal(pageB.data.attempts.length, 1);
  assert.equal(pageB.data.resultLocked, false, '确认后结果按钮解锁');
  await tapResult(pageB, 'send');
  const secondOpId = pageB.data.attempts[1].id;
  assert.equal(secondOpId, 'attempt-2');
  assert.equal(pageB.data.attempts.length, 2);
  assert.equal(savedState().attempts.length, 2);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(savedState().nextAttemptSeq, 3);

  // A 的旧回执这时才返回：不得把只有一把的旧快照写回
  assert.equal(heldTimers.length, 1, '应只有 A 的延迟回执');
  heldTimers[0].fn();
  await savingA;

  const finalState = savedState();
  assert.equal(finalState.attempts.length, 2, '旧回执不得把两把变回一把');
  assert.deepEqual(
    finalState.attempts.map(item => item.id),
    [firstOpId, secondOpId]
  );
  assert.equal(finalState.pendingSaves.length, 0);
  assert.equal(finalState.nextAttemptSeq, 3, '旧回执不得让序号退回 2');
  assert.equal(ledgerState().records.length, 2);
  assert.equal(
    ledgerState().records.filter(record => record.opId === firstOpId).length,
    1,
    '旧回执按同一操作 ID 幂等'
  );
  assert.equal(pageB.data.attempts.length, 2, 'B 的页面显示不被旧实例改动');

  const reentered = createPage();
  assert.equal(reentered.data.attempts.length, 2);
  assert.equal(reentered.data.attemptCountText, '2 把');
  assert.equal(reentered.data.attempts[1].label, '第 2 把');
});

// ---- G29 ----
test('G29 隐藏旧实例延迟回执只按 opId 合并，不覆盖其他线路、备注与场次', async () => {
  const pageA = createPage();
  tapStart(pageA, 0);
  tapRoute(pageA, ROUTE_BLUE);

  const originalSetTimeout = global.setTimeout;
  const heldTimers = [];
  let savingA;
  global.setTimeout = (fn, ms) => {
    heldTimers.push({ fn, ms });
    return heldTimers.length;
  };
  try {
    pageA._saveDelayMs = 80;
    savingA = pageA.recordAttempt({
      currentTarget: { dataset: { result: 'fail' } }
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const firstOpId = pageA.data.pendingAttempts[0].opId;

  // 新实例 B 在另一条线上记录并补备注；A 的第一把还没有回执
  const pageB = createPage();
  pageB._saveDelayMs = 0;
  tapRoute(pageB, ROUTE_RED);
  await tapResult(pageB, 'send');
  const redOpId = pageB.data.attempts[0].id;
  assert.equal(redOpId, 'attempt-2');
  tapNote(pageB, redOpId);
  typeNote(pageB, '红线上右脚');
  pageB.saveNote();
  assert.equal(pageB.data.attempts[0].note, '红线上右脚');
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(savedState().activeRouteId, ROUTE_RED);

  heldTimers[0].fn();
  await savingA;

  const merged = savedState();
  assert.equal(merged.attempts.length, 2, '旧回执只补自己那一把');
  const first = merged.attempts.find(item => item.id === firstOpId);
  const red = merged.attempts.find(item => item.id === redOpId);
  assert.ok(first && red);
  assert.equal(first.result, 'fail');
  assert.equal(first.routeId, ROUTE_BLUE);
  assert.equal(red.result, 'send');
  assert.equal(red.note, '红线上右脚', '其他线路备注不被旧快照覆盖');
  assert.equal(merged.pendingSaves.length, 0);
  assert.equal(merged.nextAttemptSeq, 3);
  assert.equal(merged.activeRouteId, ROUTE_RED, '当前线路仍是新实例的选择');
  assert.equal(merged.sessions.length, 1);
  assert.equal(ledgerState().records.length, 2);

  const detailBlue = createDetailPage(ROUTE_BLUE);
  assert.equal(detailBlue.data.attemptCountText, '1 把');
});

// ---- G30 ----
test('G30 保存中进入详情再操作：详情页旧快照不复活待确认、不吞已保存尝试', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  page.toggleReceiptLossArm();
  await tapResult(page, 'fail');
  const firstOpId = page.data.pendingAttempts[0].opId;
  assert.equal(savedState().pendingSaves.length, 1);

  // 待确认时进入详情：详情页快照里只有待确认，没有已保存尝试
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.attemptCountText, '0 把');
  assert.equal(detail.data.summaryText, '0 天 · 0 场 · 0 把');

  // 回到今日页确认第一把；详情页仍持有旧快照
  await retryPending(page, firstOpId);
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().pendingSaves.length, 0);

  detail.recordAgain();
  assert.equal(detail.data.storageError, '');
  const afterAgain = savedState();
  assert.equal(afterAgain.attempts.length, 1, '详情页写回不得吞掉刚确认的一把');
  assert.equal(afterAgain.pendingSaves.length, 0, '详情页写回不得复活待确认');
  assert.equal(afterAgain.activeRouteId, ROUTE_BLUE);

  // 同日再开第二场，制造「多场选场」路径；详情页再次在保存期间打开
  page.onShow();
  page.openSessionForm();
  tapStart(page, 0);
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, 'session-1');
  tapRoute(page, ROUTE_BLUE);
  page.toggleReceiptLossArm();
  await tapResult(page, 'fail');
  const secondOpId = page.data.pendingAttempts[0].opId;

  const staleDetail = createDetailPage(ROUTE_BLUE);
  assert.equal(
    staleDetail.data.summaryText,
    '1 天 · 1 场 · 1 把',
    '待确认不计入详情'
  );

  await retryPending(page, secondOpId);
  assert.equal(savedState().attempts.length, 2);
  assert.equal(savedState().pendingSaves.length, 0);

  staleDetail.recordAgain();
  assert.ok(staleDetail.data.sessionPicker, '同日两场应让用户明确选场');
  assert.equal(staleDetail.data.sessionPicker.sessions.length, 2);
  staleDetail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });
  assert.equal(staleDetail.data.storageError, '');
  const finalState = savedState();
  assert.equal(finalState.attempts.length, 2, '选场写回不得吞掉已确认的一把');
  assert.equal(finalState.pendingSaves.length, 0, '选场写回不得复活待确认');
  assert.equal(finalState.activeSessionId, secondSessionId);
  assert.equal(finalState.activeRouteId, ROUTE_BLUE);
});

// ---- G31 ----
test('G31 前一把保存中或回执丢失时点结果不生成第二个待确认，确认后可连记', async () => {
  const page = createPage();
  page._saveDelayMs = 30;
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  page.toggleReceiptLossArm();

  const originalSubmit = server.submitOperation;
  let submitCalls = 0;
  server.submitOperation = operation => {
    submitCalls += 1;
    return originalSubmit(operation);
  };

  try {
    const saving = page.recordAttempt({
      currentTarget: { dataset: { result: 'fail' } }
    });
    const firstOpId = page.data.pendingAttempts[0].opId;
    assert.equal(page.data.savingOpId, firstOpId);
    assert.equal(page.data.resultLocked, true);
    assert.ok(page.data.resultLockHint);

    // 保存中再点「完攀」：方法兜底不生成第二个待确认，也不发第二个请求
    await tapResult(page, 'send');
    assert.equal(submitCalls, 0, '保存尚未完成，不派发新操作');
    assert.equal(page.data.pendingAttempts.length, 1);
    assert.equal(savedState().pendingSaves.length, 1);
    assert.equal(savedState().pendingSaves[0].opId, firstOpId);
    assert.equal(savedState().nextAttemptSeq, 2);
    assert.match(page.data.saveNotice, /上一把还在保存或待确认/);

    await saving;
    assert.equal(submitCalls, 1);
    assert.equal(page.data.pendingAttempts.length, 1);
    assert.match(page.data.pendingAttempts[0].statusText, /回执丢失/);
    assert.equal(page.data.resultLocked, true);

    // 回执丢失后再点结果：仍然只保留原待确认
    await tapResult(page, 'send');
    assert.equal(submitCalls, 1);
    assert.equal(page.data.pendingAttempts.length, 1);
    assert.equal(savedState().pendingSaves.length, 1);
    assert.equal(savedState().attempts.length, 0);
    assert.equal(ledgerState().records.length, 1);

    // 在原行重试确认后解锁，再点结果生成新的 ID
    await retryPending(page, firstOpId);
    assert.equal(page.data.resultLocked, false);
    assert.equal(page.data.attempts.length, 1);
    assert.equal(page.data.attempts[0].id, firstOpId);

    await tapResult(page, 'send');
    assert.equal(page.data.attempts.length, 2);
    assert.equal(page.data.attempts[1].id, 'attempt-2');
    assert.notEqual(page.data.attempts[1].id, firstOpId);
    assert.equal(page.data.resultLocked, false);
    assert.equal(ledgerState().records.length, 2);
    assert.equal(savedState().nextAttemptSeq, 3);
  } finally {
    server.submitOperation = originalSubmit;
  }

  // 界面元素：按钮 disabled 绑定与方法兜底同在；不得全页清空存储
  const wxml = read(PAGE_WXML);
  assert.match(wxml, /disabled="\{\{resultLocked\}\}"/);
  assert.match(wxml, /id="result-locked-hint"/);
  assert.equal(typeof pageDefinition.onUnload, 'function', '应处理页面卸载');
  assert.doesNotMatch(
    read(PAGE_JS) + read(DETAIL_JS),
    /clearStorageSync/,
    '试用页面不得用 clearStorageSync 清空其他业务缓存'
  );
});
