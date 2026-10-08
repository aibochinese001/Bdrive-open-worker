# AGENTS.md — BDrive 商务网盘（Cloudflare Workers）

给 AI / CI Agent 的确定性部署指南。按顺序执行，不要跳过、不要靠猜。

## 快速部署（3 条命令）

```bash
npm install
npx wrangler login          # 浏览器授权一次
npm run setup               # 创建/复用 D1 bdrive-db → 回填 wrangler.jsonc → 应用 migrations
npx wrangler secret put SESSION_SECRET   # 输入随机串（32+ 字节 hex）
npx wrangler deploy
```

部署成功后打开 `https://<worker>.workers.dev`，注册账号，再用 SQL 提升管理员：

```bash
npx wrangler d1 execute bdrive-db --remote --command "UPDATE users SET role='admin' WHERE email='you@example.com'"
```

## Token 权限清单（Cloudflare API Token 需勾选）

| 权限 | 范围 | 用途 |
|---|---|---|
| Workers Scripts | Edit | 上传/部署 Worker |
| Workers D1 | Edit | 建库、执行 migrations |
| Workers R2 | Edit | 绑定 BUCKET（bdrive-files） |
| Workers Assets | Edit | 托管 static/ 前端 |
| Account Settings | Read | whoami / 账号识别 |

最小可用 token：`Workers Scripts Edit` + `Workers D1 Edit` + `Workers R2 Edit`。

## Secrets / 变量清单

| 名称 | 类型 | 必填 | 用途 | 获取方式 | 不填时行为 |
|---|---|---|---|---|---|
| `SESSION_SECRET` | secret | 是 | 会话 Cookie 签名密钥 | `npx wrangler secret generate` 或 `openssl rand -hex 32` | ⚠️ 落到代码内置 fallback，生产必须设置 |
| `BASE_URL` | var | 否 | 站点对外根地址（分享/支付回调绝对 URL） | 你的域名 | 自动按请求 Host 推断，功能降级而非崩溃 |

其他业务配置（易支付商户 PID/密钥、SMTP、套餐价格、支付方式开关）在「管理后台 → 系统设置」里配置，存于 D1 `settings` 表，**不是** env secret。

## 常见报错对照表

| 报错 | 原因 | 处理 |
|---|---|---|
| `Unable to find D1 database bdrive-db` | 未建库或 database_id 未回填 | 重跑 `npm run setup` |
| `Missing required SESSION_SECRET` / 登录后 Cookie 无效 | secret 未设置或过短 | `npx wrangler secret put SESSION_SECRET`（≥32 字节随机） |
| `D1 execute: no such table` | migrations 未全部应用 | 重跑 `npm run setup`（会自动补齐 0001/0002） |
| `R2 bucket bdrive-files not found` | 未创建 R2 bucket | 在 Cloudflare 面板建 `bdrive-files`，或让 wrangler 首次 deploy 时自动创建 |
| `wrangler: Unauthorized` | token 权限不足 | 按上方权限表补权限，重新生成 token |
| `ERR_TOO_MANY_REDIRECTS`（部署后访问） | SESSION_SECRET 未设置导致会话校验失败 | 设置 SESSION_SECRET 后重新部署 |
| `assets not found` / 404 页面 | `assets.directory` 未指向 `./static` | 用 `wrangler.jsonc.example` 复制配置 |

## 仓库结构

```
src/index.ts          入口与路由装配（/api/auth /api/drive /api/public /api/admin /support/*）
src/lib.ts            D1 助手 / settings / MD5 / 工具；Env 类型（DB/BUCKET/ASSETS/SESSION_SECRET/BASE_URL）
src/auth.ts           PBKDF2 密码哈希 / JWT / 登录与管理员中间件
src/epay.ts           易支付签名（MD5, ksort）与下单参数
src/files.ts          配额 / 套餐 / 会员激活 / 目录树工具
src/routes/           auth / drive / share / pay / admin 路由
src/smtp.ts, mail.ts  邮件发送（验证码等）
src/support-proxy.ts  在线客服同源反向代理（占位 https://chat.example.com，部署时改成你自己的客服站）
migrations/           0001_init.sql（表结构）、0002_email.sql（邮件/验证码）
static/               HTML/CSS/JS（Workers Assets 托管，含 PWA）
scripts/setup.mjs     一次性部署准备脚本（npm run setup）
scripts/formal_secret_scan.mjs  敏感信息扫描（npm run scan:secrets）
wrangler.jsonc.example 配置模板（复制为 wrangler.jsonc；wrangler.jsonc 不入库）
```

## 安全红线

- `wrangler.jsonc`（含真实 D1 ID）、`.dev.vars`、`node_modules/`、`.wrangler/` 不入库（见 .gitignore）。
- 开源前跑一次 `npm run scan:secrets`，应输出 0 命中。
- 不要在代码/注释/提交信息里写真实密钥、真实邮箱、真实生产域名。
