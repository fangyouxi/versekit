#!/usr/bin/env node
// vk — versekit CLI. Default output is JSON (agents and scripts are the primary caller);
// --human switches to the layout a person reads. Anything that writes goes through core,
// so the same facts are reachable from the web UI and from Feishu cards.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { paths, ensureDirs, migrate, open, getMeta, isInitialised } from "../../core/src/index.mjs";
import { COMMANDS } from "../../core/src/commands.mjs";
import { browserReady, PROFILE, PORT } from "../../driver-browser/src/index.mjs";

const PKG = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a) => !a.startsWith("-") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
const human = has("--human");
const out = (data) => {
  if (human) return;
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
};

const line = (label, value) => `${label.padEnd(22)}${value}`;

// ---------------------------------------------------------------- commands

function cmdInit() {
  const p = migrate();
  const config = existsSync(p.configFile)
    ? JSON.parse(readFileSync(p.configFile, "utf8"))
    : null;
  if (!config) {
    writeFileSync(
      p.configFile,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date().toISOString(),
          defaults: {
            mode: "auto",
            visibility: "public",
            collect: { offsets: ["1h", "6h", "24h", "3d", "7d", "daily"] },
          },
          browser: { profile: "${state}/browser", cdp_port: 9333 },
          channel: { feishu: { enabled: false } },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  const result = {
    ok: true,
    root: p.root,
    db: p.db,
    config: p.configFile,
    schema_version: getMeta("schema_version"),
    next: ["vk doctor", "vk account add tiktok --name 主号", "vk channel bind feishu"],
  };
  if (human) {
    console.log(line("已初始化", p.state));
    console.log(line("数据库", p.db));
    console.log(line("配置", p.configFile));
    console.log("\n下一步：");
    result.next.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else out(result);
  return result;
}

function guard() {
  if (isInitialised()) return true;
  const msg = "还没有初始化：先运行 vk init";
  if (human) console.error(msg);
  else out({ ok: false, error: { code: "not_initialised", message: msg } });
  return false;
}

function cmdNow() {
  if (!guard()) return;
  const conn = open({ readonly: true });
  const count = (sql, ...p) => conn.prepare(sql).get(...p)?.n ?? 0;
  const accounts = conn.prepare("SELECT platform, handle, state FROM account ORDER BY platform").all();
  const data = {
    ok: true,
    accounts: {
      total: accounts.length,
      by_state: Object.fromEntries(
        ["ok", "expiring", "expired", "banned", "manual"].map((s) => [s, count("SELECT COUNT(*) n FROM account WHERE state = ?", s)]),
      ),
    },
    queue: {
      queued: count("SELECT COUNT(*) n FROM run WHERE state='queued'"),
      running: count("SELECT COUNT(*) n FROM run WHERE state='running'"),
      failed: count("SELECT COUNT(*) n FROM run WHERE state='failed'"),
    },
    publishes: {
      published: count("SELECT COUNT(*) n FROM publish WHERE state='published'"),
      published_limited: count("SELECT COUNT(*) n FROM publish WHERE state='published_limited'"),
      needs_human: count("SELECT COUNT(*) n FROM publish WHERE state='notify_pending'"),
      failed: count("SELECT COUNT(*) n FROM publish WHERE state='failed'"),
    },
    channel: { feishu: count("SELECT COUNT(*) n FROM channel_binding WHERE channel='feishu'") > 0 ? "bound" : "unbound" },
    accounts_list: accounts,
  };
  if (human) {
    console.log(`账号   ${data.accounts.total} 个（ok ${data.accounts.by_state.ok} · 需处理 ${data.accounts.by_state.expiring + data.accounts.by_state.expired}）`);
    for (const a of accounts) console.log(`       ${a.platform.padEnd(12)}${a.handle.padEnd(18)}${a.state}`);
    console.log(`队列   待跑 ${data.queue.queued} · 运行中 ${data.queue.running} · 失败 ${data.queue.failed}`);
    console.log(`发布   成功 ${data.publishes.published} · 部分 ${data.publishes.published_limited} · 待确认 ${data.publishes.needs_human}`);
    console.log(`通道   飞书 ${data.channel.feishu === "bound" ? "已连接" : "未配对"}`);
    if (!accounts.length) console.log("\n还没有账号：vk account add tiktok --name 主号");
  } else out(data);
  return data;
}

function cmdDoctor() {
  const checks = [];
  const add = (id, ok, detail, next) => checks.push({ id, ok, detail, ...(next ? { next } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  add("node", nodeOk, `v${process.versions.node}${nodeOk ? "" : "（需要 ≥22.5，node:sqlite）"}`, nodeOk ? null : "升级 Node 到 22.5 以上");

  const p = paths();
  add("config_dir", existsSync(p.config), p.config, existsSync(p.config) ? null : "运行 vk init");
  add("database", existsSync(p.db), p.db, existsSync(p.db) ? null : "运行 vk init");
  add("schema_version", getMeta("schema_version") === "1", getMeta("schema_version") ?? "（无）", getMeta("schema_version") ? null : "运行 vk init");

  const chrome = browserReady();
  add("chrome", chrome === null, chrome ?? "已找到 Chrome", chrome);
  add("browser_profile", existsSync(PROFILE), `${PROFILE}（CDP :${PORT}）`, existsSync(PROFILE) ? null : "首次扫码登录时会自动创建");

  let counts = { accounts: 0, expiring: 0, stuck: 0 };
  if (isInitialised()) {
    const conn = open({ readonly: true });
    counts.accounts = conn.prepare("SELECT COUNT(*) n FROM account").get().n;
    counts.expiring = conn.prepare("SELECT COUNT(*) n FROM account WHERE state IN ('expiring','expired')").get().n;
    counts.stuck = conn.prepare("SELECT COUNT(*) n FROM run WHERE state='running' AND lease_until < ?").get(Date.now()).n;
  }
  add("accounts", counts.accounts > 0, `${counts.accounts} 个账号`, counts.accounts ? null : "vk account add <platform> --name 主号");
  add("account_health", counts.expiring === 0, counts.expiring ? `${counts.expiring} 个账号需要重新登录` : "全部正常", counts.expiring ? "vk account reauth <id>" : null);
  add("queue", counts.stuck === 0, counts.stuck ? `${counts.stuck} 个任务租约过期` : "没有卡住的任务", counts.stuck ? "重启守护进程（任务会自动重排）" : null);

  const adapters = ["youtube", "bilibili", "tiktok", "xiaohongshu", "douyin"].filter((a) =>
    existsSync(new URL(`../../adapter-${a}/package.json`, import.meta.url)),
  );
  add("adapters", adapters.length > 0, adapters.length ? adapters.join(", ") : "尚未接入任何平台适配器", adapters.length ? null : "按 docs/adapter-contract.md 实现第一个适配器");

  const feishu = isInitialised()
    ? open({ readonly: true }).prepare("SELECT COUNT(*) n FROM channel_binding WHERE channel='feishu'").get().n > 0
    : false;
  add("channel_feishu", feishu, feishu ? "已配对" : "未配对", feishu ? null : "vk channel bind feishu");

  const okCount = checks.filter((c) => c.ok).length;
  const data = {
    ok: checks.every((c) => c.ok || ["adapters", "channel_feishu", "browser_profile", "accounts"].includes(c.id)),
    passed: okCount,
    total: checks.length,
    checks,
  };
  if (human) {
    for (const c of checks) {
      const mark = c.ok ? "✓" : "✗";
      console.log(`${mark} ${c.id.padEnd(18)}${c.detail}`);
      if (!c.ok && c.next) console.log(`  ${" ".repeat(19)}→ ${c.next}`);
    }
    console.log(`\n${okCount}/${checks.length} 项通过`);
  } else out(data);
  return data;
}

function cmdCommands() {
  const data = COMMANDS.map((c) => ({
    name: c.name,
    summary: c.summary,
    remote: c.remote,
    cli: c.cli?.usage ?? null,
    card: c.card?.label ?? null,
    idempotent: typeof c.idempotent === "function",
    ttl_ms: c.ttlMs ?? null,
  }));
  if (human) for (const c of data) console.log(`${c.name.padEnd(18)}${c.remote ? "远程 ✓" : "远程 ✗"}  ${c.summary}`);
  else out(data);
  return data;
}

function usage() {
  const text = [
    "vk — versekit CLI（默认 JSON，--human 给人看）",
    "",
    "用法:",
    "  vk init",
    "  vk now [--human]",
    "  vk doctor [--human]",
    "  vk commands [--human]",
    "  vk --version",
    "",
    "命令总表由 packages/core/src/commands.mjs 派生（与 Web、飞书卡片同源）。",
  ].join("\n");
  console.log(text);
}

// ---------------------------------------------------------------- dispatch

const cmd = positional[0];

try {
  if (!cmd || has("--help") || has("-h")) usage();
  else if (has("--version") || has("-v")) console.log(PKG.version);
  else if (cmd === "init") cmdInit();
  else if (cmd === "now") cmdNow();
  else if (cmd === "doctor") cmdDoctor();
  else if (cmd === "commands") cmdCommands();
  else {
    console.error(`未知命令：${cmd}\n`);
    usage();
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (human) console.error(`出错：${message}`);
  else out({ ok: false, error: { message } });
  process.exit(1);
}
