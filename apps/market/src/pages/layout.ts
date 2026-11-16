import type { FeedEntry } from "@ace/marketplace";

/*
 * The public page's frame (ADR 0168 §2): server-rendered, one small stylesheet, words rather
 * than chrome (docs/design/design-language.md). Every value from the store goes through
 * `escape`. Pure.
 */

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escape = (value: string | number) =>
  String(value).replace(/[&<>"']/g, (char) => entities[char] ?? char);

export const typeNames: Readonly<Record<string, string>> = {
  suit: "Suit",
  "spade-skill": "Skill",
  "spade-plugin": "Plugin",
  "spade-bot": "Bot",
  "ace-plugin": "ace plugin",
};
export const typeName = (type: string) => typeNames[type] ?? type;

/** The filter's choices, in the order the app's menu has them. */
export const typeChoices = [
  ["", "Everything"],
  ["suit", "Suits"],
  ["spade-skill", "Skills"],
  ["spade-plugin", "Plugins"],
  ["spade-bot", "Bots"],
] as const;

const style = `
:root{color-scheme:light dark;--bg:#fbfbfa;--ink:#1d1e20;--muted:#55585e;--subtle:#6b6f76;
--line:#e4e4e2;--field:#ffffff;--accent:#1d1e20;--accent-fg:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#161719;--ink:#e8e9eb;--muted:#b3b6bb;
--subtle:#94989e;--line:#2a2c30;--field:#1e2023;--accent:#e8e9eb;--accent-fg:#161719}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:24px}
header .home{font-weight:600}
h1{font-size:24px;font-weight:600;margin:0 0 4px}
h2{font-size:13px;font-weight:600;color:var(--subtle);margin:32px 0 8px}
form{display:flex;gap:8px;margin:0 0 8px}
input,select{font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);
border-radius:8px;padding:6px 12px}
input[type=search]{flex:1;min-width:0}
button{font:inherit;font-weight:600;color:var(--accent-fg);background:var(--accent);border:0;
border-radius:999px;padding:6px 16px;cursor:pointer}
ul{list-style:none;margin:0;padding:0}
.row{display:block;padding:8px 0}
.row .title{display:block}
.row .line{display:block;color:var(--muted)}
.meta{color:var(--subtle);font-size:13px}
.lead{color:var(--muted);margin:0 0 8px}
.description{white-space:pre-wrap;margin:16px 0}
.action{font-weight:600}
.versions li{display:flex;gap:16px;padding:4px 0}
.versions .number{min-width:96px;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
.empty{color:var(--muted)}
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${style}</style>
</head>
<body>
<main>
<header><a class="home" href="/">ace marketplace</a><a class="meta" href="/search">Search</a></header>
${body}
</main>
</body>
</html>
`;
}

export function searchForm(query = "", type = ""): string {
  const options = typeChoices
    .map(
      ([value, label]) =>
        `<option value="${escape(value)}"${value === type ? " selected" : ""}>${escape(label)}</option>`,
    )
    .join("");
  return `<form action="/search" method="get" role="search">
<input type="search" name="q" value="${escape(query)}" placeholder="Search marketplace" aria-label="Search marketplace">
<select name="type" aria-label="Type">${options}</select>
<button type="submit">Search</button>
</form>`;
}

/** What ace says about an entry's review, in words. */
export function reviewWords(entry: { reviewed: boolean; byAce: boolean }): string {
  if (entry.byAce) return "By ace";
  return entry.reviewed ? "Reviewed by ace" : "Not reviewed by ace";
}

export const entryPath = (entry: { type: string; name: string }) =>
  `/${encodeURIComponent(entry.type)}/${encodeURIComponent(entry.name)}`;

/** One list row: title, one line, then type and publisher in meta ink. */
export function entryRow(entry: FeedEntry): string {
  const meta = [typeName(entry.type), entry.publisher?.name].filter(Boolean).join(" · ");
  return `<li><a class="row" href="${escape(entryPath(entry))}"><span class="title">${escape(entry.title)}</span>${
    entry.line ? `<span class="line">${escape(entry.line)}</span>` : ""
  }<span class="meta">${escape(meta)}</span></a></li>`;
}

export function entryList(entries: readonly FeedEntry[], empty: string): string {
  if (entries.length === 0) return `<p class="empty">${escape(empty)}</p>`;
  return `<ul>${entries.map(entryRow).join("")}</ul>`;
}
