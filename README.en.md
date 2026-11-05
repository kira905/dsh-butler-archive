# dsh-butler-archive

[中文](README.md) · English

> ### What this is
> **A DSH plugin**: archive idle sessions out of the sidebar, and pull them back when you need them.
>
> ### What it solves
> Sessions pile up until the sidebar is pure noise — but deleting them feels unsafe, because some hold reasoning you will never write twice. This adds the missing middle state: **archive** (out of the main list, state and history fully kept), browse, restore, and an explicit real delete.
>
> ### Run it in one command
> ```powershell
> dsh plugin --profile web add @kira905/dsh-butler-archive
> ```
> After install the sidebar gets an "archive" entry; no config file to edit.
>
> ### What it looks like
> A row of sidebar buttons plus an archive page (grouped by batch, restore one or a whole batch). ⚠️ **No screenshots in this repo** — if you want to see the UI first, install it into a test profile and click through it.

---

> **Three different names (as of 2026-10-19): the repository, the npm package and the runtime id.**
> This repository was renamed from `dsh-archive-sessions` to **`dsh-butler-archive`** (older URLs on
> both hosts redirect automatically); the **npm package is `@kira905/dsh-butler-archive`** as of this
> version (the old `dsh-archive-sessions` package name exists only in historical releases).
> The **runtime id stays `dsh-archive-sessions`** — the route prefix `/api/dsh-archive-sessions/…`,
> the log prefix and the configuration file name are unchanged. Install/register sections below use
> the npm package name; route/log/configuration sections use the real runtime values.

A **DeepSeek Harness (DSH) web plugin** that adds an *Archived Sessions* section to the settings page:
list, preview, restore and delete sessions that were **physically moved out** of the `sessions` directory.

It manages **directory-level archival** — session directories relocated wholesale to
`<DSH_HOME>/_archived-sessions/<batch>/<session-id>/`, which is why they no longer show up in the
sidebar and are no longer decoded by the host process (that is what makes loading noticeably faster).
This is **not** the same as DSH's built-in "GUI archive", which only tags a session with
`archivedSessionIds` and leaves its files inside `sessions/`.

- **host half** — a set of loopback-only HTTP routes (default prefix `/api/dsh-archive-sessions`)
- **client half** — one settings-page section (grouped by working directory, inline preview, restore, delete)
- **Zero third-party runtime dependencies** — only `node:fs` / `node:path` / `node:zlib` / `node:os`

## Why archiving used to freeze the whole process (fixed in v0.4.0)

The DSH host process runs a **single-threaded event loop**, and v0.3.x moved sessions with *synchronous*
calls (`cpSync` / `statSync`) that never handed the thread back. Archiving a large batch therefore did
not just "take a while" — it **blocked the whole process**: other HTTP requests, other running sessions
and every timer sat in the queue until the copy finished.

Three causes, all fixed in v0.4.0:

| Area | Old behaviour | Why it blocked | Now |
|---|---|---|---|
| Copy | `cpSync` the whole directory, then a synchronous `statSync` walk to verify | one long synchronous call owns the thread | per-file **streamed** async copies (each chunk returns to the loop) with an explicit **macrotask** yield every `archive.copyBatchBytes` / `archive.copyBatchFiles` |
| Candidate scan | `statSync` on every entry to ask "is this a directory / does it hold a session file" | hundreds of synchronous disk round-trips | a single `readdir(recursive)` collects the whole tree as Dirents; only directories that really hold a session file get one `stat` for size/mtime |
| Index | load the entire `session_projcache.json` table, then filter by id | slower as the table grows, and fully synchronous | single-key read of `session_projcache/sessions/<id>.json` (falls back to the table only when the key file is missing) |

> ⚠️ Yielding must use a **macrotask** (`setImmediate`). Wrapping sync work in `Promise.resolve()` is
> *fake* async: microtasks only hand the stack to other microtasks in the same turn, so IO callbacks and
> timers never run.

Two more guarantees came with it:

- **Single-flight lock.** A second trigger while a run is in progress returns immediately — it is never
  queued and never starts a second copy:
  `{ "ok": false, "alreadyRunning": true, "code": "already-running", "running": { "trigger": "timer", "startedAt": ..., "elapsedMs": ..., "phase": "copy" } }`.
- **Re-entrant half-done state.** The idempotency key is **`sessionId` + target batch directory**
  (never the source path — that path changes once the session moves). A `pendingBatch` entry makes the
  next run reuse the same batch directory; an in-progress marker (`<batch>/.in-progress/<id>.json`) marks
  a partial copy so the next run only fills in the missing files. If the target already exists with
  **different bytes** and no marker, it is reported as a **conflict**: nothing is overwritten and the
  source is kept. Comparisons use sha256, not just file size.

Measured (40 sessions × 2 MB = 80 MB, 5 ms heartbeat recording the longest loop stall, two runs):

| | Longest loop stall | Total copy time |
|---|---|---|
| v0.3.x (synchronous) | **988.8 / 1200.1 ms** (basically the whole run) | 989 / 1200 ms |
| v0.4.0 (async batching) | **18.7 / 16.1 ms** | 807 / 1095 ms |

```bash
node scripts/test-archive-concurrency.mjs   # two concurrent triggers ⇒ one run, one copy on disk
node scripts/test-archive-resume.mjs        # half-done target ⇒ only the missing files are copied
node scripts/test-archive-duplicate.mjs     # identical duplicate skipped / different bytes ⇒ conflict, no overwrite
```

## Design rationale

This component is one implementation of the operations system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design):

- **Why it exists / where its boundary is** → *Autonomous Ops Steward* **§2 L4 Archival**,
  **§6 P2 event source "archive failure"**
- **Host version compatibility range** → *Multi-Machine Handoff & Cloud Relay* **§4.5
  "Compatibility requirements"** (also section 5 below)
- **Component-specific pitfalls and measurements** → the *Known limitations* section below, plus the
  compatibility regression checklist in [`docs/RELEASING.md`](docs/RELEASING.md)
- **Docs repo** → Gitee (mirror) <https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub (primary) <https://github.com/kira905/ops-handoff-design>

## Install

The package is published on npm as **`@kira905/dsh-butler-archive`**.

**Route 0 (recommended, since 0.3.5) — install it through the DSH plugin manager; the bundle layer mounts it for you**:

```bash
dsh plugin --profile web add @kira905/dsh-butler-archive
```

The package ships its own `cordis.patch.yml` (`package.json#dsh.bundle`), so installing it hands the profile a layer and **you do not edit the profile's `cordis.patch.yml` at all**.

Routes A/B/C below are the three manual variants; after those you still need the registration step.

**A — declare a dependency** in `profiles/<name>/package.json`:

```jsonc
{ "dependencies": { "@kira905/dsh-butler-archive": "^0.3.5" } }
```

and install it with whatever command you normally use for that profile.

**B — install straight into the profile**:

```bash
npm install @kira905/dsh-butler-archive --prefix <DSH_HOME>/profiles/<name>
```

**C — clone it (offline / you want to edit the source)**: `git clone https://github.com/kira905/dsh-butler-archive`,
copy it to `<DSH_HOME>/profiles/<name>/node_modules/@kira905/dsh-butler-archive/`
and add a mapping to `profiles/<name>/node_modules/.package-map.json`:

```json
{ "packages": { "@kira905/dsh-butler-archive": { "url": "./@kira905/dsh-butler-archive", "dependencies": {} } } }
```

### Register it — manual routes only

**Skip this when you used Route 0**; the bundle layer already inserted the row. For the manual routes,
append the `insert` block from [`cordis.patch.yml.example`](./cordis.patch.yml.example) to
`profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-butler-archive
      name: '@kira905/dsh-butler-archive'
```

> Releases up to `0.3.3` used the id/name `dsh-archive-sessions`; when upgrading from those,
> **remove the old entry before adding the new one**, or DSH fails with `duplicate loader entry id`.

⚠️ **Do not mix the two routes.** When you install through Route 0 (a bundle layer), do *not* also
append the block above into the profile's `cordis.patch.yml` — the same id twice makes DSH fail with
`duplicate loader entry id`. Existing hand-registered installs can stay as they are, or drop the manual
entry and switch to Route 0.

⚠️ The insert `id` must be unique, or DSH fails with `duplicate loader entry id`. Check first:

```bash
grep -n "id:" <DSH_HOME>/profiles/<name>/cordis.patch.yml
```

Then restart DSH, open the Web GUI, hard-refresh (Ctrl+Shift+R), and look for *Archived Sessions*
in Settings. If the section is missing: grep the host logs for `dsh-archive-sessions`, hit
`curl http://localhost:3080/api/dsh-archive-sessions/list`, and verify
`node_modules/<pkg>` + `.package-map.json` + the parsed insert.

## Configuration

Priority (later wins): built-in defaults → config file → environment variables.

Config file location (first match wins):

1. `$ARCHIVE_SESSIONS_CONFIG`
2. `<DSH_HOME>/<hostname>.archive-sessions.config.json` ← one file per machine, recommended
3. `<DSH_HOME>/archive-sessions.config.json`

`<DSH_HOME>` = `$DSH_HOME`, defaulting to `~/.dsh`. Environment overrides:
`DSH_HOME`, `DSH_SESSIONS_DIR`, `ARCHIVE_SESSIONS_CONFIG`, `ARCHIVE_SESSIONS_DIR`,
`ARCHIVE_SESSIONS_API_PREFIX`.

Relative path values resolve against `<DSH_HOME>` (`"archiveRoot": "archive-2"` →
`<DSH_HOME>/archive-2`), so one config file moves between Windows / macOS / Linux unchanged.

Full default set with comments: [`examples/archive-sessions.config.example.json`](./examples/archive-sessions.config.example.json).
Highlighted keys: `language`, `ui` / `uiByLanguage` (override every UI string),
`paths.archiveRoot|sessionsRoot|storagesDir`, `archive.headerFrames`,
`preview.maxMessages|maxMessageChars`, `server.apiPrefix|allowedHosts`,
`auto.enabled|dryRun|hours|intervalMs|minSizeMb|maxPerRun`.

> Restart DSH after editing the config file. The exceptions are the auto-archive knobs
> (`enabled` / `dryRun` / `hours` / `intervalMs` / `minSizeMb` / `maxPerRun`), which live in the state
> file and take effect immediately via the panel or `POST {prefix}/auto`.

### Health check CLI (v0.5.0+)

The plugin is the half that acts; `dsh-archive-health` is the read-only half. One command answers
"is the archive state healthy right now" with six checks, a human-readable (or `--json`) report and
a meaningful exit code (`0` all green, `3` some ⚠️/🔴, `2` usage error, `1` self-test failed).

```bash
dsh-archive-health --self-test      # 30 fixture checks, self-cleaning, no side effects
dsh-archive-health --json           # structured output for scripting
dsh-archive-health --strict         # treat any ghost as red (default splits real ghosts vs duplicates)
```

Checks: (1) archived-list vs ghost sessions, (2) auto-archive config against **your** expectations
(`--expect-json`; without it the tool only reports current values), (3) last auto-archive run,
(4) ungrouped sessions (sub-agents excluded via the log's first frame), (5) the ops ledger,
(6) source vs deployed copy sha256 (**off by default**: N/A outside a source checkout).

It is strictly read-only. The two networked checks degrade to ⚠️ "cannot tell" when the host is
unreachable — it never guesses. Cookie: put the base64 signing key in `DSH_RPC_COOKIE_SECRET`
(the CLI reads no credential file itself).

## Compatibility

`package.json` declares `"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0"` (optional peer).

| DSH host | Status | Notes |
|---|---|---|
| **`0.2.0-rc.2`** | ✅ **Measured end-to-end (2026-10-16)** | **The baseline of the range this version declares in `peerDependencies`**: installed and exercised for real on an isolated instance (separate data root + port 3090, host `0.2.0-rc.2`) — `scripts/verify-live.mjs` ran **26 checks, all PASS** against the live instance (real HTTP routes `list` / `detail` / `restore` / `delete` + real on-disk side effects + fixture self-cleanup); the client half `client.js` appears in the plugin resource list of the instance's startup HTML |
| later `0.2.x` | ⚠️ **Not measured; no promise** | The declared upper bound is `<0.3.0`; cross-minor compatibility is unverified — re-run the script above after upgrading |
| the `0.1.1-rc.2` – `0.1.5` lines | ⚠️ **Not end-to-end tested** (the declared baseline of `v0.3.2` and earlier) | **This version no longer declares a 0.1.x range**; users still on 0.1.x should stay on `v0.3.2` |
| `< 0.1.1-rc.2` / `>= 0.3.0` | ❌ Untested | The settings-section slot may differ / breaking host changes were not assessed |

**Runtime probing of two APIs.** The client half tries, in order:

1. `ctx.slots.inject("settings.section", …)` — the shape used by the official settings plugin on both lines;
2. `ctx.settings.installSection(…)` — only if it exists **and** takes fewer than 4 parameters, because on
   the new line that name is a *server-side settings registration*
   (`installSection(owner, ns, schema, entry, hooks)`), not a UI API. Using it blindly crashes the plugin.

The host half probes `ctx.webServer ?? ctx.server` for `.register(route)`. If neither is found the plugin
throws a clear error instead of silently doing nothing.

**Session-log format coupling** (re-check on host upgrades): the log is `session.jsonl.zstd`
(multi-frame zstd concatenation, decompressed frame by frame); events are
`{"type": "session" | "user/message" | "assistant/message" | …}` with text inside
`data.content[]` / `data.message.content[]`; a session directory is named by its id; and
`sessions/<cwd-key>/<session-id>/` derives the project key from the working directory.

## Permission boundary

| Design | Behaviour |
|---|---|
| loopback-only | Accepts only `127.0.0.1` / `::1`; everything else gets 403 |
| Host allow-list | `Host` header must match `server.allowedHosts` |
| Same-origin | When `Origin` is present it must match the Host; `sec-fetch-site: cross-site` is rejected |
| Credentials | Stores no secrets and makes no outbound requests |
| No path escape | `sessionId` may only be a directory name inside the archive root; `/`, `\`, `.`, `..` → 400 |
| Restore never overwrites | If the target already holds a session with that id it returns 409 and changes nothing |
| Restore is rollback-safe | Copy → per-file byte comparison → only then delete the source; a mismatch deletes the copy and keeps the source |
| Delete is permanent | No recycle bin; the UI asks for confirmation twice |
| Auto-archive is conservative | Off by default; even when enabled it defaults to dry-run; open turns and empty shells are never archived |
| Public config carries no paths | `GET {prefix}/config` returns UI strings and thresholds only |

What it deliberately does **not** do: authenticate callers (it assumes DSH Web is bound to loopback),
rate-limit, or encrypt the archive.

## Known limitations

1. **Restart DSH once after a restore** to see the session back in the sidebar — the plugin clears the
   `archivedSessionIds` flag, but the running registry keeps its in-memory copy.
2. **Delete cannot be undone** (no recycle bin).
3. **Batch convention**: the archive root is expected to hold batch directories
   (`<batch-timestamp>/<session-id>/`). Sessions laid out flat under the root may not be listed.
4. **Restore target derivation** uses the `cwd → project key` rule; when no cwd is available the session
   lands under `archive.unknownCwdKey` (default `_no-cwd`) and is grouped as unknown.
5. **The session log is a private host format** and may change between host versions.
6. **Metadata fallback decompresses the first N frames** (`archive.headerFrames`, default 8). Frames are
   small, so the cost is negligible; if no `user/message` appears in those frames the list falls back to
   showing the session id as the title.
7. **Auto-archive is mechanical**: "idle for N hours + closed turn + not an empty shell". Watch the dry-run
   candidate list before enabling live mode.
8. **Languages**: `zh` and `en` are built in; other values fall back to `en`.

## Repository layout

```
lib/index.js      host half: routes, scanning, preview, restore, delete, auto-archive
lib/client.js     client half: the settings-page section
lib/config.js     config layer (defaults / file / env / validation / UI strings)
examples/         config example with every default
cordis.patch.yml           the bundle patch `dsh.bundle` points at (Route 0 mounts it)
cordis.patch.yml.example   the manual insert block, with every config key spelled out
scripts/          deploy.mjs, verify-source.mjs, test-e2e.mjs, test-host.mjs, verify-live.mjs, push-publish.mjs
docs/RELEASING.md versioning policy, changelog rules, release checklist
```

## Development

```bash
node scripts/verify-source.mjs .   # syntax + config behaviour + sensitive-string scan
node scripts/test-e2e.mjs          # clean temp path + a second config + real HTTP (--keep to inspect)
DSH_HOME=<isolated home> node scripts/deploy.mjs         # idempotent deploy (+ backup + rollback script)
node scripts/verify-live.mjs --base http://127.0.0.1:3090 --home <isolated home>
```

All scripts are dependency-free — no `npm install` needed.

## License

**AGPL-3.0** (GNU Affero General Public License v3.0) — see [LICENSE](./LICENSE).

This project is open under **AGPL-3.0**: free to use and modify for personal, educational and
open-source projects. If you need it in a **closed-source** or **commercial** setting (where
AGPL's copyleft obligations do not apply), a **commercial license** is available — this
repository has no public contact address yet, so **please reach out by opening an issue**.

**License history**: **MIT up to and including v0.2.0; AGPL-3.0 from v0.3.0 onward.** Licenses
cannot be revoked for versions already published under MIT — a license change only binds
**future** versions (see `docs/RELEASING.md` §License-change check).

The session-decoding code was written independently; it contains no third-party private code or data.
The docs half of this open-source branch is licensed **CC BY-NC-SA 4.0**; the two halves are licensed
separately on purpose (documents to discourage commercial resale, code under a copyleft license with
commercial licensing available).
