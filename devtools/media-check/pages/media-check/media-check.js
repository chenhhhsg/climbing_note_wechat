/**
 * 本地视频验证页（独立实验工程）
 *
 * 验证未来复盘报告时间点要走通的路径：
 * 从相册单选一段本地视频 → 播放/暂停 → 把报告约定的
 * 5000 毫秒在播放器边界换算成 5 秒并跳转。
 *
 * 选片得到的临时路径只保存在当前页面实例中，不写缓存、不上传。
 *
 * 每次成功选片都会创建一个新的原生 video 节点（新的 token 与 id）。
 * 播放器事件必须携带当前节点的 token 才会被接受，这样换片后旧视频
 * 迟到的 loadedmetadata / timeupdate / error 不会被误当成新视频。
 */
const TARGET_POSITION_MS = 5000;
const TARGET_POSITION_SECONDS = TARGET_POSITION_MS / 1000;
const VIDEO_CONTEXT_ID = 'media-check-video';

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeDuration(value) {
  const duration = safeNumber(value);
  return duration !== null && duration > 0 ? duration : null;
}

function insufficientDurationMessage(durationText) {
  return `视频时长不足 ${TARGET_POSITION_SECONDS} 秒（${durationText} 秒），无法跳转到第 5 秒`;
}

Page({
  data: {
    videoPath: '',
    videoInstances: [],        // 只放当前选片创建的一个节点身份 { token, domId }
    activeToken: '',           // 当前原生 video 节点的事件身份
    hasVideo: false,
    ready: false,              // 当前视频的元数据是否已就绪
    duration: null,            // 秒，来自播放器 loadedmetadata
    durationText: '',
    width: null,               // 播放器可取得的视频宽高
    height: null,
    playing: false,
    currentTime: null,         // 秒，只由播放器 timeupdate 回报
    currentTimeText: '',
    targetPositionMs: TARGET_POSITION_MS,
    targetPositionSeconds: TARGET_POSITION_SECONDS,
    seekTargetSeconds: null,   // 本次跳转实际发送给播放器的秒值
    seekDisabled: true,        // 元数据未就绪或时长不足时禁用跳转按钮
    shortVideoMessage: '',     // 元数据到达即可见的时长不足原因
    seekStatus: '',
    errorMessage: '',          // 播放器错误
    chooseError: ''            // 选片错误
  },

  onLoad() {
    // 每次进入都是新的选片会话：不读取缓存，也不恢复上次的临时路径。
    this._selectionSeq = 0;
    this._videoContext = null;
    this._videoContextId = '';
  },

  /**
   * 从相册单选一段视频。取消选片保持已有视频不变；
   * 选择失败显示可重试的错误。
   */
  chooseVideo() {
    return new Promise(resolve => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album'],
        success: res => {
          const file = res && res.tempFiles && res.tempFiles[0];
          if (!file || !file.tempFilePath) {
            this.setData({ chooseError: '没有取得视频文件，请重新选择' });
            resolve(res);
            return;
          }
          this.useVideo(file.tempFilePath);
          resolve(res);
        },
        fail: err => {
          const errMsg = (err && err.errMsg) || '';
          if (/cancel/i.test(errMsg)) {
            // 取消选片不是错误：保留当前视频和播放状态，只允许继续操作。
            resolve(err);
            return;
          }
          this.setData({
            chooseError: `选择视频失败：${errMsg || '未知错误'}`
          });
          resolve(err);
        }
      });
    });
  },

  /**
   * 切换到新视频：创建一个新的原生 video 节点身份，并清空上一段的
   * 就绪状态、位置和错误。旧节点的事件携带旧 token，全部忽略。
   */
  useVideo(tempFilePath) {
    const seq = (this._selectionSeq || 0) + 1;
    this._selectionSeq = seq;
    const token = `video-${seq}`;
    const domId = `${VIDEO_CONTEXT_ID}-${seq}`;

    this._videoContext = null;
    this._videoContextId = '';

    this.setData({
      videoPath: tempFilePath,
      videoInstances: [{ token, domId }],
      activeToken: token,
      hasVideo: true,
      ready: false,
      duration: null,
      durationText: '',
      width: null,
      height: null,
      playing: false,
      currentTime: null,
      currentTimeText: '',
      seekTargetSeconds: null,
      seekDisabled: true,
      shortVideoMessage: '',
      seekStatus: '',
      errorMessage: '',
      chooseError: ''
    });
  },

  /**
   * 事件身份绑定在实际触发事件的 video 节点上，
   * 不能用页面当前选片状态反推，否则迟到的旧事件会被当成新视频。
   */
  isCurrentVideoEvent(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset;
    const token = (dataset && dataset.videoToken) || '';
    return token !== '' && token === this.data.activeToken;
  },

  /**
   * videoContext 跟随当前节点：换片后为新 id 重新创建，
   * 跳转只会发给当前显示的播放器。
   */
  getVideoContext() {
    const instance = this.data.videoInstances[0];
    if (!instance) return null;

    if (!this._videoContext || this._videoContextId !== instance.domId) {
      this._videoContext = wx.createVideoContext(instance.domId, this);
      this._videoContextId = instance.domId;
    }
    return this._videoContext;
  },

  /**
   * 播放器元数据就绪：这里才拿到当前视频的时长和宽高。
   * 元数据不代表播放位置，currentTime 仍保持“尚未回报”。
   * 时长不足 5 秒时立即显示原因并禁用跳转。
   */
  onVideoLoadedMetadata(e) {
    if (!this.data.hasVideo || !this.isCurrentVideoEvent(e)) return;

    const detail = (e && e.detail) || {};
    const duration = safeDuration(detail.duration);
    const width = safeNumber(detail.width);
    const height = safeNumber(detail.height);
    const ready = duration !== null;
    const durationText = ready ? duration.toFixed(2) : '';
    const tooShort = ready && duration < TARGET_POSITION_SECONDS;

    this.setData({
      ready,
      duration,
      durationText,
      width: width !== null && width > 0 ? width : null,
      height: height !== null && height > 0 ? height : null,
      currentTime: null,
      currentTimeText: '',
      seekTargetSeconds: null,
      seekDisabled: !ready || tooShort,
      shortVideoMessage: tooShort ? insufficientDurationMessage(durationText) : '',
      seekStatus: '',
      errorMessage: ''
    });
  },

  onVideoPlay(e) {
    if (!this.isCurrentVideoEvent(e)) return;
    this.setData({ playing: true });
  },

  onVideoPause(e) {
    if (!this.isCurrentVideoEvent(e)) return;
    this.setData({ playing: false });
  },

  /**
   * 播放器实际回报的播放位置，与按钮目标值分开记录。
   */
  onVideoTimeUpdate(e) {
    if (!this.isCurrentVideoEvent(e)) return;

    const detail = (e && e.detail) || {};
    const currentTime = safeNumber(detail.currentTime);
    if (currentTime === null) return;

    this.setData({
      currentTime,
      currentTimeText: currentTime.toFixed(2)
    });
  },

  onVideoError(e) {
    if (!this.isCurrentVideoEvent(e)) return;

    const errMsg = (e && e.detail && e.detail.errMsg) || '未知错误';
    this.setData({
      ready: false,
      duration: null,
      durationText: '',
      width: null,
      height: null,
      playing: false,
      currentTime: null,
      currentTimeText: '',
      seekTargetSeconds: null,
      seekDisabled: true,
      shortVideoMessage: '',
      seekStatus: '',
      errorMessage: `视频播放失败：${errMsg}，请重新选择视频`
    });
  },

  togglePlay() {
    if (!this.data.hasVideo) return;

    const context = this.getVideoContext();
    if (!context) return;

    if (this.data.playing) {
      context.pause();
    } else {
      context.play();
    }
  },

  /**
   * 报告侧使用毫秒（5000），播放器 seek 使用秒；
   * 只在调用播放器的边界换算，并把目标值与实际回报分开显示。
   * 按钮已按元数据禁用，这里保留方法内守卫，防止绕过界面调用。
   */
  seekToFifthSecond() {
    if (!this.data.hasVideo) {
      this.setData({ seekStatus: '请先选择视频' });
      return;
    }
    if (!this.data.ready || this.data.duration === null) {
      this.setData({
        seekDisabled: true,
        seekStatus: '视频元数据尚未就绪，请稍候再试'
      });
      return;
    }
    if (this.data.duration < TARGET_POSITION_SECONDS) {
      this.setData({
        seekTargetSeconds: null,
        seekDisabled: true,
        shortVideoMessage: insufficientDurationMessage(this.data.durationText),
        seekStatus: insufficientDurationMessage(this.data.durationText)
      });
      return;
    }

    const context = this.getVideoContext();
    if (!context) {
      this.setData({ seekStatus: '播放器尚未就绪，请稍候再试' });
      return;
    }

    context.seek(TARGET_POSITION_SECONDS);
    this.setData({
      seekTargetSeconds: TARGET_POSITION_SECONDS,
      seekStatus: '已请求跳到第 5 秒，等待播放器回报实际位置'
    });
  }
});
