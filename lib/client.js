// dsh-archive-sessions / lib/client.js（浏览器端）—— 设置页「归档会话管理」分栏
//
// 打包形态：window.__ModuleLoader__.load({ id, factory }) + factory 内 require("react")，
// 末尾 return module.exports。
//
// 注册姿势（运行时探测，兼容两套主包 API）：
//   1) ctx.settings.installSection(...)    —— 新 API 存在时优先
//   2) ctx.slots.inject("settings.section", ...) —— 0.1.1 线
//
// 数据全部来自 host 半的受控路由（前缀由 host 下发，默认 /api/dsh-archive-sessions）：
//   GET  {prefix}/config
//   GET  {prefix}/list
//   GET  {prefix}/detail?sessionId=
//   POST {prefix}/restore
//   POST {prefix}/delete
//   GET  {prefix}/auto · POST {prefix}/auto · POST {prefix}/auto/run
//
// 界面文案默认取内置 zh/en 字典，可在配置文件的 ui / uiByLanguage 里逐条覆盖。
window.__ModuleLoader__.load({
	// 登记 id 必须等于包名：0.2.0 主包的 client-modules 按「条目 id = 包名」找 factory
	// （`graphRow(id /* package name */)`），id 写旧的无 scope 名字会 HTTP 200 却
	// "loaded without registering"，插件永不挂载（S16 装验实测）。
	id: "@kira905/dsh-butler-archive",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const NS = "archive-sessions";
		const DEFAULT_PREFIX = "/api/dsh-archive-sessions";
		const CSS_ID = "dsh-archive-sessions-css";
		const ATTR = "data-dsh-archive-sessions";

		/** 设置侧栏的 nav 标签（随 DSH 语言切换；面板内文案由 host 配置决定）。 */
		const DICT = {
			zh: { nav: "归档会话管理" },
			en: { nav: "Archived Sessions" }
		};

		/** 内置文案兜底（host 的 /config 未返回时使用；键与 lib/config.js 保持一致）。 */
		const FALLBACK_TEXT = {
			nav: "归档会话管理",
			loadFailed: "读取失败：{error}",
			loadingText: "正在读取归档目录…",
			retry: "重试",
			refresh: "刷新",
			refreshing: "加载中…",
			empty: "归档目录里没有会话。",
			unknownCwd: "未知工作目录",
			unknownTime: "时间未知",
			summary: "共 {total} 个归档会话 · 占用 {size}",
			batch: "批次",
			turns: "{n} 轮",
			goto: "前往",
			flagEmpty: "空会话",
			flagArchived: "曾归档",
			flagNoMeta: "元数据缺失",
			actionPreview: "预览",
			actionCollapse: "收起",
			actionRestore: "恢复",
			actionDelete: "删除",
			busy: "处理中…",
			decoding: "正在解码会话日志…",
			previewFailed: "预览失败：{error}",
			previewMeta: "共 {total} 条消息",
			previewTail: "（显示尾部 {n} 条）",
			cwdLabel: "工作目录 {cwd}",
			roleUser: "用户",
			roleAssistant: "助手",
			truncated: "（内容过长，已截断）",
			emptyLog: "这条会话日志里没有对话消息 —— 通常是打开会话后没发消息就关掉了，日志只留下会话头。",
			emptySafe: "这类空会话可以安全删除。",
			sessionId: "会话 id {id}",
			preset: "预设 {name}",
			delegation: "委派层级 {depth}",
			eventTypes: "日志事件：{list}",
			confirmRestore: "确认恢复这个归档会话？",
			confirmRestoreBody: "会把会话目录复制回 sessions 目录（复制校验通过后才删除归档源），不会覆盖任何已存在的数据。",
			restoreUnarchived: "该会话曾被打过「归档」标记，已一并摘除——重启一次 DSH 后即回到正常会话列表。",
			restored: "已恢复：{path}",
			restoreFailed: "恢复失败：{error}",
			confirmDelete: "确认永久删除这个归档会话？",
			confirmDeleteBody: "删除后不可恢复（不进回收站），请确认这不是你还需要的内容。",
			deleted: "已删除归档会话：{id}",
			deleteFailed: "删除失败：{error}",
			opFailed: "操作失败：{error}",
			setFailed: "设置失败：{error}",
			autoTitle: "自动归档",
			autoEnabledDry: "已启用 · 试跑模式",
			autoEnabledLive: "已启用 · 真归档",
			autoDisabled: "已停用",
			autoThreshold: "阈值 {hours} 小时未活跃",
			autoEvery: "每 {hours} 小时检查一次",
			autoLastRun: "上次运行 {time}",
			autoNeverRun: "尚未运行",
			autoTotal: "累计归档 {n} 个",
			autoRunNow: "立即试跑",
			autoEnable: "启用（先试跑）",
			autoGoLive: "改为真归档",
			autoGoDry: "改回试跑",
			autoDisable: "停用",
			autoScanned: "扫描 {n} 个会话",
			autoCandidates: "候选 {n} 个",
			autoDryRun: "试跑（未移动任何文件）",
			autoArchived: "已归档 {n} 个",
			autoSkipped: "跳过 {n} 个",
			autoErrors: "失败 {n} 个",
			autoBatch: "批次 {batch}",
			autoRunDone: "试跑完成：",
			autoArchiveDone: "自动归档完成：",
			autoLastDry: "上次结果：",
			autoLastReal: "上次归档：",
			autoUpdated: "自动归档设置已更新。",
			autoConfirmLive:
				"确认让自动归档真的移动会话？\n\n判据：{hours} 小时未活跃、回合已闭合、且不是空壳会话。\n移动后仍可在本列表里预览和恢复。",
			autoDaysIdle: "{days} 天未活跃",
			footer:
				"这里管理的是被物理移出 sessions 目录的老会话（归档目录 _archived-sessions）。恢复=复制回 sessions（校验通过才删源），删除=永久删除。",
			skipOpenTurn: "回合未闭合",
			skipEmptyShell: "空壳（无对话内容）",
			errNotFound: "归档会话不存在（可能已被删除）",
			errTargetExists: "目标位置已存在同名会话，未覆盖任何数据。",
			errCopyFailed: "复制失败。",
			errVerifyFailed: "复制校验不一致，已回滚（未删除归档源）。",
			errCleanupFailed: "复制已成功，但清理归档源失败。",
			errDeleteFailed: "删除失败。",
			errForbidden: "请求被拒绝（该接口只接受本机 loopback 请求）。",
			errBadRequest: "请求不合法。",
			errUnknown: "未知错误"
		};

		/** 事件类型人话标签（空会话预览里用来说明日志里有什么）。 */
		const EVENT_LABELS = {
			session: "会话头",
			"user/message": "用户消息",
			"assistant/message": "助手回复",
			"tool/call": "工具调用",
			"tool/result": "工具结果",
			"permission/preset": "权限预设",
			"sandbox/mode": "沙箱模式",
			"approval/policy": "审批策略",
			"session/end-seed": "会话结束标记",
			"turn/end": "回合结束",
			"assistant/chunk": "流式片段"
		};

		/** 运行期文本表：先用兜底字典，拉到 host 配置后整体替换。 */
		let TEXT = { ...FALLBACK_TEXT };
		let API = DEFAULT_PREFIX;
		const configListeners = new Set();

		function setRuntimeConfig(config) {
			if (config === null || typeof config !== "object") return;
			if (typeof config.apiPrefix === "string" && config.apiPrefix.length > 1) {
				API = config.apiPrefix.replace(/\/+$/, "");
			}
			if (config.ui !== null && typeof config.ui === "object") {
				TEXT = { ...FALLBACK_TEXT, ...config.ui };
			}
			for (const listener of configListeners) {
				try {
					listener();
				} catch {
					/* ignore listener errors */
				}
			}
		}

		/** {name} 占位符插值。 */
		function t(key, params) {
			const template = typeof TEXT[key] === "string" ? TEXT[key] : key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => {
				const value = params[name];
				return value === undefined || value === null ? "" : String(value);
			});
		}

		//#region css
		const CSS = `
[${ATTR}]{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#e6e6e6);min-width:0}
[${ATTR}] .as-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[${ATTR}] .as-title{font-size:15px;font-weight:600}
[${ATTR}] .as-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-spacer{flex:1}
[${ATTR}] .as-btn{appearance:none;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;padding:4px 12px;font:inherit;font-size:12.5px;white-space:nowrap}
[${ATTR}] .as-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.28))}
[${ATTR}] .as-btn:disabled{opacity:.5;cursor:default}
[${ATTR}] .as-act{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:rgba(128,128,128,.1);color:var(--dsw-alias-label-secondary,#c6cad1);border-radius:6px;padding:1px 8px;font:inherit;font-size:11.5px;white-space:nowrap}
[${ATTR}] .as-act:hover:not(:disabled){background:rgba(128,128,128,.26);color:var(--dsw-alias-label-primary,#e6e6e6)}
[${ATTR}] .as-act:disabled{opacity:.5;cursor:default}
[${ATTR}] .as-act.as-on{border-color:rgba(91,157,255,.5);color:#8ab8ff}
[${ATTR}] .as-act.as-danger{color:#e5484d}
[${ATTR}] .as-act.as-danger:hover:not(:disabled){background:rgba(229,72,77,.18)}
[${ATTR}] .as-group{margin-top:4px}
[${ATTR}] .as-ghead{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));font-size:12.5px}
[${ATTR}] .as-ghead:hover{background:rgba(128,128,128,.16)}
[${ATTR}] .as-caret{flex:none;width:10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-cwd{font-weight:600;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:12px;word-break:break-all}
[${ATTR}] .as-count{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-variant-numeric:tabular-nums}
[${ATTR}] .as-rows{margin-top:2px}
[${ATTR}] .as-row{display:flex;align-items:flex-start;gap:8px;padding:6px 4px 6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
[${ATTR}] .as-row:last-child{border-bottom:none}
[${ATTR}] .as-main{flex:1;min-width:0}
[${ATTR}] .as-name{font-weight:500;word-break:break-all}
[${ATTR}] .as-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);margin-top:1px;word-break:break-all}
[${ATTR}] .as-flag{color:#e5b35c;border:1px solid rgba(229,179,92,.45);border-radius:4px;padding:0 4px;font-size:10.5px;margin-left:4px;white-space:nowrap}
[${ATTR}] .as-flag.as-flag-dim{color:var(--dsw-alias-label-tertiary,#9aa0a8);border-color:rgba(154,160,168,.45)}
[${ATTR}] .as-acts{flex:none;display:flex;gap:4px;padding-top:1px}
[${ATTR}] .as-preview{margin:2px 0 8px 12px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.14))}
[${ATTR}] .as-pmeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);margin-bottom:6px;word-break:break-all}
[${ATTR}] .as-msgs{max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:7px;padding-right:4px}
[${ATTR}] .as-msg{border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));padding-left:9px}
[${ATTR}] .as-msg.as-user{border-left-color:#5b9dff}
[${ATTR}] .as-msg.as-assistant{border-left-color:#3ecf6e}
[${ATTR}] .as-role{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a8);margin-left:6px;font-variant-numeric:tabular-nums}
[${ATTR}] .as-text{white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--dsw-alias-label-secondary,#c6cad1);margin-top:1px}
[${ATTR}] .as-cut{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-err{color:var(--dsw-alias-label-error,#e06c6c);font-size:12.5px;padding:8px 0}
[${ATTR}] .as-empty{border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:10px;padding:18px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:13px}
[${ATTR}] .as-toast{border-radius:8px;padding:7px 11px;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
[${ATTR}] .as-toast.as-ok{border:1px solid rgba(62,207,110,.45);background:rgba(62,207,110,.12);color:#7ee2a8}
[${ATTR}] .as-toast.as-bad{border:1px solid rgba(229,72,77,.45);background:rgba(229,72,77,.12);color:#ff8a8d}
[${ATTR}] .as-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-act.primary{border-color:rgba(91,157,255,.5);color:#8ab8ff}
[${ATTR}] .as-auto{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border-radius:10px;padding:8px 11px;display:flex;flex-direction:column;gap:4px}
[${ATTR}] .as-auto-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
[${ATTR}] .as-auto-title{font-weight:600;font-size:12.5px}
[${ATTR}] .as-auto-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);word-break:break-all}
[${ATTR}] .as-badge{font-size:10.5px;border-radius:4px;padding:0 6px;line-height:1.7;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));color:var(--dsw-alias-label-tertiary,#9aa0a8);white-space:nowrap}
[${ATTR}] .as-badge.as-ok{color:#7ee2a8;border-color:rgba(62,207,110,.45)}
[${ATTR}] .as-badge.as-warn{color:#f2cf7c;border-color:rgba(229,179,92,.45)}
[${ATTR}] .as-auto-list{margin:2px 0 0;padding-left:16px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${ATTR}] .as-auto-list li{word-break:break-all}
`;
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-archive-sessions";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region helpers
		function formatBytes(bytes) {
			const n = typeof bytes === "number" && isFinite(bytes) ? bytes : 0;
			if (n <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let value = n;
			let i = 0;
			while (value >= 1024 && i < units.length - 1) {
				value /= 1024;
				i += 1;
			}
			return (i === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)) + " " + units[i];
		}
		function formatTime(value) {
			let ms = typeof value === "number" ? value : NaN;
			if (typeof value === "string") ms = Date.parse(value);
			if (!isFinite(ms) || ms <= 0) return t("unknownTime");
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return (
				d.getFullYear() +
				"-" +
				p(d.getMonth() + 1) +
				"-" +
				p(d.getDate()) +
				" " +
				p(d.getHours()) +
				":" +
				p(d.getMinutes())
			);
		}

		/** 把 host 的错误体翻成人话：优先按 code 查字典，其次用 host 的英文 message。 */
		function errorText(body, status, fallbackKey) {
			const code = body !== null && typeof body.code === "string" ? body.code : null;
			const map = {
				"not-found": "errNotFound",
				"target-exists": "errTargetExists",
				"copy-failed": "errCopyFailed",
				"verify-failed": "errVerifyFailed",
				"source-cleanup-failed": "errCleanupFailed",
				"delete-failed": "errDeleteFailed",
				"loopback-only": "errForbidden",
				"session-id-required": "errBadRequest",
				"invalid-body": "errBadRequest",
				"invalid-json": "errBadRequest",
				"body-too-large": "errBadRequest"
			};
			const key = code !== null ? map[code] : undefined;
			if (key !== undefined) {
				const extra = body !== null && typeof body.message === "string" ? body.message : "";
				return t(key) + (extra ? " (" + extra + ")" : "");
			}
			if (body !== null && (typeof body.message === "string" || typeof body.error === "string")) {
				return body.message || body.error;
			}
			if (fallbackKey !== undefined) return t(fallbackKey);
			return "HTTP " + status;
		}

		async function apiGet(path) {
			const res = await fetch(path, { headers: { accept: "application/json" } });
			let body = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			if (!res.ok) throw new Error(errorText(body, res.status));
			return body;
		}
		async function apiPost(path, payload) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			let body = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			if (!res.ok) throw new Error(errorText(body, res.status));
			return body;
		}

		/** 把一次自动归档结果压成一行摘要。 */
		function summarizeRun(result) {
			const skipLabel = (reason) => {
				if (reason === "open-turn") return t("skipOpenTurn");
				if (reason === "empty-shell") return t("skipEmptyShell");
				return reason;
			};
			const parts = [
				t("autoScanned", { n: result.scanned ?? 0 }),
				t("autoCandidates", { n: (result.candidates ?? []).length })
			];
			if (result.dryRun === true) {
				parts.push(t("autoDryRun"));
			} else {
				parts.push(t("autoArchived", { n: (result.archived ?? []).length }) + (result.movedMb ? " / " + result.movedMb + " MB" : ""));
			}
			if ((result.skipped ?? []).length > 0) {
				const detail = (result.skipped ?? [])
					.slice(0, 3)
					.map((item) => skipLabel(item.reason))
					.filter((label, index, list) => list.indexOf(label) === index)
					.join("/");
				parts.push(t("autoSkipped", { n: result.skipped.length }) + (detail ? " (" + detail + ")" : ""));
			}
			if ((result.errors ?? []).length > 0) parts.push(t("autoErrors", { n: result.errors.length }));
			if (result.batch) parts.push(t("autoBatch", { batch: result.batch }));
			if (result.note) parts.push(result.note);
			return parts.join(" · ");
		}

		function groupByCwd(rows) {
			const groups = [];
			const index = new Map();
			for (const row of rows) {
				const key = typeof row.cwd === "string" && row.cwd.length > 0 ? row.cwd : "__none__";
				let group = index.get(key);
				if (group === undefined) {
					group = { key, cwd: key === "__none__" ? null : key, rows: [] };
					index.set(key, group);
					groups.push(group);
				}
				group.rows.push(row);
			}
			return groups;
		}
		//#endregion

		//#region section
		function Section() {
			const [status, setStatus] = useState("loading");
			const [data, setData] = useState(null);
			const [error, setError] = useState(null);
			const [collapsed, setCollapsed] = useState({});
			const [busyId, setBusyId] = useState(null);
			const [toast, setToast] = useState(null);
			const [openId, setOpenId] = useState(null);
			const [previews, setPreviews] = useState({});
			const [auto, setAuto] = useState(null);
			const [autoBusy, setAutoBusy] = useState(false);
			const [, forceRender] = useState(0);

			useEffect(() => {
				injectCss();
			}, []);

			// host 配置（界面文案 / 路由前缀）只拉一次，拉到后重渲染整块面板
			useEffect(() => {
				let cancelled = false;
				const rerender = () => {
					if (!cancelled) forceRender((n) => n + 1);
				};
				configListeners.add(rerender);
				void (async () => {
					try {
						setRuntimeConfig(await apiGet(DEFAULT_PREFIX + "/config"));
					} catch {
						// host 未提供 /config 时静默用内置文案（老 host 兼容）
					}
				})();
				return () => {
					cancelled = true;
					configListeners.delete(rerender);
				};
			}, []);

			const load = useCallback(async (silent) => {
				if (silent !== true) setStatus("loading");
				setError(null);
				try {
					const body = await apiGet(API + "/list");
					setData(body);
					setStatus("ready");
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					setStatus("error");
				}
			}, []);

			const loadAuto = useCallback(async () => {
				try {
					setAuto(await apiGet(API + "/auto"));
				} catch {
					setAuto(null); // host 未启用自动归档路由时静默降级
				}
			}, []);

			useEffect(() => {
				void load();
				void loadAuto();
			}, [load, loadAuto]);

			const autoRun = useCallback(
				async (dry) => {
					setAutoBusy(true);
					setToast(null);
					try {
						const result = await apiPost(API + "/auto/run", { dryRun: dry === true });
						setToast({
							kind: (result.errors ?? []).length > 0 ? "bad" : "ok",
							text: (result.dryRun === true ? t("autoRunDone") : t("autoArchiveDone")) + summarizeRun(result)
						});
						await loadAuto();
						await load(true);
					} catch (err) {
						setToast({ kind: "bad", text: t("opFailed", { error: err instanceof Error ? err.message : String(err) }) });
					} finally {
						setAutoBusy(false);
					}
				},
				[load, loadAuto]
			);

			const autoSet = useCallback(
				async (patch) => {
					if (patch.dryRun === false) {
						const hours = Number(auto?.config?.hours) || 48;
						const ok = window.confirm(t("autoConfirmLive", { hours: hours }));
						if (!ok) return;
					}
					setAutoBusy(true);
					setToast(null);
					try {
						await apiPost(API + "/auto", patch);
						await loadAuto();
						setToast({ kind: "ok", text: t("autoUpdated") });
					} catch (err) {
						setToast({ kind: "bad", text: t("setFailed", { error: err instanceof Error ? err.message : String(err) }) });
					} finally {
						setAutoBusy(false);
					}
				},
				[auto, loadAuto]
			);

			useEffect(() => {
				if (toast === null) return undefined;
				const timer = setTimeout(() => setToast(null), 8000);
				return () => clearTimeout(timer);
			}, [toast]);

			const toggleGroup = useCallback((key) => {
				setCollapsed((prev) => ({ ...prev, [key]: prev[key] !== true }));
			}, []);

			const fetchedRef = useRef(new Set());

			const togglePreview = useCallback((sessionId) => {
				setOpenId((current) => (current === sessionId ? null : sessionId));
			}, []);

			// 打开预览后按需拉取详情（每个会话只请求一次；失败则允许再次点预览重试）
			useEffect(() => {
				if (openId === null) return undefined;
				if (fetchedRef.current.has(openId)) return undefined;
				fetchedRef.current.add(openId);
				let cancelled = false;
				setPreviews((prev) => ({ ...prev, [openId]: { status: "loading" } }));
				void (async () => {
					try {
						const body = await apiGet(API + "/detail?sessionId=" + encodeURIComponent(openId));
						if (!cancelled) setPreviews((prev) => ({ ...prev, [openId]: { status: "ready", data: body } }));
					} catch (err) {
						fetchedRef.current.delete(openId);
						if (!cancelled) {
							setPreviews((prev) => ({
								...prev,
								[openId]: { status: "error", error: err instanceof Error ? err.message : String(err) }
							}));
						}
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [openId]);

			const doRestore = useCallback(
				async (row) => {
					const ok = window.confirm(
						t("confirmRestore") + "\n\n" + row.title + "\n" + row.sessionId + "\n\n" + t("confirmRestoreBody")
					);
					if (!ok) return;
					setBusyId(row.sessionId);
					setToast(null);
					try {
						const body = await apiPost(API + "/restore", { sessionId: row.sessionId });
						const extra = body.unarchived === true || row.wasArchived === true ? "\n" + t("restoreUnarchived") : "";
						setToast({ kind: "ok", text: t("restored", { path: body.restoredTo }) + extra });
						if (openId === row.sessionId) setOpenId(null);
						await load(true);
					} catch (err) {
						setToast({ kind: "bad", text: t("restoreFailed", { error: err instanceof Error ? err.message : String(err) }) });
					} finally {
						setBusyId(null);
					}
				},
				[load, openId]
			);

			const doDelete = useCallback(
				async (row) => {
					const ok = window.confirm(
						t("confirmDelete") + "\n\n" + row.title + "\n" + row.sessionId + "\n\n" + t("confirmDeleteBody")
					);
					if (!ok) return;
					setBusyId(row.sessionId);
					setToast(null);
					try {
						await apiPost(API + "/delete", { sessionId: row.sessionId });
						setToast({ kind: "ok", text: t("deleted", { id: row.sessionId }) });
						if (openId === row.sessionId) setOpenId(null);
						await load(true);
					} catch (err) {
						setToast({ kind: "bad", text: t("deleteFailed", { error: err instanceof Error ? err.message : String(err) }) });
					} finally {
						setBusyId(null);
					}
				},
				[load, openId]
			);

			const rows = data !== null && Array.isArray(data.archives) ? data.archives : [];
			const groups = groupByCwd(rows);

			const header = h(
				"div",
				{ className: "as-head" },
				h("span", { className: "as-title" }, t("nav")),
				data !== null
					? h(
							"span",
							{ className: "as-sub" },
							t("summary", { total: data.total, size: formatBytes(data.totalSize) })
						)
					: null,
				h("span", { className: "as-spacer" }),
				h(
					"button",
					{ type: "button", className: "as-btn", disabled: status === "loading", onClick: () => void load() },
					status === "loading" ? t("refreshing") : t("refresh")
				)
			);

			const body = [];
			if (status === "loading" && data === null) {
				body.push(h("div", { className: "as-note", key: "loading" }, t("loadingText")));
			}
			if (status === "error") {
				body.push(
					h("div", { className: "as-err", key: "err" }, t("loadFailed", { error: error || t("errUnknown") })),
					h(
						"div",
						{ key: "err-retry" },
						h("button", { type: "button", className: "as-btn", onClick: () => void load() }, t("retry"))
					)
				);
			}
			if (status === "ready" && rows.length === 0) {
				body.push(h("div", { className: "as-empty", key: "empty" }, t("empty")));
			}
			for (const group of groups) {
				const isCollapsed = collapsed[group.key] === true;
				body.push(
					h(
						"div",
						{ className: "as-group", key: "g-" + group.key },
						h(
							"div",
							{ className: "as-ghead", onClick: () => toggleGroup(group.key), role: "button", tabIndex: 0 },
							h("span", { className: "as-caret" }, isCollapsed ? "▶" : "▼"),
							h("span", { className: "as-cwd" }, group.cwd === null ? t("unknownCwd") : group.cwd),
							h("span", { className: "as-count" }, String(group.rows.length))
						),
						isCollapsed ? null : h("div", { className: "as-rows" }, group.rows.map((row) => renderRow(row)))
					)
				);
			}

			function renderRow(row) {
				const busy = busyId === row.sessionId;
				const isOpen = openId === row.sessionId;
				// 日志文件极小（<1KB）⇒ 基本只有会话头，没有任何对话内容
				const isEmpty = typeof row.size === "number" && row.size < 1024;
				const preview = previews[row.sessionId];
				const meta = [
					row.turns > 0 ? t("turns", { n: row.turns }) : null,
					formatBytes(row.size),
					formatTime(row.createdAt),
					t("batch") + " " + row.batch
				]
					.filter((part) => part !== null)
					.join(" · ");
				return h(
					"div",
					{ key: row.sessionId },
					h(
						"div",
						{ className: "as-row" },
						h(
							"div",
							{ className: "as-main" },
							h(
								"div",
								{ className: "as-name" },
								row.title !== null && row.title !== undefined ? row.title : row.sessionId,
								isEmpty ? h("span", { className: "as-flag as-flag-dim" }, t("flagEmpty")) : null,
								row.wasArchived === true ? h("span", { className: "as-flag" }, t("flagArchived")) : null,
								row.hasMeta === false ? h("span", { className: "as-flag" }, t("flagNoMeta")) : null
							),
							h("div", { className: "as-meta" }, meta)
						),
						h(
							"div",
							{ className: "as-acts" },
							h(
								"button",
								{
									type: "button",
									className: "as-act" + (isOpen ? " as-on" : ""),
									onClick: () => togglePreview(row.sessionId)
								},
								isOpen ? t("actionCollapse") : t("actionPreview")
							),
							h(
								"button",
								{
									type: "button",
									className: "as-act",
									disabled: busy,
									onClick: () => void doRestore(row)
								},
								busy ? t("busy") : t("actionRestore")
							),
							h(
								"button",
								{
									type: "button",
									className: "as-act as-danger",
									disabled: busy,
									onClick: () => void doDelete(row)
								},
								t("actionDelete")
							)
						)
					),
					isOpen ? renderPreview(row, preview) : null
				);
			}

			function renderHeaderLine(detail) {
				const header = detail.header || {};
				const parts = [
					header.id ? t("sessionId", { id: header.id }) : null,
					header.agentPreset ? t("preset", { name: header.agentPreset }) : null,
					header.delegationDepth !== null && header.delegationDepth !== undefined
						? t("delegation", { depth: header.delegationDepth })
						: null
				].filter((part) => part !== null);
				return parts.length > 0 ? h("div", { className: "as-pmeta" }, parts.join(" · ")) : null;
			}

			function renderEventLine(detail) {
				const types = detail.eventTypes !== null && typeof detail.eventTypes === "object" ? detail.eventTypes : {};
				const keys = Object.keys(types);
				if (keys.length === 0) return null;
				const list = keys.map((key) => (EVENT_LABELS[key] ?? key) + " × " + types[key]).join("、");
				return h("div", { className: "as-pmeta" }, t("eventTypes", { list: list }));
			}

			function renderPreview(row, preview) {
				if (preview === undefined || preview.status === "loading") {
					return h("div", { className: "as-preview" }, h("div", { className: "as-note" }, t("decoding")));
				}
				if (preview.status === "error") {
					return h(
						"div",
						{ className: "as-preview" },
						h("div", { className: "as-err" }, t("previewFailed", { error: preview.error }))
					);
				}
				const detail = preview.data || {};
				const messages = Array.isArray(detail.messages) ? detail.messages : [];
				const total = typeof detail.totalMessages === "number" ? detail.totalMessages : messages.length;
				const meta = [
					t("previewMeta", { total: total }) +
						(total > messages.length ? t("previewTail", { n: messages.length }) : ""),
					detail.cwd ? t("cwdLabel", { cwd: detail.cwd }) : null,
					detail.createdAt ? formatTime(detail.createdAt) : null
				]
					.filter((part) => part !== null)
					.join(" · ");
				return h(
					"div",
					{ className: "as-preview" },
					h("div", { className: "as-pmeta" }, meta),
					messages.length === 0
						? h(
								"div",
								null,
								h("div", { className: "as-note" }, t("emptyLog")),
								renderHeaderLine(detail),
								renderEventLine(detail),
								h("div", { className: "as-note" }, t("emptySafe"))
							)
						: h(
								"div",
								{ className: "as-msgs" },
								messages.map((message, index) =>
									h(
										"div",
										{ className: "as-msg as-" + message.role, key: index },
										h(
											"div",
											null,
											h(
												"span",
												{ className: "as-role" },
												message.role === "user" ? t("roleUser") : t("roleAssistant")
											),
											h("span", { className: "as-time" }, formatTime(message.time))
										),
										h("div", { className: "as-text" }, message.content),
										message.truncated === true ? h("div", { className: "as-cut" }, t("truncated")) : null
									)
								)
							)
				);
			}

			function renderAuto(data) {
				const cfg = data.config || {};
				const st = data.state || {};
				const last = st.lastResult || null;
				const enabled = cfg.enabled === true;
				const dry = cfg.dryRun !== false;
				const hours = Number(cfg.hours) || 48;
				const intervalHours = Math.max(1, Math.round((Number(cfg.intervalMs) || 21600000) / 3600000));
				const badge = enabled ? (dry ? t("autoEnabledDry") : t("autoEnabledLive")) : t("autoDisabled");
				const meta = [
					t("autoThreshold", { hours: hours }),
					t("autoEvery", { hours: intervalHours }),
					st.lastRunAt ? t("autoLastRun", { time: formatTime(st.lastRunAt) }) : t("autoNeverRun"),
					t("autoTotal", { n: Number(st.totalArchived) || 0 })
				].join(" · ");
				const acts = [
					h(
						"button",
						{ type: "button", className: "as-act", disabled: autoBusy, onClick: () => void autoRun(true) },
						autoBusy ? t("busy") : t("autoRunNow")
					)
				];
				if (!enabled) {
					acts.push(
						h(
							"button",
							{
								type: "button",
								className: "as-act primary",
								disabled: autoBusy,
								onClick: () => void autoSet({ enabled: true, dryRun: true })
							},
							t("autoEnable")
						)
					);
				} else {
					acts.push(
						h(
							"button",
							{
								type: "button",
								className: "as-act" + (dry ? " primary" : ""),
								disabled: autoBusy,
								onClick: () => void autoSet({ dryRun: !dry })
							},
							dry ? t("autoGoLive") : t("autoGoDry")
						),
						h(
							"button",
							{
								type: "button",
								className: "as-act as-danger",
								disabled: autoBusy,
								onClick: () => void autoSet({ enabled: false })
							},
							t("autoDisable")
						)
					);
				}
				const candidateList =
					last !== null && Array.isArray(last.candidates) && last.candidates.length > 0
						? h(
								"ul",
								{ className: "as-auto-list" },
								last.candidates
									.slice(0, 8)
									.map((c) =>
										h(
											"li",
											{ key: c.sessionId },
											c.sessionId + " · " + c.mb + " MB · " + t("autoDaysIdle", { days: c.ageD })
										)
									)
							)
						: null;
				return h(
					"div",
					{ className: "as-auto" },
					h(
						"div",
						{ className: "as-auto-head" },
						h("span", { className: "as-auto-title" }, t("autoTitle")),
						h("span", { className: "as-badge" + (enabled ? (dry ? " as-warn" : " as-ok") : "") }, badge),
						h("span", { className: "as-spacer" }),
						...acts
					),
					h("div", { className: "as-auto-meta" }, meta),
					last !== null
						? h(
								"div",
								{ className: "as-auto-meta" },
								(last.dryRun === true ? t("autoLastDry") : t("autoLastReal")) + summarizeRun(last)
							)
						: null,
					candidateList
				);
			}

			return h(
				"div",
				{ [ATTR]: "" },
				header,
				toast !== null
					? h("div", { className: "as-toast " + (toast.kind === "ok" ? "as-ok" : "as-bad") }, toast.text)
					: null,
				auto !== null ? renderAuto(auto) : null,
				h("div", { className: "as-note" }, t("footer")),
				...body
			);
		}
		//#endregion

		//#region plugin
		const name = "dsh-archive-sessions/client";
		const inject = ["slots", "locale"];

		/** 设置分栏选项（两套注册姿势共用）。 */
		function sectionOptions(t) {
			return {
				name: "settings.section",
				id: "archive-sessions",
				order: 1000,
				label: () => t("nav"),
				locale: NS
			};
		}

		/**
		 * 注册设置分栏（运行时探测两套 API）。
		 *
		 * ① 首选 ctx.slots.inject("settings.section", ...)：
		 *    官方 @deepseek-ai/dsh-client-ui-settings-general 自己在用的姿势，
		 *    在 0.1.1 线与 0.1.5 线都被官方源码使用。
		 * ② 兜底才试 ctx.settings.installSection：
		 *    ⚠️ 注意这个函数名在新线里属于**服务端设置注册**，签名是
		 *       installSection(owner, ns, schema, entry, hooks)（5 个参数，给不是 UI 分栏用的）。
		 *    因此这里要求「存在 + 形参个数少于 4」才认定它是 UI 分栏 API，避免误用把插件打崩。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-archive-sessions: dictionaries");
			const t = ctx.locale.bind(NS);

			if (ctx.slots && typeof ctx.slots.inject === "function" && typeof ctx.slots.register === "function") {
				ctx.slots.inject("settings.section", () => ctx.slots.register(sectionOptions(t), Section));
				return;
			}
			const installSection = ctx.settings && ctx.settings.installSection;
			if (typeof installSection === "function" && installSection.length < 4) {
				installSection(sectionOptions(t), Section);
				return;
			}
			throw new Error(
				"dsh-archive-sessions: no usable settings-section API found " +
					"(neither ctx.slots.inject nor a UI-shaped ctx.settings.installSection)"
			);
		}
		//#endregion

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
