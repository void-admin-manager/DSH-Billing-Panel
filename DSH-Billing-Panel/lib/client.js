/**
 * Usage/balance panel — browser half.
 *
 * Renders the balance, this month's usage, and one answer's tokens/spend/time in the
 * conversation pane; enforces the three editable ceilings; reports each finished
 * answer to the host's turn ledger.
 *
 * Cautions:
 * - Peak windows are UTC Mon–Fri 01:00–04:00 and 06:00–10:00, with **no public-holiday
 *   calendar**: spend during Chinese public holidays is over-estimated (see README).
 * - A ceiling stops the current answer of the current conversation only; subagents
 *   already running in the background are not stopped by it.
 * - Subagents add tokens, spend, and requests to the answer; time covers the answer's
 *   own turn only.
 * - No credential reaches this half: account reads go through the Host API, usage
 *   reads through the Host's loopback route.
 */
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-usage-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const reactDomClient = require("react-dom/client");
		const reactJsxRuntime = require("react/jsx-runtime");
		const jsx = reactJsxRuntime.jsx;
		const jsxs = reactJsxRuntime.jsxs;

		/** Refresh cadence for both account reads, in milliseconds. */
		const REFRESH_INTERVAL_MS = 60000;
		/** Client build identity reported to the Host with each account call. */
		const CLIENT_VERSION = "0.2.0";
		/** Panel host element id, so a reload never stacks two panels. */
		const ROOT_ID = "dsh-usage-balance-root";
		/** Anchor element id: the pane-relative box the host lives in. */
		const ANCHOR_ID = "dsh-usage-balance-anchor";
		/** Local storage key holding the guard limits this page last saved. */
		const LIMITS_KEY = "dsh-usage-balance/limits/v2";
		/** Local storage key holding the answers this page already wrote to the ledger. */
		const TURN_LEDGER_KEY = "dsh-usage-balance/ledger/v1";
		/** How many finished answers stay remembered, so one answer is never written twice. */
		const LEDGER_MEMORY = 64;
		/** Local storage key holding the last model price table this page read. */
		const PRICING_CACHE_KEY = "dsh-usage-balance/pricing/v1";
		/** How long a cached price table is trusted, in milliseconds. */
		const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
		/** How often the panel recomputes an in-flight answer's time and spend. */
		const GUARD_TICK_MS = 1000;
		/** How long a budget interrupt suppresses further interrupts, in milliseconds. */
		const GUARD_BACKOFF_MS = 30000;
		/** Longest follow-up, in tokens, that an interruption prompt asks for. */
		const EXPLANATION_TARGET_TOKENS = 500;
		/** Guard defaults: one answer may spend at most 10000万 tokens (1e8), ¥5, or 3600 s. */
		const DEFAULT_LIMITS = {
			enabled: true,
			tokens: 1e8,
			cost: 5,
			seconds: 3600
		};
		/** Editable range of one ceiling: tokens 10,000–2.1e9, spend ¥1–100,000, time 60–86,400 s. */
		const MIN_LIMIT = { tokens: 1e4, cost: 1, seconds: 60 };
		const MAX_LIMIT = { tokens: 21e8, cost: 100_000, seconds: 86_400 };
		/** The floor as the token field shows it, in 万. */
		const MIN_TOKENS_FIELD = MIN_LIMIT.tokens / 1e4;
		/** The ceiling as the token field shows it, in 万. */
		const MAX_TOKENS_FIELD = MAX_LIMIT.tokens / 1e4;
		/** Rate table used until the host half answers: CNY per one million tokens */
		const FALLBACK_PRICING = {
			currency: "CNY",
			models: {
				"deepseek-flash": {
					peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
					offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
				},
				"deepseek-v4-pro": {
					peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
					offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
				}
			}
		};
		/** Panel stacking layer: read from the host's injected global */
		const LAYER = (() => {
			const injected = globalThis.__DSH_USAGE_BALANCE__?.layer;
			return Number.isSafeInteger(injected) && injected > 0 ? injected : 1200;
		})();
		/** Minimum conversation-pane size for the panel to appear, in CSS pixels. */
		const PANE_MIN_WIDTH = 1440;
		const PANE_MIN_HEIGHT = 256;
		/** Conversation-pane selectors, most specific first. */
		const PANE_SELECTORS = [
			'[data-conversation-region="chat"]',
			"[data-conversation-content]",
			"[data-conversation-scroll]"
		];
		/** Label identifying the Trajectory view in the conversation view ring. */
		const TRAJECTORY_TAB_LABEL = /trajectory|轨迹/iu;
		/** Bar counts above this get their own horizontal scroll box. */
		const MAX_BARS_WITHOUT_SCROLL = 16;
		/** Styles are injected once per page, keyed by a stable data attribute. */
		const CSS_TAG_ID = "@deepseek-ai/dsh-client-ui-usage-balance/BalanceBadge.css";
		const CSS = [
			"#" + ANCHOR_ID + "{position:absolute;z-index:" + String(LAYER) + ";pointer-events:none;overflow:hidden}",
			"#" + ROOT_ID + "{position:absolute;right:24px;bottom:22px;pointer-events:none}",
			"#" + ROOT_ID + "[data-visible=false]{display:none}",
			".dsh-balance-panel{box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;gap:8px;",
			"width:min(28rem,calc(100vw - 96px));padding:11px 14px;border:1px solid var(--dsw-alias-border-l3,#3a3a3a);",
			"border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#1b1b1b) 90%,transparent);",
			"color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:13.5px;line-height:19px;font-variant-numeric:tabular-nums;",
			"box-shadow:0 1px 8px rgba(0,0,0,.22);backdrop-filter:blur(6px);pointer-events:auto;",
			"user-select:none;-webkit-app-region:no-drag;opacity:.9;transition:opacity .15s ease}",
			".dsh-balance-panel:hover{opacity:1}",
			".dsh-balance-row{display:flex;align-items:center;gap:6px 16px;white-space:nowrap}",
			".dsh-balance-entry{display:inline-flex;align-items:baseline;gap:5px}",
			".dsh-balance-label{color:var(--dsw-alias-label-tertiary,#7d7d7d)}",
			".dsh-balance-value{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:500}",
			".dsh-balance-cost{color:var(--dsw-alias-label-warning,#d9a05b);font-weight:500}",
			".dsh-balance-muted{color:var(--dsw-alias-label-tertiary,#7d7d7d)}",
			".dsh-balance-button{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;",
			"border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#7d7d7d);",
			"font-size:13px;line-height:1;cursor:pointer;margin-left:auto}",
			".dsh-balance-button:hover{background:color-mix(in srgb,currentColor 16%,transparent)}",
			".dsh-balance-button[data-spinning=true]{animation:dsh-balance-spin 1s linear infinite}",
			"@keyframes dsh-balance-spin{to{transform:rotate(360deg)}}",
			".dsh-balance-toggle{align-self:center;display:inline-flex;gap:2px;padding:2px;border-radius:6px;",
			"background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d7d7d) 14%,transparent)}",
			".dsh-balance-toggle button{border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#7d7d7d);",
			"font:inherit;font-size:12px;line-height:17px;padding:2px 10px;cursor:pointer}",
			".dsh-balance-toggle button[data-active=true]{background:color-mix(in srgb,var(--dsw-alias-bg-base,#1b1b1b) 80%,transparent);",
			"color:var(--dsw-alias-label-primary,#e8e8e8)}",
			".dsh-balance-chart{display:flex;align-items:flex-end;gap:2px;height:72px;overflow-x:auto;overflow-y:hidden;",
			"scrollbar-width:thin;padding-bottom:1px;border-bottom:1px solid var(--dsw-alias-border-l3,#3a3a3a)}",
			".dsh-balance-chart[data-scroll=true] .dsh-balance-bar{flex:none;width:14px}",
			".dsh-balance-chart::-webkit-scrollbar{height:5px}",
			".dsh-balance-chart::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.18));border-radius:3px}",
			".dsh-balance-chart-empty{color:var(--dsw-alias-label-tertiary,#7d7d7d);flex:none;margin:auto;font-size:12.5px}",
			".dsh-balance-bar{flex:1 1 0;min-width:3px;min-height:2px;border-radius:2px 2px 0 0;",
			"background:linear-gradient(to top,color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 45%,transparent),var(--dsw-alias-brand-primary,#4d6bfe))}",
			".dsh-balance-bar[data-empty=true]{background:var(--dsw-alias-separator-primary,rgba(255,255,255,.14))}",
			".dsh-balance-bar[data-today=true]{background:linear-gradient(to top,color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 30%,transparent),#7ee0c0)}",
			".dsh-balance-axis{display:flex;gap:2px;overflow:hidden}",
			".dsh-balance-axis[data-scroll=true] .dsh-balance-tick{flex:none;width:14px}",
			".dsh-balance-tick{flex:1 1 0;min-width:3px;text-align:center;color:var(--dsw-alias-label-tertiary,#7d7d7d);",
			"font-size:10.5px;line-height:14px;overflow:hidden}",
			".dsh-balance-foot{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:12px;line-height:17px;flex-wrap:wrap}",
			".dsh-balance-error{color:var(--dsw-alias-label-warning,#d9a05b)}",
			".dsh-balance-guards{display:flex;flex-direction:column;gap:6px;padding-top:8px;",
			"border-top:1px solid var(--dsw-alias-border-l3,#3a3a3a)}",
			".dsh-balance-guard-head{display:flex;align-items:center;gap:9px;color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:12.5px;line-height:18px}",
			".dsh-balance-guard-head .dsh-balance-value{margin-left:auto}",
			".dsh-balance-guards[data-off=true] .dsh-balance-guard{opacity:.45}",
			".dsh-balance-guard{display:grid;grid-template-columns:3.5rem 6.5rem minmax(0,1fr) 5.5rem 2.25rem;align-items:center;gap:8px;font-size:12.5px;line-height:18px}",
			".dsh-balance-guard-label{color:var(--dsw-alias-label-tertiary,#7d7d7d)}",
			".dsh-balance-guard-meter{position:relative;height:7px;border-radius:4px;overflow:hidden;",
			"background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#7d7d7d) 18%,transparent)}",
			".dsh-balance-guard-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:4px;",
			"background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .2s linear}",
			".dsh-balance-guard[data-state=warn] .dsh-balance-guard-fill{background:var(--dsw-alias-label-warning,#d9a05b)}",
			".dsh-balance-guard[data-state=over] .dsh-balance-guard-fill{background:var(--dsw-alias-label-danger,#e06c75)}",
			".dsh-balance-guard-now{color:var(--dsw-alias-label-primary,#e8e8e8);text-align:right;font-variant-numeric:tabular-nums;",
			"white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-balance-guard[data-state=over] .dsh-balance-guard-now{color:var(--dsw-alias-label-warning,#d9a05b)}",
			// A spinner is a poor fit for a ceiling, so the field is a text box with a numeric keypad hint
			".dsh-balance-limit{box-sizing:border-box;width:100%;padding:3px 7px;border-radius:6px;font:inherit;font-size:12.5px;line-height:18px;",
			"border:1px solid var(--dsw-alias-border-l3,#3a3a3a);background:color-mix(in srgb,var(--dsw-alias-bg-base,#1b1b1b) 70%,transparent);",
			"color:var(--dsw-alias-label-primary,#e8e8e8);text-align:right;font-variant-numeric:tabular-nums}",
			".dsh-balance-limit::-webkit-outer-spin-button,.dsh-balance-limit::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0}",
			".dsh-balance-limit[type=number]{-moz-appearance:textfield;appearance:textfield}",
			".dsh-balance-limit:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
			// A live answer freezes the ceilings, so the field reads as data rather than as a control until that answer ends.
			".dsh-balance-limit[data-locked=true]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:not-allowed}",
			".dsh-balance-limit[data-locked=true]:hover{border-color:var(--dsw-alias-border-l3,#3a3a3a)}",
			".dsh-balance-limit-unit{color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:12px;line-height:18px;white-space:nowrap}",
			".dsh-balance-alert{color:var(--dsw-alias-label-warning,#d9a05b);font-size:12.5px;line-height:18px}",
			".dsh-balance-note{color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:12px;line-height:16px}",
			".dsh-balance-stop{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font:inherit;font-size:12.5px;line-height:18px;",
			"border:1px solid var(--dsw-alias-border-l3,#3a3a3a);background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:pointer}",
			".dsh-balance-stop:hover{border-color:var(--dsw-alias-label-warning,#d9a05b);color:var(--dsw-alias-label-warning,#d9a05b)}",
			".dsh-balance-stop[disabled]{opacity:.45;cursor:not-allowed}",
			".dsh-balance-stop[disabled]:hover{border-color:var(--dsw-alias-border-l3,#3a3a3a);color:var(--dsw-alias-label-secondary,#9a9a9a)}",
			".dsh-balance-checkbox{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}",
			".dsh-balance-checkbox[disabled]{cursor:not-allowed;opacity:.5}",
			".dsh-balance-lock{color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:11.5px;line-height:16px}",
			".dsh-balance-turn{color:var(--dsw-alias-label-tertiary,#7d7d7d);font-size:11.5px;line-height:16px}"
		].join("");

		/** Panel copy; the registration picks the pair matching the active locale. */
		const COPY = {
			en: {
				balance: "Balance",
				bonus: "Granted",
				cost: "Spent",
				requests: "API requests",
				tokens: "Tokens",
				tokensOption: "Tokens",
				requestsOption: "Requests",
				loading: "loading…",
				signedOut: "sign in to view",
				failed: "unavailable",
				error: "usage read failed",
				emptyChart: "no usage recorded this month",
				refresh: "Refresh now",
				updated: "updated",
				title: "DeepSeek Platform balance and this month's usage",
				guards: "Answer limits",
				guardTokens: "tokens",
				guardCost: "spend",
				guardSeconds: "time",
				limitTokens: "max tokens",
				limitCost: "max spend",
				limitSeconds: "max seconds",
				toggleGuards: "Enforce the answer limits",
				stopNow: "Stop the answer",
				stopHint: "Stop the running answer",
				noSession: "no conversation bound yet",
				guardIdle: "waiting for an answer",
				guardRunning: "answering",
				stopped: "stopped",
				budgetNote: "estimated at the published rate · spend refreshed daily",
				answerRequests: "{count} requests in this answer",
				ledgerWritten: "recorded",
				ledgerSending: "recording…",
				ledgerFailed: "not recorded",
				interrupted: "stopped by the answer limit",
				// One sentence, placeholders filled from the ceiling that tripped.
				replyPrompt: "The plugin stopped your previous answer (the user did not): the answer hit the {kind} limit at {actual} / {limit}. Reply with one paragraph of at most {target} tokens giving what you had established, what you were about to do next, and how the user should continue. Do not call tools; exceeding the limit stops the reply again.",
				lockHint: "limits are locked while an answer is running",
				unitTokens: "10k tok",
				unitCost: "CNY",
				unitSeconds: "s",
				tokensValue: "{value} × 10k tok",
				subagents: " · {sessions} subagent(s), {requests} request(s) included"
			},
			zh: {
				balance: "余额",
				bonus: "赠金",
				cost: "消费",
				requests: "API 请求",
				tokens: "Tokens",
				tokensOption: "Tokens",
				requestsOption: "请求数",
				loading: "读取中…",
				signedOut: "登录后查看",
				failed: "暂不可用",
				error: "用量读取失败",
				emptyChart: "本月暂无用量记录",
				refresh: "立即刷新",
				updated: "更新于",
				title: "DeepSeek 开放平台余额与本月用量",
				guards: "回答上限",
				guardTokens: "tokens",
				guardCost: "消费",
				guardSeconds: "时长",
				limitTokens: "tokens 上限",
				limitCost: "消费上限(元)",
				limitSeconds: "时长上限(秒)",
				toggleGuards: "启用回答上限（超限即中止）",
				stopNow: "中止回答",
				stopHint: "立即中止正在进行的回答",
				noSession: "尚未绑定对话",
				guardIdle: "等待回答",
				guardRunning: "回答中",
				stopped: "已中止",
				budgetNote: "按公开单价估算 · 单价每日刷新",
				answerRequests: "本轮共 {count} 次请求",
				ledgerWritten: "已记入台账",
				ledgerSending: "台账写入中…",
				ledgerFailed: "台账未写入",
				interrupted: "已被回答上限中止",
				replyPrompt: "插件已中止你上一条回答（不是用户中止的）：本次回答触发了 {kind} 上限（{actual} / {limit}）。请只输出一段话，最多 {target} tokens，说明已确认的结论、下一步打算、以及用户接下来怎么继续；不要调用工具。超过上限会被再次中止。",
				lockHint: "回答进行中，上限已锁定",
				unitTokens: "万tokens",
				unitCost: "元",
				unitSeconds: "秒",
				tokensValue: "{value}万tokens",
				subagents: " · 含子代 {sessions} 个 / {requests} 次请求"
			}
		};

		/** Inject the panel stylesheet once for the whole page. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]");
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-usage-balance";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Pick panel copy for one active locale. */
		function copyFor(active) {
			return typeof active === "string" && active.toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
		}

		/** Create the panel's observable state cell: the snapshot is replaced wholesale on publish */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			const publish = () => {
				for (const listener of [...listeners]) listener();
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				patch: (fields) => {
					snapshot = { ...snapshot, ...fields };
					publish();
				}
			};
		}

		/** Format one amount for display. */
		function formatAmount(amount) {
			const numeric = typeof amount === "number" ? amount : Number(amount);
			if (!Number.isFinite(numeric)) return String(amount);
			const decimals = numeric !== 0 && Math.abs(numeric) < 0.01 ? 3 : 2;
			return numeric.toLocaleString(undefined, {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals
			});
		}

		/** Currency symbol for one wallet's ISO code. */
		function currencySymbol(currency) {
			return currency === "CNY" ? "¥" : "$";
		}

		/** Join wallet amounts of one kind into a single display string. */
		function formatWallets(wallets) {
			if (!Array.isArray(wallets) || wallets.length === 0) return void 0;
			return wallets
				.map((wallet) => currencySymbol(wallet.currency) + formatAmount(wallet.balance))
				.join(" · ");
		}

		/** Compact count: 1.2k / 3.4M. */
		function formatCount(value) {
			const numeric = Number(value);
			if (!Number.isFinite(numeric)) return "—";
			if (numeric < 1000) return String(Math.round(numeric));
			if (numeric < 1e4) return `${(numeric / 1e3).toFixed(1)}k`;
			if (numeric < 1e6) return `${String(Math.round(numeric / 1e3))}k`;
			return `${(numeric / 1e6).toFixed(1)}M`;
		}

		/** Short clock label for one timestamp. */
		function formatClock(at) {
			if (!Number.isFinite(at) || at <= 0) return "";
			const date = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** Day-of-month label for one ISO date bucket. */
		function dayOfMonth(date) {
			const day = /^\d{4}-\d{2}-(\d{2})$/u.exec(typeof date === "string" ? date : "")?.[1];
			return day === undefined ? "" : String(Number(day));
		}

		/** Read one RemoteResult envelope. */
		function unwrap(result) {
			if (result === null || result === void 0) return void 0;
			if (typeof result === "object" && "ok" in result) return result.ok ? result.value : void 0;
			return result;
		}

		/** Whether the conversation view ring is currently showing the Trajectory view. */
		function trajectoryViewOpen() {
			const tablist = document.querySelector('[data-conversation-tabs], [role="tablist"]');
			if (tablist !== null) {
				const selected = tablist.querySelector('[role="tab"][aria-selected="true"]');
				if (selected !== null && TRAJECTORY_TAB_LABEL.test(selected.textContent ?? "")) return true;
			}
			return document.querySelector("[data-trajectory-scroll]") !== null;
		}

		/** Find the conversation pane the panel attaches to. */
		function conversationPane() {
			for (const selector of PANE_SELECTORS) {
				const found = document.querySelector(selector);
				if (found !== null) return found;
			}
			return null;
		}

		/** Whether the conversation pane is currently at least 1024x768. */
		function paneLargeEnough(pane) {
			const rect = pane.getBoundingClientRect();
			return rect.width >= PANE_MIN_WIDTH && rect.height >= PANE_MIN_HEIGHT;
		}

		/** Attach the panel's host to the conversation pane. */
		function attachToConversation(host) {
			const pane = conversationPane();
			if (pane === null) return null;
			const container = pane.parentElement ?? pane;
			let anchor = container.querySelector(":scope > #" + ANCHOR_ID);
			if (anchor === null) {
				anchor = document.createElement("div");
				anchor.id = ANCHOR_ID;
				container.appendChild(anchor);
			}
			// The host is born inside the anchor, so it never flashes over the app.
			anchor.appendChild(host);
			return anchor;
		}

		/** Lay the anchor over the conversation pane's rectangle. */
		function positionAnchorOverPane(anchor, pane) {
			const rect = pane.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return false;
			const container = anchor.parentElement;
			const bounds = container === null ? { left: 0, top: 0 } : container.getBoundingClientRect();
			anchor.style.left = `${String(rect.left - bounds.left)}px`;
			anchor.style.top = `${String(rect.top - bounds.top)}px`;
			anchor.style.width = `${String(rect.width)}px`;
			anchor.style.height = `${String(rect.height)}px`;
			return true;
		}

		/** Keep the host in the conversation pane and keep its `data-visible` in step with the pane's own size and the Trajectory view. */
		function watchConversation(host) {
			let anchor = attachToConversation(host);
			let pane = conversationPane();
			let trajectory = trajectoryViewOpen();
			const sizes = new WeakMap();
			const apply = () => {
				// `isConnected` is the liveness test: a detached pane also reports a zero rect
				const tracked = pane !== null && pane.isConnected !== false;
				const largeEnough = tracked && paneLargeEnough(pane);
				host.dataset.visible = largeEnough && !trajectory ? "true" : "false";
				if (anchor !== null && tracked) positionAnchorOverPane(anchor, pane);
			};
			const measure = () => {
				if (pane === null) return;
				const rect = pane.getBoundingClientRect();
				const key = `${String(rect.width)}x${String(rect.height)}@${String(rect.left)},${String(rect.top)}`;
				if (sizes.get(pane) === key) return;
				sizes.set(pane, key);
				apply();
			};
			const onMutation = () => {
				if (pane === null || pane.isConnected === false) {
					const nextAnchor = attachToConversation(host);
					const nextPane = conversationPane();
					if (nextAnchor !== null && nextPane !== null) {
						anchor = nextAnchor;
						pane = nextPane;
						observePane();
					}
				}
				const nextTrajectory = trajectoryViewOpen();
				if (nextTrajectory !== trajectory) {
					trajectory = nextTrajectory;
					apply();
				}
				measure();
			};
			const resizeObserver = typeof globalThis.ResizeObserver === "function"
				? new globalThis.ResizeObserver(apply)
				: void 0;
			const observePane = () => {
				if (pane === null) return;
				resizeObserver?.observe(pane);
			};
			if (resizeObserver === void 0) globalThis.addEventListener?.("resize", apply);
			observePane();
			apply();
			// Attribute changes (tab selection), pane swaps, and layout that resizes without a window event all arrive here.
			const observer = new MutationObserver(onMutation);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["aria-selected", "data-conversation-content"]
			});
			return () => {
				observer.disconnect();
				resizeObserver?.disconnect();
				if (resizeObserver === void 0) globalThis.removeEventListener?.("resize", apply);
				host.remove();
				if (anchor !== null && anchor.parentElement !== null) anchor.remove();
			};
		}

		/** Services the panel needs before it can read the account, and to stop an answer. */
		const inject = ["remote", "remote.account", "remote.session", "locale"];

		/** Build the refresh routine reading both the account balance and the host-bridged month usage. */
		function createRefresh(ctx, store) {
			let inFlight;
			return () => {
				if (inFlight !== void 0) return inFlight;
				store.patch({ refreshing: true });
				const locale = ctx.locale.getSnapshot().active;
				const bridge = globalThis.__DSH_USAGE_BALANCE__;
				const read = (async () => {
					// account balance
					let signedIn = false;
					try {
						const view = unwrap(await ctx.remote.account.getState());
						signedIn = view !== void 0 && view.status === "credential-stored";
					} catch {
						// an unreadable account view is reported as signed out below
					}
					if (signedIn) {
						try {
							const value = unwrap(await ctx.remote.account.getBalance({
								version: CLIENT_VERSION,
								locale: typeof locale === "string" && locale !== "" ? locale : "en",
								timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
							}));
							store.patch({
								signedIn: true,
								wallets: value?.status === "ready" ? value.value : void 0,
								bonuses: value?.status === "ready"
									? (value.bonusWallets ?? []).filter((wallet) => Number(wallet.balance) > 0)
									: void 0,
								balance: value === void 0 ? "unavailable" : value.status,
								accountError: void 0
							});
						} catch (error) {
							store.patch({
								signedIn: true,
								balance: "failed",
								accountError: error instanceof Error ? error.message : String(error)
							});
						}
					} else {
						store.patch({
							signedIn: false,
							wallets: void 0,
							bonuses: void 0,
							balance: "signed-out",
							accountError: void 0
						});
					}

					// month usage, through the host bridge
					if (bridge === void 0 || typeof bridge.endpoint !== "string") {
						store.patch({
							usageError: "host usage bridge is unavailable",
							refreshing: false,
							updatedAt: Date.now()
						});
						return;
					}
					try {
						const query = new URLSearchParams({
							locale: typeof locale === "string" ? locale : "zh_CN",
							tz: String(-new Date().getTimezoneOffset() * 60)
						});
						const response = await fetch(`${bridge.endpoint}?${query.toString()}`, {
							headers: { accept: "application/json" }
						});
						const payload = await response.json();
						if (payload?.ok !== true) {
							throw new Error(String(payload?.error ?? `usage read failed (${String(response.status)})`));
						}
						store.patch({
							usage: payload.value,
							usageError: void 0,
							refreshing: false,
							updatedAt: Date.now()
						});
					} catch (error) {
						store.patch({
							usageError: error instanceof Error ? error.message : String(error),
							refreshing: false,
							updatedAt: Date.now()
						});
					}
				})();
				inFlight = read.finally(() => {
					inFlight = void 0;
				});
				return inFlight;
			};
		}

		/** Read one stored JSON value, tolerating a browser that refuses storage. */
		function readStored(key) {
			try {
				const raw = globalThis.localStorage?.getItem(key);
				return raw === null || raw === undefined || raw === "" ? void 0 : JSON.parse(raw);
			} catch {
				return void 0;
			}
		}

		/** Write one JSON value, ignoring a browser that refuses storage. */
		function writeStored(key, value) {
			try {
				globalThis.localStorage?.setItem(key, JSON.stringify(value));
			} catch {
				// a page that cannot persist limits still enforces them for this session
			}
		}

		/** Coerce one stored or typed ceiling into the range its field allows. */
		function clampLimit(value, floor, ceiling, fallback) {
			const numeric = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(numeric)) return fallback;
			return Math.min(ceiling, Math.max(floor, numeric));
		}

		/** Fold whatever was stored into the complete limit set the guards read. */
		function normalizeLimits(stored) {
			const source = stored !== null && typeof stored === "object" ? stored : {};
			const draft = source.draft !== null && typeof source.draft === "object" ? source.draft : {};
			return {
				enabled: source.enabled !== false,
				tokens: clampLimit(source.tokens, MIN_LIMIT.tokens, MAX_LIMIT.tokens, DEFAULT_LIMITS.tokens),
				cost: clampLimit(source.cost, MIN_LIMIT.cost, MAX_LIMIT.cost, DEFAULT_LIMITS.cost),
				seconds: clampLimit(source.seconds, MIN_LIMIT.seconds, MAX_LIMIT.seconds, DEFAULT_LIMITS.seconds),
				// Per-field text while a field is being edited; cleared on commit.
				draft
			};
		}

		// Peak = UTC Mon-Fri 01:00-04:00 and 06:00-10:00. Public holidays are NOT excluded.
		function peakBilling(now) {
			const date = new Date(now);
			const weekday = date.getUTCDay();
			if (weekday === 0 || weekday === 6) return false;
			const hour = date.getUTCHours();
			return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
		}

		/** Pick the rate card for one model at one instant. */
		function rateCardFor(table, model, now) {
			const models = table?.models ?? {};
			const names = Object.keys(models);
			if (names.length === 0) return void 0;
			const exact = typeof model === "string" && model !== "" ? names.find((name) => model.startsWith(name)) : void 0;
			const fallback = names.find((name) => name.startsWith("deepseek-flash")) ?? names[0];
			const card = models[exact ?? fallback];
			return peakBilling(now) ? card?.peak : card?.offPeak;
		}

		/** Price one message's token buckets, split by the published rate line that billed them — this is the plugin's whole billing formula. */
		function priceParts(buckets, card) {
			const perMillion = 1e6;
			const price = (count, rate) => ((count ?? 0) * (rate ?? 0)) / perMillion;
			return {
				cacheMiss: price(buckets.input, card?.cacheMiss) + price(buckets.cacheWrite, card?.cacheMiss),
				cacheHit: price(buckets.cacheRead, card?.cacheHit),
				output: price(buckets.output, card?.output)
			};
		}

		/** Add one request's buckets into an answer's running bucket total. */
		function addBuckets(total, buckets) {
			return {
				input: total.input + (buckets.input ?? 0),
				cacheRead: total.cacheRead + (buckets.cacheRead ?? 0),
				cacheWrite: total.cacheWrite + (buckets.cacheWrite ?? 0),
				output: total.output + (buckets.output ?? 0)
			};
		}

		/** Add one request's price parts into an answer's running parts total. */
		function addParts(total, parts) {
			return {
				cacheMiss: total.cacheMiss + parts.cacheMiss,
				cacheHit: total.cacheHit + parts.cacheHit,
				output: total.output + parts.output
			};
		}

		/** Every token one request billed: its prompt buckets plus its output. */
		function billedTokens(buckets) {
			return (buckets.input ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0);
		}

		/** The prompt side of one request: everything it re-read, without its output. */
		function promptTokens(buckets) {
			return (buckets.input ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0);
		}

		/** A zeroed token bucket set, for a request that has not reported yet. */
		function noBuckets() {
			return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		}

		/** A zeroed cost-part set, for an answer that has not billed yet. */
		function noParts() {
			return { cacheMiss: 0, cacheHit: 0, output: 0 };
		}

		/** What the subagents of one answer billed, kept apart from the answer's own requests so the panel and the ledger can show both. */
		function emptyChild() {
			return { sessions: 0, requests: 0, buckets: noBuckets(), parts: noParts() };
		}

		/** Fold one child's usage samples inside the answer's window. Each request is priced at its own instant. */
		function foldChildWindow(entries, from, to, pricing, model) {
			let buckets = noBuckets();
			let parts = noParts();
			let requests = 0;
			let ack = false;
			let prompt = noBuckets();
			// The instant of the request in flight, so its own card can be chosen.
			let promptAt = from;
			let step;
			/** Settle the request in flight into this child's totals, at its own instant. */
			const settle = () => {
				if (!ack) return;
				buckets = addBuckets(buckets, prompt);
				parts = addParts(parts, priceParts(prompt, rateCardFor(pricing, model, promptAt)));
				ack = false;
				prompt = noBuckets();
			};
			for (const entry of entries) {
				const event = entry?.event;
				if (event === undefined) continue;
				if (!(event.time >= from) || event.time > to) continue;
				if (event.type === "llm/retry-started") {
					// A retried request of the child bills again, and is still one request.
					settle();
					continue;
				}
				const usage = eventUsage(event);
				if (usage === undefined) continue;
				const at = event.data?.step;
				if (ack && typeof at === "number" && typeof step === "number" && at < step) continue;
				const same = step !== void 0 && step === at;
				if (same && ack && bucketsEqual(prompt, usage)) continue;
				if (!same) {
					settle();
					requests += 1;
				}
				ack = true;
				prompt = usage;
				step = at;
				// A request is priced where it ran, not where the fold happens to run.
				promptAt = Number.isFinite(event.time) ? event.time : from;
			}
			settle();
			return { requests, buckets, parts };
		}

		/** A provider usage sample's own counts, when the sample carries usable numbers. */
		function usageBuckets(usage) {
			if (usage === null || typeof usage !== "object") return void 0;
			const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : void 0);
			const input = count(usage.inputTokens);
			const output = count(usage.outputTokens);
			if (input === undefined || output === undefined) return void 0;
			return {
				input,
				cacheRead: count(usage.cacheReadTokens) ?? 0,
				cacheWrite: count(usage.cacheWriteTokens) ?? 0,
				output
			};
		}

		/** The last provider usage sample embedded in an assistant stream. */
		function streamUsage(stream) {
			if (!Array.isArray(stream)) return void 0;
			for (let index = stream.length - 1; index >= 0; index -= 1) {
				const record = stream[index];
				const chunk = record?.chunk ?? record;
				if (chunk?.type === "usage" && chunk.usage !== null && typeof chunk.usage === "object") return chunk.usage;
			}
			return void 0;
		}

		/** Usage carried by one durable assistant settlement, whichever field holds it. */
		function eventUsage(event) {
			if (event?.type === "assistant/message") return usageBuckets(event.data?.usage) === void 0
				? usageBuckets(streamUsage(event.data?.stream))
				: usageBuckets(event.data.usage);
			if (event?.type === "assistant/attempt") return usageBuckets(streamUsage(event.data?.stream));
			return void 0;
		}

		/** One answer's token accounting: only `turn/start` restarts it, every request inside adds up. */
		function emptyTurn() {
			return {
				on: false,
				// The answer's own totals over the requests that already settled.
				buckets: noBuckets(),
				settledParts: { cacheMiss: 0, cacheHit: 0, output: 0 },
				// How many of this answer's own requests have reported usage; a retried request is still one request.
				parentRequests: 0,
				// What this answer's subagents billed while it was being given.
				child: emptyChild(),
				// The newest sample of the request in flight
				ack: false,
				prompt: noBuckets(),
				promptAt: 0,
				// The answer's own totals, as the panel, the ceilings, and the ledger read them.
				total: 0,
				cost: 0,
				parts: { cacheMiss: 0, cacheHit: 0, output: 0 },
				input: 0,
				uncachedInput: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 0,
				// The same numbers split into the answer's own requests and its subagents'.
				ownTotal: 0,
				ownRequests: 0,
				childTotal: 0,
				childCost: 0,
				childRequests: 0,
				childSessions: 0,
				requests: 0,
				step: void 0,
				model: void 0
			};
		}

		/** Whether two token buckets hold the same counts. */
		function bucketsEqual(left, right) {
			return left.input === right.input
				&& left.cacheRead === right.cacheRead
				&& left.cacheWrite === right.cacheWrite
				&& left.output === right.output;
		}

		/** Republish one answer's totals from settled requests, the request in flight, and its subagents (which add no time). */
		function withTotals(usage, card) {
			const inFlight = usage.ack ? usage.prompt : noBuckets();
			const sum = addBuckets(usage.buckets, inFlight);
			const ownParts = usage.ack ? addParts(usage.settledParts, priceParts(inFlight, card)) : usage.settledParts;
			const child = usage.child ?? emptyChild();
			const merged = addBuckets(sum, child.buckets);
			const parts = addParts(ownParts, child.parts);
			return {
				...usage,
				child,
				total: billedTokens(merged),
				cost: parts.cacheMiss + parts.cacheHit + parts.output,
				parts,
				input: promptTokens(merged),
				uncachedInput: merged.input,
				cacheRead: merged.cacheRead,
				cacheWrite: merged.cacheWrite,
				output: merged.output,
				// The two halves, so the panel and the ledger can show the split.
				ownTotal: billedTokens(sum),
				ownRequests: usage.parentRequests,
				childTotal: billedTokens(child.buckets),
				childCost: child.parts.cacheMiss + child.parts.cacheHit + child.parts.output,
				childRequests: child.requests,
				childSessions: child.sessions,
				requests: usage.parentRequests + child.requests
			};
		}

		/** Fold the request in flight into the answer's settled totals. */
		function settleAttempt(usage, card) {
			if (!usage.ack) return usage;
			return {
				...usage,
				buckets: addBuckets(usage.buckets, usage.prompt),
				settledParts: addParts(usage.settledParts, priceParts(usage.prompt, card)),
				ack: false,
				prompt: noBuckets()
			};
		}

		/** How long the answer now being accounted has been running, in seconds. */
		function elapsedSeconds(guard, now) {
			if (!(guard.startedAt > 0)) return 0;
			const end = guard.endedAt > 0 ? guard.endedAt : now;
			return Math.max(0, (end - guard.startedAt) / 1000);
		}

		/** Read the ledger keys this page has already written. */
		function storedLedgerKeys() {
			const stored = readStored(TURN_LEDGER_KEY);
			return Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : [];
		}

		/** Remember one written answer, keeping the newest entries only. */
		function rememberLedgerKey(key) {
			const keys = storedLedgerKeys().filter((existing) => existing !== key);
			keys.push(key);
			writeStored(TURN_LEDGER_KEY, keys.slice(-LEDGER_MEMORY));
		}

		/** Hand one finished answer's totals to the host half, which appends them to the turn ledger on disk. */
		function recordTurn(store, guard, at) {
			const usage = guard.usage ?? emptyTurn();
			const bridge = globalThis.__DSH_USAGE_BALANCE__;
			const route = typeof bridge?.turnEndpoint === "string" ? bridge.turnEndpoint : void 0;
			const sessionId = guard.sessionId;
			if (route === void 0 || sessionId === void 0 || guard.turn === void 0) return;
			if (usage.total <= 0 && usage.requests <= 0) return;
			const key = `${sessionId}:${String(guard.turn)}`;
			if (storedLedgerKeys().includes(key)) return;
			rememberLedgerKey(key);
			const limits = store.getSnapshot().limits;
			const record = {
				sessionId,
				turn: guard.turn,
				endedAt: at,
				tokens: Math.round(usage.total),
				// The prompt side split by the bucket that billed it
				input: Math.round(usage.input),
				uncachedInput: Math.round(usage.uncachedInput),
				cacheRead: Math.round(usage.cacheRead),
				cacheWrite: Math.round(usage.cacheWrite),
				output: Math.round(usage.output),
				cost: Math.round(usage.cost * 1e6) / 1e6,
				// What that cost is made of, one part per published rate line.
				costParts: {
					cacheMiss: Math.round(usage.parts.cacheMiss * 1e6) / 1e6,
					cacheHit: Math.round(usage.parts.cacheHit * 1e6) / 1e6,
					output: Math.round(usage.parts.output * 1e6) / 1e6
				},
				currency: store.getSnapshot().pricing?.currency ?? "CNY",
				seconds: Math.round(elapsedSeconds(guard, at) * 10) / 10,
				requests: usage.requests,
				// The answer's own requests and its subagents' requests, so a line can be read either way: the totals above are the two added up.
				ownRequests: usage.ownRequests,
				ownTokens: Math.round(usage.ownTotal),
				subagents: usage.childSessions === 0 ? void 0 : {
					sessions: usage.childSessions,
					requests: usage.childRequests,
					tokens: Math.round(usage.childTotal),
					cost: Math.round(usage.childCost * 1e6) / 1e6
				},
				model: usage.model,
				stopped: guard.stopped === true,
				reason: guard.reason ?? void 0,
				limits: { tokens: limits.tokens, cost: limits.cost, seconds: limits.seconds }
			};
			store.patch({ ledger: { state: "sending", key, at } });
			void fetch(route, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(record)
			}).then(async (response) => {
				const payload = await response.json();
				if (payload?.ok !== true) throw new Error(String(payload?.error ?? "ledger write failed"));
				store.patch({ ledger: { state: "written", key, at, path: payload.value?.path } });
			}).catch(() => {
				// A failed write must not lose the answer: forgetting the key lets the next fold of this window try again once the bridge is back.
				writeStored(TURN_LEDGER_KEY, storedLedgerKeys().filter((existing) => existing !== key));
				store.patch({ ledger: { state: "failed", key, at } });
			});
		}

		/** Follow the active conversation and account its answers. */
		function followGuards(store, sessions) {
			let detachList = () => { };
			let detachEvents = () => { };
			let bound = void 0;
			let lastWindow = void 0;
			/** An event's own instant, falling back to the clock when it carries none. */
			const stamp = (event) => (Number.isFinite(event?.time) ? event.time : Date.now());

			// ── the answer's subagents ──────────────────────────────────────────
			/** Descendant session ids discovered for the bound answer. */
			const childIds = new Set();
			/** Descendant id → its binding and the disposer of its window subscription. */
			const childSources = new Map();
			/** Re-entrancy guard: one fold at a time, with a queued follow-up pass. */
			let folding = false;
			let refoldQueued = false;

			/** Subscribe to every session that descends from the bound one. */
			const trackChildren = () => {
				if (bound === void 0) return;
				const list = sessions.list?.getSnapshot?.();
				const rows = list === undefined ? [] : Object.values(list.byId ?? {});
				let grew = true;
				while (grew) {
					grew = false;
					for (const row of rows) {
						if (typeof row?.id !== "string" || row.id === bound.sessionId || childIds.has(row.id)) continue;
						if (row.parentId !== bound.sessionId && !childIds.has(row.parentId)) continue;
						if (row.origin !== void 0 && row.origin !== "subagent") continue;
						childIds.add(row.id);
						grew = true;
					}
				}
				for (const childId of childIds) {
					if (childSources.has(childId)) continue;
					const binding = sessions.binding(childId);
					if (binding === void 0) {
						// A descendant this page does not retain cannot be read; remembering it keeps every later pass from looking it up again.
						childSources.set(childId, { binding: void 0, detach: void 0 });
						continue;
					}
					const detach = binding.eventSource?.subscribe?.(readWindow);
					childSources.set(childId, { binding, detach: typeof detach === "function" ? detach : void 0 });
				}
			};

			/** Recompute what the answer's subagents billed and publish the merged totals. */
			const publishChildren = () => {
				const state = store.getSnapshot().guard;
				const usage = state.usage ?? emptyTurn();
				let child = emptyChild();
				if (state.startedAt > 0 && childSources.size > 0) {
					const to = state.endedAt > 0 ? state.endedAt : Number.POSITIVE_INFINITY;
					for (const source of childSources.values()) {
						const entries = source.binding?.eventSource?.getSnapshot?.()?.entries;
						if (!Array.isArray(entries)) continue;
						const folded = foldChildWindow(entries, state.startedAt, to, state.pricing, state.model);
						child = {
							sessions: child.sessions + 1,
							requests: child.requests + folded.requests,
							buckets: addBuckets(child.buckets, folded.buckets),
							parts: addParts(child.parts, folded.parts)
						};
					}
				}
				const childCost = child.parts.cacheMiss + child.parts.cacheHit + child.parts.output;
				if (child.sessions === usage.childSessions
					&& child.requests === usage.childRequests
					&& billedTokens(child.buckets) === usage.childTotal
					&& childCost === usage.childCost) {
					return;
				}
				// The request in flight is priced where it ran
				const inFlightAt = Number.isFinite(usage.promptAt) && usage.promptAt > 0 ? usage.promptAt : Date.now();
				store.patch({ guard: { ...state, usage: withTotals({ ...usage, child }, rateCardFor(state.pricing, state.model, inFlightAt)) } });
			};

			/** Clear the accounting and arm a fresh answer. */
			const startTurn = (turn, at) => {
				const current = store.getSnapshot().guard;
				// A re-fold of the same answer — every event re-reads the window from its
				// `turn/start` — must not undo what was already decided about it: whether it
				// was stopped, why, and the key that makes that stop final. Only a different
				// answer clears them.
				const sameAnswer = current.sessionId !== void 0 && current.turn === turn;
				store.patch({
					guard: {
						...current,
						turn,
						step: void 0,
						startedAt: at,
						endedAt: 0,
						tick: 0,
						running: true,
						stopped: sameAnswer && current.stopped === true,
						stoppedKey: sameAnswer ? current.stoppedKey : void 0,
						reason: sameAnswer ? current.reason : void 0,
						usage: { ...emptyTurn(), on: true }
					},
					notice: sameAnswer ? store.getSnapshot().notice : void 0
				});
			};

			/** Fold one accepted event into the running answer. */
			const accountEvent = (event) => {
				const state = store.getSnapshot().guard;
				if (event.type === "turn/start") {
					startTurn(event.data?.turn ?? state.turn, stamp(event));
					return;
				}
				if (event.type === "step/start") {
					// A request boundary inside the answer.
					if (state.turn !== void 0 && event.data?.turn !== state.turn) return;
					store.patch({
						guard: { ...store.getSnapshot().guard, step: event.data?.step, running: true }
					});
					return;
				}
				if (event.type === "turn/end") {
					if (state.running && event.data?.turn === state.turn) {
						const current = store.getSnapshot().guard;
						const at = stamp(event);
						store.patch({
							guard: {
								...current,
								running: false,
								endedAt: at,
								usage: { ...current.usage, on: false }
							}
						});
						// The answer is over: its totals become one line in the turn ledger.
						// Its subagents are folded in first, so the line carries everything the
						// answer cost — including what it spent through them.
						publishChildren();
						recordTurn(store, store.getSnapshot().guard, at);
					}
					return;
				}
				if (event.type === "llm/retry-started") {
					// A retried request bills again.
					const usage = state.usage;
					if (!usage.ack) return;
					const card = rateCardFor(state.pricing, state.model, stamp(event));
					store.patch({ guard: { ...state, usage: withTotals(settleAttempt(usage, card), card) } });
					return;
				}
				const usage = eventUsage(event);
				if (usage === void 0) return;
				if (state.turn !== void 0 && event.data?.turn !== state.turn) return;
				const current = store.getSnapshot().guard;
				const step = event.data?.step;
				// A sample older than the request already in flight is dropped: the answer only ever moves forward
				if (current.usage.ack && typeof step === "number" && typeof current.usage.step === "number" && step < current.usage.step) return;
				// The same step is the same request, even across a retry.
				const sameRequest = current.usage.step !== void 0 && current.usage.step === step;
				// A later sample of the same request replaces its own, so one request is billed once.
				if (sameRequest && bucketsEqual(current.usage.prompt, usage) && current.usage.ack) return;
				const card = rateCardFor(current.pricing, current.model, stamp(event));
				// A sample for a new request settles the one before it and counts this one
				const settled = sameRequest ? current.usage : settleAttempt(current.usage, card);
				store.patch({
					guard: {
						...current,
						usage: withTotals({
							...settled,
							ack: true,
							prompt: usage,
							// The in-flight request's own instant, so a later re-fold (a child notification, the end of the answer) prices it where it ran.
							promptAt: stamp(event),
							step,
							model: current.model,
							parentRequests: sameRequest ? current.usage.parentRequests : current.usage.parentRequests + 1
						}, card)
					}
				});
			};

			/** Fold the event window from its newest turn boundary. */
			const readWindow = () => {
				// A child window that notifies synchronously — during its own subscription
				if (folding) {
					refoldQueued = true;
					return;
				}
				folding = true;
				const snapshot = bound?.eventSource?.getSnapshot();
				if (snapshot !== undefined && snapshot !== lastWindow) {
					lastWindow = snapshot;
					const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
					let from = -1;
					for (let index = 0; index < entries.length; index += 1) {
						if (entries[index]?.event?.type === "turn/start") from = index;
					}
					// A window that carries no turn boundary yet still has live attempts, which the guard accounts from the running answer's own start.
					if (from < 0) from = 0;
					for (let index = from; index < entries.length; index += 1) {
						const event = entries[index]?.event;
						if (event !== undefined && typeof event.type === "string") accountEvent(event);
					}
					// Subagent spawns are announced in this window, so a fresh pass is also where new children are discovered.
					for (const entry of entries) {
						const event = entry?.event;
						if (event?.type !== "subagent/catalog") continue;
						const childId = event.data?.childId ?? event.data?.childSessionId;
						if (typeof childId === "string" && childId !== "") childIds.add(childId);
					}
				}
				// A child window that changes must refresh the answer's totals too.
				trackChildren();
				publishChildren();
				folding = false;
				if (refoldQueued) {
					refoldQueued = false;
					readWindow();
				}
			};

			/** Re-read the window from scratch after rewinding the active turn. */
			const rewind = () => {
				lastWindow = void 0;
				readWindow();
			};

			/** Attach to one session's event window, replacing any previous one. */
			const attach = (sessionId) => {
				detachEvents();
				detachEvents = () => { };
				// Another conversation's children must not contribute: drop every child subscription.
				for (const source of childSources.values()) source.detach?.();
				childSources.clear();
				childIds.clear();
				bound = sessionId === undefined ? void 0 : sessions.binding(sessionId);
				if (bound === void 0) {
					lastWindow = void 0;
					store.patch({
						guard: {
							...store.getSnapshot().guard,
							sessionId: void 0,
							running: false,
							turn: void 0,
							step: void 0,
							startedAt: 0,
							endedAt: 0,
							tick: 0,
							stoppedKey: void 0,
							usage: emptyTurn(),
							note: void 0
						}
					});
					return;
				}
				const events = bound.eventSource;
				if (events === undefined || typeof events.subscribe !== "function") {
					store.patch({ guard: { ...store.getSnapshot().guard, sessionId, note: "session-event-source-unavailable" } });
					return;
				}
				store.patch({ guard: { ...store.getSnapshot().guard, sessionId, note: void 0 } });
				detachEvents = events.subscribe(readWindow);
				rewind();
			};

			/** Choose which conversation to watch: the newest one whose own state says it is answering */
			const pickSession = () => {
				const list = sessions.list?.getSnapshot?.();
				const rows = list === undefined ? [] : Object.values(list.byId ?? {});
				const answering = rows.find((row) => sessions.binding(row.id)?.session?.running === true);
				if (answering !== undefined) return answering.id;
				const main = rows.find((row) => (row.retainedBy?.mainView ?? 0) > 0);
				if (main !== undefined) return main.id;
				return rows.find((row) => row.removed !== true)?.id;
			};

			/** Re-pick the watched conversation and re-read whichever window is bound. */
			const syncSession = () => {
				const next = pickSession();
				if (next === void 0) return;
				if (next !== store.getSnapshot().guard.sessionId || bound === void 0) attach(next);
				else rewind();
			};

			// One subscription on the session catalog plus one on the watched session's event window: no polling of either.
			const listSource = sessions.list;
			if (listSource !== void 0 && typeof listSource.subscribe === "function") {
				detachList = listSource.subscribe(syncSession);
			}
			syncSession();

			return () => {
				detachList();
				detachEvents();
				for (const source of childSources.values()) source.detach?.();
				childSources.clear();
			};
		}

		/** Run the three ceilings against the answer being given and stop it when one is crossed. */
		function installGuard(ctx, scope, store, sessions) {
			let lastInterrupt = 0;
			let inFlight = false;
			// The answer the backoff clock belongs to, as `sessionId:turn`.
			let lastTurnKey;

			/** The answer now being measured, keyed so two sessions' turn 1 stay distinct. */
			const turnKeyOf = (guard) => (guard.sessionId === void 0 || guard.turn === void 0
				? void 0
				: `${guard.sessionId}:${String(guard.turn)}`);

			/** The ceiling that the current answer currently crosses, if any. */
			const breached = (guard, limits, now) => {
				if (!limits.enabled || !guard.running || guard.sessionId === void 0) return void 0;
				// A turn already stopped is never stopped again — matched by session and turn,
				// because turn numbers restart at 1 in every conversation.
				const key = turnKeyOf(guard);
				if (key !== void 0 && key === guard.stoppedKey) return void 0;
				// A conversation can stop being live while its accounting stays; only a session the service still binds may be cancelled.
				if (sessions.binding(guard.sessionId) === void 0) return void 0;
				if (guard.usage.total >= limits.tokens) {
					return { kind: "tokens", limit: limits.tokens, actual: guard.usage.total };
				}
				if (guard.usage.cost >= limits.cost) {
					return { kind: "cost", limit: limits.cost, actual: guard.usage.cost };
				}
				const elapsed = elapsedSeconds(guard, now);
				if (elapsed >= limits.seconds) return { kind: "seconds", limit: limits.seconds, actual: elapsed };
				return void 0;
			};

			/** Compose the follow-up prompt that explains one interruption. */
			const explanationPrompt = (copy, budget, breach) => {
				const label = breach.kind === "tokens" ? copy.guardTokens : breach.kind === "cost" ? copy.guardCost : copy.guardSeconds;
				const actual = breach.kind === "cost" ? breach.actual.toFixed(4) : String(Math.round(breach.actual));
				const limit = breach.kind === "cost" ? String(breach.limit) : String(Math.round(breach.limit));
				const target = Math.max(1, Math.round(Math.min(EXPLANATION_TARGET_TOKENS, budget)));
				return copy.replyPrompt
					.replace("{kind}", label)
					.replace("{actual}", actual)
					.replace("{limit}", limit)
					.replace("{target}", String(target));
			};

			/** Cancel one answer and queue its explanation. */
			const interrupt = async (guard, breach) => {
				const copy = copyFor(ctx.locale.getSnapshot().active);
				const label = breach.kind === "tokens" ? copy.guardTokens : breach.kind === "cost" ? copy.guardCost : copy.guardSeconds;
				// The answering request inherits the current token ceiling, which caps the reply target the prompt states.
				const budget = store.getSnapshot().limits.tokens;
				const interrupted = guard.turn;
				const key = turnKeyOf(guard);
				let accepted = false;
				try {
					const result = await ctx.remote.session.cancel({ sessionId: guard.sessionId });
					accepted = result?.ok === true;
				} catch {
					accepted = false;
				}
				// Another turn began while the cancel was in flight: that answer owns the panel now
				if (store.getSnapshot().guard.turn !== interrupted) return;
				const state = store.getSnapshot().guard;
				store.patch({
					guard: {
						...state,
						running: !accepted && state.running,
						stopped: accepted,
						// A refused cancel is retried after the backoff, so this turn stays
						// eligible; an accepted one is remembered and never repeated.
						stoppedKey: accepted ? key : state.stoppedKey,
						stoppedTurn: accepted ? interrupted : state.stoppedTurn,
						reason: { kind: breach.kind, limit: breach.limit, actual: breach.actual, at: Date.now(), accepted }
					},
					notice: { kind: breach.kind, label, accepted, at: Date.now() }
				});
				if (!accepted) return;
				const binding = sessions.binding(guard.sessionId);
				if (binding === void 0) return;
				try {
					await binding.session.prompt(
						[{ type: "text", text: explanationPrompt(copy, budget, breach) }],
						"queue"
					);
				} catch {
					// a refused explanation leaves the user with the panel notice
				}
			};

			const check = () => {
				const state = store.getSnapshot();
				const now = Date.now();
				// The request's time is read from the clock.
				if (state.guard.running && state.guard.startedAt > 0 && state.guard.endedAt === 0) {
					const whole = Math.floor(elapsedSeconds(state.guard, now));
					if (whole !== state.guard.tick) {
						store.patch({ guard: { ...store.getSnapshot().guard, tick: whole } });
					}
				}
				if (inFlight) return;
				// The backoff clock belongs to one answer: a new answer starts it over.
				const key = turnKeyOf(state.guard);
				if (key !== void 0 && key !== lastTurnKey) {
					lastTurnKey = key;
					lastInterrupt = 0;
				}
				const breach = breached(state.guard, state.limits, now);
				if (now - lastInterrupt < GUARD_BACKOFF_MS) return;
				if (breach === void 0) return;
				lastInterrupt = now;
				inFlight = true;
				void interrupt(state.guard, breach).finally(() => {
					inFlight = false;
				});
			};

			const ticker = setInterval(check, GUARD_TICK_MS);
			scope.effect(() => () => {
				clearInterval(ticker);
			}, "usage-balance: budget guard ticker");

			/** Stop the running answer on demand, using the same seam as the automatic guard. */
			const stop = async () => {
				const state = store.getSnapshot();
				const guardState = state.guard;
				const sessionId = guardState.sessionId;
				if (sessionId === void 0 || !guardState.running) return;
				const stoppedTurn = guardState.turn;
				let accepted = false;
				try {
					const result = await ctx.remote.session.cancel({ sessionId });
					accepted = result?.ok === true;
				} catch {
					accepted = false;
				}
				// The same guard as the automatic path: a newer turn owns the panel by now.
				if (!accepted || store.getSnapshot().guard.turn !== stoppedTurn) return;
				const current = store.getSnapshot().guard;
				store.patch({
					guard: {
						...current,
						running: false,
						stopped: true,
						// A manual stop is not a ceiling breach: no notice and no reason are claimed
						stoppedTurn,
						stoppedKey: `${sessionId}:${String(stoppedTurn)}`,
						reason: void 0
					},
					notice: void 0
				});
			};

			return { check, stop };
		}

		/** Sanitize one typed ceiling into the digits its unit accepts. */
		function sanitizeLimitText(raw, allowFraction) {
			const text = String(raw).replace(/[^0-9.]/gu, "");
			if (!allowFraction) return text.replace(/\./gu, "").slice(0, 9);
			const first = text.indexOf(".");
			if (first < 0) return text.slice(0, 9);
			return `${text.slice(0, first + 1)}${text.slice(first + 1).replace(/\./gu, "")}`.slice(0, 10);
		}

		/** Whether one ceiling's field accepts fractional values. */
		function limitAllowsFraction(kind) {
			return kind === "cost" || kind === "tokens";
		}

		/** Tokens in one 万 (ten-thousand). */
		const TOKENS_PER_WAN = 1e4;

		/** Format a token count for the token row's own readout. */
		function formatWan(tokens, copy) {
			const wan = tokens / TOKENS_PER_WAN;
			const rounded = Math.round(wan * 100) / 100;
			return copy.tokensValue.replace("{value}", String(rounded));
		}

		/** The token ceiling as the field shows it: in 万, so the shipped default reads `1` rather than `10000`. */
		function tokensToField(tokens) {
			return String(Math.round((tokens / TOKENS_PER_WAN) * 1e6) / 1e6);
		}

		/** A committed token field back in tokens. */
		function fieldToTokens(text) {
			return Math.round(Number(text) * TOKENS_PER_WAN);
		}

		/** One guard row: what the ceiling is, how much of it the running answer used, the editable ceiling itself, and its unit. */
		function GuardRow(props) {
			const percent = Math.max(0, Math.min(100, Math.round(props.ratio * 100)));
			const locked = props.locked;
			const field = props.field;
			// The accepted range, stated on the control itself: the bounds are advisory attributes here
			const range = props.min === void 0 || props.max === void 0
				? props.fieldLabel
				: `${props.fieldLabel} · ${String(props.min)}–${String(props.max)} ${props.unit}`;
			return jsxs("div", {
				className: "dsh-balance-guard",
				"data-state": props.state,
				"data-locked": locked ? "true" : "false",
				children: [
					jsx("span", { className: "dsh-balance-guard-label", children: props.label }),
					jsx("span", { className: "dsh-balance-guard-now", children: props.now }),
					jsx("span", {
						className: "dsh-balance-guard-meter",
						children: jsx("span", { className: "dsh-balance-guard-fill", style: { width: `${String(percent)}%` } })
					}),
					jsx("input", {
						className: "dsh-balance-limit",
						type: "text",
						inputMode: limitAllowsFraction(props.kind) ? "decimal" : "numeric",
						autoComplete: "off",
						spellCheck: false,
						readOnly: locked,
						"data-locked": locked ? "true" : "false",
						// The bounds are advisory only: this is a text box, so the value is clamped by the commit handler rather than by the browser.
						"aria-valuemin": String(props.min),
						"aria-valuemax": String(props.max),
						value: field,
						"aria-label": props.fieldLabel,
						title: locked ? `${range} · ${props.lockHint}` : range,
						onChange: (event) => { props.onEdit(event.target.value); },
						onBlur: () => { props.onCommit(); },
						onKeyDown: (event) => {
							if (event.key === "Enter") {
								props.onCommit();
								event.currentTarget.blur();
							}
						}
					}),
					jsx("span", { className: "dsh-balance-limit-unit", children: props.unit })
				]
			});
		}

		/** The text one ceiling's field shows: the in-progress edit when there is one */
		function limitFieldText(props, kind) {
			const draft = props.limits.draft?.[kind];
			if (typeof draft === "string") return draft;
			return kind === "tokens" ? tokensToField(props.limits.tokens) : String(props.limits[kind]);
		}

		/** The unit label one ceiling's field shows. */
		function limitUnit(copy, kind) {
			return kind === "tokens" ? copy.unitTokens : kind === "cost" ? copy.unitCost : copy.unitSeconds;
		}

		/** Build the guard block's rows: enable switch */
		function guardBlock(props) {
			const t = props.copy;
			const guard = props.guard;
			const limits = props.limits;
			const usage = guard.usage ?? emptyTurn();
			// Every row measures the same window: the answer being given.
			const elapsed = elapsedSeconds(guard, Date.now());
			const used = { tokens: usage.total, cost: usage.cost, seconds: elapsed };
			// A running answer freezes every ceiling: the limit it is being measured against must not move while it runs.
			const locked = guard.running === true;
			// While an answer runs its time keeps moving
			const stateOf = (kind) => {
				const limit = limits[kind] ?? 0;
				if (limit <= 0) return "off";
				if (used[kind] >= limit) return "over";
				return used[kind] >= limit * 0.8 ? "warn" : "ok";
			};
			const status = guard.sessionId === void 0
				? t.noSession
				: guard.running ? t.guardRunning : t.guardIdle;
			// Two independent facts decide how the panel reports itself: whether an answer is running
			const stopRequested = guard.stopped === true && guard.running !== true;
			const statusText = guard.running
				? status
				: guard.stopped === true ? t.stopped : status;
			const notice = props.notice;
			// The ledger is about the answer that just ended
			const ledger = props.ledger;
			const ledgerText = ledger === void 0
				? void 0
				: ledger.state === "written" ? t.ledgerWritten
					: ledger.state === "sending" ? t.ledgerSending : t.ledgerFailed;
			/** One ceiling row, built from the shared field state. */
			const row = (kind, label, now, min, max) => jsx(GuardRow, {
				kind,
				label,
				fieldLabel: kind === "tokens" ? t.limitTokens : kind === "cost" ? t.limitCost : t.limitSeconds,
				lockHint: t.lockHint,
				locked,
				now,
				unit: limitUnit(t, kind),
				ratio: limits[kind] > 0 ? used[kind] / limits[kind] : 0,
				state: stateOf(kind),
				min,
				max,
				field: limitFieldText(props, kind),
				onEdit: (value) => { props.onEdit(kind, value); },
				onCommit: () => { props.onCommit(kind); }
			}, `guard-${kind}`);
			return [
				jsxs("div", {
					className: "dsh-balance-guard-head",
					children: [
						jsx("input", {
							className: "dsh-balance-checkbox",
							type: "checkbox",
							checked: limits.enabled,
							disabled: locked,
							title: locked ? `${t.toggleGuards} · ${t.lockHint}` : t.toggleGuards,
							"aria-label": t.toggleGuards,
							onChange: (event) => { props.onEnabled(event.target.checked); }
						}),
						jsx("span", { children: t.guards }),
						jsx("span", {
							className: guard.stopped ? "dsh-balance-error" : "dsh-balance-value",
							children: statusText
						}),
						jsx("button", {
							type: "button",
							className: "dsh-balance-stop",
							// The control offers the action while an answer runs
							title: stopRequested ? t.stopped : t.stopHint,
							"aria-label": stopRequested ? t.stopped : t.stopHint,
							disabled: guard.sessionId === void 0 || !guard.running,
							onClick: () => { void props.onStop(); },
							children: `■ ${stopRequested ? t.stopped : t.stopNow}`
						})
					]
				}),
				row("tokens", t.guardTokens, formatWan(used.tokens, t), MIN_TOKENS_FIELD, MAX_TOKENS_FIELD),
				row("cost", t.guardCost, currencySymbol(props.currency) + formatAmount(used.cost), MIN_LIMIT.cost, MAX_LIMIT.cost),
				row("seconds", t.guardSeconds, `${String(Math.round(used.seconds))}s`, MIN_LIMIT.seconds, MAX_LIMIT.seconds),
				// What the three rows add up to: one answer
				jsx("div", {
					className: "dsh-balance-turn",
					title: ledger?.path ?? void 0,
					children: [
						t.answerRequests.replace("{count}", String(usage.requests)),
						usage.childSessions === 0
							? ""
							: t.subagents
								.replace("{sessions}", String(usage.childSessions))
								.replace("{requests}", String(usage.childRequests)),
						ledgerText === void 0 ? "" : ` · ${ledgerText}`
					].join("")
				}, "guard-turn"),
				locked
					? jsx("div", { className: "dsh-balance-lock", children: `🔒 ${t.lockHint}` }, "guard-lock")
					: null,
				notice === void 0
					? null
					: jsx("div", {
						className: "dsh-balance-alert",
						title: guard.reason === void 0
							? void 0
							: `${guard.reason.kind} ${String(guard.reason.actual)} / ${String(guard.reason.limit)}`,
						children: notice.accepted
							? `${t.interrupted}：${notice.label}`
							: `${t.interrupted}（${t.failed}）：${notice.label}`
					}, "guard-notice"),
				jsx("div", { className: "dsh-balance-note", children: `${t.budgetNote} · ${props.pricingSource}` }, "guard-note")
			];
		}

		/** The visible panel; reads the store and grows up/left from its anchor. */
		function UsageBalancePanel(props) {
			const state = react.useSyncExternalStore(
				props.balanceStore.subscribe,
				props.balanceStore.getSnapshot
			);
			const [metric, setMetric] = react.useState("tokens");
			const t = props.copy;
			const usage = state.usage;
			const series = Array.isArray(usage?.series) && usage.series.length > 0
				? usage.series
				: Array.from({ length: 31 }, (unused, index) => ({ date: String(index + 1), tokens: 0, requests: 0 }));
			const peak = series.reduce((max, row) => Math.max(max, metric === "tokens" ? row.tokens : row.requests), 0);
			const scroll = series.length > MAX_BARS_WITHOUT_SCROLL;
			const today = String(new Date().getDate());
			const balanceText = formatWallets(state.wallets);
			const bonusText = formatWallets(state.bonuses);
			const failed = state.balance === "failed";
			const errorText = state.usageError ?? state.accountError;

			let balanceValue;
			if (!state.signedIn) balanceValue = t.signedOut;
			else if (failed) balanceValue = t.failed;
			else if (balanceText === void 0) balanceValue = t.loading;
			else balanceValue = balanceText;

			const entry = (label, value, className) => jsxs("span", {
				className: "dsh-balance-entry",
				children: [
					jsx("span", { className: "dsh-balance-label", children: label }),
					jsx("span", { className: className ?? "dsh-balance-value", children: value })
				]
			});

			return jsxs("div", {
				className: "dsh-balance-panel",
				"data-state": errorText !== void 0 ? "error" : "ready",
				role: "status",
				title: t.title,
				children: [
					jsxs("div", {
						className: "dsh-balance-row",
						children: [
							entry(t.balance, balanceValue),
							entry(
								t.cost,
								usage === void 0 ? t.loading : currencySymbol(usage.currency) + formatAmount(usage.cost),
								"dsh-balance-cost"
							),
							entry(t.requests, usage === void 0 ? t.loading : formatCount(usage.requests)),
							jsxs("span", {
								className: "dsh-balance-entry",
								title: usage === void 0
									? t.loading
									: `↑${formatCount(usage.input)}  ↓${formatCount(usage.output)}`,
								children: [
									jsx("span", { className: "dsh-balance-label", children: t.tokens }),
									jsx("span", {
										className: "dsh-balance-value",
										children: usage === void 0 ? t.loading : formatCount(usage.tokens)
									})
								]
							}),
							jsx("button", {
								type: "button",
								className: "dsh-balance-button",
								"data-spinning": state.refreshing ? "true" : "false",
								title: t.refresh,
								"aria-label": t.refresh,
								onClick: () => {
									void props.refresh();
								},
								children: "⟳"
							})
						]
					}),
					jsxs("div", {
						className: "dsh-balance-guards",
						"data-off": state.limits.enabled ? "false" : "true",
						children: guardBlock({
							guard: state.guard,
							limits: state.limits,
							notice: state.notice,
							ledger: state.ledger,
							copy: t,
							currency: state.pricing?.currency ?? "CNY",
							pricingSource: state.pricingSource,
							onEdit: props.editLimit,
							onCommit: props.commitLimit,
							onEnabled: props.setEnabled,
							onStop: props.stop
						})
					}),
					jsxs("div", {
						className: "dsh-balance-row",
						style: { justifyContent: "flex-end" },
						children: [
							jsxs("span", {
								className: "dsh-balance-toggle",
								children: [
									jsx("button", {
										type: "button",
										"data-active": metric === "tokens" ? "true" : "false",
										onClick: () => { setMetric("tokens"); },
										children: t.tokensOption
									}),
									jsx("button", {
										type: "button",
										"data-active": metric === "requests" ? "true" : "false",
										onClick: () => { setMetric("requests"); },
										children: t.requestsOption
									})
								]
							})
						]
					}),
					jsx("div", {
						className: "dsh-balance-chart",
						"data-scroll": scroll ? "true" : "false",
						children: usage === void 0
							? jsx("span", { className: "dsh-balance-chart-empty", children: t.emptyChart })
							: series.map((row) => {
								const value = metric === "tokens" ? row.tokens : row.requests;
								const ratio = peak > 0 ? value / peak : 0;
								return jsx("div", {
									className: "dsh-balance-bar",
									"data-empty": value === 0 ? "true" : "false",
									"data-today": dayOfMonth(row.date) === today ? "true" : "false",
									style: { height: `${String(Math.max(2, Math.round(ratio * 60)))}px` },
									title: `${dayOfMonth(row.date) || row.date} · ${formatCount(row.tokens)} tokens · ${formatCount(row.requests)} requests`
								}, row.date);
							})
					}),
					scroll
						? jsx("div", {
							className: "dsh-balance-axis",
							"data-scroll": "true",
							children: series.map((row, index) => jsx("span", {
								className: "dsh-balance-tick",
								children: index % 5 === 0 ? dayOfMonth(row.date) : ""
							}, `tick-${row.date}`))
						})
						: null,
					jsxs("div", {
						className: "dsh-balance-foot",
						children: [
							jsx("span", { children: `${t.updated} ${formatClock(state.updatedAt)}` }),
							bonusText === void 0 ? null : jsx("span", { children: `${t.bonus} ${bonusText}` }),
							errorText === void 0
								? null
								: jsx("span", { className: "dsh-balance-error", title: errorText, children: t.error })
						]
					})
				]
			});
		}

		/** Read the last price table this page stored, when it is still fresh. */
		function cachedPricing() {
			const stored = readStored(PRICING_CACHE_KEY);
			if (stored === null || typeof stored !== "object") return void 0;
			if (!Number.isFinite(stored.at) || Date.now() - stored.at >= PRICING_TTL_MS) return void 0;
			return stored.table;
		}

		/** Read the price table the host half folded from DeepSeek's published list. */
		async function fetchPricing() {
			const bridge = globalThis.__DSH_USAGE_BALANCE__;
			const route = typeof bridge?.pricingEndpoint === "string" ? bridge.pricingEndpoint : void 0;
			if (route !== void 0) {
				try {
					const response = await fetch(route, { headers: { accept: "application/json" } });
					const payload = await response.json();
					if (payload?.ok === true && payload.value?.models !== void 0) {
						writeStored(PRICING_CACHE_KEY, { at: Date.now(), table: payload.value });
						return { table: payload.value, source: "published" };
					}
				} catch {
					// the cached or built-in table below still prices the guard
				}
			}
			const cached = cachedPricing();
			if (cached !== void 0) return { table: cached, source: "offline" };
			return { table: FALLBACK_PRICING, source: "built-in" };
		}

		/** Client plugin body: own the panel store, start the refresh loops */
		function apply(ctx) {
			ensureStyles();
			const store = createStore({
				signedIn: false,
				balance: "loading",
				wallets: void 0,
				bonuses: void 0,
				accountError: void 0,
				usage: void 0,
				usageError: void 0,
				refreshing: false,
				updatedAt: 0,
				// Guard state: limits (persisted), the active session, the answer being accounted, and the notice left by the last interruption.
				limits: normalizeLimits(readStored(LIMITS_KEY)),
				guard: {
					sessionId: void 0,
					turn: void 0,
					// The answer being accounted: the request it is on
					step: void 0,
					startedAt: 0,
					endedAt: 0,
					tick: 0,
					running: false,
					usage: emptyTurn(),
					// The answer already interrupted, so it is never stopped twice: keyed by
					// session and turn, because turn numbers restart at 1 in every conversation.
					stoppedTurn: void 0,
					stoppedKey: void 0,
					// The price table the accounting prices with, kept here so a new answer inherits it instead of losing it between turns.
					pricing: cachedPricing() ?? FALLBACK_PRICING,
					model: void 0
				},
				notice: void 0,
				// The last answer handed to the turn ledger on disk, and how that went.
				ledger: void 0,
				pricing: cachedPricing() ?? FALLBACK_PRICING,
				pricingSource: "built-in"
			});
			const refresh = createRefresh(ctx, store);

			ctx.effect(() => {
				void refresh();
				const timer = setInterval(() => {
					void refresh();
				}, REFRESH_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, "usage-balance: refresh loop");

			// Prices refresh on the account cadence: the page asks the host route every minute.
			ctx.effect(() => {
				let active = true;
				const pull = () => {
					void fetchPricing().then(({ table, source }) => {
						if (!active) return;
						// The panel reads `pricing`, the accounting reads `guard.pricing`.
						store.patch({ pricing: table, pricingSource: source, guard: { ...store.getSnapshot().guard, pricing: table } });
					});
				};
				pull();
				const timer = setInterval(pull, REFRESH_INTERVAL_MS);
				return () => {
					active = false;
					clearInterval(timer);
				};
			}, "usage-balance: pricing loop");

			/** The ceiling a sanitized field text commits to. */
			const commitValue = (kind, text, fallback) => {
				const numeric = Number(text);
				if (text === "" || !Number.isFinite(numeric)) return fallback;
				const value = kind === "tokens" ? fieldToTokens(text) : numeric;
				// Both ends of the field's range apply to what is typed, exactly as they apply to what was stored.
				return clampLimit(value, MIN_LIMIT[kind], MAX_LIMIT[kind], fallback);
			};

			/** Publish one field edit. */
			const editLimit = (kind, value) => {
				const limits = store.getSnapshot().limits;
				// A running answer owns the ceilings it is measured against.
				if (store.getSnapshot().guard.running) return;
				const text = sanitizeLimitText(value, limitAllowsFraction(kind));
				const next = normalizeLimits({ ...limits, draft: { ...limits.draft, [kind]: text } });
				store.patch({ limits: next });
			};

			/** Commit one field edit: clamp it, drop the draft, and persist. */
			const commitLimit = (kind) => {
				const limits = store.getSnapshot().limits;
				const text = limits.draft?.[kind];
				const draft = { ...limits.draft };
				delete draft[kind];
				const next = normalizeLimits({
					...limits,
					[kind]: text === void 0 ? limits[kind] : commitValue(kind, text, limits[kind]),
					draft
				});
				store.patch({ limits: next });
				writeStored(LIMITS_KEY, next);
			};

			/** Turn the guards on or off, persisting the choice. */
			const setEnabled = (enabled) => {
				// The switch changes the same verdict the fields do, so it locks with them.
				if (store.getSnapshot().guard.running) return;
				const next = normalizeLimits({ ...store.getSnapshot().limits, enabled });
				store.patch({ limits: next });
				writeStored(LIMITS_KEY, next);
			};

			// The guards need the client session service
			let stopGuard = () => { };
			let stopFollowing = () => { };
			let stop = async () => { };
			ctx.inject(["sessions"], (scope) => {
				const sessions = scope.sessions ?? ctx.sessions;
				if (sessions === void 0) return;
				stopFollowing = followGuards(store, sessions);
				const guard = installGuard(ctx, scope, store, sessions);
				stop = guard.stop;
				stopGuard = () => {
					stopFollowing();
				};
				scope.effect(() => () => {
					stopFollowing();
				}, "usage-balance: guard follow");
			});

			// One live instance per page: a hot replacement (HMR) mounts a new bundle while an older instance may still be mounted
			const previous = globalThis.__DSH_USAGE_BALANCE_PANEL__;
			if (previous !== void 0) {
				try {
					previous.root.unmount();
				} catch {
					// a root already torn down by React needs no second unmount
				}
				previous.host.remove();
				globalThis.__DSH_USAGE_BALANCE_PANEL__ = void 0;
			}

			// The host is created detached; `watchConversation` attaches it inside the conversation pane (retrying until the pane exists)
			const host = document.createElement("div");
			host.id = ROOT_ID;
			const stopWatchingConversation = watchConversation(host);
			const root = reactDomClient.createRoot(host);
			globalThis.__DSH_USAGE_BALANCE_PANEL__ = { host, root };
			const render = () => {
				root.render(react.createElement(UsageBalancePanel, {
					copy: copyFor(ctx.locale.getSnapshot().active),
					balanceStore: store,
					refresh,
					editLimit,
					commitLimit,
					setEnabled,
					stop
				}));
			};
			render();
			// Panel copy follows the active locale, so a language change re-renders.
			ctx.effect(() => {
				const locale = ctx.locale;
				return typeof locale?.subscribe === "function"
					? locale.subscribe(render)
					: void 0;
			}, "usage-balance: panel locale");

			ctx.effect(() => () => {
				stopGuard();
				stopFollowing();
				stopWatchingConversation();
				root.unmount();
				host.remove();
				if (globalThis.__DSH_USAGE_BALANCE_PANEL__?.root === root) globalThis.__DSH_USAGE_BALANCE_PANEL__ = void 0;
			}, "usage-balance: mount lifetime");
		}

		exports.UsageBalancePanel = UsageBalancePanel;
		exports.followGuards = followGuards;
		exports.installGuard = installGuard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
