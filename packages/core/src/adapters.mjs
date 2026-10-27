// Adapter and channel discovery.
//
// Adapters are separate packages (`packages/adapter-<platform>`) so they can be versioned and
// tested on their own. The core never imports one directly — it reads the registry — which is
// what keeps "core cannot depend on an adapter" true instead of aspirational.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { open } from "./index.mjs";
import { fileURLToPath } from "node:url";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ADAPTER_METHODS = ["login", "check", "publish", "collect"];

/** Shape check — the same one contract tests assert, kept here so a bad adapter fails at load. */
function validate(adapter, where) {
  if (!adapter?.platform) throw new Error(`${where}: 缺少 platform`);
  if (typeof adapter.ready !== "function") throw new Error(`${where}: 缺少 ready()`);
  for (const m of ADAPTER_METHODS) {
    if (adapter[m] && typeof adapter[m] !== "function") throw new Error(`${where}: ${m} 不是函数`);
  }
  if (!adapter.publish && !adapter.collect) throw new Error(`${where}: publish 与 collect 都没有，适配器没有意义`);
  const caps = adapter.capabilities ?? {};
  return {
    platform: adapter.platform,
    publish: caps.publish ?? (adapter.publish ? "web" : "none"),
    collect: caps.collect ?? (adapter.collect ? "web" : "none"),
    requiresQualification: caps.requiresQualification ?? false,
    visibility: caps.visibility ?? null,
    adapter,
  };
}

/**
 * Loads every installed adapter. `only` restricts to some platforms (useful in tests and in
 * `vk doctor`). A broken adapter is reported, not fatal — one bad package must not stop the rest.
 */
export async function loadAdapters({ only = null, root = PACKAGES } = {}) {
  const dirs = existsSync(root)
    ? readdirSync(root).filter((d) => d.startsWith("adapter-") && existsSync(join(root, d, "package.json")))
    : [];
  const loaded = [];
  const errors = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dirPath, "package.json"), "utf8"));
    } catch (err) {
      errors.push({ dir, message: `读不到 package.json: ${err.message}` });
      continue;
    }
    const entry = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main ?? "src/index.mjs";
    try {
      const mod = await import(pathToFileURL(join(dirPath, entry)).href);
      const adapter = mod.default ?? mod.adapter;
      const info = validate(adapter, dir);
      if (only && !only.includes(info.platform)) continue;
      loaded.push(info);
    } catch (err) {
      errors.push({ dir, message: err.message });
    }
  }
  return { adapters: loaded, errors };
}

/** Turns loaded adapters into runner handlers. Missing capabilities are simply not registered. */
export function buildHandlers(adapters) {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
  const handlers = {};

  // The platform lives on the publish row, not on the run: the runner stays platform-agnostic.
  const platformOf = (publishId) =>
    open()
      .prepare("SELECT a.platform FROM publish p JOIN account a ON a.id = p.account_id WHERE p.id = ?")
      .get(publishId)?.platform ?? null;

  const adapterFor = (publishId) => {
    const platform = platformOf(publishId);
    if (!platform) throw new Error(`找不到发布 ${publishId}，或它的账号没有平台`);
    const adapter = byPlatform.get(platform);
    if (!adapter) throw new Error(`没有 ${platform} 适配器（装 packages/adapter-${platform}）`);
    return adapter;
  };

  if (adapters.some((a) => a.publish !== "none")) {
    handlers.publish = async (run) => adapterFor(run.target_id).adapter.publish({ publishId: run.target_id });
  }
  if (adapters.some((a) => a.collect !== "none")) {
    handlers.collect = async (run) => {
      const adapter = adapterFor(run.target_id);
      if (adapter.collect === "none") throw new Error(`${adapter.platform} 还没有指标采集`);
      return adapter.adapter.collect({ publishId: run.target_id });
    };
  }
  return handlers;
}
