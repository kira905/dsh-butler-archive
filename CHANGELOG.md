# 变更记录

> 面向**使用者**写（你能观察到什么变化），不写内部流水账；每条尽量带「影响面」与「迁移动作」。
> 版本号规则见 [`docs/RELEASING.md`](docs/RELEASING.md) §1；当前处于 **0.x**（MINOR 位可承载破坏性变更，但必须显式标注 `Breaking`）。
> 倒序排列：最新在最上。

## [0.3.5] - 2026-10-20

### Added

- **本包现在声明 `dsh.bundle`，是「可安装」的 DSH 插件**：`package.json#dsh.bundle.patch = ./cordis.patch.yml`，
  仓库根新增 `cordis.patch.yml`（`insert`：`id: dsh-butler-archive` / `name: '@kira905/dsh-butler-archive'`）。
  此前只声明 `dsh.client`，走「声明式安装」时 DSH 只把它当**普通依赖**装、**不加载**，并给一条
  `warning: … declares no dsh.bundle — installed as a plain dependency, not a profile layer`。
  现在 `dsh plugin --profile <name> add @kira905/dsh-butler-archive` 会把它作为 **profile 层**自动挂载，
  **不用再手工改 profile 的 `cordis.patch.yml`**。
  影响面 / 迁移动作：**已经手工 insert 过的现有安装别跟着再走 bundle 层** —— 同一条 id 会撞
  `duplicate loader entry id`；要么继续用手工那条，要么先删掉手工条目再改走 bundle。
- `files` 补 `cordis.patch.yml`（保证 npm 包里带上它）。

### Changed

- `cordis.patch.yml.example` 改写为「**旧版 / 手动注册参考**」：删掉「本插件没有 `dsh.bundle`、
  写进 `bundles` 会启动即崩」这条**已被本版推翻的前提**，改为「正常走 bundle 层；手工 insert
  只用于老宿主 / 手工拷贝安装」，并保留全部 `config` 键作参考。**选择改写而非删除**：它目前是
  仓里唯一把 `config` 各键列全的地方，老装法也仍要用它。
- 宿主兼容区间、运行时行为、HTTP 路由**均无改动**（本轮推送内容为 `package.json` +
  `cordis.patch.yml` + 该示例文件 + README 安装段 + 本文件）。隔离实例实测记录见交付报告。

## [0.3.4] - 2026-10-19

### Fixed

- 🔴 **设置页里的「归档会话管理」在 DSH 0.2.0 主包上不出现 —— 已修**。`lib/client.js` 的
  `__ModuleLoader__.load({ id })` 登记的是旧名 `dsh-archive-sessions`，而 0.2.0 的
  `dsh-client-modules` 按**条目 id = 包名**（`@kira905/dsh-butler-archive`）找 factory ⇒
  资源 HTTP 200、控制台报 `loaded without registering … via __ModuleLoader__.load`，
  插件永不挂载。本版把登记 id 改成包名。
  影响面：**只影响浏览器端是否挂载**；host 半路由（`/api/dsh-archive-sessions/*`）此前一直可用。
- 说明：本仓 `lib/` 是**手写源码**（无构建步骤、无 `src/`），因此没有「改 src 再 build」这一步，
  `lib/client.js` 就是源头。
- `module.exports.name`（cordis 插件名）**刻意保持** `dsh-archive-sessions/client` 不变 ——
  它只用于日志/标签，不参与模块查找；改它对本次故障无帮助。

## [0.3.3] - 2026-10-16

### Changed

- 🔴 **许可**：**自本版起为 `AGPL-3.0-only` + 商业授权（双许可）**。`LICENSE` 维持 GNU AGPL-3.0 官方全文不变；README 中英双份的「许可」段补**商业授权**说明。⚠️ 术语必须读准：**AGPL 本身不禁商用**（AGPL / MIT / Apache 本身都不禁商用，AGPL 只要求**衍生作品也开源**）；「+ 商业授权」= **双许可** —— 「要么按 AGPL 衍生开源、要么取得商业授权」。**历史版本的授权状态不变**（`v0.2.0` 及之前为 MIT，`v0.3.0` 起为 AGPL-3.0），已发布的旧授权**收不回**，变更只约束**未来版本**。
- **宿主兼容区间据实刷新 + 端到端实测**：`peerDependencies` 由 `>=0.1.1-rc.2 <0.2.0` 改为 **`>=0.2.0-rc.2 <0.3.0`**。依据 = **隔离实例（端口 3090，主包 `0.2.0-rc.2`）上的真装真跑**：本仓 `scripts/verify-live.mjs` 对运行中的实例跑 **26 项检查全 PASS**（真实 HTTP 路由 list / detail / restore / delete + 真实磁盘副作用 + 夹具自清理），客户端半 `client.js` 出现在实例启动 HTML 的插件资源清单里。README 同步写明「**实测过的宿主版本**」与「**未实测不作承诺**」。
- **本轮无代码与行为改动**（推送内容为 `package.json` + `README.md` / `README.en.md` + 本文件）。

## [0.3.2] - 2026-09-28

### Changed

- **本轮文档更新（本次发版内容）**：README「相关组件」互链节补入本批新发布的两件伴生组件（自维护任务看板 `dsh-task-board-local`、零依赖急救台 `dsh-firstaid`）。本轮**无代码与行为改动**（推送内容仅 `README.md`）。

## [0.3.1] - 2026-09-22

### Changed

- **本轮文档更新（本次发版内容）**：README 对外文案统一为仓名；中英双份 README 新增「相关组件」互链节；「支持的主包版本」表按 2026-09-21 静态兼容性审计更新。本轮**无代码与行为改动**（推送内容仅 `.md` 文件）。

- **脱敏工具（开发者 / 发布流程向）**：`scripts/verify-source.mjs` 与 `scripts/verify-publish.mjs` 的规则表
  **不再内联具体机器名 / 用户名 / 本地路径 / 同步产品名**，改为由环境变量
  `BUILD_MACHINE_NAMES` / `BUILD_USER_NAMES` / `BUILD_LAYOUT_ROOTS` / `BUILD_SYNC_PRODUCTS` 注入。
  - **影响面**：脚本本身不带任何本机标识（这是本次改动的目的）。
  - **迁移动作**：**发布前若要覆盖本机实名规则，必须先注入环境变量再跑**；不注入时只跑通用形态规则
    （盘符路径、`Users\`、`$env:`、凭证形态、会话/提交 hash 形态等）。检查单已相应补注。
- **文档对齐**：README（中文 / 英文）里引用的两份方法论文档标题，随文档仓改名去掉"设计"字样；
  英文 README 的 `git clone` 地址更正为本仓现名（旧仓名由平台自动重定向）；
  `docs/RELEASING.md` 中「回填文档仓组件索引表」的示例改为与文档仓实际表格**同列**（原示例列义不同，照抄会填错）。

## [0.3.0] - 2026-09-15

### Breaking

- **许可变更：MIT → AGPL-3.0**（`package.json` 为 `AGPL-3.0-only`，仓根 `LICENSE` 换为 AGPL 官方全文）。
  - **为什么**：AGPL 是 OSI 认证的开源许可（可被收录、可被 fork 学习，曝光面大），其传染性天然劝退闭源 / SaaS 场景，
    防商用效果接近"非商业许可"但不牺牲曝光；同时**另提供商业授权**（供不愿受 AGPL 约束的闭源 / 商业场景）。
  - **影响面**：`v0.3.0` 起，在闭源或商业产品中使用本插件须遵守 AGPL-3.0，或另行取得商业授权。
  - **迁移动作**：**无需改动代码**。但请注意——**已经按 MIT 发布的 `v0.2.0` 及更早版本，他人已获得的授权收不回**：
    许可变更**只约束新版本**，旧版本的 MIT 授权继续有效。这条是开源许可的固有语义，写在这里以免误读。

### Changed

- README（中 / 英）新增 License 与商业授权段（双语一致；不含任何个人身份信息）。
- `docs/RELEASING.md` 的发布检查单增加「**许可变更必须三处齐改**」检查项（`LICENSE` / 两个 README / `package.json`）。

## [0.2.0] - 2026-09-11

### Added

- **首版发布**：把"被物理移出会话目录的归档会话"变成可以正常查看 / 预览 / 恢复 / 删除的对象。
  - **host 半**：一组 **loopback-only** 的 HTTP 路由（列表 / 详情 / 恢复 / 删除 / 自动归档等），
    默认前缀 `/api/dsh-archive-sessions`（可配置）。
  - **client 半**：设置页一个分栏——按工作目录分组的归档会话列表、行内预览、恢复、删除。
  - **配置层**：全部可调参数外置到配置文件 / 环境变量，带说明的示例见 `examples/`；
    支持"每台机器一份"配置（`<DSH_HOME>/<主机名>.archive-sessions.config.json`）以便多机共存。
  - **脚本**：部署（`scripts/deploy.mjs`，幂等 + 备份 + 一键回滚）、源码静态验证、端到端测试
    （`scripts/test-e2e.mjs`）、真实实例验证、发布校验。
- **零第三方运行时依赖**：仅使用 node 内置模块（`node:fs` / `node:path` / `node:zlib` / `node:os`）。

### Notes

- 发布前验证：**端到端检查 48 项**（`scripts/test-e2e.mjs` → `E2E PASSED`）+ **真实 DSH 实例 26 项检查**，全部通过。
- 宿主兼容基线：`@deepseek-ai/dsh` **`0.1.1-rc.2`**（支持区间与逐项状态见 README 第五节「兼容性」）。
