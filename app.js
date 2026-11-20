/**
 * 攀笔 - 攀岩记录小程序
 * 应用入口文件
 *
 * T016：云启动与正式本机档案隔离。没有云能力、云环境仍是占位或初始化失败时，
 * 只记账并继续启动——正式页面的本机记录、场内记把与回看都不依赖云。旧云记录的
 * 读取失败在 utils/db.js 里以可判别错误返回，不在这里阻塞启动。
 * 不改 AppID、不猜云环境：env 仍是占位值，由后续任务在获得真实环境后替换。
 *
 * T048–T050 追加返工：冷启动时接一次本地「长按删除」的持久凭据恢复。没有凭据或没有
 * 未完成条目时这一步立即返回，不扫描视频目录；有未完成条目时才继续清视频索引与文件，
 * 失败留给单线记录页的可见重试。它不依赖云能力，因此放在云初始化之前。
 *
 * T052：整场删除使用自己命名空间里的独立凭据。冷启动先恢复单把删除，再恢复整场删除；
 * 两者都只处理各自 journal 的 pending，没有待办时不碰文件系统。整场恢复只有在同一份
 * 档案证明原场次、本场关联与全部原把次都已不在时才继续清理；原场次还在就撤掉未完成
 * 凭据，不会在重开时悄悄接着做一次没提交的删除。
 *
 * T067：文本恢复的最后一步是写一个很小的提交键。冷启动只核对既有提交与未完成的
 * stage：已经落盘的提交按记录选代；没有持久提交键时绝不自动把 stage 提升为当前
 * 代际，而是保留原文、继续读旧档，等用户重新预演并显式确认。任何异常都只记录，
 * 不覆盖较新的档案；读取入口自己按提交键选代，不依赖这一步成功。
 */
App({
  onLaunch() {
    // 文本恢复提交的冷启动补写：只在证据完整且没有更新提交时工作。
    this.recoverLocalTextRestore();
    // 本机删除凭据的重开恢复：只读正式命名空间内各自的受保护键。
    this.recoverLocalAttemptDeletes();
    this.recoverLocalSessionDeletes();
    // 云能力不可用时只记录，不影响本机档案与页面加载。
    if (typeof wx === 'undefined' || !wx.cloud) {
      console.warn('未检测到云开发能力（可能基础库低于 2.2.3）：旧云记录暂不可读，本机记录不受影响');
      this.globalData.cloudReady = false;
      return;
    }
    try {
      wx.cloud.init({
        // 占位环境：获得真实云环境后在配置任务中替换，这里不猜测。
        env: 'your-env-id',
        traceUser: true
      });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.error('云开发初始化失败：旧云记录暂不可读，本机记录不受影响', error);
      this.globalData.cloudReady = false;
    }
  },

  /**
   * 冷启动核对文本恢复：没有恢复计划时立即返回，不碰档案。
   * 有持久提交时只按提交记录报告；没有提交键时保留 stage 原文与旧档，不自动启用。
   * 读取入口本身按提交键选代，所以这一步失败也不会让页面看到半新半旧的数据。
   */
  recoverLocalTextRestore() {
    try {
      const backup = require('./utils/training-backup.js');
      if (!backup || typeof backup.recoverPending !== 'function') return;
      const result = backup.recoverPending();
      if (result && result.ok === false && result.code && result.code !== 'nothing-to-recover') {
        console.warn('本机文本恢复提交检查未完成，现有档案与清单保持不变', result.code, result.error);
      }
    } catch (error) {
      console.warn('本机文本恢复提交检查失败，现有档案与清单保持不变', error);
    }
  },

  /**
   * 冷启动恢复长按删除的收尾：没有 journal 时立即返回（不碰文件系统）。
   * 任何异常只记录，不阻塞启动；单线记录页重开时还有一次可见的自动重试与手动重试。
   */
  recoverLocalAttemptDeletes() {
    try {
      const attemptDelete = require('./utils/training-attempt-delete.js');
      if (!attemptDelete || typeof attemptDelete.recoverPending !== 'function') return;
      const task = attemptDelete.recoverPending();
      if (task && typeof task.catch === 'function') task.catch(() => undefined);
    } catch (error) {
      console.warn('本机删除凭据恢复检查失败，记录与视频保持不变', error);
    }
  },

  /**
   * 冷启动恢复整场删除的收尾：独立 journal，没有 pending 时不碰文件系统。
   * 读取不到档案或凭据时整轮失败关闭，证据与视频都保持原样。
   */
  recoverLocalSessionDeletes() {
    try {
      const sessionDelete = require('./utils/training-session-delete.js');
      if (!sessionDelete || typeof sessionDelete.recoverPending !== 'function') return;
      const task = sessionDelete.recoverPending();
      if (task && typeof task.catch === 'function') task.catch(() => undefined);
    } catch (error) {
      console.warn('本机场次删除凭据恢复检查失败，记录与视频保持不变', error);
    }
  },

  globalData: {
    // 全局数据
    userInfo: null,
    // 云能力是否可用；false 时旧云记录走可判别失败，本机档案照常。
    cloudReady: false,
    // 攀岩类型选项
    climbTypes: ['抱石', '先锋攀', '顶绳攀', '室内', '室外'],
    // 完成状态选项
    statusOptions: ['完成', '未完成', '挂片', '红点']
  }
});
