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
    showGradePicker: false    // 是否显示难度选择器
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
   */
  async submitForm() {
    if (!this.validateForm()) return;
    if (this.data.isSubmitting) return;

    this.setData({ isSubmitting: true });

    try {
      wx.showLoading({ title: '保存中...' });

      // 上传图片
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

      wx.hideLoading();
      wx.showToast({
        title: '保存成功',
        icon: 'success'
      });

      // 返回上一页
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);

    } catch (err) {
      console.error('保存失败：', err);
      wx.hideLoading();
      wx.showToast({
        title: '保存失败',
        icon: 'none'
      });
    } finally {
      this.setData({ isSubmitting: false });
    }
  }
});
