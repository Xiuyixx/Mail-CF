# Mail-CF

<p align="center">
  <img src="assets/mail-cf-logo.png" alt="Mail-CF Logo" width="160" height="160">
</p>

基于 Cloudflare Workers 和 Resend 的安全网页发信工具。

附件选择后可点击文件名右侧的“×”逐项移除；删除的附件不会随邮件发送。

Mail-CF 提供密码保护的写信页面，可使用已验证域名下的任意合法前缀发信，例如 `support@example.com` 或 `billing.eu@example.com`。

## 功能

- 使用 Cloudflare Secret `PASSWD` 登录
- 签名、限时会话 Cookie
- CSRF 和同源请求保护
- 支持收件人、抄送、密送、Reply-To、发件人名称和自定义发件前缀
- 支持纯文本和 HTML 正文
- 支持附件
- 适配手机、平板和桌面视口，支持安全区域、动态视口和键盘/触控操作
- 使用 Resend 上游幂等键防止重复发送
- Durable Object 持久化限流
- 请求、附件和收件人校验
- CSP nonce 和安全响应头
- 不依赖 Cloudflare Access

## 环境要求

- Cloudflare Workers 账户
- 已在 Resend 验证的域名
- Node.js 22 或更高版本
- Wrangler 4

## 部署

1. 确认 `wrangler.toml` 的 `name` 与目标 Worker 名称一致。
2. 安装依赖、登录并部署：

   ```bash
   npm ci
   npx wrangler login
   npx wrangler deploy --dry-run
   npx wrangler deploy
   ```

3. 在 **Worker → 设置 → 运行时变量和密钥** 中配置下表内容，然后点击保存并部署。不要把这些配置填写到“构建环境变量”页面：构建变量只在构建阶段使用，Worker 运行时不会从那里读取 `env.PASSWD` 等配置。

   `PASSWD` 和 `API_KEY` 必须选择 **Secret/机密** 类型。`PASSWD` 只要填写非空即可，不限制长度，也不要求必须包含数字。

首次部署会根据 `v1` migration 创建 SQLite Durable Object `RateLimiter`。升级 Worker 时请保留已有 migration 历史。

### Cloudflare Git 自动部署

连接此仓库的 `main` 分支，根目录使用仓库根目录，构建命令留空，部署命令使用 `npx wrangler deploy`。仓库已包含正式 `wrangler.toml`，无需复制示例配置。

部署前将配置中的 `name` 与 Cloudflare Worker 名称保持一致。仓库中的 `wrangler.toml` 不定义 `[vars]`，并启用 `keep_vars = true`，因此 Dashboard 中的运行时变量和 Secret 不会被 Git 部署覆盖或清空。

**配置位置：**

- **运行时变量和密钥**：配置 `PASSWD`、`API_KEY`、`DOMAIN`、`NAME` 和 `PREFIX`。
- **构建环境变量**：不要在这里配置 Mail-CF 的运行参数；这里的值不会替代 Worker 运行时绑定。
- **绑定**：`RATE_LIMITER` 由 `wrangler.toml` 自动创建和绑定，不要手动添加为普通变量。

## 配置项

在 **运行时变量和密钥** 页面配置以下内容（必填项在前，组内按说明文字从短到长排列）：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `PASSWD` | 是 | 网页登录密码 |
| `API_KEY` | 是 | Resend API 密钥 |
| `DOMAIN` | 是 | Resend 已验证的发信域名 |
| `NAME` | 否 | 默认发件人名称，默认空 |
| `PREFIX` | 否 | 默认发件前缀，默认为 `noreply` |

变量名区分大小写。`PASSWD` 和 `API_KEY` 使用 Secret/机密类型，其余使用普通变量。

仅支持上表中的五个新变量名，不再读取旧名称。升级前请先配置 `PASSWD` Secret，并确认 `API_KEY` 和 `DOMAIN` 已设置；旧密码变量不会自动迁移。

必须保留 `RATE_LIMITER` Durable Object 绑定。绑定缺失时 Mail-CF 会拒绝登录和发信，不会降级为无保护模式。

## 常见问题

- **密码错误或服务未配置**：检查运行时 `PASSWD` 是否已保存到当前 Worker，以及是否与输入完全一致。密码只要非空即可；构建变量不能替代运行时配置。
- **请求过于频繁**：等待限流窗口结束；若持续发生，检查 `RATE_LIMITER` 绑定及其运行状态，绑定缺失或调用失败也会拒绝请求。
- **可选变量未填写**：`PREFIX` 默认 `noreply`，`NAME` 默认空，不影响登录。
- **Secret 尚未设置**：可以先部署，再添加运行时 Secret；不要添加 `secrets.required` 来创建空白项，它会在缺少 Secret 时阻止部署。

## 限制

- 请求体：35 MiB，超限返回 HTTP 413；无效 JSON 返回 HTTP 400
- 单个附件：10 MiB
- 全部附件：25 MiB，最多 10 个
- 收件人：To、Cc、Bcc 合计最多 50 个，不允许重复地址（忽略大小写）
- 登录：每个 IP 每分钟最多 10 次
- 发信：每个 IP 每分钟最多 20 次
- Resend 请求超时：15 秒

重试同一封邮件时必须复用相同的 `Idempotency-Key`，不要为重试生成新的 Key。

## 开发与验证

```bash
npm ci
npm run check
npm test
```

测试使用模拟的 Resend 请求，不会真正发送邮件。GitHub Actions 会在每次 push 和 pull request 时执行相同检查。

### 浏览器测试

```bash
npx playwright install --with-deps chromium firefox webkit
npm run browser:test
```

覆盖手机、平板、桌面和横屏视口，验证登录、写信、附件、模拟发送、退出及横向溢出。浏览器模拟不能替代真机验证。

### 表单体验

- 发件人名称会预填 `NAME`；清空后本次邮件不带显示名称。不提交该字段的 API 请求仍使用默认名称。
- 登录和发送期间显示“登录中…”/“发送中…”，禁用按钮以防重复提交，失败后恢复。
- 非 JSON 错误响应显示 HTTP 状态码，网络失败显示重试提示。
- 选择附件和发送前均检查大小：单文件最多 10 MiB，合计最多 25 MiB；超限不会读取为 Base64 或上传。后端校验仍然保留。

发件域名不会再静默留空：运行时 `DOMAIN` 缺失、为空或仅含空白时，会显示“未配置，请检查 DOMAIN”。请在当前 Worker 的生产环境“变量和机密”中配置实际已验证域名并保存部署；构建变量不能代替运行时变量。
