# 岩馆快速记录 · 本地试用工程

独立的微信原生小程序工程，只用于离线试用与验收：

- 不连接云环境，不读取正式工程的记录；
- 岩馆、线路为虚构样例；场次、线路、尝试、待确认操作与模拟保存账本都只写本机；
- 在微信开发者工具中导入本目录（`devtools/gym-log/`）即可运行，不影响正式小程序。

## T008 弱网重试：开发者工具复现入口

页面：`pages/today/today`（今日攀爬）。所有操作都在本机完成，不需要云账号。

1. 选择岩馆/日期，点「开始场次」，再选一条线路。
2. 点顶部「弱网演练（本地模拟）」卡片里的
   **「模拟下一次保存回执丢失」**（`id=arm-receipt-loss`）。
   卡片会显示“已就绪：下一次保存会写入模拟账本，但客户端收不到回执（仅一次）”。
3. 点底部「未完成」或「完攀」：
   - 先出现 `保存中…` 的待确认行（`id=pending-attempt-N`）；
   - 随后显示 `保存失败 · 回执丢失，已保留`（`id=save-notice`），
     原来的第几把、结果和时刻都还在。
   - 这一把确认前，底部两个结果按钮保持 `disabled`，上方出现
     `id=result-locked-hint` 的提示。此时再点结果不会生成第二个待确认，
     必须先在原行重试。确认成功后按钮自动解锁，可以正常连记。
4. 点该行的 **「重试保存」**（`id=retry-attempt-N`，`data-op-id` 就是同一操作 ID）：
   - 保存端账本按操作 ID 幂等，不会新增第二条；
   - 行从待确认区转入已保存尝试，编号不变。
5. 再次点「未完成/完攀」会生成新的操作 ID，形成新的一把。
6. 关闭页面重新进入，或在待确认时返回再进入：待确认行仍在，重试不会重复入账。
7. 跨实例交错（开发者工具可用「编译模式 → 重新启动」模拟重新进入）：
   旧页面的延迟回执晚于新页面的重试/新尝试到达时，客户端只按 `opId`
   核销或合并该操作，不会用旧快照覆盖新的场次、备注、尝试或序号；
   已卸载的旧页面不会写回任何缓存。

### 本地复核用的隔离方式

本工程现有页面只使用前两个专用缓存键；T010 新增的照片服务使用后两个键
和专用文件目录（页面接入在 T011，尚未调用）。复现前只删除/重置这四个键，
不要调用 `clearStorageSync` 清空开发者工具里的其他业务数据。
Node 回归测试使用内存缓存与可控文件替身，不触碰本机微信存储。

可复核的本机缓存键：

| 键 | 内容 |
|---|---|
| `climbingNote.gymLogTrial.v1` | 客户端数据：场次、线路、已保存尝试、待确认操作 |
| `climbingNote.gymLogTrial.saveLedger.v1` | 模拟保存端账本：按 `opId` 幂等，含“下一次丢回执”开关 |
| `climbingNote.gymLogTrial.photos.v1` | 照片索引：归属、photoId、local 位置、尺寸/字节与操作状态（受保护） |
| `climbingNote.gymLogTrial.photoThumbs.v1` | 缩略图元数据（可重建缓存，不参与照片身份） |

照片文件位于 `<USER_DATA_PATH>/gym-log-trial-photos/v1/`，主图在 `main/`、
缩略图在 `thumb/`。每个文件名都是 `photo-<seq>.jpg`；目录内不存放其他业务文件。

四个键与服务文件都在本机，属于试用/测试数据；真实跨设备、服务端权限与并发幂等仍待验。

## T010 线路照片持久服务（仅本机，页面尚未接入）

`utils/photo-files.js` 封装真实文件、压缩、尺寸/体积读取和缩略图操作；
`utils/route-photos.js` 负责一条长期线路至多一张主照片的归属、索引和失败恢复。
本服务不访问云、不读取正式记录，也不属于 T009 打包范围（整个 `devtools/gym-log/`
在正式包排除清单中）。

### 数据版本与专用存储

| 项 | 值 |
|---|---|
| 索引键 | `climbingNote.gymLogTrial.photos.v1`（`INDEX_VERSION = 1`） |
| 缩略图缓存键 | `climbingNote.gymLogTrial.photoThumbs.v1`（`THUMB_CACHE_VERSION = 1`） |
| 文件根目录 | `<USER_DATA_PATH>/gym-log-trial-photos/v1/` |
| 存储类型 | 本轮只有 `{ type: 'local', location }`；`photoId` 与 `location` 分开保存 |

索引结构（只读摘要）：

```text
{
  version: 1,
  nextPhotoSeq, nextOpSeq,
  routes: [ { ownerId, datasetId, routeId, photoId, rev, activeOpSeq } ],
  photos: [ { photoId, ownerId, datasetId, routeId,
              storage: { type: 'local', location },
              width, height, bytes: { main, thumb }, createdAt } ],
  operations: [ { opId, seq, instanceId, ownerId, datasetId, routeId,
                  kind: add|replace|remove,
                  status: started|committed|failed|aborted,
                  photoId, basePhotoId, baseRev,
                  startedAt, finishedAt, error } ]
}
```

- `routes` 是“用户 + 数据集 + 稳定线路 → 当前主照片”的关联，移除后保留
  `photoId: ''` 的墓碑与 `rev`/`activeOpSeq`，防止旧回调恢复已移除照片。
- `photos` 只保存当前主照片的文件元数据；被更换或移除的旧记录不会保留。
- `operations` 是操作状态与幂等依据，不是普通日志；不要把它当成缓存清理。
- 缩略图元数据在独立缓存键中，丢失后可从主图重建，不影响主照片索引。

### 服务契约

```js
const { createWxPhotoFiles } = require('../../utils/photo-files');
const { createRoutePhotoService } = require('../../utils/route-photos');

const photos = createRoutePhotoService({
  ownerId: 'trial-user-a',      // 试用身份注入；不得用昵称、头像或全局当前线路
  datasetId: 'trial-dataset-1', // 试用数据集；重置时更换新值，不能沿用旧值
  files: createWxPhotoFiles()   // 页面也可注入可控替身做测试
});

await photos.recover(); // 页面/服务初始化时调用一次：中止上次未完成操作并清理孤儿
```

| 方法 | 说明 |
|---|---|
| `addPhoto({ routeId, sourcePath, opId })` | 线路无照片时新增；已有照片返回 `already-has-photo` |
| `replacePhoto({ routeId, sourcePath, opId })` | 更换主照片；失败保留旧照片 |
| `removePhoto({ routeId, opId })` | 移除指定归属的主照片；失败返回可恢复状态 |
| `getRoutePhoto({ routeId })` | 按归属读取当前主照片、缩略图与可用性 |
| `getPhoto({ photoId })` | 按 photoId 读取，自动校验 owner/dataset；不返回其他归属 |
| `rebuildThumbnail({ photoId })` | 从主图重建缩略图；主图缺失返回 `missing-file` |
| `cleanupOrphans()` | 只清理 main/thumb 目录中不被索引或进行中操作引用的本服务文件 |
| `recover()` | 中止 `started` 操作、修剪缩略图缓存、清理孤儿文件 |
| `listPhotos()` | 当前 owner/dataset 的照片记录与字节合计（供容量功能使用） |

所有方法都返回普通对象：

```text
成功: { ok: true, ... }
失败: { ok: false, code, error, recoverable }
```

调用方必须用 `ok` 判断是否显示“已保存到本机”；不能只看返回文案或本地乐观状态。
稳定的错误码包括 `missing-owner`、`missing-dataset`、`missing-route`、
`already-has-photo`、`no-photo`、`operation-in-progress`、`stale-operation`、
`index-broken`、`index-write-failed`、`compress-failed`、`file-write-failed`、
`thumbnail-failed`、`missing-file`、`file-delete-failed`。

### 归属与幂等规则

- 归属在操作启动时固定为当前的 `ownerId + datasetId + routeId`，写入索引后才开始
  读临时文件和写文件；后续回调只按 `opId` 与索引里的归属核对。
- 缺少 `ownerId` / `datasetId` / `routeId` 直接返回可识别错误，不写文件、不写索引。
- 同一 `opId` 重复或并发调用：已提交返回 `duplicate: true` 和同一 `photoId`；
  仍在执行返回 `operation-in-progress`，不会再次压缩/写文件。
- 每个线路有单调递增的 `activeOpSeq`。较旧操作在新操作启动后才完成时返回
  `stale-operation`，不会覆盖新照片、恢复已移除照片或写入其他线路。
- `photoId` 只在新增/更换时分配，不使用临时路径；路径变化不改变照片身份。
- 以上都是虚构身份的注入测试；真实微信账号隔离另列验收，不能据此宣称已通过。

### 保存、更换、移除与恢复

1. **新增/更换**：先把 `status: started` 的操作写入索引；主图压缩并写入
   `main/photo-<seq>.jpg`，缩略图写入 `thumb/photo-<seq>.jpg`，最后才提交索引
   （同时把操作标为 `committed`）。文件和索引任一失败都不返回成功。
2. **失败清理**：新增失败或索引提交失败时，只删除本次 `photoId` 对应、且索引中
   没有引用的文件；索引不可读时不删除任何用户文件。
3. **更换失败**：索引未切换，旧主图与旧关联保持不变；用同一 `opId` 重试成功后
   才删除旧文件。若旧文件删除失败，返回成功但带 `cleanupError`，旧文件作为
   可证明无引用的孤儿留给 `cleanupOrphans()`/`recover()`。
4. **移除**：先提交“线路不再引用”的索引，再删除主图与缩略图。索引失败时旧照片
   仍可读；文件删除失败返回 `file-delete-failed` 与 `associationRemoved: true`，
   不虚报成功，可用同一 `opId` 重试清理。
5. **重启恢复**：新服务实例先 `recover()` 会把上次 `started` 的操作标为 `aborted`，
   再清理 `main/`、`thumb/` 中不被索引引用的 `photo-*.jpg`；仍被照片记录引用的
   主图/缩略图不会被删除。索引损坏时拒绝重建，只返回 `index-broken`。
6. **读取缺失文件**：`getRoutePhoto` 返回 `ok: false, code: 'missing-file', photo`，
   保留 photoId/归属供页面显示“本机照片不可用，可重新添加”，绝不改读其他线路。

### 压缩与缩略图策略

- 主图按最长边 2048 px、质量 80 等比缩放；缩略图按最长边 320 px、质量 70。
  只缩放、不裁剪，保持整幅画面。
- 300–800 KB/张是试验目标，不是已核验的硬上限，也不会成为保存失败的判据；
  结果里的 `photo.overTrialTarget` 只表示超过 800 KB 目标。
- 缩略图是可重建缓存：`thumbnail.available === false` 时主图仍可读，可调用
  `rebuildThumbnail` 重建；清缓存不应清除主图或 `photos.v1` 索引。
- 保存时缩略图从“刚压缩好的临时主图”生成，和持久主图内容一致，也不依赖
  压缩器读取用户文件目录里的持久路径。
- 开发者工具实测（`2.02.2609240`，SDK `2.25.4`）：`wx.compressImage` 对
  `http://usr/...` 持久路径返回 `compressImage:fail file doesn't exist`，对
  `http://tmp/...` 临时路径正常。因此保存流程使用选择器/下载得到的临时路径；
  仅“缩略图丢失后从持久主图重建”在开发者工具受限，真机或 T012 的页面级临时源
  另验，不能把开发者工具结果当成真机通过。
- 压缩质量与尺寸常量集中在 `route-photos.js` 的 `PHOTO_POLICY`；真机岩点清晰度、
  实际容量和系统空间不足仍待验。

### 将来本机转云端的保留方式

本轮只实现 local，不发起任何上传。后续迁移可用同一 `photoId`，把
`storage` 从 `{ type: 'local', location }` 改为云端位置；`location` 不是跨设备
地址，旧本机路径不能当成云文件 URL。迁移必须由仍持有文件的手机执行，先上传并
确认云文件可用，再切换线路引用；上传或切换失败可重试并保留原本机状态。
文件丢失、只剩索引时要求重新添加，不能把其他手机路径当待上传文件。

### 离线验证与开发者工具验证

```powershell
node --test tests/route-photos.test.cjs
node --test tests/*.test.cjs
```

- `tests/route-photos.test.cjs` 覆盖 PS01–PS06：临时文件失效后重建读取、
  A/B 与数据集隔离、压缩/写文件/索引失败、更换失败保旧、移除失败、
  迟到回调、孤立文件清理，以及用 Node 实际磁盘执行真实文件适配器。
- 开发者工具验证步骤（真实 `wx` 文件系统，证据放仓库外）：

  1. 在开发者工具导入 `devtools/gym-log/`，确保不启用云开发。
  2. 在调试器 Console 或自动化入口先 `require` 两个服务模块，选择一段虚构或
     生成的样例图（不得使用真实个人照片），调用：
     `photos.addPhoto({ routeId: '<稳定线路ID>', sourcePath: '<选择器临时路径>', opId: 'manual-1' })`。
  3. 断言返回 `ok: true`，记录 `photoId`、`photo.storage.location`、主图/缩略图字节；
     删除选择器临时文件或用新页面重新加载后，创建新服务实例调用
     `getRoutePhoto({ routeId })`，应读到同一 `photoId` 和持久主图。
  4. 重载小程序后再执行一次读取；记录文件管理器中的 `main/photo-*.jpg` 与
     `thumb/photo-*.jpg`，以及两个专用索引键。
  5. 截图、命令与原始返回放 `D:/climbing_note/_batch-evidence/T010/`，不提交仓库。

  真机拍照/相册权限、退出微信后的文件保留、实际压缩画质与正式账号隔离均为
  **待验**；本服务不是完整照片 UI，页面接入见 T011。
