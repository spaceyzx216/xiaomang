# Xiaomang + KKClaw 上线验收清单

## A. 基础服务
- [ ] `xiaomang` 前端静态资源已部署（`dist`）
- [ ] `xiaomang` Node 代理服务已启动（`PORT=8787`）
- [ ] Nginx 已加载 `deploy/nginx.xiaomang.conf`
- [ ] `GET /tikhub-proxy/health` 返回 `status=ok`

## B. 环境变量
- [ ] `COZE_API_TOKEN` 已配置
- [ ] `TIKHUB_API_TOKEN` 已配置
- [ ] `COZE_BASE_URL` / `TIKHUB_BASE_URL` 配置正确
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
- [ ] Word / Excel 导出正常

## E. 稳定性检查
- [ ] Coze 流式接口响应正常（无长时间卡死）
- [ ] `/api/coze/workflow/stream-run` 正常
- [ ] `/api/coze/workflows/chat` 正常
- [ ] task-server 连接 Mongo 正常
- [ ] 日志中无连续报错

## F. 回滚与应急
- [ ] 保留上一版可回滚构建产物
- [ ] 保留上一版 `.env` 备份
- [ ] 明确回滚命令（Nginx + Node 服务）
- [ ] 线上负责人与应急联系方式已确认
