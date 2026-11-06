# Stage 0 capability probe

The experiment from [DESKTOP_PRODUCT_SPEC.md §12](../../docs/DESKTOP_PRODUCT_SPEC.md). `probe.mjs` uses only Node (no dependencies) and the official API at `api.tumblr.com`, authenticated with the user's own OAuth2 app and a bearer token. It never reads browser cookies, the web client's token or extension storage. Commands that touch the account refuse to run while a browser process is alive, unless `--browser-ok` is given. Results made that way are marked as not browser-exited.

Everything it writes goes to `%LOCALAPPDATA%\tumblr-studio-stage0`, outside the repository:

- `credentials.dpapi`: the client key, secret and tokens, encrypted with Windows DPAPI for the current user.
- `state.json`: blogs, plus the test posts the probe created.
- `results.json` and `report.md`: one row per capability, with the status `pass` / `fail` / `observed` / `unsupported` / `unknown` / `not_run`.

## Steps

1. Register an app at <https://www.tumblr.com/oauth/apps>. Set its **OAuth2 redirect URL** to `http://localhost:8765/callback` (the website and callback fields can be anything).
2. In your own terminal, run `node spike/stage0/probe.mjs setup` and enter the consumer key and secret. The secret is typed hidden. Alternatively, set `TUMBLR_CLIENT_ID` / `TUMBLR_CLIENT_SECRET` before running it.
3. Run `node spike/stage0/probe.mjs auth`. A browser opens once so you can allow access.
4. **Quit every browser process**, including Edge's background process. From then on:

| Command | What it does to the account |
|---|---|
| `read [--blog B]` | Read only: token refresh, blogs, the first two post pages and drafts/queue per blog, the first two follower pages of the main blog, following, block list |
| `write --blog T` | Creates **one private** image post on T, edits it (full PUT, then a tags-only PUT) |
| `write --blog T --reblog-to R` | Also reblogs it privately onto R |
| `… --allow-public` | Also makes the test post public for about 10 s and back, then publishes a reblog on R, hides the original and looks at the reblog as a logged-out visitor (A38); the reblog is made private afterwards |
| `block --blog B --target X` | Blocks X from B, verifies the result in the block list, unblocks it and verifies again. X must be an account you control. An existing block is left alone |
| `cleanup [--yes]` | Lists, or with `--yes` deletes, only the posts this probe created |
| `report` | Rewrites `report.md` |
| `selftest` | Offline: test image, DPAPI round trip, parsing of long ids |

Reporting is not attempted: no reporting endpoint is documented, and a test must never file a report.
