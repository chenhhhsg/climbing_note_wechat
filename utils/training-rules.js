/**
 * 正式本机训练 · 线路类型与适用等级规则（T016）
 *
 * 正式首页「开始训练」只需三类线路：抱石、顶绳、先锋（与 v0.3 独立工程一致）。
 * 等级取值与顺序不另立一份，直接复用正式 utils/grade.js 的 V 级与 YDS 表：
 * - 抱石：VB、V0–V16（vScaleGrades）
 * - 顶绳、先锋：5.6–5.15a（ydsGrades）
 *
 * 只做类型与等级的匹配、切换与展示；不读写本机档案，也不改动画线或把次。
 * 旧线路没有 climbType 字段（旧 V 级线路）时按抱石读取，浏览不会回写或迁移。
 *
 * 这里同时给出「抱石首次完攀」的共用判定与「改为未完成」的目标挑选：抱石（含缺类型的
 * 旧 V 级线路）一次完攀后不再新增，顶绳和先锋可重复；判定是纯函数，档案层与页面共用。
 */
const grade = require('./grade.js');

const CLIMB_TYPES = ['抱石', '顶绳', '先锋'];
const BOULDER_CLIMB_TYPE = '抱石';
const DEFAULT_CLIMB_TYPE = '抱石';
const DEFAULT_GRADE = 'V3';
// 类型切换后原等级失效时，选择器显示的占位文案。
const GRADE_PLACEHOLDER = '请选择等级';

// 与 utils/grade.js 的实际取值和顺序一致，避免正式工程出现第二份等级表。
const BOULDER_GRADES = grade.vScaleGrades.map(item => item.value);
const ROPE_GRADES = grade.ydsGrades.map(item => item.value);

const GRADES_BY_TYPE = {
  抱石: BOULDER_GRADES,
  顶绳: ROPE_GRADES,
  先锋: ROPE_GRADES
};

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isClimbType(value) {
  return hasText(value) && CLIMB_TYPES.indexOf(value) !== -1;
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
function isGradeForType(type, gradeValue) {
  if (!hasText(gradeValue)) return false;
  return gradesForType(type).indexOf(gradeValue) !== -1;
}

/**
 * 切换类型后该保留还是清空原等级：原等级仍适用于新类型时保留（顶绳 5.10a 切先锋），
 * 否则返回空串要求重选（抱石 V3 切顶绳、切回抱石时失效值清空）。
 */
function resolveGradeForType(type, gradeValue) {
  return isGradeForType(type, gradeValue) ? gradeValue : '';
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
function gradeText(gradeValue) {
  return hasText(gradeValue) ? gradeValue : GRADE_PLACEHOLDER;
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
 * 「已完攀」归属：同一本机档案 + 同一条长期线路 ID。
 * 两者任一不同都不算同一条已完攀线路，避免重建编号空间后复用编号互相上锁。
 * 线路类型只从线路档案取：把次记录里可省略、可伪造的 climbType 不参与判定。
 */
function isSameSendOwner(left, right) {
  if (!left || !right) return false;
  return (
    String(left.archiveId || '') === String(right.archiveId || '') &&
    String(left.routeId || '') === String(right.routeId || '')
  );
}

/**
 * 「改为未完成」的明确目标：这条线最近一把可识别的已确认完攀。
 *
 * 只读挑选，不改动任何记录：
 * - 只在同一线路内挑 result === 'send' 的有效把次，跨线路、跨场次不会串；
 * - 多条历史完攀时取序号最大的一把（最近可识别的那一把），改完一把才轮到前一把，
 *   因此旧汇总和多条历史完攀都能逐次更正，且读取不重写任何历史。
 */
function latestSendAttempt(attempts, routeId) {
  if (!Array.isArray(attempts) || !hasText(routeId)) return null;
  let best = null;
  let bestSeq = -1;
  attempts.forEach(item => {
    if (!item || item.routeId !== routeId || item.result !== 'send') return;
    if (isUndoneAttempt(item)) return;
    const seq = Number.isInteger(item.seq) ? item.seq : 0;
    // 序号相同时后加入的更晚，取 >= 让「最近」的含义与追加顺序一致。
    if (!best || seq >= bestSeq) {
      best = item;
      bestSeq = seq;
    }
  });
  return best;
}

/**
 * 撤回标记（T032）：把次记录里带非空 undoneAt 表示这一把已被撤回。
 * 撤回不物理删除原把、也不伪造相反结果——ID、序号、场次、线路、结果、备注与时间都保留，
 * 只有这一个标记说明它当前不属于有效集合；清掉标记（恢复）就回到原来那一把。
 *
 * 旧档案（T032 之前）没有这个字段：缺字段、空串或未定义一律按**有效**读取，
 * 只读判定，不迁移、不回写、不改原字节。
 */
function isUndoneAttempt(attempt) {
  return Boolean(attempt) && hasText(attempt.undoneAt);
}

/** 有效把次：已提交且未被撤回的那一把。 */
function isEffectiveAttempt(attempt) {
  return Boolean(attempt) && !isUndoneAttempt(attempt);
}

/**
 * 有效把次集合：所有读数端（把数、最近有效备注、完攀、统计、小结、清单与历史）
 * 共用这一份筛选，保证撤回后各页面给出一致的有效读数。
 * 不传数组时返回空数组，不抛错。
 */
function effectiveAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).filter(isEffectiveAttempt);
}

module.exports = {
  CLIMB_TYPES,
  BOULDER_CLIMB_TYPE,
  DEFAULT_CLIMB_TYPE,
  DEFAULT_GRADE,
  GRADE_PLACEHOLDER,
  BOULDER_GRADES,
  ROPE_GRADES,
  GRADES_BY_TYPE,
  isClimbType,
  gradesForType,
  isGradeForType,
  resolveGradeForType,
  climbTypeOf,
  gradeText,
  isBoulderClimbType,
  isBoulderRoute,
  allowsRepeatSend,
  isSameSendOwner,
  latestSendAttempt,
  isUndoneAttempt,
  isEffectiveAttempt,
  effectiveAttempts
};
