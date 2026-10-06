/**
 * Usage/balance panel — host half.
 *
 * Reads the stored platform account grant, queries Platform's monthly usage, reads and
 * caches the published price list, serves three loopback JSON routes (usage / pricing /
 * turn ledger), and appends one line per finished answer to `log/turns.jsonl`.
 *
 * Cautions:
 * - The grant is read from `.credentials.yaml` per request and never leaves this half:
 *   route responses, the injected bridge, and both data files carry no credential.
 * - All three routes admit loopback same-origin callers only.
 * - Ledger bodies come from the page, so every field is re-read, bounded, and rebuilt.
 * - Prices: the Chinese page is read first and its yuan amounts are used as they stand;
 *   the English page is a fallback whose dollars are converted, which is approximate.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ───────────────────────────── configuration ───────────────────────────── */

/** Page global carrying this plugin's route paths. */
const BRIDGE_GLOBAL = "__DSH_USAGE_BALANCE__";
/** Loopback route serving the folded usage JSON. */
const ROUTE_PATH = "/usage-balance/summary";
/** Loopback route serving the daily model price table. */
const PRICING_ROUTE_PATH = "/usage-balance/pricing";
/** Loopback route accepting one finished answer for the turn ledger. */
const TURN_ROUTE_PATH = "/usage-balance/turn";
/** Largest ledger body accepted from the page, in bytes. */
const LEDGER_MAX_BYTES = 16384;
/** Distinct answers kept in memory to refuse a repeated write. */
const LEDGER_MEMORY = 512;
/** Panel stacking layer the page half uses when it reads no injected layer. */
const CLIENT_LAYER = 1200;
/** Platform origin used when the stored grant carries no issuer. */
const DEFAULT_ORIGIN = "https://platform.deepseek.com";
/** Plan/top-up grants live under this credential record key. */
const CREDENTIAL_KEY = "deepseek-account-platform/default";
/** Request budget for one Platform read. */
const REQUEST_TIMEOUT_MS = 15000;
/** Reuse window for a cached read, so overlapping callers cannot hammer Platform. */
const CACHE_TTL_MS = 50000;

/* ──────────────────────────────── grant ──────────────────────────────── */

/** Locate the Harness home holding the credential store. */
function harnessHome() {
	return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

/** Extract the account grant from a credentials document. Only the platform record is read. */
function parseGrant(raw) {
	if (typeof raw !== "string") return void 0;
	// One record block: from its key to the next top-level record key.
	const record = new RegExp(`${CREDENTIAL_KEY.replace("/", "\\/")}:[\\s\\S]*?(?=\\n {2}\\S|$)`, "u").exec(raw)?.[0];
	if (record === void 0) return void 0;
	const token = /token:\s*(\S+)/u.exec(record)?.[1];
	if (token === undefined) return void 0;
	const origin = /issuer:\s*(\S+)/u.exec(record)?.[1] ?? DEFAULT_ORIGIN;
	if (!/^https?:\/\//u.test(origin)) return void 0;
	return { token, origin };
}

/** Read this account grant from the credential store. */
function readGrant() {
	let raw;
	try {
		raw = readFileSync(join(harnessHome(), ".credentials.yaml"), "utf8");
	} catch {
		return void 0;
	}
	return parseGrant(raw);
}

/* ─────────────────────────────── platform ─────────────────────────────── */

/** The five client identity headers the Platform account API expects. */
function identityHeaders(metadata) {
	const locale = typeof metadata?.locale === "string" && metadata.locale !== "" ? metadata.locale : "zh_CN";
	const offset = typeof metadata?.timezoneOffsetSeconds === "number"
		? metadata.timezoneOffsetSeconds
		: -new Date().getTimezoneOffset() * 60;
	return {
		"x-client-platform": "web",
		"x-client-version": "0.2.0-rc.2",
		"x-client-bundle-id": "",
		"x-client-locale": locale.toLowerCase().startsWith("zh") ? "zh_CN" : "en_US",
		"x-client-timezone-offset": String(offset)
	};
}

/** Perform one authenticated Platform GET. The token goes only to the stored issuer. */
async function platformGet(url, headers) {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`platform responded ${String(response.status)}`);
	const payload = await response.json();
	if (payload?.code !== 0) throw new Error(`platform code ${String(payload?.code)}: ${String(payload?.msg ?? "")}`);
	const data = payload?.data?.biz_data;
	if (data === null || data === void 0) throw new Error("platform payload carries no data");
	return data;
}

/** Sum Platform model rows into one amount per usage type. */
function sumUsageTypes(rows) {
	const totals = {};
	for (const row of Array.isArray(rows) ? rows : []) {
		for (const entry of Array.isArray(row?.usage) ? row.usage : []) {
			const type = typeof entry?.type === "string" ? entry.type : void 0;
			const amount = Number(entry?.amount);
			if (type === void 0 || !Number.isFinite(amount)) continue;
			totals[type] = (totals[type] ?? 0) + amount;
		}
	}
	return totals;
}

/** Tokens a summed type map accounts for: prompt-side buckets plus response. */
function tokenCount(totals) {
	return (totals.PROMPT_TOKEN ?? 0)
		+ (totals.PROMPT_CACHE_HIT_TOKEN ?? 0)
		+ (totals.PROMPT_CACHE_MISS_TOKEN ?? 0)
		+ (totals.RESPONSE_TOKEN ?? 0);
}

/** Money a summed type map accounts for: every bucket is billed. */
function costAmount(totals) {
	return (totals.PROMPT_TOKEN ?? 0)
		+ (totals.PROMPT_CACHE_HIT_TOKEN ?? 0)
		+ (totals.PROMPT_CACHE_MISS_TOKEN ?? 0)
		+ (totals.RESPONSE_TOKEN ?? 0);
}

/** Fold the monthly Platform payloads into the panel's figures. */
function foldMonthlyUsage(amountData, costData, month, year) {
	const amountRoot = Array.isArray(amountData) ? amountData[0] : amountData;
	const costRoot = Array.isArray(costData) ? costData[0] : costData;
	const amountTotals = sumUsageTypes(amountRoot?.total);
	const costTotals = sumUsageTypes(costRoot?.total);
	const series = [];
	for (const day of Array.isArray(amountRoot?.days) ? amountRoot.days : []) {
		const totals = sumUsageTypes(day?.data);
		series.push({
			date: typeof day?.date === "string" ? day.date : "",
			tokens: Math.round(tokenCount(totals)),
			requests: Math.round(totals.REQUEST ?? 0)
		});
	}
	return {
		month,
		year,
		currency: "CNY",
		requests: Math.round(amountTotals.REQUEST ?? 0),
		tokens: Math.round(tokenCount(amountTotals)),
		// Named "input"/"output" rather than prompt/cache wording so the response body carries no field whose name could be mistaken for cre
		input: Math.round((amountTotals.PROMPT_TOKEN ?? 0)
			+ (amountTotals.PROMPT_CACHE_HIT_TOKEN ?? 0)
			+ (amountTotals.PROMPT_CACHE_MISS_TOKEN ?? 0)),
		output: Math.round(amountTotals.RESPONSE_TOKEN ?? 0),
		cost: costAmount(costTotals),
		series
	};
}

/** Read this month's Platform usage for the signed-in account. */
async function readUsage(metadata) {
	const grant = readGrant();
	if (grant === void 0) throw new Error("no stored platform account grant");
	const now = new Date();
	const month = now.getMonth() + 1;
	const year = now.getFullYear();
	const headers = {
		"x-dsh-auth-token": grant.token,
		accept: "application/json",
		...identityHeaders(metadata)
	};
	const [amountData, costData] = await Promise.all([
		platformGet(`${grant.origin}/api/v0/usage/amount?month=${String(month)}&year=${String(year)}`, headers),
		platformGet(`${grant.origin}/api/v0/usage/cost?month=${String(month)}&year=${String(year)}`, headers)
	]);
	return foldMonthlyUsage(amountData, costData, month, year);
}

/* ─────────────────────────────── pricing ─────────────────────────────── */

/** DeepSeek's published price lists, in the order they are read. */
const PRICING_SOURCES = [
	{ url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", locale: "zh" },
	{ url: "https://api-docs.deepseek.com/quick_start/pricing", locale: "en" }
];
/** The page the price route reports as its source when a read never succeeded. */
const PRICING_DOC_URL = PRICING_SOURCES[0].url;
/** How long one successful price read is reused. */
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
/** Request budget for the price read. */
const PRICING_TIMEOUT_MS = 15000;
/** Smallest plausible per-million-token price, in whichever denomination the cell writes. */
const MIN_PLAUSIBLE_PRICE = 0.0005;
/** USD→CNY rate, used only when the English page is the source (approximate). */
const USD_CNY = 7.1;
/** Model columns this plugin can price, in the order the published table lists them. */
const PRICING_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

/** Build one model's rate card from **peak** amounts in CNY per million tokens. */
function rateCard(hitPeak, missPeak, outputPeak) {
	const round = (value) => Math.round(value * 1e6) / 1e6;
	return {
		peak: { cacheHit: round(hitPeak), cacheMiss: round(missPeak), output: round(outputPeak) },
		// Off-peak is half of peak in the published table; the page recomputes the window itself, so both halves travel.
		offPeak: { cacheHit: round(hitPeak / 2), cacheMiss: round(missPeak / 2), output: round(outputPeak / 2) }
	};
}

/** The built-in table: official yuan peak prices per million tokens (off-peak is half). */
const DEFAULT_PRICING = {
	currency: "CNY",
	models: {
		"deepseek-flash": rateCard(0.04, 2, 8),
		"deepseek-v4-pro": rateCard(0.3, 9, 27)
	},
	source: "built-in"
};

/** Strip markup from one documentation fragment and collapse its whitespace. */
function textOf(fragment) {
	return fragment.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Cut one HTML document into its row fragments, tolerating nested tables. */
function markupRows(html) {
	const starts = [...html.matchAll(/<tr\b[^>]*>/giu)].map((match) => match.index);
	const ends = [...html.matchAll(/<\/tr\s*>/giu)].map((match) => match.index + match[0].length);
	const rows = [];
	for (const start of starts) {
		const end = ends.find((candidate) => candidate > start);
		if (end !== undefined) rows.push(html.slice(start, end));
	}
	return rows;
}

/** Cut one row fragment into its cell texts, by the same start/end pairing. */
function rowCells(row) {
	const starts = [...row.matchAll(/<t[dh]\b[^>]*>/giu)].map((match) => match.index);
	const ends = [...row.matchAll(/<\/t[dh]\s*>/giu)].map((match) => match.index + match[0].length);
	const cells = [];
	for (const start of starts) {
		const end = ends.find((candidate) => candidate > start);
		if (end !== undefined) cells.push(textOf(row.slice(start, end)));
	}
	return cells;
}

/** The first amount in one cell text, in whichever denomination that cell writes. */
function cellPrice(cell) {
	const yuan = /([0-9]+(?:\.[0-9]+)?)\s*元/u.exec(cell);
	if (yuan !== null) {
		const amount = Number(yuan[1]);
		return Number.isFinite(amount) && amount >= MIN_PLAUSIBLE_PRICE ? { amount, denomination: "CNY" } : undefined;
	}
	const dollar = /\$\s*([0-9]+(?:\.[0-9]+)?)/u.exec(cell);
	if (dollar !== null) {
		const amount = Number(dollar[1]);
		return Number.isFinite(amount) && amount >= MIN_PLAUSIBLE_PRICE ? { amount, denomination: "USD" } : undefined;
	}
	return undefined;
}

/** The published table's billing row families, in publication order, in both languages the page is served in. */
const PRICING_ROW_LABELS = [
	{ kind: "cacheHit", label: /cache hit|缓存命中/iu },
	{ kind: "cacheMiss", label: /cache miss|缓存未命中/iu },
	{ kind: "output", label: /output tokens|百万\s*tokens\s*输出|1M\s*OUTPUT/iu }
];

/** Fold the published price page into this plugin's rate table. */
function parsePricing(html) {
	if (typeof html !== "string" || html === "") return void 0;
	const rows = markupRows(html).map((row) => rowCells(row));
	let headerIndex = -1;
	let columns = [];
	for (const [index, cells] of rows.entries()) {
		const found = cells
			.map((name, column) => ({ column, name }))
			.filter(({ column, name }) => column > 0 && PRICING_MODELS.some((model) => name.startsWith(model)));
		if (found.length > 0) {
			headerIndex = index;
			columns = found;
			break;
		}
	}
	if (headerIndex < 0) return void 0;
	const values = {};
	for (const { column, name } of columns) {
		values[column] = {
			model: PRICING_MODELS.find((model) => name.startsWith(model)),
			peak: {},
			offPeak: {}
		};
	}
	/** Read one model column's amount from one row. */
	const amountOf = (cells, column) => {
		const priced = cells.filter((cell) => /([0-9]\s*元|\$\s*[0-9])/u.test(cell));
		const cell = priced[column - 1];
		return cell === undefined ? undefined : cellPrice(cell);
	};
	/** Every denomination this page wrote, so a mixed page can be rejected. */
	const denominations = new Set();
	let cursor = headerIndex + 1;
	for (const { kind, label } of PRICING_ROW_LABELS) {
		let head = -1;
		for (let index = cursor; index < rows.length; index += 1) {
			if (label.test(rows[index].join(" "))) {
				head = index;
				break;
			}
		}
		if (head < 0 || rows[head + 1] === undefined) return void 0;
		for (const column of Object.keys(values).map(Number)) {
			const offPeak = amountOf(rows[head], column);
			const peak = amountOf(rows[head + 1], column);
			if (offPeak === undefined || peak === undefined) return void 0;
			denominations.add(offPeak.denomination);
			denominations.add(peak.denomination);
			values[column].offPeak[kind] = offPeak.amount;
			values[column].peak[kind] = peak.amount;
		}
		// The next family starts after this family's two rows.
		cursor = head + 2;
	}
	if (denominations.size !== 1) return void 0;
	const published = [...denominations][0];
	// Yuan is the authority and travels unchanged
	const toCny = (amount) => Math.round((published === "CNY" ? amount : amount * USD_CNY) * 1e6) / 1e6;
	const models = {};
	// The same numbers as the page wrote them, in the page's own denomination: the local price file keeps these so it can document the p
	const asPublished = {};
	for (const { model, peak, offPeak } of Object.values(values)) {
		const complete = PRICING_ROW_LABELS.every(({ kind }) => Number.isFinite(peak[kind]) && Number.isFinite(offPeak[kind]));
		const wedged = complete
			&& offPeak.cacheHit <= peak.cacheHit
			&& offPeak.cacheMiss <= peak.cacheMiss
			&& offPeak.output <= peak.output
			&& peak.cacheHit <= peak.cacheMiss
			&& peak.cacheMiss <= peak.output
			&& peak.cacheHit > 0
			&& peak.output > 0;
		if (!wedged) continue;
		models[model] = {
			peak: { cacheHit: toCny(peak.cacheHit), cacheMiss: toCny(peak.cacheMiss), output: toCny(peak.output) },
			offPeak: { cacheHit: toCny(offPeak.cacheHit), cacheMiss: toCny(offPeak.cacheMiss), output: toCny(offPeak.output) }
		};
		asPublished[model] = {
			peak: { cacheHit: peak.cacheHit, cacheMiss: peak.cacheMiss, output: peak.output },
			offPeak: { cacheHit: offPeak.cacheHit, cacheMiss: offPeak.cacheMiss, output: offPeak.output }
		};
	}
	if (Object.keys(models).length === 0) return void 0;
	return { currency: "CNY", models, denomination: published, asPublished };
}

/** Read DeepSeek's published model pricing, Chinese page first. */
async function readPublishedPricing() {
	const published = {};
	let table;
	let primary;
	for (const { url, locale } of PRICING_SOURCES) {
		try {
			const response = await fetch(url, {
				headers: { accept: "text/html", "accept-language": locale === "zh" ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9" },
				signal: AbortSignal.timeout(PRICING_TIMEOUT_MS)
			});
			if (!response.ok) continue;
			const folded = parsePricing(await response.text());
			if (folded === undefined) continue;
			// The amounts as the page wrote them (yuan on the Chinese page
			const peak = {};
			for (const [model, card] of Object.entries(folded.asPublished)) peak[model] = { ...card.peak };
			published[locale] = { url, denomination: folded.denomination, peak };
			if (table === undefined) {
				table = { ...folded, source: url, approximate: folded.denomination === "USD" };
				primary = locale;
			}
		} catch {
			// Try the next published page.
		}
	}
	if (table === undefined) return void 0;
	return { ...table, published, primary };
}

/** Absolute path of the local price file: both published price lists, as last read. */
function pricingPath() {
	const override = process.env.DSH_USAGE_BALANCE_PRICING;
	if (typeof override === "string" && override !== "") return override;
	const root = pluginRoot();
	return root === void 0
		? join(harnessHome(), "usage-balance", "pricing.json")
		: join(root, "pricing.json");
}

/** Format of the local price file this version writes; an older or newer one is ignored. */
const PRICING_FILE_VERSION = 1;

/** Validate one rate table read from the local price file: a damaged or edited file counts as absent. */
function tableFromLocal(value) {
	if (value === null || typeof value !== "object") return void 0;
	if (value.version !== PRICING_FILE_VERSION) return void 0;
	const table = value.table;
	if (table === null || typeof table !== "object" || table.currency !== "CNY") return void 0;
	if (table.models === null || typeof table.models !== "object") return void 0;
	const models = {};
	for (const [model, card] of Object.entries(table.models)) {
		if (!PRICING_MODELS.includes(model)) continue;
		if (card === null || typeof card !== "object") continue;
		const windows = {};
		let usable = true;
		for (const window of ["peak", "offPeak"]) {
			const rates = card[window];
			const clean = {};
			for (const kind of ["cacheHit", "cacheMiss", "output"]) {
				const amount = rates?.[kind];
				if (typeof amount !== "number" || !Number.isFinite(amount) || amount < MIN_PLAUSIBLE_PRICE || amount > 1e6) {
					usable = false;
					break;
				}
				clean[kind] = amount;
			}
			if (!usable) break;
			windows[window] = clean;
		}
		if (!usable) continue;
		const ordered = windows.offPeak.cacheHit <= windows.peak.cacheHit
			&& windows.offPeak.cacheMiss <= windows.peak.cacheMiss
			&& windows.offPeak.output <= windows.peak.output
			&& windows.peak.cacheHit <= windows.peak.cacheMiss
			&& windows.peak.cacheMiss <= windows.peak.output;
		if (!ordered) continue;
		models[model] = windows;
	}
	if (Object.keys(models).length === 0) return void 0;
	return {
		currency: "CNY",
		models,
		source: typeof value.source === "string" && value.source !== "" ? value.source : pricingPath(),
		writtenAt: typeof value.writtenAt === "string" ? value.writtenAt : void 0,
		local: true
	};
}

/** Read the local price file, if it holds a usable table. */
function readLocalPricing() {
	try {
		const path = pricingPath();
		if (!existsSync(path)) return void 0;
		return tableFromLocal(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return void 0;
	}
}

/** Write the local price file (both published lists, the folded table). A temp file plus rename, so a torn write is never read back. */
function writeLocalPricing(entry) {
	const path = pricingPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		const payload = {
			version: PRICING_FILE_VERSION,
			writtenAt: new Date().toISOString(),
			// The list the guards price with, folded to CNY per million tokens.
			table: { currency: entry.currency, models: entry.models },
			// What each page actually printed, in its own denomination, so the file documents its own derivation and can be re-folded by hand.
			published: entry.published ?? {},
			primary: entry.primary ?? "zh",
			source: entry.source ?? PRICING_DOC_URL,
			approximate: entry.approximate === true,
			numeral: "per one million tokens",
			note: "Written by the usage-balance plugin once a day from DeepSeek's published price pages. Read back only when a fresh read fails; validated on every read."
		};
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		renameSync(temporary, path);
		return path;
	} catch {
		return void 0;
	}
}

/* ──────────────────────────── request trust ──────────────────────────── */

/** Loopback hostnames accepted in a request's Host/Origin, matching the app's own rule. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/** Parse one authority (host or host:port) into a URL, or undefined when malformed. */
function parseAuthority(value) {
	if (typeof value !== "string" || value === "") return void 0;
	try {
		return new URL(`http://${value}`);
	} catch {
		return void 0;
	}
}

/** Decide whether one request may read account usage: loopback peer, loopback Host, same-origin only. */
function isLocalSameOrigin(request) {
	const peer = request.socket?.remoteAddress ?? "";
	if (!(peer.startsWith("127.") || peer === "::1" || peer === "::ffff:127.0.0.1")) return false;
	const headers = request.headers ?? {};
	const hostUrl = parseAuthority(headers.host);
	if (hostUrl === void 0 || !isLoopbackHostname(hostUrl.hostname)) return false;
	if (headers["sec-fetch-site"] === "cross-site") return false;
	const origin = headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/* ───────────────────────────── turn ledger ───────────────────────────── */

/** Locate this plugin's own directory. */
function pluginRoot() {
	try {
		const root = dirname(dirname(fileURLToPath(import.meta.url)));
		return existsSync(join(root, "lib", "client.js")) ? root : void 0;
	} catch {
		return void 0;
	}
}

/** Absolute path of the turn ledger: one JSON line per finished answer. */
function ledgerPath() {
	const override = process.env.DSH_USAGE_BALANCE_LEDGER;
	if (typeof override === "string" && override !== "") return override;
	const root = pluginRoot();
	return root === void 0
		? join(harnessHome(), "usage-balance", "turns.jsonl")
		: join(root, "log", "turns.jsonl");
}

/** One bounded, non-negative number from a submitted record. */
function boundedNumber(value, max) {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric < 0 || numeric > max) return void 0;
	return numeric;
}

/** One bounded non-empty string from a submitted record. */
function boundedText(value, max) {
	return typeof value === "string" && value !== "" && value.length <= max ? value : void 0;
}

/** Fold one submitted answer into the line the ledger stores. The page is untrusted: every field is re-bounded and rebuilt. */
function ledgerRecord(payload) {
	const sessionId = boundedText(payload?.sessionId, 200);
	const turn = boundedNumber(payload?.turn, 1e9);
	const tokens = boundedNumber(payload?.tokens, 1e15);
	const input = boundedNumber(payload?.input, 1e15);
	const uncachedInput = boundedNumber(payload?.uncachedInput, 1e15);
	const cacheRead = boundedNumber(payload?.cacheRead, 1e15);
	const cacheWrite = boundedNumber(payload?.cacheWrite, 1e15);
	const output = boundedNumber(payload?.output, 1e15);
	const cost = boundedNumber(payload?.cost, 1e12);
	const seconds = boundedNumber(payload?.seconds, 1e9);
	if (sessionId === void 0 || turn === void 0 || tokens === void 0 || cost === void 0 || seconds === void 0) return void 0;
	const endedAt = boundedNumber(payload?.endedAt, Number.MAX_SAFE_INTEGER);
	const reason = payload?.reason;
	const kind = reason?.kind === "tokens" || reason?.kind === "cost" || reason?.kind === "seconds" ? reason.kind : void 0;
	const limits = payload?.limits;
	const parts = payload?.costParts;
	const subagents = payload?.subagents;
	return {
		schema: 1,
		writtenAt: new Date().toISOString(),
		sessionId,
		turn: Math.round(turn),
		// ISO instant of the answer's own end, so the file reads without arithmetic.
		endedAt: endedAt === void 0 ? void 0 : new Date(endedAt).toISOString(),
		tokens: Math.round(tokens),
		// The prompt side split by the bucket that billed it: cache hits, cache writes, and the part that was neither.
		input: Math.round(input ?? 0),
		uncachedInput: Math.round(uncachedInput ?? 0),
		cacheRead: Math.round(cacheRead ?? 0),
		cacheWrite: Math.round(cacheWrite ?? 0),
		output: Math.round(output ?? 0),
		cost: Math.round(cost * 1e6) / 1e6,
		// What `cost` is made of, one part per published rate line.
		costParts: parts === void 0 ? void 0 : {
			cacheMiss: boundedNumber(parts.cacheMiss, 1e12),
			cacheHit: boundedNumber(parts.cacheHit, 1e12),
			output: boundedNumber(parts.output, 1e12)
		},
		currency: boundedText(payload?.currency, 8) ?? "CNY",
		seconds,
		// `requests`/`tokens` are the answer plus its subagents; these are the answer's own.
		requests: Math.round(boundedNumber(payload?.requests, 1e6) ?? 0),
		ownRequests: Math.round(boundedNumber(payload?.ownRequests, 1e6) ?? 0),
		ownTokens: Math.round(boundedNumber(payload?.ownTokens, 1e15) ?? 0),
		// What the answer spent through its subagents, when it spawned any.
		subagents: subagents === void 0 ? void 0 : {
			sessions: Math.round(boundedNumber(subagents.sessions, 1e4) ?? 0),
			requests: Math.round(boundedNumber(subagents.requests, 1e6) ?? 0),
			tokens: Math.round(boundedNumber(subagents.tokens, 1e15) ?? 0),
			cost: boundedNumber(subagents.cost, 1e12)
		},
		model: boundedText(payload?.model, 120),
		stopped: payload?.stopped === true,
		// `accepted` tells a refused stop from a ceiling that never tripped: both leave
		// `stopped` false, and only this field says which of the two happened.
		reason: kind === void 0 ? void 0 : {
			kind,
			limit: boundedNumber(reason?.limit, 1e15),
			actual: boundedNumber(reason?.actual, 1e15),
			accepted: reason?.accepted === true
		},
		limits: limits === void 0 ? void 0 : {
			tokens: boundedNumber(limits.tokens, 1e15),
			cost: boundedNumber(limits.cost, 1e12),
			seconds: boundedNumber(limits.seconds, 1e9)
		}
	};
}

/* ──────────────────────────────── plugin ──────────────────────────────── */

/** Host plugin body: register the loopback usage route and publish its path into the page. */
function apply(ctx) {
	const cache = { at: 0, value: void 0, inflight: void 0 };
	const pricingCache = { at: 0, value: void 0, inflight: void 0 };
	// Answers already written, so a page that re-sends one (a replayed event window or a reload) cannot put the same line in the file tw
	const ledgerWritten = new Set();

	/** Serve one request, reusing a recent read. */
	const cachedRead = (metadata) => {
		const now = Date.now();
		if (cache.value !== void 0 && now - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.value);
		if (cache.inflight !== void 0) return cache.inflight;
		const read = readUsage(metadata).then((value) => {
			cache.at = Date.now();
			cache.value = value;
			cache.inflight = void 0;
			return value;
		}, (error) => {
			cache.inflight = void 0;
			throw error;
		});
		cache.inflight = read;
		return read;
	};

	/** Answer one price request from the daily cache. */
	const cachedPricing = () => {
		const cached = pricingCache.value;
		if (cached !== void 0 && Date.now() - pricingCache.at < PRICING_TTL_MS) return Promise.resolve(cached);
		if (pricingCache.inflight !== void 0) return pricingCache.inflight;

		/** Adopt a table for the rest of the TTL, and report where it came from. */
		const adopt = (table) => {
			pricingCache.value = table;
			// A local file keeps its own age: its `writtenAt` decides when to try the network again
			pricingCache.at = typeof table.writtenAt === "string" && Number.isFinite(Date.parse(table.writtenAt))
				? Date.parse(table.writtenAt)
				: Date.now();
			return table;
		};

		const local = readLocalPricing();
		if (local !== void 0 && Date.now() - Date.parse(local.writtenAt ?? "") < PRICING_TTL_MS) {
			return Promise.resolve(adopt(local));
		}

		const read = (async () => {
			try {
				const entry = await readPublishedPricing();
				if (entry !== void 0) {
					if (entry.published !== void 0 && writeLocalPricing(entry) === void 0) {
						// The table is still usable for this run; the file is only a cache.
						entry.writeFailed = true;
					}
					return adopt(entry);
				}
			} catch {
				// Fall through to the local file.
			}
			if (local !== void 0) {
				// Stale, but the published numbers this plugin last saw: better than the built-in copy
				return adopt({ ...local, stale: true });
			}
			return adopt(DEFAULT_PRICING);
		})().then((table) => {
			pricingCache.inflight = void 0;
			return table;
		}, (error) => {
			pricingCache.inflight = void 0;
			throw error;
		});
		pricingCache.inflight = read;
		return read;
	};

	/** Write one JSON response with no-store caching and no sniffing. */
	const sendJson = (response, status, payload) => {
		const body = JSON.stringify(payload);
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-length": String(Buffer.byteLength(body))
		});
		response.end(body);
	};

	const handler = async (request, response) => {
		if (!isLocalSameOrigin(request)) {
			// The refusal names the rule only; it never mentions what it protects.
			sendJson(response, 403, { ok: false, error: "usage route is available to local same-origin callers only" });
			return;
		}
		const url = new URL(request.url ?? ROUTE_PATH, "http://loopback.invalid");
		const tz = Number(url.searchParams.get("tz"));
		const metadata = {
			locale: url.searchParams.get("locale") ?? void 0,
			timezoneOffsetSeconds: Number.isFinite(tz) ? tz : void 0
		};
		try {
			sendJson(response, 200, { ok: true, value: await cachedRead(metadata) });
		} catch {
			sendJson(response, 200, { ok: false, error: "platform usage read failed" });
		}
	};

	/** Serve the daily model price table on its own loopback route. */
	const pricingHandler = async (request, response) => {
		if (!isLocalSameOrigin(request)) {
			sendJson(response, 403, { ok: false, error: "pricing route is available to local same-origin callers only" });
			return;
		}
		// Always 200: the body distinguishes a published table from the fallback
		const table = await cachedPricing();
		sendJson(response, 200, {
			ok: true,
			value: {
				...table,
				source: table.source ?? PRICING_DOC_URL,
				approximate: table.approximate === true || table.denomination === "USD",
				// Where these prices came from, so a page can show it instead of assuming they are fresh: a published page
				origin: table.local === true ? "local" : table.source === "built-in" || table.source === void 0 ? "built-in" : "published",
				local: table.local === true,
				stale: table.stale === true,
				writtenAt: table.writtenAt,
				writeFailed: table.writeFailed === true,
				pricingPath: pricingPath()
			}
		});
	};

	/** Read one request body, refusing anything above the ledger's ceiling. */
	const readBody = (request) => new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const settle = (finish) => {
			if (settled) return;
			settled = true;
			finish();
		};
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > LEDGER_MAX_BYTES) {
				settle(() => { reject(new Error("ledger payload too large")); });
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => { settle(() => { resolve(Buffer.concat(chunks).toString("utf8")); }); });
		request.on("error", () => { settle(() => { reject(new Error("ledger payload unreadable")); }); });
		request.on("close", () => { settle(() => { reject(new Error("ledger payload truncated")); }); });
	});

	/** Append one finished answer to the turn ledger. */
	const turnHandler = async (request, response) => {
		if (!isLocalSameOrigin(request)) {
			sendJson(response, 403, { ok: false, error: "turn ledger is available to local same-origin callers only" });
			return;
		}
		if (request.method !== "POST") {
			sendJson(response, 405, { ok: false, error: "turn ledger accepts POST only" });
			return;
		}
		let record;
		try {
			record = ledgerRecord(JSON.parse(await readBody(request)));
		} catch {
			record = void 0;
		}
		if (record === void 0) {
			sendJson(response, 200, { ok: false, error: "turn ledger payload rejected" });
			return;
		}
		const path = ledgerPath();
		const key = `${record.sessionId}:${String(record.turn)}`;
		if (ledgerWritten.has(key)) {
			sendJson(response, 200, { ok: true, value: { written: false, duplicate: true, path } });
			return;
		}
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		} catch {
			// The path never reaches the file's failure text: a filesystem error could carry a home directory
			sendJson(response, 200, { ok: false, error: "turn ledger write failed" });
			return;
		}
		ledgerWritten.add(key);
		if (ledgerWritten.size > LEDGER_MEMORY) ledgerWritten.delete(ledgerWritten.values().next().value);
		sendJson(response, 200, { ok: true, value: { written: true, duplicate: false, path } });
	};

	ctx.inject(["webServer"], (scope) => {
		scope.effect(
			() => scope.webServer.register({ kind: "exact", path: ROUTE_PATH, handler }),
			"usage-balance: platform usage route"
		);
		scope.effect(
			() => scope.webServer.register({ kind: "exact", path: PRICING_ROUTE_PATH, handler: pricingHandler }),
			"usage-balance: model pricing route"
		);
		scope.effect(
			() => scope.webServer.register({ kind: "exact", path: TURN_ROUTE_PATH, handler: turnHandler }),
			"usage-balance: turn ledger route"
		);
	});

	ctx.on("webserver/index-inject", (table) => {
		// Data only: the page learns where to ask, never what to present.
		table.push({
			kind: "global",
			name: BRIDGE_GLOBAL,
			value: {
				endpoint: ROUTE_PATH,
				pricingEndpoint: PRICING_ROUTE_PATH,
				turnEndpoint: TURN_ROUTE_PATH,
				layer: CLIENT_LAYER
			}
		});
	});
}

export { apply };
