import { fields, statusLabel } from "./render.ts";
import { type Entry, type Identity, inOrder, type Registry } from "./types.ts";

/**
 * `out/runbook.html`: one self-contained page (no network) to keep open on a phone beside the
 * laptop. Ticking a field copies its value and remembers the tick in this browser.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const style = `
:root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --text: #1b1b1a; --muted: #6a6a66;
  --line: #e2e2de; --accent: #2457d6; --done: #1f7a4d; --warn: #a3500b; }
@media (prefers-color-scheme: dark) { :root { --bg: #121211; --card: #1c1c1b; --text: #ececea;
  --muted: #9b9b96; --line: #2f2f2d; --accent: #7aa2ff; --done: #5fc48f; --warn: #f0a35e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 16px 14px 64px; }
h1 { font-size: 1.4rem; margin: 8px 0 4px; } h2 { font-size: 1.15rem; margin: 0; }
p { margin: 6px 0; } .muted { color: var(--muted); font-size: .9rem; }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
td:first-child { overflow-wrap: anywhere; }
th:last-child, td:last-child { white-space: nowrap; text-align: right; }
th { color: var(--muted); font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px; margin: 16px 0; }
.head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.chip { font-size: .78rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
  white-space: nowrap; }
.chip.approved { color: var(--done); border-color: currentColor; }
.chip.blocked { color: var(--warn); border-color: currentColor; }
.open { display: inline-block; margin: 8px 0; padding: 10px 14px; border-radius: 8px;
  background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600; }
ul.fields { list-style: none; padding: 0; margin: 8px 0; }
ul.fields li { border-top: 1px solid var(--line); }
ul.fields label { display: flex; gap: 10px; align-items: flex-start; padding: 10px 2px;
  min-height: 44px; cursor: pointer; }
ul.fields input { width: 22px; height: 22px; margin: 2px 0 0; flex: none; accent-color: var(--done); }
.label { display: block; font-size: .8rem; color: var(--muted); }
code { font: .88rem/1.4 ui-monospace, "SF Mono", Menlo, monospace; overflow-wrap: anywhere; }
li.done code { color: var(--muted); text-decoration: line-through; }
.copied { color: var(--done); font-size: .8rem; margin-left: 6px; }
blockquote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--line); }
.progress { font-variant-numeric: tabular-nums; }
`;

const script = `
const ticked = (key) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const remember = (key, on) => {
  try { if (on) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch {}
};
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement("textarea"); area.value = text; document.body.append(area);
  area.select(); const ok = document.execCommand("copy"); area.remove(); return ok;
}
function progress(card) {
  const boxes = card.querySelectorAll("input[type=checkbox]");
  const done = [...boxes].filter((box) => box.checked).length;
  card.querySelector(".progress").textContent = done + "/" + boxes.length;
}
for (const card of document.querySelectorAll(".card")) {
  for (const box of card.querySelectorAll("input[type=checkbox]")) {
    const item = box.closest("li");
    box.checked = ticked(box.dataset.key);
    item.classList.toggle("done", box.checked);
    box.addEventListener("change", async () => {
      remember(box.dataset.key, box.checked);
      item.classList.toggle("done", box.checked);
      progress(card);
      if (!box.checked) return;
      const ok = await copy(item.querySelector("code").textContent);
      const note = document.createElement("span");
      note.className = "copied"; note.textContent = ok ? "Copied" : "Copy failed";
      item.querySelector(".label").append(note); setTimeout(() => note.remove(), 1500);
    });
  }
  progress(card);
}
`;

function fieldList(entry: Entry, app: Identity): string {
  const items = fields(entry, app).map(
    (field, index) =>
      `<li><label><input type="checkbox" data-key="spade-runbook:${entry.id}:${index}"><span>` +
      `<span class="label">${escapeHtml(field.label)}</span><code>${escapeHtml(field.value)}</code>` +
      `</span></label></li>`,
  );
  return `<ul class="fields">${items.join("")}</ul>`;
}

function card(entry: Entry, app: Identity): string {
  const parts = [
    `<section class="card" id="${escapeHtml(entry.id)}">`,
    `<div class="head"><h2>${escapeHtml(entry.name)}</h2>` +
      `<span class="chip ${entry.status}">${statusLabel[entry.status]}</span></div>`,
    `<p class="muted">About ${entry.minutes} minutes · <span class="progress"></span> ticked` +
      (entry.blocked_on ? ` · Blocked on: ${escapeHtml(entry.blocked_on)}` : "") +
      `</p>`,
  ];
  if (entry.kind === "approval") {
    parts.push(`<p>${escapeHtml(entry.channel)}</p>`);
    if (entry.console)
      parts.push(
        `<a class="open" href="${escapeHtml(entry.console)}" target="_blank" rel="noreferrer">Open the form</a>`,
      );
    parts.push(`<blockquote>${escapeHtml(entry.ask)}</blockquote>`);
  } else {
    parts.push(`<p>${escapeHtml(entry.where)}</p>`);
    parts.push(
      `<a class="open" href="${escapeHtml(entry.console)}" target="_blank" rel="noreferrer">Open the console</a>`,
    );
  }
  parts.push(fieldList(entry, app));
  if (entry.kind === "broker")
    parts.push(
      `<p class="muted">Run the secret commands from <code>apps/cloud</code>; wrangler asks for each value. ` +
        `They are ${entry.secrets.map((name) => `<code>${escapeHtml(name)}</code>`).join(" and ")}.</p>`,
    );
  if (entry.notes.length)
    parts.push(`<ul>${entry.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`);
  parts.push(`</section>`);
  return parts.join("\n");
}

function board(entries: readonly Entry[]): string {
  const rows = entries.map((entry) => {
    const blocked = entry.blocked_on
      ? `<span class="label">Blocked on: ${escapeHtml(entry.blocked_on)}</span>`
      : "";
    return (
      `<tr><td><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</a>${blocked}</td>` +
      `<td><span class="chip ${entry.status}">${statusLabel[entry.status]}</span></td>` +
      `<td>${entry.minutes}</td></tr>`
    );
  });
  const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  return (
    `<table><thead><tr><th>Registration</th><th>Status</th><th>Min</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table><p class="muted">About ${total} minutes of typing in all.</p>`
  );
}

export function renderRunbook(registry: Registry): string {
  const entries = inOrder(registry);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Spade connector registrations</title><style>${style}</style></head><body><main>`,
    "<h1>Spade connector registrations</h1>",
    `<p class="muted">Generated by <code>bun run docs:connectors</code>. Tick a field to copy it. ` +
      `Secrets are never on this page: wrangler asks for them. Slack alone can be created by ` +
      `command: <code>bun run docs:connectors slack --yes</code>.</p>`,
    board(entries),
    ...entries.map((entry) => card(entry, registry.app)),
    `</main><script>${script}</script></body></html>`,
    "",
  ].join("\n");
}
