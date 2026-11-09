/**
 * 岩馆快速记录 · 攀岩类型与适用等级规则（本机试用）
 *
 * 试用工程可以被单独导入开发者工具运行，所以本文件不 require 正式工程的
 * utils/grade.js，而是按正式等级表核对后的取值与顺序保留一份只读副本：
 * - 抱石：V 级（VB、V0–V16）
 * - 顶绳、先锋：YDS（5.6–5.15a）
 *
 * 只做类型与等级的匹配与展示；不读写缓存，也不改动画线、场次或尝试。
 * 旧线路没有 climbType 字段（旧 V 级线路）时按抱石读取，浏览不会写回或迁移。
 *
 * 这里同时给出「抱石首次完攀」的共用判定：抱石（含缺类型的旧 V 级线路）一次完攀后
 * 不再新增，顶绳和先锋可重复；归属按「试用用户 + 数据集 + 长期线路 ID」比较。
 * 误点完攀时按同一份规则挑出「最近一把可识别的已确认完攀」，供「改为未完成」原位改正。
 * 判定是纯函数，今日页、详情页与模拟保存账本用同一份规则。
 */
const CLIMB_TYPES = ['抱石', '顶绳', '先锋'];

// 与正式 utils/grade.js 的 vScaleGrades 取值和顺序一致。
const BOULDER_GRADES = [
  'VB',
  'V0',
  'V1',
  'V2',
  'V3',
  'V4',
  'V5',
  'V6',
  'V7',
  'V8',
  'V9',
  'V10',
  'V11',
  'V12',
  'V13',
  'V14',
  'V15',
  'V16'
];

// 与正式 utils/grade.js 的 ydsGrades 取值和顺序一致。
const ROPE_GRADES = [
  '5.6',
  '5.7',
  '5.8',
  '5.9',
  '5.10a',
  '5.10b',
  '5.10c',
  '5.10d',
  '5.11a',
  '5.11b',
  '5.11c',
  '5.11d',
  '5.12a',
  '5.12b',
  '5.12c',
  '5.12d',
  '5.13a',
  '5.13b',
  '5.13c',
  '5.13d',
  '5.14a',
  '5.14b',
  '5.14c',
  '5.14d',
  '5.15a'
];

const GRADES_BY_TYPE = {
  抱石: BOULDER_GRADES,
  顶绳: ROPE_GRADES,
  先锋: ROPE_GRADES
};

const DEFAULT_CLIMB_TYPE = '抱石';
const DEFAULT_GRADE = 'V3';
// 类型切换后原等级失效时，选择器显示的占位文案。
const GRADE_PLACEHOLDER = '请选择等级';
// 抱石按「首次完攀」记录；顶绳和先锋可以重复完攀。
const BOULDER_CLIMB_TYPE = '抱石';

function isClimbType(value) {
  return typeof value === 'string' && CLIMB_TYPES.indexOf(value) !== -1;
}

/**
 * 该类型的可选等级；未知类型返回空数组，交由调用方明确报错。
 */
function gradesForType(type) {
  return isClimbType(type) ? GRADES_BY_TYPE[type].slice() : [];
}

/**
 * 等级是否属于该类型；空值和类型错配都返回 false，调用方不得回落取值。
 */
function isGradeForType(type, grade) {
  if (typeof grade !== 'string' || grade.length === 0) return false;
  return gradesForType(type).indexOf(grade) !== -1;
}

/**
 * 线路的攀岩类型：已有有效类型原样返回；缺字段的旧 V 级线路按抱石读取。
 * 只读判断，不修改传入的线路，也不触发缓存迁移。
 */
function climbTypeOf(route) {
  if (route && isClimbType(route.climbType)) return route.climbType;
  return DEFAULT_CLIMB_TYPE;
}

/**
 * 未选到有效等级时显示占位文案，不静默显示首个等级。
 */
function gradeText(grade) {
  return typeof grade === 'string' && grade.length > 0
    ? grade
    : GRADE_PLACEHOLDER;
}

/**
 * 是否按抱石处理：已知类型按名称比较；缺字段或空值的旧 V 级线路按抱石读取
 * （与 climbTypeOf 的兼容规则一致）。非空但非法的类型不回落成抱石。
 */
function isBoulderClimbType(value) {
  if (isClimbType(value)) return value === BOULDER_CLIMB_TYPE;
  return value === undefined || value === null || value === '';
}

function isBoulderRoute(route) {
  return isBoulderClimbType(route ? route.climbType : undefined);
}

/**
 * 该线路是否允许重复完攀：抱石（含旧 V 级）首次完攀即结束，顶绳和先锋可以再记。
 */
function allowsRepeatSend(route) {
  return !isBoulderRoute(route);
}

/**
 * 「已完攀」归属：同一个试用用户 + 同一数据集 + 同一条长期线路 ID。
 * 三者任一不同都不算同一条已完攀线路，避免不同用户上下文或重置后复用编号互相上锁。
 * 线路类型只从路线档案取：账本记录里可省略、可伪造的 climbType 不参与判定。
 */
function isSameSendOwner(left, right) {
  if (!left || !right) return false;
  return (
    String(left.ownerId || '') === String(right.ownerId || '') &&
    String(left.datasetId || '') === String(right.datasetId || '') &&
    String(left.routeId || '') === String(right.routeId || '')
  );
}

/**
 * 「改为未完成」的明确目标（T015 返工）：这条线最近一把可识别的已确认完攀。
 *
 * 只读挑选，不改动任何记录：
 * - 只在同一线路内挑 result === 'send' 的把次，跨线路、跨场次不会串；
 * - 多条历史完攀时取序号最大的一把（最近可识别的那一把），改完一把才轮到前一把，
 *   因此旧汇总和多条历史完攀都能逐次更正，且读取不重写任何历史。
 */
function latestSendAttempt(attempts, routeId) {
  if (!Array.isArray(attempts) || typeof routeId !== 'string' || routeId === '') {
    return null;
  }
  let best = null;
  let bestSeq = -1;
  attempts.forEach(item => {
    if (!item || item.routeId !== routeId || item.result !== 'send') return;
    const seq = Number.isInteger(item.seq) ? item.seq : 0;
    // 序号相同时后加入的更晚，取 >= 让「最近」的含义与追加顺序一致。
    if (!best || seq >= bestSeq) {
      best = item;
      bestSeq = seq;
    }
  });
  return best;
}

module.exports = {
  CLIMB_TYPES,
  BOULDER_GRADES,
  ROPE_GRADES,
  GRADES_BY_TYPE,
  DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE,
  GRADE_PLACEHOLDER,
  BOULDER_CLIMB_TYPE,
  isClimbType,
  gradesForType,
  isGradeForType,
  climbTypeOf,
  gradeText,
  isBoulderClimbType,
  isBoulderRoute,
  allowsRepeatSend,
  isSameSendOwner,
  latestSendAttempt
};
