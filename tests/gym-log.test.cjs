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
// T014：抱石首次完攀的共用规则与试用身份，与页面、账本实际使用的一致。
const routeRules = require(path.join(DEV_PROJECT, 'utils', 'route-rules.js'));
const trialProfile = require(path.join(DEV_PROJECT, 'utils', 'trial-profile.js'));

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

// 「改为未完成」按**真实渲染出来的控件**取：
// 今日页取 routeCorrectionRows（每把一行），详情页取每把记录行上的
// correctionState / correctionContext（控件就在这一把记录自己那一行）。
// 顺序与列表一致：index 0 就是最上面那个控件。
function renderedCorrectionControls(page) {
  if (Array.isArray(page.data.groups)) {
    const rows = [];
    page.data.groups.forEach(group => {
      (group.attempts || []).forEach(attempt => {
        if (!attempt.correctionState) return;
        rows.push({
          attemptId: attempt.id,
          state: attempt.correctionState,
          disabled: Boolean(attempt.correctionDisabled),
          context: attempt.correctionContext
        });
      });
    });
    return rows;
  }
  return (page.data.routeCorrectionRows || []).map(row => ({
    attemptId: row.attemptId,
    state: row.state,
    disabled: Boolean(row.disabled),
    context: row.context
  }));
}

function correctControlFor(page, attemptId) {
  return (
    renderedCorrectionControls(page).find(row => row.attemptId === attemptId) ||
    null
  );
}

function datasetOf(context) {
  return {
    attemptId: context.attemptId,
    routeId: context.routeId,
    sessionId: context.sessionId,
    generation: context.generation,
    datasetId: context.datasetId,
    ownerId: context.ownerId
  };
}

// 按 WXML 的 data-* → dataset 映射（data-attempt-id → dataset.attemptId）构造真实点按事件。
// 该位置此刻已是只读结果（或没有控件）时返回 null：这次点击不构成任何写操作。
function correctEventAt(page, index) {
  const control = renderedCorrectionControls(page)[index];
  if (!control || control.state === 'corrected' || !control.context) return null;
  return { currentTarget: { dataset: datasetOf(control.context) } };
}

function correctEvent(page, index) {
  return correctEventAt(page, index === undefined ? 0 : index);
}

// 点第 index 个真实渲染出来的控件（默认第一个）。
// 位置已变成只读结果时不做任何事——正是要回归的「同坐标第二次点击」。
async function tapCorrect(page, index) {
  const event = correctEventAt(page, index === undefined ? 0 : index);
  if (!event) return undefined;
  return page.correctSend(event);
}

// 单独点某一把自己的控件：模拟用户为「另一把」重新做出的明确选择。
async function tapCorrectFor(page, attemptId) {
  const control = correctControlFor(page, attemptId);
  if (!control || control.state === 'corrected' || !control.context) {
    return undefined;
  }
  return page.correctSend({
    currentTarget: { dataset: datasetOf(control.context) }
  });
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

// 新建一条指定类型与等级的线路并选中；不传类型/等级时沿用表单默认（抱石 V3）。
function createTypedRoute(page, name, climbType, grade) {
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: name } });
  if (climbType) {
    page.onQuickRouteTypeChange({
      detail: { value: page.data.quickRouteTypes.indexOf(climbType) }
    });
  }
  if (grade) {
    page.onQuickRouteGradeChange({
      detail: { value: page.data.quickRouteGrades.indexOf(grade) }
    });
  }
  page.createQuickRoute();
  return page.data.selectedRoute.id;
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

// 账本行数：重置后账本会被写成空账本（而非删除），空账本同样按 0 行计。
function ledgerRows() {
  const ledger = ledgerState();
  return ledger ? ledger.records.length : 0;
}

function localToday() {
  return store.todayLocalDate();
}

// 直接调用模拟保存入口时，带上与今日页实际提交一致的归属与类型上下文。
function submitContext(routeId, result, opId, extra) {
  const saved = savedState();
  return Object.assign(
    {
      opId,
      sessionId: saved ? saved.activeSessionId : 'session-1',
      routeId,
      result,
      note: '',
      climbType: '抱石',
      ownerId: trialProfile.TRIAL_OWNER_ID,
      datasetId: trialProfile.TRIAL_DATASET_ID
    },
    extra || {}
  );
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
  // 抱石默认选 V3；这里按等级取值选择 V4，不依赖选项下标。
  assert.equal(page.data.quickRouteType, '抱石');
  assert.equal(page.data.quickRouteGrade, 'V3');
  page.onQuickRouteGradeChange({
    detail: { value: page.data.quickRouteGrades.indexOf('V4') }
  });
  page.createQuickRoute();

  const created = page.data.selectedRoute;
  assert.ok(created);
  assert.match(created.id, /^route-local-\d+$/, '新建线路也有稳定 ID');
  assert.equal(created.name, '屋檐小点线');
  assert.equal(created.gymId, 'gym-chalkbox');
  assert.equal(created.climbType, '抱石');
  assert.equal(created.colorName, '黄色');
  assert.equal(created.grade, 'V4');
  assert.equal(page.data.quickRouteVisible, false);
  assert.equal(page.data.quickRouteError, '');

  await tapResult(page, 'fail');

  const reentered = createPage();
  assert.equal(reentered.data.selectedRoute.id, created.id);
  assert.equal(reentered.data.selectedRoute.name, '屋檐小点线');
  assert.equal(reentered.data.selectedRoute.climbType, '抱石');
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

  await page.resetTrialData();
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
    'bindtap="onRouteTap"',
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
    'onRouteTap',
    'recordAttempt',
    'openNoteEditor',
    'onNoteInput',
    'saveNote',
    'cancelNote',
    'toggleQuickRoute',
    'onQuickRouteNameInput',
    'onQuickRouteColorChange',
    'onQuickRouteTypeChange',
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
  for (const value of ['devtools/media-check', 'devtools/gym-log']) {
    assert.equal(
      ignore.filter(item => item.type === 'folder' && item.value === value).length,
      1,
      `根配置中 ${value} 打包排除应恰好出现一次`
    );
  }
  assert.equal(rootProject.appid, 'wx9ea86e9d7aa04c2f', 'AppID 不得变更');
  assert.equal(rootProject.cloudbaseRoot, 'cloudbase/');
  assert.equal(rootProject.cloudfunctionRoot, 'cloudfunctions/');

  // T017 起首页新增正式场内记录页；T018/T020 各再增一页；T034 再增本次小结独立页。
  // 不把正式 app.pages 自己当唯一 oracle：用获批页面白名单加源码四件套独立核对。
  const basePages = [
    'pages/index/index',
    'pages/add-record/add-record',
    'pages/record-list/record-list',
    'pages/record-detail/record-detail',
    'pages/stats/stats',
    'pages/profile/profile'
  ];
  const approvedExtraPages = [
    'pages/training-session/training-session',
    'pages/training-summary/training-summary',
    'pages/training-route/training-route',
    'pages/fitness-test/fitness-test'
  ];
  const approvedPages = new Set([...basePages, ...approvedExtraPages]);

  assert.equal(
    new Set(rootApp.pages).size,
    rootApp.pages.length,
    '正式页面不得重复注册'
  );
  for (const page of rootApp.pages) {
    assert.ok(approvedPages.has(page), `不得注册未批准的正式页面：${page}`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(
        fs.existsSync(path.join(ROOT, `${page}.${ext}`)),
        `页面源码四件套缺失：${page}.${ext}`
      );
    }
  }
  assert.deepEqual(
    rootApp.pages.filter(page => basePages.includes(page)),
    basePages,
    '原六页保留且相对顺序不变'
  );

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
  // 抱石首次完攀后不再新增，先记未完成再完攀（仍是两把、一把完攀）。
  await tapResult(page, 'fail');
  await tapResult(page, 'send');

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
    ['未完成', '完攀']
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
    wxml.includes('wx:if="{{!isLegacy && route && canRecordAgain}}"'),
    '旧汇总与已完攀线路都不显示「今天再爬」'
  );
  assert.ok(
    wxml.includes('id="detail-completed-footer"') && wxml.includes('已完攀'),
    '已完攀线路在同一页脚位置显示状态说明'
  );
  assert.ok(
    wxml.includes('bindtap="dismissRecordNotice"'),
    '已完攀的迟到操作提示可收起'
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
    'dismissStorageError',
    'dismissRecordNotice'
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
  // T015：已完攀的抱石线在详情只回看，「今天再爬」与选场流程只对仍可再记的线路开放，
  // 因此这条用例改用可重复完攀的顶绳线路，仍保持两场三把与选场归属断言不变。
  const ropeId = createTypedRoute(page, '顶绳选场线', '顶绳', '5.10a');
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');

  page.openSessionForm();
  tapStart(page, 0);
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapRoute(page, ropeId);
  await tapResult(page, 'send');

  // QA 复现起点：同一岩馆今天已有两场，当前明确选中第 1 场
  tapSession(page, firstSessionId);
  assert.equal(page.data.activeSession.id, firstSessionId);
  tapRoute(page, ropeId);

  const writesBefore = wxLog.setKeys.length;
  const navBefore = wxLog.navigations.length;

  const detail = createDetailPage(ropeId);
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
  assert.equal(savedState().activeRouteId, ropeId);
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
  assert.equal(savedState().activeRouteId, ropeId);
  assert.equal(savedState().attempts.length, 3);
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  // 明确选中另一场：切换归属后返回，尝试归属不串
  const nextDetail = createDetailPage(ropeId);
  nextDetail.recordAgain();
  assert.ok(nextDetail.data.sessionPicker);
  nextDetail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });
  assert.equal(nextDetail.data.sessionPicker, null);
  assert.equal(savedState().activeSessionId, secondSessionId);
  assert.equal(savedState().activeRouteId, ropeId);
  assert.equal(savedState().attempts.length, 3, '切场次不复制或删除尝试');
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  page.onShow();
  assert.equal(page.data.activeSession.id, secondSessionId);
  assert.equal(page.data.selectedRoute.id, ropeId);
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
  // 抱石首次完攀后不再新增把次，所以这里用虚构的顶绳线做夹具：
  // 绳攀可以重复完攀，本用例验证的是操作 ID 幂等与回执注入本身。
  const ROPE_ROUTE = 'route-fixture-rope-510a';
  const ropeState = store.createInitialState();
  ropeState.routes.push({
    id: ROPE_ROUTE,
    gymId: 'gym-chalkbox',
    name: '虚构顶绳线',
    colorName: '黄色',
    colorHex: '#d9a21b',
    grade: '5.10a',
    climbType: '顶绳'
  });
  storage.set(STORE_KEY, JSON.stringify(ropeState));

  const base = {
    sessionId: 'session-1',
    routeId: ROPE_ROUTE,
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

  // 账本与客户端键完全分开：保存端只往账本键写，不动试用数据键
  assert.ok(
    wxLog.setKeys.length > 0 && wxLog.setKeys.every(key => key === LEDGER_KEY),
    '保存端只写账本键'
  );
  assert.equal(
    savedState().routes.find(route => route.id === ROPE_ROUTE).climbType,
    '顶绳',
    '保存端不改写试用数据里的线路'
  );

  const invalid = server.submitOperation({
    opId: '',
    sessionId: 'session-1',
    routeId: ROPE_ROUTE,
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

// ---- G32 ----
test('G32 三种攀岩类型的名称与等级选项按正式等级表核对', async () => {
  const rules = require(path.join(DEV_PROJECT, 'utils', 'route-rules.js'));
  // 正式工程等级表只读参照，用来核对试用工程的取值与顺序。
  const official = require(path.join(ROOT, 'utils', 'grade.js'));

  assert.deepEqual(
    rules.CLIMB_TYPES,
    ['抱石', '顶绳', '先锋'],
    '三种类型名称与计划一致'
  );
  assert.deepEqual(
    rules.gradesForType('抱石'),
    official.vScaleGrades.map(grade => grade.value),
    '抱石的选项与顺序按正式 V 级表'
  );
  assert.deepEqual(
    rules.gradesForType('顶绳'),
    official.ydsGrades.map(grade => grade.value),
    '顶绳的选项与顺序按正式 YDS 表'
  );
  assert.deepEqual(
    rules.gradesForType('先锋'),
    official.ydsGrades.map(grade => grade.value),
    '先锋的选项与顺序按正式 YDS 表'
  );

  // 旧的固定 V0–V8 已不再是抱石的完整选项；旧值仍可读写。
  assert.ok(rules.gradesForType('抱石').includes('VB'));
  assert.ok(rules.gradesForType('抱石').includes('V16'));
  assert.equal(rules.isGradeForType('抱石', 'V0'), true);
  assert.equal(rules.isGradeForType('抱石', 'V8'), true);
  assert.equal(rules.isGradeForType('抱石', '5.10a'), false, 'V 级不含 YDS');
  assert.equal(rules.isGradeForType('顶绳', '5.10a'), true);
  assert.equal(rules.isGradeForType('先锋', '5.11b'), true);

  // 页面默认类型与等级：抱石 V3，且默认等级必须属于默认类型。
  const page = createPage();
  assert.equal(page.data.quickRouteType, '抱石');
  assert.equal(page.data.quickRouteGrade, 'V3');
  assert.deepEqual(page.data.quickRouteTypes, ['抱石', '顶绳', '先锋']);
  assert.deepEqual(
    page.data.quickRouteGrades,
    official.vScaleGrades.map(grade => grade.value)
  );
  assert.equal(page.data.quickRouteGradeText, 'V3');

  // 表单结构：类型选择器在左、等级选择器在右；等级显示占位文案；颜色独立可选。
  const wxml = read(PAGE_WXML);
  assert.match(wxml, /range="\{\{quickRouteTypes\}\}"/);
  assert.match(wxml, /bindchange="onQuickRouteTypeChange"/);
  assert.match(wxml, /range="\{\{quickRouteGrades\}\}"/);
  assert.match(wxml, /\{\{quickRouteGradeText\}\}/);
  assert.match(wxml, /bindchange="onQuickRouteGradeChange"/);
  assert.match(wxml, /bindchange="onQuickRouteColorChange"/);
  assert.ok(
    wxml.indexOf('onQuickRouteTypeChange') <
      wxml.indexOf('onQuickRouteGradeChange'),
    '攀岩类型选择器在等级选择器左侧'
  );
});

// ---- G33 ----
test('G33 切换类型即时重算等级：共有值保留，失效值清空显示「请选择等级」，颜色不变', async () => {
  const page = createPage();
  tapStart(page, 0);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '联动线' } });
  page.onQuickRouteColorChange({ detail: { value: 3 } });
  assert.equal(page.data.quickRouteGrade, 'V3');
  assert.equal(page.data.quickRouteColorName, '绿色');

  // 抱石 V3 → 顶绳：V3 不在 YDS 里 → 清空并要求重选
  page.onQuickRouteTypeChange({
    detail: { value: page.data.quickRouteTypes.indexOf('顶绳') }
  });
  assert.equal(page.data.quickRouteType, '顶绳');
  assert.equal(page.data.quickRouteGrade, '');
  assert.equal(page.data.quickRouteGradeText, '请选择等级');
  assert.deepEqual(
    page.data.quickRouteGrades,
    store.GRADES_BY_TYPE['顶绳']
  );
  assert.equal(page.data.quickRouteColorName, '绿色', '切换类型不动颜色');

  // 顶绳 5.10a → 先锋：同属 YDS，共有等级保留
  page.onQuickRouteGradeChange({
    detail: { value: page.data.quickRouteGrades.indexOf('5.10a') }
  });
  assert.equal(page.data.quickRouteGrade, '5.10a');
  page.onQuickRouteTypeChange({
    detail: { value: page.data.quickRouteTypes.indexOf('先锋') }
  });
  assert.equal(page.data.quickRouteType, '先锋');
  assert.equal(page.data.quickRouteGrade, '5.10a');
  assert.equal(page.data.quickRouteGradeText, '5.10a');
  assert.equal(page.data.quickRouteColorName, '绿色');

  // 先锋 5.10a → 抱石：失效 → 清空
  page.onQuickRouteTypeChange({
    detail: { value: page.data.quickRouteTypes.indexOf('抱石') }
  });
  assert.equal(page.data.quickRouteType, '抱石');
  assert.equal(page.data.quickRouteGrade, '');
  assert.equal(page.data.quickRouteGradeText, '请选择等级');
  assert.equal(page.data.quickRouteColorName, '绿色', '颜色仍属于当前表单');

  // 重选 V3 后可以创建，写入的是类型与等级的组合
  page.onQuickRouteGradeChange({
    detail: { value: page.data.quickRouteGrades.indexOf('V3') }
  });
  page.createQuickRoute();
  assert.equal(page.data.quickRouteError, '');
  assert.equal(page.data.selectedRoute.climbType, '抱石');
  assert.equal(page.data.selectedRoute.grade, 'V3');
  assert.equal(page.data.selectedRoute.colorName, '绿色');
});

// ---- G34 ----
test('G34 空值、越界或类型与等级错配时创建入口直接拒绝，不新建也不回落', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  const routesBefore = savedState().routes.length;
  const activeBefore = page.state.activeRouteId;
  const selectedBefore = page.data.selectedRoute.id;

  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '非法组合线' } });

  // 1) 等级为空：不能创建
  page.onQuickRouteTypeChange({
    detail: { value: page.data.quickRouteTypes.indexOf('顶绳') }
  });
  assert.equal(page.data.quickRouteGrade, '');
  page.createQuickRoute();
  assert.match(page.data.quickRouteError, /请选择等级/);
  assert.equal(savedState().routes.length, routesBefore, '空值不新增线路');
  assert.equal(page.state.activeRouteId, activeBefore, '活动线路不变');
  assert.equal(page._quickPhotoSource, '', '未创建时不动已选照片');

  // 2) 等级索引越界：不静默落到首个等级
  page.onQuickRouteGradeChange({ detail: { value: 99 } });
  assert.equal(page.data.quickRouteGrade, '');
  assert.equal(page.data.quickRouteGradeText, '请选择等级');
  page.createQuickRoute();
  assert.match(page.data.quickRouteError, /请选择等级/);
  assert.equal(savedState().routes.length, routesBefore, '越界不新增线路');
  assert.equal(page.state.activeRouteId, activeBefore);

  // 3) 类型与等级错配：直接改状态后再调创建入口
  page.setData({
    quickRouteType: '抱石',
    quickRouteTypeIndex: page.data.quickRouteTypes.indexOf('抱石'),
    quickRouteGrades: store.GRADES_BY_TYPE['抱石'],
    quickRouteGrade: '5.10a',
    quickRouteGradeIndex: 0
  });
  page.createQuickRoute();
  assert.match(page.data.quickRouteError, /不匹配/);
  assert.equal(savedState().routes.length, routesBefore, '错配不新增线路');
  assert.equal(page.state.activeRouteId, activeBefore);
  assert.equal(page.data.selectedRoute.id, selectedBefore, '当前线路不变');

  // 4) 非法类型：拒绝且不回落
  page.setData({ quickRouteType: '室内', quickRouteGrade: 'V3' });
  page.createQuickRoute();
  assert.match(page.data.quickRouteError, /攀岩类型/);
  assert.equal(savedState().routes.length, routesBefore);

  // 修正为有效组合后才创建
  page.setData({
    quickRouteType: '抱石',
    quickRouteTypeIndex: page.data.quickRouteTypes.indexOf('抱石'),
    quickRouteGrades: store.GRADES_BY_TYPE['抱石'],
    quickRouteGrade: 'V3',
    quickRouteGradeIndex: store.GRADES_BY_TYPE['抱石'].indexOf('V3')
  });
  page.createQuickRoute();
  assert.equal(page.data.quickRouteError, '');
  assert.equal(savedState().routes.length, routesBefore + 1);
  assert.equal(page.data.selectedRoute.climbType, '抱石');
  assert.equal(page.data.selectedRoute.grade, 'V3');
});

// ---- G35 ----
test('G35 三种类型分别保存后重开：类型、等级、颜色与长期 ID 稳定', async () => {
  const page = createPage();
  tapStart(page, 0);

  const cases = [
    { type: '抱石', grade: 'V3', colorIndex: 0 },
    { type: '顶绳', grade: '5.10a', colorIndex: 1 },
    { type: '先锋', grade: '5.11b', colorIndex: 4 }
  ];
  const created = [];
  for (const item of cases) {
    page.toggleQuickRoute();
    page.onQuickRouteNameInput({ detail: { value: item.type + '线' } });
    page.onQuickRouteColorChange({ detail: { value: item.colorIndex } });
    page.onQuickRouteTypeChange({
      detail: { value: page.data.quickRouteTypes.indexOf(item.type) }
    });
    page.onQuickRouteGradeChange({
      detail: { value: page.data.quickRouteGrades.indexOf(item.grade) }
    });
    page.createQuickRoute();
    assert.equal(page.data.quickRouteError, '', item.type + ' 应可创建');
    created.push({
      id: page.data.selectedRoute.id,
      type: item.type,
      grade: item.grade,
      colorName: page.data.selectedRoute.colorName
    });
  }
  assert.equal(
    new Set(created.map(item => item.id)).size,
    3,
    '三条线路的长期 ID 各不相同'
  );
  assert.ok(created.every(item => /^route-local-\d+$/.test(item.id)));

  const reentered = createPage();
  for (const item of created) {
    const route = reentered.data.routes.find(entry => entry.id === item.id);
    assert.ok(route, '重开后仍能读回 ' + item.type + ' 线路');
    assert.equal(route.climbType, item.type);
    assert.equal(route.grade, item.grade);
    assert.equal(route.colorName, item.colorName);
  }

  // 新建线路的类型写入缓存，不是只在前端展示。
  const stored = savedState().routes.filter(route =>
    created.some(item => item.id === route.id)
  );
  assert.equal(stored.length, 3);
  assert.ok(
    stored.every(
      route => typeof route.climbType === 'string' && route.climbType.length > 0
    ),
    '新建线路持久化 climbType'
  );

  // 详情页展示同一条线的类型与等级
  const detail = createDetailPage(created[1].id);
  assert.equal(detail.data.route.climbType, '顶绳');
  assert.equal(detail.data.route.grade, '5.10a');
  assert.equal(detail.data.notFound, false);
});

// ---- G36 ----
test('G36 缺类型的旧 V 级线路按抱石读取，原把次与备注一致且浏览不迁移', async () => {
  const page = createPage();
  tapStart(page, 0);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '旧线备注');
  page.saveNote();

  // 样例与旧汇总都没有 climbType 字段，读取时按抱石展示。
  const blue = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(blue.climbType, '抱石');
  assert.equal(blue.grade, 'V3');
  assert.ok(
    savedState().routes.every(route => route.climbType === undefined),
    '读取不给旧线路补写类型'
  );

  const stateBefore = JSON.stringify(savedState());
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.route.climbType, '抱石');
  assert.equal(detail.data.route.grade, 'V3');
  assert.equal(detail.data.attemptCount, 2, '原把次不变');
  assert.equal(detail.data.groups[0].attempts[1].note, '旧线备注', '旧备注归属不变');
  assert.match(detail.data.summaryText, /2 把/);

  const legacy = createDetailPage(LEGACY_ROUTE);
  assert.equal(legacy.data.isLegacy, true);
  assert.equal(legacy.data.route.climbType, '抱石');
  assert.equal(legacy.data.attemptCount, 0, '旧汇总不生成逐次尝试');

  createPage();
  assert.equal(
    JSON.stringify(savedState()),
    stateBefore,
    '浏览详情与重进不改动线路缓存，也不迁移'
  );

  // normalizeState 只做兼容读取，不补齐或改写类型字段。
  const normalized = store.normalizeState(store.createInitialState());
  assert.ok(normalized);
  assert.ok(
    normalized.routes.every(route => route.climbType === undefined),
    '兼容读取不写入类型'
  );
});

// ---- T014 / A1 ----
test('T014-A1 抱石首次完攀后跨场次、跨页面与直接保存入口都不能新增', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-01');
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);

  // 完攀前可连续记未完成，第二把补备注（同一抱石线允许多次未完成）
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '第二把换左脚');
  page.saveNote();
  assert.equal(page.data.attempts.length, 2);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);

  // 首次完攀确认：本线随即关闭
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.attempts[2].resultText, '完攀');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routeSendCount, 1);
  assert.equal(page.data.routeStateText, '已完攀');

  const attemptsBefore = savedState().attempts.length;
  const ledgerRows = ledgerState().records.length;
  assert.equal(attemptsBefore, 3);
  assert.equal(ledgerRows, 3);

  // 跨场次：另开同日第二场，完攀与未完成都不得新增待确认或把次
  page.openSessionForm();
  page.onDateChange({ detail: { value: '2026-11-01' } });
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0, '第二场只显示自己的尝试');
  assert.equal(page.data.routeClosed, true, '跨场次仍按已完攀关闭入口');

  await tapResult(page, 'send');
  await tapResult(page, 'fail');
  assert.equal(page.data.pendingAttempts.length, 0, '不得新增待确认项');
  assert.match(page.data.saveNotice, /已完攀/);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(ledgerState().records.length, ledgerRows);

  // 连点：同一页快速点两次也不会新增
  await Promise.all([tapResult(page, 'send'), tapResult(page, 'fail')]);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(ledgerState().records.length, ledgerRows);

  // 跨页面：重新进入的实例同样按已完攀拒绝
  const reentered = createPage();
  assert.equal(reentered.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(reentered.data.routeCompleted, true);
  await tapResult(reentered, 'send');
  assert.equal(reentered.data.pendingAttempts.length, 0);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(ledgerState().records.length, ledgerRows);

  // 直接调用实际模拟保存入口：不同操作 ID 也不增加账本行
  const directSend = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'attempt-direct-1')
  );
  assert.equal(directSend.ok, false);
  assert.equal(directSend.alreadySent, true);
  assert.equal(ledgerState().records.length, ledgerRows, '直接完攀不得新增账本行');
  const directFail = server.submitOperation(
    submitContext(ROUTE_BLUE, 'fail', 'attempt-direct-2')
  );
  assert.equal(directFail.ok, false);
  assert.equal(directFail.alreadySent, true);
  assert.equal(ledgerState().records.length, ledgerRows, '直接未完成也不得新增账本行');

  // 原线路三把的 ID、备注与所属场次逐项核对
  const blueAttempts = savedState()
    .attempts.filter(item => item.routeId === ROUTE_BLUE)
    .sort((left, right) => left.seq - right.seq);
  assert.deepEqual(
    blueAttempts.map(item => item.result),
    ['fail', 'fail', 'send']
  );
  assert.equal(blueAttempts[1].note, '第二把换左脚');
  assert.ok(
    blueAttempts.every(item => item.sessionId === firstSessionId),
    '三把都归属第一场'
  );
  assert.equal(new Set(blueAttempts.map(item => item.id)).size, 3);

  // 另一条同色同级抱石线仍能独立记录
  tapRoute(page, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.routeClosed, false);
  await tapResult(page, 'fail');
  assert.equal(page.data.attempts.length, 1);
  await tapResult(page, 'send');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(
    savedState().attempts.filter(
      item => item.routeId === ROUTE_BLUE_BALANCE
    ).length,
    2
  );
  assert.equal(
    savedState().attempts.filter(item => item.routeId === ROUTE_BLUE).length,
    3,
    '原线路不因另一条线新增而改变'
  );
});

// ---- T014 / A2 ----
test('T014-A2 完攀待确认（丢回执）时跨场次与并发重试都只新增一次完攀', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-01');
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  page.toggleReceiptLossArm();
  await tapResult(page, 'send');
  const opId = page.data.pendingAttempts[0].opId;
  assert.ok(opId);
  assert.equal(page.data.attempts.length, 1, '完攀确认前不计入已保存');
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, true, '完攀待确认也关闭新增入口');
  assert.equal(page.data.routeStateText, '完攀待确认');
  assert.equal(ledgerState().records.length, 2);
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1
  );
  assert.equal(savedState().pendingSaves.length, 1);

  // 另一个场次尝试另起操作：不新增第二个待确认，也不新增把次
  page.openSessionForm();
  page.onDateChange({ detail: { value: '2026-11-01' } });
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  await tapResult(page, 'fail');
  assert.equal(page.data.pendingAttempts.length, 0, '不得新增第二个待确认');
  assert.equal(savedState().pendingSaves.length, 1, '原待确认保留');
  assert.equal(savedState().pendingSaves[0].opId, opId);
  assert.equal(savedState().attempts.length, 1, '不得新增把次');
  assert.equal(ledgerState().records.length, 2, '不得新增账本行');
  assert.match(page.data.saveNotice, /待确认/);

  // 另一个页面实例同样拒绝
  const other = createPage();
  await tapResult(other, 'send');
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(ledgerState().records.length, 2);

  // 直接调用保存入口：不同操作 ID 也不行
  const direct = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'attempt-direct-3')
  );
  assert.equal(direct.ok, false);
  assert.equal(direct.alreadySent, true);
  assert.equal(ledgerState().records.length, 2);

  // 两个页面并发重试原操作 ID：只确认一次
  const pageA = createPage();
  const pageB = createPage();
  pageA._saveDelayMs = 20;
  pageB._saveDelayMs = 20;
  await Promise.all([
    pageA.retryPendingAttempt({ currentTarget: { dataset: { opId } } }),
    pageB.retryPendingAttempt({ currentTarget: { dataset: { opId } } })
  ]);
  assert.equal(
    ledgerState().records.filter(item => item.opId === opId).length,
    1,
    '同一操作 ID 只入账一次'
  );
  assert.equal(
    savedState().attempts.filter(item => item.id === opId).length,
    1,
    '本地只保留一条完攀尝试'
  );
  assert.equal(savedState().pendingSaves.length, 0, '原待确认可清除');
  assert.equal(ledgerState().records.length, 2, '重试复用同一操作，不重复入账');

  // 确认后按已完攀处理：页面与直接入口都不能再新增
  const after = createPage();
  assert.equal(after.data.routeCompleted, true);
  await tapResult(after, 'send');
  assert.equal(savedState().attempts.length, 2);
  assert.equal(ledgerState().records.length, 2);
  const afterDirect = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'attempt-direct-4')
  );
  assert.equal(afterDirect.ok, false);
  assert.equal(afterDirect.alreadySent, true);
  assert.equal(ledgerState().records.length, 2);

  // 取回的完攀与原把次归属正确
  const confirmed = savedState().attempts.find(item => item.id === opId);
  assert.ok(confirmed);
  assert.equal(confirmed.result, 'send');
  assert.equal(confirmed.sessionId, firstSessionId);
  assert.equal(confirmed.routeId, ROUTE_BLUE);
});

test('T014-A2 落账前写失败：待确认保留，跨场次与直接入口都不新增，重试后只入账一次', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-01');
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  assert.equal(ledgerState().records.length, 2);

  // 落账前写失败：账本没有变化，客户端仍保留原待确认
  wxLog.failKeys.add(LEDGER_KEY);
  await tapResult(page, 'send');
  const opId = page.data.pendingAttempts[0].opId;
  assert.ok(opId);
  assert.match(page.data.saveNotice, /账本写入失败/);
  assert.equal(page.data.attempts.length, 2, '未确认的完攀不计入已保存');
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(page.data.routeClosed, true);
  assert.equal(ledgerState().records.length, 2, '落账失败时不入账');

  // 跨场次另起操作
  page.openSessionForm();
  page.onDateChange({ detail: { value: '2026-11-01' } });
  page.startSession();
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(savedState().pendingSaves.length, 1);

  // 直接入口在落账仍失败时也不新增
  const direct = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'attempt-direct-5')
  );
  assert.equal(direct.ok, false);
  assert.equal(ledgerState().records.length, 2);

  // 恢复写入后重试原操作：只新增一次完攀
  wxLog.failKeys.delete(LEDGER_KEY);
  tapSession(page, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.pendingAttempts.length, 1);
  await retryPending(page, opId);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.attempts[2].id, opId);
  assert.equal(page.data.attempts[2].resultText, '完攀');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(ledgerState().records.length, 3);
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1
  );
  assert.equal(savedState().pendingSaves.length, 0);
});

test('T014-A2 已落账但本地确认写失败：保留待确认，重试取回同一个完攀且不重复入账', async () => {
  const page = createPage();
  page._saveDelayMs = 30;
  tapStart(page, 0, '2026-11-01');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');

  const saving = page.recordAttempt({
    currentTarget: { dataset: { result: 'send' } }
  });
  const opId = page.data.pendingAttempts[0].opId;
  // 待确认已落盘后，只让客户端状态写入失败；模拟账本已入账。
  wxLog.failKeys.add(STORE_KEY);
  await saving;

  assert.match(page.data.storageError, /本地保存失败/);
  assert.match(page.data.saveNotice, /保存端已确认，但本地写入失败/);
  assert.equal(page.data.attempts.length, 2, '本地未确认不得显示为已保存');
  assert.equal(page.data.pendingAttempts.length, 1);
  assert.equal(page.data.routeClosed, true);
  assert.equal(ledgerState().records.length, 3);
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1
  );
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(savedState().attempts.length, 2);

  // 本地未确认期间：另一个页面与直接入口都不重复入账
  const other = createPage();
  await tapResult(other, 'send');
  assert.equal(ledgerState().records.length, 3);
  const direct = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'attempt-direct-6')
  );
  assert.equal(direct.ok, false);
  assert.equal(direct.alreadySent, true);
  assert.equal(ledgerState().records.length, 3);

  // 恢复本地写入后重试：取回同一个完攀，账本不重复
  wxLog.failKeys.delete(STORE_KEY);
  await retryPending(page, opId);
  assert.equal(page.data.storageError, '');
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.attempts[2].id, opId);
  assert.equal(page.data.attempts[2].resultText, '完攀');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(ledgerState().records.length, 3, '重复确认不再入账');
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(savedState().attempts.length, 3);
});

test('T014-A2 落账前写失败时另起的重复完攀待确认会被撤销，原把次仍可恢复', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-01');
  tapRoute(page, ROUTE_BLUE);

  // 原把次：落账前写失败，账本里还没有这一把，只剩本地待确认。
  wxLog.failKeys.add(LEDGER_KEY);
  await tapResult(page, 'send');
  const opId = page.data.pendingAttempts[0].opId;
  assert.ok(opId);
  assert.equal(ledgerState(), null, '落账失败时不写账本');
  assert.equal(savedState().pendingSaves.length, 1);

  // 另一个页面实例/旧客户端又留下一条同线路的完攀待确认（并发时可能各自先落盘）。
  const concurrent = savedState();
  concurrent.pendingSaves.push({
    opId: 'attempt-duplicate-9',
    seq: concurrent.nextAttemptSeq,
    sessionId: concurrent.activeSessionId,
    routeId: ROUTE_BLUE,
    result: 'send',
    note: '',
    createdAt: new Date().toISOString()
  });
  concurrent.nextAttemptSeq += 1;
  storage.set(STORE_KEY, JSON.stringify(concurrent));
  const attemptsBefore = savedState().attempts.length;

  // 派发这条重复待确认：保存端判为「完攀还在待确认」，本地撤销它，不落账、不新增把次。
  const other = createPage();
  await other.dispatchPending('attempt-duplicate-9');
  assert.match(other.data.saveNotice, /待确认/);
  assert.equal(ledgerState(), null, '重复待确认不入账');
  assert.equal(savedState().attempts.length, attemptsBefore, '不新增把次');
  assert.equal(savedState().pendingSaves.length, 1, '不永久滞留冲突待确认');
  assert.equal(savedState().pendingSaves[0].opId, opId);

  // 原把次仍可恢复：恢复账本写入后重试，只新增一次完攀。
  wxLog.failKeys.delete(LEDGER_KEY);
  await retryPending(page, opId);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.attempts.length, 1);
  assert.equal(page.data.attempts[0].id, opId);
  assert.equal(page.data.attempts[0].resultText, '完攀');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(ledgerState().records.length, 1);
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1
  );
  assert.equal(savedState().pendingSaves.length, 0);
});

// ---- T014 / A3 ----
test('T014-A3 同色同级、独立用户上下文与独立数据集都不误锁', async () => {
  // 归属判定：用户、数据集、线路 ID 任一不同都不算同一条已完攀线路
  const base = {
    ownerId: trialProfile.TRIAL_OWNER_ID,
    datasetId: trialProfile.TRIAL_DATASET_ID,
    routeId: ROUTE_BLUE
  };
  assert.equal(store.isSameSendOwner(base, Object.assign({}, base)), true);
  assert.equal(
    store.isSameSendOwner(base, Object.assign({}, base, { ownerId: 'trial-user-local-b' })),
    false
  );
  assert.equal(
    store.isSameSendOwner(
      base,
      Object.assign({}, base, { datasetId: 'trial-dataset-local-9' })
    ),
    false
  );
  assert.equal(
    store.isSameSendOwner(
      base,
      Object.assign({}, base, { routeId: ROUTE_BLUE_BALANCE })
    ),
    false
  );

  // 账本：归属只认当前试用用户与当前数据集，别的归属的完攀记录不牵连这条线
  const foreignSend = (opId, extra) =>
    Object.assign(
      {
        opId,
        sessionId: 'session-1',
        routeId: ROUTE_BLUE,
        result: 'send',
        note: '',
        receivedAt: new Date().toISOString(),
        climbType: '抱石',
        ownerId: trialProfile.TRIAL_OWNER_ID,
        datasetId: trialProfile.TRIAL_DATASET_ID
      },
      extra
    );
  storage.set(
    LEDGER_KEY,
    JSON.stringify({
      version: 1,
      records: [
        foreignSend('op-other-owner', { ownerId: 'trial-user-local-b' }),
        foreignSend('op-other-dataset', { datasetId: 'trial-dataset-local-9' })
      ],
      loseNextReceipt: false
    })
  );

  // 同一条线路 ID，别的用户上下文或别的数据集不算这条线已完攀：可以正常入账
  const allowed = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'op-current-1')
  );
  assert.equal(allowed.ok, true, '其他归属的旧记录不锁住当前上下文');
  assert.equal(ledgerState().records.length, 3);

  // 同一归属：不同操作 ID 的完攀与未完成都不再入账
  const dupSend = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'op-current-2')
  );
  assert.equal(dupSend.ok, false);
  assert.equal(dupSend.alreadySent, true);
  const dupFail = server.submitOperation(
    submitContext(ROUTE_BLUE, 'fail', 'op-current-3')
  );
  assert.equal(dupFail.ok, false);
  assert.equal(dupFail.alreadySent, true);
  assert.equal(ledgerState().records.length, 3);

  // 省略上下文（项目支持的旧请求形状）与伪造类型、伪造归属都不能绕过判定
  const legacyShape = server.submitOperation({
    opId: 'op-current-4',
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    result: 'fail',
    note: ''
  });
  assert.equal(legacyShape.ok, false);
  assert.equal(legacyShape.alreadySent, true, '遗漏上下文不能绕过完攀判定');
  const forged = server.submitOperation(
    Object.assign(submitContext(ROUTE_BLUE, 'send', 'op-current-5'), {
      climbType: '先锋',
      ownerId: 'trial-user-local-z',
      datasetId: 'trial-dataset-local-8'
    })
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.alreadySent, true, '伪造类型与归属不能绕过完攀判定');
  assert.equal(ledgerState().records.length, 3);

  // 被复制的操作 ID 换到另一条线路：只能拒绝，不能拿别人的记录当确认
  const copied = server.submitOperation(
    submitContext(ROUTE_BLUE_BALANCE, 'send', 'op-current-1')
  );
  assert.equal(copied.ok, false);
  assert.equal(copied.opIdConflict, true);
  assert.equal(copied.duplicate, undefined, '不得返回错误确认');
  assert.equal(ledgerState().records.length, 3);

  // 另一条同色同级线路仍有自己的独立完攀
  const balance = server.submitOperation(
    submitContext(ROUTE_BLUE_BALANCE, 'send', 'op-current-6')
  );
  assert.equal(balance.ok, true, '另一条同色同级线路独立完攀');
  assert.equal(ledgerState().records.length, 4);

  // 别的归属用过同一个操作 ID：同样只能拒绝，不能拿它当这一把的确认
  const copiedForeign = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', 'op-other-dataset')
  );
  assert.equal(copiedForeign.ok, false);
  assert.equal(copiedForeign.opIdConflict, true);
  assert.equal(copiedForeign.duplicate, undefined);
  assert.equal(ledgerState().records.length, 4);

  // 重置后复用编号的独立数据集：账本清空，不被旧完攀锁住
  resetHarness();
  const page = createPage();
  tapStart(page, 0);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '重置前线路' } });
  page.createQuickRoute();
  assert.equal(page.data.selectedRoute.id, 'route-local-1');
  await tapResult(page, 'send');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(ledgerState().records.length, 1);

  const reset = await page.resetTrialData();
  assert.equal(reset, true);
  assert.equal(ledgerState().records.length, 0, '重置清空模拟账本');

  tapStart(page, 0);
  page.toggleQuickRoute();
  page.onQuickRouteNameInput({ detail: { value: '重置后复用编号' } });
  page.createQuickRoute();
  assert.equal(
    page.data.selectedRoute.id,
    'route-local-1',
    '重置后编号从头开始，可能复用旧编号'
  );
  await tapResult(page, 'send');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1
  );
});

// ---- T014 / A4 ----
test('T014-A4 旧 V 级线路多条历史完攀原样只读、旧账本可读，绳攀完攀后可再记', async () => {
  // 旧格式缓存：没有 climbType 的 V 级线路，历史已有三条完攀
  const legacyState = store.createInitialState();
  legacyState.sessions.push({
    id: 'session-1',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2026-11-01',
    createdAt: new Date().toISOString()
  });
  legacyState.nextSessionSeq = 2;
  legacyState.activeSessionId = 'session-1';
  legacyState.activeRouteId = ROUTE_BLUE;
  [1, 2, 3].forEach(index => {
    legacyState.attempts.push({
      id: 'attempt-' + index,
      seq: index,
      sessionId: 'session-1',
      routeId: ROUTE_BLUE,
      result: 'send',
      note: '历史第 ' + index + ' 把',
      createdAt: new Date().toISOString()
    });
  });
  legacyState.nextAttemptSeq = 4;
  storage.set(STORE_KEY, JSON.stringify(legacyState));

  const page = createPage();
  assert.equal(page.data.loadError, '', '旧缓存仍可读');
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routeSendCount, 3, '历史多条完攀按原数目展示');
  assert.ok(
    savedState().routes.every(route => route.climbType === undefined),
    '读取不补写类型，也不迁移'
  );

  // 共用状态判定可直接由页面之外复用
  const completion = store.routeCompletion(savedState(), ROUTE_BLUE);
  assert.equal(completion.known, true);
  assert.equal(completion.isBoulder, true);
  assert.equal(completion.sendCount, 3);
  assert.equal(completion.completed, true);
  assert.equal(completion.closed, true);
  assert.equal(completion.canRecord, false);

  // 之后无法新增（完攀或未完成）
  await tapResult(page, 'send');
  await tapResult(page, 'fail');
  assert.equal(savedState().attempts.length, 3);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(ledgerState(), null, '被拒绝的提交不得写账本');

  // 旧账本（没有类型 / 归属字段）仍可读，不判定损坏，也不丢操作 ID 幂等
  storage.set(
    LEDGER_KEY,
    JSON.stringify({
      version: 1,
      records: [
        {
          opId: 'old-op-1',
          sessionId: 'session-1',
          routeId: ROUTE_BLUE,
          result: 'send',
          note: '',
          receivedAt: new Date().toISOString()
        }
      ],
      loseNextReceipt: false
    })
  );
  const loadedLedger = server.loadLedger();
  assert.equal(loadedLedger.error, '', '旧账本可兼容读取');
  assert.equal(loadedLedger.ledger.records.length, 1);

  // 类型不从记录里读：缺类型的旧 V 级线路按试用数据里的权威线路判成抱石，
  // 所以这条旧账本记录照样挡住同一线路的新操作，同 op 重放则仍取回原记录。
  const legacyBlocked = server.submitOperation(
    submitContext(ROUTE_BLUE, 'fail', 'old-op-2')
  );
  assert.equal(legacyBlocked.ok, false);
  assert.equal(legacyBlocked.alreadySent, true);
  const legacyReplay = server.submitOperation(
    submitContext(ROUTE_BLUE, 'fail', 'old-op-1')
  );
  assert.equal(legacyReplay.ok, true);
  assert.equal(legacyReplay.duplicate, true, '旧账本的同一操作 ID 仍幂等');
  assert.equal(ledgerState().records.length, 1);

  // 绳攀：完攀后可再记，同一操作 ID 仍幂等
  resetHarness();
  const ropePage = createPage();
  tapStart(ropePage, 0);
  ropePage.toggleQuickRoute();
  ropePage.onQuickRouteNameInput({ detail: { value: '顶绳线' } });
  ropePage.onQuickRouteTypeChange({
    detail: { value: ropePage.data.quickRouteTypes.indexOf('顶绳') }
  });
  ropePage.onQuickRouteGradeChange({
    detail: { value: ropePage.data.quickRouteGrades.indexOf('5.10a') }
  });
  ropePage.createQuickRoute();
  const ropeId = ropePage.data.selectedRoute.id;
  assert.equal(ropePage.data.selectedRoute.climbType, '顶绳');

  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.routeCompleted, false, '顶绳不因完攀关闭入口');
  assert.equal(ropePage.data.routeClosed, false);
  assert.equal(ropePage.data.routeRepeatable, true);
  assert.equal(ropePage.data.routeSendCount, 1);
  const firstRopeSendId = ropePage.data.attempts[0].id;

  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.attempts.length, 2, '顶绳完攀后可再记');
  assert.equal(
    ledgerState().records.filter(item => item.routeId === ropeId).length,
    2
  );

  const dup = server.submitOperation({
    opId: firstRopeSendId,
    sessionId: ropePage.data.activeSession.id,
    routeId: ropeId,
    result: 'send',
    note: '',
    climbType: '顶绳',
    ownerId: trialProfile.TRIAL_OWNER_ID,
    datasetId: trialProfile.TRIAL_DATASET_ID
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true, '相同操作 ID 保持幂等重试');
  assert.equal(
    ledgerState().records.filter(item => item.routeId === ropeId).length,
    2
  );

  // 先锋同理：完攀后可再记，不误锁
  ropePage.toggleQuickRoute();
  ropePage.onQuickRouteNameInput({ detail: { value: '先锋线' } });
  ropePage.onQuickRouteTypeChange({
    detail: { value: ropePage.data.quickRouteTypes.indexOf('先锋') }
  });
  ropePage.onQuickRouteGradeChange({
    detail: { value: ropePage.data.quickRouteGrades.indexOf('5.11b') }
  });
  ropePage.createQuickRoute();
  assert.equal(ropePage.data.selectedRoute.climbType, '先锋');
  await tapResult(ropePage, 'send');
  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.attempts.length, 2);
  assert.equal(ropePage.data.routeClosed, false);
  assert.equal(ropePage.data.routeSendCount, 2);
});

// ---- T014 / A5 ----
test('T014-A5 直接保存入口按权威线路与当前上下文判定：旧签名、谎称类型与复制 opId 都不能入账', async () => {
  // 与试用探针同一套内存数据：真实线路 route-chalkbox-blue-dyn 是缺 climbType 的旧 V 级线路。
  const seedProbe = extra => {
    const state = store.createInitialState();
    const route = state.routes.find(item => item.id === ROUTE_BLUE);
    state.sessions.push({
      id: 'session-probe',
      seq: 1,
      gymId: route.gymId,
      date: '2026-11-09',
      createdAt: '2026-11-09T08:00:00Z'
    });
    state.nextSessionSeq = 2;
    state.activeSessionId = 'session-probe';
    state.activeRouteId = route.id;
    Object.assign(state, extra || {});
    storage.set(STORE_KEY, JSON.stringify(state));
    return state;
  };

  const state = seedProbe();
  const route = state.routes.find(item => item.id === ROUTE_BLUE);
  assert.equal(route.climbType, undefined, '夹具是缺类型的旧 V 级线路');
  assert.equal(
    routeRules.isBoulderRoute(route),
    true,
    '缺类型的旧 V 级线路按权威线路判成抱石'
  );

  const common = {
    sessionId: 'session-probe',
    routeId: ROUTE_BLUE,
    result: 'send',
    note: ''
  };

  // 1) 先正常完攀一次入账
  const first = server.submitOperation({ ...common, opId: 'attempt-probe-1' });
  assert.equal(first.ok, true);
  assert.equal(ledgerState().records.length, 1);
  // 账本里的归属与类型取权威上下文，不照抄请求里可省略、可伪造的声明
  assert.equal(ledgerState().records[0].climbType, '抱石');
  assert.equal(ledgerState().records[0].ownerId, trialProfile.TRIAL_OWNER_ID);
  assert.equal(ledgerState().records[0].datasetId, state.datasetId);

  // 2) 旧签名（只有 sessionId/routeId/result/note/opId）不能借省略上下文再入账一份
  const legacy = server.submitOperation({ ...common, opId: 'attempt-probe-2' });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.alreadySent, true);

  // 3) 谎称先锋的当前请求同样被拒：类型只看权威线路
  const mislabeled = server.submitOperation({
    ...common,
    result: 'fail',
    climbType: '先锋',
    opId: 'attempt-probe-3'
  });
  assert.equal(mislabeled.ok, false);
  assert.equal(mislabeled.alreadySent, true);
  assert.equal(ledgerState().records.length, 1, '账本仍是 1 行');
  assert.equal(savedState().attempts.length, 0, '被拒的请求不进试用数据');

  // 4) 同一原 op 重放（已入账、本地还没确认）取回原记录，不新增行
  const replay = server.submitOperation({ ...common, opId: 'attempt-probe-1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.opId, 'attempt-probe-1');
  assert.equal(replay.record.result, 'send');
  assert.equal(ledgerState().records.length, 1);

  // 5) 复制 opId 到另一条线路：不能把别条线的记录当成这一把的确认
  const copied = server.submitOperation({
    ...common,
    routeId: ROUTE_BLUE_BALANCE,
    opId: 'attempt-probe-1'
  });
  assert.equal(copied.ok, false);
  assert.equal(copied.opIdConflict, true);
  assert.equal(ledgerState().records.length, 1);

  // 6) 已入账但本地确认写失败：本地仍有原待确认，原 op 重放取回同一结果，
  //    别的操作 ID 仍被拒（原把次可恢复）
  const unconfirmed = seedProbe({
    nextAttemptSeq: 2,
    pendingSaves: [
      {
        opId: 'attempt-probe-1',
        seq: 1,
        sessionId: 'session-probe',
        routeId: ROUTE_BLUE,
        result: 'send',
        note: '',
        createdAt: '2026-11-09T08:01:00Z'
      }
    ]
  });
  assert.ok(unconfirmed.pendingSaves.length === 1);
  const replayUnconfirmed = server.submitOperation({
    ...common,
    opId: 'attempt-probe-1'
  });
  assert.equal(replayUnconfirmed.ok, true);
  assert.equal(replayUnconfirmed.duplicate, true);
  const otherOp = server.submitOperation({ ...common, opId: 'attempt-probe-4' });
  assert.equal(otherOp.ok, false);
  assert.equal(otherOp.alreadySent, true);
  assert.equal(ledgerState().records.length, 1);

  // 7) 只有待确认、账本还没落账（落账前写失败）：新操作 ID 被拒并指向原把次，
  //    原把次自己仍能落账
  resetHarness();
  seedProbe({
    nextAttemptSeq: 2,
    pendingSaves: [
      {
        opId: 'attempt-pending-1',
        seq: 1,
        sessionId: 'session-probe',
        routeId: ROUTE_BLUE,
        result: 'send',
        note: '',
        createdAt: '2026-11-09T08:02:00Z'
      }
    ]
  });
  const blockedByPending = server.submitOperation({
    ...common,
    opId: 'attempt-pending-2'
  });
  assert.equal(blockedByPending.ok, false);
  assert.equal(blockedByPending.pendingSend, true);
  assert.equal(ledgerState(), null, '被拒的提交不得写账本');
  const ownRetry = server.submitOperation({ ...common, opId: 'attempt-pending-1' });
  assert.equal(ownRetry.ok, true, '原把次仍可落账');
  assert.equal(ownRetry.duplicate, false);
  assert.equal(ledgerState().records.length, 1);

  // 8) 试用数据里已确认完攀、账本为空：直接入口同样拒绝新操作
  resetHarness();
  seedProbe({
    nextAttemptSeq: 2,
    attempts: [
      {
        id: 'attempt-confirmed-1',
        seq: 1,
        sessionId: 'session-probe',
        routeId: ROUTE_BLUE,
        result: 'send',
        note: '权威数据里已确认',
        createdAt: '2026-11-09T08:03:00Z'
      }
    ]
  });
  const blockedByConfirmed = server.submitOperation({
    ...common,
    opId: 'attempt-confirmed-2'
  });
  assert.equal(blockedByConfirmed.ok, false);
  assert.equal(blockedByConfirmed.alreadySent, true);
  assert.equal(ledgerState(), null, '被拒的提交不得写账本');
});

// ---- T014 / A6：重置或切换数据集后的迟到回执 ----
// 复现 PM 探针：页面 A 的完攀回执晚到；页面 B 重置（或切到新数据集）后在
// 同一条固定线路重新开场，新数据从零分配，旧请求的 opId/sessionId 会被复用。
// 迟到的 deliver / finish 必须无副作用：不落账、不写新把次、不消费新数据。
test('T014-A6 无照片重置复用数据集后，旧页面的迟到完攀不落账、不写新把次、不误锁', async () => {
  const pageA = createPage();
  tapStart(pageA, 0, '2026-11-05');
  tapRoute(pageA, ROUTE_BLUE);
  pageA._saveDelayMs = 60; // 页面 A 的完攀回执晚到
  const outstanding = pageA.recordAttempt({
    currentTarget: { dataset: { result: 'send' } }
  });
  const oldOpId = pageA.data.pendingAttempts[0].opId;
  const oldSessionId = pageA.data.activeSession.id;
  assert.equal(oldOpId, 'attempt-1');
  assert.equal(savedState().pendingSaves.length, 1);
  assert.equal(ledgerState(), null, 'A 的回执还没到，账本尚未写入');

  // 页面 B：无照片重置保持同一 datasetId，却在同一固定线路重新开场
  const pageB = createPage();
  assert.equal(await pageB.resetTrialData(), true);
  assert.equal(
    savedState().datasetId,
    trialProfile.TRIAL_DATASET_ID,
    '无照片重置保持同一数据集'
  );
  tapStart(pageB, 0, '2026-11-09');
  tapRoute(pageB, ROUTE_BLUE);
  assert.equal(savedState().attempts.length, 0);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(ledgerRows(), 0, '重置后账本已清空');

  // A 的迟到完攀回执到达：新数据此刻还没有自己的把次，
  // 旧请求的 opId/sessionId 会被新数据复用，这里必须无副作用。
  await outstanding;
  assert.equal(ledgerRows(), 0, '迟到旧回执不落账');
  assert.equal(savedState().attempts.length, 0, '迟到旧回执不写新把次');
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).closed,
    false,
    '旧完攀不得误锁新数据'
  );

  // 新数据从零分配，复用同一 opId 与 sessionId 正常记一把未完成
  await tapResult(pageB, 'fail');
  assert.equal(pageB.data.attempts[0].id, oldOpId, '新数据复用同一 opId');
  assert.equal(pageB.data.activeSession.id, oldSessionId, '新数据复用同一 sessionId');
  assert.equal(ledgerState().records.length, 1, '新数据自己那一把正常入账');
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).closed,
    false,
    '新一把是未完成，不被旧的完攀影响'
  );

  // 新上下文仍可继续：同一编号空间里正常再记一把完攀
  await tapResult(pageB, 'send');
  assert.equal(savedState().attempts.length, 2);
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).completed,
    true,
    '新数据自己的完攀正常生效'
  );
  assert.equal(ledgerState().records.length, 2);
});

test('T014-A7 切到新数据集后，旧页面的迟到回执不消费新数据的待确认与把次', async () => {
  const pageA = createPage();
  tapStart(pageA, 0, '2026-11-05');
  tapRoute(pageA, ROUTE_BLUE);

  // 用固定计时器扣住 A 的回执，等 B 重置并在新数据集重开后按确定顺序放行。
  const originalSetTimeout = global.setTimeout;
  const heldTimers = [];
  let outstanding;
  global.setTimeout = fn => {
    heldTimers.push(fn);
    return heldTimers.length;
  };
  try {
    pageA._saveDelayMs = 60;
    outstanding = pageA.recordAttempt({
      currentTarget: { dataset: { result: 'send' } }
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  const oldOpId = pageA.data.pendingAttempts[0].opId;
  const oldSessionId = pageA.data.activeSession.id;

  // 页面 B：显式切到新数据集（有照片轮换走的也是这条路径）
  const pageB = createPage();
  assert.equal(pageB.applyTrialReset('trial-dataset-local-2'), true);
  assert.equal(savedState().datasetId, 'trial-dataset-local-2');
  tapStart(pageB, 0, '2026-11-09');
  tapRoute(pageB, ROUTE_BLUE);

  // 新数据自己那一把：丢回执，保留待确认，同时账本已有一行
  pageB.toggleReceiptLossArm();
  await tapResult(pageB, 'fail');
  assert.equal(savedState().pendingSaves.length, 1, '新数据的待确认已落盘');
  assert.equal(savedState().pendingSaves[0].opId, oldOpId, '新数据复用同一 opId');
  assert.equal(ledgerState().records.length, 1);
  assert.equal(ledgerState().records[0].opId, oldOpId);

  // 放行 A 的迟到完攀：不落账，也不动新数据仍在待确认的那一把
  assert.equal(heldTimers.length, 1, '应只有 A 的延迟回执');
  heldTimers[0]();
  await outstanding;
  assert.equal(savedState().pendingSaves.length, 1, '旧回调不消费新数据的待确认');
  assert.equal(savedState().pendingSaves[0].opId, oldOpId);
  assert.equal(savedState().pendingSaves[0].result, 'fail', '新一把仍是未完成');
  assert.equal(savedState().attempts.length, 0);
  assert.equal(ledgerState().records.length, 1, '旧回调不落账');
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).hasPendingSend,
    false,
    '旧回执不得把新线路标成完攀待确认'
  );

  // 新数据自己的回执仍可用原 opId 恢复，且只入账一次
  await retryPending(pageB, oldOpId);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().attempts[0].id, oldOpId);
  assert.equal(ledgerState().records.length, 1, '原操作 ID 仍幂等，不重复入账');
});

test('T014-A8 新数据先记未完成：复用同 opId 的旧完攀不得落账、不得当确认、不得误锁', async () => {
  // 新数据集里正常记一把未完成
  const page = createPage();
  assert.equal(page.applyTrialReset('trial-dataset-local-2'), true);
  tapStart(page, 0, '2026-11-09');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  const newOpId = page.data.attempts[0].id;
  const newSessionId = page.data.activeSession.id;
  assert.equal(ledgerState().records.length, 1);

  // 重置前编号空间的迟到完攀：opId / sessionId / routeId 都被新数据复用，
  // 只有世代还是旧的——直接走实际保存入口也不能拿新记录当确认。
  const staleSend = server.submitOperation({
    opId: newOpId,
    sessionId: newSessionId,
    routeId: ROUTE_BLUE,
    result: 'send',
    note: '',
    generation: 'gen-stale-before-reset'
  });
  assert.equal(staleSend.ok, false);
  assert.equal(staleSend.stale, true, '旧世代一律不入账');
  assert.equal(staleSend.duplicate, undefined, '不得返回错误确认');
  assert.equal(staleSend.alreadySent, undefined);
  assert.equal(ledgerState().records.length, 1, '不新增账本行');
  assert.equal(savedState().attempts.length, 1, '不写试用数据');
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).closed,
    false,
    '新数据的未完成不被旧完攀误锁'
  );

  // 新数据自己的完攀仍能记录，且与旧请求互不影响
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 2);
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).completed,
    true
  );
  assert.equal(ledgerState().records.length, 2);
});


// ---- T015 / A1：今日页、历史选线与详情统一展示 ----
test('T015-A1 抱石首次完攀：按钮位置显示「已完攀」，历史项直达详情，同色另一条与绳攀仍可记', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);

  // 完攀前：允许连记未完成，结果按钮仍在，列表不带标记
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  tapNote(page, page.data.attempts[1].id);
  typeNote(page, '第二把换左脚');
  page.saveNote();
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.routeStateText, '');
  let blueItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(blueItem.completionText, '');
  assert.equal(blueItem.isCompleted, false);

  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.routeCompleted, true, '确认成功后按已完攀显示');
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routeStateText, '已完攀');
  assert.equal(page.data.routeSendCount, 1);

  // 今日页历史选线列表一致显示「已完攀」，同色同级另一条不带标记
  blueItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  const balanceItem = page.data.routes.find(
    route => route.id === ROUTE_BLUE_BALANCE
  );
  assert.equal(blueItem.completionText, '已完攀');
  assert.equal(blueItem.isCompleted, true);
  assert.equal(blueItem.isClosed, true);
  assert.equal(balanceItem.completionText, '');
  assert.equal(balanceItem.isClosed, false);

  // 历史项直达详情：只导航、不改选线、不新增把次
  const attemptsBefore = savedState().attempts.length;
  const writesBefore = wxLog.setKeys.length;
  wxLog.navigations = [];
  page.onRouteTap({ currentTarget: { dataset: { routeId: ROUTE_BLUE } } });
  assert.equal(wxLog.navigations.length, 1, '历史项直接进入详情');
  assert.equal(wxLog.navigations[0].type, 'navigateTo');
  assert.ok(wxLog.navigations[0].url.includes(ROUTE_BLUE));
  assert.equal(wxLog.setKeys.length, writesBefore, '直达详情不写新增数据');
  assert.equal(savedState().attempts.length, attemptsBefore);

  // 同色同级另一条抱石线仍能记下一把
  page.onRouteTap({
    currentTarget: { dataset: { routeId: ROUTE_BLUE_BALANCE } }
  });
  assert.equal(
    page.data.selectedRoute.id,
    ROUTE_BLUE_BALANCE,
    '未完攀线路仍可选中'
  );
  await tapResult(page, 'fail');
  assert.equal(page.data.attempts.length, 1);
  assert.equal(
    savedState().attempts.filter(
      item => item.routeId === ROUTE_BLUE_BALANCE
    ).length,
    1
  );

  // 详情页与今日页显示同一份状态，且不再提供「今天再爬」
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routeCompleted, true);
  assert.equal(detail.data.routeClosed, true);
  assert.equal(detail.data.canRecordAgain, false);
  assert.equal(detail.data.routeStateText, '已完攀');
  assert.equal(detail.data.summaryText, '1 天 · 1 场 · 3 把');
  assert.equal(
    detail.data.groups[0].attempts[1].note,
    '第二把换左脚',
    '详情回看原把次备注'
  );

  // 原线路三把归属第一场，备注只在第二把
  const blueAttempts = savedState()
    .attempts.filter(item => item.routeId === ROUTE_BLUE)
    .sort((left, right) => left.seq - right.seq);
  assert.deepEqual(
    blueAttempts.map(item => item.result),
    ['fail', 'fail', 'send']
  );
  assert.equal(blueAttempts[1].note, '第二把换左脚');
  assert.equal(new Set(blueAttempts.map(item => item.id)).size, 3);

  // 绳攀完攀后仍可经「今天再爬」继续记录
  const ropePage = createPage();
  tapStart(ropePage, 0, '2026-11-05');
  const ropeId = createTypedRoute(ropePage, '顶绳再爬线', '顶绳', '5.10a');
  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.routeCompleted, false, '顶绳不因完攀关闭入口');
  const ropeDetail = createDetailPage(ropeId);
  assert.equal(ropeDetail.data.canRecordAgain, true);
  ropeDetail.recordAgain();
  assert.equal(ropeDetail.data.recordNotice, '', '绳攀仍可继续记录');
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );
  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.attempts.length, 2);
});

// ---- T015 / A2：保存中、失败与丢回执的一致状态 ----
test('T015-A2 保存中与丢回执保留原把次和重试入口，确认后原按钮位置显示「已完攀」', async () => {
  const page = createPage();
  page._saveDelayMs = 40;
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 点完攀前先就绪「下一次丢回执」：保存中 → 丢回执 → 重试确认
  page.toggleReceiptLossArm();
  const saving = page.recordAttempt({
    currentTarget: { dataset: { result: 'send' } }
  });
  const savingRow = page.data.pendingAttempts[0];
  assert.ok(savingRow, '保存中保留原把次');
  assert.equal(savingRow.isSaving, true);
  assert.equal(savingRow.statusText, '保存中…');
  assert.equal(savingRow.label, '第 2 把', '原把次编号不变');
  assert.equal(page.data.resultLocked, true, '保存中不生成新的一把');
  assert.equal(page.data.routeCompleted, false, '未确认前不算已完攀');
  assert.equal(page.data.routeClosed, true, '抱石完攀待确认即关闭新增入口');
  assert.equal(page.data.routeStateText, '完攀待确认');
  await saving;

  // 丢回执：原把次保留，可见重试入口，等待确认期间不能新增
  const lostRow = page.data.pendingAttempts[0];
  assert.ok(lostRow);
  assert.equal(lostRow.canRetry, true);
  assert.match(lostRow.statusText, /回执丢失/);
  assert.equal(page.data.attempts.length, 1, '未确认的完攀不计入已保存');
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, true);
  const lostItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(lostItem.completionText, '完攀待确认', '列表同步显示待确认');

  const opId = lostRow.opId;
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1,
    '保存端只入账一次完攀'
  );

  // 重试同一操作：确认成功后原按钮位置显示「已完攀」
  await retryPending(page, opId);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.attempts.length, 2);
  assert.equal(page.data.attempts[1].id, opId);
  assert.equal(page.data.attempts[1].resultText, '完攀');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeStateText, '已完攀');
  assert.equal(page.data.saveNotice, '');
  const doneItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(doneItem.completionText, '已完攀');
  assert.equal(
    ledgerState().records.filter(item => item.result === 'send').length,
    1,
    '重试不重复入账'
  );

  // 页面重开或跨日：不出现新增把次入口
  const reopened = createPage();
  assert.equal(reopened.data.routeCompleted, true);
  assert.equal(reopened.data.routeStateText, '已完攀');
  const reopenedDetail = createDetailPage(ROUTE_BLUE);
  assert.equal(reopenedDetail.data.canRecordAgain, false);

  // 绑定断言：按钮位置渲染的是「已完攀」面板与回看入口
  const wxml = read(PAGE_WXML);
  assert.ok(
    wxml.includes('id="route-completed-panel"'),
    '已完攀面板在原按钮位置'
  );
  assert.ok(
    wxml.includes('id="route-completed-detail"'),
    '已完攀后只留回看入口'
  );
  assert.ok(
    wxml.includes('wx:if="{{routeCompleted}}"') &&
      wxml.includes('id="record-send"'),
    '结果按钮与已完攀面板互斥渲染'
  );
  const wxss = read(PAGE_WXSS);
  assert.match(wxss, /\.route-completed-panel/, '已完攀面板样式');
  assert.match(wxss, /\.route-state-done/, '完攀标记样式');

  // 详情页绑定：已完攀不显示「今天再爬」，改在同一页脚显示状态说明
  const detailWxml = read(DETAIL_WXML);
  assert.ok(
    detailWxml.includes('wx:if="{{!isLegacy && route && canRecordAgain}}"') &&
      detailWxml.includes('id="record-again"'),
    '「今天再爬」只在可再记时出现'
  );
  assert.ok(
    detailWxml.includes('id="detail-completed-footer"'),
    '已完攀线路在同一页脚位置显示状态'
  );
  assert.match(read(DETAIL_WXSS), /\.detail-completed-footer/);
});

// ---- T015 / A3：迟到的旧页面事件与已打开的选场弹层 ----
test('T015-A3 详情迟到事件与已打开选场弹层都不新建场次、不发起尝试', async () => {
  const page = createPage();
  tapStart(page, 0);
  const firstSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 同日第二场，再回到第一场，保持当前选线为这条抱石线
  page.openSessionForm();
  page.startSession();
  const secondSessionId = page.data.activeSession.id;
  assert.notEqual(secondSessionId, firstSessionId);
  tapSession(page, firstSessionId);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.routeClosed, false, '尚未完攀时可进入选场流程');

  // 详情页打开同日选场弹层（此时线路还没完攀）
  const detail = createDetailPage(ROUTE_BLUE);
  detail.recordAgain();
  assert.ok(detail.data.sessionPicker, '同日多场先显式选场');
  assert.equal(detail.data.sessionPicker.sessions.length, 2);

  // 另一个页面实例确认这条抱石线的首次完攀
  await tapResult(page, 'send');
  assert.equal(
    store.routeCompletion(savedState(), ROUTE_BLUE).completed,
    true,
    '另一实例已确认完攀'
  );

  // 已打开的选场弹层再选中另一场：不切换归属、不新增尝试、不返回
  const attemptsBefore = savedState().attempts.length;
  const sessionsBefore = savedState().sessions.length;
  const activeBefore = savedState().activeSessionId;
  const navBefore = wxLog.navigations.length;
  detail.chooseSessionForAgain({
    currentTarget: { dataset: { sessionId: secondSessionId } }
  });
  assert.equal(detail.data.sessionPicker, null);
  assert.match(detail.data.recordNotice, /已完攀/);
  assert.equal(savedState().activeSessionId, activeBefore, '不切换场次');
  assert.equal(savedState().sessions.length, sessionsBefore, '不新建场次');
  assert.equal(savedState().attempts.length, attemptsBefore, '不发起尝试');
  assert.equal(wxLog.navigations.length, navBefore, '不返回今日页');
  assert.equal(detail.data.canRecordAgain, false, '详情随即按已完攀收起入口');

  // 迟到的「今天再爬」事件：同样不新建场次、不发起尝试
  const lateNavBefore = wxLog.navigations.length;
  detail.recordAgain();
  assert.match(detail.data.recordNotice, /已完攀/);
  assert.equal(savedState().sessions.length, sessionsBefore);
  assert.equal(savedState().attempts.length, attemptsBefore);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(wxLog.navigations.length, lateNavBefore);

  // 已完攀线路不再显示「今天再爬」入口
  const doneDetail = createDetailPage(ROUTE_BLUE);
  assert.equal(doneDetail.data.canRecordAgain, false);
  assert.equal(doneDetail.data.routeCompleted, true);
});

// ---- T015 / A4：旧夹具与旧汇总 ----
test('T015-A4 旧夹具多条历史完攀与旧汇总原样只读，今日页与详情一致', async () => {
  // 旧格式缓存：缺 climbType 的 V 级线路，历史已有三条完攀（含备注）
  const legacyState = store.createInitialState();
  legacyState.sessions.push({
    id: 'session-1',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2026-10-20',
    createdAt: new Date().toISOString()
  });
  legacyState.nextSessionSeq = 2;
  legacyState.activeSessionId = 'session-1';
  legacyState.activeRouteId = ROUTE_BLUE;
  [1, 2, 3].forEach(index => {
    legacyState.attempts.push({
      id: 'legacy-attempt-' + index,
      seq: index,
      sessionId: 'session-1',
      routeId: ROUTE_BLUE,
      result: 'send',
      note: '历史第 ' + index + ' 把',
      createdAt: new Date().toISOString()
    });
  });
  legacyState.nextAttemptSeq = 4;
  storage.set(STORE_KEY, JSON.stringify(legacyState));

  const page = createPage();
  assert.equal(page.data.loadError, '', '旧缓存仍可读');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeStateText, '已完攀');
  assert.equal(page.data.routeSendCount, 3, '历史多条完攀按原数目展示');
  const legacyItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(legacyItem.completionText, '已完攀');
  assert.equal(legacyItem.climbType, '抱石', '缺类型的旧 V 级线路按抱石读取');

  // 历史项直达详情，详情原样回看三条备注
  wxLog.navigations = [];
  page.onRouteTap({ currentTarget: { dataset: { routeId: ROUTE_BLUE } } });
  assert.equal(wxLog.navigations.length, 1);
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.attemptCount, 3, '原三条记录保持原数目');
  assert.deepEqual(
    detail.data.groups[0].attempts.map(attempt => attempt.note),
    ['历史第 1 把', '历史第 2 把', '历史第 3 把']
  );
  assert.equal(detail.data.canRecordAgain, false);
  assert.equal(detail.data.routeStateText, '已完攀');
  assert.ok(
    savedState().routes.every(route => route.climbType === undefined),
    '读取不补写类型，也不迁移'
  );

  // 之后无法新增（完攀或未完成），旧账本仍未被写
  await tapResult(page, 'send');
  await tapResult(page, 'fail');
  assert.equal(savedState().attempts.length, 3);
  assert.equal(savedState().pendingSaves.length, 0);
  assert.equal(ledgerState(), null, '被拒绝的提交不得写账本');

  // 旧汇总只读样例：今日页入口在原处，详情按原文展示，不生成逐次尝试
  assert.equal(page.data.legacySample.id, LEGACY_ROUTE);
  wxLog.navigations = [];
  page.openLegacySample();
  assert.ok(wxLog.navigations[0].url.includes(LEGACY_ROUTE));
  const legacyDetail = createDetailPage(LEGACY_ROUTE);
  assert.equal(legacyDetail.data.isLegacy, true);
  assert.equal(legacyDetail.data.attemptCountText, '0 把', '不生成 5 条逐次尝试');
  assert.equal(
    legacyDetail.data.legacySummary.summaryText,
    store.LEGACY_SUMMARY_SAMPLE.legacy.summaryText,
    '旧汇总按原文展示'
  );
  assert.equal(legacyDetail.data.canRecordAgain, false, '旧汇总无新增入口');

  // WXML 绑定：今日页完攀标记与详情状态说明都按同一份字段渲染
  const todayWxml = read(PAGE_WXML);
  assert.ok(todayWxml.includes('bindtap="onRouteTap"'), '历史项绑定完攀感知入口');
  assert.ok(
    todayWxml.includes('{{item.completionText}}') &&
      todayWxml.includes('{{routeStateText}}'),
    '今日页列表与当前线路都显示完攀标记'
  );
  const detailWxml = read(DETAIL_WXML);
  assert.ok(
    detailWxml.includes('{{routeStateText}}') &&
      detailWxml.includes('id="detail-completed-footer"'),
    '详情页显示同一份完攀状态'
  );
});

// ---- T015 / A5：待确认与已完攀分开显示，并给出回原把次的准确入口 ----
test('T015-A5 待确认与已完攀分开：详情不误报「已完攀」，跨场待确认可回到原把次重试', async () => {
  const todayWxml = read(PAGE_WXML);
  const detailWxml = read(DETAIL_WXML);

  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  const sessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 完攀点下去丢回执：这一把留在待确认，原 opId 与序号不变
  page.toggleReceiptLossArm();
  await tapResult(page, 'send');
  const pendingBefore = savedState().pendingSaves;
  assert.equal(pendingBefore.length, 1);
  const opId = pendingBefore[0].opId;
  assert.equal(pendingBefore[0].sessionId, sessionId);

  // 本场待确认：结果按钮已被待确认面板替换，而不是能点却没用的按钮
  assert.equal(page.data.routeCompleted, false, '待确认不算已完攀');
  assert.equal(page.data.routeClosed, true, '待确认即关闭新增入口');
  assert.equal(page.data.routePendingSend, true);
  assert.equal(page.data.pendingSendOtherSession, false, '本场待确认无需跳场');
  assert.equal(page.data.resultLocked, true);
  assert.match(page.data.pendingSendHint, /待确认/);

  // 详情页：同一线路与今日页读数一致，且不再把待确认渲染成「已完攀」
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routeCompleted, false);
  assert.equal(detail.data.routeClosed, true);
  assert.equal(detail.data.canRecordAgain, false);
  assert.equal(detail.data.routeStateText, '完攀待确认');
  assert.equal(detail.data.routePendingSend, true);
  assert.equal(detail.data.pendingRetry.opId, opId);
  assert.equal(detail.data.pendingRetry.sessionId, sessionId, '入口指向原把次所在场次');
  assert.equal(detail.data.pendingRetry.attemptLabel, '第 2 把');
  assert.match(detail.data.pendingRetryHint, /待确认/);

  // 旧写法（wx:elif="{{!isLegacy && route}}" 直接渲染「已完攀」）必须消失
  assert.ok(
    !/<view\s+wx:elif="\{\{!isLegacy && route\}\}"\s+id="detail-completed-footer"[\s\S]*?id="detail-completed-state"[^>]*>已完攀<\/text>/.test(
      detailWxml
    ),
    '详情底部不再用「可再记之外」的分支兜底显示「已完攀」'
  );
  assert.ok(detailWxml.includes('id="detail-pending-footer"'), '待确认页脚独立存在');
  assert.ok(detailWxml.includes('id="detail-pending-retry"'), '待确认给出重试入口');
  assert.ok(detailWxml.includes('bindtap="openPendingRetry"'));
  assert.ok(
    detailWxml.includes('wx:elif="{{!isLegacy && route && routeCompleted}}"') &&
      detailWxml.includes('wx:elif="{{!isLegacy && route && routePendingSend}}"'),
    '已完攀与待确认是两个互斥分支'
  );
  // 待确认分支里不得出现「已完攀」字样
  const pendingBlock = detailWxml.slice(
    detailWxml.indexOf('routePendingSend'),
    detailWxml.indexOf('同日多场')
  );
  assert.ok(pendingBlock.length > 0 && !pendingBlock.includes('已完攀'));
  // 今日页绑定：待确认面板与结果按钮互斥
  assert.ok(todayWxml.includes('wx:elif="{{routePendingSend}}"'));
  assert.ok(todayWxml.includes('id="route-pending-panel"'));
  assert.ok(todayWxml.includes('id="route-pending-goto"'));

  // 迟到的「今天再爬」在待确认期间不越过状态：不新建场次、不生成 opId、不导航、不开弹层
  const before = {
    sessions: savedState().sessions.length,
    attempts: savedState().attempts.length,
    pending: savedState().pendingSaves.length,
    nav: wxLog.navigations.length
  };
  detail.recordAgain();
  assert.match(detail.data.recordNotice, /待确认/);
  assert.match(detail.data.recordNotice, /第 2 把/, '说明里点名原把次');
  assert.equal(detail.data.sessionPicker, null, '待确认时不打开选场弹层');
  assert.equal(savedState().sessions.length, before.sessions);
  assert.equal(savedState().attempts.length, before.attempts);
  assert.equal(savedState().pendingSaves.length, before.pending);
  assert.equal(wxLog.navigations.length, before.nav);

  // 换到另一场次再看同一条线路：不能显示成能新增；应给出回原场次的入口
  page.openSessionForm();
  page.startSession();
  const otherSessionId = page.data.activeSession.id;
  assert.notEqual(otherSessionId, sessionId);
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, true);
  assert.equal(page.data.routePendingSend, true);
  assert.equal(page.data.pendingSendOtherSession, true, '待确认落在另一场次');
  assert.match(page.data.pendingSendHint, /2026-11-05/);
  assert.match(page.data.pendingSendHint, /第 1 场/);

  // 跨场直接点结果不生成第二个待确认（面板之外的方法兜底）
  const otherPendingBefore = savedState().pendingSaves.length;
  await tapResult(page, 'send');
  assert.equal(savedState().pendingSaves.length, otherPendingBefore, '跨场不新增待确认');
  assert.match(page.data.saveNotice, /待确认/);

  // 从另一页面/另一场次打开同一线路：详情同样识别待确认并指向原把次
  const detailFromOther = createDetailPage(ROUTE_BLUE);
  assert.equal(detailFromOther.data.routePendingSend, true);
  assert.equal(detailFromOther.data.routeCompleted, false);
  assert.equal(detailFromOther.data.pendingRetry.sessionId, sessionId);

  // 回原把次：只切换当前场次/线路，不新建场次、不生成新 opId、不发起尝试
  const gotoBefore = {
    sessions: savedState().sessions.length,
    attempts: savedState().attempts.length,
    pending: savedState().pendingSaves.length
  };
  wxLog.navigations = [];
  detailFromOther.openPendingRetry();
  assert.equal(savedState().activeSessionId, sessionId, '切换回原场次');
  assert.equal(savedState().activeRouteId, ROUTE_BLUE, '保持这条线路被选中');
  assert.equal(savedState().sessions.length, gotoBefore.sessions, '不新建场次');
  assert.equal(savedState().pendingSaves.length, gotoBefore.pending, '不生成新的 opId');
  assert.equal(savedState().pendingSaves[0].opId, opId, '仍复用原 opId');
  assert.equal(savedState().attempts.length, gotoBefore.attempts);
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(wxLog.navigations[0].type, 'navigateBack');

  // 回到今日页后可找到原把次并就地重试
  page.onShow();
  assert.equal(page.data.activeSession.id, sessionId);
  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE);
  assert.equal(page.data.pendingAttempts.length, 1, '原把次可见');
  assert.equal(page.data.pendingAttempts[0].opId, opId);
  assert.equal(page.data.pendingAttempts[0].canRetry, true);
  assert.equal(page.data.pendingAttempts[0].label, '第 2 把');

  await retryPending(page, opId);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.routePendingSend, false);
  assert.equal(page.data.routeCompleted, true, '确认后才显示已完攀');
  assert.equal(page.data.routeStateText, '已完攀');
  assert.ok(savedState().attempts.some(item => item.id === opId));
  assert.equal(
    savedState().attempts.find(item => item.id === opId).sessionId,
    sessionId,
    '完攀归属原场次'
  );
  assert.equal(
    ledgerState().records.filter(record => record.result === 'send').length,
    1,
    '重试不重复入账'
  );

  // 确认成功后详情与今日页一致显示「已完攀」，待确认入口收起
  const doneDetail = createDetailPage(ROUTE_BLUE);
  assert.equal(doneDetail.data.routeCompleted, true);
  assert.equal(doneDetail.data.routePendingSend, false);
  assert.equal(doneDetail.data.pendingRetry, null);
  assert.equal(doneDetail.data.pendingRetryHint, '');
  assert.equal(doneDetail.data.routeStateText, '已完攀');
  assert.equal(doneDetail.data.canRecordAgain, false);
  const doneItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(doneItem.completionText, '已完攀');
});

// ---- T015 / A6：绳攀待确认不升级成线路级状态，完攀后仍可记录 ----
test('T015-A6 顶绳完攀待确认只留在待确认行，不显示线路级「完攀待确认」，确认后仍可再记', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  const ropeId = createTypedRoute(page, '顶绳待确认线', '顶绳', '5.10a');

  page.toggleReceiptLossArm();
  await tapResult(page, 'send');
  assert.equal(savedState().pendingSaves.length, 1);
  const opId = savedState().pendingSaves[0].opId;

  // 绳攀没有「首次完攀」概念：待确认只体现在待确认行，不关闭入口、不出线路级标记
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false, '顶绳不因待确认关闭新增入口');
  assert.equal(page.data.routePendingSend, false, '绳攀不显示线路级待确认面板');
  assert.equal(page.data.pendingSendHint, '');
  assert.equal(page.data.routeStateText, '');
  assert.equal(page.data.resultLocked, true, '同一把仍保存中被锁定');
  const item = page.data.routes.find(route => route.id === ropeId);
  assert.equal(item.completionText, '', '列表不显示线路级待确认标记');
  assert.equal(item.isClosed, false);

  // 待确认行本身可重试，确认后原按钮位置照旧可以继续记录
  assert.equal(page.data.pendingAttempts.length, 1);
  assert.equal(page.data.pendingAttempts[0].canRetry, true);
  await retryPending(page, opId);
  assert.equal(page.data.pendingAttempts.length, 0);
  assert.equal(page.data.attempts.length, 1);
  await tapResult(page, 'send');
  assert.equal(page.data.attempts.length, 2, '绳攀完攀后仍可记录');
  assert.equal(page.data.routeCompleted, false);

  // 详情页与今日页一致：绳攀仍提供「今天再爬」，不显示待确认或已完攀页脚
  const detail = createDetailPage(ropeId);
  assert.equal(detail.data.canRecordAgain, true);
  assert.equal(detail.data.routePendingSend, false);
  assert.equal(detail.data.routeCompleted, false);
  assert.equal(detail.data.routeStateText, '');
  assert.equal(detail.data.pendingRetry, null);
});

// ---- T015 / A7：误点完攀的撤销（「改为未完成」更正原把次） ----

// 让第 n 次写客户端试用缓存的调用失败一次，用来模拟「保存端已改、本地没落盘」。
function failStoreWrites(n) {
  const original = global.wx.setStorageSync;
  let count = 0;
  global.wx.setStorageSync = function (key, value) {
    if (key === STORE_KEY) {
      count += 1;
      if (count === n) {
        throw { errMsg: 'setStorageSync:fail mock storage error' };
      }
    }
    return original.call(this, key, value);
  };
  return () => {
    global.wx.setStorageSync = original;
  };
}

test('T015-A7 误点完攀可原把改正：只翻那一把的结果，模型与账本同步，之后可再次完攀', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  await tapResult(page, 'send');

  // 给已完攀那一把补备注，核对更正后仍留在原把次上
  const sendAttempt = savedState().attempts.find(item => item.result === 'send');
  tapNote(page, sendAttempt.id);
  typeNote(page, '完攀那把的备注');
  page.saveNote();

  assert.equal(page.data.routeCompleted, true, '确认成功后仍显示「已完攀」');
  assert.equal(page.data.routeCorrectable, true, '已完攀时给出「改为未完成」入口');
  assert.equal(page.data.routeCorrectionPending, false);
  assert.equal(page.data.routeCorrectionRows.length, 1, '每一把各占一行');
  assert.equal(page.data.routeCorrectionRows[0].label, '第 3 把', '明确说清改正的是哪一把');
  assert.match(page.data.routeCorrectionRows[0].contextText, /2026-11-05/);
  assert.match(page.data.routeCorrectionRows[0].contextText, /第 1 场/);
  assert.equal(page.data.routeCorrectionRows[0].state, 'correctable');
  // 已完攀的分支只留回看与更正：不再渲染「完攀」结果按钮
  const todayWxml = read(PAGE_WXML);
  const completedBlock = todayWxml.slice(
    todayWxml.indexOf('wx:if="{{routeCompleted}}"'),
    todayWxml.indexOf('wx:elif="{{routePendingSend}}"')
  );
  assert.ok(completedBlock.length > 0);
  assert.ok(!completedBlock.includes('data-result="send"'), '已完攀后不再出现「完攀」按钮');
  assert.ok(!completedBlock.includes('data-result="fail"'), '普通「未完成」也不在已完攀分支里');
  // 更正控件逐把渲染在本场记录下方（不在结果条里），每把各自带 dataset
  const correctionCard = todayWxml.slice(
    todayWxml.indexOf('id="route-correction"'),
    todayWxml.indexOf('wx:if="{{selectedRoute && !noteEditor}}"')
  );
  assert.ok(correctionCard.includes('wx:for="{{routeCorrectionRows}}"'), '每把一行');
  assert.ok(
    correctionCard.includes('id="route-correct-{{item.attemptId}}"'),
    '每把各有一个「改为未完成」按钮'
  );
  assert.ok(correctionCard.includes('bindtap="correctSend"'));
  assert.ok(
    correctionCard.includes('data-attempt-id="{{item.context.attemptId}}"'),
    '按钮把这一把自己的原把次带进 dataset'
  );
  assert.match(read(PAGE_WXSS), /\.route-correct-button/, '更正按钮样式');

  const before = {
    attempts: savedState().attempts.length,
    sessions: savedState().sessions.length,
    ledgerRows: ledgerState().records.length,
    source: store.clone(
      savedState().attempts.find(item => item.id === sendAttempt.id)
    )
  };

  wxLog.setKeys = [];
  await tapCorrect(page);
  assert.deepEqual(
    Array.from(new Set(wxLog.setKeys)).sort(),
    [LEDGER_KEY, STORE_KEY].sort(),
    '更正只写试用数据与模拟账本，不碰照片、索引等其他键'
  );

  const state = savedState();
  assert.equal(state.attempts.length, before.attempts, '把数不变');
  assert.equal(state.sessions.length, before.sessions, '不为纠错新建场次');
  assert.equal(state.pendingCorrections.length, 0, '待更正已结清');

  const corrected = state.attempts.find(item => item.id === sendAttempt.id);
  assert.equal(corrected.result, 'fail', '原位改成未完成');
  assert.equal(corrected.id, before.source.id, '原 stable ID 不变');
  assert.equal(corrected.seq, before.source.seq, '序号不变');
  assert.equal(corrected.sessionId, before.source.sessionId, '原场次不变');
  assert.equal(corrected.createdAt, before.source.createdAt, '时间不变');
  assert.equal(corrected.note, '完攀那把的备注', '备注保留在原把次上');

  // 账本同步：同一条记录被翻成未完成，没有留下第二条，也没有新增行
  const ledger = ledgerState();
  assert.equal(ledger.records.length, before.ledgerRows, '不新增账本行');
  assert.equal(ledger.records.filter(row => row.result === 'send').length, 0);
  const ledgerRow = ledger.records.find(row => row.opId === sendAttempt.id);
  assert.equal(ledgerRow.result, 'fail');
  assert.ok(ledgerRow.correctedAt, '账本记录标出更正时间');

  // 今日页立刻一致：状态、统计与列表标记都回到未完攀
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.routeStateText, '');
  assert.equal(page.data.routeSendCount, 0);
  assert.equal(page.data.routeCorrectable, false);
  assert.equal(page.data.attempts.length, 3);
  assert.equal(page.data.attempts[2].resultText, '未完成');
  assert.equal(page.data.attempts[2].note, '完攀那把的备注');
  const listItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(listItem.completionText, '');
  assert.equal(listItem.isClosed, false);

  // 详情页统计与逐把结果立刻一致，并恢复「今天再爬」
  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routeCompleted, false);
  assert.equal(detail.data.routeStateText, '');
  assert.equal(detail.data.sendCount, 0);
  assert.equal(detail.data.canRecordAgain, true);
  assert.equal(detail.data.routeCorrectable, false);
  assert.equal(detail.data.groups[0].attempts[2].resultText, '未完成');
  assert.equal(detail.data.groups[0].attempts[2].note, '完攀那把的备注');
  const detailWxml = read(DETAIL_WXML);
  assert.ok(
    detailWxml.includes('id="detail-correct-{{attempt.id}}"'),
    '详情页每把记录各有一个更正控件'
  );
  assert.ok(detailWxml.includes('id="detail-corrected-{{attempt.id}}"'), '改完变只读结果');
  assert.ok(detailWxml.includes('bindtap="correctSend"'));
  assert.ok(
    detailWxml.includes('class="attempt-correct-slot"'),
    '控件与只读结果占同一固定高度格，改完不塌陷'
  );
  assert.ok(
    detailWxml.includes('wx:if="{{!isLegacy && route && canRecordAgain}}"') &&
      detailWxml.includes('id="record-again"'),
    '更正后详情恢复「今天再爬」'
  );

  // 之后可以正常再记并再次完攀（同一线路，新的操作 ID）
  await tapResult(page, 'send');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(savedState().attempts.length, 4, '新增第 4 把');
  assert.notEqual(savedState().attempts[3].id, sendAttempt.id);
  assert.equal(ledgerState().records.length, 4, '新的一把按新操作 ID 入账');
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    1,
    '再次完攀只入账一次'
  );
});

test('T015-A7 更正后的原账本重放与迟到操作：不复活旧完攀、不误撤后来的新完攀', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  const firstOpId = savedState().attempts[0].id;

  await tapCorrect(page);
  assert.equal(savedState().attempts[0].result, 'fail');

  // 1) 用原 opId 直接重放一次：账本按幂等返回那条已改正的记录，不复活 send
  const replay = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', firstOpId)
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.result, 'fail', '重放取回的是已改正的记录');
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0,
    '重放不新增完攀记录'
  );

  // 2) 那份旧回执照样送到页面：本地已是未完成，不得被翻回完攀
  page.finishDispatch(firstOpId, replay, {
    opId: firstOpId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    result: 'send',
    generation: ''
  });
  assert.equal(savedState().attempts.length, 1, '不新增把次');
  assert.equal(savedState().attempts[0].result, 'fail', '旧回执不复活旧完攀');
  assert.equal(savedState().pendingSaves.length, 0);

  // 3) 更正后重新完攀，再收到针对旧把次的迟到更正：不得误撤后来的新完攀
  await tapResult(page, 'send');
  const secondOpId = savedState().attempts.find(
    item => item.result === 'send'
  ).id;
  assert.notEqual(secondOpId, firstOpId);
  assert.equal(page.data.routeCompleted, true);

  const lateCorrection = server.submitCorrection({
    opId: firstOpId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    generation: savedState().generation
  });
  assert.equal(lateCorrection.ok, true);
  assert.equal(lateCorrection.duplicate, true, '迟到的更正按幂等处理');
  assert.equal(lateCorrection.alreadyCorrected, true);
  assert.equal(
    ledgerState().records.find(row => row.opId === secondOpId).result,
    'send',
    '后来的新完攀不被误撤'
  );
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    1
  );

  page.finishCorrection(firstOpId, lateCorrection, {
    attemptId: firstOpId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    generation: savedState().generation
  });
  assert.equal(
    savedState().attempts.find(item => item.id === secondOpId).result,
    'send',
    '迟到的更正回调不改动新完攀'
  );
  assert.equal(
    savedState().attempts.filter(item => item.result === 'send').length,
    1
  );
});

test('T015-A7 连点「改为未完成」只派发一次：不生成第二条待更正，也不新增把次', async () => {
  const page = createPage();
  page._saveDelayMs = 40;
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'send');
  const opId = savedState().attempts[1].id;

  // 连点同一次渲染：两次都用渲染当时带下来的上下文，第二次只复用同一条待更正。
  const rendered = correctEvent(page);
  const first = page.correctSend(rendered);
  const second = page.correctSend(rendered);
  assert.equal(savedState().pendingCorrections.length, 1, '只有一条待更正');
  assert.equal(
    savedState().pendingCorrections[0].attemptId,
    opId,
    '待更正指向原把次'
  );
  assert.equal(Object.keys(page._dispatchingCorrections).length, 1);
  assert.equal(page.data.savingCorrectionId, opId, '更正保存中');
  assert.equal(page.data.routeCorrectionSaving, true);
  assert.equal(page.data.routeCorrectionStatusText, '更正保存中…');
  assert.equal(page.data.routeCorrectable, true, '保存中仍能看到这条更正');
  assert.equal(page.data.routeCorrectable, true);
  await Promise.all([first, second]);

  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(savedState().attempts.length, 2, '连点不新增把次');
  assert.equal(savedState().attempts[1].result, 'fail');
  assert.equal(ledgerState().records.length, 2, '账本仍只有两行');
  assert.equal(ledgerState().records.filter(row => row.result === 'send').length, 0);
  assert.equal(page.data.savingCorrectionId, '', '派发状态已清空');
  assert.equal(Object.keys(page._dispatchingCorrections).length, 0);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeCorrectionPending, false);
});

test('T015-A7 更正已入账但本地写入失败：保留待更正，再点一次按同一把重试到两边一致', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  const opId = savedState().attempts[0].id;

  // 第 2 次写试用缓存（即确认后的原位改正）失败：账本已改，本地没落盘
  const restore = failStoreWrites(2);
  await tapCorrect(page);
  restore();

  assert.match(page.data.storageError, /mock storage error/);
  assert.equal(savedState().attempts[0].result, 'send', '本地仍显示已完攀');
  assert.equal(savedState().attempts.length, 1, '不新增把次');
  assert.equal(savedState().pendingCorrections.length, 1, '待更正保留在本地');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeCorrectionPending, true);
  assert.equal(page.data.routeCorrectable, true, '失败后仍可再点重试');
  assert.match(page.data.routeCorrectionStatusText, /未确认/);
  assert.match(page.data.routeCorrectionStatusText, /重试/);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0,
    '保存端账本已改正'
  );

  // 再点一次：保存端按原 opId 幂等，本地原位改正后两边一致
  await tapCorrect(page);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeCorrectionPending, false);
  assert.equal(page.data.storageError, '');
  assert.equal(ledgerState().records.length, 1, '重试不新增账本行');
  assert.equal(ledgerState().records.filter(row => row.result === 'send').length, 0);
});

test('T015-A7 历史多条完攀逐次更正：优先最近一把，读取不重写历史，旧汇总只读', async () => {
  // 旧格式缓存：缺 climbType 的 V 级线路，跨两个场次共三条历史完攀（带备注）
  const legacyState = store.createInitialState();
  legacyState.sessions.push({
    id: 'session-1',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2026-10-20',
    createdAt: new Date().toISOString()
  });
  legacyState.sessions.push({
    id: 'session-2',
    seq: 2,
    gymId: 'gym-chalkbox',
    date: '2026-10-27',
    createdAt: new Date().toISOString()
  });
  legacyState.nextSessionSeq = 3;
  legacyState.activeSessionId = 'session-1';
  legacyState.activeRouteId = ROUTE_BLUE;
  [
    { id: 'legacy-attempt-1', sessionId: 'session-1', note: '历史第 1 把' },
    { id: 'legacy-attempt-2', sessionId: 'session-1', note: '历史第 2 把' },
    { id: 'legacy-attempt-3', sessionId: 'session-2', note: '历史第 3 把' }
  ].forEach((item, index) => {
    legacyState.attempts.push({
      id: item.id,
      seq: index + 1,
      sessionId: item.sessionId,
      routeId: ROUTE_BLUE,
      result: 'send',
      note: item.note,
      createdAt: new Date().toISOString()
    });
  });
  legacyState.nextAttemptSeq = 4;
  storage.set(STORE_KEY, JSON.stringify(legacyState));

  const page = createPage();
  assert.equal(page.data.loadError, '', '旧缓存仍可读');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeCorrectable, true);
  assert.equal(page.data.routeCorrectionRows.length, 3, '三把历史完攀各占一行');
  assert.equal(
    page.data.routeCorrectionRows[0].attemptId,
    'legacy-attempt-3',
    '第一行是最近可识别的那一把'
  );
  assert.equal(page.data.routeCorrectionRows[0].label, '第 1 把');
  assert.match(page.data.routeCorrectionRows[0].contextText, /2026-10-27/);
  [
    page.data.routeCorrectionRows[1],
    page.data.routeCorrectionRows[2]
  ].forEach(row => {
    assert.equal(row.state, 'correctable', '每把都各自带一个控件');
    assert.ok(row.context.attemptId, '每把都带自己的原把次 dataset');
  });

  const routesBefore = JSON.stringify(savedState().routes);
  await tapCorrect(page);

  let state = savedState();
  assert.equal(state.attempts.length, 3, '把数不变');
  assert.equal(state.attempts.find(item => item.id === 'legacy-attempt-3').result, 'fail');
  assert.equal(state.attempts.find(item => item.id === 'legacy-attempt-1').result, 'send');
  assert.equal(state.attempts.find(item => item.id === 'legacy-attempt-2').result, 'send');
  assert.equal(
    state.attempts.find(item => item.id === 'legacy-attempt-1').note,
    '历史第 1 把',
    '其他历史把次的备注不动'
  );
  assert.equal(state.sessions.length, 2, '不为纠错新建场次');
  assert.equal(JSON.stringify(state.routes), routesBefore, '读取不补写类型、不迁移');
  assert.equal(ledgerRows(), 0, '旧数据本就没有账本行，更正不凭空空建一行');
  assert.equal(page.data.routeCompleted, true, '还有两把完攀');
  assert.equal(page.data.routeSendCount, 2);
  // 已改的那一行留在原位置变成只读结果，下一把仍是自己那一行，没有被补位
  assert.equal(page.data.routeCorrectionRows.length, 3);
  assert.equal(page.data.routeCorrectionRows[0].attemptId, 'legacy-attempt-3');
  assert.equal(page.data.routeCorrectionRows[0].state, 'corrected');
  assert.equal(
    page.data.routeCorrectionRows[0].context,
    null,
    '只读结果行没有 dataset，点不出第二次写操作'
  );
  assert.equal(page.data.routeCorrectionRows[1].attemptId, 'legacy-attempt-2');
  assert.equal(page.data.routeCorrectionRows[1].state, 'correctable');

  // 另一把必须**显式再点它自己那一行**才会更正
  await tapCorrectFor(page, 'legacy-attempt-2');
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-2').result,
    'fail'
  );
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-1').result,
    'send',
    '没点的最后一把仍然保留'
  );
  assert.equal(page.data.routeSendCount, 1);

  await tapCorrectFor(page, 'legacy-attempt-1');
  state = savedState();
  assert.equal(state.attempts.filter(item => item.result === 'send').length, 0);
  assert.equal(state.pendingCorrections.length, 0);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeCorrectable, false, '没有可点的控件后不再给更正入口');
  assert.equal(page.data.routeStateText, '');
  assert.equal(
    page.data.routeCorrectionRows.filter(row => row.state === 'corrected').length,
    3,
    '三把都留在原位显示只读结果'
  );
  // 三条历史完攀都有明细，改完后可以正常再记
  await tapResult(page, 'fail');
  assert.equal(savedState().attempts.length, 4);

  // 旧汇总样例仍只读：没有逐次尝试，也没有更正入口
  const legacyDetail = createDetailPage(LEGACY_ROUTE);
  assert.equal(legacyDetail.data.isLegacy, true);
  assert.equal(legacyDetail.data.routeCorrectable, false);
  assert.equal(legacyDetail.data.canRecordAgain, false);
});

test('T015-A7 更正只作用于这条抱石的已确认完攀：不碰未确认重试、绳攀与同色另一条', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');

  // 完攀还没确认：不提供更正，仍走原把次重试
  page.toggleReceiptLossArm();
  await tapResult(page, 'send');
  const pendingOpId = savedState().pendingSaves[0].opId;
  assert.equal(page.data.routePendingSend, true);
  assert.equal(page.data.routeCorrectable, false, '未确认的完攀不给更正入口');

  const before = {
    attempts: savedState().attempts.length,
    pending: savedState().pendingSaves.length,
    ledgerSend: ledgerState().records.filter(row => row.result === 'send').length
  };
  // 未确认时根本没有控件；即便按旧渲染构造一个空 dataset 也不挑「最新一把」
  await page.correctSend({ currentTarget: { dataset: {} } });
  assert.equal(savedState().attempts.length, before.attempts, '不新增把次');
  assert.equal(savedState().pendingSaves.length, before.pending, '不消费原待确认');
  assert.equal(savedState().pendingCorrections.length, 0, '未确认时不生成待更正');
  assert.match(page.data.saveNotice, /没有可改正的已确认完攀/);

  // 确认后才可更正；同色同级另一条线路始终不受影响
  await retryPending(page, pendingOpId);
  assert.equal(page.data.routeCorrectable, true);
  const balanceItem = page.data.routes.find(
    route => route.id === ROUTE_BLUE_BALANCE
  );
  assert.equal(balanceItem.completionText, '');
  assert.equal(balanceItem.isClosed, false);

  await tapCorrect(page);
  assert.equal(page.data.routeCompleted, false);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0
  );
  // 同色同级另一条仍能正常记一把
  page.onRouteTap({ currentTarget: { dataset: { routeId: ROUTE_BLUE_BALANCE } } });
  await tapResult(page, 'fail');
  assert.equal(
    savedState().attempts.filter(item => item.routeId === ROUTE_BLUE_BALANCE).length,
    1
  );

  // 顶绳、先锋没有「首次完攀」概念：不给更正入口，完攀后仍可继续记
  const ropePage = createPage();
  tapStart(ropePage, 0, '2026-11-05');
  const ropeId = createTypedRoute(ropePage, '顶绳更正检查线', '顶绳', '5.10a');
  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.routeCompleted, false);
  assert.equal(ropePage.data.routeCorrectable, false, '绳攀没有「改为未完成」更正');

  const ropeBefore = savedState().attempts.filter(
    item => item.routeId === ropeId
  ).length;
  await tapCorrect(ropePage);
  assert.equal(
    savedState().attempts.filter(item => item.routeId === ropeId).length,
    ropeBefore,
    '绳攀的完攀不被更正'
  );
  assert.equal(
    savedState().attempts.filter(
      item => item.routeId === ropeId && item.result === 'send'
    ).length,
    1,
    '绳攀完攀仍原样保留'
  );
  await tapResult(ropePage, 'send');
  assert.equal(ropePage.data.attempts.length, 2, '绳攀完攀后仍可记录');
});

test('T015-A7 更正不跨用户、数据集与线路：跨线路/跨场次/别的归属与重置后的请求都拒绝', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  const opId = savedState().attempts[0].id;
  const generation = savedState().generation;

  const untouched = () => {
    const attempt = savedState().attempts[0];
    assert.equal(attempt.result, 'send', '试用数据里的原把次未被改动');
    assert.equal(
      ledgerState().records.filter(row => row.result === 'send').length,
      1,
      '账本里的完攀未被改动'
    );
    assert.equal(ledgerState().records.length, 1);
  };

  // 跨线路：把这条线的原把次报到同岩馆另一条抱石线
  const crossRoute = server.submitCorrection({
    opId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE_BALANCE,
    generation
  });
  assert.equal(crossRoute.ok, false);
  assert.equal(crossRoute.opIdConflict, true);
  untouched();

  // 跨场次：把原把次报到另一个场次
  const crossSession = server.submitCorrection({
    opId,
    sessionId: 'session-999',
    routeId: ROUTE_BLUE,
    generation
  });
  assert.equal(crossSession.ok, false);
  assert.equal(crossSession.opIdConflict, true);
  untouched();

  // 跨用户：账本里同 opId 的记录属于别的虚构归属
  storage.set(
    LEDGER_KEY,
    JSON.stringify({
      version: server.LEDGER_VERSION,
      records: [
        {
          opId,
          sessionId: 'session-1',
          routeId: ROUTE_BLUE,
          result: 'send',
          note: '',
          receivedAt: new Date().toISOString(),
          ownerId: 'trial-owner-other',
          datasetId: 'trial-dataset-other',
          generation
        }
      ],
      loseNextReceipt: false
    })
  );
  const foreignOwner = server.submitCorrection({
    opId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    generation
  });
  assert.equal(foreignOwner.ok, false);
  assert.equal(foreignOwner.opIdConflict, true);
  assert.equal(
    ledgerState().records[0].result,
    'send',
    '别的归属的账本记录未被改动'
  );
  assert.equal(ledgerState().records[0].correctedAt, undefined);

  // 缺少原把次归属字段的请求直接拒绝
  assert.match(server.submitCorrection({ opId }).error, /场次归属/);

  // 重置到新数据集后：旧编号空间的更正一律拒绝，也不动新数据
  assert.equal(
    page.applyTrialReset(trialProfile.nextTrialDatasetId(page.state.datasetId)),
    true
  );
  assert.equal(savedState().attempts.length, 0, '重置清空场次与尝试');
  const stale = server.submitCorrection({
    opId,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE,
    generation
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0,
    '旧请求不写新账本'
  );

  // 迟到的更正回执也不能把旧快照写进新数据
  const writesBefore = wxLog.setKeys.length;
  page.finishCorrection(
    opId,
    {
      ok: true,
      duplicate: false,
      correctedLedger: true,
      record: { opId, result: 'fail' }
    },
    { attemptId: opId, sessionId: 'session-1', routeId: ROUTE_BLUE, generation }
  );
  assert.equal(savedState().attempts.length, 0, '迟到回调不写新数据');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(wxLog.setKeys.length, writesBefore, '不写回任何旧快照');
});

test('T015-A7 更正目标以试用数据为准：未确认的完攀不能被更正，只能先重试原把次', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  page.toggleReceiptLossArm();
  await tapResult(page, 'send');

  // 保存端账本已入账，但客户端还没确认：这时不允许把这一把改成未完成，
  // 否则会用旧快照在本地复活一条完攀。
  const pending = savedState().pendingSaves[0];
  const tooEarly = server.submitCorrection({
    opId: pending.opId,
    sessionId: pending.sessionId,
    routeId: ROUTE_BLUE,
    generation: savedState().generation
  });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.correctionMissing, true);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    1,
    '账本里的完攀保留'
  );

  // 先重试原把次确认，再更正：两边都只剩未完成
  await retryPending(page, pending.opId);
  assert.equal(page.data.routeCompleted, true);
  await tapCorrect(page);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0
  );
  assert.equal(page.data.routeCompleted, false);
});

test('T015-A7 详情页更正跨天历史完攀：不为纠错新建今天场次，返回今日页后立刻一致', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'fail');
  await tapResult(page, 'fail');
  await tapResult(page, 'send');
  const sendOpId = savedState().attempts[2].id;

  // 同日之外新开一场并保持这条线路被选中：完攀标记是线路级的，跨场仍显示
  page.openSessionForm();
  page.startSession();
  const otherSessionId = page.data.activeSession.id;
  tapRoute(page, ROUTE_BLUE);
  assert.equal(page.data.attempts.length, 0, '这一场还没有把次');
  assert.equal(page.data.routeCompleted, true, '跨天历史完攀仍是线路级状态');
  assert.equal(page.data.routeCorrectable, true);
  assert.equal(page.data.routeCorrectionRows.length, 1, '这条线只有一把可更正');
  assert.match(page.data.routeCorrectionRows[0].contextText, /2026-11-05/);

  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routeCompleted, true);
  assert.equal(detail.data.canRecordAgain, false);
  assert.equal(detail.data.routeCorrectable, true);
  assert.equal(detail.data.routeCorrectionRows[0].label, '第 3 把');
  assert.match(detail.data.routeCorrectionRows[0].contextText, /2026-11-05/);
  // 控件渲染在那一把记录自己那一行上
  const detailRow = renderedCorrectionControls(detail)[0];
  assert.equal(detailRow.attemptId, sendOpId);
  assert.equal(detailRow.state, 'correctable');
  assert.equal(detail.data.routeCorrectionPending, false);

  const sessionsBefore = savedState().sessions.length;
  wxLog.setKeys = [];
  await tapCorrect(detail);

  // 不为纠错新建/切换场次，只改原把次
  assert.equal(savedState().sessions.length, sessionsBefore);
  assert.equal(savedState().activeSessionId, otherSessionId, '当前场次不被更正改动');
  assert.equal(savedState().attempts.length, 3);
  assert.equal(
    savedState().attempts.find(item => item.id === sendOpId).result,
    'fail'
  );
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.deepEqual(
    Array.from(new Set(wxLog.setKeys)).sort(),
    [LEDGER_KEY, STORE_KEY].sort()
  );

  // 详情立刻一致：统计、逐把结果与入口同时更新
  assert.equal(detail.data.routeCompleted, false);
  assert.equal(detail.data.routeStateText, '');
  assert.equal(detail.data.sendCount, 0);
  assert.equal(detail.data.routeCorrectable, false);
  assert.equal(detail.data.canRecordAgain, true, '更正后详情恢复「今天再爬」');
  assert.equal(detail.data.groups[0].attempts[2].resultText, '未完成');

  // 今日页返回后立刻一致
  page.onShow();
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeStateText, '');
  assert.equal(page.data.routeCorrectable, false);
  const listItem = page.data.routes.find(route => route.id === ROUTE_BLUE);
  assert.equal(listItem.completionText, '');

  // 更正后可以正常再记并再次完攀，仍然不新建场次
  detail.recordAgain();
  assert.equal(savedState().sessions.length, sessionsBefore, '沿用已有场次');
  assert.equal(savedState().activeSessionId, otherSessionId);
  assert.equal(savedState().activeRouteId, ROUTE_BLUE);
  assert.equal(
    wxLog.navigations[wxLog.navigations.length - 1].type,
    'navigateBack'
  );

  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  assert.equal(page.data.routeCompleted, true);
  assert.equal(savedState().attempts.length, 4);
  assert.equal(savedState().sessions.length, sessionsBefore);
});

test('T015-A7 详情页更正丢回执：保留待更正与重试入口，重试后两边只剩未完成', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');

  const detail = createDetailPage(ROUTE_BLUE);
  assert.equal(detail.data.routeCorrectable, true);

  // 就绪「下一次丢失回执」：账本已改成未完成，详情没收到确认
  page.toggleReceiptLossArm();
  await tapCorrect(detail);

  assert.equal(savedState().attempts[0].result, 'send', '本地仍显示已完攀');
  assert.equal(savedState().attempts.length, 1, '不新增把次');
  assert.equal(savedState().pendingCorrections.length, 1, '待更正保留');
  assert.equal(detail.data.routeCorrectionPending, true);
  assert.equal(detail.data.routeCorrectable, true, '失败后仍可重试');
  assert.match(detail.data.routeCorrectionStatusText, /未确认/);
  assert.match(detail.data.recordNotice, /回执丢失/);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0,
    '账本已改成未完成'
  );

  // 重试沿用同一把：保存端幂等，本地原位改正
  await tapCorrect(detail);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(detail.data.routeCompleted, false);
  assert.equal(detail.data.routeCorrectionPending, false);
  assert.equal(detail.data.canRecordAgain, true);
  assert.equal(ledgerState().records.length, 1, '重试不新增账本行');
  assert.equal(ledgerState().records.filter(row => row.result === 'send').length, 0);
  // 今日页返回后共用同一份判定，不依赖任何页面内的临时标记
  assert.equal(store.routeCompletion(savedState(), ROUTE_BLUE).completed, false);
  page.onShow();
  assert.equal(page.data.routeCompleted, false, '今日页共用同一份判定');
  assert.equal(page.data.routeCorrectable, false);
});

test('T015-A7 更正入口把渲染当时的原把次带进 dataset；参数缺失或过时不挑最新一把', async () => {
  // WXML：每个控件把**这一把**的原把次与线路/场次/世代/数据集/归属一起传进 dataset。
  // data-attempt-id → dataset.attemptId（其余同上），correctSend 只按这份上下文改正。
  const todayWxml = read(PAGE_WXML);
  const todayCard = todayWxml.slice(
    todayWxml.indexOf('id="route-correction"'),
    todayWxml.indexOf('wx:if="{{selectedRoute && !noteEditor}}"')
  );
  [
    'data-attempt-id="{{item.context.attemptId}}"',
    'data-route-id="{{item.context.routeId}}"',
    'data-session-id="{{item.context.sessionId}}"',
    'data-generation="{{item.context.generation}}"',
    'data-dataset-id="{{item.context.datasetId}}"',
    'data-owner-id="{{item.context.ownerId}}"'
  ].forEach(attr => {
    assert.ok(todayCard.includes(attr), '今日页更正控件带上 ' + attr);
  });
  assert.ok(todayCard.includes('bindtap="correctSend"'));

  const detailWxml = read(DETAIL_WXML);
  const detailButton = detailWxml.slice(
    detailWxml.indexOf('id="detail-correct-{{attempt.id}}"'),
    detailWxml.indexOf('</button>', detailWxml.indexOf('id="detail-correct-{{attempt.id}}"'))
  );
  [
    'data-attempt-id="{{attempt.correctionContext.attemptId}}"',
    'data-route-id="{{attempt.correctionContext.routeId}}"',
    'data-session-id="{{attempt.correctionContext.sessionId}}"',
    'data-generation="{{attempt.correctionContext.generation}}"',
    'data-dataset-id="{{attempt.correctionContext.datasetId}}"',
    'data-owner-id="{{attempt.correctionContext.ownerId}}"'
  ].forEach(attr => {
    assert.ok(detailButton.includes(attr), '详情页更正控件带上 ' + attr);
  });
  assert.ok(detailButton.includes('bindtap="correctSend"'));

  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  const attemptId = savedState().attempts[0].id;

  // 渲染当时写下的就是这一把的完整上下文（外部探针可按这几个字段构造事件）
  assert.deepEqual(page.data.routeCorrectionRows[0].context, {
    attemptId,
    routeId: ROUTE_BLUE,
    sessionId: savedState().activeSessionId,
    generation: savedState().generation,
    datasetId: savedState().datasetId,
    ownerId: trialProfile.TRIAL_OWNER_ID
  });

  // 缺参数：不回落到「最新一把」，也不改动任何数据
  await page.correctSend();
  assert.equal(savedState().attempts[0].result, 'send', '无事件时不挑最新一把');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.match(page.data.saveNotice, /没有可改正的已确认完攀/);
  await page.correctSend({ currentTarget: { dataset: {} } });
  assert.equal(savedState().attempts[0].result, 'send', '空 dataset 同样不改动');

  // 过时的编号空间（重置/切换前的渲染）同样不改动
  const rendered = correctEvent(page);
  await page.correctSend({
    currentTarget: {
      dataset: Object.assign({}, rendered.currentTarget.dataset, {
        generation: 'gen-before-reset'
      })
    }
  });
  assert.equal(savedState().attempts[0].result, 'send', '旧世代不改动');
  assert.match(page.data.saveNotice, /未做更正/);

  // 跨线路的旧渲染（把这一把报到同色另一条线）：冲突，不改动
  await page.correctSend({
    currentTarget: {
      dataset: Object.assign({}, rendered.currentTarget.dataset, {
        routeId: ROUTE_BLUE_BALANCE
      })
    }
  });
  assert.equal(savedState().attempts[0].result, 'send', '跨线路不改动');
  assert.match(page.data.saveNotice, /不属于当前线路/);

  // 真实点按仍能改正这一把，且只写试用数据与账本
  wxLog.setKeys = [];
  await page.correctSend(rendered);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(savedState().attempts.length, 1);
  assert.deepEqual(
    Array.from(new Set(wxLog.setKeys)).sort(),
    [LEDGER_KEY, STORE_KEY].sort()
  );
});

test('T015-A7 旧页面的旧按钮只更正渲染当时的把次，不改后来的新完攀', async () => {
  const pageA = createPage();
  tapStart(pageA, 0, '2026-11-05');
  tapRoute(pageA, ROUTE_BLUE);
  await tapResult(pageA, 'send');
  const firstId = savedState().attempts[0].id;

  // 页面 B 在这一把仍是完攀时渲染，并留下渲染当时的事件
  const pageB = createPage();
  assert.equal(pageB.data.routeCorrectable, true);
  assert.equal(pageB.data.routeCorrectionRows[0].attemptId, firstId);
  const staleEvent = correctEvent(pageB);

  // 页面 A 先改正第一把，再记一条新的完攀
  await tapCorrect(pageA);
  assert.equal(savedState().attempts[0].result, 'fail');
  await tapResult(pageA, 'send');
  const secondId = savedState().attempts[1].id;
  assert.notEqual(secondId, firstId);
  assert.equal(savedState().attempts[1].result, 'send');

  // 旧页面 B 用旧事件再点：不能把新完攀改成未完成
  await pageB.correctSend(staleEvent);
  assert.equal(
    savedState().attempts.find(item => item.id === secondId).result,
    'send',
    '旧按钮不改后来的新完攀'
  );
  assert.equal(
    savedState().attempts.find(item => item.id === firstId).result,
    'fail'
  );
  assert.equal(savedState().attempts.length, 2, '不新增把次');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.match(pageB.data.saveNotice, /已经是未完成|未改动/);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    1,
    '账本里只留后来的那一条完攀'
  );
});

test('T015-A7 两条历史完攀各占一行：改一把后另一把留在自己那行，旧事件重放不牵动它', async () => {
  const legacyState = store.createInitialState();
  legacyState.sessions.push({
    id: 'session-1',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2026-10-20',
    createdAt: new Date().toISOString()
  });
  legacyState.nextSessionSeq = 2;
  legacyState.activeSessionId = 'session-1';
  legacyState.activeRouteId = ROUTE_BLUE;
  ['legacy-attempt-1', 'legacy-attempt-2'].forEach((id, index) => {
    legacyState.attempts.push({
      id,
      seq: index + 1,
      sessionId: 'session-1',
      routeId: ROUTE_BLUE,
      result: 'send',
      note: '',
      createdAt: new Date().toISOString()
    });
  });
  legacyState.nextAttemptSeq = 3;
  storage.set(STORE_KEY, JSON.stringify(legacyState));

  const page = createPage();
  assert.equal(page.data.routeCorrectionRows.length, 2, '两把各占一行');
  assert.equal(
    page.data.routeCorrectionRows[0].attemptId,
    'legacy-attempt-2',
    '第一行是最近可识别的那一把'
  );
  assert.equal(page.data.routeCorrectionRows[1].attemptId, 'legacy-attempt-1');
  const staleEvent = correctEvent(page);

  await tapCorrect(page);
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-2').result,
    'fail'
  );
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-1').result,
    'send'
  );
  // 已改的那一行留在原位变成只读结果；另一把仍是自己那行、自己的控件
  assert.equal(page.data.routeCorrectionRows[0].attemptId, 'legacy-attempt-2');
  assert.equal(page.data.routeCorrectionRows[0].state, 'corrected');
  assert.equal(page.data.routeCorrectionRows[1].attemptId, 'legacy-attempt-1');
  assert.equal(page.data.routeCorrectionRows[1].state, 'correctable');
  // 原坐标已不可点：第二击取不到控件，也就没有写操作
  assert.equal(correctEventAt(page, 0), null, '同一位置不再是可点控件');

  // 再投递同一条旧事件：另一把保持完攀，编号空间也不受影响
  await page.correctSend(staleEvent);
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-1').result,
    'send',
    '另一把不被同一条旧事件牵动'
  );
  assert.equal(savedState().attempts.length, 2);
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(ledgerRows(), 0, '旧数据本就没有账本行，更正不凭空空建一行');

  // 要改另一把，必须显式点它自己那一行
  await tapCorrectFor(page, 'legacy-attempt-1');
  assert.equal(
    savedState().attempts.find(item => item.id === 'legacy-attempt-1').result,
    'fail'
  );
  assert.equal(store.routeCompletion(savedState(), ROUTE_BLUE).completed, false);
  assert.equal(ledgerRows(), 0);
});

test('T015-A7 早于账本的本地完攀：更正后重放原完攀不重新入账，新把与再完攀都正常', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');
  const source = savedState().attempts[0];
  const generation = savedState().generation;

  // 模拟早于账本的早期本地数据：真实 ID 与场次都在，账本里却没有这一把
  const ledger = ledgerState();
  ledger.records = [];
  storage.set(LEDGER_KEY, JSON.stringify(ledger));

  await tapCorrect(page);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(savedState().attempts.length, 1);
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(ledgerRows(), 0, '本地把次照样更正，但不凭空补建账本行');

  // 原 opId 的原请求迟到：不得在账本里重新长出完攀
  const replay = server.submitOperation(
    submitContext(ROUTE_BLUE, 'send', source.id, { generation })
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.alreadyCorrected, true, '按已改正的本地结果结清');
  assert.equal(ledgerRows(), 0, '迟到原请求不重新入账');
  assert.equal(store.routeCompletion(savedState(), ROUTE_BLUE).closed, false);

  // 迟到的原请求也不锁死这条线路：正常新把与再次完攀都能记
  await tapResult(page, 'fail');
  assert.equal(savedState().attempts.length, 2);
  await tapResult(page, 'send');
  assert.equal(savedState().attempts.length, 3);
  assert.equal(savedState().attempts[2].result, 'send');
  assert.equal(store.routeCompletion(savedState(), ROUTE_BLUE).completed, true);
  assert.equal(ledgerRows(), 2, '新把按新 opId 正常入账');
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    1,
    '再次完攀只入账一次'
  );

  // 同 opId 换到别的线路仍是操作 ID 冲突，不会误当确认
  const copied = server.submitOperation(
    submitContext(ROUTE_BLUE_BALANCE, 'send', source.id, { generation })
  );
  assert.equal(copied.ok, false);
  assert.equal(copied.opIdConflict, true);
  assert.equal(ledgerRows(), 2);
});

// ---- T015 / A7 返工回归：控件逐把绑定，同一个位置不会自动接上下一把 ----

// QA 复现的旧数据：同一条抱石线两笔既有完攀（11-08 与 11-05），跨两个场次，
// 账本里没有对应行（旧数据早于账本）。账号笔数与备注也照原样保留。
function seedTwoLegacySends() {
  const state = store.createInitialState();
  state.sessions.push({
    id: 'session-1',
    seq: 1,
    gymId: 'gym-chalkbox',
    date: '2026-11-05',
    createdAt: '2026-11-09T06:51:45.211Z'
  });
  state.sessions.push({
    id: 'session-2',
    seq: 2,
    gymId: 'gym-chalkbox',
    date: '2026-11-08',
    createdAt: '2026-11-09T06:51:45.216Z'
  });
  state.nextSessionSeq = 3;
  state.activeSessionId = 'session-1';
  state.activeRouteId = ROUTE_BLUE_BALANCE;
  state.attempts.push({
    id: 'attempt-5',
    seq: 5,
    sessionId: 'session-1',
    routeId: ROUTE_BLUE_BALANCE,
    result: 'send',
    note: 'QA 早期本地完攀 4',
    createdAt: '2026-11-05T07:34:05.000Z'
  });
  state.attempts.push({
    id: 'attempt-6',
    seq: 6,
    sessionId: 'session-2',
    routeId: ROUTE_BLUE_BALANCE,
    result: 'send',
    note: 'QA 早期本地完攀 5',
    createdAt: '2026-11-08T07:18:25.000Z'
  });
  state.nextAttemptSeq = 7;
  storage.set(STORE_KEY, JSON.stringify(state));
  return state;
}

test('T015-A7 返工：详情页两笔旧完攀，第一击改 6；同坐标第二击取不到控件，5 保持完攀', async () => {
  seedTwoLegacySends();
  const detail = createDetailPage(ROUTE_BLUE_BALANCE);

  assert.equal(detail.data.routeCompleted, true);
  assert.equal(detail.data.routeCorrectable, true);
  // 每把一行：两行都有各自的控件与 dataset（控件渲染在那一把记录自己那一行）
  let controls = renderedCorrectionControls(detail);
  assert.equal(controls.length, 2, '两把各占一行');
  assert.equal(controls[0].attemptId, 'attempt-6', '第一行是最近的一把');
  assert.equal(controls[1].attemptId, 'attempt-5');
  assert.ok(controls[0].context && controls[1].context, '每把都带自己的原把次');

  const sessionsBefore = savedState().sessions.length;
  const attemptsBefore = savedState().attempts.length;

  // 第一击：用第一个绑定控件的真实 dataset（渲染当时的那一把）
  await detail.correctSend(correctEventAt(detail, 0));
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-6').result,
    'fail'
  );
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send',
    '没点的那一笔保持完攀'
  );
  assert.equal(savedState().pendingCorrections.length, 0);

  // 重新渲染后从「同一位置」取实际可用控件：已是只读结果，没有可点控件
  controls = renderedCorrectionControls(detail);
  assert.equal(controls.length, 2, '改过的那行不塌陷，两行都还在');
  assert.equal(controls[0].attemptId, 'attempt-6', '位置稳定：原位置仍是刚改的那一把');
  assert.equal(controls[0].state, 'corrected', '原位置变成只读结果');
  assert.equal(controls[0].context, null, '只读结果行没有 dataset');
  assert.equal(controls[1].attemptId, 'attempt-5', '下一把没有被补到上一把的位置');
  assert.equal(controls[1].state, 'correctable');
  assert.equal(correctEventAt(detail, 0), null, '同坐标第二击取不到控件');
  // 还有一把完攀：线路状态徽标不变（detail-route-state 仍在），
  // 所以控件上方的布局不变化，第二击的坐标语义与第一击一致。
  assert.equal(detail.data.routeCompleted, true);
  assert.equal(detail.data.routeStateText, '已完攀');

  // Windows 真实双击的第二击：落在原坐标 → 没有控件，不构成写操作
  await tapCorrect(detail, 0);
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send',
    '第二击不会落到 5'
  );
  assert.equal(
    savedState().attempts.filter(item => item.result === 'fail').length,
    1,
    '一次连续点击只改所示的那一笔'
  );
  assert.equal(savedState().attempts.length, attemptsBefore, '不新增把次');
  assert.equal(savedState().sessions.length, sessionsBefore, '不新建场次');

  // 刷新 / onShow 也不把刚改过的下一把重置到同一位置
  detail.onShow();
  assert.equal(
    renderedCorrectionControls(detail)[0].attemptId,
    'attempt-6',
    'onShow 后原位置仍是刚改的那一把'
  );
  assert.equal(correctEventAt(detail, 0), null);
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send'
  );

  // 下一把要显式再点它自己那一行
  await tapCorrectFor(detail, 'attempt-5');
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'fail'
  );
  assert.equal(detail.data.routeCorrectable, false, '没有可点控件后不再给入口');
  assert.equal(detail.data.canRecordAgain, true, '两笔都改完后恢复「今天再爬」');
  assert.equal(detail.data.routeCorrectionRows.length, 2);
  assert.equal(
    detail.data.routeCorrectionRows.filter(row => row.state === 'corrected').length,
    2,
    '两把都留在原位显示只读结果'
  );
});

test('T015-A7 返工：今日页两笔旧完攀，第一击改 6；同坐标第二击不新增把次也不重开场次', async () => {
  seedTwoLegacySends();
  const page = createPage();

  assert.equal(page.data.selectedRoute.id, ROUTE_BLUE_BALANCE);
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeCorrectable, true);

  let controls = renderedCorrectionControls(page);
  assert.equal(controls.length, 2, '两把各占一行');
  assert.equal(controls[0].attemptId, 'attempt-6');
  assert.equal(controls[1].attemptId, 'attempt-5');

  const attemptsBefore = savedState().attempts.length;
  const sessionsBefore = savedState().sessions.length;

  // 第一击：第一个绑定控件的真实 dataset
  await tapCorrect(page, 0);
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-6').result,
    'fail'
  );
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send',
    '没点的那一笔保持完攀'
  );

  // 重新渲染后同一位置已是只读结果，下一把仍是自己那一行
  controls = renderedCorrectionControls(page);
  assert.equal(controls[0].attemptId, 'attempt-6');
  assert.equal(controls[0].state, 'corrected');
  assert.equal(controls[1].attemptId, 'attempt-5');
  assert.equal(controls[1].state, 'correctable');
  assert.equal(correctEventAt(page, 0), null, '同坐标第二击取不到控件');
  // 还有一把完攀：线路状态徽标与把数文案都不变，控件上方布局不动
  assert.equal(page.data.routeCompleted, true);
  assert.equal(page.data.routeStateText, '已完攀');

  // 真实第二击：原坐标已不可点 → 既不新增把次，也不重开场次
  await tapCorrect(page, 0);
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send'
  );
  assert.equal(savedState().attempts.length, attemptsBefore, '不新增把次');
  assert.equal(savedState().sessions.length, sessionsBefore, '不重开场次');
  assert.equal(savedState().activeSessionId, 'session-1', '当前场次不被牵动');
  assert.equal(savedState().pendingCorrections.length, 0);

  // 刷新（onShow）后仍不把下一把接到同一位置
  page.onShow();
  assert.equal(renderedCorrectionControls(page)[0].attemptId, 'attempt-6');
  assert.equal(correctEventAt(page, 0), null);
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'send'
  );

  // 下一把必须显式点它自己那一行
  await tapCorrectFor(page, 'attempt-5');
  assert.equal(
    savedState().attempts.find(item => item.id === 'attempt-5').result,
    'fail'
  );
  assert.equal(page.data.routeCorrectable, false, '没有可点控件后不再给更正入口');
  assert.equal(page.data.routeCorrectionRows.length, 2, '改完两把后卡片仍在（位置稳定）');
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeClosed, false);
  // 继续记录的入口清楚：底部的「未完成/完攀」结果按钮回来了
  assert.ok(read(PAGE_WXML).includes('id="record-send"'));
  assert.ok(read(PAGE_WXML).includes('id="record-fail"'));
});

test('T015-A7 返工：仅一笔完攀时快速连点只改一次，不新增把次、不重开场次', async () => {
  const page = createPage();
  tapStart(page, 0, '2026-11-05');
  tapRoute(page, ROUTE_BLUE);
  await tapResult(page, 'send');

  const attemptsBefore = savedState().attempts.length;
  const sessionsBefore = savedState().sessions.length;
  assert.equal(page.data.routeCorrectionRows.length, 1, '只有一笔可更正');

  // 快速双点：第一击用真实 dataset；第二击发生在重新渲染之后，同坐标已无控件
  const first = correctEventAt(page, 0);
  assert.ok(first, '第一击有可点控件');
  await page.correctSend(first);
  assert.equal(savedState().attempts[0].result, 'fail');
  assert.equal(correctEventAt(page, 0), null, '重新渲染后同坐标没有控件');
  await tapCorrect(page, 0);

  assert.equal(savedState().attempts.length, attemptsBefore, '不新增把次');
  assert.equal(savedState().sessions.length, sessionsBefore, '不重开场次');
  assert.equal(savedState().pendingCorrections.length, 0);
  assert.equal(
    ledgerState().records.filter(row => row.result === 'send').length,
    0,
    '账本里没有残留完攀'
  );
  assert.equal(page.data.routeCompleted, false);
  assert.equal(page.data.routeCorrectable, false);
  // 继续记录的入口清楚
  assert.equal(page.data.routeClosed, false);
  assert.equal(page.data.resultLocked, false);
});
