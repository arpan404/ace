import { downloadPage } from "../content/download.ts";
import { product } from "../content/product.ts";
import { spadePage } from "../content/spade.ts";

/*
 * The social cards: the image a link to the site shows when it is shared. Each is a page laid
 * out at exactly 1200 by 630 (pages/og/[name].astro), photographed to a PNG by scripts/og.ts.
 * The home card is /og.png; every other card is /og/<name>.png and belongs to one page.
 *
 * The features, agents, MCP and security headlines repeat their pages' own opening lines, which
 * are written in the page files rather than a content file; change both together.
 */

export interface Card {
  name: string;
  /** The page this card is shown for. */
  path: string;
  headline: string;
  /** One line under the headline. */
  line: string;
}

export const cardSize = { width: 1200, height: 630 } as const;

export const cards: Card[] = [
  {
    name: "home",
    path: "/",
    headline: product.headline,
    line: "Claude Code, Codex, Cursor and every agent you use, as one team on your own machines.",
  },
  {
    name: "features",
    path: "/features/",
    headline: "Everything your agents need beyond the terminal.",
    line: "Computer use, a real browser, simulators, other machines and a status you can trust.",
  },
  {
    name: "agents",
    path: "/agents/",
    headline: "Every coding agent you use, in one app.",
    line: "Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi and any ACP agent.",
  },
  {
    name: "spade",
    path: "/spade/",
    headline: spadePage.headline,
    line: "Spade, ace's own assistant: bots with a face, a task, a model and a machine.",
  },
  {
    name: "download",
    path: "/download/",
    headline: downloadPage.headline,
    line: "Free and open source, for Mac, Windows and Linux, with apps for iPhone and iPad.",
  },
  {
    name: "mcp",
    path: "/mcp/",
    headline: "One MCP toolset for every agent.",
    line: "Delegate, drive a browser, use desktop apps and simulators, in every CLI.",
  },
  {
    name: "security",
    path: "/security/",
    headline: "Your code, your machines, your keys.",
    line: "Agents run on your computers. ace never collects or proxies provider credentials.",
  },
];

/** Where a card's image is served: the home card at /og.png, the rest under /og/. */
export function cardImage(card: Card): string {
  return card.name === "home" ? "/og.png" : `/og/${card.name}.png`;
}

/** The card for a page: its own when it has one, else the home card. */
export function cardFor(path: string): { image: string; alt: string } {
  const card = cards.find((entry) => entry.path === path) ?? cards[0];
  if (!card) return { image: "/og.png", alt: product.headline };
  return { image: cardImage(card), alt: cardAlt(card) };
}

/** What the image shows, for og:image:alt and twitter:image:alt. */
export function cardAlt(card: Card): string {
  return `${card.headline} ${card.line} The ace logo and its mark drawn in the letters a, c and e, on black.`;
}
