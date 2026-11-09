/**
 * 岩馆快速记录 · 线路照片文件适配器
 *
 * 只封装本机文件与图片处理，不读写照片索引、不做归属判断：
 * - 主图与缩略图都落在小程序用户文件目录的专用子目录里；
 * - 压缩只按最长边等比缩放并保持整幅画面，不做裁剪；
 * - 所有方法返回 { ok, ... }，不向调用方抛异常；
 * - 可注入 wxApi 或整个适配器，离线测试不需要真实微信文件系统。
 *
 * 目录与文件命名都属于本服务的专用命名空间：
 *   <USER_DATA_PATH>/gym-log-trial-photos/v1/main/photo-<seq>.jpg
 *   <USER_DATA_PATH>/gym-log-trial-photos/v1/thumb/photo-<seq>.jpg
 *
 * 缩略图是可重建内容；主图路径由照片索引单独记录，不能把选择器临时路径
 * 当成照片身份或持久位置。
 */
const PHOTO_FILES_VERSION = 1;
const PHOTO_ROOT_DIRNAME = 'gym-log-trial-photos';
const PHOTO_ID_PATTERN = /^photo-[A-Za-z0-9_-]+$/;
const PHOTO_FILE_PATTERN = /^photo-[A-Za-z0-9_-]+\.(?:jpg|jpeg|png)$/i;

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function isSafePhotoId(photoId) {
  return typeof photoId === 'string' && PHOTO_ID_PATTERN.test(photoId);
}

function normalizePath(value) {
  if (!hasText(value)) return '';
  const text = value.replace(/\\/g, '/');
  // 微信用户目录是 http://usr（开发者工具）或 wxfile://usr（真机），
  // 协议后的双斜线不能被折叠，否则会变成 http:/usr 导致 mkdir 拒绝访问。
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/.exec(text);
  const scheme = match ? match[1] : '';
  const rest = match ? match[2] : text;
  return scheme + rest.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function joinPath() {
  const parts = Array.prototype.slice
    .call(arguments)
    .filter(part => hasText(part));
  if (!parts.length) return '';
  return normalizePath(parts.join('/'));
}

function isMissingPathError(text) {
  return /no such file|not exist|ENOENT|cannot find/i.test(text || '');
}

function toPromiseApi(api, method, options) {
  return new Promise(resolve => {
    if (!api || typeof api[method] !== 'function') {
      resolve({ ok: false, error: '当前环境不支持 ' + method });
      return;
    }
    try {
      api[method](
        Object.assign({}, options, {
          success(result) {
            resolve({ ok: true, result: result || {} });
          },
          fail(error) {
            resolve({ ok: false, error: errorText(error) });
          }
        })
      );
    } catch (error) {
      resolve({ ok: false, error: errorText(error) });
    }
  });
}

function getFileSystemManager(api) {
  if (!api || typeof api.getFileSystemManager !== 'function') return null;
  try {
    return api.getFileSystemManager();
  } catch (error) {
    return null;
  }
}

function createWxPhotoFiles(options) {
  const config = options || {};
  const api =
    config.wxApi || (typeof wx !== 'undefined' ? wx : null);
  const userDataPath =
    config.userDataPath || (api && api.env && api.env.USER_DATA_PATH) || '';
  const rootDir =
    normalizePath(config.rootDir) ||
    joinPath(userDataPath, PHOTO_ROOT_DIRNAME, 'v' + PHOTO_FILES_VERSION);
  const mainDir = joinPath(rootDir, 'main');
  const thumbDir = joinPath(rootDir, 'thumb');

  let readyPromise = null;

  function fileSystem() {
    return getFileSystemManager(api);
  }

  function copyFile(srcPath, destPath) {
    const fs = fileSystem();
    if (!fs) return Promise.resolve({ ok: false, error: '文件系统不可用' });
    return toPromiseApi(fs, 'copyFile', { srcPath, destPath });
  }

  function unlink(filePath) {
    const fs = fileSystem();
    if (!fs) return Promise.resolve({ ok: false, error: '文件系统不可用' });
    return toPromiseApi(fs, 'unlink', { filePath });
  }

  async function mkdirp(dirPath) {
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'mkdir', {
      dirPath,
      recursive: true
    });
    if (result.ok) return { ok: true };
    // 目录已存在时不同基础库返回的报错文案不同，统一视为成功。
    if (/already exist|file exists|EEXIST/i.test(result.error)) {
      return { ok: true };
    }
    return { ok: false, error: '创建照片目录失败：' + result.error };
  }

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const main = await mkdirp(mainDir);
        if (!main.ok) return main;
        return mkdirp(thumbDir);
      })().then(result => {
        if (!result.ok) readyPromise = null;
        return result;
      });
    }
    return readyPromise;
  }

  async function remove(filePath) {
    if (!hasText(filePath)) return { ok: true, existed: false };
    const result = await unlink(filePath);
    if (result.ok) return { ok: true, existed: true };
    if (isMissingPathError(result.error)) {
      return { ok: true, existed: false };
    }
    return { ok: false, error: '删除照片文件失败：' + result.error };
  }

  async function stat(filePath) {
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'stat', { path: filePath });
    if (!result.ok) {
      if (isMissingPathError(result.error)) {
        return { ok: true, exists: false, bytes: 0 };
      }
      return { ok: false, error: '读取照片文件状态失败：' + result.error };
    }
    let stats = result.result.stats;
    if (Array.isArray(stats)) stats = stats[0];
    if (!stats || typeof stats.size !== 'number') {
      return { ok: false, error: '读取照片文件状态失败：返回结构无效' };
    }
    return { ok: true, exists: true, bytes: stats.size };
  }

  async function getImageInfo(srcPath) {
    if (!hasText(srcPath)) {
      return { ok: false, error: '缺少照片来源路径' };
    }
    const result = await toPromiseApi(api, 'getImageInfo', { src: srcPath });
    if (!result.ok) {
      return { ok: false, error: '读取照片尺寸失败：' + result.error };
    }
    const info = result.result || {};
    if (!(info.width > 0) || !(info.height > 0)) {
      return { ok: false, error: '读取照片尺寸失败：返回宽高无效' };
    }
    return {
      ok: true,
      width: info.width,
      height: info.height,
      type: typeof info.type === 'string' ? info.type : ''
    };
  }

  /**
   * 等比缩放到最长边不超过 maxEdge。compressedWidth 只按宽度比例给，
   * 长宽比由微信压缩器保持，因此不会裁剪画面。
   */
  async function compressImage(options) {
    const input = options || {};
    const info = await getImageInfo(input.srcPath);
    if (!info.ok) return info;

    const maxEdge = Number(input.maxEdge) > 0 ? Number(input.maxEdge) : 0;
    const longest = Math.max(info.width, info.height);
    const scale =
      maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1;
    const targetWidth = Math.max(1, Math.round(info.width * scale));
    const targetHeight = Math.max(1, Math.round(info.height * scale));

    const request = {
      src: input.srcPath,
      quality:
        Number.isFinite(input.quality) && input.quality > 0
          ? Math.min(100, Math.round(input.quality))
          : 80
    };
    if (scale < 1) request.compressedWidth = targetWidth;

    const result = await toPromiseApi(api, 'compressImage', request);
    if (!result.ok) {
      return { ok: false, error: '照片压缩失败：' + result.error };
    }
    const path = result.result.tempFilePath;
    if (!hasText(path)) {
      return { ok: false, error: '照片压缩失败：没有返回临时文件' };
    }
    return {
      ok: true,
      path,
      width: targetWidth,
      height: targetHeight,
      source: { width: info.width, height: info.height }
    };
  }

  function mainPath(photoId) {
    return isSafePhotoId(photoId) ? joinPath(mainDir, photoId + '.jpg') : '';
  }

  function thumbPath(photoId) {
    return isSafePhotoId(photoId) ? joinPath(thumbDir, photoId + '.jpg') : '';
  }

  async function writeInto(dirPath, photoId, srcPath, label) {
    if (!isSafePhotoId(photoId)) {
      return { ok: false, error: label + '文件名无效' };
    }
    if (!hasText(srcPath)) {
      return { ok: false, error: label + '缺少来源文件' };
    }
    const ready = await ensureReady();
    if (!ready.ok) return ready;

    const targetPath = joinPath(dirPath, photoId + '.jpg');
    // 覆盖只发生在同一个未提交的 photoId 上；调用方保证目标未被索引引用。
    const removed = await remove(targetPath);
    if (!removed.ok) return removed;

    const copied = await copyFile(srcPath, targetPath);
    if (!copied.ok) {
      await remove(targetPath);
      return { ok: false, error: label + '写入失败：' + copied.error };
    }

    const statResult = await stat(targetPath);
    if (!statResult.ok || !statResult.exists || !(statResult.bytes > 0)) {
      await remove(targetPath);
      return {
        ok: false,
        error:
          label +
          '写入失败：' +
          (statResult.ok ? '文件为空或不存在' : statResult.error)
      };
    }
    return { ok: true, path: targetPath, bytes: statResult.bytes };
  }

  function writeMain(photoId, srcPath) {
    return writeInto(mainDir, photoId, srcPath, '主图');
  }

  function writeThumb(photoId, srcPath) {
    return writeInto(thumbDir, photoId, srcPath, '缩略图');
  }

  async function readDir(dirPath) {
    const fs = fileSystem();
    if (!fs) return { ok: false, error: '文件系统不可用' };
    const result = await toPromiseApi(fs, 'readdir', { dirPath });
    if (!result.ok) {
      if (isMissingPathError(result.error)) {
        return { ok: true, files: [] };
      }
      return { ok: false, error: '读取照片目录失败：' + result.error };
    }
    const names = Array.isArray(result.result.files)
      ? result.result.files
      : [];
    const files = names
      .filter(name => PHOTO_FILE_PATTERN.test(name))
      .map(name => ({ name, path: joinPath(dirPath, name) }));
    return { ok: true, files };
  }

  function listMain() {
    return readDir(mainDir);
  }

  function listThumb() {
    return readDir(thumbDir);
  }

  return {
    version: PHOTO_FILES_VERSION,
    rootDir,
    mainDir,
    thumbDir,
    mainPath,
    thumbPath,
    ensureReady,
    getImageInfo,
    compressImage,
    writeMain,
    writeThumb,
    stat,
    remove,
    listMain,
    listThumb
  };
}

module.exports = {
  PHOTO_FILES_VERSION,
  PHOTO_ROOT_DIRNAME,
  PHOTO_ID_PATTERN,
  PHOTO_FILE_PATTERN,
  createWxPhotoFiles,
  isSafePhotoId,
  errorText
};
