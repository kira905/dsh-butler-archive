# 发布流程（RELEASING）

本文件说明本仓库的**版本号策略**、**变更记录规范**与**发布前检查单**。
它同时是「开源支线」两半的接口约定：代码侧（本仓库）与文档侧（方法论文章）在发布说明里互链。

---

## 1. 版本号策略（SemVer）

`MAJOR.MINOR.PATCH`，语义按**用户可见面**判定，不按内部重构：

| 变更 | 版本位 | 例子 |
|---|---|---|
| 破坏性：配置键改名/删除、HTTP 路由或响应字段破坏性变更、主包支持区间收窄、归档目录约定变更 | **MAJOR** | 去掉 `paths.*`、`list` 响应改结构 |
| 新增：新配置键、新路由、新 UI 功能、扩大主包支持区间 | **MINOR** | 加 `archive.headerFrames` 可配置 |
| 修复：bug 修复、文案修正、性能优化、内部重构（行为不变） | **PATCH** | 修首帧-only 的标题兜底 bug |

补充规则：

- 当前处于 **0.x**：允许 MINOR 位承载破坏性变更，但**必须在 CHANGELOG 里显式标注 `BREAKING`**，
  并在 README 的兼容性表格里更新支持区间。
- **主包兼容区间变化 = 至少 MINOR**，且必须同步改 `package.json` 的 `peerDependencies`。
- 一个版本一个主题。混装多个主题时拆成多次发布。
- 版本号只增不减；发错了就发下一个补丁版本回退，不重打已发布的 tag。

## 2. 变更记录规范

`CHANGELOG.md`，倒序（最新在最上），每条发布一节：

```markdown
## [0.2.0] - 2026-09-11

### Added
- 配置层：全部可调参数外置到配置文件 / 环境变量（默认值与示例见 `examples/`）。
### Changed
- 界面文案改为内置 zh/en 字典，可用 `ui` / `uiByLanguage` 覆盖。
### Fixed
- `list` 的标题/元数据兜底只解第一帧，首条用户消息落在后续帧时取不到标题。
### Breaking
- （若有）说明改了什么、怎么迁移。
```

约定：

- 面向**使用者**写（他能观察到什么变化），不写内部流水账；
- 每条尽量带「影响面」与「迁移动作」；
- 未发布期间的改动先写进 `## [Unreleased]` 一节，发布时改成版本号 + 日期。

## 3. 发布前检查单

按顺序跑，任一项不过就不发：

- [ ] `node scripts/verify-source.mjs .` → `ALL CHECKS PASSED`
- [ ] `node scripts/test-e2e.mjs` → `E2E PASSED`
- [ ] 在**真实 DSH 实例**上装一次（至少：分栏出现、列表出数、预览、恢复、删除各一次）
- [ ] **隐私扫描**：仓库里没有本机路径、机器名、用户名、会话内容、凭据；
      `git grep -nE "[A-H]:[\\\\/]"` 只应命中文档里的通用示例
- [ ] `package.json` 的 `version` 已按第 1 节规则递增；`peerDependencies` 区间与实测一致
- [ ] **许可变更检查（若本次动了许可）**：许可变更必须**三处齐改**——
      ① 仓根 `LICENSE` 文件（用官方全文，不改写条款文字）
      ② `README.md` 与 `README.en.md` 的 License / 商业授权段（双语一致）
      ③ `package.json` 的 `license` 字段（SPDX 标识，如 `AGPL-3.0-only`）；
      并在 README 变更记录里写明「哪个版本起换了什么许可」。
      ⚠️ 许可变更**只约束未来版本**：已按旧许可发布的版本，他人已获得的授权收不回——
      这一点必须写进 README，别让读者以为旧版本也跟着换了许可
- [ ] `CHANGELOG.md` 已写、日期已填、`BREAKING` 已标注（若有）
- [ ] README 的「兼容性」表格与实测结论一致（哪些版本"已实测"，哪些"预期可用"）
- [ ] `cordis.patch.yml.example` 里的 `id` / `name` 与 `package.json` 的包名一致
- [ ] 打包内容正确：`npm pack --dry-run` 只应包含 `lib/` `examples/` `cordis.patch.yml.example`
      `README.md` `LICENSE`（`package.json` 的 `files` 字段控制）

## 4. 发布步骤

```bash
# 1) 版本与记录
#    改 package.json 的 version、更新 CHANGELOG.md
# 2) 全套验证
node scripts/verify-source.mjs .
node scripts/test-e2e.mjs
# 3) 提交与标签
git add -A
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --tags
# 4) 发布说明：直接贴 CHANGELOG 里本节的正文，并链到文档侧方法论文章
```

**要不要同时发 npm，由维护者决定。** 若发 npm：

```bash
npm publish --access public   # 首次发布前确认包名可用、LICENSE/README 已在 files 里
```

> 发 npm 的前提是包名 `dsh-archive-sessions` 未被占用，且愿意承担长期可用性承诺。
> 只发 GitHub Release（用户 `git clone` 后按 README 手工安装）是更轻的选择。

### 双端发布（Gitee 镜像 + GitHub 主）的四个实测坑

1. **Gitee 建仓后默认是私有**——即便建仓请求里写了 `private: false`，实测建出来的仍是私有仓
   （表现为"公开仓"其实只有自己能看，匿名 API 一律 `404 Not Found Project`）。
   建仓后必须再显式 PATCH 一次：`PATCH /api/v5/repos/{owner}/{repo}`，
   **且必须带 `name` 字段**（否则报 `{"messages":["name is missing"]}`），
   body 用 form 编码：`access_token=…&name=<repo>&private=false`。`push-publish.mjs` 已内置这一步。
2. **post-publish 复核要看"匿名视角"**：用带 token 的 API 读得到 ≠ 公开。
   权威判据 = 匿名读 `GET /api/v5/repos/{owner}/{repo}` 返回 `private: false`，且匿名能取到文件内容。
3. **重打过的 tag 推送会被拒**（提示像认证失败其实是 non-fast-forward）→ **只对 tag 用 `--force`**，
   分支仍走非快进保护。
4. **Gitee 不因 push 自动建仓**：目标仓不存在时 push 直接 `404 not found`；
   建仓只能走 API（要账号级令牌）或网页。

## 5. 与文档侧的互链

开源支线分两半：

- **代码侧（本仓库）**：插件本体 + README + 本文件；
- **文档侧**：同支线的方法论文档（讲"为什么这么设计 / 怎么把私有插件抽成通用件"），
  由**独立发布说明**承载。

两边发布时**互相链接**：README §10「设计依据」给出文档侧链接
（Gitee <https://gitee.com/kira905/ops-handoff-design> ｜ GitHub <https://github.com/kira905/ops-handoff-design>）；
文档侧的发布说明里给出本仓库链接与对应版本号。**两边的版本号各自独立**，
互相引用时写明「引用的是 vX.Y.Z 时的行为」，避免一边改了另一边不知情。

发布时的固定动作（两半都适用）：

1. 本仓发布说明里补「设计依据」→ 指向文档仓 + 文档仓版本号；
2. 需要回填到**文档仓组件索引表**的一行：

   ```
   | dsh-butler-archive | 会话归档的通用化实现（去硬编码、路径可配、零依赖） | AGPL-3.0（+ 商业授权） | 《自治式运维管家》§2 L4 归档、§6 P2 事件源「归档出错」 | ✅ 已发布（Gitee + GitHub 双端）· 当前 v0.3.0 |
   ```

3. 文档仓若有更新，本仓 README §10 的「版本对应」行同步校准。

> 占位符约定：`<docs-repo-url>`（文档仓地址）、`<code-repo-url>`（本仓地址，本仓自己的远端地址
> 在推送完成后才知道，故发布说明里先用占位符）。替换时三个位置一起改：
> README §10、本文件 §5、以及代码头部的设计依据注释。

## 6. 兼容性回归（每次动到会话格式相关代码时）

改到 `lib/index.js` 里解码 / 元数据 / 恢复相关的函数时，除了跑本仓库的两条脚本，
还要在真实 DSH 上复核：列表能出数、预览能出消息、恢复后会话回到侧边栏（重启一次后）。
原因：这些函数的输入是**主包私有格式**，主包升级（尤其 0.1.x → 0.2.x）可能改事件族与日志封装。
