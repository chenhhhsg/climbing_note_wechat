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
 */
const app = getApp();
const trainingStore = require('../../utils/training-store.js');
const {
  createTrainingPhotoController
} = require('../../utils/training-photo-controller.js');

Page({
  data: {
    userInfo: null,
    hasUserInfo: false
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
      content: '确定要清除缓存吗？本机训练记录与照片不会被清除。',
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
   * 意见反馈
   */
  feedback() {
    wx.showModal({
      title: '意见反馈',
      content: '如有问题或建议，请在下方留言',
      editable: true,
      placeholderText: '请输入你的反馈...',
      success: (res) => {
        if (res.confirm && res.content) {
          // 这里可以将反馈发送到云数据库
          wx.showToast({
            title: '感谢反馈',
            icon: 'success'
          });
        }
      }
    });
  }
});
