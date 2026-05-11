/**
 * 攀岩难度等级工具
 * 包含 V-scale (抱石) 和 YDS (先锋攀) 难度系统
 */

// V-scale 难度等级（抱石）
const vScaleGrades = [
  { value: 'VB', label: 'VB', level: 0 },
  { value: 'V0', label: 'V0', level: 1 },
  { value: 'V1', label: 'V1', level: 2 },
  { value: 'V2', label: 'V2', level: 3 },
  { value: 'V3', label: 'V3', level: 4 },
  { value: 'V4', label: 'V4', level: 5 },
  { value: 'V5', label: 'V5', level: 6 },
  { value: 'V6', label: 'V6', level: 7 },
  { value: 'V7', label: 'V7', level: 8 },
  { value: 'V8', label: 'V8', level: 9 },
  { value: 'V9', label: 'V9', level: 10 },
  { value: 'V10', label: 'V10', level: 11 },
  { value: 'V11', label: 'V11', level: 12 },
  { value: 'V12', label: 'V12', level: 13 },
  { value: 'V13', label: 'V13', level: 14 },
  { value: 'V14', label: 'V14', level: 15 },
  { value: 'V15', label: 'V15', level: 16 },
  { value: 'V16', label: 'V16', level: 17 }
];

// YDS 难度等级（先锋攀/顶绳攀）
const ydsGrades = [
  { value: '5.6', label: '5.6', level: 0 },
  { value: '5.7', label: '5.7', level: 1 },
  { value: '5.8', label: '5.8', level: 2 },
  { value: '5.9', label: '5.9', level: 3 },
  { value: '5.10a', label: '5.10a', level: 4 },
  { value: '5.10b', label: '5.10b', level: 5 },
  { value: '5.10c', label: '5.10c', level: 6 },
  { value: '5.10d', label: '5.10d', level: 7 },
  { value: '5.11a', label: '5.11a', level: 8 },
  { value: '5.11b', label: '5.11b', level: 9 },
  { value: '5.11c', label: '5.11c', level: 10 },
  { value: '5.11d', label: '5.11d', level: 11 },
  { value: '5.12a', label: '5.12a', level: 12 },
  { value: '5.12b', label: '5.12b', level: 13 },
  { value: '5.12c', label: '5.12c', level: 14 },
  { value: '5.12d', label: '5.12d', level: 15 },
  { value: '5.13a', label: '5.13a', level: 16 },
  { value: '5.13b', label: '5.13b', level: 17 },
  { value: '5.13c', label: '5.13c', level: 18 },
  { value: '5.13d', label: '5.13d', level: 19 },
  { value: '5.14a', label: '5.14a', level: 20 },
  { value: '5.14b', label: '5.14b', level: 21 },
  { value: '5.14c', label: '5.14c', level: 22 },
  { value: '5.14d', label: '5.14d', level: 23 },
  { value: '5.15a', label: '5.15a', level: 24 }
];

/**
 * 根据攀岩类型获取难度等级列表
 * @param {String} climbType - 攀岩类型（抱石/先锋攀/顶绳攀）
 * @returns {Array} 难度等级列表
 */
const getGradesByType = (climbType) => {
  if (climbType === '抱石') {
    return vScaleGrades;
  }
  return ydsGrades;
};

/**
 * 获取所有难度等级（用于筛选）
 * @returns {Array} 所有难度等级
 */
const getAllGrades = () => {
  return [...vScaleGrades, ...ydsGrades];
};

/**
 * 比较两个难度等级的高低
 * @param {String} grade1 - 难度1
 * @param {String} grade2 - 难度2
 * @returns {Number} 正数表示grade1更高，负数表示grade2更高，0表示相同
 */
const compareGrades = (grade1, grade2) => {
  const allGrades = getAllGrades();
  const g1 = allGrades.find(g => g.value === grade1);
  const g2 = allGrades.find(g => g.value === grade2);
  if (!g1 || !g2) return 0;
  return g1.level - g2.level;
};

/**
 * 获取最高难度
 * @param {Array} grades - 难度数组
 * @returns {String} 最高难度
 */
const getMaxGrade = (grades) => {
  if (!grades || grades.length === 0) return '-';
  const allGrades = getAllGrades();
  let maxGrade = grades[0];
  let maxLevel = 0;

  grades.forEach(grade => {
    const found = allGrades.find(g => g.value === grade);
    if (found && found.level > maxLevel) {
      maxLevel = found.level;
      maxGrade = grade;
    }
  });

  return maxGrade;
};

/**
 * 获取难度等级的颜色
 * @param {String} grade - 难度等级
 * @returns {String} 颜色值
 */
const getGradeColor = (grade) => {
  const allGrades = getAllGrades();
  const found = allGrades.find(g => g.value === grade);
  if (!found) return '#999999';

  const level = found.level;
  if (level <= 3) return '#4caf50';    // 绿色：简单
  if (level <= 7) return '#2196f3';    // 蓝色：中等
  if (level <= 12) return '#ff9800';   // 橙色：困难
  if (level <= 18) return '#f44336';   // 红色：很难
  return '#9c27b0';                     // 紫色：极难
};

module.exports = {
  vScaleGrades,
  ydsGrades,
  getGradesByType,
  getAllGrades,
  compareGrades,
  getMaxGrade,
  getGradeColor
};
