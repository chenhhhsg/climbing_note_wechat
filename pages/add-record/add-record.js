/**
 * 添加/编辑记录页面
 * 支持完整的攀岩记录表单
 * 通过 url 参数 id 判断是新增还是编辑模式
 */
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const gradeUtil = require('../../utils/grade');
const app = getApp();

Page({
  data: {
    // 模式
    isEdit: false,
    recordId: '',

    // 表单数据
    date: '',
    location: '',
    climbType: '',
    grade: '',
    status: '',
    attempts: 1,
    routeColor: '',
    routeName: '',
    area: '',
    notes: '',
    images: [],

    // 选项数据
    climbTypes: [],
    climbTypeLabels: {},
    statusOptions: [],
    statusLabels: {},
    gradeOptions: [],
    gradeLabels: {},

    // 状态标签
    statusTags: [
      { value: 'flash', label: 'Flash', icon: '⚡' },
      { value: 'completed', label: '完成', icon: '✅' },
      { value: 'failed', label: '未完成', icon: '❌' },
      { value: 'project', label: 'Project', icon: '🎯' }
    ],

    // 线路颜色选项
    colorOptions: ['红', '蓝', '绿', '黄', '黑', '白', '紫', '橙', '粉', '灰'],

    // UI状态
    isSubmitting: false,
    loadingRecord: false
  },

  async onLoad(options) {
    const { climbTypes, climbTypeLabels, statusOptions, statusLabels } = app.globalData;

    this.setData({
      date: dateUtil.getToday(),
      climbTypes,
      climbTypeLabels,
      statusOptions,
      statusLabels,
      climbType: climbTypes[0],
      status: statusOptions[0]
    });

    this.updateGradeOptions(climbTypes[0]);

    // 编辑模式：加载已有记录
    if (options.id) {
      this.setData({ isEdit: true, recordId: options.id, loadingRecord: true });
      wx.setNavigationBarTitle({ title: '编辑记录' });
      await this.loadRecordForEdit(options.id);
    }
  },

  /**
   * 编辑模式：加载记录数据填充表单
   */
  async loadRecordForEdit(id) {
    const res = await db.getRecordById(id);

    if (res.success) {
      const record = res.data;

      // 先更新难度选项（根据记录的攀岩类型）
      this.updateGradeOptions(record.climbType);

      this.setData({
        date: record.date || '',
        location: record.location || '',
        climbType: record.climbType || '',
        grade: record.grade || '',
        status: record.status || '',
        attempts: record.attempts || 1,
        routeColor: record.routeColor || '',
        routeName: record.routeName || '',
        area: record.area || '',
        notes: record.notes || '',
        images: record.images || [],
        loadingRecord: false
      });
    } else {
      this.setData({ loadingRecord: false });
      wx.showToast({ title: '加载记录失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  /**
   * 根据攀岩类型更新难度选项
   */
  updateGradeOptions(climbType) {
    const grades = gradeUtil.getGradeOptions(climbType);
    const gradeLabels = {};
    grades.forEach(g => { gradeLabels[g.value] = g.label; });

    this.setData({
      gradeOptions: grades.map(g => g.value),
      gradeLabels
    });
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  onLocationInput(e) {
    this.setData({ location: e.detail.value });
  },

  onClimbTypeChange(e) {
    const index = e.detail.value;
    const climbType = this.data.climbTypes[index];
    this.setData({ climbType, grade: '' });
    this.updateGradeOptions(climbType);
  },

  onGradeChange(e) {
    const index = e.detail.value;
    this.setData({ grade: this.data.gradeOptions[index] });
  },

  // 状态标签选择
  onStatusSelect(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({ status });
  },

  // 尝试次数 +/-
  onAttemptsPlus() {
    this.setData({ attempts: this.data.attempts + 1 });
  },

  onAttemptsMinus() {
    if (this.data.attempts > 1) {
      this.setData({ attempts: this.data.attempts - 1 });
    }
  },

  onAttemptsInput(e) {
    const val = parseInt(e.detail.value) || 1;
    this.setData({ attempts: Math.max(1, val) });
  },

  // 线路颜色选择
  onColorSelect(e) {
    const color = e.currentTarget.dataset.color;
    this.setData({ routeColor: this.data.routeColor === color ? '' : color });
  },

  onRouteNameInput(e) {
    this.setData({ routeName: e.detail.value });
  },

  onAreaInput(e) {
    this.setData({ area: e.detail.value });
  },

  onNotesInput(e) {
    this.setData({ notes: e.detail.value });
  },

  chooseImage() {
    const remaining = 6 - this.data.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传6张图片', icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map(file => file.tempFilePath);
        this.setData({ images: [...this.data.images, ...newImages] });
      }
    });
  },

  deleteImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({ current: url, urls: this.data.images });
  },

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
    if (!this.data.status) {
      wx.showToast({ title: '请选择完成状态', icon: 'none' });
      return false;
    }
    return true;
  },

  /**
   * 收集表单数据
   */
  getFormData() {
    return {
      date: this.data.date,
      location: this.data.location,
      climbType: this.data.climbType,
      grade: this.data.grade,
      status: this.data.status,
      attempts: this.data.attempts,
      routeColor: this.data.routeColor,
      routeName: this.data.routeName,
      area: this.data.area,
      notes: this.data.notes
    };
  },

  async submitForm() {
    if (!this.validateForm()) return;
    if (this.data.isSubmitting) return;

    this.setData({ isSubmitting: true });
    wx.showLoading({ title: '保存中...' });

    try {
      // 处理图片：区分已有 fileID（cloud://）和新本地文件
      const existingImages = this.data.images.filter(img => img.startsWith('cloud://'));
      const newLocalImages = this.data.images.filter(img => !img.startsWith('cloud://'));

      // 上传新图片（逐张上传，带进度提示）
      let imageFileIDs = [];
      if (newLocalImages.length > 0) {
        for (let i = 0; i < newLocalImages.length; i++) {
          wx.showLoading({ title: `压缩上传图片 ${i + 1}/${newLocalImages.length}...` });
          const imgRes = await db.uploadImage(newLocalImages[i]);
          if (!imgRes.success) {
            wx.hideLoading();
            wx.showToast({ title: `第${i + 1}张图片上传失败`, icon: 'none' });
            this.setData({ isSubmitting: false });
            return;
          }
          imageFileIDs.push(imgRes.data);
        }
      }

      // 合并已有图片和新上传图片
      const allImages = [...existingImages, ...imageFileIDs];

      wx.showLoading({ title: '保存记录中...' });

      // 收集表单数据
      const formData = {
        ...this.getFormData(),
        images: allImages
      };

      let res;
      if (this.data.isEdit) {
        // 编辑模式：先删除被移除的旧图片
        const oldImages = (await db.getRecordById(this.data.recordId)).data.images || [];
        const removedImages = oldImages.filter(img => !allImages.includes(img));
        if (removedImages.length > 0) {
          await db.deleteImage(removedImages);
        }
        res = await db.updateRecord(this.data.recordId, formData);
      } else {
        // 新增模式
        res = await db.createRecord(formData);
      }

      wx.hideLoading();

      if (res.success) {
        wx.showToast({ title: this.data.isEdit ? '更新成功' : '保存成功', icon: 'success' });
        setTimeout(() => {
          if (this.data.isEdit) {
            wx.navigateBack();
          } else {
            const pages = getCurrentPages();
            if (pages.length > 1) {
              wx.navigateBack();
            } else {
              wx.switchTab({ url: '/pages/record-list/record-list' });
            }
          }
        }, 1500);
      } else {
        wx.showToast({ title: this.data.isEdit ? '更新失败' : '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '操作失败', icon: 'none' });
      console.error('[Submit]', err);
    }

    this.setData({ isSubmitting: false });
  }
});
