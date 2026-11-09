/**
 * T020 9c 攀岩体能自测回归测试（分项阈值、总分对照、页面主流程与本机隔离）
 *
 * 分两层验证：
 * 1) 计算层：直接驱动 utils/fitness-test.js，用原方案的分项档位、21 行总分对照表、
 *    两组 60 kg 夹具与边界值（未测 / 已测未达 / 自重成功 / 封顶 / 体重非法）核对分数；
 * 2) 页面层：直接加载正式页面文件（pages/fitness-test/fitness-test.js 与
 *    pages/profile/profile.js），捕获 Page(...) 定义，用隔离的微信本地存储替身与
 *    故障注入驱动真实页面处理器，并核对 WXML 上的真实控件与绑定：
 *    - 填写、保存、改正录入、复测另存、退出重开、比较两次结果；
 *    - 保存失败可重试：无重复记录、原成绩不丢；
 *    - 清空一项再保存重开保持未测；
 *    - 训练隔离：自测全程不写训练命名空间，训练档案字节不变，普通清缓存不清自测记录。
 *
 * 真机（微信开发者工具与手机端）的实际交互、输入法表现与断网真机复核仍是整体验收（待验）。
 *
 * 运行：node --test tests/fitness-test.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE_JS = path.join(ROOT, 'utils', 'fitness-test.js');
const STORE_JS = path.join(ROOT, 'utils', 'training-store.js');
const PAGE_JS = path.join(ROOT, 'pages', 'fitness-test', 'fitness-test.js');
const PAGE_WXML = path.join(ROOT, 'pages', 'fitness-test', 'fitness-test.wxml');
const PROFILE_JS = path.join(ROOT, 'pages', 'profile', 'profile.js');
const PROFILE_WXML = path.join(ROOT, 'pages', 'profile', 'profile.wxml');
const APP_JSON = path.join(ROOT, 'app.json');

const FITNESS_KEY = 'climbingNote.fitness.v1.records';
const TRAINING_KEY = 'climbingNote.training.v1.archive';

// ---- 独立推导的期望值：直接照抄 docs/product/9c攀岩体能自测-v0.1.md 的档位与对照表 ----
const EXPECTED_LOAD_THRESHOLDS = [100, 110, 120, 130, 140, 150, 160, 180, 200, 220];
const EXPECTED_HANG_THRESHOLDS = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360];
const EXPECTED_CORE_STEPS = [
  { action: 'tuck', label: '悬垂屈膝 L 举', steps: [[10, 1], [20, 2], [30, 3]] },
  { action: 'straight', label: '直腿 L 举', steps: [[10, 4], [15, 5], [20, 6]] },
  { action: 'front', label: '前水平', steps: [[5, 7], [10, 8], [20, 9], [30, 10]] }
];
// 21 行总分对照：总分 → 法式 / YDS / 抱石跨项目对照（空串＝暂无对应档）
const EXPECTED_ROWS = [
  [1, 2, '6a', '5.10b', '约 V0'],
  [3, 4, '6b', '5.10d', '约 V0'],
  [5, 6, '6c', '5.11b', '约 V1'],
  [7, 8, '6c+', '5.11c', '约 V2'],
  [9, 10, '7a', '5.11d', '约 V2'],
  [11, 12, '7a+', '5.12a', '约 V3'],
  [13, 14, '7b', '5.12b', '约 V4'],
  [15, 16, '7b+', '5.12c', '约 V5'],
  [17, 18, '7c', '5.12d', '约 V6'],
  [19, 20, '7c+', '5.13a', '约 V7'],
  [21, 22, '8a', '5.13b', '约 V8'],
  [23, 24, '8a+', '5.13c', '约 V9'],
  [25, 26, '8b', '5.13d', '约 V10'],
  [27, 28, '8b+', '5.14a', '约 V11'],
  [29, 30, '8c', '5.14b', '约 V12'],
  [31, 32, '8c+', '5.14c', '约 V13'],
  [33, 34, '9a', '5.14d', '约 V14'],
  [35, 36, '9a+', '5.15a', '约 V15'],
  [37, 38, '9b', '5.15b', '约 V16'],
  [39, 39, '9b+', '5.15c', '约 V17'],
  [40, 40, '9c', '5.15d', '']
];

function expectedRowFor(total) {
  return EXPECTED_ROWS.find(row => total >= row[0] && total <= row[1]) || null;
}

// ---- 微信本地存储替身：隔离存储 + 故障注入 ----
const storage = new Map();
const fault = { setFailAt: 0, setCount: 0, getFail: false };
const wxLog = { navigations: [], toasts: [], switches: [], modalConfirm: true, setKeys: [], removeKeys: [], removedInfos: 0 };

function resetAll() {
  storage.clear();
  fault.setFailAt = 0;
  fault.setCount = 0;
  fault.getFail = false;
  wxLog.navigations = [];
  wxLog.toasts = [];
  wxLog.switches = [];
  wxLog.modalConfirm = true;
  wxLog.setKeys = [];
  wxLog.removeKeys = [];
}

/** 让「第 N 次 setStorageSync」失败：先归零计数，避免沿用上一段的调用次数。 */
function armSetFailAt(callNumber) {
  fault.setCount = 0;
  fault.setFailAt = callNumber;
}

// 刻意不提供 wx.cloud：自测功能不需要云能力，也不得依赖网络。
global.wx = {
  getStorageSync(key) {
    if (fault.getFail) throw new Error('getStorageSync:fail injected');
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorageSync(key, value) {
    fault.setCount += 1;
    if (fault.setFailAt && fault.setCount === fault.setFailAt) {
      throw new Error('setStorageSync:fail injected at call ' + fault.setCount);
    }
    wxLog.setKeys.push(key);
    storage.set(key, value);
  },
  removeStorageSync(key) {
    wxLog.removeKeys.push(key);
    storage.delete(key);
  },
  getStorageInfoSync() {
    return { keys: Array.from(storage.keys()) };
  },
  showModal(options) {
    options.success({ confirm: wxLog.modalConfirm, cancel: !wxLog.modalConfirm });
  },
  showToast(options) {
    wxLog.toasts.push(options);
  },
  navigateTo(options) {
    wxLog.navigations.push(options);
  },
  switchTab(options) {
    wxLog.switches.push(options);
  }
};

global.getApp = () => ({ globalData: {} });

const fitness = require(MODULE_JS);
const store = require(STORE_JS);

// 捕获原生 Page(...) 定义；每个用例都重新执行页面模块，顺带覆盖「模块重新加载」路径。
function capturePage(jsPath) {
  let definition = null;
  global.Page = def => {
    definition = def;
  };
  delete require.cache[require.resolve(jsPath)];
  require(jsPath);
  assert.ok(definition, jsPath + ' 应注册 Page 定义');
  return definition;
}

/** 页面实例替身：支持 wx 的 setData 数据路径写法。 */
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
  return { currentTarget: { dataset: dataset || {} } };
}

function inputEvent(value) {
  return { detail: { value: value } };
}

function pickEvent(value) {
  return { detail: { value: value } };
}

// ---- 表单夹具 ----
// 夹具一（原方案第一次验收）：60 kg，指力/拉力各多挂 24 kg，直腿 L 举 15 秒，悬挂 150 秒。
const FIXTURE_A = {
  date: '2026-11-09',
  weightKg: '60',
  finger: 'done',
  fingerExtraKg: '24',
  pull: 'done',
  pullExtraKg: '24',
  core: 'straight',
  coreSeconds: '15',
  hang: '150'
};
// 夹具二（原方案第二次验收）：60 kg，指力 12 kg，拉力 18 kg，直腿 L 举 15 秒，悬挂 90 秒。
const FIXTURE_B = Object.assign({}, FIXTURE_A, {
  fingerExtraKg: '12',
  pullExtraKg: '18',
  hang: '90'
});

function stateIndex(stateValue) {
  return fitness.LOAD_STATES.findIndex(entry => entry.value === stateValue);
}

function actionIndex(actionKey) {
  return fitness.CORE_ACTIONS.findIndex(entry => entry.key === actionKey);
}

/** 通过页面上的真实输入处理函数填写表单。 */
function fillForm(page, values) {
  if (values.date !== undefined) page.onDateChange(pickEvent(values.date));
  if (values.weightKg !== undefined) page.onWeightInput(inputEvent(values.weightKg));
  if (values.finger !== undefined) page.onFingerStateChange(pickEvent(String(stateIndex(values.finger))));
  if (values.fingerExtraKg !== undefined) page.onFingerExtraInput(inputEvent(values.fingerExtraKg));
  if (values.pull !== undefined) page.onPullStateChange(pickEvent(String(stateIndex(values.pull))));
  if (values.pullExtraKg !== undefined) page.onPullExtraInput(inputEvent(values.pullExtraKg));
  if (values.core !== undefined) page.onCoreActionChange(pickEvent(String(actionIndex(values.core))));
  if (values.coreSeconds !== undefined) page.onCoreSecondsInput(inputEvent(values.coreSeconds));
  if (values.hang !== undefined) page.onHangSecondsInput(inputEvent(values.hang));
}

function openFitnessPage() {
  const page = createPage(fitnessDefinition);
  page.onLoad();
  return page;
}

function recordsRaw() {
  const raw = storage.get(FITNESS_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** 夹具（页面填写用的键名）→ 计算层的表单模型。 */
function formModelOf(values) {
  return {
    date: values.date,
    weightKg: values.weightKg,
    fingerState: values.finger,
    fingerExtraKg: values.fingerExtraKg,
    pullState: values.pull,
    pullExtraKg: values.pullExtraKg,
    coreAction: values.core,
    coreSeconds: values.coreSeconds,
    hangSeconds: values.hang
  };
}

function fitnessEvaluation(values) {
  return fitness.evaluateForm(formModelOf(values));
}

function summarize(evaluated) {
  return evaluated.items.map(item => item.points).join(',');
}

function handlersIn(source) {
  return [...source.matchAll(/(?:bind|catch)[a-zA-Z]+="([^"]+)"/g)].map(match => match[1]);
}

function seedTraining() {
  const started = store.startSession({ gymName: '我自己去的岩馆', now: new Date(2026, 10, 9, 8, 30) });
  assert.equal(started.ok, true, started.error);
  const route = store.createRoute({
    sessionId: started.archive.activeSessionId,
    name: '蓝色抱石线',
    climbType: '抱石',
    grade: 'V3',
    colorName: '蓝色',
    colorHex: '#2f6fe4'
  });
  assert.equal(route.ok, true, route.error);
  const attempt = store.saveAttempt({
    routeId: route.route.id,
    sessionId: route.archive.activeSessionId,
    result: 'send',
    note: '第一把就过'
  });
  assert.equal(attempt.ok, true, attempt.error);
  return { sessionId: route.archive.activeSessionId, routeId: route.route.id };
}

let fitnessDefinition = null;
let profileDefinition = null;

beforeEach(() => {
  resetAll();
  fitnessDefinition = capturePage(PAGE_JS);
  profileDefinition = capturePage(PROFILE_JS);
});

// ================================================================== 计算层

test('F01 分项档位表与原方案逐档一致（负重、悬挂、核心）', () => {
  assert.deepEqual(fitness.LOAD_THRESHOLDS, EXPECTED_LOAD_THRESHOLDS);
  assert.deepEqual(fitness.HANG_THRESHOLDS, EXPECTED_HANG_THRESHOLDS);
  assert.equal(fitness.GRADE_TABLE.length, 21);

  // 负重项：体重 100 kg 时，额外负重 10/20/… 正好是 110%/120%…；取已达最高档。
  EXPECTED_LOAD_THRESHOLDS.forEach((threshold, index) => {
    const atThreshold = fitness.scoreLoad(100, threshold - 100);
    assert.equal(atThreshold.percent, threshold);
    assert.equal(atThreshold.points, index + 1, threshold + '% 应为 ' + (index + 1) + ' 分');
    if (threshold > 100) {
      // 差一点没到这一档：保留较低档，不四舍五入进位。
      const below = fitness.scoreLoad(100, threshold - 100.1);
      assert.equal(below.points, index, (threshold - 0.1) + '% 应仍为 ' + index + ' 分');
    }
  });
  // 超出最高档封顶，且标记为已达最高档。
  const capped = fitness.scoreLoad(60, 400);
  assert.equal(capped.points, 10);
  assert.equal(capped.capped, true);
  // 未达到第一档（额外负重为负会被拒收，这里直接验证计分下限）。
  assert.equal(fitness.scoreLoad(60, 0).points, 1);
  assert.equal(fitness.scoreLoad(60, 0).percent, 100);

  // 悬挂耐力：阈值取整档，超出封顶。
  EXPECTED_HANG_THRESHOLDS.forEach((threshold, index) => {
    assert.equal(fitness.scoreHang(threshold).points, index + 1, threshold + ' 秒应为 ' + (index + 1) + ' 分');
    if (threshold > 30) {
      assert.equal(fitness.scoreHang(threshold - 1).points, index, (threshold - 1) + ' 秒应仍为 ' + index + ' 分');
    }
  });
  assert.equal(fitness.scoreHang(29).points, 0);
  assert.equal(fitness.scoreHang(0).points, 0);
  assert.equal(fitness.scoreHang(1000).points, 10);
  assert.equal(fitness.scoreHang(1000).capped, true);

  // 核心动作：每档位与封顶，且不跨动作相加。
  EXPECTED_CORE_STEPS.forEach(entry => {
    const action = fitness.coreAction(entry.action);
    assert.equal(action.label, entry.label);
    entry.steps.forEach(pair => {
      assert.equal(
        fitness.scoreCore(entry.action, pair[0]).points,
        pair[1],
        entry.label + ' ' + pair[0] + ' 秒应为 ' + pair[1] + ' 分'
      );
    });
    const [firstSeconds, firstPoints] = entry.steps[0];
    assert.equal(fitness.scoreCore(entry.action, firstSeconds - 1).points, 0);
    const last = entry.steps[entry.steps.length - 1];
    assert.equal(fitness.scoreCore(entry.action, last[0] + 60).points, last[1]);
  });
  // 直腿 L 举 40 秒仍是 6 分（不按前水平加分）。
  assert.equal(fitness.scoreCore('straight', 40).points, 6);
  assert.equal(fitness.scoreCore('unknown', 30), null);
});

test('F02 总分 1–40 逐档对照与 19/20、18、40 的指定读数', () => {
  for (let total = 1; total <= 40; total += 1) {
    const expected = expectedRowFor(total);
    const row = fitness.gradeForTotal(total);
    assert.ok(row, total + ' 分应有对照');
    assert.equal(row.french, expected[2], total + ' 分法式');
    assert.equal(row.yds, expected[3], total + ' 分 YDS');
    assert.equal(row.v, expected[4], total + ' 分抱石对照');
    const lines = fitness.gradeLines(total);
    assert.equal(lines.length, 3);
    assert.equal(lines[2].value, expected[4] === '' ? fitness.NO_COUNTERPART : expected[4]);
  }
  // 0 分与超出 40 分都没有对照行（不插值、不补档）。
  assert.equal(fitness.gradeForTotal(0), null);
  assert.equal(fitness.gradeForTotal(41), null);
  assert.deepEqual(fitness.gradeLines(0), []);

  assert.equal(fitness.gradeForTotal(20).french, '7c+');
  assert.equal(fitness.gradeForTotal(20).yds, '5.13a');
  assert.equal(fitness.gradeForTotal(20).v, '约 V7');
  assert.equal(fitness.gradeForTotal(19).french, '7c+');
  assert.equal(fitness.gradeForTotal(19).yds, '5.13a');
  assert.equal(fitness.gradeForTotal(19).v, '约 V7');
  assert.equal(fitness.gradeForTotal(18).french, '7c');
  assert.equal(fitness.gradeForTotal(18).yds, '5.12d');
  assert.equal(fitness.gradeForTotal(18).v, '约 V6');
  assert.equal(fitness.gradeForTotal(40).french, '9c');
  assert.equal(fitness.gradeForTotal(40).yds, '5.15d');
  assert.equal(fitness.gradeForTotal(40).v, '');
  assert.equal(fitness.gradeLines(40)[2].value, '暂无对应档');
});

test('F03 体重必须是正数：负数、0、非数、无穷拒收', () => {
  ['-60', '0', '-0.5', 'abc', '', '   ', 'Infinity', '-Infinity', 'NaN', '1e5', '60kg'].forEach(value => {
    const evaluated = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { weightKg: value })));
    assert.equal(evaluated.ok, false, JSON.stringify(value) + ' 应被拒收');
    assert.match(evaluated.error, /体重/);
  });
  // 数字与数字文本都接受（正数）。
  [60, 60.5, '60', ' 60 '].forEach(value => {
    const evaluated = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { weightKg: value })));
    assert.equal(evaluated.ok, true, JSON.stringify(value) + ' 应接受：' + evaluated.error);
    assert.equal(evaluated.weightKg, typeof value === 'string' ? Number(value.trim()) : value);
  });
  // 额外负重与时长必须是非负数。
  const negativeLoad = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { fingerExtraKg: '-1' })));
  assert.equal(negativeLoad.ok, false);
  assert.match(negativeLoad.error, /额外负重/);
  const negativeSeconds = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { hang: '-3' })));
  assert.equal(negativeSeconds.ok, false);
  assert.match(negativeSeconds.error, /秒数/);
  const nanSeconds = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { coreSeconds: 'NaN' })));
  assert.equal(nanSeconds.ok, false);
  assert.match(nanSeconds.error, /核心动作/);
});

test('F04 未测、已测未达、自重成功三种状态都能表达，四项都测才给总分', () => {
  const untested = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { finger: 'untested', fingerExtraKg: '' })));
  assert.equal(untested.items[0].status, 'untested');
  assert.equal(untested.items[0].statusText, '未测');
  assert.equal(untested.items[0].points, null);
  assert.equal(untested.complete, false);
  assert.equal(untested.total, null);
  assert.match(untested.totalText, /四项都测/);

  const failed = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { finger: 'failed', fingerExtraKg: '' })));
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(failed.items[0].statusText, '已测未达');
  assert.equal(failed.items[0].points, 0);

  const selfWeight = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { finger: 'done', fingerExtraKg: '0' })));
  assert.equal(selfWeight.items[0].status, 'measured');
  assert.equal(selfWeight.items[0].points, 1);
  assert.match(selfWeight.items[0].rawText, /自重（总负荷 100%）/);

  // 核心：选了动作 + 秒数才算已测；低于该动作第一档记 0 分；只选动作不填秒数＝未测。
  const coreUntested = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { core: 'front', coreSeconds: '' })));
  assert.equal(coreUntested.items[2].status, 'untested');
  const coreFailed = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { core: 'front', coreSeconds: '3' })));
  assert.equal(coreFailed.items[2].status, 'failed');
  assert.equal(coreFailed.items[2].points, 0);
  const coreNoAction = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { core: '', coreSeconds: '20' })));
  assert.equal(coreNoAction.ok, false);
  assert.match(coreNoAction.error, /核心动作/);

  // 四项均测且合计 0：明确显示尚未达到起评档。
  const zero = fitness.evaluateForm(formModelOf({
    date: FIXTURE_A.date,
    weightKg: '60',
    finger: 'failed',
    fingerExtraKg: '',
    pull: 'failed',
    pullExtraKg: '',
    core: 'front',
    coreSeconds: '2',
    hang: '20'
  }));
  assert.equal(zero.complete, true);
  assert.equal(zero.total, 0);
  assert.equal(zero.totalText, '尚未达到原表起评档');
  assert.equal(zero.grade, null);
  assert.deepEqual(zero.gradeLines, []);

  // 悬挂 20 秒＝已测未达，不是未测。
  const hangFailed = fitness.evaluateForm(formModelOf(Object.assign({}, FIXTURE_A, { hang: '20' })));
  assert.equal(hangFailed.items[3].status, 'failed');
  assert.equal(hangFailed.items[3].points, 0);
  assert.equal(hangFailed.items[3].statusText, '已测未达');
});

test('F05 原方案两组 60 kg 夹具在计算层得到 20/19/18 与 15/14 分', () => {
  const first = fitnessEvaluation(FIXTURE_A);
  assert.equal(summarize(first), '5,5,5,5');
  assert.equal(first.total, 20);
  assert.equal(first.totalText, '20 / 40 · 7c+ · 5.13a · 约 V7');

  const hang120 = fitnessEvaluation(Object.assign({}, FIXTURE_A, { hang: '120' }));
  assert.equal(hang120.total, 19);
  assert.equal(hang120.totalText, '19 / 40 · 7c+ · 5.13a · 约 V7');

  const hang90 = fitnessEvaluation(Object.assign({}, FIXTURE_A, { hang: '90' }));
  assert.equal(hang90.total, 18);
  assert.equal(hang90.totalText, '18 / 40 · 7c · 5.12d · 约 V6');

  const second = fitnessEvaluation(FIXTURE_B);
  assert.equal(summarize(second), '3,4,5,3');
  assert.equal(second.total, 15);
  assert.equal(second.grade.french, '7b+');

  // 悬挂 89 秒：耐力 2 分，总分比 90 秒少 1 分。
  const hang89 = fitnessEvaluation(Object.assign({}, FIXTURE_B, { hang: '89' }));
  assert.equal(hang89.items[3].points, 2);
  assert.equal(hang89.total, 14);
  assert.equal(hang89.grade.french, '7b');

  // 指力自重完成 + 其余满分之外的分项：指力 1 分。
  const selfWeightFinger = fitnessEvaluation(Object.assign({}, FIXTURE_B, { fingerExtraKg: '0' }));
  assert.equal(selfWeightFinger.items[0].points, 1);

  // 所有项目满档：总分 40，对照 9c。
  const full = fitnessEvaluation({
    date: FIXTURE_A.date,
    weightKg: '60',
    finger: 'done',
    fingerExtraKg: '200',
    pull: 'done',
    pullExtraKg: '200',
    core: 'front',
    coreSeconds: '30',
    hang: '360'
  });
  assert.equal(full.total, 40);
  assert.equal(full.totalText, '40 / 40 · 9c · 5.15d · 暂无对应档');
});

// ================================================================== 注册与入口

test('P01 页面注册进 app.json、「我的」有入口，WXML 控件与处理器真实存在', () => {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  assert.equal(appJson.pages[0], 'pages/index/index');
  assert.ok(
    appJson.pages.includes('pages/fitness-test/fitness-test'),
    '体能自测页必须注册进 app.json'
  );
  ['js', 'json', 'wxml', 'wxss'].forEach(ext => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'pages', 'fitness-test', 'fitness-test.' + ext)),
      '缺少页面文件 fitness-test.' + ext
    );
  });

  // 「我的」入口：真实按钮 + 真实处理器 + 真实跳转。
  const profileWxml = fs.readFileSync(PROFILE_WXML, 'utf8');
  assert.ok(profileWxml.indexOf('bindtap="goToFitnessTest"') !== -1, '个人页缺少体能自测入口');
  assert.equal(typeof profileDefinition.goToFitnessTest, 'function');
  const profilePage = createPage(profileDefinition);
  profilePage.goToFitnessTest();
  assert.equal(wxLog.navigations.length, 1);
  assert.equal(wxLog.navigations[0].url, '/pages/fitness-test/fitness-test');

  // 自测页里每个绑定都必须有对应页面方法。
  const wxml = fs.readFileSync(PAGE_WXML, 'utf8');
  const handlers = handlersIn(wxml);
  assert.ok(handlers.length >= 10, '自测页应有足够多的真实控件绑定');
  handlers.forEach(handler => {
    assert.equal(
      typeof fitnessDefinition[handler],
      'function',
      '自测页的 ' + handler + ' 必须有对应页面方法'
    );
  });

  // 关键控件：日期、体重、四项输入、状态选择、保存、新建复测、分项、记录与比较。
  [
    'date-picker',
    'weight-input',
    'finger-state-picker',
    'finger-extra-input',
    'pull-state-picker',
    'pull-extra-input',
    'core-action-picker',
    'core-seconds-input',
    'hang-seconds-input',
    'save-test',
    'new-test',
    'preview-total',
    'records-card',
    'comparison-card',
    'clear-compare'
  ].forEach(id => {
    assert.ok(wxml.indexOf('id="' + id + '"') !== -1, '自测页缺少控件 ' + id);
  });

  // 说明区必须写清动作标准与算法口径。
  ['kg', '秒', '指力板', '引体向上', '前水平', '最高档', '40'].forEach(keyword => {
    assert.ok(wxml.indexOf(keyword) !== -1, '说明区缺少 ' + keyword);
  });
  assert.ok(wxml.indexOf('约 V 级') !== -1 || wxml.indexOf('跨项目对照') !== -1);
});

// ================================================================== 页面主流程

test('P02 真实页面完成两组 60 kg 夹具的填写与重算', () => {
  const page = openFitnessPage();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.formVisible, true);

  fillForm(page, FIXTURE_A);
  assert.equal(page.data.preview.measuredCountText, '已测 4 / 4 项');
  assert.equal(page.data.preview.totalText, '20 / 40 · 7c+ · 5.13a · 约 V7');
  assert.equal(page.data.preview.gradeLines.length, 3);

  page.onHangSecondsInput(inputEvent('120'));
  assert.equal(page.data.preview.totalText.indexOf('19 / 40'), 0);
  page.onHangSecondsInput(inputEvent('90'));
  assert.equal(page.data.preview.totalText.indexOf('18 / 40'), 0);
  assert.equal(page.data.preview.gradeLines[0].value, '7c');
  assert.equal(page.data.preview.gradeLines[1].value, '5.12d');
  assert.equal(page.data.preview.gradeLines[2].value, '约 V6');

  // 夹具二：3、4、5、3，总分 15，法式 7b+。
  fillForm(page, FIXTURE_B);
  assert.equal(page.data.preview.items.map(item => item.pointsText).join(','), '3 分,4 分,5 分,3 分');
  assert.equal(page.data.preview.totalText.indexOf('15 / 40 · 7b+'), 0);

  // 悬挂 89 秒 → 2 分，总分 14 → 7b。
  page.onHangSecondsInput(inputEvent('89'));
  assert.equal(page.data.preview.items[3].pointsText, '2 分');
  assert.equal(page.data.preview.totalText.indexOf('14 / 40 · 7b'), 0);

  // 清空悬挂 → 该项未测，不再有总分。
  page.onHangSecondsInput(inputEvent(''));
  assert.equal(page.data.preview.items[3].statusText, '未测');
  assert.equal(page.data.preview.measuredCountText, '已测 3 / 4 项');
  assert.match(page.data.preview.totalText, /四项都测/);
});

test('P03 保存、改正录入、复测另存与退出重开都只写本机且保持一致', () => {
  const page = openFitnessPage();
  fillForm(page, FIXTURE_A);
  const saved = page.saveTest();
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.code, 'created');

  let raw = recordsRaw();
  assert.equal(raw.tests.length, 1);
  assert.equal(raw.tests[0].total, 20);
  assert.equal(raw.tests[0].date, '2026-11-09');
  assert.equal(raw.tests[0].weightKg, 60);
  assert.equal(raw.tests[0].finger.state, 'done');
  assert.equal(raw.tests[0].finger.extraKg, 24);
  assert.equal(raw.tests[0].core.action, 'straight');
  assert.equal(raw.tests[0].core.seconds, 15);
  assert.equal(raw.tests[0].hang.seconds, 150);
  assert.equal(raw.tests[0].points.finger, 5);
  assert.equal(raw.tests[0].tableVersion, fitness.TABLE_VERSION);
  assert.equal(raw.tests[0].archiveId, raw.archiveId);
  assert.ok(raw.archiveId.indexOf('fitness-archive-') === 0);
  assert.equal(page.data.records.length, 1);
  assert.match(page.data.records[0].gradeText, /7c\+/);

  // 保存后表单进入「修改这一条」：再次保存是原位更正，不新增第二条。
  const firstId = raw.tests[0].id;
  page.onHangSecondsInput(inputEvent('120'));
  const updated = page.saveTest();
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.code, 'updated');
  assert.equal(updated.record.id, firstId);
  raw = recordsRaw();
  assert.equal(raw.tests.length, 1, '修改不得新增记录');
  assert.equal(raw.tests[0].hang.seconds, 120);
  assert.equal(raw.tests[0].total, 19);

  // 新建复测：另存一条，原记录保留。
  page.startNewTest();
  assert.equal(page.data.fingerStateIndex, 0);
  assert.equal(page.data.hangSeconds, '');
  fillForm(page, Object.assign({}, FIXTURE_B, { date: '2026-11-10' }));
  const second = page.saveTest();
  assert.equal(second.ok, true, second.error);
  assert.equal(second.code, 'created');
  assert.notEqual(second.record.id, firstId);
  raw = recordsRaw();
  assert.equal(raw.tests.length, 2);
  const byId = new Map(raw.tests.map(item => [item.id, item]));
  assert.equal(byId.get(firstId).total, 19);
  assert.equal(second.record.total, 15);
  assert.equal(page.data.records.length, 2);

  // 退出重开（重新执行页面模块）：原数据、日期与结果一致。
  fitnessDefinition = capturePage(PAGE_JS);
  const reopened = createPage(fitnessDefinition);
  reopened.onLoad();
  reopened.onShow();
  assert.equal(reopened.data.records.length, 2);
  // 列表按日期新在前：11-10 的复测在前，11-09 的原记录在后。
  assert.equal(reopened.data.records[0].date, '2026-11-10');
  assert.equal(reopened.data.records[0].totalText, '15 / 40');
  assert.equal(reopened.data.records[1].date, '2026-11-09');
  assert.equal(reopened.data.records[1].totalText, '19 / 40');
  assert.match(reopened.data.records[1].gradeText, /7c\+ · 5\.13a · 约 V7/);
  assert.match(reopened.data.records[1].tableVersionText, /9c-v0\.1/);

  // 「修改」把原记录读回表单：保存只更新它。
  const target = raw.tests.find(item => item.total === 19);
  reopened.editRecord(tapDataset({ id: target.id }));
  assert.equal(reopened.data.weightKg, '60');
  assert.equal(reopened.data.hangSeconds, '120');
  assert.equal(reopened.data.fingerStateIndex, stateIndex('done'));
  assert.equal(reopened.data.preview.totalText.indexOf('19 / 40'), 0);
  reopened.onHangSecondsInput(inputEvent('150'));
  const corrected = reopened.saveTest();
  assert.equal(corrected.code, 'updated');
  assert.equal(recordsRaw().tests.length, 2);
  assert.equal(fitness.findTest(reopened._state, target.id).total, 20);
});

test('P04 选择两次结果比较各分项原始数据与总分', () => {
  const page = openFitnessPage();
  fillForm(page, FIXTURE_A);
  const first = page.saveTest().record;
  page.startNewTest();
  fillForm(page, Object.assign({}, FIXTURE_B, { date: '2026-11-12' }));
  const second = page.saveTest().record;

  assert.equal(page.data.comparison, null);
  page.toggleCompare(tapDataset({ id: first.id }));
  assert.equal(page.data.selectedIds.length, 1);
  assert.equal(page.data.comparison, null);
  page.toggleCompare(tapDataset({ id: second.id }));
  assert.equal(page.data.canCompare, true);
  const comparison = page.data.comparison;
  assert.ok(comparison, '两次选中后应出现比较结果');
  assert.equal(comparison.rows.length, 4);
  assert.match(comparison.summary.leftText, /2026-11-09/);
  assert.match(comparison.summary.rightText, /2026-11-12/);
  assert.match(comparison.summary.leftText, /20 \/ 40/);
  assert.match(comparison.summary.rightText, /15 \/ 40/);

  const fingerRow = comparison.rows.find(row => row.key === 'finger');
  assert.match(fingerRow.left.rawText, /额外负重 24 kg（总负荷 140%）/);
  assert.match(fingerRow.right.rawText, /额外负重 12 kg（总负荷 120%）/);
  assert.equal(fingerRow.left.pointsText, '5 分');
  assert.equal(fingerRow.right.pointsText, '3 分');
  assert.equal(fingerRow.deltaText, '分项 -2');
  const hangRow = comparison.rows.find(row => row.key === 'hang');
  assert.match(hangRow.left.rawText, /自重悬挂 150 秒/);
  assert.match(hangRow.right.rawText, /自重悬挂 90 秒/);
  assert.equal(comparison.summary.totalDeltaText, '总分 -5');

  // 取消选择后比较结果消失，记录仍在；重新选上第二条，比较结果回来。
  page.toggleCompare(tapDataset({ id: second.id }));
  assert.equal(page.data.comparison, null);
  assert.equal(recordsRaw().tests.length, 2);
  page.toggleCompare(tapDataset({ id: second.id }));
  assert.ok(page.data.comparison);  page.clearCompare();
  assert.equal(page.data.comparison, null);
  assert.equal(page.data.selectedIds.length, 0);
  assert.equal(recordsRaw().tests.length, 2);
});

test('P05 保存失败可重试：无重复、无原成绩丢失', () => {
  const page = openFitnessPage();
  fillForm(page, FIXTURE_A);

  // 第一次落盘失败：不报已保存，也不写入任何记录。
  armSetFailAt(1);
  const failed = page.saveTest();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'write-failed');
  assert.match(page.data.storageError, /保存本机体能自测记录失败/);
  assert.equal(storage.has(FITNESS_KEY), false);
  assert.equal(page.data.records.length, 0);

  // 沿用同一个测试 ID 重试：只落一条。
  fault.setFailAt = 0;
  const retried = page.saveTest();
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.code, 'created');
  assert.equal(recordsRaw().tests.length, 1);
  const firstId = retried.record.id;

  // 再存第二条，然后让「修改」这一步落盘失败：原成绩必须保持不动。
  page.startNewTest();
  fillForm(page, Object.assign({}, FIXTURE_B, { date: '2026-11-11' }));
  const second = page.saveTest();
  assert.equal(second.ok, true, second.error);
  assert.equal(recordsRaw().tests.length, 2);
  const keep = recordsRaw().tests.find(item => item.id === second.record.id);
  assert.equal(keep.total, 15);
  assert.equal(keep.hang.seconds, 90);

  page.editRecord(tapDataset({ id: second.record.id }));
  page.onHangSecondsInput(inputEvent('30'));
  armSetFailAt(1);
  const updateFailed = page.saveTest();
  assert.equal(updateFailed.ok, false);
  const after = recordsRaw();
  assert.equal(after.tests.length, 2, '失败的更正不得新增记录');
  assert.deepEqual(after.tests.find(item => item.id === second.record.id), keep, '失败的更正不得改动原成绩');

  // 重试成功后只更新那一条，第一条记录不受影响。
  fault.setFailAt = 0;
  const updateOk = page.saveTest();
  assert.equal(updateOk.ok, true, updateOk.error);
  assert.equal(updateOk.code, 'updated');
  const finalState = recordsRaw();
  assert.equal(finalState.tests.length, 2);
  assert.equal(finalState.tests.find(item => item.id === second.record.id).hang.seconds, 30);
  assert.equal(finalState.tests.find(item => item.id === firstId).total, 20);

  // 落盘彻底不可用（读取也失败）时不写、不覆盖。
  fault.getFail = true;
  const unreadable = page.saveTest();
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, 'unreadable');
  fault.getFail = false;
  assert.equal(recordsRaw().tests.length, 2);
});

test('P06 清空一项再保存重开保持未测，无完整总分', () => {
  const page = openFitnessPage();
  fillForm(page, FIXTURE_B);
  const saved = page.saveTest().record;
  assert.equal(saved.total, 15);

  page.onHangSecondsInput(inputEvent(''));
  const cleared = page.saveTest();
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(cleared.record.hang.seconds, null);
  assert.equal(cleared.record.total, null);
  assert.equal(recordsRaw().tests.length, 1, '清空一项仍是修改这一条');

  fitnessDefinition = capturePage(PAGE_JS);
  const reopened = createPage(fitnessDefinition);
  reopened.onLoad();
  assert.equal(reopened.data.records.length, 1);
  assert.equal(reopened.data.records[0].totalText, '四项未测齐，无总分');
  reopened.editRecord(tapDataset({ id: saved.id }));
  assert.equal(reopened.data.hangSeconds, '');
  assert.equal(reopened.data.preview.items[3].statusText, '未测');
  assert.match(reopened.data.preview.totalText, /四项都测/);

  // 体重非法时保存被拒，不写盘。
  reopened.onWeightInput(inputEvent('-1'));
  const rejected = reopened.saveTest();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid');
  assert.match(reopened.data.formError, /体重/);
  assert.equal(recordsRaw().tests.length, 1);
  assert.equal(recordsRaw().tests[0].hang.seconds, null);
});

// ================================================================== 训练隔离

test('P07 自测全程不碰训练数据，训练页也不写自测成绩，清缓存不清自测记录', () => {
  const seeded = seedTraining();
  // 模拟已有一条线路主照片索引：自测与清缓存都不得动它。
  const photoIndexBefore = JSON.stringify({
    version: 1,
    entries: [{ routeId: seeded.routeId, mainPath: 'http://usr/route-main.jpg' }]
  });
  storage.set(store.PHOTO_INDEX_KEY, photoIndexBefore);
  const archiveBefore = storage.get(TRAINING_KEY);
  const archiveTextBefore = JSON.stringify(store.loadState().archive);
  assert.ok(archiveBefore);
  // 从这里开始单独记录写入的键：自测的操作只能落在自测命名空间。
  wxLog.setKeys = [];

  // 自测页完整走一遍：填、存、改、复测、重开、比较。
  const page = openFitnessPage();
  fillForm(page, FIXTURE_A);
  const first = page.saveTest().record;
  page.onHangSecondsInput(inputEvent('120'));
  page.saveTest();
  page.startNewTest();
  fillForm(page, Object.assign({}, FIXTURE_B, { date: '2026-11-13' }));
  const second = page.saveTest().record;
  page.toggleCompare(tapDataset({ id: first.id }));
  page.toggleCompare(tapDataset({ id: second.id }));
  fitnessDefinition = capturePage(PAGE_JS);
  const reopened = createPage(fitnessDefinition);
  reopened.onLoad();
  reopened.onShow();

  // 训练档案字节不变；把次、完攀数与备注都还在，照片索引也原样。
  assert.equal(storage.get(TRAINING_KEY), archiveBefore, '自测不得改写训练档案');
  assert.equal(JSON.stringify(store.loadState().archive), archiveTextBefore);
  assert.equal(storage.get(store.PHOTO_INDEX_KEY), photoIndexBefore, '自测不得改写照片索引');
  const attempts = store.loadState().archive.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].result, 'send');
  assert.equal(attempts[0].note, '第一把就过');
  assert.equal(store.loadState().archive.routes[0].id, seeded.routeId);

  // 自测页的每一次写入都只落在自测命名空间。
  wxLog.setKeys.forEach(key => {
    assert.equal(key, FITNESS_KEY, '自测页不得写其他键：' + key);
  });
  assert.ok(storage.has(FITNESS_KEY));
  assert.equal(storage.has('climbingNote.fitness.v1.archive'), false);

  // 训练侧写入（补备注）不会碰自测记录。
  const fitnessBefore = storage.get(FITNESS_KEY);
  const noted = store.setAttemptNote(attempts[0].id, { note: '第二把滑手' });
  assert.equal(noted.ok, true, noted.error);
  assert.equal(storage.get(FITNESS_KEY), fitnessBefore, '记线路不得改动自测记录');
  const archiveAfterTrainingWrite = storage.get(TRAINING_KEY);
  assert.notEqual(archiveAfterTrainingWrite, archiveBefore, '训练侧这一笔应确实写进了训练档案');

  // 训练页源码里没有自测入口：训练页不写自测成绩。
  ['pages/training-session/training-session.js', 'pages/training-route/training-route.js', 'pages/index/index.js']
    .forEach(rel => {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.equal(source.indexOf('fitness'), -1, rel + ' 不应引用自测模块');
    });

  // 普通清缓存：只清训练命名空间的可重建缓存，自测记录与训练档案都保留。
  storage.set('climbingNote.training.v1.cache.thumbnails', 'rebuildable');
  const profilePage = createPage(profileDefinition);
  profilePage._photoUi = null;
  wxLog.modalConfirm = true;
  profilePage.clearCache();
  return Promise.resolve().then(() => {
    assert.equal(storage.has('climbingNote.training.v1.cache.thumbnails'), false, '可重建缓存应被清掉');
    assert.equal(storage.has(FITNESS_KEY), true, '清缓存不得清除自测记录');
    assert.equal(storage.get(FITNESS_KEY), fitnessBefore);
    assert.equal(storage.get(TRAINING_KEY), archiveAfterTrainingWrite, '清缓存不得清除训练档案');
    assert.equal(storage.get(store.PHOTO_INDEX_KEY), photoIndexBefore, '清缓存不得清除线路主照片索引');
    assert.equal(recordsRaw().tests.length, 2);
    assert.equal(wxLog.toasts.length > 0, true);
  });
});

test('P08 自测记录损坏或版本不支持时只报错、保留原数据、不落盘', () => {
  storage.set(FITNESS_KEY, '{不是 JSON');
  const page = openFitnessPage();
  assert.match(page.data.loadError, /本机体能自测记录/);
  assert.equal(page.data.formVisible, false);
  assert.equal(page.data.records.length, 0);
  // 原数据保持不动。
  assert.equal(storage.get(FITNESS_KEY), '{不是 JSON');

  storage.set(
    FITNESS_KEY,
    JSON.stringify({ version: 99, archiveId: 'fitness-archive-old', nextTestSeq: 1, tests: [] })
  );
  const versionPage = openFitnessPage();
  assert.equal(versionPage.data.formVisible, false);
  assert.match(versionPage.data.loadError, /版本不受支持/);
  assert.match(storage.get(FITNESS_KEY), /"version":99/);

  // 结构损坏（tests 不是数组）也按损坏处理，不覆盖。
  storage.set(FITNESS_KEY, JSON.stringify({ version: 1, archiveId: 'a', tests: 'nope' }));
  const brokenPage = openFitnessPage();
  assert.equal(brokenPage.data.formVisible, false);
  assert.equal(typeof brokenPage.retryLoad, 'function');
  brokenPage.retryLoad();
  assert.equal(storage.get(FITNESS_KEY), JSON.stringify({ version: 1, archiveId: 'a', tests: 'nope' }));
});
