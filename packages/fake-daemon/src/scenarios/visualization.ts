import type { Scenario } from "../scenario.ts";
import { explainerHtml } from "./explainer-page.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

/** A published chat visualization: text, theme tokens and SVG bars with fixed and themed fills. */
const glacierHtml =
  '<!doctype html><html><head><title>Glacier mass loss</title><style>.chart{display:grid;gap:8px;padding:12px;border:1px solid var(--border);border-radius:var(--radius)}.chart p{margin:0;color:var(--muted-foreground)}text{fill:var(--muted-foreground);font-size:12px}</style></head><body><div class="chart"><strong>Annual glacier mass loss (Gt)</strong><p>Fixed colours on the left, theme chart colours on the right.</p><svg viewBox="0 0 280 120" width="280" height="120" role="img" aria-label="Glacier mass loss by period"><rect x="10" y="50" width="50" height="50" fill="#e07a2e"/><rect x="80" y="30" width="50" height="70" fill="#2e86e0"/><rect x="150" y="20" width="50" height="80" style="fill:var(--chart-1)"/><rect x="220" y="5" width="50" height="95" style="fill:var(--chart-2)"/><text x="10" y="115">2000</text><text x="80" y="115">2010</text><text x="150" y="115">2020</text><text x="220" y="115">2023</text></svg></div></body></html>';

interface PublishedPage {
  threadId: string;
  html: string;
  /** SHA-256 of the UTF-8 html; the fake attachment store serves it by this hash. */
  sha256: string;
  title: string;
  threadTitle: string;
  ask: string;
  reply: string;
}

export const fixtureVisualization: PublishedPage = {
  threadId: "thread-visualization",
  html: glacierHtml,
  sha256: "140787ad272ad7f66a107953a7e407448f11335548eb77c605471b130f87ddd3",
  title: "Glacier mass loss",
  threadTitle: "Chart glacier mass loss",
  ask: "Create an HTML visualisation of glacier mass loss.",
  reply: "Losses accelerate after 2010; the 2023 bar is the largest annual loss on record.",
};

/** An interactive learning page: a slider, a step-through and a quick check. */
export const fixtureExplainer: PublishedPage = {
  threadId: "thread-explainer",
  html: explainerHtml,
  sha256: "95bd1269754fbcc3bbc5b3f75c79bea3709ae0f7a3f5b3974c5fb8c96ec520b7",
  title: "Binary search, step by step",
  threadTitle: "Explain binary search",
  ask: "Explain how binary search works. Make it interactive so I can try it.",
  reply:
    "Each comparison discards half of what is left, so 16 items take at most 5 steps and a million take about 20. A linear scan has to walk the list until it hits the value.",
};

export const publishedPages = [fixtureVisualization, fixtureExplainer];

/** One completed ace MCP call, as Claude Code reports it. */
function aceCall(key: string, name: string, args: Record<string, unknown>) {
  return [
    tool("root", key, {
      kind: "mcp",
      title: `mcp__ace__${name}`,
      detail: { kind: "mcp", server: "ace", tool: name, arguments: args },
    }),
    toolDone("root", key),
  ];
}

/** An agent previewed and published one HTML page, then answered under it. */
function published(page: PublishedPage): Scenario {
  const bytes = new TextEncoder().encode(page.html).byteLength;
  return {
    thread: { id: page.threadId, workspaceId: "acme", title: page.threadTitle, provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", page.ask),
          ...aceCall("preview", "ace_html_preview", { html: "…" }),
          ...aceCall("render", "ace_html_render", { title: page.title, html: "…" }),
          {
            type: "item.upsert",
            agent: "root",
            item: "page",
            draft: {
              type: "html",
              complete: true,
              visualization: {
                title: page.title,
                document: {
                  sha256: page.sha256,
                  bytes,
                  name: "visualization.html",
                  mimeType: "text/plain",
                },
              },
            },
          },
          message("root", "done", "assistant", page.reply),
          endTurn("root"),
        ],
      },
    ],
  };
}

export function visualization(): Scenario {
  return published(fixtureVisualization);
}

export function explainer(): Scenario {
  return published(fixtureExplainer);
}
