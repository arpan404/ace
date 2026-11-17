import { marketPublishFixture, type FakeDaemon } from "@ace/fake-daemon";
import type { MarketScanReport } from "@ace/protocol/marketplace";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { entry, findMarket, openApp, seed } from "./market-test-seed.ts";

/* Discover's ranked sections, publisher pages, your profile, publishing and managing (ADR 0174). */

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const scan = (verdict: "pass" | "block"): MarketScanReport => ({
  format: "ace-market-scan",
  scanner: 1,
  verdict,
  runnable: false,
  checks: [
    {
      id: "scripts",
      verdict,
      sentence:
        verdict === "block" ? "A script downloads code and runs it." : "No script runs downloads.",
      findings: verdict === "block" ? 1 : 0,
    },
  ],
  findings:
    verdict === "block"
      ? [
          {
            check: "scripts",
            rule: "download-exec",
            level: "block",
            path: "scripts/setup.sh",
            line: 4,
            message: "scripts/setup.sh line 4 downloads a script and runs it",
          },
        ]
      : [],
  truncated: false,
  read: { files: 3, textBytes: 1800 },
});

async function ownVersions(daemon: FakeDaemon, type: "suit", name: string) {
  const reply = await daemon.marketplace.handle({
    type: "marketplace.request",
    requestId: "check",
    operation: { op: "publish", request: { action: "entry", type, name } },
  });
  if (reply.type !== "marketplace.result") throw new Error("no answer");
  const result = reply.result;
  if (result.op !== "publish" || result.answer.kind !== "entry") throw new Error("no entry");
  return result.answer.entry.versions.map((version) => [version.version, version.status]);
}

test("trending renders in rank order, each with how it moved since last week", async () => {
  const fixture = marketPublishFixture();
  const discover = fixture.discover;
  if (!discover) throw new Error("the fixture has Discover");
  await openApp("/chats?market=discover", {
    publishing: {
      ...fixture,
      discover: {
        ...discover,
        // Out of order on purpose: the page ranks them.
        trending: [
          {
            entry: entry("suit", "harbour-dusk", "Harbour dusk"),
            rank: 2,
            movement: { kind: "down", by: 1 },
            week: 9,
          },
          {
            entry: entry("spade-bot", "inbox", "Inbox"),
            rank: 3,
            movement: { kind: "new" },
            week: 4,
          },
          {
            entry: entry("spade-skill", "triage-mail", "Triage mail"),
            rank: 1,
            movement: { kind: "up", by: 3 },
            week: 20,
          },
        ],
      },
    },
  });
  const market = await findMarket();
  const trending = within(await within(market).findByRole("list", { name: "Trending this week" }));
  const rows = trending.getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^1.*Triage mail/),
    expect.stringMatching(/^2.*Harbour dusk/),
    expect.stringMatching(/^3.*Inbox/),
  ]);
  expect(within(rows[0] as HTMLElement).getByLabelText("Up 3")).toBeTruthy();
  expect(within(rows[1] as HTMLElement).getByLabelText("Down 1")).toBeTruthy();
  expect(within(rows[2] as HTMLElement).getByText("New")).toBeTruthy();
});

test("a publisher's page lists their entries, and a byline opens it", async () => {
  await openApp("/chats?market=discover", {
    entries: [
      ...(seed.entries ?? []),
      {
        summary: entry("suit", "night-ferry", "Night ferry", {
          publisher: { id: "pub_lighthouse", name: "lighthouse" },
        }),
      },
    ],
    publishing: marketPublishFixture(),
  });
  const market = await findMarket();
  const looks = within(await within(market).findByRole("region", { name: "Looks" }));
  await userEvent.click(await looks.findByRole("button", { name: "Published by lighthouse" }));

  expect(await within(market).findByRole("heading", { level: 1, name: "Lighthouse" })).toBeTruthy();
  const listed = within(within(market).getByRole("list", { name: "Looks" }));
  expect(listed.getByText("Night ferry")).toBeTruthy();
});

test("signed out, the bar and the profile say to sign in to publish", async () => {
  await openApp("/chats?market=discover", { publishing: { signedOut: true } });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: "Sign in to publish" }));

  expect(
    await within(market).findByText("Sign in to publish", { selector: ".mk-name" }),
  ).toBeTruthy();
  expect(within(market).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
    "/settings/profile",
  );
  expect(within(market).queryByRole("button", { name: "Publish something" })).toBeNull();
});

test("publishing holds Next on a failed check until Check again passes", async () => {
  await openApp("/chats?market=publish", {
    publishing: {
      ...marketPublishFixture(),
      scans: { "spade-skill/sort-receipts": [scan("block"), scan("pass")] },
    },
  });
  const market = await findMarket();
  await userEvent.click(
    await within(market).findByRole("button", { name: /Instructions and scripts a bot can use/ }),
  );
  await userEvent.click(await within(market).findByRole("button", { name: "Choose a folder…" }));
  await userEvent.type(within(market).getByLabelText("Name in the marketplace"), "sort-receipts");
  await userEvent.type(within(market).getByLabelText("Folder on this machine"), "/Users/me/sort");
  await userEvent.click(within(market).getByRole("button", { name: "Next" }));

  expect(await within(market).findByText("A script downloads code and runs it.")).toBeTruthy();
  expect(
    within(market).getByText("scripts/setup.sh line 4 downloads a script and runs it."),
  ).toBeTruthy();
  expect(within(market).getByText("1 check to fix before you publish.")).toBeTruthy();
  const next = within(market).getByRole("button", { name: "Next" });
  expect(next.hasAttribute("disabled")).toBe(true);
  await userEvent.click(next);
  expect(within(market).queryByLabelText("Description")).toBeNull();

  await userEvent.click(within(market).getByRole("button", { name: "Check again" }));
  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  await userEvent.click(within(market).getByRole("button", { name: "Next" }));
  expect(await within(market).findByLabelText("Description")).toBeTruthy();
  await userEvent.click(within(market).getByRole("button", { name: "Publish" }));
  expect(await within(market).findByText("sort-receipts is waiting for review")).toBeTruthy();
});

test("withdrawing a version asks first, and only the confirmation withdraws it", async () => {
  const app = await openApp("/chats?market=me/suit/harbour-dusk", {
    publishing: marketPublishFixture(),
  });
  const market = await findMarket();
  const version = within(await within(market).findByRole("listitem", { name: "Version 1.2.0" }));
  await userEvent.click(version.getByRole("button", { name: "Withdraw" }));

  const ask = within(within(market).getByRole("group", { name: "Withdraw 1.2.0" }));
  expect(await ownVersions(app.daemon, "suit", "harbour-dusk")).toContainEqual(["1.2.0", "live"]);
  expect(ask.getByRole("button", { name: "Withdraw" }).hasAttribute("disabled")).toBe(true);

  await userEvent.type(
    ask.getByLabelText("Why you're withdrawing it"),
    "It hides the status colours.",
  );
  await userEvent.click(ask.getByRole("button", { name: "Withdraw" }));
  await waitFor(async () =>
    expect(await ownVersions(app.daemon, "suit", "harbour-dusk")).toContainEqual([
      "1.2.0",
      "withdrawn",
    ]),
  );
  expect(
    await within(await within(market).findByRole("listitem", { name: "Version 1.2.0" })).findByText(
      "Withdrawn",
    ),
  ).toBeTruthy();
});

test("the By ace mark shows only for ace's own publisher by the signed list", async () => {
  await openApp("/chats?market=tools", {
    entries: [
      {
        summary: entry("spade-skill", "official", "Official", {
          byAce: true,
          publisher: { id: "pub_ace", name: "ace" },
        }),
      },
      // The index claims the name; the daemon found no signed list naming it.
      {
        summary: entry("spade-skill", "lookalike", "Lookalike", {
          publisher: { id: "pub_x", name: "ace" },
        }),
      },
    ],
  });
  const market = await findMarket();
  const skills = within(await within(market).findByRole("list", { name: "Skills" }));
  await skills.findByText("Lookalike");
  const official = skills.getByText("Official").closest(".mk-card") as HTMLElement;
  const lookalike = skills.getByText("Lookalike").closest(".mk-card") as HTMLElement;

  expect(within(official).getByLabelText("By ace")).toBeTruthy();
  expect(within(official).getByRole("img", { name: "Verified by ace" })).toBeTruthy();
  expect(within(lookalike).queryByLabelText("By ace")).toBeNull();
  expect(within(lookalike).queryByRole("img", { name: "Verified by ace" })).toBeNull();
});

test("an entry this device's scan blocks can't be installed, and says why", async () => {
  const app = await openApp("/chats?market=skill/setup-mail/review", {
    entries: [
      { summary: entry("spade-skill", "setup-mail", "Setup mail"), blocked: scan("block") },
    ],
  });
  const market = await findMarket();
  expect(
    await within(market).findByText(
      "ace's scan on this device refused it, so it can't be installed.",
    ),
  ).toBeTruthy();
  expect(
    within(market).getByText("scripts/setup.sh line 4 downloads a script and runs it."),
  ).toBeTruthy();
  expect(within(market).queryByRole("button", { name: "Install" })).toBeNull();
  expect(app.daemon.marketplace.accepted).toEqual([]);
});
