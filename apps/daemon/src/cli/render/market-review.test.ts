import { expect, it } from "vitest";
import type { MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { installQuestion, reviewLines } from "./market-review.ts";

const hash = "a".repeat(64);
function review(overrides: Partial<MarketReview> = {}): MarketReview {
  return {
    id: "rv-1",
    source: "market",
    type: "spade-plugin",
    name: "linear-sync",
    title: "Linear Sync",
    version: "0.4.1",
    hash,
    publisher: { id: "pub_1", name: "arpan" },
    signed: true,
    reviewed: true,
    byAce: false,
    body: { type: "spade-plugin", pluginName: "linear-sync", executions: 2, unsupported: 0 },
    expiresAt: 0,
    items: 2,
    ...overrides,
  };
}
const items: MarketReviewItem[] = [
  {
    kind: "execution",
    section: "",
    execution: {
      kind: "stdio",
      name: "linear",
      command: "npx",
      args: ["-y", "linear-mcp"],
      env: {},
    },
  },
  {
    kind: "execution",
    section: "",
    execution: {
      kind: "remote",
      name: "api",
      type: "http",
      url: "https://api.linear.app/mcp",
      headers: {},
    },
  },
];

it("asks to install by what it runs and reaches", () => {
  expect(installQuestion(review(), items)).toBe(
    "Install spade-plugin/linear-sync 0.4.1? It runs one MCP server and reaches api.linear.app.",
  );
});

it("says who published it, that it is signed and reviewed, and what it runs and reaches", () => {
  const lines = reviewLines(review(), items);
  expect(lines).toContain("By @arpan. Signed, reviewed by ace.");
  expect(lines).toContain("It runs: linear (npx -y linear-mcp).");
  expect(lines).toContain("It reaches: api.linear.app.");
});

it("an unsigned entry from a git catalog says so", () => {
  const lines = reviewLines(
    review({
      publisher: undefined,
      from: "https://git.example/catalog",
      signed: false,
      reviewed: false,
    }),
    [],
  );
  expect(lines).toContain("From https://git.example/catalog. Not signed, not reviewed by ace.");
});

it("the device scan's findings read as sentences, notes left out", () => {
  const lines = reviewLines(
    review({
      scan: {
        format: "ace-market-scan",
        scanner: 1,
        verdict: "warn",
        checks: [],
        findings: [
          {
            check: "scripts",
            rule: "dynamic-url",
            level: "warn",
            path: "server.js",
            line: 12,
            message: "It reaches an address it builds at run time.",
          },
          { check: "scripts", rule: "fetch", level: "note", message: "It uses fetch." },
        ],
        runnable: true,
        truncated: false,
        read: { files: 2, textBytes: 400 },
      },
    }),
    items,
  );
  expect(lines).toContain("The scan found one thing to know:");
  expect(lines).toContain("  server.js line 12: It reaches an address it builds at run time.");
  expect(lines.join("\n")).not.toContain("It uses fetch.");
});

it("an update says what changed since the installed version", () => {
  const changes: MarketReviewItem[] = [
    { kind: "change", section: "", path: "server.js", change: "changed", executable: false },
    { kind: "change", section: "", path: "hooks/pre.sh", change: "added", executable: true },
  ];
  const lines = reviewLines(review({ updates: "0.4.0" }), changes);
  expect(lines).toContain("What changed since 0.4.0: changed server.js, added hooks/pre.sh.");
  expect(installQuestion(review({ updates: "0.4.0" }), [])).toBe(
    "Update spade-plugin/linear-sync to 0.4.1?",
  );
});

it("a bot's routines are named as off until started, and its needs are listed", () => {
  const lines = reviewLines(
    review({
      type: "spade-bot",
      body: {
        type: "spade-bot",
        botName: "Inbox",
        task: "Sorts mail.",
        model: "fast",
        routines: [{ name: "Morning", instruction: "Sort", schedule: "daily 8:00" }],
        notes: [],
        brings: [],
        needs: [
          {
            key: "connector:gmail",
            kind: "connector",
            label: "Gmail",
            why: "To read mail.",
            required: true,
          },
        ],
        spadeReady: false,
      },
    }),
    [],
  );
  expect(lines).toContain("Its routines (off until you start them): Morning (daily 8:00).");
  expect(lines).toContain("It needs Gmail: To read mail.");
  expect(lines).toContain("Spade isn't running, so the install waits for it.");
});

it("a blocked review ends with why it can't be installed", () => {
  const lines = reviewLines(review({ blocked: "This Suit fails ace's checks." }), []);
  expect(lines.at(-1)).toBe("It can't be installed: This Suit fails ace's checks.");
});
