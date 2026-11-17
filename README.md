# intelbrew.sh

The site for [Intelbrew](https://github.com/d4rkwyng/intelbrew) at **intelbrew.sh**: a
Cloudflare Worker with static assets.

- `curl -fsSL https://intelbrew.sh | bash` installs Intelbrew.
- A browser at https://intelbrew.sh gets a small landing page.

No framework, no build step, no runtime dependencies, no cookies or analytics.

## How the routing works

`wrangler.jsonc` sets `assets.run_worker_first` to `["/", "/install.sh"]`, so only those
two paths run the script (`src/worker.js`, logic in `src/routes.js`). Every other path is
a static file from `public/`, with `public/404.html` for anything missing.

| Request | Response |
|---|---|
| `GET /` from a command-line fetcher | the installer, `text/plain; charset=utf-8` |
| `GET /` from a browser | `public/index.html` |
| `GET /install.sh`, any client | the installer |
| upstream failure on either | `502`, a one-line shell snippet (below) |
| anything else | a static file, or the 404 page |

**Command-line fetcher** means the User-Agent starts with `curl`, `Wget`, `fetch`,
`HTTPie` (and a few similar), or the `Accept` header doesn't contain `text/html`.
Responses from `/` carry `Vary: User-Agent, Accept`.

**The installer** is fetched from one fixed URL,
`https://raw.githubusercontent.com/d4rkwyng/intelbrew/main/install.sh`, cached at the edge
for 5 minutes and served with `cache-control: public, max-age=300`. Nothing else is ever
fetched from GitHub: there is no path or query parameter that changes the URL, so it is
not an open proxy. Redirects are not followed.

**On failure** (network error, non-2xx, a redirect, or a body that doesn't start with
`#!`), it returns `502` with `cache-control: no-store` and this body, which is valid shell,
so a pipe into `bash` never runs an HTML page:

```sh
echo "intelbrew.sh: could not fetch the installer, try https://github.com/d4rkwyng/intelbrew" >&2; exit 1
```

(With `curl -f`, curl itself stops on the 502 and prints its own error.)

**Security headers** on every response: a CSP with `default-src 'none'` and only
same-origin scripts, styles and images; HSTS; `X-Content-Type-Options: nosniff`;
`Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`. The worker sets them on its own
responses and `public/_headers` sets them on static files.

### Main or a release tag?

The installer is served from `main`, the same URL the Intelbrew README uses. Pinning to a
release tag would make what `intelbrew.sh` serves reviewable and stable, at the cost of a
change here for every installer release. The intelbrew repo has no tags yet, so it uses
`main`; to pin later, change `INSTALLER_URL` in `src/routes.js`.

## Files

```
src/worker.js      entry point: exports only the fetch handler
src/routes.js      routing, CLI detection, installer fetch, headers
public/            landing page, 404 page, CSS, copy-button JS, images, favicons,
                   robots.txt, _headers
test/              node --test tests for src/routes.js (mocked fetch)
wrangler.jsonc     Worker config (no account_id, no routes)
```

The spot illustrations in `public/img/` are pixel art generated with PixelLab, scaled 2x
nearest-neighbour and shown with `image-rendering: pixelated`.

## Local development

Tests (Node 20+, no install):

```sh
node --test
```

Local server (downloads wrangler through npx; no Cloudflare login needed for local mode):

```sh
npx wrangler dev
# then, in another terminal:
curl -s http://localhost:8787/ | head -3                     # the installer
curl -s -A Mozilla/5.0 -H 'Accept: text/html' http://localhost:8787/ | head -3   # the page
```

## Connecting it to Cloudflare

Nothing here deploys by itself. `wrangler.jsonc` deliberately has no `account_id` and no
`routes`; the account comes from the Git connection and the domain is added in the
dashboard.

1. Push this repo to GitHub.
2. Cloudflare dashboard: **Workers & Pages** → **Create** → **Import a repository** →
   choose this repo. The Worker name must match `wrangler.jsonc`: `intelbrew-sh`. Build
   command: none. Deploy command: the default (`npx wrangler deploy`). Save and deploy.
3. In the new Worker: **Settings** → **Domains & Routes** → **Add** → **Custom domain** →
   `intelbrew.sh`. (The zone must be on the same Cloudflare account; Cloudflare creates
   the DNS record and certificate.)
4. Optional: in the same place, turn off the `workers.dev` route, or set
   `"workers_dev": false` in `wrangler.jsonc`.

Each push to `main` then redeploys.

## Testing the live site

```sh
curl -sSI https://intelbrew.sh/                       # 200, text/plain, cache-control
curl -fsSL https://intelbrew.sh | head -3             # #!/bin/bash ...
curl -fsSL https://intelbrew.sh | bash -n && echo ok  # parses as bash, runs nothing
curl -fsSL https://intelbrew.sh/install.sh | diff - <(curl -fsSL https://raw.githubusercontent.com/d4rkwyng/intelbrew/main/install.sh) && echo same
curl -sS -A Mozilla/5.0 -H 'Accept: text/html' https://intelbrew.sh/ | grep -o '<title>.*</title>'
curl -sS -o /dev/null -w '%{http_code}\n' https://intelbrew.sh/nope   # 404
```

After a change to `install.sh` upstream, `intelbrew.sh` serves it within about 5 minutes
(plus GitHub's own raw cache, also about 5 minutes).

## Licence

BSD-2-Clause, like Intelbrew ([LICENSE](LICENSE)). Intelbrew is not affiliated with or
endorsed by Homebrew.
