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

function createTrialPhotoService(datasetId) {
  return createRoutePhotoService({
    ownerId: TRIAL_OWNER_ID,
    datasetId: datasetId || TRIAL_DATASET_ID,
    files: createWxPhotoFiles()
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
  resetTrialPhotoService
};
