# BDrive 商务网盘（Cloudflare Workers）

基于 Cloudflare Workers + Hono + D1 + R2 的多用户商务网盘系统，带会员订阅、管理后台与易支付（微信 / 支付宝 / 数字人民币 / USDT）。

## 功能

- **用户系统**：邮箱注册登录、JWT + HttpOnly Cookie、PBKDF2(SHA-256,10 万次) 密码哈希、封禁/解封、管理员角色。
- **网盘核心**：
  - R2 流式上传 / 下载，支持 HTTP `Range`（视频音频拖动、断点续传）。
  - 文件夹树（递归 CTE 面包屑 / 移动防环 / 递归删除）、重命名、搜索。
  - 存储配额与单文件大小限制（免费版 + 会员套餐，管理员可按用户覆盖）。
  - 分享链接：自定义提取码、有效期、下载次数；文件夹可整包浏览/下载；公开分享页无需登录。
- **会员体系**：套餐（天/月/年/永久）、空间与单文件权益、到期时间、续费叠加。
- **易支付**：标准 MD5 签名（ksort + 密钥），4 种支付方式可独立开关，通道 `type` 可在后台按服务商调整（数字人民币默认 `dcep`、USDT 默认 `usdt`）；异步通知验签、金额校验、幂等激活。
- **管理后台**（`/admin/`）：数据仪表盘、用户（角色/封禁/配额/会员/重置密码/删除）、套餐 CRUD、订单、文件、分享、站点与易支付设置。

## 技术栈

| 层 | 服务 |
|---|---|
| 运行时 | Cloudflare Workers（Hono，TypeScript） |
| 元数据 | Cloudflare D1（SQLite） |
| 对象存储 | Cloudflare R2 |
| 前端 | 静态 HTML + 原生 JS（`static/`，由 Workers Assets 托管） |

## 目录

```
src/
  index.ts          入口与路由装配
  lib.ts            D1 助手 / 设置 / MD5 / 工具
  auth.ts           密码哈希 / JWT / 登录与管理员中间件
  epay.ts           易支付签名与下单参数
  files.ts          配额、套餐、会员激活、目录树工具
  routes/
    auth.ts         注册/登录/登出/me/站点信息
    drive.ts        文件/文件夹/上传下载/分享管理
    share.ts        公开分享访问与下载
    pay.ts          套餐、下单、易支付回调
    admin.ts        管理后台 API
migrations/0001_init.sql
static/             前端页面与资源
```

## 本地开发

```powershell
npm install
# 本地 D1 迁移
node .\node_modules\wrangler\bin\wrangler.js d1 execute bdrive-db --local --file=.\migrations\0001_init.sql
# 启动（读取 .dev.vars 中的 SESSION_SECRET）
node .\node_modules\wrangler\bin\wrangler.js dev
```

## 部署

推荐方式（自动建库 / 回填配置 / 应用迁移，AI 与 CI 也适用，详见 [AGENTS.md](AGENTS.md)）：

```powershell
npm install
npx wrangler login
npm run setup          # 创建/复用 D1 bdrive-db → 回填 wrangler.jsonc → 应用 migrations
npx wrangler secret put SESSION_SECRET   # 输入随机密钥（32+ 字节）
npx wrangler deploy
```

手动方式：

```powershell
$env:CLOUDFLARE_API_TOKEN="<token>"
$env:CLOUDFLARE_ACCOUNT_ID="<account id>"
node .\node_modules\wrangler\bin\wrangler.js d1 execute bdrive-db --remote --file=.\migrations\0001_init.sql
node .\node_modules\wrangler\bin\wrangler.js secret put SESSION_SECRET   # 输入随机密钥
node .\node_modules\wrangler\bin\wrangler.js deploy
```

首个管理员：先在网站注册账号，再将其角色提升为管理员：

```powershell
wrangler d1 execute bdrive-db --remote --command "UPDATE users SET role='admin' WHERE email='you@example.com'"
```

## 易支付配置

在「管理后台 → 系统设置」填写：

- 网关地址（站点根目录即可，自动补 `/submit.php`）、商户 PID、商户密钥。
- 异步通知地址：`https://<你的域名>/api/payment/callback`（需在易支付后台登记）。
- 勾选启用的支付方式，并按你的易支付服务商填各通道 `type` 代码。

## 安全说明

- 支付回调同时校验签名与金额；订单兑付用条件 UPDATE 保证幂等。
- 所有文件访问强制归属校验；公开分享通过子树归属 + 提取码 + 有效期 + 次数控制。
- 生产请务必设置强随机 `SESSION_SECRET`，并使用 HTTPS 自定义域。