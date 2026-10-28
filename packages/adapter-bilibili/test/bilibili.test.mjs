// B站适配器测试：不碰真网络、不碰真 biliup —— 用一个假的 biliup 脚本 + 一个假的 archives 接口。
// 验的是契约，不是平台：状态迁移、followup 落库、auth 失败要降级到 blocked 而不是 failed。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-bili-"));

const core = await import("../../core/src/index.mjs");
const adapter = (await import("../src/index.mjs")).default;

const db = () => core.open();
let seq = 0;

/** 一个只会照剧本说话的 biliup：STYLE=cookie 决定是成功还是登录失效。 */
function fakeBiliup() {
  const dir = mkdtempSync(join(tmpdir(), "vk-biliup-"));
  const bin = join(dir, "biliup");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.STYLE || "ok";
if (mode === "auth") { console.error("请先登录：cookie 已失效"); process.exit(1); }
if (mode === "nobv" && args.includes("list")) { console.log("BV1xx411c7mD  固定标题"); process.exit(0); }
if (mode === "nobv") { console.log("上传完成"); process.exit(0); }
if (args.includes("list")) { console.log("BV1zz411c7mE  标题"); process.exit(0); }
console.log(JSON.stringify({ argv: args, id: "BV1yy411c7mF" }));
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_BILIUP_BIN = bin;
  return bin;
}

function seed({ state = "queued", credential = true, scheduledAt = null, title = null } = {}) {
  const n = ++seq;
  const credPath = `${process.env.VK_HOME}/cookies-${n}.json`;
  if (credential) {
    writeFileSync(credPath, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "y" }] } }));
  }
  const asset = `${process.env.VK_HOME}/cut-${n}.mp4`;
  writeFileSync(asset, "fake video");
  db().prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)").run(
    `w${n}`,
    `第 ${n} 期`,
    asset,
    JSON.stringify({ title: title ?? `测试标题 ${n}`, description: "描述", tags: ["AI", "效率"] }),
    Date.now(),
  );
  db().prepare("INSERT INTO account (id, platform, handle, credential_ref, created_at) VALUES (?,?,?,?,?)").run(`a${n}`, "bilibili", `@bili${n}`, credential ? credPath : null, Date.now());
  db()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`p${n}`, `w${n}`, `a${n}`, state, scheduledAt, Date.now(), Date.now());
  return { publishId: `p${n}`, accountId: `a${n}`, credPath };
}

before(() => {
  core.migrate();
  fakeBiliup();
});

beforeEach(() => {
  db().exec("DELETE FROM snapshot; DELETE FROM followup; DELETE FROM publish; DELETE FROM work; DELETE FROM account; DELETE FROM run; DELETE FROM event;");
  process.env.STYLE = "ok";
});

test("publish 把稿件发出去：拿回 BV 号、进 published、排一次采集", async () => {
  const { publishId, accountId } = seed();
  const res = await adapter.publish({ publishId });
  assert.match(res.id, /^BV[0-9A-Za-z]{10}$/);
  assert.equal(res.state, "published");

  const row = db().prepare("SELECT state, external_id, external_url FROM publish WHERE id=?").get(publishId);
  assert.equal(row.state, "published");
  assert.equal(row.external_id, res.id);
  assert.match(row.external_url, /bilibili\.com\/video\//);

  const run = db().prepare("SELECT kind, lane, state FROM run WHERE target_id=?").get(publishId);
  assert.equal(run.kind, "collect");
  assert.equal(run.lane, accountId);
});

test("publish 生成三条 followup：工厂里这些只是 notes 字符串，这里必须可追踪", async () => {
  const { publishId } = seed();
  await adapter.publish({ publishId });
  const kinds = db().prepare("SELECT kind FROM followup WHERE publish_id=? ORDER BY kind").all(publishId).map((r) => r.kind);
  assert.deepEqual(kinds, ["declare_ai_generated", "upload_captions"]);
  const events = db().prepare("SELECT COUNT(*) n FROM event WHERE type='publish.needs_followup' AND publish_id=?").get(publishId);
  assert.equal(events.n, 2);
});

test("合集是可选 followup：配置了才生成", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET overrides_json=? WHERE id=?").run(JSON.stringify({ collection: "出海合规" }), publishId);
  await adapter.publish({ publishId });
  const kinds = db().prepare("SELECT kind FROM followup WHERE publish_id=?").all(publishId).map((r) => r.kind);
  assert.ok(kinds.includes("add_to_collection"));
});

test("延时发布不足 4 小时就不传 --dtime（平台怪癖归适配器）", async () => {
  const soon = seed({ scheduledAt: Date.now() + 30 * 60e3 });
  const later = seed({ scheduledAt: Date.now() + 6 * 3600e3 });
  const a = await adapter.publish({ publishId: soon.publishId, dryRun: true });
  const b = await adapter.publish({ publishId: later.publishId, dryRun: true });
  assert.ok(!a.args.includes("--dtime"));
  assert.ok(b.args.includes("--dtime"));
});

test("输出里没有 BV 号时回退到 biliup list 找", async () => {
  process.env.STYLE = "nobv";
  const { publishId } = seed({ title: "固定标题" });
  const res = await adapter.publish({ publishId });
  assert.equal(res.id, "BV1xx411c7mD");
});

test("登录失效 → blocked + 账号置 expired + 事件，而不是 failed", async () => {
  process.env.STYLE = "auth";
  const { publishId, accountId } = seed();
  await assert.rejects(() => adapter.publish({ publishId }));
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "blocked");
  assert.equal(db().prepare("SELECT state FROM account WHERE id=?").get(accountId).state, "expired");
  assert.ok(db().prepare("SELECT 1 FROM event WHERE type='account.expired'").get());
});

test("没有凭证时立刻报人话，不去调 biliup", async () => {
  const { publishId } = seed({ credential: false });
  await assert.rejects(() => adapter.publish({ publishId }), /没有凭证|登录文件不存在/);
});

test("collect 把稿件指标写成快照，来源记 intercept", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET state='published', external_id='BV1yy411c7mF' WHERE id=?").run(publishId);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      code: 0,
      data: { arc_audits: [{ Archive: { bvid: "BV1yy411c7mF" }, stat: { view: 1234, like: 56, favorite: 7, coin: 8, share: 9, reply: 10 } }] },
    }),
  });
  try {
    const res = await adapter.collect({ publishId });
    assert.deepEqual(res.metrics, { play: 1234, like: 56, fav: 7, coin: 8, share: 9, comment: 10 });
  } finally {
    globalThis.fetch = realFetch;
  }

  const snap = db().prepare("SELECT source, status, metrics_json FROM snapshot WHERE publish_id=?").get(publishId);
  assert.equal(snap.source, "intercept");
  assert.equal(snap.status, "ok");
  assert.equal(JSON.parse(snap.metrics_json).play, 1234);
});

test("collect 遇到登录失效抛错并留下 degraded 事件", async () => {
  const { publishId } = seed();
  db().prepare("UPDATE publish SET state='published', external_id='BV1yy411c7mF' WHERE id=?").run(publishId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: -101, message: "账号未登录" }) });
  try {
    await assert.rejects(() => adapter.collect({ publishId }), /-101/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(db().prepare("SELECT 1 FROM event WHERE type='collect.degraded'").get());
});
