/**
 * 数据库操作工具
 * 封装云数据库的增删改查操作
 */

// 获取数据库实例
const db = wx.cloud.database();
// 获取集合引用
const recordsCollection = db.collection('climbing_records');

/**
 * 添加攀岩记录
 * @param {Object} record - 记录数据
 * @returns {Promise} 添加结果
 */
const addRecord = (record) => {
  return recordsCollection.add({
    data: {
      ...record,
      createTime: db.serverDate(), // 服务器时间
      updateTime: db.serverDate()
    }
  });
};

/**
 * 获取记录列表
 * @param {Number} page - 页码，从1开始
 * @param {Number} pageSize - 每页数量
 * @returns {Promise} 记录列表
 */
const getRecords = (page = 1, pageSize = 20) => {
  const skip = (page - 1) * pageSize;
  return recordsCollection
    .orderBy('date', 'desc')
    .skip(skip)
    .limit(pageSize)
    .get();
};

/**
 * 获取记录详情
 * @param {String} id - 记录ID
 * @returns {Promise} 记录详情
 */
const getRecordById = (id) => {
  return recordsCollection.doc(id).get();
};

/**
 * 删除记录
 * @param {String} id - 记录ID
 * @returns {Promise} 删除结果
 */
const deleteRecord = (id) => {
  return recordsCollection.doc(id).remove();
};

/**
 * 获取最近的记录
 * @param {Number} limit - 获取数量
 * @returns {Promise} 记录列表
 */
const getRecentRecords = (limit = 5) => {
  return recordsCollection
    .orderBy('date', 'desc')
    .limit(limit)
    .get();
};

/**
 * 获取所有记录（用于统计）
 * @returns {Promise} 所有记录
 */
const getAllRecords = () => {
  return recordsCollection
    .orderBy('date', 'desc')
    .get();
};

/**
 * 上传图片到云存储
 * @param {String} filePath - 本地文件路径
 * @returns {Promise} 上传结果，包含fileID
 */
const uploadImage = (filePath) => {
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const cloudPath = `climbing-images/${timestamp}-${randomStr}.jpg`;

  return wx.cloud.uploadFile({
    cloudPath: cloudPath,
    filePath: filePath
  });
};

/**
 * 删除云存储中的图片
 * @param {String|Array} fileIDs - 文件ID或文件ID数组
 * @returns {Promise} 删除结果
 */
const deleteImage = (fileIDs) => {
  const ids = Array.isArray(fileIDs) ? fileIDs : [fileIDs];
  return wx.cloud.deleteFile({
    fileList: ids
  });
};

module.exports = {
  addRecord,
  getRecords,
  getRecordById,
  deleteRecord,
  getRecentRecords,
  getAllRecords,
  uploadImage,
  deleteImage
};
