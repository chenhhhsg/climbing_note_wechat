/**
 * 攀岩记录数据库操作模块
 *
 * 数据集合:
 *   climbing_sessions - 新版 Session（一次进馆 = 一条记录，含多条线路）
 *   climbing_records  - 旧版记录（保留兼容）
 *
 * 返回格式: { success: boolean, data?: any, error?: string }
 */

const { getGradeLevel, getGradeSystem } = require('./grade');
const { isThisMonth, getToday } = require('./date');

// ============================================
// 数据库初始化
// ============================================

const db = wx.cloud.database();
const _ = db.command;
const sessionsCol = db.collection('climbing_sessions');
const recordsCol = db.collection('climbing_records');

// ============================================
// 内部工具方法
// ============================================

const success = (data) => ({ success: true, data });

const fail = (error) => {
  console.error('[DB Error]', error);
  return { success: false, error: error.message || error };
};

const timestamp = () => Date.now();

/**
 * 生成唯一 route ID
 */
const generateRouteId = () => {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

/**
 * 为 route 中每条线路补充 gradeLevel
 */
const enrichRoute = (route) => {
  const system = getGradeSystem(route.climbType);
  const gradeLevel = getGradeLevel(route.grade, system);
  return {
    id: route.id || generateRouteId(),
    climbType: route.climbType || 'boulder',
    grade: route.grade || '',
    gradeLevel,
    status: route.status || 'completed',
    attempts: parseInt(route.attempts) || 1,
    routeColor: route.routeColor || '',
    routeName: route.routeName || '',
    area: route.area || '',
    notes: route.notes || '',
    images: route.images || []
  };
};

/**
 * 根据 routes 数组计算 Session 级别的统计字段
 */
const calcSessionStats = (routes) => {
  const routeCount = routes.length;
  const completedCount = routes.filter(r => r.status === 'flash' || r.status === 'completed').length;
  const flashCount = routes.filter(r => r.status === 'flash').length;
  const projectCount = routes.filter(r => r.status === 'project').length;
  const completionRate = routeCount > 0 ? Math.round((completedCount / routeCount) * 100) : 0;

  let maxGrade = '';
  let maxGradeLevel = -1;
  routes.forEach(r => {
    if (r.gradeLevel > maxGradeLevel) {
      maxGradeLevel = r.gradeLevel;
      maxGrade = r.grade;
    }
  });

  return { routeCount, completedCount, flashCount, projectCount, completionRate, maxGrade, maxGradeLevel };
};

// ============================================
// 云函数调用（好友相关）
// ============================================

/**
 * 调用 friendApi 云函数
 *
 * @param {string} action - 操作名
 * @param {Object} [data] - 参数
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
const callCloud = async (action, data = {}) => {
  try {
    const res = await wx.cloud.callFunction({
      name: 'friendApi',
      data: { action, ...data }
    });
    return res.result;
  } catch (err) {
    console.error('[Cloud Error]', err);
    return { success: false, error: err.message || '云函数调用失败' };
  }
};

// ============================================
// climbing_sessions 接口（新版）
// ============================================

/**
 * 创建攀岩 Session
 *
 * @param {Object} session
 * @param {string} session.date - 日期 YYYY-MM-DD
 * @param {string} session.location - 岩馆
 * @param {number} [session.duration] - 时长（分钟）
 * @param {string} [session.notes] - 备注
 * @param {Array}  session.routes - 线路列表
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
const createSession = async (session) => {
  try {
    const now = timestamp();
    const dateStr = session.date || getToday();

    // 处理每条线路
    const routes = (session.routes || []).map(enrichRoute);
    const stats = calcSessionStats(routes);

    const doc = {
      date: dateStr,
      timestamp: new Date(dateStr).getTime(),
      location: session.location || '',
      duration: parseInt(session.duration) || 0,
      notes: session.notes || '',
      visibility: session.visibility || 'private',

      routes,
      ...stats,

      createdAt: now,
      updatedAt: now
    };

    const res = await sessionsCol.add({ data: doc });
    return success(res._id);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 更新攀岩 Session
 *
 * @param {string} id - Session _id
 * @param {Object} data - 要更新的字段
 * @returns {Promise<{success: boolean, data?: number, error?: string}>}
 */
const updateSession = async (id, data) => {
  try {
    const updateData = { ...data, updatedAt: timestamp() };

    // 如果传了 routes，重新处理并计算统计
    if (data.routes !== undefined) {
      const routes = data.routes.map(enrichRoute);
      const stats = calcSessionStats(routes);
      updateData.routes = routes;
      Object.assign(updateData, stats);
    }

    // 如果修改了 date，更新 timestamp
    if (data.date !== undefined) {
      updateData.timestamp = new Date(data.date).getTime();
    }

    const res = await sessionsCol.doc(id).update({ data: updateData });
    return success(res.stats.updated);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 删除攀岩 Session（同时删除关联的云存储图片）
 *
 * @param {string} id - Session _id
 * @returns {Promise<{success: boolean, data?: number, error?: string}>}
 */
const deleteSession = async (id) => {
  try {
    // 1. 读取记录，收集所有图片 fileID
    const sessionRes = await getSessionById(id);
    if (!sessionRes.success) return sessionRes;

    const allImages = [];
    (sessionRes.data.routes || []).forEach(route => {
      (route.images || []).forEach(img => allImages.push(img));
    });

    // 2. 删除云存储图片
    if (allImages.length > 0) {
      await deleteImage(allImages);
    }

    // 3. 删除数据库文档
    const res = await sessionsCol.doc(id).remove();
    return success(res.stats.removed);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 根据 id 获取 Session 详情
 *
 * @param {string} id - Session _id
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
const getSessionById = async (id) => {
  try {
    const res = await sessionsCol.doc(id).get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 获取 Session 列表（支持筛选、搜索、分页）
 *
 * @param {Object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=20]
 * @param {string} [options.keyword] - 搜索 location / notes / routes.* 字段
 * @param {Object} [options.filters]
 * @param {string} [options.filters.location]
 * @param {string} [options.filters.date]
 * @param {string} [options.filters.climbType] - 匹配 routes 中的 climbType
 * @param {string} [options.filters.status] - 匹配 routes 中的 status
 * @param {string} [options.filters.grade] - 匹配 routes 中的 grade
 * @returns {Promise<{success: boolean, data?: {list: Array, total: number, page: number, pageSize: number}, error?: string}>}
 */
const getSessions = async (options = {}) => {
  try {
    const { page = 1, pageSize = 20, filters = {}, keyword } = options;
    const skip = (page - 1) * pageSize;
    const conditions = [];

    // Session 级别筛选
    if (filters.location) {
      conditions.push({ location: filters.location });
    }
    if (filters.date) {
      conditions.push({ date: filters.date });
    }

    // routes 内字段筛选（使用 elemMatch）
    if (filters.climbType) {
      conditions.push({
        routes: _.elemMatch({ climbType: filters.climbType })
      });
    }
    if (filters.status) {
      conditions.push({
        routes: _.elemMatch({ status: filters.status })
      });
    }
    if (filters.grade) {
      conditions.push({
        routes: _.elemMatch({ grade: filters.grade })
      });
    }

    // 关键词搜索
    if (keyword) {
      const regex = db.RegExp({ regexp: keyword, options: 'i' });
      conditions.push(_.or([
        { location: regex },
        { notes: regex },
        { 'routes.routeName': regex },
        { 'routes.area': regex },
        { 'routes.notes': regex }
      ]));
    }

    const where = conditions.length > 0 ? _.and(conditions) : {};

    const [listRes, countRes] = await Promise.all([
      sessionsCol
        .where(where)
        .orderBy('timestamp', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get(),
      sessionsCol
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
 * 获取最近 Session
 *
 * @param {number} [limit=5]
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
const getRecentSessions = async (limit = 5) => {
  try {
    const res = await sessionsCol
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

/**
 * 获取 Session 统计数据
 * 从所有 sessions.routes 中聚合统计
 *
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
const getSessionStats = async () => {
  try {
    // 分批获取所有 Session
    let allSessions = [];
    let hasMore = true;
    let skip = 0;
    const batchSize = 100;

    while (hasMore) {
      const res = await sessionsCol
        .orderBy('timestamp', 'desc')
        .skip(skip)
        .limit(batchSize)
        .get();
      allSessions = allSessions.concat(res.data);
      hasMore = res.data.length === batchSize;
      skip += batchSize;
    }

    // 展开所有 routes
    const allRoutes = [];
    allSessions.forEach(s => {
      (s.routes || []).forEach(r => allRoutes.push(r));
    });

    const totalSessions = allSessions.length;
    const totalRoutes = allRoutes.length;

    // 本月进馆 / 线路
    const monthSessions = allSessions.filter(s => isThisMonth(s.date)).length;
    const monthRoutes = allSessions
      .filter(s => isThisMonth(s.date))
      .reduce((sum, s) => sum + (s.routes || []).length, 0);

    // 最高难度
    let maxGrade = '';
    let maxGradeLevel = -1;
    allRoutes.forEach(r => {
      if (r.gradeLevel > maxGradeLevel) {
        maxGradeLevel = r.gradeLevel;
        maxGrade = r.grade;
      }
    });

    // 完成率
    const completedRoutes = allRoutes.filter(r =>
      r.status === 'flash' || r.status === 'completed'
    ).length;
    const completionRate = totalRoutes > 0 ? Math.round((completedRoutes / totalRoutes) * 100) : 0;

    // 状态统计
    const flashCount = allRoutes.filter(r => r.status === 'flash').length;
    const completedCount = allRoutes.filter(r => r.status === 'completed').length;
    const failedCount = allRoutes.filter(r => r.status === 'failed').length;
    const projectCount = allRoutes.filter(r => r.status === 'project').length;

    // 常去岩馆 Top5
    const locationMap = {};
    allSessions.forEach(s => {
      if (s.location) locationMap[s.location] = (locationMap[s.location] || 0) + 1;
    });
    const topLocations = Object.entries(locationMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // 攀岩类型分布
    const typeMap = {};
    allRoutes.forEach(r => {
      if (r.climbType) typeMap[r.climbType] = (typeMap[r.climbType] || 0) + 1;
    });
    const typeDistribution = Object.entries(typeMap)
      .map(([type, count]) => ({
        type,
        count,
        percentage: totalRoutes > 0 ? Math.round((count / totalRoutes) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);

    // 月度趋势（近 6 个月）
    const now = new Date();
    const monthTrend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const sessions = allSessions.filter(s => s.date && s.date.startsWith(ym));
      const routes = sessions.reduce((sum, s) => sum + (s.routes || []).length, 0);
      monthTrend.push({ month: ym, sessions: sessions.length, routes });
    }

    return success({
      totalSessions,
      totalRoutes,
      monthSessions,
      monthRoutes,
      maxGrade,
      maxGradeLevel,
      completionRate,
      flashCount,
      completedCount,
      failedCount,
      projectCount,
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

const compressImage = async (filePath) => {
  try {
    const res = await wx.compressImage({ src: filePath, quality: 80 });
    return success(res.tempFilePath);
  } catch (err) {
    console.warn('[Image] 压缩失败，使用原图:', err);
    return success(filePath);
  }
};

const uploadImage = async (filePath) => {
  try {
    const compressRes = await compressImage(filePath);
    const finalPath = compressRes.data;

    const ext = finalPath.split('.').pop() || 'jpg';
    const today = getToday();
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const cloudPath = `climbing-images/${today}/${ts}-${rand}.${ext}`;

    const res = await wx.cloud.uploadFile({ cloudPath, filePath: finalPath });
    return success(res.fileID);
  } catch (err) {
    return fail(err);
  }
};

const uploadImages = async (filePaths) => {
  try {
    const fileIDs = [];
    for (let i = 0; i < filePaths.length; i++) {
      const res = await uploadImage(filePaths[i]);
      if (!res.success) return fail(new Error(`第${i + 1}张图片上传失败: ${res.error}`));
      fileIDs.push(res.data);
    }
    return success(fileIDs);
  } catch (err) {
    return fail(err);
  }
};

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
// climbing_records 旧接口（保留兼容）
// ============================================

const deriveProjectFields = (status) => {
  if (status === 'project') return { isProject: true, projectStatus: 'active' };
  return { isProject: false, projectStatus: '' };
};

const deriveGradeFields = (grade, climbType) => {
  if (!grade) return { gradeLevel: -1, gradeSystem: '' };
  const system = getGradeSystem(climbType);
  const level = getGradeLevel(grade, system);
  return { gradeLevel: level, gradeSystem: system };
};

const createRecord = async (record) => {
  try {
    const now = timestamp();
    const dateStr = record.date || getToday();
    const gradeFields = deriveGradeFields(record.grade, record.climbType);
    const projectFields = deriveProjectFields(record.status);

    const doc = {
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
      createdAt: now,
      updatedAt: now
    };

    const res = await recordsCol.add({ data: doc });
    return success(res._id);
  } catch (err) {
    return fail(err);
  }
};

const updateRecord = async (id, data) => {
  try {
    const updateData = { ...data, updatedAt: timestamp() };

    if (data.grade !== undefined) {
      const climbType = data.climbType;
      let gradeSystem = '';
      if (!climbType) {
        const original = await recordsCol.doc(id).get();
        gradeSystem = getGradeSystem(original.data.climbType);
      } else {
        gradeSystem = getGradeSystem(climbType);
      }
      updateData.gradeSystem = gradeSystem;
      updateData.gradeLevel = getGradeLevel(data.grade, gradeSystem);
    }

    if (data.status !== undefined) {
      const projectFields = deriveProjectFields(data.status);
      updateData.isProject = projectFields.isProject;
      updateData.projectStatus = projectFields.isProject ? (data.projectStatus || 'active') : '';
    }

    if (data.date !== undefined) {
      updateData.timestamp = new Date(data.date).getTime();
    }

    const res = await recordsCol.doc(id).update({ data: updateData });
    return success(res.stats.updated);
  } catch (err) {
    return fail(err);
  }
};

const deleteRecord = async (id) => {
  try {
    const res = await recordsCol.doc(id).remove();
    return success(res.stats.removed);
  } catch (err) {
    return fail(err);
  }
};

const getRecordById = async (id) => {
  try {
    const res = await recordsCol.doc(id).get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

const getRecords = async (options = {}) => {
  try {
    const { page = 1, pageSize = 20, filters = {}, keyword } = options;
    const skip = (page - 1) * pageSize;
    const conditions = [];

    if (filters.climbType) conditions.push({ climbType: filters.climbType });
    if (filters.status) conditions.push({ status: filters.status });
    if (filters.grade) conditions.push({ grade: filters.grade });
    if (filters.location) conditions.push({ location: filters.location });

    if (keyword) {
      const regex = db.RegExp({ regexp: keyword, options: 'i' });
      conditions.push(_.or([
        { location: regex },
        { notes: regex },
        { routeName: regex }
      ]));
    }

    const where = conditions.length > 0 ? _.and(conditions) : {};

    const [listRes, countRes] = await Promise.all([
      recordsCol.where(where).orderBy('timestamp', 'desc').skip(skip).limit(pageSize).get(),
      recordsCol.where(where).count()
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

const getRecentRecords = async (limit = 5) => {
  try {
    const res = await recordsCol.orderBy('timestamp', 'desc').limit(limit).get();
    return success(res.data);
  } catch (err) {
    return fail(err);
  }
};

const getStats = async () => {
  try {
    let allRecords = [];
    let hasMore = true;
    let skip = 0;
    const batchSize = 100;

    while (hasMore) {
      const res = await recordsCol.orderBy('timestamp', 'desc').skip(skip).limit(batchSize).get();
      allRecords = allRecords.concat(res.data);
      hasMore = res.data.length === batchSize;
      skip += batchSize;
    }

    const total = allRecords.length;
    const monthClimbs = allRecords.filter(r => isThisMonth(r.date)).length;

    let maxGrade = '';
    let maxGradeLevel = -1;
    allRecords.forEach(r => {
      if (r.gradeLevel > maxGradeLevel) {
        maxGradeLevel = r.gradeLevel;
        maxGrade = r.grade;
      }
    });

    const completedCount = allRecords.filter(r => r.status === 'flash' || r.status === 'completed').length;
    const completionRate = total > 0 ? Math.round((completedCount / total) * 100) : 0;
    const flashCount = allRecords.filter(r => r.status === 'flash').length;
    const projectRecords = allRecords.filter(r => r.isProject);
    const projectCount = projectRecords.length;
    const projectActive = projectRecords.filter(r => r.projectStatus === 'active').length;
    const projectCompleted = projectRecords.filter(r => r.projectStatus === 'completed').length;
    const projectAbandoned = projectRecords.filter(r => r.projectStatus === 'abandoned').length;

    const locationMap = {};
    allRecords.forEach(r => { if (r.location) locationMap[r.location] = (locationMap[r.location] || 0) + 1; });
    const topLocations = Object.entries(locationMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    const typeMap = {};
    allRecords.forEach(r => { if (r.climbType) typeMap[r.climbType] = (typeMap[r.climbType] || 0) + 1; });
    const typeDistribution = Object.entries(typeMap).map(([type, count]) => ({ type, count, percentage: total > 0 ? Math.round((count / total) * 100) : 0 })).sort((a, b) => b.count - a.count);

    const now = new Date();
    const monthTrend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const count = allRecords.filter(r => r.date && r.date.startsWith(ym)).length;
      monthTrend.push({ month: ym, count });
    }

    return success({
      total, monthClimbs, maxGrade, maxGradeLevel, completedCount, completionRate,
      flashCount, projectCount, projectActive, projectCompleted, projectAbandoned,
      topLocations, typeDistribution, monthTrend
    });
  } catch (err) {
    return fail(err);
  }
};

const addRecord = async (record) => createRecord(record);

const getAllRecords = async () => {
  try {
    const res = await getRecords({ pageSize: 1000 });
    if (res.success) return { data: res.data.list };
    throw new Error(res.error);
  } catch (err) {
    throw err;
  }
};

// ============================================
// 导出
// ============================================

module.exports = {
  // ---- 云函数调用 ----
  callCloud,

  // ---- 新版 Session 接口 ----
  createSession,
  updateSession,
  deleteSession,
  getSessionById,
  getSessions,
  getRecentSessions,
  getSessionStats,

  // ---- 图片操作 ----
  compressImage,
  uploadImage,
  uploadImages,
  deleteImage,

  // ---- 旧版 Record 接口（保留兼容） ----
  createRecord,
  updateRecord,
  deleteRecord,
  getRecordById,
  getRecords,
  getRecentRecords,
  getStats,
  addRecord,
  getAllRecords
};
