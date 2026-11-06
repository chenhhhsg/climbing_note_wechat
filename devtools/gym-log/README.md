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

本工程页面使用七个专用缓存键和专用照片目录：前两个键保存场次/尝试与模拟账本，
第三、四个键保存照片索引和可重建缩略图元数据，最后三个是并发协调数据
（活跃实例租约、在途预留与文件删除声明）。复现前只删除/重置这七个键，
不要调用 `clearStorageSync` 清空开发者工具里的其他业务数据。
Node 回归测试使用内存缓存与可控文件替身，不触碰本机微信存储。

可复核的本机缓存键：

| 键 | 内容 |
|---|---|
| `climbingNote.gymLogTrial.v1` | 客户端数据：数据集标识、场次、线路、已保存尝试、待确认操作 |
| `climbingNote.gymLogTrial.saveLedger.v1` | 模拟保存端账本：按 `opId` 幂等，含“下一次丢回执”开关 |
| `climbingNote.gymLogTrial.photos.v1` | 照片索引：归属、photoId、local 位置、尺寸/字节与操作状态（受保护） |
| `climbingNote.gymLogTrial.photoThumbs.v1` | 缩略图元数据（可重建缓存，不参与照片身份） |
| `climbingNote.gymLogTrial.photoInstances.v1` | 活跃实例租约：运行期标识与实例心跳（可重建协调数据） |
| `climbingNote.gymLogTrial.photoReservations.v1` | 在途字节预留：并发保存/重建共享同一份已预留预算（可重建协调数据） |
| `climbingNote.gymLogTrial.photoDeletes.v1` | 文件删除声明：异步 unlink 期间的忙状态（可重建协调数据） |

照片文件位于 `<USER_DATA_PATH>/gym-log-trial-photos/v1/`，主图在 `main/`、
缩略图在 `thumb/`。每个文件名都是 `photo-<seq>.jpg`；目录内不存放其他业务文件。

七个键与服务文件都在本机，属于试用/测试数据；真实跨设备、服务端权限与并发幂等仍待验。
后三个键是并发协调数据：删除它们不会丢照片，只会让进行中的预留、删除声明与实例
存活判定重置。

## T011 页面照片接入：添图、跨天展示、更换与移除

页面：`pages/today/today`（今日攀爬）和 `pages/route-detail/route-detail`（线路详情）。
一条长期线路最多一张主照片，照片可选；照片文件和关联都只保存在本机。

### 入口

| 入口 | 位置 | 行为 |
|---|---|---|
| 新建线路 | 今日页「＋ 快速新建线路」表单里的「线路照片（可选）」 | 可先拍照/从相册选图并预览；创建线路后保存，照片失败不回滚线路 |
| 今日当前线路 | 「本场记录」下「线路照片」卡片 | 添图、预览确认、更换、移除、失败重试 |
| 历史/选线路 | 线路列表中的缩略图与「加照片/换照片」按钮 | 列表显示同一主图的缩略图；点按钮先选中线路，再选择拍照或相册 |
| 线路详情 | 详情页「线路照片」卡片 | 展示完整主图，点击进入原生预览可双指缩放；也可添图、更换、移除 |

### 使用与状态

1. 点「拍照」或「从相册选择」；选择器只请求一张图片，
   `sourceType` 分别为 `camera` / `album`。
2. 选择后先显示预览，点「确认保存」才开始压缩和写入；点「取消」不改变原照片。
3. 保存中显示「照片保存中…」；文件与索引都完成后才显示
   「已保存到本机」并提示一次。失败时卡片显示原因和「重试保存」，
   已有照片、场次、尝试和备注保持可用；照片操作不锁住底部记尝试按钮。
4. 已有照片时再次选择进入更换流程：失败仍显示并可预览旧图，
   成功后各入口读取同一 `photoId` 和新主图。移除前弹窗说明
   “只在本机保存一份，移除后需要重新添加”；取消不变，成功后显示
   「添加线路照片（可选，可稍后添加）」并可重新添加。
5. 主图文件缺失时显示「本机照片不可用，可重新添加」，
   只影响当前线路，不展示其他线路照片；重新添加使用更换流程替换原关联。
6. 设备/微信清理本地文件后不会自动恢复；缩略图缺失时列表回退到主图路径，
   可重建缩略图属于 T012 的缓存管理范围。

### 重置试用数据与照片保护

- 本机已有照片时，点「重置本地试用数据」会先弹窗说明照片文件和关联索引属于用户资料：
  取消不改变任何照片、线路或尝试；确认后清空场次、线路、尝试与模拟账本，
  并把客户端切换到新的试用数据集。
- 确认重置不会删除旧照片文件或照片索引；旧数据集的照片保留在本机，
  但不会再挂到重置后可能复用的 `route-local-1` 等线路编号上。
- 没有照片时重置直接清空客户端场次/尝试与模拟账本，数据集保持不变。
- 重置写入失败时恢复重置前的模拟账本，原场次、尝试、照片与索引全部保留，可重试。
- 普通清缓存、容量统计与旧数据集照片管理见下文 T012。

### 试用身份与数据集

- 照片服务的 `ownerId`、`datasetId` 集中在 `utils/trial-profile.js`：
  `trial-user-local-a` / `trial-dataset-local-1`，均为虚构值，不代表微信账号。
- 旧版客户端缓存没有 `datasetId` 时，读取会补当前虚构数据集标识，
  原场次、线路、尝试与备注保留；下一次写入才持久化该字段。
- 今日页没有场次时不读取照片索引；有场次后通过 `utils/trial-photos.js`
  取得共享服务，`recover()` 每个 JS 上下文只执行一次；运行期身份与内存执行登记
  共同区分“同一上下文仍活跃的实例/归属”和“真正重启或 promise 已结束的遗留”，
  不会打断仍活跃的保存。

### 隔离排查

- 页面和控制器只读写上述七个专用键及 `gym-log-trial-photos/v1/`，
  不使用 `clearStorageSync`，不访问云或正式记录。
- 要重跑本机走查，只删除这七个键和该照片目录即可；不要递归清空整个用户目录。
- 开发者工具中自动化的选片步骤可用 mock `wx.chooseMedia` 返回生成的临时图片；
  文件写入、压缩和索引仍由真实 `wx` 文件系统执行。真机拍照/相册权限另验。

## T012 照片空间提醒、普通缓存保护与整批验收

页面：`pages/today/today`。容量卡片位于顶部试用横幅下方；开始场次后显示
实际照片占用、提醒线和「管理照片空间」入口。线路详情在空间不足时提供
“返回今日页管理照片空间”。

### 试用预算与计量口径

| 项 | 值 | 含义 |
|---|---|---|
| 预算 B | `100 MiB` = `104857600` 字节 | 应用自设的照片保存上限 |
| 提醒线 W | `80 MiB` = `83886080` 字节 | 达到即显示提醒与管理入口 |
| 更换余量 R | `10 MiB` = `10485760` 字节 | 新增/更换必须预留的空间 |
| 换算 | `1 MiB = 1024 × 1024` 字节 | 与平台“可用空间”不是同一口径 |

- 这些是应用自设上限，**不是微信或设备可用空间保证**；真机实际容量和系统
  空间不足另列待验。
- 统计直接逐项读取 `main/`、`thumb/` 中每个受管文件的实际字节，不使用
  `photos[].bytes` 里的写入时估值。同一线路在不同场次/日期查看不会重复计费。
- 未完成操作留下的文件、失败后残留的孤儿文件同样计入实际占用；只有
  `cleanupOrphans()` 能证明无引用后才可清理。
- 预算检查发生在压缩完新主图/缩略图、写入受管目录之前：
  当前实际占用 + 先到的在途预留 + 新主图 + 新缩略图 + R ≤ B 才继续。更换时旧文件仍在，
  峰值天然计入新旧共存，**不会先删旧照片制造空间**。
- 阈值与预算集中在 `utils/photo-space.js` 的 `PHOTO_SPACE_POLICY`，
  测试可通过 `setTrialSpacePolicy()` 注入小数值；页面不提供放宽预算的入口。
- 实际写入返回 `no space`/`ENOSPC`/“空间不足”等错误时，同样归为
  `space-insufficient`，保留旧照片、索引、场次和尝试，并显示重试与管理入口。

### 并发、预留与恢复约定（T012 第三轮返工补充）

- **所有新增受管字节的路径都受同一份预算约束**：新增、更换和缩略图重建在写入前
  都先在 `photoReservations.v1` 登记一笔在途预留（字节数取待写入文件的真实大小）。
  预算检查口径是 `实际占用 + 先到预留 + 本次新增 + R ≤ B`。
- **先到先得**：预留按登记顺序排序，后到的并发操作会看到先到的预留并被拒绝，
  返回可恢复的 `space-insufficient`，旧照片与索引不变；前一笔结束（成功/失败/中止）
  后预留立即释放，同一 `opId` 可重试。并发时最多一笔会成功，实际占用不会越过预算。
- **预留可自愈**：如果释放预留的协调写入失败，残留预留不会永久挡住后续保存。
  下一次登记或 `recover()` 会按操作终态（failed/aborted/committed）回收它；
  同一 `opId` 重试会取代该操作的旧预留。仍为 `started` 的操作、其他运行期的
  活跃预留不会被误删。
- **协调写失败先停手**：实例租约或预留无法可靠写入时，保存会在写入
  受管主图/缩略图前返回可恢复的 `coordination-failed`；不会出现“未持久化存活
  状态却继续写入、随后被其他实例当孤儿删掉”的路径。故障解除后同 `opId` 可重试。
- **重建也算写入**：`rebuildMissingThumbnails()` / `rebuildThumbnail()` 与保存共享
  同一份预留；预算不足时该项重建失败并说明原因，主图与已有缩略图不变。
- **运行期、服务实例与真实执行是三层概念**：模块加载时生成 `runtimeId`，同一 JS
  运行期的多个服务实例（不同页面、owner/dataset）共享它；模块级内存登记
  `RUNTIME_ACTIVITY` 再记录每个服务实例的保存/重建/删除声明当前是否真的还在执行。
  `recover()` 先用 `runtimeId` 排除其他运行期的遗留，再对同一运行期只保留登记仍在的
  `started` 操作：后台暂停或长 await 超过 5 分钟租约也不会被误中止；promise 已经结束、
  只是终态写回失败留下 `started` 的操作，同运行期新实例可以立即中止并允许同 `opId`
  重试。重启小程序/进程后共享登记随模块消失，无需等待 TTL 即可恢复中断保存并重试。
  重置/切换试用数据集时，页面入口会显式放弃旧数据集自己的未完成操作
  （`abandonStartedOperations()`），不影响其他归属。
- **异步删除与重试串行化**：真正 unlink 前先在 `photoDeletes.v1` 登记
  `{ photoId, runtimeId, instanceId }` 删除声明，并在异步边界后再次按最新索引、
  在途预留复查引用。保存/重建遇到声明时返回可恢复的 `cleanup-in-progress`，
  不写入或提交；声明结束后同 `opId` 重试成功。同一运行期只保护登记仍在的删除
  promise：unlink 已结束但释放声明写回失败时，同运行期新实例的 `recover()` 可回收
  该残留；另一个实例真实进行中的删除声明继续保留。旧运行期的遗留声明在下一次
  `recover()` 时立即失效，不需要等 TTL。
- **协调残留的 finally 边界**：预留与删除声明都在开始后写入共享登记，并在各自的
  `finally` 结束路径先移除登记、再尝试持久释放；写出失败只留下可回收残留，不会让
  已结束的 promise 永久占用预算或永久返回 `cleanup-in-progress`。没有对应操作记录
  的重建预留同样按共享登记回收，其他运行期或旧版数据仍按租约/版本兼容处理。
- **维护与写操作协调**：`cleanupOrphans()` 与 `clearRebuildableCache()` 在读取文件
  清单之后，逐个候选文件按**最新**索引、进行中操作、在途预留与删除声明重新确认
  引用关系：刚提交的主图/缩略图不会被过期快照删除；清缓存期间新保存照片的缩略图
  与其元数据保留。删除声明写入失败时保留文件，不冒险删除用户照片。
- **迟到的缩略图重建不会写回已移除照片**：重建在写入前后各复查一次照片记录，
  已移除/已更换时撤销写入并返回可识别失败，不留孤儿缩略图或缓存条目。
- **照片卡字节口径**：照片卡显示当前**实际可用**的缩略图字节（`photo.thumbnail.bytes`），
  缩略图缺失时不显示旧占用；清缓存/重建/重开后与真实文件、缩略图缓存元数据和空间卡一致。

### 普通清缓存与管理

| 入口 | 作用 | 不处理 |
|---|---|---|
| `清除可重建缓存` | 删除 `thumb/photo-*.jpg` 与缩略图元数据键 | 主图、照片索引、场次、尝试、备注、待确认操作、其他缓存键；清缓存期间新保存照片的缩略图保留 |
| `重建缺失缩略图` | 从持久主图重建当前试用用户当前数据集与保留旧数据集的缺失缩略图 | 不改变主图字节、photoId 或关联；受预算与在途预留约束 |
| `清理无引用文件` | 只删除索引、进行中操作与在途预留都不引用的本服务文件 | 仍被线路引用的主图/缩略图；按最新引用逐项确认后才删除 |

- 有照片操作正在保存/移除时，页面与照片服务都会拒绝清缓存，避免删掉正在
  写入的缩略图。
- 清缓存后列表缩略图回退到主图路径，重开页面仍可从主图预览；缩略图缺失
  时显示“可从主图重建”。
- 开发者工具对持久 `http://usr` 路径调用 `wx.compressImage` 会报
  `file doesn't exist`；重建缩略图因此增加离屏画布回退
  （`createOffscreenCanvas` + `canvasToTempFilePath`），不依赖压缩器读取持久路径。
  该回退仍需在开发者工具与真机分别留证。

### 重置与旧数据集

- 取消重置不改变场次、尝试、照片、索引或账本。
- 有照片时确认重置会轮换 `datasetId`：旧照片文件和索引保留在本机旧数据集，
  不会挂到重置后复用的 `route-local-N` 新线路上。
- 重置写入失败时恢复重置前的模拟账本，原资料与照片全部保留，可直接重试。
- 重置前发出的照片回调按数据集/代次失效，不会把旧照片写进新数据集视图。
  原生选片、来源弹层与确认弹窗都在**发起时**固定数据集/代次：重置或切线后
  迟到的选择/确认会被丢弃，不会绑到新数据集的同编号线路上（无照片重置即使
  不轮换数据集也会清空页面上下文）。
- 旧数据集照片仍占用本机实际空间，照片空间卡片会如实计入；本轮不自动删除
  用户唯一主图，也不递归清空用户文件目录。

### 负责人整批验收（T010–T012 同一候选）

1. 在微信开发者工具导入 `devtools/gym-log/`，确认未启用云开发；准备两张
   生成的虚构样例图（不得使用真实个人照片）。
2. 开始场次，任选一条线路（可跳过照片）。记两次未完成，给第二把补备注。
3. 给该线路添加照片：选择后先预览，确认后显示“已保存到本机”；四处入口
   （今日当前线路、历史列表、线路详情、新建线路）显示同一主图。
4. 新建场次并把日期改为两天后，从历史回到同一条线路再记一次完攀；
   详情仍为两天三把、原备注保留；同色同级另一条线不串图。
5. 更换照片时先制造失败（可临时关闭文件写入或用测试注入），确认旧图仍可
   预览；恢复后更换成功，各入口切换到新图。
6. 返回今日页查看「照片空间」：显示实际占用/预算/提醒线与管理入口；
   记录一张照片前后主图、缩略图与总占用变化。
7. 点「清除可重建缓存」：确认主图、照片索引、场次、尝试、备注和待确认
   操作仍在；重开页面仍可预览主图；照片卡不再显示缩略图字节（缩略图已删），
   点「重建缺失缩略图」后照片卡显示重建后的**真实**缩略图字节，并与
   「照片空间」卡里的缩略图占用一致。
8. 重置试用数据：先取消确认无变化；再确认并检查旧照片保留、新线路编号
   不继承旧照片；模拟客户端写入失败时应提示“重置未完成”且资料保留。
9. 执行 `node --test tests/*.test.cjs`，要求全部通过、0 跳过；在真实候选上
   重新构建正式包并运行 `scripts/check-package.cjs`，确认
   `devtools/gym-log/`、`tests/`、`tasks/`、`docs/` 等未进入正式包。
10. 证据放 `D:/climbing_note/_batch-evidence/T012/`，不提交仓库。

### 待验与不覆盖范围

- **待验**：真机拍照/相册权限、退出微信后的文件保留、真实设备空间耗尽与
  系统配额、压缩后岩点清晰度、真实微信账号切换/隔离、正式清缓存入口。
- 开发者工具的选片、弹窗与身份切换可 mock；文件写入、压缩、画布回退与索引
  仍应使用真实接口，并在报告中区分。
- 本轮只覆盖独立试用工程 `devtools/gym-log/`，不改正式页面、正式清缓存入口、
  AppID、云环境或正式数据；云上传/迁移不在本批。

## T010 线路照片持久服务（仅本机）

`utils/photo-files.js` 封装真实文件、压缩、尺寸/体积读取和缩略图操作；
`utils/route-photos.js` 负责一条长期线路至多一张主照片的归属、索引和失败恢复。
本服务不访问云、不读取正式记录，也不属于 T009 打包范围（整个 `devtools/gym-log/`
在正式包排除清单中）。

### 数据版本与专用存储

| 项 | 值 |
|---|---|
| 索引键 | `climbingNote.gymLogTrial.photos.v1`（`INDEX_VERSION = 1`） |
| 缩略图缓存键 | `climbingNote.gymLogTrial.photoThumbs.v1`（`THUMB_CACHE_VERSION = 1`） |
| 活跃实例租约键 | `climbingNote.gymLogTrial.photoInstances.v1`（`INSTANCE_LEASE_VERSION = 1`） |
| 在途预留键 | `climbingNote.gymLogTrial.photoReservations.v1`（`RESERVATION_VERSION = 1`） |
| 文件删除声明键 | `climbingNote.gymLogTrial.photoDeletes.v1`（`DELETION_VERSION = 1`） |
| 文件根目录 | `<USER_DATA_PATH>/gym-log-trial-photos/v1/` |
| 存储类型 | 本轮只有 `{ type: 'local', location }`；`photoId` 与 `location` 分开保存 |

租约、预留与删除声明是**索引之外**的独立键，不参与照片身份，也不改变 `photos.v1`
的结构（因此旧索引无需迁移）：租约记录
`{ instanceId, runtimeId, ownerId, datasetId, heartbeatAt, heartbeatMs }`，
预留记录 `{ reservationId, instanceId, runtimeId, ownerId, datasetId, photoId, opId, kind, bytes, claimSeq, startedAt }`，
删除声明记录 `{ claimId, instanceId, runtimeId, ownerId, datasetId, photoId, claimSeq, startedAt }`。
三者丢失后可从后续操作重新建立，不会丢照片；`runtimeId` 缺失的旧版记录按租约 TTL 兼容处理。
此外，模块级内存登记 `RUNTIME_ACTIVITY`（**不落盘**）记录同一运行期内每个服务实例的
操作/预留/删除声明是否仍有未结束的 promise。它只在当前 JS 运行期有效：重启后自然清空，
持久键里的 `started`/声明/预留只有在登记仍存在时才被视为真实活跃；登记已结束的残留
由同运行期新实例在故障解除后回收。不同运行期或不同实例标识不会互相释放。

索引结构（只读摘要）：

```text
{
  version: 1,
  nextPhotoSeq, nextOpSeq,
  routes: [ { ownerId, datasetId, routeId, photoId, rev, activeOpSeq } ],
  photos: [ { photoId, ownerId, datasetId, routeId,
              storage: { type: 'local', location },
              width, height, bytes: { main, thumb }, createdAt } ],
  operations: [ { opId, seq, instanceId, runtimeId, ownerId, datasetId, routeId,
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
  ownerId: 'trial-user-local-a',      // 与 utils/trial-profile.js 一致；不得用昵称、头像或全局当前线路
  datasetId: 'trial-dataset-local-1', // 与 utils/trial-profile.js 一致；安全重置时更换新值，不能沿用旧值
  files: createWxPhotoFiles()   // 页面也可注入可控替身做测试
});

await photos.recover(); // 页面/服务初始化时调用一次：中止其他运行期或已结束 promise 留下的操作，回收已结束的预留/删除声明并清理孤儿
```

| 方法 | 说明 |
|---|---|
| `addPhoto({ routeId, sourcePath, opId })` | 线路无照片时新增；已有照片返回 `already-has-photo`；写入前登记在途预留并检查峰值 |
| `replacePhoto({ routeId, sourcePath, opId })` | 更换主照片；失败保留旧照片；同样受预算与在途预留约束 |
| `removePhoto({ routeId, opId })` | 移除指定归属的主照片；失败返回可恢复状态 |
| `getRoutePhoto({ routeId })` | 按归属读取当前主照片、缩略图与可用性；`bytes.thumb` 反映当前实际缩略图（缺失为 0） |
| `getPhoto({ photoId })` | 按 photoId 读取，自动校验 owner/dataset；不返回其他归属 |
| `rebuildThumbnail({ photoId })` | 从主图重建缩略图；主图缺失返回 `missing-file`；受预算约束，照片已移除时返回 `not-found` |
| `cleanupOrphans()` | 只清理 main/thumb 目录中不被照片记录、进行中操作、预留或删除声明引用的本服务文件（逐项按最新引用确认） |
| `recover()` | 中止其他运行期或同运行期已结束 promise 留下的 `started` 操作，回收已结束的预留与删除声明、修剪缩略图缓存、清理孤儿文件；登记仍在的活跃操作/删除继续保留 |
| `abandonStartedOperations()` | 显式放弃本 owner/dataset 的未完成操作；仅用于试用数据集切换/重置，正常恢复不会调用 |
| `listPhotos()` | 当前 owner/dataset 的照片记录与字节合计（供容量功能使用） |
| `clearRebuildableCache()` | 只删可重建缩略图与其元数据；跳过清缓存期间新出现的照片缩略图 |
| `rebuildMissingThumbnails()` | 批量重建缺失缩略图；受预算约束，返回 `{ rebuilt, failed }` |

所有方法都返回普通对象：

```text
成功: { ok: true, ... }
失败: { ok: false, code, error, recoverable }
```

调用方必须用 `ok` 判断是否显示“已保存到本机”；不能只看返回文案或本地乐观状态。
稳定的错误码包括 `missing-owner`、`missing-dataset`、`missing-route`、
`already-has-photo`、`no-photo`、`operation-in-progress`、`stale-operation`、
`coordination-failed`、`cleanup-in-progress`、`index-broken`、`index-write-failed`、
`compress-failed`、`file-write-failed`、`thumbnail-failed`、`space-insufficient`、
`space-measure-failed`、`missing-file`、`file-delete-failed`。
其中 `coordination-failed`、`cleanup-in-progress` 都是可恢复的忙/失败状态：
前者表示租约或预留无法可靠写入（本次未动受管文件），后者表示旧文件正在清理；
稍后重试同一 `opId` 即可。

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
5. **重启恢复**：新服务实例先 `recover()`，只把“租约已过期或从未登记”的实例留下的
   `started` 操作标为 `aborted`，并释放这些实例的预留；仍活跃实例（含其他 owner/dataset）
   的进行中操作不会被中止，其主图也不会被清理。随后清理 `main/`、`thumb/` 中不被
   照片记录、进行中操作或预留引用的 `photo-*.jpg`。索引损坏时拒绝重建，只返回 `index-broken`。
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
node --test tests/gym-log-photos.test.cjs
node --test tests/*.test.cjs
```

- `tests/route-photos.test.cjs` 覆盖 PS01–PS09：临时文件失效后重建读取、
  A/B 与数据集隔离、压缩/写文件/索引失败、更换失败保旧、移除失败、
  迟到回调、孤立文件清理，以及用 Node 实际磁盘执行真实文件适配器；
  PS07 另覆盖并发保存的在途预留、重建预算、清缓存/清理与保存交错、
  重建与移除交错、活跃实例不被 `recover()` 中止与遗留恢复、
  读取结果按当前实际缩略图报告字节；PS08 覆盖预留释放写失败后的自愈、
  租约写失败安全拒绝、同一运行期超过 TTL 的保护、新运行期立即恢复、
  异步 unlink 与同 `opId` 重试的串行化，以及真实子进程在 TTL 内重启后
  中止遗留保存并成功重试；PS09 覆盖同运行期已结束 promise 的跨实例恢复：
  删除声明释放 remove/set 失败、另一删除仍活跃时的区分保护、
  committed/failed 终态写回失败、无 `opId` 重建预留残留，均由新实例
  `recover()` 回收后同 `opId` 重试成功。
- `tests/gym-log-photos.test.cjs` 覆盖 PU01–PU05：相册/拍照参数、预览确认、
  权限拒绝、压缩/写文件/索引失败重试、缺文件重新添加、两天三把与四处一致、
  更换/移除、切线路与退出重进、安全重置和旧缓存 datasetId 兼容；
  PU05 另覆盖选片期间重置（当前线路、快速新建、数据集不变）与来源弹层、
  移除确认弹窗迟到回调失效。
- `tests/photo-lifecycle.test.cjs` 覆盖 PL01–PL07：容量计量与提醒、峰值检查、
  普通清缓存范围、重置隔离、身份隔离、整批交接；PL07 覆盖并发保存预留、
  重建预算、真实文件适配器上的清缓存/清理/重建交错、实例恢复与照片卡字节口径。
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
  **待验**；页面接入与走查步骤见上文 T011 章节。
