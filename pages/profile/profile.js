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
 */
const app = getApp();
const trainingStore = require('../../utils/training-store.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

Page({
  data: {
    userInfo: null,
    hasUserInfo: false,
    // T059：复制失败时保留的用户文字；只在页面内存里，供「点此重试」再次复制。
    feedbackDraft: '',
    feedbackCopyFailed: false
  },

  onLoad() {
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
   * 获取用户信息
   */
  getUserProfile() {
    wx.getUserProfile({
      desc: '用于完善个人资料',
      success: (res) => {
        app.globalData.userInfo = res.userInfo;
        this.setData({
          userInfo: res.userInfo,
          hasUserInfo: true
        });
      },
      fail: (err) => {
        console.log('获取用户信息失败：', err);
      }
    });
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
  }
});
