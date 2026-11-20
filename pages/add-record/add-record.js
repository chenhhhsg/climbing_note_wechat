/**
 * 添加记录页面
 * 包含日期、地点、攀岩类型、难度、完成状态、尝试次数、备注、图片上传
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    // 表单数据
    date: '',           // 日期
    location: '',       // 地点
    climbType: '',      // 攀岩类型
    grade: '',          // 难度等级
    status: '',         // 完成状态
    attempts: 1,        // 尝试次数
    notes: '',          // 备注
    images: [],         // 上传的图片

    // 选项数据
    climbTypes: [],           // 攀岩类型选项
    statusOptions: [],        // 完成状态选项
    gradeOptions: [],         // 难度等级选项

    // UI状态
    isSubmitting: false,      // 是否正在提交
    showGradePicker: false,   // 是否显示难度选择器

    // R5 保存成功后的终态：写入成功后提交锁定至离开本页，只排一次延迟返回；
    // 返回失败时保存仍保持锁定，只给显式重试返回，绝不重复上传或写库。
    saveState: '',            // '' 未保存 / 'saved' 已保存（终态）
    returnFailed: false       // 延迟返回失败，等待用户显式重试返回
  },

  onLoad() {
    // 初始化表单数据
    this.setData({
      date: dateUtil.getToday(),
      climbTypes: app.globalData.climbTypes,
      statusOptions: app.globalData.statusOptions,
      climbType: app.globalData.climbTypes[0],
      status: app.globalData.statusOptions[0]
    });

    // 初始化难度选项
    this.updateGradeOptions(app.globalData.climbTypes[0]);
  },

  /**
   * 页面卸载：取消已排队的延迟返回，离开本页后不再弹回上一页。
   */
  onUnload() {
    this.clearReturnTimer();
  },

  /**
   * 取消延迟返回定时器（成功终态只允许一个待执行的返回回执）。
   */
  clearReturnTimer() {
    if (this.returnTimer) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
  },

  /**
   * 排一次延迟返回：重复触发不叠加定时器，成功写入后只有一个返回回执。
   */
  scheduleReturn() {
    if (this.returnTimer) return;
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      this.goBackAfterSave();
    }, 1500);
  },

  /**
   * 保存成功后的返回：只做页面返回，不再上传图片、不再写库。
   * 返回失败保留「已保存」锁定，改为用户显式重试返回。
   */
  goBackAfterSave() {
    if (this.data.saveState !== 'saved') return;
    if (typeof wx === 'undefined' || typeof wx.navigateBack !== 'function') {
      this.markReturnFailed();
      return;
    }
    wx.navigateBack({
      delta: 1,
      fail: () => {
        this.markReturnFailed();
      }
    });
  },

  /**
   * 返回失败：记录已保存，只提示并可显式重试返回；保存状态保持锁定。
   */
  markReturnFailed() {
    this.setData({ returnFailed: true });
    wx.showToast({
      title: '已保存，返回失败',
      icon: 'none'
    });
  },

  /**
   * 显式重试返回：只重试页面返回，绝不重复上传或写库。
   */
  retryReturn() {
    if (this.data.saveState !== 'saved') return;
    this.goBackAfterSave();
  },

  /**
   * 根据攀岩类型更新难度选项
   */
  updateGradeOptions(climbType) {
    const grades = gradeUtil.getGradesByType(climbType);
    this.setData({
      gradeOptions: grades.map(g => g.value),
      grade: grades[0].value
    });
  },

  /**
   * 日期选择变化
   */
  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  /**
   * 地点输入
   */
  onLocationInput(e) {
    this.setData({ location: e.detail.value });
  },

  /**
   * 攀岩类型选择
   */
  onClimbTypeChange(e) {
    const index = e.detail.value;
    const climbType = this.data.climbTypes[index];
    this.setData({ climbType });
    this.updateGradeOptions(climbType);
  },

  /**
   * 难度等级选择
   */
  onGradeChange(e) {
    const index = e.detail.value;
    this.setData({ grade: this.data.gradeOptions[index] });
  },

  /**
   * 完成状态选择
   */
  onStatusChange(e) {
    const index = e.detail.value;
    this.setData({ status: this.data.statusOptions[index] });
  },

  /**
   * 尝试次数变化
   */
  onAttemptsChange(e) {
    this.setData({ attempts: e.detail.value });
  },

  /**
   * 备注输入
   */
  onNotesInput(e) {
    this.setData({ notes: e.detail.value });
  },

  /**
   * 选择图片
   */
  chooseImage() {
    const remaining = 9 - this.data.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传9张图片', icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(file => file.tempFilePath);
        this.setData({
          images: [...this.data.images, ...newImages]
        });
      }
    });
  },

  /**
   * 删除图片
   */
  deleteImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  /**
   * 预览图片
   */
  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({
      current: url,
      urls: this.data.images
    });
  },

  /**
   * 表单验证
   */
  validateForm() {
    if (!this.data.date) {
      wx.showToast({ title: '请选择日期', icon: 'none' });
      return false;
    }
    if (!this.data.location) {
      wx.showToast({ title: '请输入地点', icon: 'none' });
      return false;
    }
    if (!this.data.climbType) {
      wx.showToast({ title: '请选择攀岩类型', icon: 'none' });
      return false;
    }
    if (!this.data.grade) {
      wx.showToast({ title: '请选择难度等级', icon: 'none' });
      return false;
    }
    return true;
  },

  /**
   * 提交表单
   *
   * R5：写入成功后进入终态——提交锁定到离开本页，连点零写；只排一次延迟返回。
   * 返回失败时保存仍锁定，由显式「重试返回」再试，不重复上传或写库。
   * 明确失败的写入不删除已上传的云文件，原表单输入保留，可原地重试。
   */
  async submitForm() {
    // 成功终态：不再上传、不再写库，也不重复排返回。
    if (this.data.saveState === 'saved') return;
    if (this.data.isSubmitting) return;
    if (!this.validateForm()) return;

    this.setData({ isSubmitting: true });

    try {
      wx.showLoading({ title: '保存中...' });

      // 上传图片（既有上传路径保持不变；失败重试仍走同一条路径）
      const imageFileIDs = [];
      for (const imagePath of this.data.images) {
        const uploadRes = await db.uploadImage(imagePath);
        imageFileIDs.push(uploadRes.fileID);
      }

      // 构建记录数据
      const record = {
        date: this.data.date,
        location: this.data.location,
        climbType: this.data.climbType,
        grade: this.data.grade,
        status: this.data.status,
        attempts: parseInt(this.data.attempts) || 1,
        notes: this.data.notes,
        images: imageFileIDs
      };

      // 保存到数据库
      await db.addRecord(record);

      // 写入成功即终态：先锁定提交并清掉旧返回计划，再排唯一的延迟返回。
      this.clearReturnTimer();
      this.setData({
        saveState: 'saved',
        returnFailed: false,
        isSubmitting: false
      });

      wx.hideLoading();
      wx.showToast({
        title: '保存成功',
        icon: 'success'
      });
      this.scheduleReturn();

    } catch (err) {
      console.error('保存失败：', err);
      wx.hideLoading();
      wx.showToast({
        title: '保存失败',
        icon: 'none'
      });
      // 明确失败：不锁定提交、不清理云文件（结果不明时不删除），原表单可重试。
    } finally {
      this.setData({ isSubmitting: false });
    }
  }
});
