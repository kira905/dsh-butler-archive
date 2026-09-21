# dsh-butler-archive

[中文](README.md) · English

> **Repository name ≠ package name.** This repository was renamed from `dsh-archive-sessions` to
> **`dsh-butler-archive`** (older URLs on both hosts redirect automatically), but the **plugin package
> name and its deployment directory remain `dsh-archive-sessions`** — that is the plugin id, tied to the
> `cordis.patch.yml` insert entry and to `<DSH_HOME>/profiles/<name>/node_modules/<package>`. Every
> package name below (install / register / route prefix) is therefore written with the real package name.

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

```bash
git clone https://github.com/kira905/dsh-butler-archive
```

Then install it into your DSH profile (either way works):

**A — declare a dependency** in `profiles/<name>/package.json`:

```jsonc
{ "dependencies": { "dsh-archive-sessions": "file:../../path/to/dsh-archive-sessions" } }
```

and install it with whatever command you normally use for that profile.

**B — copy it in manually**: `cp -r dsh-archive-sessions <DSH_HOME>/profiles/<name>/node_modules/`
and add a mapping to `profiles/<name>/node_modules/.package-map.json`:

```json
{ "packages": { "dsh-archive-sessions": { "url": "./dsh-archive-sessions", "dependencies": {} } } }
```

### Register it — through `cordis.patch.yml` insert

Append the block from [`cordis.patch.yml.example`](./cordis.patch.yml.example) to
`profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-archive-sessions
      name: 'dsh-archive-sessions'
```

⚠️ **Do not** put it into `dsh.profile.bundles`. This package declares `dsh.client` and no
`dsh.bundle`, so listing it in `bundles` makes DSH **fail to boot** with `declares no dsh.bundle`.
Client plugins always go through a patch insert.

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

## Compatibility

`package.json` declares `"@deepseek-ai/dsh": ">=0.1.1-rc.2 <0.2.0"` (optional peer).

| DSH host | Status | Notes |
|---|---|---|
| `0.1.1-rc.2` | ✅ **Validated end-to-end on a real DSH instance** (routes + settings section, 26 checks) | Current baseline |
| other `0.1.1` patches | ✅ Expected to work | Not tested individually |
| `>=0.1.2 <0.2.0` | ⚠️ Expected to work, **not end-to-end tested**: that line removed `installSettingsSection` / `settingsNamespace` from `@deepseek-ai/dsh-settings` (which is why older community plugins crash on boot). This plugin does not import those symbols, and the `ctx.slots.inject("settings.section", …)` API it uses is still present in `@deepseek-ai/dsh-client-ui-settings-general` on the new line (signature verified on `0.1.5-rc.1`) | Dependencies checked symbol by symbol |
| `>=0.2.0` | ❌ Unsupported | Not released yet; breaking changes are rejected explicitly |
| `<0.1.1-rc.2` | ❌ Untested | The settings-section slot may differ |

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
cordis.patch.yml.example   the insert block used to register the plugin
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
