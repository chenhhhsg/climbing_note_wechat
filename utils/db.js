/**
 * 攀岩记录数据库操作模块
 *
 * 数据集合: climbing_records
 * 返回格式: { success: boolean, data?: any, error?: string }
 */

const { getGradeLevel, getGradeSystem } = require('./grade');
const { isThisMonth, getToday } = require('./date');

// ============================================
// 数据库初始化
// ============================================

const db = wx.cloud.database();
const _ = db.command;
const $ = db.command.aggregate;
const recordsCol = db.collection('climbing_records');

// ============================================
// 内部工具方法
// ============================================

/**
 * 统一返回成功结果
 */
const success = (data) => ({ success: true, data });

/**
 * 统一返回失败结果
 */
const fail = (error) => {
  console.error('[DB Error]', error);
  return { success: false, error: error.message || error };
};

/**
 * 生成时间戳
 */
const timestamp = () => Date.now();

/**
 * 根据 status 自动推导 isProject 和 projectStatus
 */
const deriveProjectFields = (status) => {
  if (status === 'project') {
    return { isProject: true, projectStatus: 'active' };
  }
  return { isProject: false, projectStatus: '' };
};

/**
 * 根据 grade 和 climbType 计算 gradeLevel 和 gradeSystem
 */
const deriveGradeFields = (grade, climbType) => {
  if (!grade) return { gradeLevel: -1, gradeSystem: '' };
  const system = getGradeSystem(climbType);
  const level = getGradeLevel(grade, system);
  return { gradeLevel: level, gradeSystem: system };
};

// ============================================
// 数据库接口
// ============================================

/**
 * 创建攀岩记录
 *
 * @param {Object} record - 记录数据
 * @param {string} record.date - 日期 YYYY-MM-DD
 * @param {string} record.location - 地点
 * @param {string} record.climbType - 攀岩类型 (boulder/lead/speed/outdoor)
 * @param {string} record.grade - 难度 (如 V5, 5.11a)
 * @param {string} record.status - 状态 (flash/completed/failed/project)
 * @param {number} record.attempts - 尝试次数
 * @param {string} [record.routeColor] - 线路颜色
 * @param {string} [record.routeName] - 线路名称
 * @param {string} [record.area] - 区域
 * @param {string} [record.notes] - 备注
 * @param {string[]} [record.images] - 图片 fileID 数组
 * @param {string} [record.projectStatus] - project 状态 (active/completed/abandoned)
 * @param {string} [record.completedDate] - 完成日期
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
const createRecord = async (record) => {
  try {
    const now = timestamp();
    const dateStr = record.date || getToday();

    // 自动计算字段
    const gradeFields = deriveGradeFields(record.grade, record.climbType);
    const projectFields = deriveProjectFields(record.status);

    const doc = {
      // 用户数据
      date: dateStr,
      timestamp: new Date(dateStr).getTime(),
      location: record.location || '',
      climbType: record.climbType || 'boulder',

      gradeSystem: gradeFields.gradeSystem,
      grade: record.grade || '',
      gradeLevel: gradeFields.gradeLevel,

      status: record.status || 'completed',
      attempts: parseInt(record.attempts) || 1,

      routeColor: record.routeColor || '',
      routeName: record.routeName || '',
      area: record.area || '',

      notes: record.notes || '',
      images: record.images || [],

      isProject: projectFields.isProject,
      projectStatus: projectFields.projectStatus || '',
      completedDate: record.completedDate || '',

      // 系统字段
      createdAt: now,
      updatedAt: now
    };

    const res = await recordsCol.add({ data: doc });
    return success(res._id);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 更新攀岩记录
 *
 * @param {string} id - 记录 _id
 * @param {Object} data - 要更新的字段
 * @returns {Promise<{success: boolean, data?: number, error?: string}>}
 */
const updateRecord = async (id, data) => {
  try {
    const updateData = { ...data, updatedAt: timestamp() };

    // 如果修改了 grade，重新计算 gradeLevel
    if (data.grade !== undefined) {
      const climbType = data.climbType; // 可能同时更新
      let gradeSystem = '';

      // 如果没有传 climbType，需要查原记录
      if (!climbType) {
        const original = await recordsCol.doc(id).get();
        gradeSystem = getGradeSystem(original.data.climbType);
      } else {
        gradeSystem = getGradeSystem(climbType);
      }

      updateData.gradeSystem = gradeSystem;
      updateData.gradeLevel = getGradeLevel(data.grade, gradeSystem);
    }

    // 如果修改了 status，同步更新 isProject 和 projectStatus
    if (data.status !== undefined) {
      const projectFields = deriveProjectFields(data.status);
      updateData.isProject = projectFields.isProject;

      if (projectFields.isProject) {
        updateData.projectStatus = data.projectStatus || 'active';
      } else {
        updateData.projectStatus = '';
      }
    }

    // 如果修改了 date，更新 timestamp
    if (data.date !== undefined) {
      updateData.timestamp = new Date(data.date).getTime();
    }

    const res = await recordsCol.doc(id).update({ data: updateData });
    return success(res.stats.updated);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 删除攀岩记录
 *
 * @param {string} id - 记录 _id
 * @returns {Promise<{success: boolean, data?: number, error?: string}>}
 */
const deleteRecord = async (id) => {
  try {
    const res = await recordsCol.doc(id).remove();
    return success(res.stats.removed);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 根据 _id 获取记录详情
 *
 * @param {string} id - 记录 _id
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
const getRecordById = async (id) => {
  try {
    const res = await recordsCol.doc(id).get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 获取记录列表（支持筛选、搜索、分页）
 *
 * @param {Object} [options] - 查询选项
 * @param {number} [options.page=1] - 页码
 * @param {number} [options.pageSize=20] - 每页数量
 * @param {Object} [options.filters] - 筛选条件
 * @param {string} [options.filters.climbType] - 攀岩类型
 * @param {string} [options.filters.status] - 状态
 * @param {string} [options.filters.grade] - 难度
 * @param {string} [options.filters.location] - 地点
 * @param {string} [options.keyword] - 搜索关键词（匹配地点、备注、线路名称）
 * @returns {Promise<{success: boolean, data?: {list: Array, total: number, page: number, pageSize: number}, error?: string}>}
 */
const getRecords = async (options = {}) => {
  try {
    const { page = 1, pageSize = 20, filters = {}, keyword } = options;
    const skip = (page - 1) * pageSize;

    // 构建查询条件
    const conditions = [];

    if (filters.climbType) {
      conditions.push({ climbType: filters.climbType });
    }
    if (filters.status) {
      conditions.push({ status: filters.status });
    }
    if (filters.grade) {
      conditions.push({ grade: filters.grade });
    }
    if (filters.location) {
      conditions.push({ location: filters.location });
    }

    // 关键词搜索（匹配地点、备注、线路名称）
    if (keyword) {
      const regex = db.RegExp({
        regexp: keyword,
        options: 'i'
      });
      conditions.push(_.or([
        { location: regex },
        { notes: regex },
        { routeName: regex }
      ]));
    }

    // 组合查询条件
    const where = conditions.length > 0 ? _.and(conditions) : {};

    // 并行查询数据和总数
    const [listRes, countRes] = await Promise.all([
      recordsCol
        .where(where)
        .orderBy('timestamp', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get(),
      recordsCol
        .where(where)
        .count()
    ]);

    return success({
      list: listRes.data,
      total: countRes.total,
      page,
      pageSize
    });
  } catch (err) {
    return fail(err);
  }
};

/**
 * 获取最近记录
 *
 * @param {number} [limit=5] - 获取数量
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
const getRecentRecords = async (limit = 5) => {
  try {
    const res = await recordsCol
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 获取统计数据
 *
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
const getStats = async () => {
  try {
    // 获取所有记录（云数据库单次最多 20 条，需要循环获取）
    let allRecords = [];
    let hasMore = true;
    let skip = 0;
    const batchsize = 100;

    while (hasMore) {
      const res = await recordsCol
        .orderBy('timestamp', 'desc')
        .skip(skip)
        .limit(batchsize)
        .get();

      allRecords = allRecords.concat(res.data);
      hasMore = res.data.length === batchsize;
      skip += batchsize;
    }

    const total = allRecords.length;

    // 本月次数
    const monthClimbs = allRecords.filter(r => isThisMonth(r.date)).length;

    // 最高难度（使用 gradeLevel 比较）
    let maxGrade = '';
    let maxGradeLevel = -1;
    allRecords.forEach(r => {
      if (r.gradeLevel > maxGradeLevel) {
        maxGradeLevel = r.gradeLevel;
        maxGrade = r.grade;
      }
    });

    // 完成率（flash + completed 视为完成）
    const completedCount = allRecords.filter(r =>
      r.status === 'flash' || r.status === 'completed'
    ).length;
    const completionRate = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    // Flash 次数
    const flashCount = allRecords.filter(r => r.status === 'flash').length;

    // Project 统计
    const projectRecords = allRecords.filter(r => r.isProject);
    const projectCount = projectRecords.length;
    const projectActive = projectRecords.filter(r => r.projectStatus === 'active').length;
    const projectCompleted = projectRecords.filter(r => r.projectStatus === 'completed').length;
    const projectAbandoned = projectRecords.filter(r => r.projectStatus === 'abandoned').length;

    // 常去地点 Top5
    const locationMap = {};
    allRecords.forEach(r => {
      if (r.location) {
        locationMap[r.location] = (locationMap[r.location] || 0) + 1;
      }
    });
    const topLocations = Object.entries(locationMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // 攀岩类型分布
    const typeMap = {};
    allRecords.forEach(r => {
      if (r.climbType) {
        typeMap[r.climbType] = (typeMap[r.climbType] || 0) + 1;
      }
    });
    const typeDistribution = Object.entries(typeMap)
      .map(([type, count]) => ({
        type,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);

    // 月度趋势（近 6 个月）
    const now = new Date();
    const monthTrend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const count = allRecords.filter(r => r.date && r.date.startsWith(yearMonth)).length;
      monthTrend.push({ month: yearMonth, count });
    }

    return success({
      total,
      monthClimbs,
      maxGrade,
      maxGradeLevel,
      completedCount,
      completionRate,
      flashCount,
      projectCount,
      projectActive,
      projectCompleted,
      projectAbandoned,
      topLocations,
      typeDistribution,
      monthTrend
    });
  } catch (err) {
    return fail(err);
  }
};

// ============================================
// 图片操作
// ============================================

/**
 * 压缩图片
 *
 * @param {string} filePath - 本地临时文件路径
 * @returns {Promise<{success: boolean, data?: string, error?: string}>} 返回压缩后的路径
 */
const compressImage = async (filePath) => {
  try {
    const res = await wx.compressImage({
      src: filePath,
      quality: 80
    });
    return success(res.tempFilePath);
  } catch (err) {
    // 压缩失败则返回原路径
    console.warn('[Image] 压缩失败，使用原图:', err);
    return success(filePath);
  }
};

/**
 * 上传单张图片到云存储（先压缩再上传）
 *
 * @param {string} filePath - 本地临时文件路径
 * @returns {Promise<{success: boolean, data?: string, error?: string}>} 返回 fileID
 */
const uploadImage = async (filePath) => {
  try {
    // 1. 压缩图片
    const compressRes = await compressImage(filePath);
    const finalPath = compressRes.data;

    // 2. 生成云路径：climbing-images/YYYY-MM-DD/timestamp-random.ext
    const ext = finalPath.split('.').pop() || 'jpg';
    const today = getToday();
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const cloudPath = `climbing-images/${today}/${ts}-${rand}.${ext}`;

    // 3. 上传
    const res = await wx.cloud.uploadFile({
      cloudPath,
      filePath: finalPath
    });

    return success(res.fileID);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 批量上传图片（顺序上传，便于错误定位）
 *
 * @param {string[]} filePaths - 本地临时文件路径数组
 * @returns {Promise<{success: boolean, data?: string[], error?: string}>} 返回 fileID 数组
 */
const uploadImages = async (filePaths) => {
  try {
    const fileIDs = [];
    for (let i = 0; i < filePaths.length; i++) {
      const res = await uploadImage(filePaths[i]);
      if (!res.success) {
        return fail(new Error(`第${i + 1}张图片上传失败: ${res.error}`));
      }
      fileIDs.push(res.data);
    }
    return success(fileIDs);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 删除云存储中的图片
 *
 * @param {string|string[]} fileIDs - 文件 ID 或数组
 * @returns {Promise<{success: boolean, data?: void, error?: string}>}
 */
const deleteImage = async (fileIDs) => {
  try {
    const ids = Array.isArray(fileIDs) ? fileIDs : [fileIDs];
    if (ids.length === 0) return success();

    await wx.cloud.deleteFile({ fileList: ids });
    return success();
  } catch (err) {
    return fail(err);
  }
};

// ============================================
// 兼容旧接口
// ============================================

/**
 * 兼容旧接口：添加记录
 * @deprecated 请使用 createRecord
 */
const addRecord = async (record) => {
  return createRecord(record);
};

/**
 * 兼容旧接口：获取所有记录
 * @deprecated 请使用 getRecords({ pageSize: 1000 })
 */
const getAllRecords = async () => {
  try {
    const res = await getRecords({ pageSize: 1000 });
    if (res.success) {
      return { data: res.data.list };
    }
    throw new Error(res.error);
  } catch (err) {
    throw err;
  }
};

// ============================================
// 导出
// ============================================

module.exports = {
  // 核心接口
  createRecord,
  updateRecord,
  deleteRecord,
  getRecordById,
  getRecords,
  getRecentRecords,
  getStats,

  // 图片操作
  uploadImage,
  uploadImages,
  deleteImage,

  // 兼容旧接口
  addRecord,
  getAllRecords
};
