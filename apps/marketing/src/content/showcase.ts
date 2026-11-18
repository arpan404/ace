import type { ProviderKind } from "@ace/protocol";
import { route } from "./routes.ts";

/*
 * The home page's showcase: five things agents do in ace, each a tile with a piece of the app
 * drawn in it (components/home/Showcase.astro). The words live here; a tile whose feature has
 * a page links to it.
 */

export type ShowcaseId = "browser" | "review" | "devices" | "accounts" | "automations";

export interface ShowcaseTile {
  id: ShowcaseId;
  title: string;
  body: string;
  href?: string;
}

const page = (path: string) => route(path).path;

export const showcase = {
  heading: "Give them real tools.",
  lede: "Every agent gets the same tools in ace, whichever CLI it runs in.",
  tiles: [
    {
      id: "browser",
      title: "A real browser",
      body: "Agents click through your app in ace's browser. Watch, take over or stop them at any time.",
      href: page("/features/browser/"),
    },
    {
      id: "review",
      title: "Review, like a teammate's work",
      body: "Each thread works in its own git worktree. Read the diff, comment on lines, then commit and push.",
      href: page("/features/review/"),
    },
    {
      id: "devices",
      title: "Simulators and phones",
      body: "Agents tap through iOS Simulators, Android emulators and real Android phones, even ones on another machine.",
      href: page("/features/devices/"),
    },
    {
      id: "accounts",
      title: "Limits don't stop the work",
      body: "Sign in to several accounts per provider. When one runs out, the thread moves to another.",
      href: page("/features/accounts/"),
    },
    {
      id: "automations",
      title: "Work that starts itself",
      body: "Run a prompt on a schedule, on a GitHub event, when files change or when a webhook calls.",
    },
  ] satisfies ShowcaseTile[],
};

/** The automations the tile lists: what runs, what starts it and which agent does it. */
export const sampleAutomations: { name: string; when: string; provider: ProviderKind }[] = [
  { name: "Nightly flaky-test sweep", when: "Every night at 2:00", provider: "codex" },
  { name: "Triage new issues", when: "When an issue opens on GitHub", provider: "claude" },
  { name: "Rebuild the docs", when: "When files change in docs/", provider: "opencode" },
  { name: "Smoke test the deploy", when: "When the deploy webhook calls", provider: "cursor" },
];
