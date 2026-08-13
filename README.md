# 拼豆图纸生成器 - 微信小程序（云开发版，广告解锁）

Web 版「像素工坊」的同风格微信小程序版本，核心功能一致：

- 上传图片 / 新建空白画布，网格化采样并映射拼豆色号
- 手绘编辑（画笔 / 橡皮 / 撤销 / 重做 / 清空）
- 可选 AI 优化（火山引擎接口，由云函数代签）
- 色号用量统计
- 看激励视频广告解锁 AI 优化与图纸下载（带 Code 图纸、无 Code 图纸、CSV 清单）
- 未解锁时预览画布带「解锁后无水印」水印
- 图纸方案本地自动存档 / 恢复 / 清除
- 项目库：图纸云端保存（`projects` 集合 + 云存储），跨设备恢复，含原图 / 预览图
- 图纸分享：生成后可分享给微信好友，对方点开分享卡片可直接查看原图、预处理图与图纸网格，并可一键导入继续编辑
- 意见反馈

## 架构（云函数版）

本版本基于微信云开发，不再依赖任何自建服务器 / HTTP 域名。

| 部分 | 实现 | 说明 |
| --- | --- | --- |
| 前端页面 | 小程序原生 | `pages/index`、`pages/feedback-success`、`pages/share` |
| 后端逻辑 | 云函数 `cloudfunctions/` | 共 8 个：access-status / ad-unlock / ai-optimize / download-prepare / feedback / upload-chunk / project-store / share-pattern |
| 解锁额度数据 | 云数据库 `unlocks` 集合 | 按 openid 一条记录（doc id = openid），记录 AI / 下载剩余额度 |
| 下载文件 | 云存储 `downloads/` | `download-prepare` 生成文件上传云存储，前端用 `wx.cloud.downloadFile` 拉取 |
| 身份鉴权 | 云函数 openid | 自动识别微信用户 |
| AI 任务 | 云数据库 `ai_tasks` + 云存储 `ai-results/` | 提交任务立即返回 taskId，前端轮询 `action=check` 获取结果，规避云函数 60s 超时限制 |
| 分块上传 | 云函数 `upload-chunk` + `chunks` 集合 | 大图 base64 分块上传，组装完成后自动清理分块文件与记录 |
| 项目库 | 云函数 `project-store` + `projects` 集合 | 图纸 JSON 与图片存云存储，元数据按 openid 隔离 |
| 图纸分享 | 云函数 `share-pattern` + `shares` 集合 | 分享快照由云函数复制到云存储 `shares/`，30 天内凭 shareId 查看 |

前端调用映射（`utils/api.js`）：

| 云函数 | 用途 |
| --- | --- |
| access-status | 查询当前 openid 的解锁额度 |
| ad-unlock | 看完激励视频后发放额度（grant）/ 查询额度（status） |
| ai-optimize | 提交 / 轮询 AI 优化任务（submit / check） |
| download-prepare | 生成下载文件 |

## 广告解锁规则

- 每看完一次完整激励视频广告：AI 优化 +1 次、下载 +1 次（额度在云端按 openid 记录，不设每日上限）。
- 广告位 ID 配置在 `config.js` 的 `adUnitId`：在微信公众平台「流量主」创建激励视频广告位后填入；未配置时前端会提示「广告解锁功能即将上线」，不会拉起广告。
- 未看完广告（`isEnded = false`）不会发放额度。
- AI 优化任务提交成功后扣减 1 次 AI 额度；任务失败 / 取消不退回。下载在文件生成成功后扣减 1 次下载额度。

## 首次部署步骤

1. 用微信开发者工具打开本目录。
2. 点击工具栏「云开发」→ 开通云开发并创建环境（免费额度即可）。
3. （可选）把环境 ID 填入 `config.js` 的 `cloudEnv`；留空则使用默认环境。
4. 在 `cloudfunctions/` 下，对每个函数文件夹右键 → 上传并部署：云端安装依赖（共 8 个）。
5. 配置云函数环境变量（云开发控制台 → 云函数 → 对应函数 → 配置）：
   - `ai-optimize`：`VOLC_ACCESS_KEY_ID`、`VOLC_SECRET_ACCESS_KEY`
6. 配置广告位：在 `config.js` 填入 `adUnitId`（流量主激励视频广告位 ID）。
7. 编译运行。开发者工具与真机均可直接使用（云函数无需配置 request 合法域名）。

## AI 任务说明

- `ai-optimize` 采用「提交 + 轮询」模式，单次调用只需几秒；`upload-chunk`、`download-prepare` 超时保持默认 60s 即可，无需调大。
- 客户端提交前先分块上传图片到云存储，再由云函数组装，避开云函数入参大小限制。
- 前端与 `ai-optimize` 云函数必须一起重新部署：前端提交后会校验云函数返回的 `version` 字段（当前为 2），检测到旧版本会直接提示「请重新部署 ai-optimize 云函数」。
- 云函数已添加完整日志：`[callVolc] response`（火山引擎 HTTP 状态与响应体）、`[submitImageTask]`、`[pollImageTask]`（任务状态、是否有返回图）、`[ai-optimize] check` 等，可在云开发控制台 → 云函数 → 日志中查看具体失败原因。
- 火山引擎业务错误会被分类透出：余额不足/欠费、鉴权失败（密钥或权限）、并发限制、内容安全拦截、限流等，都会以明确文案提示，不会再出现「无响应」。

## 图纸分享

- 主页点击「分享图纸」后调用 `share-pattern`（create）：先把当前图纸、原图、预处理图上传到暂存区，云函数再复制到云存储 `shares/<shareId>/` 并写入 `shares` 集合，返回分享路径。
- 分享路径为 `/pages/share/share?shareId=xxx`，接收者点击微信分享卡片直接打开分享页，可查看原图、预处理图与图纸网格，并点击「导入并继续编辑」把图纸载入自己的画布（编辑与导出仍需各自看广告解锁）。
- 分享快照 30 天内有效（`shares` 集合中的 `expiresAt`）。
- 未解锁创作者分享的图纸统一叠加「未付款预览」水印，避免绕过广告解锁；分享不消耗解锁额度。
- 文件由云函数重新上传到 `shares/` 路径，保证不同 openid 的接收者都能读取；如你的云存储权限规则被自定义过，请确认允许所有用户读取。

## 发布前注意

- 云函数版不依赖域名，无需在小程序后台配置 request / downloadFile 合法域名。
- 替换 `project.config.json` 中的 `appid` 为你的小程序 AppID（当前为开发用 AppID）。
- 保存图片到相册需要申请 `scope.writePhotosAlbum` 权限（`wx.saveImageToPhotosAlbum` 会自动弹授权）。
- 云存储中的 `ai-results/`、`downloads/`、`projects/`、`shares/`、`share-staging/` 文件会持续增长，请定期在控制台清理或增加定时清理策略；分块文件（`chunks/`）会在组装完成后自动删除，暂存文件会在分享创建成功后自动删除。
- 激励视频广告没有服务端回调验证，发放以客户端 `onClose` 的 `isEnded` 为准（小程序流量主的常规做法）。
