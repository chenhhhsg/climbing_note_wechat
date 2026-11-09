/**
 * 试用身份与数据集标识（集中、稳定、明确为虚构）
 *
 * 独立试用工程没有真实微信账号归属，页面也不读取昵称、头像或登录态。
 * 这里注入的 ownerId / datasetId 只用于本机试用数据的归属检查：
 * - ownerId 是虚构的本机试用用户，不代表任何真实账号；
 * - datasetId 标记一整套试用线路编号空间；将来安全重置时换成新值，
 *   避免重建后复用 route-local-N 时挂上旧数据集的照片。
 *
 * 真实微信账号隔离、正式线路接入与云迁移不在本轮范围。
 */
const TRIAL_OWNER_ID = 'trial-user-local-a';
const TRIAL_DATASET_ID = 'trial-dataset-local-1';
const TRIAL_DATASET_PREFIX = 'trial-dataset-local-';

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTrialDatasetId(value) {
  return (
    hasText(value) &&
    value.indexOf(TRIAL_DATASET_PREFIX) === 0 &&
    value.length > TRIAL_DATASET_PREFIX.length
  );
}

/**
 * 安全重置时轮换数据集，避免重建的 route-local-N 挂上旧数据集照片。
 * 旧数据集及照片索引/文件保留，不在这里删除。
 */
function nextTrialDatasetId(currentId) {
  const match = /^trial-dataset-local-(\d+)$/.exec(String(currentId || ''));
  const next = match ? Number(match[1]) + 1 : 1;
  return TRIAL_DATASET_PREFIX + next;
}

module.exports = {
  TRIAL_OWNER_ID,
  TRIAL_DATASET_ID,
  TRIAL_DATASET_PREFIX,
  isTrialDatasetId,
  nextTrialDatasetId
};
