// Routing logic for intelbrew.sh, kept apart from src/worker.js because the
// Workers runtime treats every named export of the main module as an
// entrypoint. Tested by test/routes.test.js.
//
// intelbrew.sh: serves the Intelbrew installer to command-line fetchers
// (`curl -fsSL https://intelbrew.sh | bash`) and a static landing page to browsers.
//
// "/" and "/install.sh" are routed here; every other path that reaches this
// script (missing pages, the 404 page, other HTML; see run_worker_first in
// wrangler.jsonc) is passed to the static assets unchanged except for the
// security headers and the HTML charset. The only upstream URL ever fetched is
// INSTALLER_URL below: there is no proxy.

export const INSTALLER_URL =
  "https://raw.githubusercontent.com/d4rkwyng/intelbrew/main/install.sh";

export const EDGE_CACHE_SECONDS = 300;
const UPSTREAM_TIMEOUT_MS = 10_000;

// A valid shell snippet, so `curl https://intelbrew.sh | bash` without -f still
// fails loudly instead of running an HTML error page.
export const FAILURE_SCRIPT =
  'echo "intelbrew.sh: could not fetch the installer, try https://github.com/d4rkwyng/intelbrew" >&2; exit 1\n';

const CLI_UA = /^(curl|wget|fetch|libfetch|httpie|xh|aria2|powershell|go-http-client|python-requests|python-urllib)\b/i;

export const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** True when the request looks like a command-line fetcher rather than a browser. */
export function isCliClient(request) {
  const ua = request.headers.get("user-agent") || "";
  if (CLI_UA.test(ua)) return true;
  const accept = request.headers.get("accept") || "";
  return !accept.toLowerCase().includes("text/html");
}

function withSecurityHeaders(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

// Workers Static Assets sends HTML as bare `text/html`; name the charset. Only
// touches responses that are already HTML, so nothing else becomes HTML.
function withHtmlCharset(response) {
  const type = response.headers.get("content-type") || "";
  if (/^text\/html\s*(;|$)/i.test(type)) {
    response.headers.set("content-type", "text/html; charset=utf-8");
  }
  return response;
}

function scriptResponse(body, status, cacheControl, method) {
  return withSecurityHeaders(
    new Response(method === "HEAD" ? null : body, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": cacheControl,
        "vary": "User-Agent, Accept",
      },
    }),
  );
}

/** Fetch the installer from its one fixed URL and serve it as plain text. */
export async function serveInstaller(request, fetchImpl = fetch) {
  let text;
  try {
    const upstream = await fetchImpl(INSTALLER_URL, {
      // Cloudflare edge cache for the upstream fetch; ignored outside Workers.
      cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual", // a redirect is a failure, never followed
    });
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    text = await upstream.text();
    // Never pass on anything that isn't a shell script (an HTML error page,
    // an empty body, a captive-portal response).
    if (!text.startsWith("#!")) throw new Error("upstream body is not a script");
  } catch (err) {
    console.error(`installer fetch failed: ${err && err.message}`);
    return scriptResponse(FAILURE_SCRIPT, 502, "no-store", request.method);
  }
  return scriptResponse(
    text, 200, `public, max-age=${EDGE_CACHE_SECONDS}`, request.method);
}

/** Route one request. `env.ASSETS` is the static-assets binding. */
export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path !== "/" && path !== "/install.sh") {
    // Missing paths (served the 404 page, status kept) and other HTML. Static
    // non-HTML files are excluded in run_worker_first and never get here, but
    // withHtmlCharset leaves non-HTML types alone anyway.
    return withHtmlCharset(withSecurityHeaders(await env.ASSETS.fetch(request)));
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(new Response("Method not allowed\n", {
      status: 405,
      headers: { "allow": "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    }));
  }
  if (path === "/install.sh" || isCliClient(request)) {
    return serveInstaller(request, fetchImpl);
  }
  const page = withHtmlCharset(withSecurityHeaders(await env.ASSETS.fetch(request)));
  page.headers.set("vary", "User-Agent, Accept");
  return page;
}
