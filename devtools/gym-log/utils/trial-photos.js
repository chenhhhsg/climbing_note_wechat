/**
 * 试用工程的线路照片服务入口
 *
 * 页面只通过这里取得照片服务，避免各自拼接 ownerId / datasetId：
 * - ownerId 与 datasetId 来自 trial-profile.js 的虚构常量；
 * - 同一 JS 上下文共享一个服务实例，recover() 每个实例只执行一次，
 *   防止从今日页进入详情页时把另一个页面正在保存的操作中止；
 * - 服务只读写 T010 的专用照片索引与文件目录，不碰场次/尝试缓存。
 */
const { createRoutePhotoService } = require('./route-photos.js');
const { createWxPhotoFiles } = require('./photo-files.js');
const {
  TRIAL_OWNER_ID,
  TRIAL_DATASET_ID
} = require('./trial-profile.js');

let active = null;
let spacePolicy = null;

/**
 * 试用预算默认取 T012 的集中常量；这里只允许测试/试用注入小数值，
 * 不提供页面入口修改，避免把“可保存张数”变成用户可随意放宽的承诺。
 */
function setTrialSpacePolicy(policy) {
  spacePolicy = policy && typeof policy === 'object'
    ? Object.assign({}, policy)
    : null;
  // 已创建的服务仍持有旧预算；下一次 open 时重建。这里不删除任何照片或索引。
  active = null;
}

function getTrialSpacePolicy() {
  return spacePolicy ? Object.assign({}, spacePolicy) : null;
}

function createTrialPhotoService(datasetId, options) {
  const config = options || {};
  return createRoutePhotoService({
    ownerId: TRIAL_OWNER_ID,
    datasetId: datasetId || TRIAL_DATASET_ID,
    files: createWxPhotoFiles(),
    space: config.space || spacePolicy || undefined
  });
}

/**
 * 取得当前数据集的服务与首次恢复结果。
 * 数据集变化时重建服务；recover() 只在中止上次未完成操作和清理孤儿时执行一次。
 */
function openTrialPhotos(datasetId) {
  const target = datasetId || TRIAL_DATASET_ID;
  if (!active || active.datasetId !== target) {
    active = {
      datasetId: target,
      service: createTrialPhotoService(target),
      ready: null
    };
  }
  if (!active.ready) {
    active.ready = active.service.recover();
  }
  return { service: active.service, ready: active.ready };
}

/**
 * 释放共享实例；重置数据集、重新读取隔离数据或离线测试之间调用。
 * 不删除任何照片文件或索引。
 */
function resetTrialPhotoService() {
  active = null;
}

module.exports = {
  TRIAL_OWNER_ID,
  TRIAL_DATASET_ID,
  createTrialPhotoService,
  openTrialPhotos,
  resetTrialPhotoService,
  setTrialSpacePolicy,
  getTrialSpacePolicy
};
