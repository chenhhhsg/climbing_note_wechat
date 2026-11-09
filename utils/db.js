/**
 * 数据库操作工具
 * 封装云数据库的增删改查操作
 *
 * T016：云客户端改为惰性获取。旧记录仍是云读取，但不再在模块顶层调用
 * `wx.cloud.database()`——没有 `wx.cloud`、云环境占位或初始化失败时，正式入口
 * 的其他模块照常加载，本机档案照常读写；只有真正发起旧云请求时才在这里拿到
 * 可判别的失败（错误码 `CLOUD_UNAVAILABLE`）。对外的调用契约与错误语义不变：
 * 每个方法都返回 Promise，失败以 reject 呈现，不改为同步抛出。
 */

const COLLECTION = 'climbing_records';
const CLOUD_UNAVAILABLE = 'CLOUD_UNAVAILABLE';

let cachedDb = null;
let cachedCollection = null;

/**
 * 可判别的「云不可用」错误：页面据此提示旧记录暂不可读，并保留本机记录入口。
 */
function cloudUnavailable(message) {
  const error = new Error(message || '云开发不可用，旧云记录暂不可读');
  error.code = CLOUD_UNAVAILABLE;
  return error;
}

/**
 * 惰性获取云数据库实例；没有 wx.cloud 或取不到实例时抛出可判别错误。
 */
function getDb() {
  if (!wx || !wx.cloud || typeof wx.cloud.database !== 'function') {
    throw cloudUnavailable('云开发不可用：当前环境没有 wx.cloud，旧云记录暂不可读');
  }
  if (!cachedDb) {
    cachedDb = wx.cloud.database();
  }
  if (!cachedDb) {
    throw cloudUnavailable('云开发不可用：wx.cloud.database() 未返回实例');
  }
  return cachedDb;
}

function getRecordsCollection() {
  if (!cachedCollection) {
    cachedCollection = getDb().collection(COLLECTION);
  }
  return cachedCollection;
}

/**
 * 把惰性取值放进 Promise：云不可用时同步抛出的错误也转成 reject，
 * 保持「调用即拿到 Promise、失败走 reject」的旧契约。
 */
function withCloud(task) {
  return Promise.resolve().then(task);
}

/**
 * 添加攀岩记录
 * @param {Object} record - 记录数据
 * @returns {Promise} 添加结果
 */
const addRecord = (record) => withCloud(() => {
  const db = getDb();
  return getRecordsCollection().add({
    data: {
      ...record,
      createTime: db.serverDate(), // 服务器时间
      updateTime: db.serverDate()
    }
  });
});

/**
 * 获取记录列表
 * @param {Number} page - 页码，从1开始
 * @param {Number} pageSize - 每页数量
 * @returns {Promise} 记录列表
 */
const getRecords = (page = 1, pageSize = 20) => withCloud(() => {
  const skip = (page - 1) * pageSize;
  return getRecordsCollection()
    .orderBy('date', 'desc')
    .skip(skip)
    .limit(pageSize)
    .get();
});

/**
 * 获取记录详情
 * @param {String} id - 记录ID
 * @returns {Promise} 记录详情
 */
const getRecordById = (id) => withCloud(() => getRecordsCollection().doc(id).get());

/**
 * 删除记录
 * @param {String} id - 记录ID
 * @returns {Promise} 删除结果
 */
const deleteRecord = (id) => withCloud(() => getRecordsCollection().doc(id).remove());

/**
 * 获取最近的记录
 * @param {Number} limit - 获取数量
 * @returns {Promise} 记录列表
 */
const getRecentRecords = (limit = 5) => withCloud(() => getRecordsCollection()
  .orderBy('date', 'desc')
  .limit(limit)
  .get());

/**
 * 获取所有记录（用于统计）
 * @returns {Promise} 所有记录
 */
const getAllRecords = () => withCloud(() => getRecordsCollection()
  .orderBy('date', 'desc')
  .get());

function requireCloud() {
  if (!wx || !wx.cloud) {
    throw cloudUnavailable('云开发不可用：当前环境没有 wx.cloud');
  }
  return wx.cloud;
}

/**
 * 上传图片到云存储
 * @param {String} filePath - 本地文件路径
 * @returns {Promise} 上传结果，包含fileID
 */
const uploadImage = (filePath) => withCloud(() => {
  const cloud = requireCloud();
  if (typeof cloud.uploadFile !== 'function') {
    throw cloudUnavailable('云开发不可用：当前环境不支持 uploadFile');
  }
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const cloudPath = `climbing-images/${timestamp}-${randomStr}.jpg`;

  return cloud.uploadFile({
    cloudPath: cloudPath,
    filePath: filePath
  });
});

/**
 * 删除云存储中的图片
 * @param {String|Array} fileIDs - 文件ID或文件ID数组
 * @returns {Promise} 删除结果
 */
const deleteImage = (fileIDs) => withCloud(() => {
  const cloud = requireCloud();
  if (typeof cloud.deleteFile !== 'function') {
    throw cloudUnavailable('云开发不可用：当前环境不支持 deleteFile');
  }
  const ids = Array.isArray(fileIDs) ? fileIDs : [fileIDs];
  return cloud.deleteFile({
    fileList: ids
  });
});

module.exports = {
  addRecord,
  getRecords,
  getRecordById,
  deleteRecord,
  getRecentRecords,
  getAllRecords,
  uploadImage,
  deleteImage,
  // 便于页面与测试识别「云不可用」这一类可判别失败。
  CLOUD_UNAVAILABLE,
  cloudUnavailable
};
