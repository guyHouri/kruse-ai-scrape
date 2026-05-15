# Setup

forum_to_md needs a logged-in XenForo session to scrape `forum.jackkruse.com`. The forum returns an HTTP 403 login page to anonymous requests. You provide your own session cookies — they never get committed to the repo.

## 1. Install Node deps

```sh
cd forum_to_md
npm install
```

Requires Node 18+ (uses native `fetch`). Tested on Node 22.

## 2. Make a forum account

If you don't already have one:
1. Go to https://forum.jackkruse.com
2. Click **Sign Up** in the top right
3. Verify your email and finish the signup flow

Free accounts can see all public threads (~19,800 of them). Members-only "Inner Circle" threads (paid subscription, ~50 of them) are blocked even for logged-in free accounts — those will appear as `failed` in the extract log.

## 3. Grab your session cookies from Chrome

1. Log into https://forum.jackkruse.com in Chrome (or any Chromium-based browser).
2. Open **DevTools**: `F12` or right-click → **Inspect**.
3. Click the **Application** tab in DevTools.
4. In the left sidebar, expand **Cookies** → click `https://forum.jackkruse.com`.
5. You'll see a table of cookies. Copy the `Value` cell for each of these:

   | Cookie | What it is |
   |---|---|
   | `xf_user` | Your numeric user id + "remember me" token |
   | `xf_csrf` | CSRF token for POST requests (search session creation) |
   | `xf_session` | Active session token (the short-lived one — refresh when it expires) |

   `xf_from_search` and `_tccl_visitor` are optional analytics cookies — including them doesn't hurt.

## 4. Put the cookies into `cookies.txt`

Create a file named `cookies.txt` at the project root (next to `package.json`). Single line, format:

```
xf_user=<value-from-step-3>; xf_csrf=<value-from-step-3>; xf_session=<value-from-step-3>
```

Example (with fake values):

```
xf_user=12345%2Cabc123def456ghi789; xf_csrf=Xy7AbCdEfGhIjKlM; xf_session=zP9-wErTyUiOpAsDfGhJkL
```

Alternative: set the environment variable `XENFORO_COOKIE` to the same string. Useful for CI / cron. Env var takes priority over `cookies.txt`.

`cookies.txt` is gitignored — it will never be committed.

## 5. Verify cookies work

```sh
npm run status
```

If the forum responds and `data-logged-in="true"`, you're good. If you see HTTP 403 or `data-logged-in="false"`, refresh the cookies (XenForo session typically lasts a few hours to a few days, varies by server config).

## 6. Run the full pipeline

```sh
npm start
```

This chains four stages:
1. **pinned-discover** — walk every subforum's first page, harvest stickied threads.
2. **jack-discover** — chain XenForo search sessions to find every thread Jack Kruse has posted in (Phase 1 date-chain + Phase 2 per-subforum).
3. **extract** — fetch every thread (with pagination), write one MD per thread to `processed_mds/threads/<slug>.<id>.md`.
4. **split** — aggregate per-thread MDs into category bundles + `monster.md` + xlsx index.

Full run: ~2-3 hours from cold start. Resumable — every thread tracked via `extracted=true` in `threads.json`, so a re-run after cookie expiry picks up where it stopped.

## Cookie refresh

When `xf_session` expires mid-run:
1. The pipeline detects the login page (`data-logged-in="false"` or HTTP 403 across many threads), persists progress, and exits with code 2.
2. Re-do steps 3 and 4 above (copy fresh `xf_session` from Chrome into `cookies.txt`).
3. Re-run `npm run extract` (or whatever stage was running) — already-done threads are skipped.

## Monitoring

```sh
npm run status                # one-shot snapshot: threads.json, MDs, live procs, last 5 progress events
tail -f logs/workers.log      # one row per worker per minute
tail -f logs/progress.log     # one row per stage start/end + every 30 min
```
