// Run with: node --test   (Node 20+, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {
  handle, isCliClient, INSTALLER_URL, FAILURE_SCRIPT, EDGE_CACHE_SECONDS,
} from "../src/routes.js";

const SCRIPT = "#!/bin/bash\necho intelbrew\n";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function req(path, { ua, accept, method = "GET" } = {}) {
  const headers = {};
  if (ua !== undefined) headers["user-agent"] = ua;
  if (accept !== undefined) headers["accept"] = accept;
  return new Request("https://intelbrew.sh" + path, { method, headers });
}

// Mock fetch: records every URL it is asked for.
function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}
const okFetch = () => mockFetch(() => new Response(SCRIPT, { status: 200 }));

// Mock ASSETS binding: echoes the path so tests can see what was served.
const env = {
  ASSETS: {
    calls: [],
    async fetch(request) {
      const p = new URL(request.url).pathname;
      this.calls.push(p);
      // Workers Static Assets sends HTML as bare "text/html" (no charset).
      if (p === "/" ) return new Response("<!doctype html><title>Intelbrew</title>", {
        headers: { "content-type": "text/html" } });
      if (p === "/style.css") return new Response("body{}", {
        headers: { "content-type": "text/css" } });
      return new Response("<!doctype html><title>Not found</title>", {
        status: 404, headers: { "content-type": "text/html" } });
    },
  },
};

async function assertInstaller(res, f) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), `public, max-age=${EDGE_CACHE_SECONDS}`);
  assert.equal(await res.text(), SCRIPT);
  assert.deepEqual(f.calls, [INSTALLER_URL]);
}

test("CLI user agents are detected", () => {
  for (const ua of ["curl/8.7.1", "Wget/1.21.4", "fetch libfetch/2.0", "HTTPie/3.2.4",
                    "xh/0.22.0", "Mozilla/5.0 (Windows NT; Windows NT 10.0) PowerShell/7.4"]) {
    // PowerShell's UA starts with Mozilla; it is caught by its */* Accept instead.
    assert.equal(isCliClient(req("/", { ua, accept: "*/*" })), true, ua);
  }
  assert.equal(isCliClient(req("/", { ua: "curl/8.7.1", accept: BROWSER_ACCEPT })), true);
});

test("browsers are not CLI clients; missing Accept is", () => {
  assert.equal(isCliClient(req("/", { ua: CHROME_UA, accept: BROWSER_ACCEPT })), false);
  assert.equal(isCliClient(req("/", { ua: CHROME_UA })), true);
  assert.equal(isCliClient(req("/", { ua: "SomeBot/1.0", accept: "application/json" })), true);
});

test("curl on / gets the installer as text/plain from the fixed URL", async () => {
  const f = okFetch();
  await assertInstaller(await handle(req("/", { ua: "curl/8.7.1", accept: "*/*" }), env, f), f);
});

test("wget and HTTPie on / get the installer", async () => {
  for (const ua of ["Wget/1.21.4", "HTTPie/3.2.4"]) {
    const f = okFetch();
    await assertInstaller(await handle(req("/", { ua, accept: "*/*" }), env, f), f);
  }
});

test("a browser on / gets the landing page and no upstream fetch", async () => {
  const f = okFetch();
  const res = await handle(req("/", { ua: CHROME_UA, accept: BROWSER_ACCEPT }), env, f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(res.headers.get("vary"), /User-Agent/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(f.calls.length, 0);
});

test("HEAD / from a browser also gets the HTML charset", async () => {
  const f = okFetch();
  const res = await handle(req("/", { ua: CHROME_UA, accept: BROWSER_ACCEPT, method: "HEAD" }), env, f);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(f.calls.length, 0);
});

test("charset fix only touches HTML: other asset types keep their type", async () => {
  const f = okFetch();
  const css = await handle(req("/style.css", { ua: CHROME_UA, accept: BROWSER_ACCEPT }), env, f);
  assert.equal(css.headers.get("content-type"), "text/css");
  const missing = await handle(req("/nope", { ua: CHROME_UA, accept: BROWSER_ACCEPT }), env, f);
  assert.equal(missing.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(f.calls.length, 0);
});

test("missing pages: 404 status kept, HTML charset, security headers, no Vary", async () => {
  for (const [ua, accept] of [[CHROME_UA, BROWSER_ACCEPT], ["curl/8.7.1", "*/*"]]) {
    for (const method of ["GET", "HEAD"]) {
      const f = okFetch();
      const res = await handle(req("/no/such/page", { ua, accept, method }), env, f);
      assert.equal(res.status, 404, `${ua} ${method}`);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("vary"), null);
      assert.equal(f.calls.length, 0);
    }
  }
});

test("run_worker_first sends missing pages to the worker and keeps static files static", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const raw = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // Strip // line comments (none of the string values contain "//").
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  const pats = cfg.assets.run_worker_first;
  // Glob match: "*" matches anything, including "/".
  const m = (pat, path) => new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*") + "$").test(path);
  const workerFirst = (path) =>
    pats.some((p) => !p.startsWith("!") && m(p, path)) &&
    !pats.some((p) => p.startsWith("!") && m(p.slice(1), path));
  for (const p of ["/", "/install.sh", "/nope", "/no/such/page", "/404", "/404.html", "/index.html"]) {
    assert.equal(workerFirst(p), true, p);
  }
  // Every non-HTML file in public/ stays on the static path (public/_headers
  // applies; types and caching unchanged).
  const files = await readdir(new URL("../public/", import.meta.url), { recursive: true });
  const statics = files.map((f) => "/" + f.split("\\").join("/"))
    .filter((f) => /\.[a-z0-9]+$/i.test(f) && !/\.html$/.test(f) && f !== "/_headers");
  assert.ok(statics.includes("/style.css") && statics.includes("/img/tankard.png"));
  for (const f of statics) assert.equal(workerFirst(f), false, f);
});

test("landing page names the Tankard icon", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<img class="tankard-icon" src="\/img\/tankard.png" alt="Tankard"/);
});

test("/install.sh serves the script to any user agent, including browsers", async () => {
  for (const ua of [CHROME_UA, "curl/8.7.1", ""]) {
    const f = okFetch();
    await assertInstaller(await handle(req("/install.sh", { ua, accept: BROWSER_ACCEPT }), env, f), f);
  }
});

test("HEAD /install.sh returns headers without a body", async () => {
  const f = okFetch();
  const res = await handle(req("/install.sh", { method: "HEAD" }), env, f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await res.text(), "");
});

test("POST is refused", async () => {
  const f = okFetch();
  const res = await handle(req("/install.sh", { method: "POST" }), env, f);
  assert.equal(res.status, 405);
  assert.equal(f.calls.length, 0);
});

const failures = {
  "upstream 404": () => new Response("404: Not Found", { status: 404 }),
  "upstream 500": () => new Response("<html>oops</html>", { status: 500 }),
  "upstream redirect": () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
  "upstream HTML with 200": () => new Response("<!doctype html><p>portal</p>", { status: 200 }),
  "empty body": () => new Response("", { status: 200 }),
  "network error": () => { throw new TypeError("fetch failed"); },
};
for (const [name, responder] of Object.entries(failures)) {
  test(`failure path (${name}) returns a 502 shell-safe snippet, never HTML`, async () => {
    for (const path of ["/", "/install.sh"]) {
      const f = mockFetch(responder);
      const res = await handle(req(path, { ua: "curl/8.7.1", accept: "*/*" }), env, f);
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.text();
      assert.equal(body, FAILURE_SCRIPT);
      assert.doesNotMatch(body, /</);
    }
  });
}

test("failure snippet is valid shell that prints to stderr and exits 1", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("bash", ["-n"], { input: FAILURE_SCRIPT });
  assert.equal(r.status, 0, "bash -n syntax check");
  const run = spawnSync("bash", [], { input: FAILURE_SCRIPT, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /could not fetch the installer/);
});

test("no open proxy: other paths never fetch upstream", async () => {
  const paths = [
    "/d4rkwyng/intelbrew/main/README.md",
    "/install.sh/../../etc/passwd",
    "/install.sh.bak",
    "/install.sh/",
    "//raw.githubusercontent.com/d4rkwyng/intelbrew/main/install.sh",
    "/https://example.com/",
    "/?url=https://example.com/",
    "/install.sh?url=https://example.com/x",
  ];
  for (const p of paths) {
    const f = okFetch();
    await handle(req(p, { ua: "curl/8.7.1", accept: "*/*" }), env, f);
    // Either nothing was fetched, or only the one fixed installer URL.
    for (const u of f.calls) assert.equal(u, INSTALLER_URL, p);
  }
  // Query strings never change the fetched URL, and unknown paths fetch nothing.
  const f = okFetch();
  const res = await handle(req("/README.md", { ua: "curl/8.7.1", accept: "*/*" }), env, f);
  assert.equal(f.calls.length, 0);
  assert.equal(res.status, 404);
});

test("the entry module exports only a default fetch handler", async () => {
  const mod = await import("../src/worker.js");
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(typeof worker.fetch, "function");
});
