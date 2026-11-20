import { describe, expect, it } from "vitest";
import { checkBot } from "./checks/bot.ts";
import { checkFiles } from "./checks/index.ts";
import { disposition, scanEntry } from "./scan/index.ts";
import { folder } from "./testing.ts";

/*
 * A package's panels (ADR 0200 §5.2) at the market: each declared panel is one self-contained page
 * in its folder, a page that reaches outside its sandbox is refused, and a version with a panel is
 * held for a maintainer, as a Suit's scene is.
 */

const page = `<!doctype html><html><head><title>Watched trips</title></head><body>
<ul id="trips"></ul>
<script>addEventListener('ace:state', (event) => {
  document.getElementById('trips').textContent = JSON.stringify(event.detail);
});</script></body></html>`;

const bot = (surfaces: unknown) =>
  JSON.stringify({
    format: "spade-bot",
    version: 3,
    requires: { runtime: "1" },
    name: "Flight watcher",
    blurb: "Watches fares.",
    task: "You watch flight fares for the person.",
    tests: ["tests/watch.json"],
    surfaces,
  });

const watchlist = [
  {
    id: "watchlist",
    kind: "panel",
    file: "panels/watchlist/index.html",
    title: "Watched trips",
    state: {
      type: "object",
      properties: {
        trips: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
      },
    },
    actions: [{ name: "check_now", label: "Check now" }],
  },
];

const files = (extra: Record<string, string>) =>
  folder({ "bot.json": bot(watchlist), "tests/watch.json": "{}", ...extra });
const messages = (extra: Record<string, string>) =>
  checkBot(files(extra)).problems.map((problem) => `${problem.path}: ${problem.message}`);

describe("a package's panels at the market", () => {
  it("pass with their one page in its folder", () => {
    expect(messages({ "panels/watchlist/index.html": page })).toEqual([]);
  });

  it("are refused when the declared page isn't in the package", () => {
    expect(messages({})).toEqual([
      "panels/watchlist/index.html: panels/watchlist/index.html is declared in surfaces but isn't in the package",
    ]);
  });

  it("refuse a page that loads something from outside it", () => {
    const outside = page.replace("<ul", '<script src="https://cdn.example.com/x.js"></script><ul');
    expect(messages({ "panels/watchlist/index.html": outside }).join(" ")).toContain(
      "external requests are blocked",
    );
  });

  it("refuse a file in panels/ that no panel would serve", () => {
    expect(
      messages({ "panels/watchlist/index.html": page, "panels/watchlist/style.css": "body{}" }),
    ).toEqual([
      "panels/watchlist/style.css: panels/watchlist/style.css isn't a declared panel's page: a panel is one page, panels/<id>/index.html, with its styles, scripts and images inline",
    ]);
  });

  it("hold a version with a panel for a maintainer and block a page reaching out", () => {
    const scan = (pageText: string) => {
      const archive = files({ "panels/watchlist/index.html": pageText });
      const checked = checkFiles("spade-bot", "flight-watcher", archive);
      return scanEntry({
        type: "spade-bot",
        name: "flight-watcher",
        files: archive,
        listing: checked.listing,
        inspection: checked.inspection,
        context: { entries: [], verified: [] },
      });
    };
    const clean = scan(page);
    expect(clean.runnable).toBe(true);
    expect(
      disposition(clean, {
        newPublisher: false,
        firstVersion: false,
        official: false,
        approved: false,
      }),
    ).toBe("hold");
    const leaking = scan(page.replace("<ul", '<img src="https://track.example.com/p.gif"><ul'));
    expect(leaking.checks.find((check) => check.id === "scene")?.verdict).toBe("block");
  });
});
