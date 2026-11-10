/**
 * 正式记录版 · 页面侧线路照片控制器（T019）
 *
 * 场内页与线路详情页共用同一套照片状态，避免两处行为不一致：
 * - 选择照片后先进入预览，只有确认保存才调用训练照片服务；
 * - 保存中、失败、缺文件、无照片等状态统一由这里推导；
 * - 照片回调只按发起时的 routeId 更新缓存，不写回页面快照；
 * - 移除前必须由用户确认“本机唯一副本，需重新添加”。
 *
 * 归档与归属：
 * - 档案 ID 取自 T016 本机档案（utils/training-store.js），照片文件写在
 *   <USER_DATA_PATH>/training-photos/v1/<archiveId>/ 下，索引写在正式照片索引键；
 * - 页面不拼 ownerId、不读旧云记录；本机档案还不存在时不创建照片服务。
 *
 * 控制器只操作照片并通知页面重绘，不读写场次、尝试或待确认操作。
 */
const { createTrainingPhotoService } = require('./training-photos.js');
const {
  createWxTrainingPhotoFiles,
  errorText
} = require('./training-photo-files.js');
const store = require('./training-store.js');

let photoOpCounter = 0;

function makeOpId() {
  photoOpCounter += 1;
  return (
    'photo-ui-' +
    Date.now().toString(36) +
    '-' +
    photoOpCounter.toString(36)
  );
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '';
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function bytesText(photo) {
  if (!photo || !photo.bytes) return '';
  const main = formatBytes(photo.bytes.main);
  // 缩略图按“当前可用”的字节显示：读取结果带 thumbnail 时以它为准
  // （清缓存后为 0，重建后为真实文件大小），没有该字段才退回记录快照。
  const thumbBytes =
    photo.thumbnail && typeof photo.thumbnail === 'object'
      ? photo.thumbnail.available
        ? photo.thumbnail.bytes
        : 0
      : photo.bytes.thumb;
  const thumb = formatBytes(thumbBytes);
  if (main && thumb) return '主图 ' + main + ' · 缩略图 ' + thumb;
  return main ? '主图 ' + main : '';
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 选择器返回形状解析：两种接口字段不同，且都可能在字段存在但为空时返回。
 * - wx.chooseMedia：tempFiles[].tempFilePath
 * - wx.chooseImage：tempFilePaths[] 或 tempFiles[].path
 * 两个字段同时出现时各自取第一个非空值，不假设哪一个先有值，
 * 也不把空数组当成可用路径。
 */
function firstTextIn(list) {
  if (!Array.isArray(list)) return '';
  for (let index = 0; index < list.length; index += 1) {
    if (hasText(list[index])) return list[index];
  }
  return '';
}

function firstTempFileText(list, key) {
  if (!Array.isArray(list)) return '';
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (item && hasText(item[key])) return item[key];
  }
  return '';
}

function pickPathFromMediaResult(result) {
  if (!result) return '';
  return (
    firstTempFileText(result.tempFiles, 'tempFilePath') ||
    firstTextIn(result.tempFilePaths)
  );
}

function pickPathFromImageResult(result) {
  if (!result) return '';
  return (
    firstTextIn(result.tempFilePaths) ||
    firstTempFileText(result.tempFiles, 'path') ||
    firstTempFileText(result.tempFiles, 'tempFilePath')
  );
}

/**
 * 选择器返回值统一成 { ok, path } 或 { ok:false, cancelled, permissionDenied, error }。
 * 相册与拍照只通过 sourceType 区分，count 固定 1，避免一次选多张。
 *
 * wx.chooseMedia 与 wx.chooseImage 的官方签名都只接收一个选项对象，
 * success/fail 必须放进这个对象；拆成第二、三个参数时微信不会回调，
 * 页面会一直停在“选择中”，所以这里严格只传一个对象。
 * 两个接口只按存在性选一次：取消或失败都不改投另一个选择器，避免掩盖取消。
 */
function choosePhotoFile(source) {
  return new Promise(resolve => {
    let picker = '';
    const onSuccess = result => {
      const path =
        picker === 'image'
          ? pickPathFromImageResult(result)
          : pickPathFromMediaResult(result);
      if (!hasText(path)) {
        resolve({ ok: false, cancelled: false, error: '选择器没有返回照片路径' });
        return;
      }
      resolve({ ok: true, path });
    };
    const onFail = error => {
      const text = errorText(error);
      resolve({
        ok: false,
        cancelled: /cancel/i.test(text),
        permissionDenied: /auth|permission|deny|authorize/i.test(text),
        error: text
      });
    };

    try {
      if (typeof wx === 'undefined') {
        resolve({
          ok: false,
          cancelled: false,
          error: '当前环境不支持选择照片'
        });
        return;
      }
      const options = {
        count: 1,
        sourceType: [source],
        success: onSuccess,
        fail: onFail
      };
      if (typeof wx.chooseMedia === 'function') {
        picker = 'media';
        options.mediaType = ['image'];
        wx.chooseMedia(options);
        return;
      }
      if (typeof wx.chooseImage === 'function') {
        picker = 'image';
        options.sizeType = ['compressed'];
        wx.chooseImage(options);
        return;
      }
      resolve({ ok: false, cancelled: false, error: '当前环境不支持选择照片' });
    } catch (error) {
      resolve({ ok: false, cancelled: false, error: errorText(error) });
    }
  });
}

function askRemovePhoto() {
  return new Promise(resolve => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      resolve(false);
      return;
    }
    try {
      wx.showModal({
        title: '移除线路照片',
        content:
          '这条线路的主照片只在本机保存一份，移除后需要重新添加。现有场次、尝试和备注不会改变。',
        confirmText: '移除',
        cancelText: '保留',
        success(result) {
          resolve(Boolean(result && result.confirm));
        },
        fail() {
          resolve(false);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}

function askClearCache() {
  return new Promise(resolve => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      resolve(false);
      return;
    }
    try {
      wx.showModal({
        title: '清除可重建缓存？',
        content:
          '只删除可以重新生成的缩略图。线路主照片、照片索引、场次、尝试、备注和待确认操作都会保留；清完后可重建缩略图。',
        confirmText: '清除缓存',
        cancelText: '取消',
        success(result) {
          resolve(Boolean(result && result.confirm));
        },
        fail() {
          resolve(false);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}

function askCleanupOrphans() {
  return new Promise(resolve => {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      resolve(false);
      return;
    }
    try {
      wx.showModal({
        title: '清理无引用文件？',
        content:
          '只删除照片索引和未完成操作都不再引用的本档案照片文件；仍被线路引用的主照片不会被删除。',
        confirmText: '清理',
        cancelText: '取消',
        success(result) {
          resolve(Boolean(result && result.confirm));
        },
        fail() {
          resolve(false);
        }
      });
    } catch (error) {
      resolve(false);
    }
  });
}

function showToast(title) {
  if (typeof wx === 'undefined' || typeof wx.showToast !== 'function') return;
  try {
    wx.showToast({ title, icon: 'none' });
  } catch (error) {
    // 提示失败不影响照片状态。
  }
}

/**
 * 把服务返回统一成页面可渲染的基础状态。
 */
function serviceView(result) {
  if (!result) {
    return { status: 'error', errorText: '照片状态读取失败' };
  }
  if (result.ok) {
    if (!result.photo) return { status: 'none' };
    const photo = result.photo;
    const thumbnail = photo.thumbnail || {};
    const thumbPath = thumbnail.available ? thumbnail.location : '';
    return {
      status: 'saved',
      photoId: photo.photoId,
      mainPath: photo.storage && photo.storage.location,
      thumbnailPath: thumbPath || (photo.storage && photo.storage.location) || '',
      thumbnailAvailable: Boolean(thumbPath),
      width: photo.width,
      height: photo.height,
      bytesText: bytesText(photo)
    };
  }
  if (result.code === 'missing-file' || result.status === 'missing-file') {
    return {
      status: 'missing',
      photoId: result.photo ? result.photo.photoId : '',
      errorText: result.error || '本机照片不可用，可重新添加'
    };
  }
  return {
    status: 'error',
    errorText: result.error || '照片状态读取失败'
  };
}

/**
 * 由基础状态和最上面的用户操作叠加出页面展示状态。
 * 操作状态（预览/保存中/失败）只作用于发起时的 routeId。
 */
function buildView(base, op) {
  const source = base || { status: 'loading' };
  const view = {
    status: 'loading',
    statusText: '',
    errorText: '',
    photoId: source.photoId || '',
    mainPath: source.mainPath || '',
    thumbnailPath: source.thumbnailPath || '',
    // 缩略图是可重建缓存：清缓存/被系统清理后为 false，主图仍可用。
    thumbnailAvailable: Boolean(source.thumbnailAvailable),
    previewPath: '',
    bytesText: source.bytesText || '',
    hasPhoto: source.status === 'saved',
    missing: source.status === 'missing',
    canPreview: false,
    removeVisible: false,
    retryVisible: false,
    retryText: '',
    dismissVisible: false,
    sourceVisible: false,
    reloadVisible: false,
    cameraText: '拍照',
    albumText: '从相册选择',
    listActionText: '加照片',
    busy: false,
    // 容量不足时页面显示原因与“管理照片空间”入口；仍保留重试。
    spaceIssue: false,
    manageSpaceVisible: false,
    manageSpaceText: '管理照片空间'
  };

  const phase = op ? op.phase : source.status;

  if (!op) {
    if (source.status === 'saved') {
      view.status = 'saved';
      view.statusText = '照片保存在本机';
      view.canPreview = Boolean(view.mainPath);
      view.removeVisible = true;
      view.sourceVisible = true;
      view.cameraText = '拍照更换';
      view.albumText = '从相册更换';
      view.listActionText = '换照片';
      return view;
    }
    if (source.status === 'missing') {
      view.status = 'missing';
      view.statusText = '本机照片不可用，可重新添加';
      view.errorText = source.errorText || '';
      view.sourceVisible = true;
      view.cameraText = '重新拍照';
      view.albumText = '从相册重新添加';
      view.listActionText = '重新添加';
      return view;
    }
    if (source.status === 'error') {
      view.status = 'error';
      view.statusText = source.errorText || '照片状态读取失败';
      view.errorText = source.errorText || '';
      view.reloadVisible = true;
      view.listActionText = '照片';
      return view;
    }
    if (source.status === 'none') {
      view.status = 'none';
      view.statusText = '添加线路照片（可选，可稍后添加）';
      view.sourceVisible = true;
      view.listActionText = '加照片';
      return view;
    }
    view.status = 'loading';
    view.statusText = '照片读取中…';
    view.listActionText = '照片';
    return view;
  }

  if (phase === 'preview') {
    view.status = 'preview';
    view.previewPath = op.sourcePath || '';
    view.statusText = view.hasPhoto
      ? '已选新照片，确认后替换现有照片'
      : '已选照片，确认后保存到本机';
    view.listActionText = '预览中';
    view.busy = true;
    return view;
  }

  if (phase === 'saving') {
    view.status = 'saving';
    view.statusText =
      op.kind === 'remove' ? '正在移除照片…' : '照片保存中…';
    view.canPreview = view.hasPhoto && Boolean(view.mainPath);
    view.listActionText = '保存中';
    view.busy = true;
    return view;
  }

  view.status = 'failed';
  view.errorText = op.error || '照片操作失败';
  view.retryVisible = true;
  view.dismissVisible = true;
  view.busy = false;
  view.spaceIssue = op.code === 'space-insufficient';
  view.manageSpaceVisible = view.spaceIssue;

  if (op.kind === 'remove') {
    if (op.associationRemoved) {
      view.hasPhoto = false;
      view.statusText = '照片已从线路移除，但本机文件未清理';
      view.retryText = '重试清理';
      view.listActionText = '重新添加';
      view.sourceVisible = true;
      view.cameraText = '重新拍照';
      view.albumText = '从相册重新添加';
    } else {
      view.statusText = '移除失败，原照片保留';
      view.retryText = '重试移除';
      view.listActionText = '移除失败';
    }
    return view;
  }

  view.sourceVisible = true;
  view.retryText = '重试保存';
  if (view.hasPhoto) {
    view.statusText = view.spaceIssue
      ? '照片空间不足，新照片未保存，旧照片仍可用'
      : '新照片保存失败，旧照片仍可用';
    view.canPreview = Boolean(view.mainPath);
    view.cameraText = '拍照更换';
    view.albumText = '从相册更换';
    view.listActionText = '重试保存';
  } else {
    view.statusText = view.spaceIssue ? '照片空间不足，未保存' : '照片保存失败';
    view.listActionText = '重试';
  }
  return view;
}

/**
 * 照片空间卡片视图：占用、提醒线、预算与管理入口。
 * 所有数字来自实际文件计量结果（本档案目录），不用单张照片估值。
 */
function buildSpaceView(result) {
  if (!result) {
    return {
      status: 'loading',
      usageText: '统计中…',
      percent: 0,
      warn: false,
      over: false,
      warningText: '',
      detailText: '',
      missingThumbText: '',
      orphanText: '',
      errorText: ''
    };
  }
  if (!result.ok) {
    return {
      status: 'error',
      usageText: '暂时无法统计',
      percent: 0,
      warn: false,
      over: false,
      warningText: '',
      detailText: '',
      missingThumbText: '',
      orphanText: '',
      errorText: result.error || '照片空间统计失败'
    };
  }

  const policy = result.policy || {};
  const warn = result.warn === true;
  const over = result.overBudget === true;
  let warningText = '';
  if (over) {
    warningText =
      '照片占用已超过可保存预算 ' +
      formatBytes(policy.budgetBytes) +
      '；新增或更换会被阻止，已有照片、场次和尝试不受影响。可清除可重建缓存或移除照片后再试。';
  } else if (warn) {
    warningText =
      '照片占用已达到提醒线 ' +
      formatBytes(policy.warnBytes) +
      '；请在需要时管理照片空间。';
  }

  const missingThumbText = result.missingThumbs && result.missingThumbs.length
    ? '有 ' + result.missingThumbs.length + ' 张缩略图缺失，可从主图重建'
    : '';
  const orphanText = result.orphanBytes > 0
    ? '无引用文件占用 ' + formatBytes(result.orphanBytes)
    : '';

  return {
    status: 'ready',
    usageText:
      formatBytes(result.totalBytes) +
      ' / ' +
      formatBytes(policy.budgetBytes),
    percent: result.percent || 0,
    warn,
    over,
    warningText,
    totalBytes: result.totalBytes || 0,
    mainBytes: result.mainBytes || 0,
    thumbBytes: result.thumbBytes || 0,
    fileCount: result.fileCount || 0,
    photoCount: result.photoCount || 0,
    detailText:
      result.photoCount +
      ' 张照片 · 主图 ' +
      formatBytes(result.mainBytes) +
      (result.thumbBytes > 0
        ? ' · 缩略图 ' + formatBytes(result.thumbBytes)
        : '') +
      ' · 文件 ' +
      result.fileCount +
      ' 个',
    archiveText: '本机档案 ' + result.photoCount + ' 张照片',
    missingThumbText,
    orphanText,
    missingThumbCount:
      (result.missingThumbs && result.missingThumbs.length) || 0,
    orphanBytes: result.orphanBytes || 0,
    budgetBytes: policy.budgetBytes || 0,
    warnBytes: policy.warnBytes || 0,
    reserveBytes: policy.reserveBytes || 0,
    budgetText: formatBytes(policy.budgetBytes),
    warnText: formatBytes(policy.warnBytes),
    reserveText: formatBytes(policy.reserveBytes),
    errorText: ''
  };
}

// ---------------------------------------------------------------- 服务入口
//
// 页面只通过这里取得照片服务，避免各自拼接档案 ID：
// - 档案 ID 来自 T016 本机档案；同一档案共享一个服务实例，
//   recover() 每个实例只执行一次，防止从场内页进入详情页时把另一个页面
//   正在保存的操作中止；
// - 档案更换（重置本机档案）时显式放弃旧档案未完成的照片操作：
//   页面已经丢弃旧档案上下文，迟到回调不应再写入旧档案；
// - 服务只读写正式照片索引与本档案的专用照片目录，不碰场次/尝试档案。

let active = null;
let spacePolicy = null;

/**
 * 全页共享的“照片操作进行中”登记（仅内存）。
 *
 * 场内页与详情页各有一个控制器实例，但它们用的是同一份本机档案与照片目录。
 * 个人页清缓存必须先知道“别处正在写照片”，否则可能删掉正在写入的缩略图。
 * 这里按 opId 记录真实发起的保存/移除，promise 结束后移除。
 */
const activeOperations = new Set();

function trainingPhotoOperationInFlight() {
  return activeOperations.size > 0;
}

/**
 * 照片预算默认取正式版集中常量；这里只允许测试注入小数值，
 * 不提供页面入口修改，避免把“可保存张数”变成用户可随意放宽的承诺。
 */
function setTrainingPhotoSpacePolicy(policy) {
  spacePolicy = policy && typeof policy === 'object'
    ? Object.assign({}, policy)
    : null;
  // 已创建的服务仍持有旧预算；下一次 open 时重建。这里不删除任何照片或索引。
  active = null;
}

function getTrainingPhotoSpacePolicy() {
  return spacePolicy ? Object.assign({}, spacePolicy) : null;
}

/**
 * 为一份本机档案创建照片服务；文件适配器绑定该档案的目录。
 * wxApi / userDataPath / space 只在测试与宿主注入时提供。
 */
function createTrainingPhotoServiceFor(archiveId, options) {
  const config = options || {};
  return createTrainingPhotoService({
    archiveId,
    files: createWxTrainingPhotoFiles({
      archiveId,
      wxApi: config.wxApi,
      userDataPath: config.userDataPath
    }),
    space: config.space || spacePolicy || undefined
  });
}

/**
 * 取得当前档案的服务与首次恢复结果。
 * 档案变化时先显式放弃旧档案未完成的操作，再重建服务；
 * recover() 只在该档案服务首次打开时执行一次。
 */
function openTrainingPhotos(archiveId) {
  const target = hasText(archiveId) ? archiveId : '';
  if (!active || active.archiveId !== target) {
    if (active) {
      // 更换档案：旧页面的迟到回调不再属于当前上下文。
      // 这里只中止旧档案自己的未完成操作，不影响其他档案或运行期。
      active.service.abandonStartedOperations();
    }
    active = {
      archiveId: target,
      service: createTrainingPhotoServiceFor(target),
      ready: null
    };
  }
  if (!active.ready) {
    active.ready = active.service.recover();
  }
  return { service: active.service, ready: active.ready, archiveId: active.archiveId };
}

/**
 * 释放共享实例；重置本机档案或离线测试之间调用。
 * 不删除任何照片文件或索引。
 */
function resetTrainingPhotos() {
  active = null;
}

function createTrainingPhotoController(page, options) {
  const config = options || {};
  const onChange = config.onChange || function noop() {};
  const onNotice = config.onNotice || function noop() {};

  let service = null;
  let currentArchiveId = '';
  let ready = null;
  // 档案更换或清空页面状态时递增；旧回调据此失效，不把旧照片写进新档案视图。
  let generation = 0;
  let spaceState = null;
  const views = {};
  const ops = {};
  const seqs = {};
  const inflight = {};

  function alive() {
    return Boolean(page) && !page._unloaded;
  }

  function notify(text, toastText) {
    if (!alive()) return;
    if (text) onNotice(text, { toast: toastText || '' });
    if (toastText) showToast(toastText);
  }

  function clearState() {
    generation += 1;
    spaceState = null;
    Object.keys(views).forEach(key => delete views[key]);
    Object.keys(ops).forEach(key => delete ops[key]);
    Object.keys(seqs).forEach(key => delete seqs[key]);
    Object.keys(inflight).forEach(key => delete inflight[key]);
  }

  /**
   * 当前照片服务的档案 ID：来自本机档案。没有落盘档案（首次启动、档案损坏）
   * 时不创建服务，也不写任何照片文件或索引，页面显示可见原因。
   */
  function resolveArchiveId() {
    const loaded = store.loadState();
    if (!loaded.ok) {
      return { archiveId: '', error: loaded.error || '本机训练档案不可读' };
    }
    if (!loaded.present) {
      return {
        archiveId: '',
        error: '还没有本机训练档案，请先开始一场训练再添加照片'
      };
    }
    return { archiveId: loaded.archive.archiveId, error: '' };
  }

  function init() {
    const resolved = resolveArchiveId();
    if (!resolved.archiveId) {
      if (service) clearState();
      service = null;
      currentArchiveId = '';
      ready = Promise.resolve({
        ok: false,
        code: 'no-archive',
        error: resolved.error
      });
      return ready;
    }
    const target = resolved.archiveId;
    if (service && currentArchiveId === target) return ready;
    if (service) clearState();
    const opened = openTrainingPhotos(target);
    service = opened.service;
    currentArchiveId = opened.archiveId;
    ready = Promise.resolve(opened.ready).then(
      result => {
        if (
          result &&
          result.ok === false &&
          (result.code === 'index-broken' ||
            result.code === 'index-read-failed' ||
            result.code === 'index-write-failed')
        ) {
          notify(result.error || '照片索引不可用，已保存照片未被重建', '');
        }
        return result;
      },
      error => {
        notify('照片服务初始化失败：' + errorText(error), '');
        return { ok: false, error: errorText(error) };
      }
    );
    return ready;
  }

  function bumpSeq(routeId) {
    seqs[routeId] = (seqs[routeId] || 0) + 1;
  }

  function loadOne(routeId) {
    if (!service || !hasText(routeId)) return Promise.resolve();
    const seq = (seqs[routeId] || 0) + 1;
    seqs[routeId] = seq;
    return Promise.resolve(service.getRoutePhoto({ routeId })).then(
      result => {
        if (!alive() || seqs[routeId] !== seq) return;
        views[routeId] = serviceView(result);
        // 文件已缺失时清掉旧的“已保存到本机”提示，避免看起来仍可查看。
        if (views[routeId].status === 'missing' && !ops[routeId]) {
          onNotice('');
        }
        onChange();
      },
      error => {
        if (!alive() || seqs[routeId] !== seq) return;
        views[routeId] = {
          status: 'error',
          errorText: '读取照片状态失败：' + errorText(error)
        };
        onChange();
      }
    );
  }

  function load(routeIds) {
    if (!service) return Promise.resolve();
    const ids = Array.isArray(routeIds)
      ? routeIds.filter(id => hasText(id))
      : [];
    return Promise.resolve(ready).then(() =>
      Promise.all(ids.map(routeId => loadOne(routeId)))
    );
  }

  function view(routeId) {
    return buildView(views[routeId], ops[routeId]);
  }

  /**
   * 发起异步用户交互前固定上下文（服务实例 + 档案 + 代次）。
   * 原生选择器、确认弹窗和异步读取都可能晚于重置/换档/切页返回，
   * 旧回调必须按发起时的上下文校验，不能把旧操作绑到新档案上。
   */
  function captureContext() {
    return {
      service,
      archiveId: currentArchiveId,
      generation
    };
  }

  function isContextCurrent(context) {
    return Boolean(context) && context.service === service &&
      context.archiveId === currentArchiveId &&
      context.generation === generation;
  }

  function hasStoredPhoto(routeId) {
    const base = views[routeId];
    return Boolean(
      base && (base.status === 'saved' || base.status === 'missing')
    );
  }

  function hasActiveOperation() {
    // 别处（另一个页面实例）正在保存/移除时，本实例同样不能清缓存或清理文件。
    if (activeOperations.size > 0) return true;
    if (Object.keys(inflight).length > 0) return true;
    return Object.keys(ops).some(key => ops[key].phase === 'saving');
  }

  function choose(routeId, source) {
    if (!service) {
      return Promise.resolve({ ok: false, error: '照片服务未初始化' });
    }
    if (source !== 'camera' && source !== 'album') {
      return Promise.resolve({ ok: false, error: '未知的照片来源' });
    }
    const current = ops[routeId];
    if (current && current.phase === 'saving') {
      notify('照片正在保存，请稍后再选', '');
      return Promise.resolve({ ok: false, error: '照片正在保存' });
    }

    // 选择器是异步的原生调用：在打开前就固定档案/代次，
    // 期间发生重置或换档后丢弃这次选择，不把旧结果当成新档案的操作。
    const context = captureContext();
    return choosePhotoFile(source).then(outcome => {
      if (!alive()) return outcome;
      if (!outcome.ok) {
        if (!outcome.cancelled) {
          const label = source === 'camera' ? '拍照' : '相册';
          notify(
            outcome.permissionDenied
              ? '未获得' + label + '权限，可改用另一种方式或稍后添加'
              : '选择照片失败：' + outcome.error,
            ''
          );
        }
        return outcome;
      }
      if (!isContextCurrent(context)) {
        return {
          ok: false,
          staleContext: true,
          cancelled: false,
          error: '本机档案或线路已变化，已放弃这次选择'
        };
      }
      ops[routeId] = {
        phase: 'preview',
        kind: hasStoredPhoto(routeId) ? 'replace' : 'add',
        opId: makeOpId(),
        sourcePath: outcome.path,
        archiveId: currentArchiveId,
        generation
      };
      onChange();
      return outcome;
    });
  }

  /**
   * 旧档案/已清空状态的迟到回调直接丢弃：
   * 不回写视图、不提示“已保存”、不触发新的照片读取。
   */
  function isStaleOperation(routeId, op) {
    if (!op) return true;
    if (op.archiveId !== currentArchiveId) return true;
    if (op.generation !== generation) return true;
    return ops[routeId] !== op;
  }

  function handleResult(routeId, op, result) {
    delete inflight[op.opId];
    if (!alive()) return result;
    if (isStaleOperation(routeId, op)) return result;
    bumpSeq(routeId);

    if (result && result.ok) {
      delete ops[routeId];
      if (op.kind === 'remove') {
        views[routeId] = { status: 'none' };
        onChange();
        notify('照片已移除，可重新添加。', '已移除');
        return refreshSpace().then(() => result);
      }
      views[routeId] = serviceView({
        ok: true,
        photo: Object.assign({}, result.photo, {
          thumbnail: {
            available: Boolean(result.thumbnail && result.thumbnail.location),
            location: result.thumbnail ? result.thumbnail.location : '',
            bytes: result.thumbnail ? result.thumbnail.bytes : 0
          }
        })
      });
      onChange();
      notify('已保存到本机', '已保存到本机');
      return loadOne(routeId)
        .then(() => refreshSpace())
        .then(() => result, () => result);
    }

    if (op.kind === 'remove' && result && result.associationRemoved) {
      views[routeId] = { status: 'none' };
      op.phase = 'failed';
      op.associationRemoved = true;
      op.code = (result && result.code) || '';
      op.error = result.error || '照片文件删除失败';
      onChange();
      notify(
        '照片已从线路移除，但本机文件未清理；可点「重试清理」。',
        ''
      );
      return refreshSpace().then(() => result);
    }

    const code = result && result.code;
    if (
      code === 'already-has-photo' ||
      code === 'stale-operation' ||
      code === 'no-photo'
    ) {
      delete ops[routeId];
      notify(
        (result && result.error) || '照片状态已更新，正在重新读取。',
        ''
      );
      onChange();
      return loadOne(routeId)
        .then(() => refreshSpace())
        .then(() => result, () => result);
    }

    op.phase = 'failed';
    op.associationRemoved = false;
    op.code = (result && result.code) || '';
    op.error =
      (result && result.error) || '照片操作失败，可重试';
    onChange();
    notify(
      op.kind === 'remove'
        ? '移除失败，原照片仍保留；可重试。'
        : '照片保存失败，可重试；已有的线路和尝试记录不受影响。',
      ''
    );
    return loadOne(routeId)
      .then(() => refreshSpace())
      .then(() => result, () => result);
  }

  function runOp(routeId, op) {
    op.phase = 'saving';
    op.error = '';
    op.code = '';
    op.associationRemoved = false;
    if (alive()) onNotice('', { toast: '' });
    onChange();

    let request;
    if (op.kind === 'remove') {
      request = service.removePhoto({ routeId, opId: op.opId });
    } else if (op.kind === 'replace') {
      request = service.replacePhoto({
        routeId,
        sourcePath: op.sourcePath,
        opId: op.opId
      });
    } else {
      request = service.addPhoto({
        routeId,
        sourcePath: op.sourcePath,
        opId: op.opId
      });
    }

    const tracked = Promise.resolve(request).then(
      result => handleResult(routeId, op, result || {}),
      error =>
        handleResult(routeId, op, {
          ok: false,
          code: 'unexpected',
          error: errorText(error)
        })
    );
    inflight[op.opId] = tracked;
    activeOperations.add(op.opId);
    const done = () => {
      activeOperations.delete(op.opId);
    };
    tracked.then(done, done);
    return tracked;
  }

  /**
   * 新建线路时已在表单里预览过照片：线路创建成功后直接进入同一个确认流程。
   * 照片失败不回滚已创建的线路。返回本次发起的操作（没有则 null）。
   */
  function beginPreview(routeId, sourcePath) {
    if (!service || !hasText(routeId) || !hasText(sourcePath)) return null;
    const op = {
      phase: 'preview',
      kind: hasStoredPhoto(routeId) ? 'replace' : 'add',
      opId: makeOpId(),
      sourcePath,
      archiveId: currentArchiveId,
      generation
    };
    ops[routeId] = op;
    onChange();
    return op;
  }

  function confirm(routeId) {
    const op = ops[routeId];
    if (!op || op.phase !== 'preview') return Promise.resolve(null);
    return runOp(routeId, op);
  }

  function retry(routeId) {
    const op = ops[routeId];
    if (!op || op.phase !== 'failed') return Promise.resolve(null);
    return runOp(routeId, op);
  }

  function cancelPreview(routeId) {
    const op = ops[routeId];
    if (!op || op.phase !== 'preview') return;
    delete ops[routeId];
    onChange();
  }

  function dismiss(routeId) {
    const op = ops[routeId];
    if (!op || op.phase !== 'failed') return;
    delete ops[routeId];
    onChange();
  }

  function remove(routeId) {
    if (!hasStoredPhoto(routeId)) return Promise.resolve(null);
    const current = ops[routeId];
    if (current && current.phase === 'saving') {
      notify('照片正在处理，请稍后再移除', '');
      return Promise.resolve(null);
    }
    // 确认弹窗期间可能发生换档：按发起时上下文校验，旧确认不作用于新档案。
    const context = captureContext();
    return askRemovePhoto().then(confirmed => {
      if (!confirmed || !alive()) return null;
      if (!isContextCurrent(context)) return null;
      const op = {
        phase: 'saving',
        kind: 'remove',
        opId: makeOpId(),
        sourcePath: '',
        archiveId: currentArchiveId,
        generation
      };
      ops[routeId] = op;
      return runOp(routeId, op);
    });
  }

  function preview(routeId) {
    const current = view(routeId);
    if (!current.canPreview || !hasText(current.mainPath)) {
      if (current.status === 'missing') {
        notify('本机照片不可用，可重新添加', '');
      }
      return;
    }
    if (typeof wx === 'undefined' || typeof wx.previewImage !== 'function') {
      return;
    }
    try {
      wx.previewImage({
        current: current.mainPath,
        urls: [current.mainPath]
      });
    } catch (error) {
      // 预览失败不影响已保存照片。
    }
  }

  function countPhotos() {
    if (!service) {
      return Promise.resolve({ ok: true, photos: [] });
    }
    return Promise.resolve(ready).then(
      () => service.listPhotos(),
      () => ({ ok: false, photos: [] })
    );
  }

  function refreshSpace() {
    if (!service) {
      spaceState = null;
      return Promise.resolve(null);
    }
    return Promise.resolve(ready)
      .then(() => service.getSpaceUsage())
      .then(
        result => {
          spaceState = result;
          if (alive()) onChange();
          return result;
        },
        error => {
          spaceState = {
            ok: false,
            error: '照片空间统计失败：' + errorText(error)
          };
          if (alive()) onChange();
          return spaceState;
        }
      );
  }

  function spaceView() {
    return buildSpaceView(spaceState);
  }

  function reloadKnownPhotos() {
    return load(Object.keys(views));
  }

  /**
   * 普通清缓存：只清可重建缩略图。保存中拒绝执行，避免误删正在写入的文件。
   * 完成后重新读取已展示线路，主图仍可预览、列表回退到主图路径。
   * 页面可传入 { confirm: false } 表示确认由调用方（例如个人页的弹窗）完成。
   */
  function clearCache(options) {
    const opts = options || {};
    if (!service) {
      return Promise.resolve({ ok: false, error: '照片服务未初始化' });
    }
    if (hasActiveOperation()) {
      notify('照片正在保存或移除，请稍后再清除缓存', '');
      // busy 让调用方（个人页清缓存）能区分“这次没做”与“做了但没成功”：
      // 照片操作进行中时不得顺手清掉本机缓存键。
      return Promise.resolve({ ok: false, busy: true, error: '照片操作进行中' });
    }
    const context = captureContext();
    const confirmStep =
      opts.confirm === false ? Promise.resolve(true) : askClearCache();
    return confirmStep.then(confirmed => {
      if (!confirmed || !alive()) {
        return { ok: false, cancelled: true };
      }
      if (!isContextCurrent(context)) {
        return {
          ok: false,
          staleContext: true,
          error: '本机档案已更换，已取消这次清除缓存'
        };
      }
      return service.clearRebuildableCache().then(
        result => {
          const finish = reloadKnownPhotos().then(
            () => refreshSpace()
          );
          return finish.then(() => {
            if (result && result.ok) {
              notify(
                '已清除可重建缓存；主图、照片关联、场次和尝试均未改变。',
                '已清除缓存'
              );
            } else {
              notify(
                (result && result.error) ||
                  '清除缓存未完全成功，可重试或查看无引用文件。',
                ''
              );
            }
            return result;
          });
        },
        error => {
          const result = {
            ok: false,
            error: '清除缓存失败：' + errorText(error)
          };
          notify(result.error, '');
          return result;
        }
      );
    });
  }

  function rebuildThumbs() {
    if (!service) {
      return Promise.resolve({ ok: false, error: '照片服务未初始化' });
    }
    if (hasActiveOperation()) {
      notify('照片正在保存或移除，请稍后再重建缩略图', '');
      return Promise.resolve({ ok: false, error: '照片操作进行中' });
    }
    const context = captureContext();
    return service.rebuildMissingThumbnails().then(
      result => {
        const finish = reloadKnownPhotos().then(() => refreshSpace());
        return finish.then(() => {
          // 换档期间完成的旧重建只回报结果，不往新上下文提示。
          if (!isContextCurrent(context)) return result;
          if (result && result.ok) {
            notify(
              result.rebuiltCount > 0
                ? '已从主图重建 ' + result.rebuiltCount + ' 张缩略图。'
                : '所有缩略图都已存在，无需重建。',
              ''
            );
          } else {
            notify(
              (result && result.error) ||
                '部分缩略图未能重建；主图未受影响，可稍后重试。',
              ''
            );
          }
          return result;
        });
      },
      error => {
        const result = {
          ok: false,
          error: '重建缩略图失败：' + errorText(error)
        };
        notify(result.error, '');
        return result;
      }
    );
  }

  function cleanupOrphans() {
    if (!service) {
      return Promise.resolve({ ok: false, error: '照片服务未初始化' });
    }
    if (hasActiveOperation()) {
      notify('照片正在保存或移除，请稍后再清理无引用文件', '');
      return Promise.resolve({ ok: false, error: '照片操作进行中' });
    }
    const context = captureContext();
    return askCleanupOrphans().then(confirmed => {
      if (!confirmed || !alive()) {
        return { ok: false, cancelled: true };
      }
      if (!isContextCurrent(context)) {
        return {
          ok: false,
          staleContext: true,
          error: '本机档案已更换，已取消这次清理'
        };
      }
      return service.cleanupOrphans().then(
        result => {
          const finish = reloadKnownPhotos().then(() => refreshSpace());
          return finish.then(() => {
            if (result && result.ok) {
              notify(
                result.deleted && result.deleted.length
                  ? '已清理 ' + result.deleted.length + ' 个无引用文件。'
                  : '没有发现可清理的无引用文件。',
                ''
              );
            } else {
              notify(
                (result && result.error) ||
                  '无引用文件未完全清理，可重试。',
                ''
              );
            }
            return result;
          });
        },
        error => {
          const result = {
            ok: false,
            error: '清理无引用文件失败：' + errorText(error)
          };
          notify(result.error, '');
          return result;
        }
      );
    });
  }

  /**
   * 清空页面上的照片展示；不删除照片文件或索引。
   * generation 递增后，清空前发出的照片回调不会再写回页面。
   */
  function clear() {
    clearState();
    onChange();
  }

  return {
    init,
    load,
    view,
    hasStoredPhoto,
    hasActiveOperation,
    captureContext,
    isContextCurrent,
    choose,
    beginPreview,
    confirm,
    retry,
    cancelPreview,
    dismiss,
    remove,
    preview,
    countPhotos,
    refreshSpace,
    spaceView,
    clearCache,
    rebuildThumbs,
    cleanupOrphans,
    clear,
    pickFile: choosePhotoFile,
    getService() {
      return service;
    },
    getArchiveId() {
      return currentArchiveId;
    }
  };
}

module.exports = {
  createTrainingPhotoController,
  buildView,
  buildSpaceView,
  openTrainingPhotos,
  resetTrainingPhotos,
  createTrainingPhotoServiceFor,
  setTrainingPhotoSpacePolicy,
  getTrainingPhotoSpacePolicy,
  // 供个人页等需要跨页面判断“照片正在写”的入口使用。
  trainingPhotoOperationInFlight
};
