// The single source of truth for what versekit can do.
// CLI help, HTTP routes and Feishu card buttons are all derived from this table, and CI asserts
// the three stay identical (docs/ARCHITECTURE.md §5, PRD §5.4).
//
// Adding a capability = adding an entry here. If a feature exists only in the web UI, it is a bug.

export const COMMANDS = [
  {
    name: "init",
    summary: "建库、写配置、准备目录",
    remote: false,
    cli: { usage: "vk init" },
    card: null,
  },
  {
    name: "now",
    summary: "一屏状态：账号健康 / 队列 / 通道",
    remote: true,
    cli: { usage: "vk now [--human]" },
    card: null,
  },
  {
    name: "doctor",
    summary: "自检：能不能跑 / 能不能发 / 能不能看到 / 能不能收到",
    remote: false,
    cli: { usage: "vk doctor [--human] [--json]" },
    card: null,
  },
  {
    name: "account.add",
    summary: "加一个账号（需要在电脑上扫码）",
    remote: false,
    cli: { usage: "vk account add <platform> --name <name>" },
    card: null,
  },
  {
    name: "account.reauth",
    summary: "重新登录某个账号（只能本地执行）",
    remote: false,
    cli: { usage: "vk account reauth <accountId>" },
    card: { label: "重新授权", style: "default", confirm: false },
  },
  {
    name: "account.mode",
    summary: "把账号设为自动发布 / 仅手动",
    remote: true,
    cli: { usage: "vk account mode <accountId> auto|manual" },
    card: { label: "转手动跟踪", style: "default", confirm: false },
  },
  {
    name: "publish.create",
    summary: "创建发布（一条内容 → 多平台）",
    remote: false,
    cli: { usage: "vk publish <asset> --to <platforms> [--schedule] [--visibility] [--dry-run]" },
    card: null,
  },
  {
    name: "publish.retry",
    summary: "重试一次发布",
    remote: true,
    idempotent: (a) => `retry:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    cli: { usage: "vk publish retry <publishId>" },
    card: { label: "重试", style: "primary", confirm: false },
  },
  {
    name: "publish.release",
    summary: "把 private_then_public 的内容放行为公开",
    remote: true,
    idempotent: (a) => `release:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    cli: { usage: "vk publish release <publishId>" },
    card: { label: "放行公开", style: "primary", confirm: false },
  },
  {
    name: "publish.confirm",
    summary: "确认已在 App 内完成发布（notify 模式）",
    remote: true,
    idempotent: (a) => `confirm:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    cli: { usage: "vk publish confirm <publishId>" },
    card: { label: "我已发布", style: "primary", confirm: false },
  },
  {
    name: "collect.now",
    summary: "立刻抓一次指标",
    remote: true,
    cli: { usage: "vk collect [--now] [--platform <p>]" },
    card: { label: "立即重抓", style: "default", confirm: false },
  },
  {
    name: "stats.works",
    summary: "看作品指标（JSON）",
    remote: false,
    cli: { usage: "vk stats works [--range 7d] [--publish <id>]" },
    card: { label: "看 24 小时数据", style: "default", confirm: false },
  },
  {
    name: "channel.bind",
    summary: "配对飞书（本机显示 6 位码）",
    remote: false,
    cli: { usage: "vk channel bind feishu" },
    card: null,
  },
  {
    name: "channel.test",
    summary: "飞书通道探活",
    remote: false,
    cli: { usage: "vk channel test feishu" },
    card: null,
  },
];

export const findCommand = (name) => COMMANDS.find((c) => c.name === name) ?? null;

/** What a remote caller (card button) is allowed to trigger. */
export const remoteCommands = () => COMMANDS.filter((c) => c.remote);
