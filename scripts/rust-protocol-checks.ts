// SPDX-License-Identifier: Apache-2.0

/*
 * The Rust implementation of every `.refine()`/`.superRefine()` reachable from the wire roots.
 * The key is the function's own source as Bun reads it, normalised to single spaces: a change to
 * a rule's body changes its source, so the generator fails until its Rust check is updated too
 * (the shape table must never silently drop a constraint). The names are the statics in
 * `ace-protocol/src/checks.rs`.
 */

export interface RustCheck {
  /** The static in `ace-protocol/src/checks.rs`. */
  name: string;
  /** True when `ace-wire/src/refine.rs` owns the rule (a whole message's rule). */
  message?: boolean;
}

const entries: readonly [string, string, boolean?][] = [
  [String.raw`(a) => a.reviewers.length + (a.teams?.length ?? 0) > 0`, "REVIEWERS_PRESENT"],
  [
    String.raw`(anchor) => anchor.position.end - anchor.position.start + 1 === anchor.fingerprint.lines.length`,
    "ANCHOR_LINES_MATCH",
  ],
  [
    String.raw`(c) => Boolean(c.command[0]) && c.command.every((arg) => !arg.includes("\x00"))`,
    "COMMAND_NO_NUL",
  ],
  [
    String.raw`(event) => event.firstSeq === void 0 || event.payload.type === "item.delta" && event.firstSeq <= event.seq`,
    "EVENTS",
    true,
  ],
  [
    String.raw`(f) => [...f.before, ...f.lines, ...f.after].reduce((n, s) => n + s.length, 0) <= 8192`,
    "FINGERPRINT_SIZE",
  ],
  [
    String.raw`(f) => f.after === void 0 || f.before === void 0 || f.after <= f.before`,
    "SEARCH_DATES_ORDER",
  ],
  [
    String.raw`(hello) => [hello.token, hello.ticket, hello.grant].filter((value) => value !== void 0).length === 1`,
    "HELLO",
    true,
  ],
  [String.raw`(hello) => hello.link === void 0 || hello.grant !== void 0`, "HELLO", true],
  [String.raw`(hello) => hello.machineCode === void 0 || hello.grant !== void 0`, "HELLO", true],
  [String.raw`(id) => !["__proto__", "constructor", "prototype"].includes(id)`, "NOT_RESERVED_ID"],
  [String.raw`(images) => Object.keys(images).length <= 256`, "IMAGES_KEY_LIMIT"],
  [
    String.raw`(input) => [input.aroundSeq, input.turnOrdinal, input.itemId].filter((target) => target !== void 0).length === 1`,
    "ITEMS_WINDOW",
    true,
  ],
  [String.raw`(input) => input.before + input.after < 200`, "ITEMS_WINDOW", true],
  [String.raw`(input) => input.before === void 0 || input.after === void 0`, "TURNS_PAGE", true],
  [
    String.raw`(input) => input.sinceSeq === void 0 !== (input.sinceTime === void 0)`,
    "CATCH_UP",
    true,
  ],
  [
    String.raw`(input) => { const value = input.startsWith("./") ? input.slice(2) : input; return !value.includes("\\") && !/[<>:"|?*]/.test(value) && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && ![".git", "__proto__", "constructor", "prototype"].includes(part) && !/[. ]$/.test(part)); }`,
    "CONTAINED_PATH",
  ],
  [String.raw`(json) => new TextEncoder().encode(json).byteLength <= 2048`, "UTF8_2048"],
  [String.raw`(lines) => lines.end >= lines.start`, "RANGE_ORDERED"],
  [String.raw`(message) => message.seq === message.view.seq`, "SNAPSHOT", true],
  [String.raw`(message) => message.throughSeq >= message.afterSeq`, "PROGRESS", true],
  [
    String.raw`(message) => { let previous = message.afterSeq; if (message.throughSeq < previous) return !1; for (const event of message.events) { if ((event.firstSeq ?? event.seq) <= previous || event.seq > message.throughSeq) return !1; previous = event.seq; } return !0; }`,
    "EVENTS",
    true,
  ],
  [
    String.raw`(model) => new TextEncoder().encode(JSON.stringify(model)).byteLength <= 8192`,
    "MODEL_ROW_8192",
  ],
  [String.raw`(name) => !name.startsWith("-") && !name.startsWith(".")`, "NO_LEADING_DASH_OR_DOT"],
  [
    String.raw`(name) => name !== "." && name !== ".." && !/[/\\]/.test(name) && !/[\u0000-\u001f\u007f]/.test(name)`,
    "FILE_NAME",
  ],
  [String.raw`(name) => name !== "ace"`, "NOT_ACE"],
  [String.raw`(p) => p.end >= p.start && p.end - p.start < 100`, "LINE_RANGE"],
  [
    String.raw`(page) => page.items.every((item) => page.itemSeqs !== void 0 && Object.hasOwn(page.itemSeqs, item.id))`,
    "ITEMS_PAGE",
    true,
  ],
  [String.raw`(path) => !path.includes("\x00")`, "NO_NUL_PATH"],
  [String.raw`(path) => !path.split("/").includes("..")`, "NO_PARENT_PATH"],
  [
    String.raw`(path) => !path.startsWith("/") && !path.includes("\\") && [...path].every((char) => char.charCodeAt(0) >= 32) && !/^[A-Za-z]:/.test(path) && path.split("/").every((part) => part !== ".." && part !== "." && part !== "")`,
    "REVIEW_PATH",
  ],
  [
    String.raw`(q) => { const span = Date.parse(q.to) - Date.parse(q.from); return span >= 0 && span <= 31536000000 && new Set(q.groupBy).size === q.groupBy.length; }`,
    "USAGE_QUERY",
  ],
  [
    String.raw`(reply) => reply.items.every((item) => Object.hasOwn(reply.itemSeqs, item.id))`,
    "ITEMS_WINDOW",
    true,
  ],
  [String.raw`(s) => !s.startsWith("-") && !s.includes("\x00")`, "REVISION_REF"],
  [String.raw`(servers) => Object.keys(servers).length <= 256`, "SERVERS_KEY_LIMIT"],
  [
    String.raw`(t) => t.lanes.length <= t.budget.maxLanes && (t.kind !== "coordinator" || t.lanes.length === 1)`,
    "LANES_BUDGET",
  ],
  [String.raw`(text) => new TextEncoder().encode(text).length <= 2048`, "UTF8_2048"],
  [String.raw`(text) => new TextEncoder().encode(text).length <= 4096`, "UTF8_4096"],
  [
    String.raw`(usage) => usage.usageScope === void 0 || usage.usageScope === "agent" || usage.counterKey !== void 0`,
    "USAGE_SCOPE",
  ],
  [String.raw`(v) => Object.keys(v).length <= 64`, "KEYS_64"],
  [String.raw`(v) => v.default === void 0 || typeof v.default === v.type`, "DEFAULT_MATCHES_TYPE"],
  [String.raw`(value) => !value.includes("--")`, "NO_DOUBLE_DASH"],
  [
    String.raw`(value) => !value.includes("..") && !value.includes("--")`,
    "NO_DOTDOT_OR_DOUBLE_DASH",
  ],
  [String.raw`(value) => !value.includes("\x00")`, "NO_NUL"],
  [
    String.raw`(value) => Array.from(value).every((char) => char.charCodeAt(0) >= 32)`,
    "NO_CONTROL",
  ],
  [String.raw`(value) => Object.keys(value).length <= 24`, "KEYS_24"],
  [String.raw`(value) => Object.keys(value).length <= 32`, "KEYS_32"],
  [String.raw`(value) => Object.keys(value).length <= 64`, "KEYS_64"],
  [String.raw`(value) => ProjectIconUrl.safeParse(value).success`, "PROJECT_ICON_URL"],
  [
    String.raw`(value) => [value.threadId, value.draft, value.workspace].filter((target) => target !== void 0).length === 1`,
    "CATALOG_LIST",
    true,
  ],
  [String.raw`(value) => jsonBytes(value) <= maxSpadeRequestBytes`, "SPADE_REQUEST_BYTES"],
  [String.raw`(value) => new TextEncoder().encode(value).byteLength <= 65536`, "UTF8_65536"],
  [String.raw`(value) => value !== "." && value !== ".."`, "NOT_DOT_OR_DOTDOT"],
  [
    String.raw`(value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\x00")`,
    "FILE_NAME_NO_SLASH_NUL",
  ],
  [String.raw`(value) => value % 60000 === 0`, "START_AT_MINUTE"],
  [
    String.raw`(value) => value === value.trim() && value !== "." && value !== ".." && !value.endsWith(".")`,
    "PROJECT_DIR_NAME",
  ],
  [String.raw`(value) => value.driver !== void 0 || value.mode !== void 0`, "SPADE_DRIVE", true],
  [
    String.raw`(value) => value.hosts.every((entry) => configuredForge(entry) !== "github" || !entry.account || GitHubAccount.safeParse(entry.account).success)`,
    "SOURCE_CONTROL_GITHUB_ACCOUNT",
  ],
  [String.raw`(value) => value.hosts.every(providerMatchesHost)`, "SOURCE_CONTROL_HOST_PROVIDER"],
  [
    String.raw`(value) => value.hosts.some((entry) => entry.host === value.host) && new Set(value.hosts.map((entry) => entry.host)).size === value.hosts.length`,
    "SOURCE_CONTROL_HOSTS_UNIQUE",
  ],
  [String.raw`(value) => value.length >= 3`, "LENGTH_AT_LEAST_3"],
  [
    String.raw`(value) => value.model === void 0 || value.provider !== void 0`,
    "MODEL_NEEDS_PROVIDER",
  ],
  [String.raw`(value) => value.number !== void 0 !== (value.all === !0)`, "NUMBER_XOR_ALL"],
  [
    String.raw`(value) => value.split("/").every((part) => part !== "." && part !== "..")`,
    "NO_DOT_PARTS",
  ],
  [String.raw`(value) => value.startsWith("https://")`, "HTTPS_ONLY"],
  [
    String.raw`(value) => value.threadId === void 0 !== (value.draft === void 0)`,
    "COMMANDS_LIST",
    true,
  ],
  [String.raw`(value) => value.trim().length > 0`, "NONBLANK"],
  [String.raw`(value) => value.trim().length > 0 && !/[\r\n\0]/.test(value)`, "TITLE_NO_NEWLINE"],
  [
    String.raw`(value) => { const url = URL.parse(value); return !!url && ["https:", "wss:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }`,
    "URL_HTTPS_WSS",
  ],
  [
    String.raw`(value) => { if (/\s|\p{Cc}|\p{Cf}/u.test(value)) return !1; if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return !1; return Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)).length <= 2; }`,
    "ICON_GLYPH",
  ],
  [
    String.raw`(value) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return !1; } }`,
    "MCP_URL",
  ],
  [
    String.raw`(value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions(); return !0; } catch { return !1; } }`,
    "TIMEZONE",
  ],
  [String.raw`(w) => Object.keys(w).length <= 32`, "KEYS_32"],
  [
    String.raw`({ view }) => view.kind !== "thread" || view.itemOrder.every((id) => view.itemSeqs !== void 0 && Object.hasOwn(view.itemSeqs, id))`,
    "SNAPSHOT",
    true,
  ],
];

/** Collapse the whitespace Bun's transpiled source carries between tokens. */
export function normalizeCheckSource(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

const bySource = new Map<string, RustCheck>(
  entries.map(([source, name, message]) => [
    normalizeCheckSource(source),
    { name, message: message === true },
  ]),
);

/** The Rust check for a Zod refinement, or a refusal naming it. */
export function resolveCheck(source: string, path: string): RustCheck {
  const check = bySource.get(normalizeCheckSource(source));
  if (check === undefined) {
    throw new Error(
      `rust-protocol-shapes: ${path}: no Rust check for \`${normalizeCheckSource(source).slice(0, 120)}\``,
    );
  }
  return check;
}
