/**
 * 日期工具函数
 */

/**
 * 格式化日期为 YYYY-MM-DD 格式
 * @param {Date} date - 日期对象
 * @returns {String} 格式化后的日期字符串
 */
const formatDate = (date) => {
  if (!date) return '';
  if (typeof date === 'string') {
    date = new Date(date);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * 格式化日期为 YYYY年MM月DD日 格式
 * @param {Date|String} date - 日期对象或日期字符串
 * @returns {String} 格式化后的日期字符串
 */
const formatDateChinese = (date) => {
  if (!date) return '';
  if (typeof date === 'string') {
    date = new Date(date);
  }
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year}年${month}月${day}日`;
};

/**
 * 获取今天的日期字符串
 * @returns {String} YYYY-MM-DD 格式的今天日期
 */
const getToday = () => {
  return formatDate(new Date());
};

/**
 * 判断是否是本月
 * @param {Date|String} date - 日期对象或日期字符串
 * @returns {Boolean} 是否是本月
 */
const isThisMonth = (date) => {
  if (!date) return false;
  if (typeof date === 'string') {
    date = new Date(date);
  }
  const now = new Date();
  return date.getFullYear() === now.getFullYear() &&
         date.getMonth() === now.getMonth();
};

/**
 * 计算距离今天的天数
 * @param {Date|String} date - 日期对象或日期字符串
 * @returns {Number} 天数差
 */
const daysFromToday = (date) => {
  if (!date) return 0;
  if (typeof date === 'string') {
    date = new Date(date);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const diffTime = today.getTime() - date.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
};

/**
 * 获取相对时间描述
 * @param {Date|String} date - 日期对象或日期字符串
 * @returns {String} 相对时间描述
 */
const getRelativeTime = (date) => {
  const days = daysFromToday(date);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return formatDateChinese(date);
};

module.exports = {
  formatDate,
  formatDateChinese,
  getToday,
  isThisMonth,
  daysFromToday,
  getRelativeTime
};
