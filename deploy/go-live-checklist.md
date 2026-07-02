# Xiaomang + KKClaw 上线验收清单

## A. 基础服务
- [ ] `xiaomang` 前端静态资源已部署（`dist`）
- [ ] `xiaomang` Node 代理服务已启动（`PORT=8787`）
- [ ] Nginx 已加载 `deploy/nginx.xiaomang.conf`
- [ ] `GET /tikhub-proxy/health` 返回 `status=ok`

## B. 环境变量
- [ ] `TIKHUB_API_TOKEN` 已配置
- [ ] `TIKHUB_BASE_URL` 配置正确
- [ ] `AGENT_API_RETRY_ATTEMPTS` / `AGENT_API_RETRY_BASE_DELAY_MS` 已按线上稳定性配置
- [ ] `AGENT_CREATIVE_RETRY_ATTEMPTS` / `AGENT_CREATIVE_RETRY_BASE_DELAY_MS` 已按 DeepSeek 稳定性配置
- [ ] `DEEPSEEK_API_KEY` 已配置
- [ ] `DOUBAO_API_KEY` 或 `DOUBAO_APP_KEY` / `DOUBAO_ACCESS_KEY` 已配置
- [ ] `DOUBAO_RESOURCE_ID=volc.bigasr.auc_turbo` 已配置，`DOUBAO_ASR_ENDPOINT` 指向 `recognize/flash`
- [ ] `DOUBAO_VIDEO_ENDPOINT` / `DOUBAO_VIDEO_API_KEY` 已配置（多模态兜底）
- [ ] `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 已配置到 Vercel 环境变量
- [ ] 飞书应用已开通 `docx:document` 或 `docx:document:create`，以及 `docx:document:write_only` 或 `docx:document` 权限，并已发布/生效
- [ ] 飞书应用已开通 `base:app:create`、`base:table:create`、`base:field:read`、`base:field:create`、`base:record:create`，或 `bitable:app` 多维表格权限，并已发布/生效
- [ ] 如需写入指定文件夹，`FEISHU_FOLDER_TOKEN` 已配置，且该文件夹已给应用创建/编辑权限
- [ ] 运营侧用于归档的飞书多维表格已添加当前飞书应用为文档应用，且具备编辑/管理权限
- [ ] 最终编辑页首次粘贴多维表格 URL 后，可自动创建当前任务数据表；同任务后续选题会复用同一张表
- [ ] `WORKBENCH_URL` 已配置为线上地址（KKClaw）
- [ ] `MONGODB_URI` 已配置（task-server）

## C. 鉴权与任务过滤（KKClaw）
- [ ] 任务面板登录成功（`staff-a` / `staff-b`）
- [ ] 登录后可拉取今日任务
- [ ] 不同员工账号拉到不同任务
- [ ] 未登录时 `GET /api/tasks/today` 返回 `401`

## D. 业务主链路
- [ ] 项目经理创建任务并分配员工
- [ ] 员工在 KKClaw 今日任务看到被分配任务
- [ ] KKClaw 点击“打开工作站”可打开 Xiaomang 页面
- [ ] Xiaomang 可完成工作流生成、翻译、风格转写
- [ ] “进入最终文案编辑页”可带入已选内容
- [ ] Word / Excel / 飞书文档 / 飞书多维表格写入正常，且包含对标视频链接、封面、时长、点赞、评论、转发、收藏数据

## E. 稳定性检查
- [ ] Agent 流式接口响应正常（无长时间卡死）
- [ ] `/api/agent/workflow/stream-run` 正常
- [ ] `/api/agent/translation` 正常
- [ ] `/api/agent/rewrite` 正常
- [ ] task-server 连接 Mongo 正常
- [ ] 日志中无连续报错

## F. 回滚与应急
- [ ] 保留上一版可回滚构建产物
- [ ] 保留上一版 `.env` 备份
- [ ] 明确回滚命令（Nginx + Node 服务）
- [ ] 线上负责人与应急联系方式已确认
