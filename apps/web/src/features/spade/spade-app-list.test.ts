import type { SpadeCatalogueEntry } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import { appSections } from "./spade-app-list.ts";
import { readRecentApps, rememberRecentApp, type RecentStorage } from "./spade-recent-apps.ts";

const app = (
  id: string,
  name: string,
  category: SpadeCatalogueEntry["category"],
  ready: SpadeCatalogueEntry["ready"] = "sign_in",
  notes = "",
): SpadeCatalogueEntry => ({
  id,
  name,
  category,
  ready,
  notes,
  url: `https://mcp.${id}.example/mcp`,
  signIn: ["oauth"],
  via: undefined,
  keyUrl: undefined,
});

const catalogue = [
  app("slack", "Slack", "mail_chat", "later"),
  app("gmail", "Gmail", "mail_chat", "later", "Reads mail and writes drafts."),
  app("resend", "Resend", "mail_chat", "sign_in", "Sends email from your domains."),
  app("render", "Render", "code", "key"),
  app("railway", "Railway", "code"),
  app("github", "GitHub", "code", "key"),
  app("stripe", "Stripe", "money"),
];

const names = (sections: ReturnType<typeof appSections>) =>
  sections.map((section) => [section.title, section.entries.map((entry) => entry.name)]);

const none = { text: "", filter: "all" as const, added: new Set<string>(), recent: [] };

test("without a search, apps sit under their categories, those that connect now first", () => {
  expect(names(appSections(catalogue, none))).toEqual([
    ["Mail & chat", ["Resend", "Gmail", "Slack"]],
    ["Code", ["Railway", "GitHub", "Render"]],
    ["Money", ["Stripe"]],
  ]);
});

test("apps already added lead, then the ones reached for lately, each shown once", () => {
  const sections = appSections(catalogue, {
    ...none,
    added: new Set(["stripe", "github"]),
    recent: ["slack", "github", "gone"],
  });
  expect(names(sections)).toEqual([
    ["Your apps", ["GitHub", "Stripe"]],
    ["Recent", ["Slack"]],
    ["Mail & chat", ["Resend", "Gmail"]],
    ["Code", ["Railway", "Render"]],
  ]);
});

test("a search looks across every category, names first, then categories and notes", () => {
  expect(names(appSections(catalogue, { ...none, text: "  RAIL ", filter: "money" }))).toEqual([
    [undefined, ["Railway"]],
  ]);
  // "mail" names Gmail, then is the Mail & chat category of the rest.
  expect(names(appSections(catalogue, { ...none, text: "mail" }))).toEqual([
    [undefined, ["Gmail", "Resend", "Slack"]],
  ]);
  expect(names(appSections(catalogue, { ...none, text: "drafts" }))).toEqual([
    [undefined, ["Gmail"]],
  ]);
  expect(names(appSections(catalogue, { ...none, text: "nothing like it" }))).toEqual([
    [undefined, []],
  ]);
});

test("a category shows only its apps, with the added ones first", () => {
  expect(
    names(appSections(catalogue, { ...none, filter: "code", added: new Set(["render"]) })),
  ).toEqual([["Code", ["Render", "Railway", "GitHub"]]]);
});

/** Storage as the browser's behaves, or refuses as private mode does. */
function storage(refuse = false): RecentStorage & { value: string | null } {
  return {
    value: null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      if (refuse) throw new Error("QuotaExceededError");
      this.value = value;
    },
  };
}

test("the apps reached for lately keep the latest first, each once, at most six", () => {
  const kept = storage();
  for (const id of ["a", "b", "c", "a", "d", "e", "f", "g"]) rememberRecentApp(kept, id);
  expect(readRecentApps(kept)).toEqual(["g", "f", "e", "d", "a", "c"]);
  // Storage that refuses or holds something else leaves an empty list, never an error.
  expect(rememberRecentApp(storage(true), "a")).toEqual(["a"]);
  kept.value = "{not json";
  expect(readRecentApps(kept)).toEqual([]);
  kept.value = JSON.stringify(["x", 3, null, "y"]);
  expect(readRecentApps(kept)).toEqual(["x", "y"]);
  expect(readRecentApps(undefined)).toEqual([]);
});
