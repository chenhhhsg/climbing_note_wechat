/**
 * 正式记录版 · 线路主照片文件适配器（T019）
 *
 * 只封装本机文件与图片处理，不读写照片索引、不做归属判断：
 * - 主图与缩略图都落在小程序用户文件目录的专用子目录里，且按本机档案分目录；
 * - 压缩只按最长边等比缩放并保持整幅画面，不做裁剪；
 * - 所有方法返回 { ok, ... }，不向调用方抛异常；
 * - 可注入 wxApi 或整个适配器，离线测试不需要真实微信文件系统。
 *
 * 目录与文件命名都属于本服务的专用命名空间：
 *   <USER_DATA_PATH>/training-photos/v1/<archiveId>/main/photo-<seq>.jpg
 *   <USER_DATA_PATH>/training-photos/v1/<archiveId>/thumb/photo-<seq>.jpg
 *
 * 档案分目录是正式版与试用工程的差别：一份本机档案的照片只写在它自己的目录里，
 * 其他档案的文件既不会被这份档案的索引引用，也不会被它的清理操作删除。
 *
 * 缩略图是可重建内容；主图路径由照片索引单独记录，不能把选择器临时路径
 * 当成照片身份或持久位置。
 */
const PHOTO_FILES_VERSION = 1;
const PHOTO_ROOT_DIRNAME = 'training-photos';
const PHOTO_ID_PATTERN = /^photo-[A-Za-z0-9_-]+$/;
const PHOTO_FILE_PATTERN = /^photo-[A-Za-z0-9_-]+\.(?:jpg|jpeg|png)$/i;
// 档案 ID 会成为目录名，只接受本机档案层生成的字符集合。
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

/**
 * 档案 ID 只用于本机目录名：不接受空值、路径分隔符、协议前缀或其他可能
 * 逃出照片根目录的写法。
 */
function isSafeArchiveId(archiveId) {
  return typeof archiveId === 'string' && ARCHIVE_ID_PATTERN.test(archiveId);
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

function createWxTrainingPhotoFiles(options) {
  const config = options || {};
  const api =
    config.wxApi || (typeof wx !== 'undefined' ? wx : null);
  const userDataPath =
    config.userDataPath || (api && api.env && api.env.USER_DATA_PATH) || '';
  const archiveId = hasText(config.archiveId) ? config.archiveId : '';
  const safeArchiveId = isSafeArchiveId(archiveId);
  const rootDir =
    normalizePath(config.rootDir) ||
    (safeArchiveId
      ? joinPath(
          userDataPath,
          PHOTO_ROOT_DIRNAME,
          'v' + PHOTO_FILES_VERSION,
          archiveId
        )
      : '');
  const mainDir = joinPath(rootDir, 'main');
  const thumbDir = joinPath(rootDir, 'thumb');

  let readyPromise = null;

  function fileSystem() {
    return getFileSystemManager(api);
  }

  /**
   * 每个会动到文件的入口都先确认这份适配器绑定了一个合法档案目录：
   * 目录为空时不写、不读、不删，只返回可见错误，避免落到根目录或别处。
   */
  function requireRoot() {
    if (safeArchiveId && hasText(rootDir)) return null;
    return {
      ok: false,
      error: '缺少有效的本机档案标识，不能读写线路照片文件'
    };
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
    const invalid = requireRoot();
    if (invalid) return Promise.resolve(invalid);
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
    const invalid = requireRoot();
    if (invalid) return invalid;
    const result = await unlink(filePath);
    if (result.ok) return { ok: true, existed: true };
    if (isMissingPathError(result.error)) {
      return { ok: true, existed: false };
    }
    return { ok: false, error: '删除照片文件失败：' + result.error };
  }

  async function stat(filePath) {
    const invalid = requireRoot();
    if (invalid) return invalid;
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
   * 开发者工具对 http://usr 持久路径调用 wx.compressImage 会报
   * file doesn't exist；部分基础库也只接受临时文件。这里用离屏画布从
   * 持久主图重绘缩略图，作为压缩器失败后的回退，供“清缓存后重建缩略图”使用。
   */
  function compressViaCanvas(input, width, height, quality) {
    return new Promise(resolve => {
      const createCanvas =
        api && typeof api.createOffscreenCanvas === 'function'
          ? api.createOffscreenCanvas
          : null;
      const toTempFile =
        api && typeof api.canvasToTempFilePath === 'function'
          ? api.canvasToTempFilePath.bind(api)
          : null;
      if (!createCanvas || !toTempFile) {
        resolve({ ok: false, error: '当前环境不支持画布压缩' });
        return;
      }

      let canvas;
      let context;
      let image;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        canvas = createCanvas({ type: '2d', width, height });
        context = canvas && canvas.getContext('2d');
        image = canvas && canvas.createImage();
      } catch (error) {
        finish({ ok: false, error: '画布初始化失败：' + errorText(error) });
        return;
      }
      if (!canvas || !context || !image) {
        finish({ ok: false, error: '画布初始化失败：返回结构无效' });
        return;
      }

      image.onload = () => {
        try {
          context.drawImage(image, 0, 0, width, height);
        } catch (error) {
          finish({ ok: false, error: '画布绘制失败：' + errorText(error) });
          return;
        }
        try {
          toTempFile({
            canvas,
            fileType: 'jpg',
            quality,
            destWidth: width,
            destHeight: height,
            success(result) {
              const path = result && result.tempFilePath;
              if (!hasText(path)) {
                finish({ ok: false, error: '画布压缩失败：没有返回临时文件' });
                return;
              }
              finish({
                ok: true,
                path,
                width,
                height,
                source: {
                  width: input.sourceWidth,
                  height: input.sourceHeight
                },
                viaCanvas: true
              });
            },
            fail(error) {
              finish({
                ok: false,
                error: '画布压缩失败：' + errorText(error)
              });
            }
          });
        } catch (error) {
          finish({ ok: false, error: '画布压缩失败：' + errorText(error) });
        }
      };
      image.onerror = () => {
        finish({ ok: false, error: '画布读取照片失败' });
      };

      try {
        image.src = input.srcPath;
      } catch (error) {
        finish({ ok: false, error: '画布读取照片失败：' + errorText(error) });
      }
    });
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

    const quality =
      Number.isFinite(input.quality) && input.quality > 0
        ? Math.min(100, Math.round(input.quality))
        : 80;
    const request = {
      src: input.srcPath,
      quality
    };
    if (scale < 1) request.compressedWidth = targetWidth;

    const result = await toPromiseApi(api, 'compressImage', request);
    if (!result.ok) {
      const fallback = await compressViaCanvas(
        {
          srcPath: input.srcPath,
          sourceWidth: info.width,
          sourceHeight: info.height
        },
        targetWidth,
        targetHeight,
        quality
      );
      if (fallback.ok) return fallback;
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
    const invalid = requireRoot();
    if (invalid) return invalid;
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
    archiveId,
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
  ARCHIVE_ID_PATTERN,
  createWxTrainingPhotoFiles,
  isSafePhotoId,
  isSafeArchiveId,
  errorText
};
