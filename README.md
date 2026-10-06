# Usage & budget panel (usage-balance)

A DeepSeek Harness web-client plugin: it shows the account balance and this month's usage in the
**bottom-right corner of the conversation pane**, measures what **each answer** costs in tokens, money, and
time, and lets you set one ceiling for each of those three — when an answer crosses one, it is stopped.

In one line: **see what this answer has spent, and stop it from spending more.**

---

## Features

**1. Account overview (the panel)**

- Balance: topped-up and granted, plus the account state.
- This month: a per-day spend chart with the month's total (read-only, from Platform's usage endpoints).
- Refreshed once a minute, with a manual refresh.

**2. Per-answer measurement**

One "answer" is one turn: from the moment you send a prompt to the moment that answer ends
(`turn/start` → `turn/end`). **Every model request the turn makes is added together** — not just the last one.

| Reading | Meaning |
|---|---|
| tokens | input + output of every request in the turn; the input side is split into cache hits, cache misses, and cache writes |
| spend | an estimate in CNY, priced request by request from the published price list |
| time | real seconds from the start of the turn to its end, ticking once a second while the answer runs |
| requests | how many requests the turn made |

**3. Three editable ceilings**

| Ceiling | Unit | Settable range | Default |
|---|---|---|---|
| tokens | 10k tokens (万) | `1` – `210000` (10 thousand – 2.1 billion tokens) | `10000` (= 100 million) |
| spend | CNY | `1` – `100000` | `5` |
| time | seconds | `60` – `86400` (24 h) | `3600` |

When one is crossed: the answer is stopped immediately, and one short follow-up is queued into the same
conversation — it names the ceiling that tripped, the amount reached, and the limit, and asks the model to
finish within 500 tokens. That follow-up is itself held to the same ceilings. **A turn is never stopped twice.**

**4. And**

- **Manual stop**: the `■` button stops a running answer through the same path, and reports the outcome
  truthfully (a refused cancel is never shown as "stopped").
- **Subagents count**: what an answer spends through its subagents (tokens, money, requests) is added to that
  answer; time stays the main answer's own.
- **Ledger**: when an answer ends, one JSON line is appended to `log/turns.jsonl` — the token split, the money
  and what it is made of, the duration, the request count, and the ceilings that were in force.
- **Local price list**: the published price page is read once a day and written to `pricing.json`; when a read
  fails the local file is used; when there is none, the built-in official yuan prices apply.
- **Bilingual**: follows the interface language (Chinese / English).

---

## Usage

**Where it goes**

Put this directory under the Harness plugin source directory (`~/.dsh/plugin-src/<name>`). The host half is
loaded when Harness starts; the browser half is served to the page by Harness as a web plugin.

**When the panel appears**

In the bottom-right corner of the conversation pane, once the pane is wide enough (width ≥ 1440 px, height ≥
256 px). It hides by itself in a narrow window and comes back when there is room.

**Editing a ceiling**

- Click the number and type; **Enter, or moving focus away**, applies it and remembers it.
- Each field has its own range (table above); a value outside it is clamped back. **Clearing a field and
  leaving it keeps the stored value** rather than dropping to the minimum.
- While an answer is running the three fields and the switch are locked ("limits locked while answering") and
  unlock when that answer ends.
- To turn the ceilings off entirely, clear the checkbox in the header — measurement continues, nothing stops.

**Stopping an answer**

Click `■`. It is enabled while an answer runs and disabled when idle. It stops the current answer of the
current conversation only (see note 4 below).

**Files it writes**

| File | Contents | Location |
|---|---|---|
| `log/turns.jsonl` | one JSON line per answer: `schema`, `writtenAt`, `sessionId`, `turn`, `endedAt`, `tokens`, `input` / `uncachedInput` / `cacheRead` / `cacheWrite` / `output`, `cost`, `costParts`, `currency`, `seconds`, `requests`, `ownRequests`, `ownTokens`, `subagents`, `model`, `stopped`, `reason`, `limits` | the plugin's own `log/` by default; `DSH_USAGE_BALANCE_LEDGER` moves it anywhere |
| `pricing.json` | both published price lists **as printed** (`published.zh` in yuan, `published.en` in dollars) plus the folded `table` used for pricing (CNY per million tokens), `writtenAt`, `primary` | the plugin's own directory by default; `DSH_USAGE_BALANCE_PRICING` moves it anywhere |

Both are local, plain files holding numbers, ids, and a model name only — **no conversation text and no credential**.

**When a restart is needed**

Changing `lib/index.js` (the host half) needs one Harness restart. Changing `lib/client.js` (the browser half)
only needs a page refresh.

---

## Notes and caveats

**1. There is no public-holiday calendar — during Chinese public holidays this plugin's spend estimate is
noticeably higher than the official figure**

The published rule is "**Beijing time, Monday to Friday (excluding Chinese public holidays)**, 09:00–12:00 and
14:00–18:00 are peak; everything else, including weekends and public holidays in full, is off-peak", where
off-peak is half of peak. This plugin **looks only at the weekday and has no holiday calendar**, so:

- a public holiday falling on a Monday–Friday: those two windows are off-peak officially and peak here —
  **an over-estimate of up to about 2×**;
- weekends, and weekends worked to make up for a holiday: off-peak both officially and here — they agree.

In other words, **during public holidays (Spring Festival and National Day week especially) trust the official
bill, not this panel**. It is not a small thing that could simply be fixed: holiday dates cannot be derived
from the weekday (Spring Festival, Dragon Boat and Mid-Autumn follow the lunar calendar, Qingming follows a
solar term, and the make-up working days are published by the State Council each year), so an offline fix
means shipping a holiday table and maintaining it every year, and an online fix stops working exactly when the
source is unreachable. The trade-off taken here is to **give up one feature rather than add a dependency that
can fail**, and to state the deviation in both READMEs.

**2. The money in the panel is an estimate, not a bill**

- requests whose provider reported no usage cannot be counted;
- the small model requests Harness makes on its own (session titles, summaries) produce no usage event here;
- an unrecognized model route is priced as `deepseek-flash`;
- for reconciliation use the official bill; this panel is for watching the trend and setting a budget.

**3. Where prices come from, and how they degrade**

- DeepSeek publishes **no** machine-readable pricing endpoint — only two documentation pages (a Chinese one in
  yuan, an English one in dollars). This plugin reads the Chinese page once a day and uses its yuan amounts
  unchanged; the English page is a fallback whose dollars are converted at a fixed rate, and **that path is
  approximate** because the two published lists are not proportional.
- When the pages cannot be read, the local `pricing.json` is used; when that is missing or invalid, the
  built-in official yuan prices apply — so **an offline start still prices correctly**.
- A redesign of the published pages makes the fold fail, which degrades along the same path: prices stay
  correct, they may just be a day older.

**4. What "stop" does and does not do**

- it stops the current answer of the current conversation;
- subagents that the answer already started **in the background** (the continuable kind) are **not** stopped —
  that is how Harness's interface behaves: their tool call has long since returned, and only stopping or
  archiving the whole conversation cancels them;
- requests already completed cannot be undone; stopping only prevents the turn from sending more.

**5. And**

- The three ceilings are **budget limits**: they cost nothing by themselves, they only decide when an answer stops.
- The balance and monthly figures come from Platform's **private** usage endpoints; if those change, those two
  blocks may read as unavailable, while per-answer measurement, the ceilings, and the ledger keep working.
- The time ceiling is computed from event timestamps and covers the main answer only, not its subagents' runtime.

---

## Files

| File | Role |
|---|---|
| `package.json` | Package declaration: the `dsh.client` block marks this as a web-client plugin, and `exports["./client"]` points at the browser half |
| `lib/index.js` | Host half: reads the stored account grant, queries Platform usage, reads and caches the price list once a day, serves three loopback JSON routes (usage / pricing / ledger), and injects their paths into the page |
| `lib/client.js` | Browser half: renders the panel, adds up each answer, enforces the three ceilings, and reports each finished answer to the ledger |
| `README.md` / `README.zh.md` | This document (English / Chinese) |
| `log/turns.jsonl` | Runtime output: one ledger line per answer |
| `pricing.json` | Runtime output: the local price list (refreshed once a day when a read succeeds) |

Runs on the Node (24+) and Electron/Web environment Harness already ships; no third-party dependencies, nothing
to build.
