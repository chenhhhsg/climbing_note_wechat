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

module.exports = {
  CLIMB_TYPES,
  BOULDER_GRADES,
  ROPE_GRADES,
  GRADES_BY_TYPE,
  DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE,
  GRADE_PLACEHOLDER,
  isClimbType,
  gradesForType,
  isGradeForType,
  climbTypeOf,
  gradeText
};
