/**
 * 个人中心页面
 * 显示用户基础信息和关于小程序
 *
 * T019：本页的「清除缓存」是照片可重建缓存的清理入口。
 * - 先让照片服务清掉可重新生成的缩略图文件与缩略图元数据；照片操作进行中时
 *   拒绝执行，并且此时不清理任何本机缓存键；
 * - 再按 T016 的口径清本机命名空间里明确标记为可重建的键；
 * - 本机训练档案、线路主照片索引、仍被引用的原图、场次、把次与备注都保留，
 *   命名空间外的键（旧试用工程、旧云缓存）也一律不动。
 *
 * T020：本页新增「体能自测」入口（pages/fitness-test）。自测记录存在独立命名空间
 * `climbingNote.fitness.v1.`，不是可重建缓存，因此上面的清缓存同样不会清掉它；
 * 本页不读也不写自测记录，只做跳转。
 *
 * T026：逐把视频的独立索引在正式本机命名空间（`climbingNote.training.v1.attempt-video`），
 * 属于受保护键；视频副本写在 USER_DATA_PATH 下的档案专属目录，不属于照片可重建缓存。
 * 因此普通清缓存不会删除已关联的视频（含撤回后待恢复的把次对应副本），页面提示里
 * 一并说明本机训练记录、线路照片与逐把视频都会保留。
 *
 * T059：意见反馈改为显式剪贴板交付，不再假装已经发送。用户确认反馈内容后只发出一次
 * `wx.setClipboardData({ data, success, fail })`：原生成功回调显示「已复制」；原生失败
 * 不显示成功提示，保留刚输入的文字并在菜单里提供「点此重试」；取消不写剪贴板也不写
 * 存储。每次反馈或重试都递增操作序号，迟到的旧弹窗/剪贴板回执不能覆盖新操作。
 *
 * T066：资料入口改称「设置头像昵称」，只表达微信头像昵称在本页显示的能力：
 * 不登录、不创建账号、不写存储，也不承诺跨设备同步。读取成功、用户拒绝与读取失败
 * 各有独立的页面内存状态，和意见反馈的复制草稿/失败态互不覆盖。
 *
 * T068：在既有个人页内交付文本备份。导出只生成文字并留给用户显式复制/自行保存；
 * 导入必须在有界输入框里重新粘贴，先预演核对数量，再用独立弹窗明确确认。
 * 取消、改动输入、离开页面或迟到的旧回执都不写档案；提交后回读未通过的恢复不引导
 * 原样重试，而是要求先导出诊断、重新检查后重新确认。照片、视频、时间点与操作日志
 * 始终不进入备份文本，已有媒体保持旧档案归属。
 */
const app = getApp();
const trainingStore = require('../../utils/training-store.js');
const trainingBackup = require('../../utils/training-backup.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

// 只用于把「复制失败」分成「文档较大，剪贴板可能放不下」和普通失败两种提示。
// 它不是微信剪贴板硬上限，也不是产品承诺；实际能否复制仍以原生回调为准。
const LARGE_CLIPBOARD_BYTES = 256 * 1024;

function formatBackupBytes(bytes) {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '0 KB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function backupSummaryText(summary) {
  if (!summary || typeof summary !== 'object') return '';
  return (
    summary.sessions +
    ' 场 · ' +
    summary.routes +
    ' 条线路 · ' +
    summary.attempts +
    ' 把 · ' +
    summary.notes +
    ' 条备注 · 清单 ' +
    summary.wishlistActive +
    ' 条'
  );
}

Page({
  data: {
    userInfo: null,
    hasUserInfo: false,
    // T066：资料读取结果只在本页说明当前能力，独立于意见反馈的复制状态。
    profileNotice: '',
    profileNoticeKind: '',
    // T059：复制失败时保留的用户文字；只在页面内存里，供「点此重试」再次复制。
    feedbackDraft: '',
    feedbackCopyFailed: false,
    // T068：文本备份全部只在页面内存里流转；导出文本与导入原文都不写本机额外存储。
    backupNotice: '',
    backupNoticeKind: '',
    backupExportText: '',
    backupExportMeta: '',
    backupCopyFailed: false,
    backupCopyFailureKind: '',
    backupCopyIssueText: '',
    backupImportText: '',
    // 有界输入：最大字符数按备份核心的字节护栏设置；UTF-8 字节数只会不少于字符数，
    // 因此这个上限不会提前拒绝核心本来允许的文本。
    backupImportMaxLength: trainingBackup.MAX_BACKUP_BYTES,
    backupPreview: null,
    backupDiagnosticsText: '',
    backupDiagnosticsMeta: '',
    backupDiagnosticsCopyFailed: false,
    backupDiagnosticsCopyFailureKind: '',
    backupDiagnosticsCopyIssueText: ''
  },

  onLoad() {
    // 备份操作序号只在本页内存里：复制回执、确认弹窗都按发起时的序号核对。
    this._backupCopyOp = 0;
    this._restoreOp = 0;
    this._backupPreviewText = '';

    // 检查是否已获取用户信息
    if (app.globalData.userInfo) {
      this.setData({
        userInfo: app.globalData.userInfo,
        hasUserInfo: true
      });
    }
    // 只用于本页清缓存：不选图、不更换、不改任何照片关联。
    this._photoUi = null;
    this.initPhotoUi();
  },

  /**
   * 离开页面（含切到其他 tab）时放弃未完成的备份操作：
   * 预演令牌失效，确认弹窗与剪贴板的迟到回执都不再改本页状态。零存储写入。
   */
  onHide() {
    this.abortBackupTransient();
  },

  onUnload() {
    this.abortBackupTransient(false);
  },

  initPhotoUi() {
    if (!this._photoUi) {
      this._photoUi = createTrainingPhotoController(this, {
        onChange: () => {},
        onNotice: () => {}
      });
    }
    return Promise.resolve(this._photoUi.init());
  },

  /**
   * 获取用户信息（T066）
   *
   * 只从微信读取头像昵称，作为本页/本机内存里的显示资料：不登录、不创建账号、
   * 不写存储，也不承诺跨设备同步。拒绝与读取失败只在资料区域说明，且不触碰
   * 意见反馈的草稿和复制失败态；成功也不清除反馈状态。
   */
  getUserProfile() {
    const showProfileFailure = (err) => {
      const errMsg = err && typeof err.errMsg === 'string' ? err.errMsg : '';
      const denied = /deny|cancel/i.test(errMsg);
      this.setData({
        profileNoticeKind: denied ? 'denied' : 'failed',
        profileNotice: denied
          ? '已取消，头像昵称未更新；不影响意见反馈与训练记录。'
          : '头像昵称读取失败，请再点「设置头像昵称」重试；不影响意见反馈与训练记录。'
      });
    };

    if (typeof wx.getUserProfile !== 'function') {
      showProfileFailure({ errMsg: 'getUserProfile:fail unavailable' });
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      return true;
    };

    try {
      wx.getUserProfile({
        desc: '用于完善个人资料',
        success: (res) => {
          if (!settle()) return;
          const userInfo = res && res.userInfo ? res.userInfo : null;
          if (!userInfo) {
            showProfileFailure({ errMsg: 'getUserProfile:fail empty' });
            return;
          }
          app.globalData.userInfo = userInfo;
          this.setData({
            userInfo,
            hasUserInfo: true,
            profileNotice: '',
            profileNoticeKind: ''
          });
        },
        fail: (err) => {
          if (!settle()) return;
          showProfileFailure(err);
        }
      });
    } catch (err) {
      if (!settle()) return;
      showProfileFailure({ errMsg: (err && err.message) || 'getUserProfile:fail' });
    }
  },

  /**
   * 跳转到 9c 攀岩体能自测页（T020）
   * 只做跳转：不读、不写自测记录，也不动本机训练档案与照片。
   */
  goToFitnessTest() {
    wx.navigateTo({
      url: '/pages/fitness-test/fitness-test'
    });
  },

  /**
   * 跳转到关于页面
   */
  goToAbout() {
    wx.showModal({
      title: '关于攀笔',
      content: '攀笔是一款简洁的攀岩记录小程序，帮助你记录每一次攀登。\n\n版本：1.0.0',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 清除缓存
   *
   * T016：普通清缓存只清可重建的派生缓存，不再整片清空微信本地存储。
   * T019：先清照片的可重建缩略图（文件与元数据），再清本机命名空间里的可重建键。
   * 本机训练档案、线路主照片索引、正在进行的操作、被引用的原图以及命名空间外的
   * 其他键（旧试用工程、旧云缓存）都保持原样。
   */
  clearCache() {
    wx.showModal({
      title: '提示',
      content: '确定要清除缓存吗？本机训练记录、线路照片与逐把视频不会被清除。',
      success: (res) => {
        if (!res.confirm) return;
        this.clearCacheConfirmed();
      }
    });
  },

  clearCacheConfirmed() {
    const photoStep = this._photoUi
      ? this._photoUi.clearCache({ confirm: false })
      : Promise.resolve({ ok: true });

    return Promise.resolve(photoStep).then(result => {
      // 照片正在保存或移除：这次什么都不清，避免删到正在写入的文件。
      if (result && result.busy) {
        wx.showToast({ title: '照片正在保存，稍后再清', icon: 'none' });
        return result;
      }

      const outcome = trainingStore.clearRebuildableStorage();
      if (!outcome.ok) {
        wx.showToast({ title: '清除失败', icon: 'none' });
        return outcome;
      }

      // 还没有本机档案时照片服务未初始化，这类“没得清”不算清理失败。
      const photoServiceReady = Boolean(this._photoUi && this._photoUi.getService());
      const photoFailed = photoServiceReady && Boolean(result && result.ok === false);
      wx.showToast({
        title: photoFailed ? '已清缓存，缩略图未清完' : '清除成功',
        icon: photoFailed ? 'none' : 'success'
      });
      return outcome;
    });
  },

  /**
   * 开始一次新的反馈操作。
   * 弹窗与剪贴板回调都带着发起时的序号；序号不匹配说明用户已经开始了更新的操作，
   * 旧回执只允许被丢弃，不能改状态、不能再发提示。
   */
  beginFeedbackOp() {
    this._feedbackOp = (this._feedbackOp || 0) + 1;
    return this._feedbackOp;
  },

  /**
   * 意见反馈（T059）
   *
   * 确认后把原文交给原生剪贴板，由用户自己粘贴发送；不写云、不写本机存储。
   * 取消或空内容都没有副作用。
   */
  feedback() {
    const op = this.beginFeedbackOp();

    wx.showModal({
      title: '意见反馈',
      content: '写下问题或建议。确认后会复制到剪贴板，可粘贴发送给开发者。',
      editable: true,
      placeholderText: '请输入你的反馈...',
      success: (res) => {
        if (this._feedbackOp !== op) return; // 迟到的旧弹窗回执
        if (!res || !res.confirm) return; // 取消：不复制、不写存储

        const text = typeof res.content === 'string' ? res.content : '';
        if (!text.trim()) {
          wx.showToast({ title: '请先输入反馈', icon: 'none' });
          return;
        }
        this.copyFeedbackText(text);
      }
    });
  },

  /**
   * 用同一个原生参数对象发起一次复制。
   * success / fail 每个回执只处理一次；旧操作的回执直接忽略。
   */
  copyFeedbackText(text) {
    const op = this.beginFeedbackOp();
    let settled = false;

    this.setData({
      feedbackDraft: text,
      feedbackCopyFailed: false
    });

    wx.setClipboardData({
      data: text,
      success: () => {
        if (settled) return;
        settled = true;
        if (this._feedbackOp !== op) return;
        this.setData({
          feedbackDraft: '',
          feedbackCopyFailed: false
        });
        wx.showToast({ title: '已复制', icon: 'success' });
      },
      fail: () => {
        if (settled) return;
        settled = true;
        if (this._feedbackOp !== op) return;
        // 不落存储，只把原文留在页面内存，供下面的重试入口再复制一次。
        this.setData({
          feedbackDraft: text,
          feedbackCopyFailed: true
        });
        wx.showToast({ title: '复制失败，文字已保留', icon: 'none' });
      }
    });
  },

  /**
   * 重试复制上一段没有被原生剪贴板接收的反馈文字。
   */
  retryFeedback() {
    const text = typeof this.data.feedbackDraft === 'string'
      ? this.data.feedbackDraft
      : '';
    if (!text.trim()) return;
    this.copyFeedbackText(text);
  },

  // ------------------------------------------------------------------ *
  // T068：文本备份与恢复
  // 本页只做「生成文字 → 用户显式复制/保存 → 重新粘贴 → 预演 → 独立确认」；
  // 不新增页面、不改路由、不碰照片/视频文件，也不把诊断原文当作可导入备份。
  // ------------------------------------------------------------------ *

  nextBackupCopyOp() {
    this._backupCopyOp = (this._backupCopyOp || 0) + 1;
    return this._backupCopyOp;
  },

  nextRestoreOp() {
    this._restoreOp = (this._restoreOp || 0) + 1;
    return this._restoreOp;
  },

  /**
   * 离开页面/卸载时放弃未完成的预演与回执。只改页面内存，不写任何存储。
   */
  abortBackupTransient(updateView) {
    this.nextRestoreOp();
    this.nextBackupCopyOp();
    this._backupPreviewText = '';
    if (!this.data || !this.data.backupPreview) return;
    if (updateView === false) {
      this.data.backupPreview = null;
      return;
    }
    this.setData({
      backupPreview: null,
      backupNoticeKind: 'info',
      backupNotice: '已离开页面，恢复预演已失效；请重新检查备份文本后再确认。'
    });
  },

  /**
   * 输入框每次变化都让旧预演失效：恢复按钮随之隐藏，旧确认弹窗的回执也按序号丢弃。
   * 只改页面内存，粘贴的原文继续留在输入框里。
   */
  onBackupImportInput(event) {
    const value = event && event.detail && typeof event.detail.value === 'string'
      ? event.detail.value
      : '';
    const hadPreview = Boolean(this.data.backupPreview);
    this.nextRestoreOp();
    this._backupPreviewText = '';
    const patch = {
      backupImportText: value,
      backupPreview: null
    };
    if (hadPreview) {
      patch.backupNoticeKind = 'info';
      patch.backupNotice = '备份文本已修改，恢复预演已失效；请重新检查后再确认。';
    }
    this.setData(patch);
  },

  /**
   * 只读生成文本备份。不会自动复制；复制必须由用户再点一次。
   * 读取失败时不清空此前导出或粘贴的文字。
   */
  exportBackupText() {
    this.nextBackupCopyOp();
    const result = trainingBackup.exportText({ now: new Date() });
    if (!result.ok) {
      this.setData({
        backupNoticeKind: 'error',
        backupNotice: '生成备份失败：' + result.error + '。当前档案与清单未改动，已保留你此前导出或粘贴的文字。'
      });
      return result;
    }
    const warning = result.warnings && result.warnings.length
      ? ' 注意：' + result.warnings.join('；') + '。'
      : '';
    this.setData({
      backupExportText: result.text,
      backupExportMeta:
        backupSummaryText(result.summary) + ' · ' + formatBackupBytes(result.bytes),
      backupCopyFailed: false,
      backupCopyFailureKind: '',
      backupCopyIssueText: '',
      backupNoticeKind: 'success',
      backupNotice:
        '已生成文本备份（' +
        formatBackupBytes(result.bytes) +
        '）。点「复制备份文本」后自行保存；照片、视频、时间点与操作日志不在文本内。' +
        warning
    });
    return result;
  },

  copyBackupText() {
    const text = typeof this.data.backupExportText === 'string'
      ? this.data.backupExportText
      : '';
    if (!text) {
      this.setData({
        backupNoticeKind: 'error',
        backupNotice: '请先点「生成文本备份」，再复制。'
      });
      return;
    }
    this.copyBackupTextByKind('backup', text);
  },

  /**
   * 受损诊断只读导出：保留当前与上一代原文的精确文本（含无法解析的原文）。
   * 生成的诊断不能再作为正常备份导入，页面会明确说明。
   */
  exportBackupDiagnostics() {
    this.nextBackupCopyOp();
    const result = trainingBackup.exportDiagnostics({ now: new Date() });
    if (!result.ok) {
      this.setData({
        backupNoticeKind: 'error',
        backupNotice: '导出诊断失败：' + (result.error || '未知错误') + '。当前档案与清单未改动。'
      });
      return result;
    }
    const hasCurrent = Boolean(
      result.current && result.current.archive && result.current.archive.present
    );
    const hasPrevious = Boolean(
      result.previous && result.previous.archive && result.previous.archive.present
    );
    this.setData({
      backupDiagnosticsText: result.text,
      backupDiagnosticsMeta:
        formatBackupBytes(result.bytes) +
        (hasCurrent ? ' · 含当前档案原文' : ' · 当前档案原文为空') +
        (hasPrevious ? ' · 含上一代原文' : ' · 当前没有上一代原文'),
      backupDiagnosticsCopyFailed: false,
      backupDiagnosticsCopyFailureKind: '',
      backupDiagnosticsCopyIssueText: '',
      backupNoticeKind: 'info',
      backupNotice:
        '诊断原文已生成。它用于排查受损或无法解析的原文，不能作为备份导入；请复制后私下保存，不要公开分享。'
    });
    return result;
  },

  copyBackupDiagnostics() {
    const text = typeof this.data.backupDiagnosticsText === 'string'
      ? this.data.backupDiagnosticsText
      : '';
    if (!text) {
      this.setData({
        backupNoticeKind: 'error',
        backupNotice: '请先点「导出受损诊断」，再复制。'
      });
      return;
    }
    this.copyBackupTextByKind('diagnostics', text);
  },

  /**
   * 两类复制共用一次操作序号，但回执只更新发起时的那一类结果。
   * 成功提示只在 wx.setClipboardData 的 success 回调里出现；失败区分大小文档。
   */
  copyBackupTextByKind(kind, text) {
    const diagnostics = kind === 'diagnostics';
    const label = diagnostics ? '诊断原文' : '备份文本';
    if (!text) return;

    const op = this.nextBackupCopyOp();
    const bytes = trainingBackup.utf8Bytes(text);
    const tooLarge = bytes > LARGE_CLIPBOARD_BYTES;
    let settled = false;

    const onSuccess = () => {
      if (settled) return;
      settled = true;
      if (this._backupCopyOp !== op) return;
      const patch = diagnostics
        ? {
            backupDiagnosticsCopyFailed: false,
            backupDiagnosticsCopyFailureKind: '',
            backupDiagnosticsCopyIssueText: ''
          }
        : {
            backupCopyFailed: false,
            backupCopyFailureKind: '',
            backupCopyIssueText: ''
          };
      patch.backupNoticeKind = 'success';
      patch.backupNotice = label + '已复制。请粘贴到你自己的记事本等私密位置保存；本页不会代你上传。';
      this.setData(patch);
      wx.showToast({ title: label + '已复制', icon: 'success' });
    };

    const onFail = () => {
      if (settled) return;
      settled = true;
      if (this._backupCopyOp !== op) return;
      const issueText = tooLarge
        ? label +
          '约 ' +
          formatBackupBytes(bytes) +
          '，手机剪贴板可能放不下，未复制。文字仍保留在本页，可长按全选后自行保存到私密位置；诊断请分次保存。'
        : '复制' +
          label +
          '失败，' +
          label +
          '仍保留在本页；可稍后再点复制，或长按全选后自行保存。';
      const patch = diagnostics
        ? {
            backupDiagnosticsCopyFailed: true,
            backupDiagnosticsCopyFailureKind: tooLarge ? 'too-large' : 'failed',
            backupDiagnosticsCopyIssueText: issueText
          }
        : {
            backupCopyFailed: true,
            backupCopyFailureKind: tooLarge ? 'too-large' : 'failed',
            backupCopyIssueText: issueText
          };
      patch.backupNoticeKind = tooLarge ? 'warning' : 'error';
      patch.backupNotice = issueText;
      this.setData(patch);
      wx.showToast({
        title: tooLarge ? '文本较大，未复制' : '复制失败，文字已保留',
        icon: 'none'
      });
    };

    try {
      wx.setClipboardData({
        data: text,
        success: onSuccess,
        fail: onFail
      });
    } catch (error) {
      onFail();
    }
  },

  /**
   * 独立预演：严格校验并读取当前档案版本，零写入。失败时保留粘贴原文。
   */
  previewBackupImport() {
    this.nextRestoreOp();
    const text = typeof this.data.backupImportText === 'string'
      ? this.data.backupImportText
      : '';
    if (!text.trim()) {
      this._backupPreviewText = '';
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'error',
        backupNotice: '请先把备份文本粘贴到输入框，再检查。'
      });
      return { ok: false, code: 'empty-input', error: '请先粘贴备份文本' };
    }

    const result = trainingBackup.inspectText(text, { now: new Date() });
    if (!result.ok) {
      this._backupPreviewText = '';
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'error',
        backupNotice:
          '检查未通过：' +
          result.error +
          '。当前档案与清单没有改动，你粘贴的文本仍保留在输入框里。'
      });
      return result;
    }

    this._backupPreviewText = text;
    this.setData({
      backupPreview: {
        token: result.token,
        bytes: result.bytes,
        summary: result.summary,
        plan: result.plan
      },
      backupNoticeKind: 'success',
      backupNotice: '检查通过，尚未写入。请核对下方数量和说明，再点「确认恢复」。'
    });
    return result;
  },

  /**
   * 正式恢复前的独立确认。取消、弹窗失败、文本已改动或更晚的操作都零写入。
   */
  confirmBackupRestore() {
    const preview = this.data.backupPreview;
    const text = typeof this.data.backupImportText === 'string'
      ? this.data.backupImportText
      : '';
    if (
      !preview ||
      !preview.token ||
      !text ||
      this._backupPreviewText !== text
    ) {
      this._backupPreviewText = '';
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'error',
        backupNotice: '请先检查当前输入的备份文本，再确认恢复。'
      });
      return;
    }

    const token = preview.token;
    const op = this.nextRestoreOp();
    wx.showModal({
      title: '确认恢复文字档案',
      content:
        '将把这份备份文字恢复为本机训练档案，并分配新的档案归属。当前档案原文会保留在本机（可导出诊断）；照片、视频、时间点与操作日志不在备份内，已有媒体仍归旧档案，恢复的文字不会产生可播放副本。确定恢复？',
      confirmText: '确认恢复',
      cancelText: '取消',
      success: (res) => {
        if (this._restoreOp !== op) return; // 迟到的旧弹窗回执
        if (!res || !res.confirm) {
          this.setData({
            backupNoticeKind: 'info',
            backupNotice: '已取消恢复，当前档案与清单没有改动。'
          });
          return;
        }
        if (
          this.data.backupImportText !== text ||
          this._backupPreviewText !== text ||
          !this.data.backupPreview ||
          this.data.backupPreview.token !== token
        ) {
          this._backupPreviewText = '';
          this.setData({
            backupPreview: null,
            backupNoticeKind: 'error',
            backupNotice: '备份文本或预演已变化，请重新检查后再确认恢复。'
          });
          return;
        }
        this.applyBackupRestore(text, token);
      },
      fail: () => {
        if (this._restoreOp !== op) return;
        this.setData({
          backupNoticeKind: 'error',
          backupNotice: '无法打开确认窗口，未做恢复；请稍后再点「确认恢复」。'
        });
      }
    });
  },

  /**
   * 调用 T067 的显式恢复。失败保留粘贴原文并撤销旧预演，要求重新检查；
   * 已提交但回读未验证时只引导诊断，不引导原样重试。
   */
  applyBackupRestore(text, token) {
    this.nextRestoreOp();
    let result;
    try {
      result = trainingBackup.confirmRestore(text, {
        confirmed: true,
        previewToken: token,
        now: new Date()
      });
    } catch (error) {
      const message = error && (error.errMsg || error.message) ? error.errMsg || error.message : String(error);
      this._backupPreviewText = '';
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'error',
        backupNotice:
          '恢复时发生本机异常，未确认写入：' +
          message +
          '。你粘贴的文本仍保留；当前档案可继续导出诊断。'
      });
      return { ok: false, code: 'exception', error: message };
    }

    this._backupPreviewText = '';
    if (result && result.ok) {
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'success',
        backupNotice:
          '恢复完成：' +
          backupSummaryText(result.summary) +
          '。旧档案原文作为上一代保留在本机；照片与视频仍归旧档案，未复制。'
      });
      return result;
    }

    // 提交点可能已写出但无法核对（提交键读回不一致/写入结果未知/提交后计数不符）：
    // 不要再引导原样重试，先诊断并按盘上提交记录重新判断。
    const commitUncertain = Boolean(
      result &&
        (result.committed === true ||
          result.code === 'committed-unverified' ||
          result.code === 'commit-unverified' ||
          result.code === 'commit-unknown')
    );
    if (commitUncertain) {
      this.setData({
        backupPreview: null,
        backupNoticeKind: 'error',
        backupNotice:
          '恢复的提交结果未能核对，可能已经提交，也可能没有，当前状态不能当作已验证。请先点「导出受损诊断」保存原文，并重新打开小程序让提交记录按本机盘上状态判断；不要用同一段文本再次恢复，重复确认可能覆盖较新的状态。如需再次恢复，请重新检查这份备份文本并重新确认。'
      });
      return result;
    }

    this.setData({
      backupPreview: null,
      backupNoticeKind: 'error',
      backupNotice:
        '恢复未写入：' +
        ((result && result.error) || '未知错误') +
        '。当前档案与清单没有改动，你粘贴的文本仍保留；请重新检查后再确认。'
    });
    return result;
  }
});
