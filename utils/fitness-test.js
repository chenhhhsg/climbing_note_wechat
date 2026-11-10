/**
 * 9c 攀岩体能自测（T020）
 *
 * 负责人批准把 docs/product/9c攀岩体能自测-v0.1.md 的完整 v0.1 方案加入手机记录版。
 * 本文件是该功能的唯一数据层与计算层：
 * - 计分只按方案原表：每项最多 10 分、取已达最高档、两档之间保留较低档、
 *   超出最高档封顶；四项直接相加，满分 40；总分查原对照表，不插值、
 *   不自行补齐对照表未列出的档位；
 * - 负重项（指力/拉力）按原始负荷比较档位：直接比较「体重＋额外负重」与「体重×档位」，
 *   不先把比例舍入到固定小数位。显示用的百分比四位小数只是展示，不参与计分，
 *   所以显示相同的两次负荷可能落在不同档位（60 kg 加 5.99999 kg 显示 110%，实际只是第 1 档）；
 * - 输入单位固定 kg 与秒。体重必须是大于 0 的有限数（负数、非数、无穷一律拒收）；
 *   额外负重与时长必须是非负数；
 * - 空白表示「未测」；用户明确已测但未达到该项第一档记 0 分（已测未达）；
 *   额外负重 0 kg 表示成功用自重完成，得 1 分；
 * - 四项都测才给总分；四项合计 0 时显示「尚未达到原表起评档」。
 *
 * 存储只落在微信本地持久存储的独立命名空间 `climbingNote.fitness.v1.` 下，
 * 与训练档案（`climbingNote.training.v1.`）完全分开：
 * - 本层不读、不写训练档案，也不读旧云记录与试用工程的键；
 * - 训练档案层的普通清缓存只清 `climbingNote.training.v1.cache.*` /
 *   `thumbs.*`，因此自测记录、输入与评分在清缓存后仍在；
 * - 不存实测人员的任何个人资料，不上传原始数据，全程不使用网络与云能力。
 *
 * 存储键：
 *   climbingNote.fitness.v1.records   自测记录档案（档案 ID、下一次序号与每条记录：
 *                                     测试 ID、日期、体重、原始输入、分项评分、总分、
 *                                     评分规则版本、对照表版本）——受保护，不属可重建缓存
 *
 * 版本标识有两个，各自独立、随每条记录分别保存，便于重开与复测比较时核对：
 * - SCORING_VERSION 评分规则版本：分项档位表与计分口径；
 * - TABLE_VERSION   等级对照表版本：总分 → 法式 / YDS / 抱石跨项目对照的查表版本。
 * 已保存的 v0.1 记录只有一个合并的 tableVersion（值就是 LEGACY_TABLE_VERSION），
 * 读到它时按实际原始 v0.1 规则补齐评分规则版本，原数据保持不动。
 *
 * 一次「保存」＝先读最新记录、再写入目标条目：新建时带上页面为该次录入生成的
 * 测试 ID（opId），同一 ID 重复提交只落一条；修改时用已存条目的 ID 原位更正，
 * 只换这一条的输入与评分，不新增第二条。落盘失败只返回错误、原记录保持不动，
 * 页面沿用同一 ID 重试即幂等。
 */
const NAMESPACE = 'climbingNote.fitness.v1.';
const STATE_KEY = NAMESPACE + 'records';
const STATE_VERSION = 1;
// 评分规则版本：分项档位表（指力/拉力的负荷百分比、悬挂秒数、核心动作档位）与计分口径的版本。
const SCORING_VERSION = '9c-score-v0.1';
// 等级对照表版本：总分 → 法式 / YDS / 抱石跨项目对照的查表版本。
// 沿用 v0.1 记录里已经保存的值，已存的旧记录不改写。
const TABLE_VERSION = '9c-v0.1';
// v0.1 记录只存过这一个版本号（那时评分规则与对照表合并为一个「计分/对照表版本」）。
// 读到它时按实际原始 v0.1 规则回显评分规则版本，不替它编别的历史版本。
const LEGACY_TABLE_VERSION = '9c-v0.1';

// 可见错误文案：损坏与「首次为空」要分开，页面据此提示并保留原数据。
const STATE_BROKEN = '本机体能自测记录格式损坏，请重置自测记录后再试';
const STATE_UNSUPPORTED = '本机体能自测记录版本不受支持，请升级小程序或重置自测记录';
const STATE_READ_FAILED = '读取本机体能自测记录失败：';
const STATE_WRITE_FAILED = '保存本机体能自测记录失败：';

// 负重类（指力/拉力）的负荷档位：总负荷达到体重的这些百分比依次得 1 至 10 分。
const LOAD_THRESHOLDS = [100, 110, 120, 130, 140, 150, 160, 180, 200, 220];
// 比较原始负荷与档位时的浮点余量：Number.EPSILON（2^-52）是 double 的相对表示误差上限，
// 一次加法加一次乘法后两侧各差几个 ulp，这里取 4 倍。
// 它只在「小数位数极端多、没法用安全整数精确比较」时才用到，量级约 1e-15 相对值，
// 比可输入的十进制差异小八个数量级以上（60 kg 加 5.99999 kg 与加 6 kg 差 1e-5 kg），
// 只覆盖 double 自身分辨率（几个 ulp）以内的表示误差。
const LOAD_COMPARE_SLACK = Number.EPSILON * 4;
// 悬挂耐力的秒数档位：依次得 1 至 10 分（按阈值取整档）。
const HANG_THRESHOLDS = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360];

// 核心动作：做过多种动作时填写得分最高的一项，得分不跨动作相加。
const CORE_ACTIONS = [
  {
    key: 'tuck',
    label: '悬垂屈膝 L 举',
    steps: [
      { seconds: 10, points: 1 },
      { seconds: 20, points: 2 },
      { seconds: 30, points: 3 }
    ]
  },
  {
    key: 'straight',
    label: '直腿 L 举',
    steps: [
      { seconds: 10, points: 4 },
      { seconds: 15, points: 5 },
      { seconds: 20, points: 6 }
    ]
  },
  {
    key: 'front',
    label: '前水平',
    steps: [
      { seconds: 5, points: 7 },
      { seconds: 10, points: 8 },
      { seconds: 20, points: 9 },
      { seconds: 30, points: 10 }
    ]
  }
];

// 总分对照表（原方案 21 行，逐行照抄，不插值）。
// v 为空字符串表示该总分在跨项目对照里没有对应档（40 分）。
const GRADE_TABLE = [
  { min: 1, max: 2, french: '6a', yds: '5.10b', v: '约 V0' },
  { min: 3, max: 4, french: '6b', yds: '5.10d', v: '约 V0' },
  { min: 5, max: 6, french: '6c', yds: '5.11b', v: '约 V1' },
  { min: 7, max: 8, french: '6c+', yds: '5.11c', v: '约 V2' },
  { min: 9, max: 10, french: '7a', yds: '5.11d', v: '约 V2' },
  { min: 11, max: 12, french: '7a+', yds: '5.12a', v: '约 V3' },
  { min: 13, max: 14, french: '7b', yds: '5.12b', v: '约 V4' },
  { min: 15, max: 16, french: '7b+', yds: '5.12c', v: '约 V5' },
  { min: 17, max: 18, french: '7c', yds: '5.12d', v: '约 V6' },
  { min: 19, max: 20, french: '7c+', yds: '5.13a', v: '约 V7' },
  { min: 21, max: 22, french: '8a', yds: '5.13b', v: '约 V8' },
  { min: 23, max: 24, french: '8a+', yds: '5.13c', v: '约 V9' },
  { min: 25, max: 26, french: '8b', yds: '5.13d', v: '约 V10' },
  { min: 27, max: 28, french: '8b+', yds: '5.14a', v: '约 V11' },
  { min: 29, max: 30, french: '8c', yds: '5.14b', v: '约 V12' },
  { min: 31, max: 32, french: '8c+', yds: '5.14c', v: '约 V13' },
  { min: 33, max: 34, french: '9a', yds: '5.14d', v: '约 V14' },
  { min: 35, max: 36, french: '9a+', yds: '5.15a', v: '约 V15' },
  { min: 37, max: 38, french: '9b', yds: '5.15b', v: '约 V16' },
  { min: 39, max: 39, french: '9b+', yds: '5.15c', v: '约 V17' },
  { min: 40, max: 40, french: '9c', yds: '5.15d', v: '' }
];

// 负重类项目的三种状态：空白未测、已测完成、已测未达成（0 分）。
const LOAD_STATES = [
  { value: 'untested', label: '未测' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '未达成' }
];

const ITEM_KEYS = ['finger', 'pull', 'core', 'hang'];
const ITEM_LABELS = {
  finger: '指力',
  pull: '拉力',
  core: '核心动作',
  hang: '悬挂耐力'
};

const NO_COUNTERPART = '暂无对应档';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function isSeq(value) {
  return Number.isInteger(value) && value > 0;
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatLocalDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function todayLocalDate(now) {
  return formatLocalDate(now instanceof Date ? now : new Date());
}

/** 本地日期字符串（YYYY-MM-DD），必须是真实存在的日期。 */
function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function timestamp(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (hasText(now)) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

let idSeq = 0;

/** 一次新建录入的测试 ID：页面为这次录入生成一次，重试沿用同一个。 */
function newTestId() {
  idSeq += 1;
  return 'fit-' + Date.now().toString(36) + '-' + idSeq + '-' + Math.random().toString(36).slice(2, 8);
}

let archiveSeq = 0;

/** 首次落盘时生成的自测档案 ID；一经写入随记录持久化，重开保持一致。 */
function newArchiveId() {
  archiveSeq += 1;
  return 'fitness-archive-' + Date.now().toString(36) + '-' + archiveSeq + '-' + Math.random().toString(36).slice(2, 8);
}

// ------------------------------------------------------------------ 数值输入

/**
 * 解析表单里的数字文本：只接受十进制数（可带负号与小数）。
 * 空串、`Infinity`、`NaN`、`1e5`、单位后缀等一律当作非数拒收。
 */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 体重：必须是大于 0 的有限数。负数、0、非数、无穷都返回 null。 */
function parsePositiveKg(value) {
  const parsed = parseNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * 可选的非负数值输入，区分三种情况：
 * - { state: 'blank' }   没填 —— 这一项按「未测」处理；
 * - { state: 'value', value } 有效数值；
 * - { state: 'invalid' } 填了但不是非负数（负数、非数、无穷）。
 */
function readOptionalNonNegative(value) {
  if (value === null || value === undefined) return { state: 'blank', value: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { state: 'invalid', value: null };
    return { state: 'value', value: value };
  }
  const text = String(value).trim();
  if (text === '') return { state: 'blank', value: null };
  const parsed = parseNumber(text);
  if (parsed === null || parsed < 0) return { state: 'invalid', value: null };
  return { state: 'value', value: parsed };
}

// ------------------------------------------------------------------ 计分

/**
 * 总负荷相对体重的比例（百分比）：（体重＋额外负重）÷ 体重 × 100，四位小数四舍五入。
 * 只用于展示。计分不读这个值，而是按原始负荷直接比较档位阈值
 * （compareLoadToThreshold），否则 109.99998% 会被舍入成 110% 而多算一档。
 */
function loadPercent(weightKg, extraKg) {
  const percent = ((weightKg + extraKg) / weightKg) * 100;
  return Math.round(percent * 10000) / 10000;
}

/**
 * 十进制数值 → { digits, scale }（值 = digits ÷ 10^scale）。
 * 取 number 的最短十进制往返表示，也就是输入框里那个十进制数（如 '5.99999'），
 * 拆成整数分子与小数位数，供计分做精确比较；显示不走这里。
 */
function decimalParts(value) {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] || '';
  const exponent = match[4] ? Number(match[4]) : 0;
  let digits = Number(match[1] + match[2] + fraction);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= Math.pow(10, -scale);
    scale = 0;
  }
  return Number.isFinite(digits) ? { digits, scale } : null;
}

/**
 * 原始负荷（体重＋额外负重）与档位的比较：>0 已超过该档、0 正好达到（十进制意义上）、
 * <0 未达到。计分只看原始负荷，不经过任何十进制舍入。
 *
 * 与「总负荷 ÷ 体重 ≥ 档位 ÷ 100」等价，但改写为「额外负重 × 100 与 体重 ×（档位 − 100）」
 * 比较，两侧都是小整数乘积：先把两者放大到同一小数位做精确整数比较（输入的十进制位数在
 * IEEE-754 安全整数范围内时结果是完全精确的，非整数体重也精确）；只有小数位数极端多、
 * 放大后超出安全整数范围时，才退回按机器精度量级的余量比较——那时两侧差值已在 double
 * 自身分辨率的几个 ulp 以内，凡是 double 能分辨的十进制差异仍然得到精确结论。
 */
function compareLoadToThreshold(weightKg, extraKg, threshold) {
  const weight = decimalParts(weightKg);
  const extra = decimalParts(extraKg);
  if (weight && extra) {
    const scale = Math.max(weight.scale, extra.scale);
    const extra100 = extra.digits * 100 * Math.pow(10, scale - extra.scale);
    const weightGap = weight.digits * (threshold - 100) * Math.pow(10, scale - weight.scale);
    if (Number.isSafeInteger(extra100) && Number.isSafeInteger(weightGap)) {
      return extra100 === weightGap ? 0 : extra100 > weightGap ? 1 : -1;
    }
  }
  const extra100 = extraKg * 100;
  const weightGap = weightKg * (threshold - 100);
  const slack = LOAD_COMPARE_SLACK * Math.max(Math.abs(extra100), Math.abs(weightGap), 1);
  if (Math.abs(extra100 - weightGap) <= slack) return 0;
  return extra100 > weightGap ? 1 : -1;
}

/** 负重项：取已经达到的最高档，超出最高档封顶 10 分。 */
function scoreLoad(weightKg, extraKg) {
  let points = 0;
  let reached = 0;
  LOAD_THRESHOLDS.forEach((threshold, index) => {
    if (compareLoadToThreshold(weightKg, extraKg, threshold) >= 0) {
      points = index + 1;
      reached = threshold;
    }
  });
  const top = LOAD_THRESHOLDS[LOAD_THRESHOLDS.length - 1];
  return {
    points,
    percent: loadPercent(weightKg, extraKg),
    reachedThreshold: reached,
    // 超过最高档：分数封顶，档位按最高档显示（正好等于最高档不算超过）。
    capped: compareLoadToThreshold(weightKg, extraKg, top) > 0
  };
}

/** 悬挂耐力：按阈值取整档（达到的秒数向下取到已列档位），超出最高档封顶。 */
function scoreHang(seconds) {
  let points = 0;
  let reached = 0;
  HANG_THRESHOLDS.forEach((threshold, index) => {
    if (seconds >= threshold) {
      points = index + 1;
      reached = threshold;
    }
  });
  return {
    points,
    reachedThreshold: reached,
    capped: seconds > HANG_THRESHOLDS[HANG_THRESHOLDS.length - 1]
  };
}

function coreAction(actionKey) {
  return CORE_ACTIONS.find(item => item.key === actionKey) || null;
}

/** 核心动作：只在这个动作自己的档位里取得分最高的一档，不跨动作相加。 */
function scoreCore(actionKey, seconds) {
  const action = coreAction(actionKey);
  if (!action) return null;
  let points = 0;
  let reached = 0;
  action.steps.forEach(step => {
    if (seconds >= step.seconds) {
      points = step.points;
      reached = step.seconds;
    }
  });
  return { points, action, reachedThreshold: reached };
}

/** 总分查原对照表；0 分与超出 40 分都没有对应行（不插值、不补档）。 */
function gradeForTotal(total) {
  if (!Number.isFinite(total) || total < 1) return null;
  return GRADE_TABLE.find(row => total >= row.min && total <= row.max) || null;
}

/** 三个对照读数：法式运动攀体能参考、YDS、抱石跨项目对照（约 V 级）。 */
function gradeLines(total) {
  const row = gradeForTotal(total);
  if (!row) return [];
  return [
    { key: 'french', label: '运动攀体能参考（法式）', value: row.french },
    { key: 'yds', label: '顶绳 / 先锋（YDS）', value: row.yds },
    { key: 'v', label: '抱石跨项目对照（约 V 级）', value: row.v || NO_COUNTERPART }
  ];
}

function itemStatus(points) {
  if (points === null || points === undefined) return 'untested';
  return points > 0 ? 'measured' : 'failed';
}

function statusTextOf(status) {
  if (status === 'untested') return '未测';
  if (status === 'failed') return '已测未达';
  return '已测';
}

function pointsTextOf(points) {
  return points === null || points === undefined ? '—' : points + ' 分';
}

/**
 * 负重项（指力 / 拉力）的分项结果。
 * 三种状态都能表达：未填＝未测；选了「未达成」＝已测未达（0 分）；
 * 选了「完成」并按额外负重算负荷——0 kg 即自重成功，得 1 分。
 */
function evaluateLoadItem(key, state, extraText, weightKg) {
  const label = ITEM_LABELS[key];
  const item = {
    key,
    label,
    status: 'untested',
    statusText: '未测',
    points: null,
    pointsText: '—',
    rawText: '未填写',
    levelText: ''
  };
  const stateValue = LOAD_STATES.some(entry => entry.value === state) ? state : 'untested';

  if (stateValue === 'untested') return { item };

  if (stateValue === 'failed') {
    item.status = 'failed';
    item.statusText = '已测未达';
    item.points = 0;
    item.pointsText = '0 分';
    item.rawText = '已经测过，未完成动作（未达第一档）';
    return { item };
  }

  const read = readOptionalNonNegative(extraText);
  if (read.state === 'blank') {
    return { item, error: label + '：请填写额外负重（kg），只挂自重请填 0' };
  }
  if (read.state === 'invalid') {
    return { item, error: label + '：额外负重须为非负数（kg）' };
  }
  if (weightKg === null) {
    // 体重非法时已经报了体重错误，这一项按未测展示，不重复报错。
    return { item };
  }

  const scored = scoreLoad(weightKg, read.value);
  item.status = itemStatus(scored.points);
  item.statusText = statusTextOf(item.status);
  item.points = scored.points;
  item.pointsText = pointsTextOf(scored.points);
  item.rawText =
    (read.value === 0 ? '自重' : '额外负重 ' + read.value + ' kg') +
    '（总负荷 ' + scored.percent + '%）';
  item.levelText = scored.capped
    ? '已达最高档（' + LOAD_THRESHOLDS[LOAD_THRESHOLDS.length - 1] + '% 以上封顶）'
    : '第 ' + scored.points + ' 档（' + scored.reachedThreshold + '%）';
  return { item };
}

/** 核心动作项：选了动作又填了秒数才算已测；低于该动作第一档记 0 分。 */
function evaluateCoreItem(actionKey, secondsText) {
  const item = {
    key: 'core',
    label: ITEM_LABELS.core,
    status: 'untested',
    statusText: '未测',
    points: null,
    pointsText: '—',
    rawText: '未填写',
    levelText: ''
  };
  const read = readOptionalNonNegative(secondsText);
  if (read.state === 'invalid') {
    return { item, error: '核心动作：持续秒数须为非负数' };
  }

  const action = coreAction(actionKey);
  if (read.state === 'blank') {
    // 只选了动作没填秒数：这一项仍是未测（不猜、不按 0 秒计分）。
    if (action) item.rawText = action.label + '（未填秒数）';
    return { item };
  }
  if (!action) {
    return { item, error: '核心动作：请选择做过得分最高的动作' };
  }

  const scored = scoreCore(action.key, read.value);
  item.status = itemStatus(scored.points);
  item.statusText = statusTextOf(item.status);
  item.points = scored.points;
  item.pointsText = pointsTextOf(scored.points);
  item.rawText = action.label + ' ' + read.value + ' 秒';
  item.levelText = scored.points > 0
    ? '第 ' + scored.points + ' 档（' + scored.reachedThreshold + ' 秒起）'
    : '未达该动作第一档（' + action.steps[0].seconds + ' 秒）';
  item.action = action.key;
  item.actionLabel = action.label;
  item.seconds = read.value;
  return { item };
}

/** 悬挂耐力项：自重悬挂，秒数按阈值取整档；低于 30 秒记 0 分。 */
function evaluateHangItem(secondsText) {
  const item = {
    key: 'hang',
    label: ITEM_LABELS.hang,
    status: 'untested',
    statusText: '未测',
    points: null,
    pointsText: '—',
    rawText: '未填写',
    levelText: ''
  };
  const read = readOptionalNonNegative(secondsText);
  if (read.state === 'invalid') {
    return { item, error: '悬挂耐力：秒数须为非负数' };
  }
  if (read.state === 'blank') return { item };

  const scored = scoreHang(read.value);
  item.status = itemStatus(scored.points);
  item.statusText = statusTextOf(item.status);
  item.points = scored.points;
  item.pointsText = pointsTextOf(scored.points);
  item.rawText = '自重悬挂 ' + read.value + ' 秒';
  item.levelText = scored.points > 0
    ? (scored.capped
      ? '已达最高档（' + HANG_THRESHOLDS[HANG_THRESHOLDS.length - 1] + ' 秒以上封顶）'
      : '第 ' + scored.points + ' 档（' + scored.reachedThreshold + ' 秒起）')
    : '未达第一档（30 秒）';
  item.seconds = read.value;
  return { item };
}

/**
 * 把一份表单（字符串或数字都能读）算成页面要展示的分项、总分与三对照。
 *
 * 返回：
 * - ok / error          表单是否可保存，以及第一条可见错误；
 * - weightKg            有效体重（非法为 null）；
 * - items               四项分项结果（顺序固定：指力、拉力、核心、悬挂）；
 * - measuredCount       已测项数（含已测未达）；
 * - complete / total    四项都测才给总分，否则 total 为 null；
 * - totalText           总分文案；四项合计 0 时为「尚未达到原表起评档」；
 * - grade / gradeLines  总分对照；0 分或没有对应档时为 null / 空数组。
 */
function evaluateForm(form) {
  const data = form || {};
  const errors = [];

  const weightKg = parsePositiveKg(data.weightKg);
  if (weightKg === null) errors.push('体重必须是大于 0 的数（kg），负数、非数与无穷不接受');

  const date = typeof data.date === 'string' ? data.date.trim() : '';
  if (!isDateString(date)) errors.push('测试日期无效，请使用本地日期（YYYY-MM-DD）');

  const finger = evaluateLoadItem('finger', data.fingerState, data.fingerExtraKg, weightKg);
  const pull = evaluateLoadItem('pull', data.pullState, data.pullExtraKg, weightKg);
  const core = evaluateCoreItem(data.coreAction, data.coreSeconds);
  const hang = evaluateHangItem(data.hangSeconds);
  [finger, pull, core, hang].forEach(entry => {
    if (entry.error) errors.push(entry.error);
  });

  const items = [finger.item, pull.item, core.item, hang.item];
  const measuredCount = items.filter(item => item.status !== 'untested').length;
  const complete = measuredCount === items.length;

  let total = null;
  let totalText = '四项都测后才显示总分（还差 ' + (items.length - measuredCount) + ' 项）';
  let grade = null;
  let lines = [];
  if (complete) {
    total = items.reduce((sum, item) => sum + item.points, 0);
    if (total === 0) {
      totalText = '尚未达到原表起评档';
    } else {
      grade = gradeForTotal(total);
      lines = gradeLines(total);
      totalText = total + ' / 40 · ' + (grade ? grade.french + ' · ' + grade.yds + ' · ' + (grade.v || NO_COUNTERPART) : NO_COUNTERPART);
    }
  }

  return {
    ok: errors.length === 0,
    error: errors.length ? errors[0] : '',
    errors,
    date,
    weightKg,
    items,
    measuredCount,
    complete,
    total,
    totalText,
    grade,
    gradeLines: lines
  };
}

// ------------------------------------------------------------------ 记录层

function createEmptyState() {
  return {
    version: STATE_VERSION,
    archiveId: newArchiveId(),
    nextTestSeq: 1,
    tests: []
  };
}

function normalizeCounter(value, tests) {
  const max = tests.reduce((acc, item) => (isSeq(item.seq) ? Math.max(acc, item.seq) : acc), 0);
  return isSeq(value) && value > max ? value : max + 1;
}

function normalizeStoredLoad(raw, weightKg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const state = LOAD_STATES.some(entry => entry.value === raw.state) ? raw.state : null;
  if (!state) return null;
  // 未测＝无分；已测未达＝0 分（明确测过但没完成动作）。
  if (state === 'untested') return { state, extraKg: 0, points: null };
  if (state === 'failed') return { state, extraKg: 0, points: 0 };
  const extraKg = readOptionalNonNegative(raw.extraKg);
  if (extraKg.state !== 'value') return null;
  const scored = scoreLoad(weightKg, extraKg.value);
  return { state, extraKg: extraKg.value, points: scored.points };
}

function normalizeStoredCore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const actionKey = raw.action === undefined || raw.action === null ? '' : raw.action;
  if (actionKey !== '' && !coreAction(actionKey)) return null;
  const seconds = readOptionalNonNegative(raw.seconds);
  if (seconds.state === 'invalid') return null;
  if (seconds.state === 'blank') return { action: actionKey, seconds: null, points: null };
  if (!actionKey) return { action: '', seconds: null, points: null };
  const scored = scoreCore(actionKey, seconds.value);
  return { action: actionKey, seconds: seconds.value, points: scored.points };
}

function normalizeStoredHang(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const seconds = readOptionalNonNegative(raw.seconds);
  if (seconds.state === 'invalid') return null;
  if (seconds.state === 'blank') return { seconds: null, points: null };
  return { seconds: seconds.value, points: scoreHang(seconds.value).points };
}

/**
 * 一条已存记录 → 两个版本标识的取值，以及它们是从哪来的。
 * - source 'stored'  记录自带独立的评分规则版本与对照表版本（当前版本保存的记录）；
 * - source 'legacy'  只有 v0.1 的单一 tableVersion（值＝LEGACY_TABLE_VERSION）：
 *                    那时评分规则与对照表合并成一个版本号，所以按实际原始 v0.1 规则
 *                    把评分规则版本补成 SCORING_VERSION；对照表版本仍是原值，不改写；
 * - source 'unknown' 认不出的对照表版本：只如实回显原值，不替它推断评分规则版本
 *                    （不补编、不猜测历史版本）。
 */
function resolveVersions(entry) {
  const storedScoring = hasText(entry.scoringVersion) ? entry.scoringVersion : '';
  const storedTable = hasText(entry.tableVersion) ? entry.tableVersion : '';
  if (storedScoring) {
    return {
      scoringVersion: storedScoring,
      tableVersion: storedTable || TABLE_VERSION,
      source: 'stored'
    };
  }
  if (storedTable === LEGACY_TABLE_VERSION) {
    return { scoringVersion: SCORING_VERSION, tableVersion: LEGACY_TABLE_VERSION, source: 'legacy' };
  }
  return { scoringVersion: '', tableVersion: storedTable, source: 'unknown' };
}

/**
 * 只接受当前版本、结构完整的记录；损坏或版本不支持时返回 null，
 * 由调用方报错并保留原数据（读写入口都不会覆盖它）。
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== STATE_VERSION) return null;
  if (!hasText(raw.archiveId)) return null;
  if (!Array.isArray(raw.tests)) return null;

  const tests = [];
  for (const entry of raw.tests) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (!hasText(entry.id) || !isSeq(entry.seq)) return null;
    if (!isDateString(entry.date)) return null;
    if (!hasText(entry.createdAt)) return null;
    if (!hasText(entry.tableVersion)) return null;
    const versions = resolveVersions(entry);
    const weightKg = parsePositiveKg(entry.weightKg);
    if (weightKg === null) return null;

    const finger = normalizeStoredLoad(entry.finger, weightKg);
    const pull = normalizeStoredLoad(entry.pull, weightKg);
    const core = normalizeStoredCore(entry.core);
    const hang = normalizeStoredHang(entry.hang);
    if (!finger || !pull || !core || !hang) return null;

    const points = [finger.points, pull.points, core.points, hang.points];
    const measuredCount = points.filter(value => value !== null && value !== undefined).length;
    const total = measuredCount === 4 ? points.reduce((sum, value) => sum + value, 0) : null;

    tests.push({
      id: entry.id,
      seq: entry.seq,
      date: entry.date,
      // 旧记录没有自带档案 ID 时按所在档案补上（兼容读取，不判损坏）。
      archiveId: hasText(entry.archiveId) ? entry.archiveId : raw.archiveId,
      weightKg,
      finger: { state: finger.state, extraKg: finger.state === 'done' ? finger.extraKg : 0 },
      pull: { state: pull.state, extraKg: pull.state === 'done' ? pull.extraKg : 0 },
      core: { action: core.action, seconds: core.seconds },
      hang: { seconds: hang.seconds },
      points: { finger: finger.points, pull: pull.points, core: core.points, hang: hang.points },
      total,
      // 两个版本标识分别带回，并记住它们是从哪来的（当前记录 / v0.1 旧记录 / 认不出）。
      scoringVersion: versions.scoringVersion,
      tableVersion: versions.tableVersion,
      versionSource: versions.source,
      createdAt: entry.createdAt,
      updatedAt: hasText(entry.updatedAt) ? entry.updatedAt : ''
    });
  }

  const ids = new Set(tests.map(item => item.id));
  if (ids.size !== tests.length) return null;
  const seqs = new Set(tests.map(item => item.seq));
  if (seqs.size !== tests.length) return null;

  return {
    version: STATE_VERSION,
    archiveId: raw.archiveId,
    nextTestSeq: normalizeCounter(raw.nextTestSeq, tests),
    tests
  };
}

/**
 * 读取本机自测记录。返回 { state, error, ok, present, corrupt }：
 * - 无键（首次进入）：ok:true、present:false、空记录，不报错；
 * - 解析或结构损坏、版本不受支持：ok:false、corrupt:true、可见错误，原数据保持不动；
 * - 读取本身失败：ok:false、可见错误。
 * state 始终可用于只读展示；写入口在 ok:false 时一律拒绝落盘。
 */
function loadState() {
  let raw;
  try {
    raw = wx.getStorageSync(STATE_KEY);
  } catch (error) {
    return {
      state: createEmptyState(),
      error: STATE_READ_FAILED + errorText(error),
      ok: false,
      present: false,
      corrupt: false
    };
  }

  if (raw === '' || raw === null || raw === undefined) {
    return { state: createEmptyState(), error: '', ok: true, present: false, corrupt: false };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { state: createEmptyState(), error: STATE_BROKEN, ok: false, present: true, corrupt: true };
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed.version !== undefined &&
    parsed.version !== STATE_VERSION
  ) {
    return { state: createEmptyState(), error: STATE_UNSUPPORTED, ok: false, present: true, corrupt: true };
  }

  const state = normalizeState(parsed);
  if (!state) {
    return { state: createEmptyState(), error: STATE_BROKEN, ok: false, present: true, corrupt: true };
  }
  return { state, error: '', ok: true, present: true, corrupt: false };
}

function saveState(state) {
  try {
    wx.setStorageSync(STATE_KEY, JSON.stringify(state));
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: STATE_WRITE_FAILED + errorText(error) };
  }
}

/** 正式命名空间里的键（自测记录与将来加入的正式键）：不是可重建缓存，清缓存不动。 */
function isFitnessKey(key) {
  return typeof key === 'string' && key.indexOf(NAMESPACE) === 0;
}

/**
 * 保存一次自测（新建或修改）。
 *
 * 输入：表单值（date / weightKg / fingerState / fingerExtraKg / pullState /
 * pullExtraKg / coreAction / coreSeconds / hangSeconds）与 options：
 * - options.testId  这次录入的测试 ID；不传时自动生成。
 *   已经存在同 ID 的条目＝修改那一条（只换输入与评分，不新增）；
 *   不存在＝按这个 ID 新建（同一 ID 重复提交只落一条，重试幂等）；
 * - options.now     可注入时间，便于离线测试。
 *
 * 返回 { ok, code, error, record, state }：
 * code：created / updated / invalid / unreadable / write-failed。
 * 校验不通过或落盘失败都不写盘，原记录保持不动。
 */
function saveTest(form, options) {
  const data = options || {};
  const evaluated = evaluateForm(form);
  if (!evaluated.ok) {
    const loaded = loadState();
    return { ok: false, code: 'invalid', error: evaluated.error, errors: evaluated.errors, evaluated, state: loaded.state, record: null };
  }

  const loaded = loadState();
  if (!loaded.ok) {
    return { ok: false, code: 'unreadable', error: loaded.error, errors: [loaded.error], evaluated, state: loaded.state, record: null };
  }

  const state = clone(loaded.state);
  const requestedId = hasText(data.testId) ? data.testId : newTestId();
  const index = state.tests.findIndex(item => item.id === requestedId);
  const existing = index === -1 ? null : state.tests[index];
  const createdAt = timestamp(data.now);
  const [fingerItem, pullItem, coreItem, hangItem] = evaluated.items;

  // 原始输入按评估结果原样保存：空白＝未测（负数与非法值在上一步已被拒收）。
  const fingerState = normalizeStateValue(form.fingerState);
  const pullState = normalizeStateValue(form.pullState);
  const record = {
    id: existing ? existing.id : requestedId,
    seq: existing ? existing.seq : state.nextTestSeq,
    date: evaluated.date,
    // 档案 ID 与测试 ID 一起随记录保存：每条记录都自带它属于哪份本机自测档案。
    archiveId: state.archiveId,
    weightKg: evaluated.weightKg,
    finger: {
      state: fingerState,
      extraKg: fingerState === 'done' ? readOptionalNonNegative(form.fingerExtraKg).value : 0
    },
    pull: {
      state: pullState,
      extraKg: pullState === 'done' ? readOptionalNonNegative(form.pullExtraKg).value : 0
    },
    core: {
      action: coreItem.action || (hasText(form.coreAction) ? form.coreAction : ''),
      seconds: coreItem.seconds === undefined ? null : coreItem.seconds
    },
    hang: { seconds: hangItem.seconds === undefined ? null : hangItem.seconds },
    points: {
      finger: fingerItem.points,
      pull: pullItem.points,
      core: coreItem.points,
      hang: hangItem.points
    },
    total: evaluated.total,
    // 评分规则版本与对照表版本各自独立保存：这次录入是按这两份表算的。
    scoringVersion: SCORING_VERSION,
    tableVersion: TABLE_VERSION,
    versionSource: 'stored',
    createdAt: existing ? existing.createdAt : createdAt,
    updatedAt: existing ? createdAt : ''
  };

  if (existing) {
    state.tests[index] = record;
  } else {
    state.tests.push(record);
    state.nextTestSeq = Math.max(state.nextTestSeq, record.seq + 1);
  }

  const saved = saveState(state);
  if (!saved.ok) {
    return { ok: false, code: 'write-failed', error: saved.error, errors: [saved.error], evaluated, state: loaded.state, record: null };
  }
  return {
    ok: true,
    code: existing ? 'updated' : 'created',
    error: '',
    errors: [],
    evaluated,
    record: clone(record),
    state
  };
}

function normalizeStateValue(value) {
  return LOAD_STATES.some(entry => entry.value === value) ? value : 'untested';
}

// ------------------------------------------------------------------ 展示与比较

function dateTextOf(date) {
  if (!isDateString(date)) return date || '';
  return date;
}

/**
 * 这条记录的两个版本号是从哪来的：当前记录不额外解释；
 * v0.1 旧记录说明原值只有一个合并版本号，评分规则按原始 v0.1 回显；
 * 认不出的对照表版本如实说明评分规则版本未记录（不猜）。
 */
function versionSourceTextOf(record) {
  if (record.versionSource === 'legacy') {
    return 'v0.1 旧记录：原只存一个版本号 ' + LEGACY_TABLE_VERSION +
      '（评分规则与对照表合并），评分规则按原始 v0.1 回显';
  }
  if (record.versionSource === 'unknown') {
    return '这条记录的对照表版本 ' + record.tableVersion + ' 无法识别，评分规则版本未记录';
  }
  return '';
}

/**
 * 一条已存记录（findTest / state.tests 里的原始记录）→ 展示行。
 * 重开列表、比较与页面回填共用同一份口径；输入必须是原始记录，不是展示行本身。
 */
function describeTest(record) {
  const weightKg = record.weightKg;
  const finger = record.finger || { state: 'untested', extraKg: 0 };
  const pull = record.pull || { state: 'untested', extraKg: 0 };
  const core = record.core || { action: '', seconds: null };
  const hang = record.hang || { seconds: null };
  const points = record.points || {};

  function loadRow(key, label, item) {
    const state = normalizeStateValue(item.state);
    if (state === 'untested') {
      return { key, label, status: 'untested', statusText: '未测', points: null, pointsText: '—', rawText: '未填写' };
    }
    if (state === 'failed') {
      return { key, label, status: 'failed', statusText: '已测未达', points: 0, pointsText: '0 分', rawText: '已经测过，未完成动作（未达第一档）' };
    }
    const scored = scoreLoad(weightKg, item.extraKg);
    return {
      key,
      label,
      status: itemStatus(points[key]),
      statusText: statusTextOf(itemStatus(points[key])),
      points: points[key],
      pointsText: pointsTextOf(points[key]),
      rawText: (item.extraKg === 0 ? '自重' : '额外负重 ' + item.extraKg + ' kg') + '（总负荷 ' + scored.percent + '%）'
    };
  }

  let coreRow;
  if (core.seconds === null || core.seconds === undefined) {
    coreRow = { key: 'core', label: ITEM_LABELS.core, status: 'untested', statusText: '未测', points: null, pointsText: '—', rawText: '未填写' };
  } else {
    const action = coreAction(core.action);
    coreRow = {
      key: 'core',
      label: ITEM_LABELS.core,
      status: itemStatus(points.core),
      statusText: statusTextOf(itemStatus(points.core)),
      points: points.core,
      pointsText: pointsTextOf(points.core),
      rawText: (action ? action.label : '未选动作') + ' ' + core.seconds + ' 秒'
    };
  }

  let hangRow;
  if (hang.seconds === null || hang.seconds === undefined) {
    hangRow = { key: 'hang', label: ITEM_LABELS.hang, status: 'untested', statusText: '未测', points: null, pointsText: '—', rawText: '未填写' };
  } else {
    hangRow = {
      key: 'hang',
      label: ITEM_LABELS.hang,
      status: itemStatus(points.hang),
      statusText: statusTextOf(itemStatus(points.hang)),
      points: points.hang,
      pointsText: pointsTextOf(points.hang),
      rawText: '自重悬挂 ' + hang.seconds + ' 秒'
    };
  }

  const total = record.total === undefined ? null : record.total;
  const lines = total === null ? [] : gradeLines(total);
  // 两个版本号分别回显：评分规则版本缺记录时如实写「未记录」，不拿当前值冒充。
  const scoringVersion = hasText(record.scoringVersion) ? record.scoringVersion : '';
  const tableVersion = hasText(record.tableVersion) ? record.tableVersion : TABLE_VERSION;
  return {
    id: record.id,
    seq: record.seq,
    date: record.date,
    dateText: dateTextOf(record.date),
    weightKg,
    weightText: weightKg + ' kg',
    items: [loadRow('finger', ITEM_LABELS.finger, finger), loadRow('pull', ITEM_LABELS.pull, pull), coreRow, hangRow],
    total,
    totalText: total === null ? '四项未测齐，无总分' : total === 0 ? '尚未达到原表起评档' : total + ' / 40',
    gradeLines: lines,
    gradeText: lines.length ? lines[0].value + ' · ' + lines[1].value + ' · ' + lines[2].value : '—',
    scoringVersion,
    tableVersion,
    versionSource: record.versionSource || '',
    scoringVersionText: '评分规则 ' + (scoringVersion || '未记录'),
    tableVersionText: '对照表 ' + tableVersion,
    versionText: '评分规则 ' + (scoringVersion || '未记录') + ' · 对照表 ' + tableVersion,
    versionSourceText: versionSourceTextOf(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || ''
  };
}

/** 已保存记录：按日期新在前（同日按序号大在前），每条都带展示行。 */
function listTests(state) {
  const source = state && Array.isArray(state.tests) ? state.tests : [];
  return source
    .slice()
    .sort((left, right) => right.date.localeCompare(left.date) || (right.seq || 0) - (left.seq || 0))
    .map(describeTest);
}

function findTest(state, testId) {
  const source = state && Array.isArray(state.tests) ? state.tests : [];
  return source.find(item => item.id === testId) || null;
}

/**
 * 两次自测的分项比较：同一天也可以比，两条各自的原始数据、分项得分与总分
 * 逐项并排显示。只读计算，不改记录、不插值、不换算成别的单位。
 */
function compareTests(state, idA, idB) {
  const left = findTest(state, hasText(idA) ? idA : '');
  const right = findTest(state, hasText(idB) ? idB : '');
  if (!left || !right) {
    return { ok: false, error: '请选择两条仍在的备份记录再比较', rows: [], summary: null };
  }
  const leftRow = describeTest(left);
  const rightRow = describeTest(right);

  const rows = leftRow.items.map((item, index) => {
    const other = rightRow.items[index];
    let deltaText = '';
    if (item.points !== null && other.points !== null) {
      const delta = other.points - item.points;
      deltaText = delta === 0 ? '分项相同' : '分项 ' + (delta > 0 ? '+' : '') + delta;
    } else if (item.points === null && other.points !== null) {
      deltaText = '新增第 ' + other.points + ' 分';
    } else if (item.points !== null && other.points === null) {
      deltaText = '本次未测';
    }
    return {
      key: item.key,
      label: item.label,
      left: { rawText: item.rawText, statusText: item.statusText, pointsText: item.pointsText, points: item.points },
      right: { rawText: other.rawText, statusText: other.statusText, pointsText: other.pointsText, points: other.points },
      deltaText
    };
  });

  let totalDeltaText = '';
  if (leftRow.total !== null && rightRow.total !== null) {
    const delta = rightRow.total - leftRow.total;
    totalDeltaText = delta === 0 ? '总分相同' : '总分 ' + (delta > 0 ? '+' : '') + delta;
  } else {
    totalDeltaText = '两次都测齐四项才能比总分';
  }

  // 两次的两个版本号并排可核对；版本不同就说明这两次的分项/总分不能直接比。
  const scoringSame = leftRow.scoringVersion === rightRow.scoringVersion;
  const tableSame = leftRow.tableVersion === rightRow.tableVersion;
  let versionNoticeText = '';
  if (!scoringSame && !tableSame) {
    versionNoticeText = '两次的评分规则版本与对照表版本都不同，分项得分与总分不可直接比较';
  } else if (!scoringSame) {
    versionNoticeText = '两次的评分规则版本不同，分项得分不可直接比较';
  } else if (!tableSame) {
    versionNoticeText = '两次的对照表版本不同，总分对照不可直接比较';
  }

  return {
    ok: true,
    error: '',
    left: leftRow,
    right: rightRow,
    rows,
    summary: {
      leftText: leftRow.dateText + ' · ' + leftRow.totalText + ' · ' + leftRow.gradeText + ' · ' + leftRow.weightText,
      rightText: rightRow.dateText + ' · ' + rightRow.totalText + ' · ' + rightRow.gradeText + ' · ' + rightRow.weightText,
      leftVersionText: leftRow.versionText,
      rightVersionText: rightRow.versionText,
      leftVersions: { scoringVersion: leftRow.scoringVersion, tableVersion: leftRow.tableVersion },
      rightVersions: { scoringVersion: rightRow.scoringVersion, tableVersion: rightRow.tableVersion },
      versionNoticeText,
      totalDeltaText
    }
  };
}

module.exports = {
  NAMESPACE,
  STATE_KEY,
  STATE_VERSION,
  SCORING_VERSION,
  TABLE_VERSION,
  LEGACY_TABLE_VERSION,
  STATE_BROKEN,
  STATE_UNSUPPORTED,
  LOAD_THRESHOLDS,
  HANG_THRESHOLDS,
  CORE_ACTIONS,
  GRADE_TABLE,
  LOAD_STATES,
  ITEM_KEYS,
  ITEM_LABELS,
  NO_COUNTERPART,
  clone,
  formatLocalDate,
  todayLocalDate,
  isDateString,
  newTestId,
  parseNumber,
  parsePositiveKg,
  readOptionalNonNegative,
  loadPercent,
  compareLoadToThreshold,
  scoreLoad,
  scoreHang,
  scoreCore,
  coreAction,
  gradeForTotal,
  gradeLines,
  evaluateForm,
  createEmptyState,
  resolveVersions,
  normalizeState,
  loadState,
  saveState,
  isFitnessKey,
  saveTest,
  describeTest,
  listTests,
  findTest,
  compareTests
};
