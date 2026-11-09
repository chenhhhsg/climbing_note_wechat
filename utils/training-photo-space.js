/**
 * 正式记录版 · 线路主照片空间计量与预算（T019）
 *
 * 只处理本服务专用目录（正式版为某一份本机档案的照片目录）里的实际文件，
 * 不用单张照片的估值：
 * - 逐项读取 main/ 与 thumb/ 中每个受管文件的实际字节数；
 * - 同一 photoId 的主图 + 缩略图只按文件各计一次，跨天查看同一线路不会重复计费；
 * - 未完成操作留下的文件、失败后残留的孤儿文件同样占用本机空间，照实计入；
 * - 预算 B、提醒线 W、更换余量 R 是应用自设上限，不是微信或设备可用空间的保证。
 *
 * 数值全部集中在这里，并允许注入小数值用于边界测试。1 MiB = 1024 × 1024 字节。
 */

const MIB = 1024 * 1024;

const PHOTO_SPACE_POLICY = Object.freeze({
  budgetBytes: 100 * MIB,
  warnBytes: 80 * MIB,
  reserveBytes: 10 * MIB
});

const SPACE_ERROR_PATTERN =
  /no space|not enough space|ENOSPC|disk (?:is )?full|storage (?:is )?full|quota|exceed|空间不足|磁盘已满|存储空间/i;

function toPositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

/**
 * 只接受正数预算与提醒线；不合法或未提供时退回默认值。
 * 提醒线不超过预算，更换余量不超过预算，避免自相矛盾的注入值。
 */
function resolveSpacePolicy(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const budgetBytes =
    toPositiveInteger(raw.budgetBytes) || PHOTO_SPACE_POLICY.budgetBytes;
  const warnRaw =
    toPositiveInteger(raw.warnBytes) ||
    Math.min(PHOTO_SPACE_POLICY.warnBytes, budgetBytes);
  const reserveRaw =
    raw.reserveBytes === undefined
      ? Math.min(PHOTO_SPACE_POLICY.reserveBytes, budgetBytes)
      : toNonNegativeInteger(raw.reserveBytes);
  return {
    version: 1,
    budgetBytes,
    warnBytes: Math.min(warnRaw, budgetBytes),
    reserveBytes: Math.min(reserveRaw, budgetBytes)
  };
}

function isSpaceError(text) {
  return SPACE_ERROR_PATTERN.test(typeof text === 'string' ? text : '');
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '0 KB';
  if (bytes >= MIB) {
    const value = bytes / MIB;
    return (value >= 10 ? value.toFixed(1) : value.toFixed(2)) + ' MB';
  }
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function photoSeqOf(fileName) {
  const match = /^(photo-[A-Za-z0-9_-]+)\.(?:jpg|jpeg|png)$/i.exec(
    typeof fileName === 'string' ? fileName : ''
  );
  return match ? match[1] : '';
}

/**
 * 创建计量器。files 必须是同目录的照片文件适配器
 * （listMain/listThumb/stat/mainPath/thumbPath）。
 */
function createPhotoSpaceMeter(options) {
  const config = options || {};
  const files = config.files;
  const policy = resolveSpacePolicy(config.policy);

  async function collect(list, kind) {
    if (!list.ok) {
      return {
        ok: false,
        error: '读取照片文件清单失败：' + (list.error || '未知错误')
      };
    }
    const entries = [];
    for (const file of list.files) {
      const statResult = await files.stat(file.path);
      if (!statResult.ok) {
        return {
          ok: false,
          error: '读取照片文件大小失败：' + (statResult.error || '未知错误')
        };
      }
      // 读取清单与 stat 之间文件被删除：不计入占用，也不当成错误。
      if (!statResult.exists || !(statResult.bytes > 0)) continue;
      entries.push({
        path: file.path,
        name: file.name,
        kind,
        photoId: photoSeqOf(file.name),
        bytes: statResult.bytes
      });
    }
    return { ok: true, entries };
  }

  /**
   * 逐项计量受管文件。context.photos 是索引里的主照片记录，
   * context.startedPhotoIds 是仍未完成操作占用的 photoId。
   * 统计只按真实文件，不使用 photos[].bytes 中的写入时快照。
   */
  async function measure(context) {
    if (!files) {
      return { ok: false, error: '缺少照片文件适配器，无法统计照片空间' };
    }
    const photos = (context && context.photos) || [];
    const startedPhotoIds = new Set(
      (context && context.startedPhotoIds) || []
    );

    const mainList = await files.listMain();
    const main = await collect(mainList, 'main');
    if (!main.ok) return main;

    const thumbList = await files.listThumb();
    const thumb = await collect(thumbList, 'thumb');
    if (!thumb.ok) return thumb;

    const mainPaths = new Set(
      photos.map(photo => files.mainPath(photo.photoId))
    );
    const thumbPaths = new Set(
      photos.map(photo => files.thumbPath(photo.photoId))
    );
    const startedMain = new Set(
      Array.from(startedPhotoIds).map(photoId => files.mainPath(photoId))
    );
    const startedThumb = new Set(
      Array.from(startedPhotoIds).map(photoId => files.thumbPath(photoId))
    );

    const entries = main.entries.concat(thumb.entries);
    let mainBytes = 0;
    let thumbBytes = 0;
    let orphanBytes = 0;
    const orphanPaths = [];
    for (const entry of entries) {
      const isMain = entry.kind === 'main';
      if (isMain) mainBytes += entry.bytes;
      else thumbBytes += entry.bytes;

      const referenced = isMain
        ? mainPaths.has(entry.path) || startedMain.has(entry.path)
        : thumbPaths.has(entry.path) || startedThumb.has(entry.path);
      if (!referenced) {
        orphanBytes += entry.bytes;
        orphanPaths.push(entry.path);
      }
      entry.referenced = referenced;
    }

    const totalBytes = mainBytes + thumbBytes;
    const presentPaths = new Set(entries.map(entry => entry.path));
    const missingMains = photos
      .filter(photo => !presentPaths.has(files.mainPath(photo.photoId)))
      .map(photo => ({
        photoId: photo.photoId,
        path: files.mainPath(photo.photoId)
      }));
    const missingThumbs = photos
      .filter(photo => !presentPaths.has(files.thumbPath(photo.photoId)))
      .map(photo => ({
        photoId: photo.photoId,
        path: files.thumbPath(photo.photoId)
      }));

    return {
      ok: true,
      policy,
      totalBytes,
      mainBytes,
      thumbBytes,
      orphanBytes,
      orphanPaths,
      fileCount: entries.length,
      files: entries,
      missingMains,
      missingThumbs,
      warn: totalBytes >= policy.warnBytes,
      overBudget: totalBytes > policy.budgetBytes,
      percent: Math.min(
        100,
        Math.round((totalBytes / policy.budgetBytes) * 100)
      ),
      remainingBytes: Math.max(0, policy.budgetBytes - totalBytes)
    };
  }

  /**
   * 新增/更换前的峰值检查：当前实际占用 + 新主图 + 新缩略图，
   * 再加更换余量 R，必须不超过预算 B。更换时旧文件尚未删除，已包含在占用里。
   */
  function checkSave(totalBytes, newMainBytes, newThumbBytes) {
    const used = toNonNegativeInteger(totalBytes);
    const newMain = toNonNegativeInteger(newMainBytes);
    const newThumb = toNonNegativeInteger(newThumbBytes);
    const newBytes = newMain + newThumb;
    const projectedBytes = used + newBytes;
    const peakBytes = projectedBytes + policy.reserveBytes;
    const ok = peakBytes <= policy.budgetBytes;
    return {
      ok,
      reason: ok ? '' : 'budget',
      totalBytes: used,
      newMainBytes: newMain,
      newThumbBytes: newThumb,
      newBytes,
      projectedBytes,
      peakBytes,
      policy,
      remainingAfterPeakBytes: Math.max(0, policy.budgetBytes - peakBytes),
      message: ok
        ? ''
        : '预计峰值 ' +
          formatBytes(peakBytes) +
          '（当前占用 ' +
          formatBytes(used) +
          ' + 新照片 ' +
          formatBytes(newBytes) +
          ' + 更换余量 ' +
          formatBytes(policy.reserveBytes) +
          '）超过本机照片预算 ' +
          formatBytes(policy.budgetBytes) +
          '；旧照片和记录未改动。'
    };
  }

  return {
    policy,
    measure,
    checkSave
  };
}

module.exports = {
  MIB,
  PHOTO_SPACE_POLICY,
  SPACE_ERROR_PATTERN,
  resolveSpacePolicy,
  isSpaceError,
  formatBytes,
  createPhotoSpaceMeter
};
