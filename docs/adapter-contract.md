# 适配器契约（Adapter Contract）

**依据**：本机视频工厂的已验证实现（`codes/trustbridge/videos/factory/publishers/`，其中 TikTok 151 行、小红书 194 行、B站 65 行、YouTube 143 行）+ Chrome CDP 驱动（`browser.mjs`，121 行）。
**用途**：versekit 的每个平台适配器都必须满足这份契约；也是 code review 的检查表。

---

## 1. 三层结构

```
内核（vs core）            队列 / 状态机 / 快照 / 事件
   │  只调四个方法
   ├─ PlatformAdapter        login · check · publish · collect（+ capabilities）
   │     │  两个实现后端任选
   │     ├─ ApiBackend       官方 API（YouTube）
   │     └─ WebBackend       浏览器自动化（TikTok / 小红书 / 抖音 / B站）
   │            │
   └────────────┴─ BrowserDriver   持久化 Chrome + CDP（单实例，多 tab）
```

**关键判断**：`BrowserDriver` 是**共享基础设施**，不是适配器内部实现。抖音、小红书、TikTok 必须共用一个 Chrome 实例和一套 tab 工具，否则每个平台各写一套 CDP 逻辑 = 三份 bug。

---

## 2. 接口

```ts
interface PlatformAdapter {
  platform: string;
  capabilities: {
    publish: "api" | "web" | "none";
    visibility: Array<"public" | "private" | "friends"> | null;  // 发布时能否选可见性
    draft: boolean;          // 能否存草稿
    collect: "api" | "web" | "none";
    requiresQualification: boolean;   // 官方 API 才为 true
  };
  ready(): string | null;              // null = 可用；否则返回「人能看懂」的缺失原因
  login(ctx): Promise<void>;           // 扫码/授权，落到 Web 页
  check(ctx): Promise<AccountState>;   // ok | expiring | expired | banned
  publish(input): Promise<PublishResult>;
  collect(id): Promise<Metrics>;
}

interface PublishResult {
  id: string;                          // 平台作品 id（发布后核实得到）
  url: string;
  visibility: "public" | "private" | "friends";
  state: "published" | "published_limited";
  followups?: Followup[];              // 见 PRD §7.2
  evidence?: { screenshot?: string; log?: string };   // 失败/降级时的取证
}
```

**`ready()` 的返回文案是产品的一部分**。工厂里的写法值得照抄：

```js
ready: () => !hasBiliup() ? 'B站 未配置：没有安装 biliup（见 README）'
        : !existsSync(COOKIES) ? `B站 未登录：biliup -u ${COOKIES} login，选"浏览器登录"`
        : null   // 可用
```

它同时是"账号墙 Why" 的数据源——**不要让用户看到"error code 403"**。

---

## 3. 从已验证实现里提炼的 14 条硬规则

| # | 规则 | 出处 |
|---|---|---|
| 1 | **复用持久化 Chrome profile**，不要每次新开无痕。登录态、代理、扩展、语言都在里面 | `browser.mjs` `PROFILE` |
| 2 | 启动时带 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`，否则后台窗口的定时器被节流，自动化会卡死 | `browser.mjs` |
| 3 | **用真实鼠标事件**（`Input.dispatchMouseEvent`），不要 `element.click()`——部分站点忽略合成点击 | `tab.click` |
| 4 | 点之前先 `scrollIntoView({behavior:'instant'})` 再量坐标：平滑滚动会让坐标与元素错位 | TikTok `at()` |
| 5 | **UI 文案中英双匹配**：`['显示更多','Show more']`。同一账号可能被平台切语言 | TikTok `T` 表 |
| 6 | **每步回读校验**，不信任 UI 反馈：填完读回文本、设完读回可见性、开关读回 `checked`、封面对话框要等到关闭 | TikTok 多处 `throw` |
| 7 | **清空富文本编辑器要断言**：Draft.js 在 macOS 上合成 Cmd+A 无效 → 用 `commands:['selectAll']`，清完 `innerText` 必须为空 | TikTok 描述框 |
| 8 | **话题输入后等 700ms 再打空格**，否则建议列表会吃掉回车/空格 | TikTok hashtag 循环 |
| 9 | **超时按真实耗时给**：视频上传 20 分钟、发布判定 3 分钟、封面处理 4 秒级 sleep | TikTok |
| 10 | **发布成功的判定靠结果状态，不靠"点了按钮"**：轮询 URL 进入作品管理页；弹出"内容检查中，仍要发布"要处理 | TikTok 末尾循环 |
| 11 | **发布后去平台核实**：跳主页取最新 `/video/` 链接得到 id/url，而不是相信返回页 | TikTok `@ACCOUNT` |
| 12 | **失败必须留现场**：截图 + 错误信息里带路径（`~/.config/…/tiktok-error.png`），否则无法远程排障 | TikTok `catch` |
| 13 | **dry-run 必须存在**，且产出截图：跑到"发布"前一步停下，截图存档 | TikTok `--dry-run` |
| 14 | **每个平台可独立运行**（`node publishers/tiktok.mjs <dir> --dry-run`）；对应到 versekit 就是 `vk publish --platform tiktok --dry-run` 能单独跑，不需要跑整条流水线 | 各 publisher 的 `import.meta.url` 入口 |

补充两条工程性细节：

- **封闭 Shadow DOM** 里的按钮（小红书 `xhs-publish-btn`）页面 JS 看不见，但 CDP 的 `DOM.getDocument({pierce:true})` 能看到 → 用 `clickInShadow()`，别去猜选择器（`browser.mjs`）。
- **每个平台的素材解析是独立函数**（`files.mjs` 的 `filesOf`）：TikTok 用英文竖版 + 9:16 封面，小红书用 16:9 + 3:4 封面当首帧。**素材差异属于适配器，不属于内核。**

---

## 4. 每个适配器必须回答的五个问题

1. **登录态怎么来、怎么判断过期？** （`check()` 的探测点是哪个页面/接口）
2. **发布前需要哪些素材？** （视频/封面/文案/话题，尺寸与字数限制写进哪里）
3. **发布中哪一步最容易挂？** （上传？风控？编辑器？）→ 对应的重试与超时
4. **发布成功如何核实？** （必须有一个"回读"动作，不是点完就算）
5. **发布后有什么不完整？** （可见性、合集、话题审核 → `followup`）

五问答不全的适配器不允许合并。

---

## 5. 反模式（明令禁止）

| 禁止 | 原因 |
|---|---|
| 在适配器里直接写 SQLite / 飞书 API | 违反零后门律（PRD §5.3） |
| 用 `sleep` 代替 `waitFor` 作为主同步手段 | 慢且脆；只允许作为"过渡动画"级别的短等待 |
| 把平台 id 硬编码在业务逻辑里（如固定账号名） | 账号是数据，不是常量 |
| 静默 catch | 失败必须有 `error_code` + 人话 + 取证 |
| 用逆向签名调国内平台私有接口 | 合规红线 |
| 一个平台一份浏览器启动代码 | CDP 驱动必须共享 |

---

## 6. 目录建议

```
packages/
  core/                 内核：队列、状态机、快照、事件、命令注册表
  driver-browser/       Chrome CDP 驱动（tab/click/type/upload/shadow/screenshot）
  adapter-youtube/      API 后端
  adapter-bilibili/     biliup 后端
  adapter-tiktok/       Web 后端（TikTok Studio）
  adapter-xiaohongshu/  Web 后端（创作服务平台）
  adapter-douyin/       Web 后端（创作者中心，待建）
```

适配器是**独立包**，版本可单独发；契约测试（`contract.test.ts`）对每个包跑同一组用例：ready/login/check/publish(dry-run)/collect 的形状校验。
