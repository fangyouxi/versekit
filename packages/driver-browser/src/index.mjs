// Chrome CDP driver: one persistent browser profile shared by every web adapter
// (TikTok Studio, 小红书创作服务平台, 抖音创作者中心).
//
// Ported from trustbridge/videos/factory/publishers/browser.mjs, where it is proven in production.
// The rules it encodes are not stylistic — see docs/adapter-contract.md §3:
//   · reuse one persistent profile (logins live there)
//   · keep timers unthrottled or automation stalls in background windows
//   · click with real mouse events (some sites ignore element.click())
//   · measure after scrollIntoView({behavior:'instant'})

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE =
  process.env.VK_CHROME_PROFILE ?? join(process.env.VK_HOME ?? homedir(), ".local", "state", "versekit", "browser");
export const PORT = Number(process.env.VK_CDP_PORT ?? 9333);
const HTTP = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** null = usable; otherwise a sentence a human can act on (this string is shown in the UI). */
export function browserReady() {
  const chrome = findChrome();
  if (!chrome) return "没有找到 Chrome/Chromium：装一个，或设置 VK_CHROME_BIN 指向它";
  if (process.env.VK_CHROME_BIN && !existsSync(process.env.VK_CHROME_BIN)) return `VK_CHROME_BIN 不存在：${process.env.VK_CHROME_BIN}`;
  return null;
}

async function up() {
  try {
    return (await fetch(`${HTTP}/json/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function ensureChrome() {
  if (await up()) return;
  const chrome = process.env.VK_CHROME_BIN ?? findChrome();
  if (!chrome) throw new Error(browserReady() ?? "没有可用的 Chrome");
  spawn(
    chrome,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Background windows get throttled timers; automation then stalls mid-upload.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await up()) return;
  }
  throw new Error(`Chrome 没有在端口 ${PORT} 上启动（profile: ${PROFILE}）`);
}

/** Opens a tab and returns a small driver. close() closes the tab. */
export async function openTab(url) {
  await ensureChrome();
  const target = await (await fetch(`${HTTP}/json/new?${encodeURI(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("连不上 Chrome 调试端口"));
  });

  let n = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.reject(new Error(`${p.method}: ${d.error.message}`)) : p.resolve(d.result);
      return;
    }
    for (const fn of listeners) fn(d);
  };

  const send = (method, params = {}, timeout = 60e3) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, timeout);
    });

  await send("Page.bringToFront");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const tab = {
    send,

    async eval(fn, ...args) {
      const expression = typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : fn;
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },

    async waitFor(fn, args = [], { timeout = 30e3, every = 500, what = "页面元素" } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await tab.eval(fn, ...args);
        if (v) return v;
        if (Date.now() > end) throw new Error(`等不到${what}`);
        await sleep(every);
      }
    },

    async click([x, y]) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(120);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    },

    /** Element centre in page coordinates, after an instant scroll (smooth scroll breaks the click). */
    point(find, arg) {
      return tab.eval(
        `(() => { const e = (${find})(${JSON.stringify(arg)}); if (!e) return null;
           e.scrollIntoView({ block: 'center', behavior: 'instant' });
           const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
    },

    type: (text) => send("Input.insertText", { text }),

    async key(key, code = key, keyCode = 0) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    },

    /** Select-all that works inside Draft.js on macOS (a synthetic Cmd+A selects nothing). */
    async selectAll() {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
    },

    async upload(expression, files) {
      const r = await send("Runtime.evaluate", { expression });
      if (!r.result.objectId) throw new Error("找不到上传控件");
      await send("DOM.setFileInputFiles", { objectId: r.result.objectId, files });
    },

    /** Clicks a button inside a closed shadow root (小红书's xhs-publish-btn): page JS can't see it, CDP can. */
    async clickInShadow(host, text) {
      await send("DOM.enable");
      const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
      const find = (node, pred) => {
        if (!node) return null;
        if (pred(node)) return node;
        for (const c of node.children ?? []) {
          const hit = find(c, pred);
          if (hit) return hit;
        }
        for (const s of node.shadowRoots ?? []) {
          const hit = find(s, pred);
          if (hit) return hit;
        }
        return null;
      };
      const el = find(root, (n) => (n.nodeName || "").toUpperCase() === host.toUpperCase());
      if (!el) throw new Error(`找不到 <${host}>`);
      const btn = find(
        el,
        (n) => (n.nodeName || "").toUpperCase() === "BUTTON" && (n.children ?? []).some((c) => c.nodeType === 3 && c.nodeValue.trim() === text),
      );
      if (!btn) throw new Error(`<${host}> 里找不到「${text}」按钮`);
      const { quads } = await send("DOM.getContentQuads", { nodeId: btn.nodeId });
      if (!quads?.length) throw new Error(`<${host}> 的「${text}」按钮不可见`);
      const xs = [0, 2, 4, 6].map((i) => quads[0][i]);
      const ys = [1, 3, 5, 7].map((i) => quads[0][i]);
      await tab.click([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    },

    /**
     * Collects JSON responses the page issues itself (the compliant way to read creator-backend data:
     * we never sign a request, we read the signed one the page already sent).
     *
     * match: RegExp against the response URL.
     * Returns [{url, body}] for every response captured while the predicate ran.
     */
    async collectJson(match, run, { timeout = 45e3, until = null } = {}) {
      await send("Network.enable");
      const found = [];
      const requests = new Map();
      const onEvent = (d) => {
        if (d.method === "Network.responseReceived" && match.test(d.params.response.url)) {
          requests.set(d.params.requestId, d.params.response.url);
        }
      };
      listeners.add(onEvent);
      const drain = setInterval(async () => {
        for (const [requestId, url] of [...requests]) {
          requests.delete(requestId);
          try {
            const r = await send("Network.getResponseBody", { requestId });
            found.push({ url, body: JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body) });
          } catch {
            /* body evicted before we read it — the next refresh will get it */
          }
        }
      }, 500);
      try {
        await run();
        const end = Date.now() + timeout;
        while (!until?.(found) && Date.now() < end) await sleep(500);
      } finally {
        clearInterval(drain);
        listeners.delete(onEvent);
      }
      return found;
    },

    async screenshot() {
      return Buffer.from((await send("Page.captureScreenshot")).data, "base64");
    },

    async goto(url) {
      await send("Page.navigate", { url });
    },

    async close() {
      ws.close();
      await fetch(`${HTTP}/json/close/${target.id}`).catch(() => {});
    },
  };

  return tab;
}
