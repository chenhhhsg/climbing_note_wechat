/**
 * 攀岩难度等级工具
 * 支持 V-scale (抱石) 和 YDS (先锋攀) 难度系统
 * 提供统一的难度计算、比较、查询接口
 */

// ============================================
// 难度数据定义
// ============================================

// V-scale 难度等级（抱石）
const V_SCALE_GRADES = [
  { value: 'VB',  level: 0,  label: 'VB' },
  { value: 'V0',  level: 1,  label: 'V0' },
  { value: 'V0+', level: 2,  label: 'V0+' },
  { value: 'V1',  level: 3,  label: 'V1' },
  { value: 'V2',  level: 4,  label: 'V2' },
  { value: 'V3',  level: 5,  label: 'V3' },
  { value: 'V4',  level: 6,  label: 'V4' },
  { value: 'V5',  level: 7,  label: 'V5' },
  { value: 'V6',  level: 8,  label: 'V6' },
  { value: 'V7',  level: 9,  label: 'V7' },
  { value: 'V8',  level: 10, label: 'V8' },
  { value: 'V9',  level: 11, label: 'V9' },
  { value: 'V10', level: 12, label: 'V10' },
  { value: 'V11', level: 13, label: 'V11' },
  { value: 'V12', level: 14, label: 'V12' }
];

// YDS 难度等级（先锋攀/顶绳攀）
const YDS_GRADES = [
  { value: '5.6',   level: 0,  label: '5.6' },
  { value: '5.7',   level: 1,  label: '5.7' },
  { value: '5.8',   level: 2,  label: '5.8' },
  { value: '5.9',   level: 3,  label: '5.9' },
  { value: '5.10a', level: 4,  label: '5.10a' },
  { value: '5.10b', level: 5,  label: '5.10b' },
  { value: '5.10c', level: 6,  label: '5.10c' },
  { value: '5.10d', level: 7,  label: '5.10d' },
  { value: '5.11a', level: 8,  label: '5.11a' },
  { value: '5.11b', level: 9,  label: '5.11b' },
  { value: '5.11c', level: 10, label: '5.11c' },
  { value: '5.11d', level: 11, label: '5.11d' },
  { value: '5.12a', level: 12, label: '5.12a' },
  { value: '5.12b', level: 13, label: '5.12b' },
  { value: '5.12c', level: 14, label: '5.12c' },
  { value: '5.12d', level: 15, label: '5.12d' },
  { value: '5.13a', level: 16, label: '5.13a' },
  { value: '5.13b', level: 17, label: '5.13b' },
  { value: '5.13c', level: 18, label: '5.13c' },
  { value: '5.13d', level: 19, label: '5.13d' },
  { value: '5.14a', level: 20, label: '5.14a' }
];

// 法国难度等级（可选扩展）
const FRENCH_GRADES = [
  { value: '4a',  level: 0,  label: '4a' },
  { value: '4b',  level: 1,  label: '4b' },
  { value: '4c',  level: 2,  label: '4c' },
  { value: '5a',  level: 3,  label: '5a' },
  { value: '5b',  level: 4,  label: '5b' },
  { value: '5c',  level: 5,  label: '5c' },
  { value: '6a',  level: 6,  label: '6a' },
  { value: '6a+', level: 7,  label: '6a+' },
  { value: '6b',  level: 8,  label: '6b' },
  { value: '6b+', level: 9,  label: '6b+' },
  { value: '6c',  level: 10, label: '6c' },
  { value: '6c+', level: 11, label: '6c+' },
  { value: '7a',  level: 12, label: '7a' },
  { value: '7a+', level: 13, label: '7a+' },
  { value: '7b',  level: 14, label: '7b' },
  { value: '7b+', level: 15, label: '7b+' },
  { value: '7c',  level: 16, label: '7c' },
  { value: '7c+', level: 17, label: '7c+' },
  { value: '8a',  level: 18, label: '8a' }
];

// 难度系统映射表
const GRADE_SYSTEMS = {
  vScale: V_SCALE_GRADES,
  yds: YDS_GRADES,
  french: FRENCH_GRADES
};

// 攀岩类型对应的默认难度系统
const CLIMB_TYPE_GRADE_MAP = {
  boulder: 'vScale',
  lead: 'yds',
  speed: 'yds',
  outdoor: 'yds'
};

// 难度等级颜色（用于 UI 展示）
const GRADE_COLORS = [
  { minLevel: 0,  maxLevel: 3,  color: '#4CAF50', label: '入门' },
  { minLevel: 4,  maxLevel: 7,  color: '#2196F3', label: '进阶' },
  { minLevel: 8,  maxLevel: 11, color: '#FF9800', label: '中级' },
  { minLevel: 12, maxLevel: 15, color: '#F44336', label: '高级' },
  { minLevel: 16, maxLevel: 99, color: '#9C27B0', label: '专家' }
];

// ============================================
// 核心方法
// ============================================

/**
 * 根据攀岩类型获取难度选项列表
 * @param {string} type - 攀岩类型 (boulder/lead/speed/outdoor)
 * @returns {Array} 难度选项数组 [{value, label, level}]
 */
const getGradeOptions = (type) => {
  const systemKey = CLIMB_TYPE_GRADE_MAP[type] || 'yds';
  return GRADE_SYSTEMS[systemKey] || [];
};

/**
 * 根据攀岩类型获取难度系统名称
 * @param {string} type - 攀岩类型
 * @returns {string} 难度系统名称 (vScale/yds/french)
 */
const getGradeSystem = (type) => {
  return CLIMB_TYPE_GRADE_MAP[type] || 'yds';
};

/**
 * 获取难度等级数值
 * 用于数据库存储和统计比较
 * @param {string} grade - 难度值 (如 'V5', '5.11a')
 * @param {string} gradeSystem - 难度系统 (vScale/yds/french)
 * @returns {number} 难度数值，未找到返回 -1
 */
const getGradeLevel = (grade, gradeSystem) => {
  if (!grade) return -1;

  // 如果指定了系统，直接查
  if (gradeSystem && GRADE_SYSTEMS[gradeSystem]) {
    const found = GRADE_SYSTEMS[gradeSystem].find(g => g.value === grade);
    return found ? found.level : -1;
  }

  // 否则遍历所有系统查找
  for (const system of Object.values(GRADE_SYSTEMS)) {
    const found = system.find(g => g.value === grade);
    if (found) return found.level;
  }

  return -1;
};

/**
 * 比较两个难度等级
 * @param {string} gradeA - 难度 A
 * @param {string} gradeB - 难度 B
 * @param {string} gradeSystem - 难度系统
 * @returns {number} 正数 A 更高，负数 B 更高，0 相同
 */
const compareGrade = (gradeA, gradeB, gradeSystem) => {
  const levelA = getGradeLevel(gradeA, gradeSystem);
  const levelB = getGradeLevel(gradeB, gradeSystem);
  return levelA - levelB;
};

/**
 * 获取最高难度
 * @param {Array<string>} grades - 难度数组
 * @param {string} gradeSystem - 难度系统
 * @returns {string|null} 最高难度值
 */
const getMaxGrade = (grades, gradeSystem) => {
  if (!grades || grades.length === 0) return null;

  let maxGrade = grades[0];
  let maxLevel = getGradeLevel(grades[0], gradeSystem);

  for (let i = 1; i < grades.length; i++) {
    const level = getGradeLevel(grades[i], gradeSystem);
    if (level > maxLevel) {
      maxLevel = level;
      maxGrade = grades[i];
    }
  }

  return maxGrade;
};

/**
 * 获取难度对应的显示颜色
 * @param {string} grade - 难度值
 * @param {string} gradeSystem - 难度系统
 * @returns {string} 颜色值
 */
const getGradeColor = (grade, gradeSystem) => {
  const level = getGradeLevel(grade, gradeSystem);
  if (level < 0) return '#999999';

  const found = GRADE_COLORS.find(c => level >= c.minLevel && level <= c.maxLevel);
  return found ? found.color : '#999999';
};

/**
 * 获取难度等级标签
 * @param {string} grade - 难度值
 * @param {string} gradeSystem - 难度系统
 * @returns {string} 等级标签（入门/进阶/中级/高级/专家）
 */
const getGradeLabel = (grade, gradeSystem) => {
  const level = getGradeLevel(grade, gradeSystem);
  if (level < 0) return '未知';

  const found = GRADE_COLORS.find(c => level >= c.minLevel && level <= c.maxLevel);
  return found ? found.label : '未知';
};

// ============================================
// 兼容旧接口（供现有页面调用）
// ============================================

/**
 * 兼容旧接口：根据攀岩类型获取难度列表
 * @param {string} climbType - 旧版攀岩类型（中文）
 * @returns {Array} 难度列表
 */
const getGradesByType = (climbType) => {
  // 中文类型映射到英文
  const typeMap = {
    '抱石': 'boulder',
    '先锋攀': 'lead',
    '顶绳攀': 'lead',
    '室内': 'boulder',
    '室外': 'outdoor'
  };
  const type = typeMap[climbType] || 'boulder';
  return getGradeOptions(type);
};

/**
 * 兼容旧接口：获取所有难度等级
 * @returns {Array} 所有难度等级
 */
const getAllGrades = () => {
  return [...V_SCALE_GRADES, ...YDS_GRADES];
};

// ============================================
// 导出
// ============================================

module.exports = {
  // 常量
  V_SCALE_GRADES,
  YDS_GRADES,
  FRENCH_GRADES,
  GRADE_SYSTEMS,
  CLIMB_TYPE_GRADE_MAP,
  GRADE_COLORS,

  // 核心方法
  getGradeOptions,
  getGradeSystem,
  getGradeLevel,
  compareGrade,
  getMaxGrade,
  getGradeColor,
  getGradeLabel,

  // 兼容旧接口
  getGradesByType,
  getAllGrades
};
