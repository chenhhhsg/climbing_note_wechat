/**
 * 数据库操作工具
 * 封装云数据库的增删改查操作
 *
 * T016：云客户端改为惰性获取。旧记录仍是云读取，但不再在模块顶层调用
 * `wx.cloud.database()`——没有 `wx.cloud`、云环境占位或初始化失败时，正式入口
 * 的其他模块照常加载，本机档案照常读写；只有真正发起旧云请求时才在这里拿到
 * 可判别的失败（错误码 `CLOUD_UNAVAILABLE`）。对外的调用契约与错误语义不变：
 * 每个方法都返回 Promise，失败以 reject 呈现，不改为同步抛出。
 *
 * T018：旧记录回看只读。这里只加两个纯函数，都不发起请求、不写任何数据：
 * - describeCloudError：把旧云读取失败分成「云环境不可用 / 没有权限 / 记录不存在 /
 *   读取失败」四类，页面据此显示有区别的状态，而不是笼统一句「加载失败」；
 * - legacyRecordView：按原字段（`date`、`location`、`climbType`、`grade`、`status`、
 *   `attempts`、`notes`、`images`）给出只读视图。已知 `climbing_sessions.routes[]`
 *   旧形状只保留原记录与原有明细的存在事实，不拆成逐把、不按同色同级猜线路、
 *   不计入本机统计，也不向旧库写回。
 */

const COLLECTION = 'climbing_records';
const CLOUD_UNAVAILABLE = 'CLOUD_UNAVAILABLE';
// 旧云失败的四个可区分类别（describeCloudError 的返回值）。
const CLOUD_KINDS = ['unavailable', 'denied', 'not-found', 'failed'];
// CloudBase 文档化的错误码：-502003 数据库权限不足；-502004 文档不存在。
// 未列出的错误码不猜类别，落到 failed，由页面给出通用重试入口。
const DENIED_ERR_CODES = [-502003];
const NOT_FOUND_ERR_CODES = [-502004];
// T061：旧云总量查询的响应不是可识别的非负整数总数时，用这个可判别错误拒绝，
// 由页面落到既有的「读取失败」状态，而不是拿 0 或列表长度冒充总数。
const COUNT_INVALID_CODE = 'LEGACY_COUNT_INVALID';

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

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function errorCodeOf(error) {
  if (!error || typeof error !== 'object') return NaN;
  if (error.errCode !== undefined && error.errCode !== null) return Number(error.errCode);
  if (typeof error.code !== 'number') return NaN;
  return error.code;
}

/**
 * 旧云读取失败的类别：只做只读判别，不重试、不改写、不换集合。
 * 返回 'unavailable' | 'denied' | 'not-found' | 'failed'。
 */
function classifyCloudError(error) {
  if (error && error.code === CLOUD_UNAVAILABLE) return 'unavailable';

  const errCode = errorCodeOf(error);
  if (Number.isFinite(errCode) && DENIED_ERR_CODES.indexOf(errCode) !== -1) return 'denied';
  if (Number.isFinite(errCode) && NOT_FOUND_ERR_CODES.indexOf(errCode) !== -1) return 'not-found';

  // errCode 也可能是文本码（例如 DATABASE_PERMISSION_DENIED），一并参与判别。
  const rawCode = error && typeof error.errCode === 'string' ? error.errCode : '';
  const text = errorText(error) + ' ' + rawCode;
  if (/permission|denied|unauthorized|无权限|权限不足|未授权/i.test(text)) return 'denied';
  if (/not exist|does not exist|不存在/i.test(text)) return 'not-found';
  return 'failed';
}

// 四类状态各自给页面用的标题与说明；都写明本机训练不受影响、不写回旧库。
const CLOUD_ERROR_VIEW = {
  unavailable: {
    title: '云环境不可用',
    hint: '旧记录暂不可读；本机训练历史、线路详情与继续训练不受影响。'
  },
  denied: {
    title: '没有访问旧记录的权限',
    hint: '旧记录暂不可读；本机训练历史、线路详情与继续训练不受影响。'
  },
  'not-found': {
    title: '这条旧记录不存在',
    hint: '旧记录可能已被删除或不属于当前账号；本机训练历史不受影响。'
  },
  failed: {
    title: '读取旧记录失败',
    hint: '请检查网络后重试；本机训练历史、线路详情与继续训练不受影响。'
  }
};

/**
 * 页面用的旧云读取失败视图：{ kind, title, hint, message }。
 * message 只供日志与测试，页面显示 title / hint。
 */
function describeCloudError(error) {
  const kind = classifyCloudError(error);
  const view = CLOUD_ERROR_VIEW[kind] || CLOUD_ERROR_VIEW.failed;
  return { kind: kind, title: view.title, hint: view.hint, message: errorText(error) };
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 旧记录的次数：只接受非负整数（也接受等值的数字字符串），其余一律返回 null。
 * 不猜、不补、不把「尝试 5 次」拆成逐把，也不按同色同级归并。
 */
function legacyAttemptCount(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

const LEGACY_SUMMARY_HINT = '旧汇总按原记录只读显示：不拆分逐次尝试、不计入本机训练统计、不向旧库写回。';
const LEGACY_DETAIL_HINT = '这条旧记录自带明细结构：按原结构只读保留，不拆成逐把、不计入本机训练统计。';

/**
 * 旧记录的只读视图（T018）：只取原字段，缺失就是缺失，不伪造。
 *
 * 返回 { present, recordId, date, location, climbType, grade, status, attempts,
 *        attemptsText, notes, images, summaryText, hasEmbeddedRoutes,
 *        embeddedRouteCount, readOnlyHint }。
 * - present:false 表示这次真的没有旧记录（空库、记录不存在或字段不可识别）；
 * - routes[] 是已知的旧明细形状：只报数量并说明原样保留，不拆成逐把。
 */
function legacyRecordView(record) {
  const empty = {
    present: false,
    recordId: '',
    date: '',
    location: '',
    climbType: '',
    grade: '',
    status: '',
    attempts: null,
    attemptsText: '',
    notes: '',
    images: [],
    summaryText: '',
    hasEmbeddedRoutes: false,
    embeddedRouteCount: 0,
    readOnlyHint: LEGACY_SUMMARY_HINT
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) return empty;

  const attempts = legacyAttemptCount(record.attempts);
  const status = hasText(record.status) ? record.status : '';
  const grade = hasText(record.grade) ? record.grade : '';
  const climbType = hasText(record.climbType) ? record.climbType : '';
  const images = Array.isArray(record.images)
    ? record.images.filter(item => hasText(item))
    : [];
  const embeddedRoutes = Array.isArray(record.routes) ? record.routes : [];
  const hasEmbeddedRoutes = embeddedRoutes.length > 0;

  // 一个可识别的字段都没有（例如空对象）：这次没有可回看的旧记录，按空结果处理，
  // 不伪造字段、不补 0，也不把空壳当成一条汇总。
  const recognizable =
    hasText(record._id) ||
    hasText(record.date) ||
    hasText(record.location) ||
    hasText(record.climbType) ||
    hasText(record.grade) ||
    hasText(record.status) ||
    hasText(record.notes) ||
    attempts !== null ||
    images.length > 0 ||
    hasEmbeddedRoutes;
  if (!recognizable) return empty;

  const summaryParts = [];
  if (grade) summaryParts.push(grade);
  if (attempts !== null) summaryParts.push('尝试 ' + attempts + ' 次');
  if (status) summaryParts.push(status);
  const summaryText = summaryParts.length > 0 ? summaryParts.join(' · ') : '旧记录（原字段为空）';

  return {
    present: true,
    recordId: hasText(record._id) ? record._id : '',
    date: hasText(record.date) ? record.date : '',
    location: hasText(record.location) ? record.location : '',
    climbType: climbType,
    grade: grade,
    status: status,
    attempts: attempts,
    // 「尝试 5 次、完成」只显示一条历史汇总；没有次数就不显示次数，不补 0 也不拆把。
    attemptsText: attempts === null ? '' : attempts + ' 次',
    notes: hasText(record.notes) ? record.notes : '',
    images: images.slice(),
    summaryText: summaryText,
    hasEmbeddedRoutes: hasEmbeddedRoutes,
    embeddedRouteCount: embeddedRoutes.length,
    readOnlyHint: hasEmbeddedRoutes ? LEGACY_DETAIL_HINT : LEGACY_SUMMARY_HINT
  };
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

/**
 * 旧云记录总量（T061）：与 getAllRecords 使用同一个集合、同一份授权范围，
 * 但只做 count 查询，不拉取记录列表，因此不受单批 20 条的限制。
 *
 * 成功时 resolve 非负整数 total（0 也原样返回）；响应缺少可识别的 total 时，
 * 以 code = COUNT_INVALID_CODE 的 Error reject，保持「调用即拿到 Promise、
 * 失败走 reject」的既有契约；云不可用、无权限与网络失败仍按原错误对象透传，
 * 交给 describeCloudError 分类。
 *
 * @returns {Promise<Number>} 旧云记录总条数
 */
const getRecordsCount = () => withCloud(() => getRecordsCollection().count().then(response => {
  const total = response && response.total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    const error = new Error('旧云记录总数响应无法识别');
    error.code = COUNT_INVALID_CODE;
    throw error;
  }
  return total;
}));

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
  getRecordsCount,
  uploadImage,
  deleteImage,
  // 便于页面与测试识别「云不可用」这一类可判别失败。
  CLOUD_UNAVAILABLE,
  cloudUnavailable,
  // T018：旧记录只读回看用的纯函数（不发请求、不写数据）。
  CLOUD_KINDS,
  DENIED_ERR_CODES,
  NOT_FOUND_ERR_CODES,
  COUNT_INVALID_CODE,
  LEGACY_SUMMARY_HINT,
  LEGACY_DETAIL_HINT,
  classifyCloudError,
  describeCloudError,
  legacyRecordView
};
