import { FakeDaemon } from "@ace/fake-daemon";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { SignInLanding, signInLandingStatus } from "@/features/connect/sign-in-landing.tsx";
import { settingsPages as listedPages } from "@/features/settings/settings-pages.ts";
import { fakeSuit, fakeSuitLibrary } from "@/test/fake-suits.ts";
import { fakeClient, harness, memoryKeyValue } from "@/test/harness.tsx";

/*
 * The Suit styling contract (ADR 0150, docs/design/suit-parts.md) for Settings and the account,
 * setup and connection screens: each test renders a page with fake data and fails when the page
 * stops naming itself (`data-page`, `data-variant`) or stops drawing one of the parts listed for it.
 */

beforeEach(() => localStorage.clear());

/** The parts listed for a page that its `page` element doesn't draw, or why it can't be checked. */
function missingIn(page: string, variant: string, parts: readonly string[]): string[] {
  const root = document.querySelector(
    `[data-part="page"][data-page="${page}"][data-variant="${variant}"]`,
  );
  if (!root) return [`page ${page}/${variant}`];
  const shown = new Set(
    [...root.querySelectorAll("[data-part]")].map((element) => {
      const name = element.getAttribute("data-part");
      const named = element.getAttribute("data-variant");
      return named ? `${name}:${named}` : name;
    }),
  );
  const drawn = (part: string) =>
    shown.has(part) ||
    (!part.includes(":") && [...shown].some((each) => each?.startsWith(`${part}:`)));
  return parts.filter((part) => !drawn(part));
}

/** Every page names its frame the same way. */
const frame = ["page-header", "page-title", "page-body"] as const;

const settingsPages: readonly { path: string; variant: string; parts: readonly string[] }[] = [
  {
    path: "/settings/agents",
    variant: "agents",
    parts: [
      ...frame,
      "settings-section",
      "settings-row",
      "card:settings-group",
      "switch",
      "switch-thumb",
      "select",
    ],
  },
  {
    path: "/settings/appearance",
    variant: "appearance",
    parts: [
      ...frame,
      "list:mode",
      "list:theme",
      "list:accent",
      "card:picker",
      "card:preview",
      "card:accent",
      "segmented",
      "segment",
    ],
  },
  {
    path: "/settings/providers",
    variant: "providers",
    parts: [...frame, "page-toolbar", "settings-section", "list-row:provider"],
  },
  {
    path: "/settings/providers/claude",
    variant: "providers",
    parts: [...frame, "list", "list-row:account", "avatar:account", "list-row:action"],
  },
  {
    path: "/settings/profile",
    variant: "profile",
    parts: [...frame, "avatar", "stat:highlight", "chart:activity"],
  },
  {
    path: "/settings/storage",
    variant: "storage",
    parts: [...frame, "settings-row", "progress:storage"],
  },
  {
    path: "/settings/remote",
    variant: "remote",
    parts: [...frame, "settings-section", "list", "list-row", "avatar:tile"],
  },
  {
    path: "/settings/remote/map",
    variant: "remote",
    parts: [...frame, "chart:fleet-map"],
  },
];

test.each(settingsPages)("Settings $path names its page, frame, groups and rows", async (page) => {
  await harness({ machines: [{ hostId: "build", name: "Build server" }] }).open(page.path);
  await screen.findByRole("navigation", { name: "Settings pages" });
  await waitFor(() => expect(missingIn("settings", page.variant, page.parts)).toEqual([]));
});

/**
 * The buttons and links inside Settings' rows and sections that name no part, as
 * `<page> "<words>"`: each one is a `button` (with its variant), a `link` or another control part.
 */
function unnamedControls(path: string): string[] {
  const holders =
    '[data-part="settings-row"], [data-part="settings-section"], [data-part="list-row"]';
  return [...document.querySelectorAll<HTMLElement>(`:is(${holders}) :is(button, a[href])`)]
    .filter((control) => !control.hasAttribute("data-part"))
    .map(
      (control) => `${path} "${control.getAttribute("aria-label") ?? control.textContent?.trim()}"`,
    );
}

/** Every page in Settings' list, and the drift list's pages under them. */
const auditedPages = [
  ...new Set([...listedPages.map((page) => page.to), ...settingsPages.map((page) => page.path)]),
];

test.each(auditedPages)("every button and link in Settings %s names its part", async (path) => {
  await harness({ machines: [{ hostId: "build", name: "Build server" }] }).open(path);
  await screen.findByRole("navigation", { name: "Settings pages" });
  await waitFor(() =>
    expect(document.querySelector('[data-part="page-body"] [data-part]')).not.toBeNull(),
  );
  expect(unnamedControls(path)).toEqual([]);
});

test("Appearance's Suits name their buttons, Make one with an agent a secondary one", async () => {
  await harness({ suits: fakeSuitLibrary([fakeSuit({ id: "sunset" })]).transport }).open(
    "/settings/appearance",
  );
  const make = await screen.findByRole("link", { name: "Make one with an agent" });
  expect(make.getAttribute("data-part")).toBe("button");
  expect(make.getAttribute("data-variant")).toBe("secondary");
  expect(unnamedControls("/settings/appearance")).toEqual([]);
});

test("a picked theme and the chosen mode carry the checked state", async () => {
  await harness().open("/settings/appearance");
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-part="card"][data-variant="picker"][data-state="checked"]')
        .length,
    ).toBe(2),
  );
});

test("first-run setup names its page, provider rows, progress and steps", async () => {
  await harness({ onboarding: "pending" }).open("/setup");
  await screen.findByRole("heading", { name: "Connect your agents" });
  await waitFor(() =>
    expect(
      missingIn("setup", "providers", [
        ...frame,
        "page-toolbar",
        "list:providers",
        "list-row:provider",
        "progress",
        "progress:steps",
      ]),
    ).toEqual([]),
  );
});

test("the connect screen names its page, card and title", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "ab".repeat(32) });
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local: memoryKeyValue(), session: memoryKeyValue() }}
        defaultUrl="ws://127.0.0.1:4242/"
        createClient={(target) => fakeClient(daemon, target.token)}
        forgetIdentity={async () => {}}
      >
        {() => null}
      </ConnectionGate>
    </AppFrame>,
  );
  await screen.findByRole("heading", { name: "Connect to ace" });
  expect(missingIn("connect", "connect", ["card:connect", "page-header", "page-title"])).toEqual(
    [],
  );
});

test("the sign-in landing names its page", () => {
  render(<SignInLanding status={signInLandingStatus("?status=signed-in")} close={() => {}} />);
  expect(missingIn("sign-in", "landing", ["card:connect", "page-title"])).toEqual([]);
});
