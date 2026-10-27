# versekit

**本地跑的多平台发布 + 自有账号数据控制面。** 电脑干活（凭证、发布、采集），手机拍板（通知、审批、重试）。
面向用 AI 创作的多平台自媒体人：一条内容一次编排发到国内外多个平台，发完自动回收播放/点赞/收藏。

> 状态：**v0.1 走骨架（walking skeleton）**。文档齐全；CLI 已有 `init / doctor / now / commands`；**还没有平台适配器**。
> 路线见 `docs/PRD.md` §12，架构见 `docs/ARCHITECTURE.md`。

---

## 快速开始

```bash
node -v                  # 需要 ≥ 22.5（用到 node:sqlite）
npm run vk -- init       # 建库 + 配置
npm run vk -- doctor --human
npm run vk -- now --human
npm run vk -- commands   # 命令总表（与 Web / 飞书卡片同源）
npm test
```

状态目录（可用 `VK_HOME` 改，测试用）：

```
~/.config/versekit/            config.json、credentials/
~/.local/state/versekit/       vk.db、vk.log、browser/（Chrome profile）
```

---

## 三条不可动摇的设计约束

1. **CLI 完整律**：关掉 Web 和飞书，`vk` 的能力不减少。没有"只有网页能做"的功能。
2. **语义一致律**：同一命令在三端产生相同的 `command_id`、幂等键、审计记录、状态迁移。
3. **零后门律**：Web 与飞书适配器不得直接读写 SQLite / 凭证目录，只能走内核。

命令只在 `packages/core/src/commands.mjs` 定义一次，CLI / HTTP / 卡片按钮由它派生，CI 校验三者一致。

---

## 仓库结构

```
packages/
  core/              schema.sql · db/事件/队列 · 状态机 · 命令注册表 · test/
  driver-browser/    Chrome CDP 驱动（持久 profile，三平台共用）
  cli/               vk
docs/
  PRD.md             产品定义、范围、竞品位置、路线图
  platforms.md       五个平台的能力矩阵（自动化 / 资质 / 降级率）
  adapter-contract.md 适配器规约：接口 + 14 条硬规则 + 反模式
  ARCHITECTURE.md    进程形态、SQLite schema、命令表、事件、采集器、CI 契约
  wireframes.html    7 屏设计稿（浏览器直接打开）
```

---

## 平台

| 平台 | 路线 | 状态 |
|---|---|---|
| YouTube | 官方 Data API v3 | 未实现（v0.1） |
| B站 | biliup + cookie | 未实现（v0.1） |
| TikTok | TikTok Studio web 自动化 | 未实现（v0.1） |
| 小红书 | 创作服务平台 web 自动化 | 未实现（v0.1） |
| 抖音 | 创作者中心 web 自动化 | 未实现（Wave 2） |

发布模式默认 `auto`；不可用时自动降级 `auto → draft → notify → manual`，每次降级都记 `fallback_reason` 并通知。
**永不静默失败**：任何发布必须终结在 `published / published_limited / 草稿待发 / notify待确认 / failed(带原因)` 之一。

---

## 合规边界

只自动化**用户自己已登录的会话**（扫码登录的 cookie / Chrome profile），不逆向签名、不采集公开内容、不碰第三方账号。
这条边界是开源可站住的前提，也是 `docs/platforms.md` 里"零资质"的原因：平台授权的是用户自己，不是我们的应用。
