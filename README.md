# dsh-butler-archive

[English](README.en.md) · 中文（默认）

> ### 这是什么
> **一个 DSH 插件**：把闲置会话从侧边栏归档掉，需要时再翻出来恢复。
>
> ### 它解决什么
> 会话越攒越多，侧边栏变成一片噪音；但直接删又不敢 —— 里面可能有再也不会写第二遍的推理过程。这个插件给的是**中间态**：归档（搬出主列表、状态与历史全保留）+ 浏览 + 恢复 + 真删（明确动作），入口就在侧边栏。
>
> ### 一条命令跑起来
> ```powershell
> dsh plugin --profile web add @kira905/dsh-butler-archive
> ```
> 装完侧边栏多出「归档」入口，不用改任何配置文件。
>
> ### 它长什么样
> 侧边栏一组按钮 + 一个归档页（按批次列出、可单条或整批恢复）。⚠️ 本仓**没有截图** —— 想先看界面，可以装进一个测试 profile 点一遍再决定。
>
> 装法与自检见下方。

---

> **本仓装完即用**：`dsh plugin --profile <profile> add @kira905/dsh-butler-archive` 一条命令，`dsh.bundle` 会让它自动挂进 profile 的组合列表，**不需要再手工写 `cordis.patch.yml`**。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-butler-archive"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-butler-archive —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-butler-archive"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-butler-archive）

# ③ 本仓是插件、没有命令入口 —— 跳过这一步（判据看 ① 与 ②）
```

---

> **仓库名 / npm 包名 / 运行时 id 三者不是一回事（2026-10-19 起）**：本仓原名 `dsh-archive-sessions`，
> 更名 **`dsh-butler-archive`**（GitHub / Gitee 两端旧地址自动重定向）；**npm 包名自本版起为
> `@kira905/dsh-butler-archive`**（旧的 `dsh-archive-sessions` 只存在于历史版本）。
> 但**运行时标识仍是 `dsh-archive-sessions`** —— 路由前缀 `/api/dsh-archive-sessions/…`、日志前缀、
> 配置文件名都不变；本文档里**安装 / 注册**段按 npm 包名写，**路由 / 日志 / 配置**段按运行时实际值写。

一个 **DeepSeek Harness (DSH) Web 插件**：在设置页新增「归档会话管理」分栏，用来查看 / 预览 /
恢复 / 删除那些被**物理移出** `sessions` 目录的老会话。

它管理的是**目录级归档**——会话目录被整体搬到 `<DSH_HOME>/_archived-sessions/<批次>/<session-id>/`，
因而不再出现在侧边栏、也不再被主进程解码（这是它能显著降低启动/加载开销的原因）。
注意：这**不同于** DSH 自带的「GUI 归档」——后者只是给会话打 `archivedSessionIds` 标记，
文件仍留在 `sessions` 目录里。

- **host 半**：注册一组 loopback-only HTTP 路由（默认前缀 `/api/dsh-archive-sessions`）：

  | 方法 | 路径 | 作用 |
  |---|---|---|
  | GET | `{prefix}/config` | 公开配置（界面文案 / 阈值，不含任何绝对路径） |
  | GET | `{prefix}/list` | 列出归档会话 |
  | GET | `{prefix}/detail` | 解码单个会话尾部 N 条消息 |
  | POST | `{prefix}/restore` | 两段式恢复回 `sessions` |
  | POST | `{prefix}/delete` | 物理删除归档会话 |
  | GET | `{prefix}/auto` | 读取自动归档配置与上次结果 |
  | POST | `{prefix}/auto` | 更新自动归档配置 |
  | POST | `{prefix}/auto/run` | 立即执行一次自动归档（默认试跑） |

- **client 半**：设置页分栏 UI（按工作目录分组、行内预览、恢复、删除）。
- **零第三方运行时依赖**：只用 `node:fs` / `node:path` / `node:zlib` / `node:os`。

---

## 一、能力

| 功能 | 说明 |
|---|---|
| 列表 | 扫描归档根下所有批次目录，列出每个会话的标题 / 工作目录 / 轮数 / 大小 / 时间（优先读 `session_projcache.json`，缺失时解会话日志头部兜底） |
| 预览 | 解码会话日志（多帧 zstd 拼接，逐帧解），返回尾部 N 条消息 + 事件类型计数 |
| 恢复 | **两段式**：复制 → 逐文件字节校验 → 才删除归档源；目标已存在同名会话时拒绝（绝不覆盖） |
| 删除 | 物理删除归档会话目录（客户端有二次确认弹窗），同时清理批次清单条目 |
| 自动归档 | 可选定时任务：把「超过 N 小时未活跃 + 回合已闭合 + 非空壳」的会话自动搬进归档根。**默认关闭，且默认只试跑不搬** |

---

## 为什么归档会把整个进程卡住（v0.4.0 起已修）

**一句话**：DSH 的 agent 主进程是**单线程事件循环**，而 v0.3.x 的归档搬运是**同步**的 ——
`cpSync` / `statSync` 一路跑到底，中间一次都不把线程还回去。于是「归档一大批会话」这件事
不是"归档慢"，而是**整个进程被按住**：这段时间里别的 HTTP 请求（包括你正在看的界面、
别的正在跑的会话）全在排队，看起来就是全站卡死、转圈、心跳超时。

三处病灶（v0.4.0 全改掉）：

| 病灶 | 老做法 | 为什么卡 | 现在 |
|---|---|---|---|
| 搬运 | `cpSync` 整目录 + 同步 `statSync` 再走一遍比对 | 一次同步调用占满线程，几十上百 MB 期间事件循环完全不转 | 逐文件**流式**异步复制（读一块写一块，天然回到事件循环），并每累计 `archive.copyBatchBytes` / `archive.copyBatchFiles` 主动 `await` 一次**宏任务**让出 |
| 候选扫描 | 每个目录项 `statSync` 问一次「你是目录吗 / 里面有没有数据文件」 | 会话一多就是成百上千次同步磁盘往返 | 一次 `readdir(recursive)` 拿整棵树的目录项（Dirent 自带类型），只有真有会话文件的目录才 `stat` 一次取大小 / mtime |
| 索引 | 整张 `session_projcache.json` 表加载进内存再按 id 筛 | 表越大越慢，且全程同步解析 | 单键读 `session_projcache/sessions/<id>.json`，一条会话只读它自己那一个文件（读不到才回退整表） |

> ⚠️ 让出事件循环必须用**宏任务**（`setImmediate`）。把同步调用包进 `Promise.resolve()` 是**假异步**：
> 微任务只是把栈交给同一轮里排在后面的微任务，IO 回调与定时器根本轮不到。

顺带修掉的第二件事：**同一次归档可能被跑两遍**（定时器到点 + 手动点「立即试跑」撞在一起，
或者上一轮还没搬完下一轮又起来了）。v0.4.0 加了**单飞锁**：

- 同一时刻只允许一个归档任务。第二次触发**立刻返回**（不排队、不重跑）：

  ```json
  {
    "ok": false, "alreadyRunning": true, "code": "already-running",
    "running": { "runId": "run-1-...", "trigger": "timer", "startedAt": 1793350725991, "elapsedMs": 812, "phase": "copy" }
  }
  ```

- 「谁在跑、从什么时候开始、跑到哪一步」都在 `running` 里，界面直接显示「已经在跑了」。

第三件事：**半完成态可重入** —— 搬到一半进程崩了 / 机器重启了，下一轮**接着搬**，而不是重搬一遍：

- **幂等键 = `sessionId` + 目标批次目录**（⚠️ 不是源路径 —— 会话搬走后源路径就变了，拿它当键必然错）。
- 状态文件里记一个 `pendingBatch`，下一轮复用同一个批次目录，于是"同一件事"能被认出来。
- 四态判定：目标不存在 ⇒ 全新搬；目标与源**逐字节一致** ⇒ 记「已搬」、只补删源那一步；
  目标里留着**搬运中标记**（`<批次>/.in-progress/<id>.json`）⇒ 半完成态，只补缺的文件（已一致的文件跳过）；
  目标存在但**没有标记、内容又不一致** ⇒ **报冲突、原样保留、绝不覆盖**（宁可停下等人看）。
- 判据用 sha256，不只比大小 —— 同名同大小、内容不同的文件必须算冲突。

想自己看一眼（三条夹具都能跑红，见 `scripts/`）：

```bash
node scripts/test-archive-concurrency.mjs   # 并发两次只跑一次
node scripts/test-archive-resume.mjs        # 半完成态只补缺的
node scripts/test-archive-duplicate.mjs     # 重复副本不重搬 / 冲突不覆盖
```

实测（40 个会话 × 2 MB = 80 MB；搬运期间用 5 ms 心跳量「事件循环最长被按住多久」，两次读数）：

| | 事件循环最长的阻塞时长 | 搬运总耗时 |
|---|---|---|
| v0.3.x（同步搬运） | **988.8 / 1200.1 ms**（几乎是整段搬运全程按住） | 989 / 1200 ms |
| v0.4.0（异步分批） | **18.7 / 16.1 ms** | 807 / 1095 ms |

结论：搬运期间事件循环还在转（心跳回合约 160~200 次），吞吐没有变差。

---

## 二、前置条件

- DSH 主包 `>= 0.2.0-rc.2 < 0.3.0`（版本区间与兼容性细节见第五节）
- Node.js `>= 20`
- 一个能写 `profiles/<name>/` 的 DSH 安装（默认 profile 名为 `web`）

---

## 三、安装（从零开始）

### 0. 先备份

改 profile 之前先把 `profiles/<name>/package.json`、`.package-map.json`、`cordis.patch.yml`
三个文件复制一份留底（改错了好回滚）。

### 1. 把包放进去

包已发布到 npm：**`@kira905/dsh-butler-archive`**。

**方式 0（推荐，0.3.5 起）—— 走 DSH 插件管理器，bundle 层自动挂载**：

```bash
dsh plugin --profile web add @kira905/dsh-butler-archive
```

本包自带 `cordis.patch.yml`（`package.json#dsh.bundle`），装它 = profile 拿到一个层，**不用手工改 profile 的 `cordis.patch.yml`**（也就跳过后面的第 2 步）。

下面的方式 A/B/C 是「手工装」的三个变体，装完还要按第 2 步手工注册。

> **方式 A/B/C 统一叫「手工装（旧版 / 离线用）」** —— 只在离线、要改源码、或装旧版（不带 `dsh.bundle`）时才走。
> **两条路别混用**：混用会在组合里留下**同一件的两份登记**（`dsh.profile.bundles` 里同一包名两行，或 `cordis.patch.yml` 里同一个 id 两行；后者**不一定会报错**，光看日志发现不了）⇒ 判据 = 两处各数一遍，每一处必须 == 1。

**方式 A（推荐，声明式）**——在 `profiles/<name>/package.json` 里加一条依赖并安装：

```jsonc
{
  "dependencies": {
    "@kira905/dsh-butler-archive": "^0.3.5"
  }
}
```

```bash
cd <DSH_HOME>/profiles/<name>
# 用你平时给这个 profile 装插件的那条命令安装（pnpm/npm 均可）
```

**方式 B（npm 直接装进 profile）**：

```bash
npm install @kira905/dsh-butler-archive --prefix <DSH_HOME>/profiles/<name>
```

**方式 C（git 克隆，离线 / 要改源码时）**——先把包目录复制成实体目录：

```bash
git clone https://github.com/kira905/dsh-butler-archive dsh-butler-archive
cp -r dsh-butler-archive <DSH_HOME>/profiles/<name>/node_modules/@kira905/dsh-butler-archive
```

同时给它补一条 package-map 映射（`profiles/<name>/node_modules/.package-map.json`）：

```json
{
  "packages": {
    "@kira905/dsh-butler-archive": { "url": "./@kira905/dsh-butler-archive", "dependencies": {} }
  }
}
```

> 三种方式的差别只在于「谁负责把文件放到 `node_modules` 下」，插件本身的行为完全一致。

### 2. 注册插件（只有「手工装法」要这一步）

**走方式 0 就跳过本节** —— bundle 层已经把它插好了。下面只给手工装（方式 A/B/C）用：
把 [`cordis.patch.yml.example`](./cordis.patch.yml.example) 里的 `insert` 段追加进 profile 的
`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-butler-archive
      name: '@kira905/dsh-butler-archive'
```

> 旧版（≤ `0.3.3` 的发布形态）条目 id/name 是 `dsh-archive-sessions`；从旧版升级时**先删掉旧条目再加新条目**，
> 否则会撞 `duplicate loader entry id`。

⚠️ **两种装法别混用**：走方式 0（bundle 层）时，profile 的 `cordis.patch.yml` 里**不要再手工追加**
上面这段 —— 同一个 id 注册两遍会崩 `duplicate loader entry id`。反过来，已经手工 insert 过的现有安装
继续手工即可，或先删掉手工条目再改走方式 0。

⚠️ `insert` 的 `id` 不能和已有条目重复，重复会崩 `duplicate loader entry id`。加之前先查：

```bash
grep -n "id:" <DSH_HOME>/profiles/<name>/cordis.patch.yml
```

### 3. 重启 DSH 并验证

重启 DSH → 打开 Web GUI → **硬刷新**（Ctrl+Shift+R）→ 进入 设置，左侧应出现
「归档会话管理」分栏。

分栏没出现时按顺序排查：

1. 主进程日志里搜 `dsh-archive-sessions`（启动失败会留痕）；
2. 直接打接口确认 host 半活着：`curl http://localhost:3080/api/dsh-archive-sessions/list`
   （若你改了 `server.apiPrefix`，用改后的前缀）；
3. 确认 `.package-map.json` 与 `node_modules/<包名>` 都在位；
4. 确认 `cordis.patch.yml` 里的 `insert` 真的被解析到了（重复 id / YAML 缩进错误都会让整段失效）。

---

## 四、配置

配置解析优先级（后者覆盖前者）：

1. 插件内置默认值（见 [`examples/archive-sessions.config.example.json`](./examples/archive-sessions.config.example.json)）
2. 配置文件
3. 环境变量

配置文件的位置（先找到谁就用谁）：

| 优先级 | 路径 |
|---|---|
| 1 | `$ARCHIVE_SESSIONS_CONFIG` 指向的文件 |
| 2 | `<DSH_HOME>/<主机名>.archive-sessions.config.json` ← 一台机器一份，多机共存推荐 |
| 3 | `<DSH_HOME>/archive-sessions.config.json` |

其中 `<DSH_HOME>` = `$DSH_HOME`，未设置时是 `~/.dsh`。

支持的环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 用户数据根（默认 `~/.dsh`） |
| `DSH_SESSIONS_DIR` | 活跃会话目录（默认 `<DSH_HOME>/sessions`） |
| `ARCHIVE_SESSIONS_CONFIG` | 配置文件路径 |
| `ARCHIVE_SESSIONS_DIR` | 归档根目录（默认 `<DSH_HOME>/_archived-sessions`） |
| `ARCHIVE_SESSIONS_API_PREFIX` | HTTP 路由前缀 |

**路径键写成相对路径时按 `<DSH_HOME>` 解析**（例：`"archiveRoot": "archive-2"` →
`<DSH_HOME>/archive-2`），所以一份配置可以在 Windows / macOS / Linux 之间搬运，不必写死用户名。

常用键速查（完整默认值与注释见示例文件）：

| 键 | 默认 | 说明 |
|---|---|---|
| `language` | `"zh"` | 界面语言，内置 `zh` / `en` |
| `ui` / `uiByLanguage` | `{}` | 逐条覆盖界面文案；键表见 `lib/config.js` 的 `DEFAULT_UI` |
| `paths.archiveRoot` | `null` | 归档根；`null` = `<DSH_HOME>/_archived-sessions` |
| `paths.sessionsRoot` | `null` | 活跃会话根；`null` = `<DSH_HOME>/sessions` |
| `paths.storagesDir` | `null` | 存储目录；`null` = `<DSH_HOME>/storages` |
| `archive.headerFrames` | `8` | 元数据兜底时向前解几帧（见「已知限制」） |
| `archive.statePath` | `null` | 自动归档状态文件路径；`null` = 归档根下 `.auto-archive.json` |
| `preview.maxMessages` | `50` | 预览返回的消息条数 |
| `preview.maxMessageChars` | `4000` | 单条消息截断长度 |
| `server.apiPrefix` | `"/api/dsh-archive-sessions"` | 路由前缀 |
| `server.allowedHosts` | `["127.0.0.1","localhost","[::1]"]` | 允许的 Host 名 |
| `auto.enabled` | `false` | 是否开启自动归档 |
| `auto.dryRun` | `true` | `true` 只列候选、不移动文件 |
| `auto.hours` | `48` | 多少小时未活跃才成为候选 |
| `auto.minSizeMb` / `auto.maxPerRun` | `0` / `50` | 候选大小下限 / 单次上限 |

> 改配置文件后**需要重启 DSH** 才生效（插件启动时载入一次并常驻内存）。
> 例外是自动归档的 `enabled` / `dryRun` / `hours` / `intervalMs` / `minSizeMb` / `maxPerRun`——
> 这几项由面板或 `POST {prefix}/auto` 维护在状态文件里，改完立即生效。

---

## 五、兼容性

### 支持的主包版本

| DSH 主包 | 状态 | 说明 |
|---|---|---|
| **`0.2.0-rc.2`** | ✅ **已端到端实测（2026-10-16）** | **本版 `peerDependencies` 声明的区间基线**：在隔离实例（独立数据根 + 端口 3090，主包 `0.2.0-rc.2`）上**真装真跑** —— 本仓 `scripts/verify-live.mjs` 对运行中的实例跑 **26 项检查全 PASS**（真实 HTTP 路由 `list` / `detail` / `restore` / `delete` + 真实磁盘副作用 + 夹具自清理）；客户端半 `client.js` 出现在实例启动 HTML 的插件资源清单里 |
| `0.2.x` 后续版本 | ⚠️ **未实测，不作承诺** | 区间上界写 `<0.3.0`；次版本间是否仍兼容**未验证**，升级请重跑上面的实测脚本 |
| `0.1.1-rc.2` ~ `0.1.5` 线 | ⚠️ **未端到端实测**（历史版本 `v0.3.2` 及之前的声明基线） | **本版起 `peerDependencies` 不再声明 0.1.x 区间**；仍跑 0.1.x 的用户请用 `v0.3.2` |
| `< 0.1.1-rc.2` / `>= 0.3.0` | ❌ 未验证 | settings 分栏的 slot 形态可能不同 / 主包破坏性变更未评估 |

> **依赖声明说明（重要）**：`package.json` 的 `dsh.client.inject` 里，
> `@deepseek-ai/dsh-client-runtime`（该包在 0.1.2 之后**整包停更**）与
> `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives`
> （这两个包**从未**声明 `dsh.client`，属源码期核心库）在 0.1.5 线上是**无效条目**。
> DSH 对无法解析的 inject 条目**静默跳过、不报错**，因此它们**不影响功能**；
> 之所以保留，是因为 0.1.1 线上 `dsh-client-runtime` 确为客户端插件包。
> 计划在下一版把它们从 `inject` 中移除，仅保留 `dsh-client-ui-settings` 与 `dsh-client-locale`。

`package.json` 里对应声明：

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0" },
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

（标 `optional` 是因为社区插件的惯例是「主包由宿主提供、不重复安装」，
而插件自身不 import 主包任何运行时符号。）

### 双 API 分支（新旧主包都能起）

client 半注册 settings 分栏时**运行时探测**，按可用的那套走：

```js
// ① 首选 slot 注入：官方 @deepseek-ai/dsh-client-ui-settings-general 自己在用的姿势，
//    0.1.1 线与 0.1.5 线的官方源码都还在用
if (ctx.slots && typeof ctx.slots.inject === "function" && typeof ctx.slots.register === "function") {
  ctx.slots.inject("settings.section", () => ctx.slots.register(sectionOptions(t), Section));
  return;
}
// ② 兜底才试 ctx.settings.installSection，且要求「形参个数 < 4」——
//    因为新线里同名方法的签名是 installSection(owner, ns, schema, entry, hooks)，
//    那是服务端设置注册（5 参），直接当 UI 分栏用会把插件打崩
const installSection = ctx.settings && ctx.settings.installSection;
if (typeof installSection === "function" && installSection.length < 4) {
  installSection(sectionOptions(t), Section);
  return;
}
throw new Error("no usable settings-section API found");
```

> 为什么要卡形参个数：`installSection` 这个名字在新旧语义之间**撞名了**——
> 它在 0.1.2+ 里是「把一段配置 schema 注册进 settings 服务」，而本插件要的是
> 「往设置页插一个 UI 分栏」。不卡参数个数就会把配置注册 API 当 UI API 调用。

host 半注册路由时同样探测：

```js
const server = ctx.webServer ?? ctx.server;   // 不同主包版本暴露的服务名不同
server.register(route);
```

两处都找不到时会抛一条明确的错误（而不是静默失效）。

### 本插件刻意不依赖的东西

- 不 import 任何 `@deepseek-ai/*` 运行时符号（只在 `package.json` 的 `dsh.client.inject`
  里声明 client 侧依赖名，那是宿主解析用的声明，不是代码 import）；
- 不碰 `workspaceRegistry` / `storageDomain` / `agentPresets` / `agents` 等内部服务
  （host 半只 inject `['webServer']`）；
- 读 `session_projcache.json` / `workspace.json` 时按「字段缺了就降级」处理，不假定 schema 版本。

### 会话日志格式耦合点（升级主包时重点回归）

预览与元数据兜底依赖以下主包事实，主包改格式时这里要跟着改：

- 会话日志 = `session.jsonl.zstd`（**多帧 zstd 拼接**，逐帧解；单帧 `.jsonl` 也支持）；
- 事件行 `{"type": "session" | "user/message" | "assistant/message" | ...}`，
  文本在 `data.content[]` / `data.message.content[]` 里；
- 会话目录名 = 会话 id（`session-<uuid>` 或 `<uuid>`，非安全字符会被编码成 `~XXXX`）；
- `sessions/<cwd-key>/<session-id>/` 的 `cwd-key` 由工作目录推导（形如 `--D-work-proj--`）。

---

## 六、权限边界与安全设计

| 设计 | 说明 |
|---|---|
| loopback-only | 只接受来自 `127.0.0.1` / `::1` 的连接，否则 403 |
| Host 白名单 | `Host` 头必须是配置的 `server.allowedHosts` 之一 |
| 同源校验 | 有 `Origin` 时必须与 Host 同源；`sec-fetch-site: cross-site` 直接拒 |
| 无凭据 | 不存任何密钥 / token；不向外发任何请求 |
| 不越界读写 | `sessionId` 只允许出现在归档根的子目录名位置：含 `/` `\` `.` `..` 一律 400 |
| 恢复不覆盖 | 目标目录已存在同名会话时返回 409 并**放弃**，绝不动已有数据 |
| 恢复可回滚 | 复制后逐文件字节校验，不一致就删除副本并保留归档源（返回 500 + 原因） |
| 删除激进但可预期 | 物理删除、不进回收站；UI 有二次确认，API 侧无软删除 |
| 自动归档默认安全 | 默认关闭；开启后默认仍只试跑（`dryRun: true`），要显式再点一次才真搬 |
| 自动归档判据保守 | 未闭合回合 / 空壳会话一律跳过，候选按最老优先、单次上限可配 |
| 公开配置不含隐私 | `GET {prefix}/config` 只返回界面文案与阈值，**不含任何绝对路径** |

它**不做**的事（明确声明）：不校验调用者身份（假定 DSH Web 只监听 loopback）、
不做速率限制、不加密归档内容（归档目录按你原来的权限暴露）。

---

## 七、已知限制

1. **恢复后要重启一次 DSH** 才能看到会话回到侧边栏。插件已经把 `workspace.json` 里的
   `archivedSessionIds` 标记摘掉，但主进程运行中的内存 registry 不同步。
2. **删除不可撤销**：不进回收站、没有 undo。请先用「预览」确认内容。
3. **归档目录的批次约定**：归档根下按批次目录组织（`<批次时间戳>/<会话 id>/`），
   这是主流的归档脚本约定；若你的会话直接平铺在归档根下，插件会把它当批次名处理、
   可能列不出来。可用 `archive.manifestFile` 配合批次清单（`[{from,to,mb,ageD}]`）改善恢复定位。
4. **恢复目标目录推导**依赖 `cwd → sessions 项目 key` 的规则；三者都取不到 cwd 时
   落到 `archive.unknownCwdKey`（默认 `_no-cwd`），会话能恢复但可能显示在「未知工作目录」分组下。
5. **会话日志格式是主包私有格式**，可能随主包升级变化（见第五节末）。
6. **元数据兜底要解头部若干帧**（`archive.headerFrames`，默认 8）：只有会话头的帧很小，
   所以成本可忽略；但若某会话前 8 帧里都没有 `user/message`，列表里标题会显示为会话 id 兜底值。
7. **自动归档只处理「目录里放着数据文件的会话」**：不负责判断会话是否重要，只按
   「未活跃时长 + 回合闭合 + 非空壳」三条机械判据筛选，请先长期用试跑模式观察候选名单。
8. **未做 i18n 全语种覆盖**：内置 `zh` / `en`，其余语言回退 `en`。
9. **搬运是分批异步的**：为了让事件循环不被占死，搬运会在批之间让出。所以进程若恰好在搬运中间被杀，
   归档根下会留下一个"半完成"的目标目录 —— 这不是损坏：下一轮会接着补完（`pendingBatch` 还在），
   你也可以直接删掉那个批次目录重来。
10. **冲突要人看**：同名会话在目标批次里已存在、但字节对不上时，插件**不会覆盖也不会删除源**，
   只在结果里报 `conflicts` 并把 `pendingBatch` 留着 —— 需要你自己判断哪一份是该留的。

---

## 八、仓库结构

```
dsh-butler-archive/
├─ lib/
│  ├─ index.js                 host 半：路由 + 扫描/预览/恢复/删除/自动归档
│  ├─ client.js                client 半：设置页分栏 UI
│  └─ config.js                配置层（默认值 / 文件 / 环境变量 / 校验 / 文案）
├─ examples/
│  └─ archive-sessions.config.example.json   配置示例（含全部默认值）
├─ cordis.patch.yml            bundle patch（`dsh.bundle` 指向它；方式 0 自动挂载）
├─ cordis.patch.yml.example    手工注册 / 全部配置键参考（旧版装法用）
├─ scripts/
│  ├─ test-e2e.mjs             端到端测试（干净临时路径 + 独立配置 + 真实 HTTP，跑通全流程）
│  ├─ test-host.mjs            测试宿主：把 host 半挂在最小 webServer 上
│  ├─ test-archive-concurrency.mjs  夹具：并发两次只跑一次（单飞锁）
│  ├─ test-archive-resume.mjs       夹具：半完成态只补缺的（幂等键 + 搬运中标记）
│  ├─ test-archive-duplicate.mjs    夹具：重复副本不重搬 / 字节不一致报冲突不覆盖
│  ├─ _fixture-support.mjs     上面三条夹具共用的小工具（临时 home + 三件套 env 隔离 + 假会话）
│  ├─ verify-source.mjs        静态验证（语法 / 配置行为 / 硬编码与隐私扫描）
│  ├─ verify-publish.mjs       发布后复核（两端 refs 对齐 + 内容级 API 直读 + 匿名可见 + 敏感复扫）
│  ├─ push-publish.mjs         幂等推送器（自检 → 建仓 → 临时带 token URL 推送 → 回读校验）
│  └─ deploy.mjs               幂等部署（认 DSH_HOME，自动备份 + 生成一键回滚）
└─ docs/
   └─ RELEASING.md             发布流程（版本号策略 / 变更记录 / 发布前检查单）
```

---

## 九、开发与测试

```bash
# 1) 静态验证：语法 + 配置解析行为 + 硬编码/隐私扫描
node scripts/verify-source.mjs .

# 2) 端到端：临时目录里造一套假 DSH home（sessions / storages / 归档目录 + 多帧 zstd 日志），
#    用一份独立配置起真实 HTTP，跑 list / detail / restore / delete / auto / 安全边界
node scripts/test-e2e.mjs          # --keep 保留临时目录便于排查

# 2b) 自动归档的三条专项夹具（各自独立造现场，跑完自己清理临时目录）
node scripts/test-archive-concurrency.mjs   # 并发触发两次 ⇒ 第二次返回「正在跑」、磁盘上只有一份
node scripts/test-archive-resume.mjs        # 半完成态 ⇒ 再跑只补缺的、不重搬（附 mtime 未变证据）
node scripts/test-archive-duplicate.mjs     # 同名副本 ⇒ 字节一致跳过 / 不一致报冲突且不覆盖
#    变异证红：把 lib 复制一份、拆掉某处防线，再用 ARCHIVE_TEST_LIB=<那份 index.js> 跑对应夹具

# 3) 在真实 DSH 上验证（装到测试实例，别拿正在干活的生产实例试）
#    启动 DSH 后先 curl 一下 list 路由，再硬刷新 GUI 看分栏

# 4) 发布后复核（只读；要两端都验就都跑）
node scripts/verify-publish.mjs --owner <账号> --repo dsh-butler-archive
node scripts/verify-publish.mjs --owner <账号> --repo dsh-butler-archive --skip-github

# 5) 发布（幂等；token 走环境变量，不落盘、不写 git remote）
$env:OSS_PUSH_TOKEN='<token>'; node scripts/push-publish.mjs --platform gitee --owner <账号> --repo dsh-butler-archive
```

所有脚本都是**零依赖**的，不需要 `npm install`。

> 发布相关的坑（Gitee 建仓默认私有、PATCH 必须带 name、重打 tag 才用 --force 等）记在
> `docs/RELEASING.md` 与本机 `oss-publish` 技能里。

---

## 十、设计依据

本组件是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述运维体系的一个实现，
设计依据（对应文档仓约定的固定四问）：

- **它为什么存在、边界在哪** → 见《自治式运维管家》**§2 L4 归档**、**§6 P2 事件源「归档出错」**
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》**§4.5「兼容性要求」**（另见本 README 第五节）
- **本组件特有的坑与实测** → 见本 README「已知限制」一节，以及 `docs/RELEASING.md` 的兼容性回归清单
- **文档仓地址** → Gitee（镜像）<https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub（主）<https://github.com/kira905/ops-handoff-design>
  （文档仓的组件索引表回指本仓；两仓互链、版本各自独立）

> 设计稿里不写具体仓库地址（写死即死链），实现清单统一收在文档仓的组件索引表里——本仓只负责回链章节。

---

## 十一、相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本组件的关系 |
|---|---|---|
| `dsh-butler-archive` | 会话归档管理（列表 / 预览 / 恢复 / 删除 + 可选自动归档） | **本仓** |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | 会话标题跟着对话实时更新 | 同一个问题的两面：本仓治「老会话占着加载开销」，它治「标题跟会话内容对不上」——都为了**侧边栏这个唯一入口还能用** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | 只读生态总览面板（插件加载 / 补丁 / 技能 frontmatter / 升级风险） | 它的第 ③ 类「魔改补丁健康」正是查**本仓这类靠 `cordis.patch.yml` insert 注册的组件**有没有断链；它只诊断、不动手，与本仓互不写入 |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | 诊断取证工具组：依赖闭包体检 + 会话图片附件对账 | 宿主升级前后先跑它的 `closure/`；本仓的「会话日志格式耦合点」（见第五节）就是那类**升级后必须要回归**的判据 |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | 本仓治的是**会话数量**（老会话退出 `sessions`、启动与加载开销降下来），它治的是**会话编排**（卡接活、跑完、被人验收）；两者共享同一批会话，但对象不同：本仓搬走的是"闲置的"，它管的是"正在被派活的" |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删四类现场压成一个入口 | 本仓的**移除/归档是写动作**，一旦误操作就属于它说的"要撤销改动 / 数据被删"；它也负责回答"最近改了什么、备份还在不在" |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。

---

## 十二、许可与致谢

**AGPL-3.0**（GNU Affero General Public License v3.0），见 [LICENSE](./LICENSE)。

本项目管理在 **AGPL-3.0** 下开放：个人、学习、开源项目可自由使用与修改。
若需在**闭源**或**商业场景**中使用（AGPL 的传染条款不适用），请联系获取**商业授权**——
本仓暂无公开的联系邮箱，**请通过本仓 Issue 联系**。

**许可变更记录**：**v0.2.0 及之前为 MIT，v0.3.0 起为 AGPL-3.0。**
已经按 MIT 发布的版本，他人已获得的授权收不回——许可变更只约束**未来版本**（详见 `docs/RELEASING.md` §许可变更检查）。

会话解码部分参考了 DSH 会话插件生态里公开的 zstd 多帧解码实现思路；
本仓库代码为独立实现，不含任何第三方私有代码或数据。

> 本仓为开源支线「代码侧」；「方法论文档侧」另有一仓（见上节链接），两仓互链、许可各自独立
> （文档侧 CC BY-NC-SA 4.0，代码侧 AGPL-3.0 + 商业授权）。

---

<a id="english"></a>
## English (short version)

**dsh-butler-archive** (repository; npm package `@kira905/dsh-butler-archive`; runtime id
`dsh-archive-sessions`) is a web plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
that adds an "Archived Sessions" section to the settings page. It manages sessions that were
**physically moved out** of the `sessions` directory (into `<DSH_HOME>/_archived-sessions/<batch>/<id>/`),
letting you list, preview, restore and delete them — plus an optional, off-by-default, dry-run-first
auto-archiver.

- Zero runtime dependencies (only `node:fs` / `node:path` / `node:zlib` / `node:os`).
- host half: 8 loopback-only HTTP routes. client half: one settings section.
- Install it with `dsh plugin --profile <name> add @kira905/dsh-butler-archive` (declares `dsh.bundle`,
  so the profile gets a layer that inserts the row automatically). Manual route: append the
  `cordis.patch.yml.example` block to the profile's `cordis.patch.yml` — use one route or the other,
  never both (the same id twice fails with `duplicate loader entry id`).
- Config file: `$ARCHIVE_SESSIONS_CONFIG`, else `<DSH_HOME>/<hostname>.archive-sessions.config.json`,
  else `<DSH_HOME>/archive-sessions.config.json`. Relative path values resolve against `<DSH_HOME>`.
- Supported DSH: `>=0.2.0-rc.2 <0.3.0` (validated end-to-end on `0.2.0-rc.2`; the `0.1.5` line was
  **statically re-checked on 2026-09-21** — every host interface this plugin actually uses is still
  present there — but `0.1.5-rc.2` has **not** been re-tested end-to-end; the settings-section
  registration probes both the new `ctx.settings.installSection` and the legacy `ctx.slots.inject` APIs
  at runtime).
- Restore is two-phase (copy → byte-verify → delete source) and never overwrites an existing session.
- Delete is permanent. Auto-archive is disabled by default and defaults to dry-run.

Licensed under **AGPL-3.0** (see [LICENSE](./LICENSE)). Free to use and modify for personal,
educational and open-source projects. For **closed-source or commercial** use (where AGPL's
copyleft does not apply) a **commercial license** is available — **open an issue in this
repository** to get in touch. License history: **MIT up to and including v0.2.0, AGPL-3.0 from
v0.3.0 onward** (a license change only binds future versions).
