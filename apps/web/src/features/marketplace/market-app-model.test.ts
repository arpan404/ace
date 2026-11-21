import type { SpadeCatalogueEntry, SpadeConnector } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import { appLine, connectLine, searchApps, storeApps } from "./market-app-model.ts";

const entry = (id: string, name: string, extra: Partial<SpadeCatalogueEntry> = {}) =>
  ({
    id,
    name,
    url: `https://${id}.example/mcp`,
    signIn: ["oauth"],
    notes: "",
    via: undefined,
    category: "work",
    ready: "sign_in",
    keyUrl: undefined,
    ...extra,
  }) satisfies SpadeCatalogueEntry;

const connection = (id: string, extra: Partial<SpadeConnector> = {}) =>
  ({
    id,
    name: id,
    url: `https://${id}.example/mcp`,
    catalogue: id,
    local: false,
    signIn: "oauth",
    state: "connected",
    account: undefined,
    tools: 3,
    problem: undefined,
    device: undefined,
    via: undefined,
    notice: undefined,
    bots: [],
    lastUsedMs: undefined,
    failed: undefined,
    ...extra,
  }) satisfies SpadeConnector;

const catalogue = [
  entry("gmail", "Gmail", { category: "mail_chat", via: "cloud", notes: "Reads mail." }),
  entry("linear", "Linear", { notes: "An API key also works." }),
  entry("notion", "Notion"),
  entry("zapier", "Zapier", { ready: "key", signIn: ["token"] }),
  entry("asana", "Asana", { ready: "later", signIn: ["oauth_client"] }),
];

test("each app reads as one state the store agrees on, from its connection or its readiness", () => {
  const apps = storeApps(catalogue, [
    connection("linear", { account: "sam@acme.dev" }),
    connection("notion", { state: "needs_reconnect" }),
  ]);
  expect(apps.map((app) => [app.id, app.state, appLine(app)])).toEqual([
    ["gmail", "available", "Mail & chat"],
    ["linear", "connected", "Connected as sam@acme.dev"],
    ["notion", "signed_out", "Signed out"],
    ["zapier", "available", "Work"],
    ["asana", "later", "Not available yet"],
  ]);
});

test("in a list already titled by its category, an app says how it connects instead", () => {
  const apps = storeApps(catalogue, []);
  expect(apps.slice(0, 4).map(connectLine)).toEqual([
    "Signs in through Spade Cloud",
    "Signs in on its own page",
    "Signs in on its own page",
    "Needs a key",
  ]);
});

test("an app connected by address, outside the catalogue, is an entry too", () => {
  const apps = storeApps(catalogue, [
    connection("ours", { name: "Our tracker", catalogue: undefined, local: true }),
  ]);
  expect(apps.at(-1)).toMatchObject({ id: "ours", name: "Our tracker", state: "connected" });
});

test("search finds apps by name first, then category, then notes, and every word must match", () => {
  const apps = storeApps(catalogue, []);
  expect(searchApps(apps, "lin").map((app) => app.id)).toEqual(["linear"]);
  // "mail" names no app, but Gmail's name holds it and its category says Mail & chat.
  expect(searchApps(apps, "mail").map((app) => app.id)).toEqual(["gmail"]);
  expect(searchApps(apps, "api key").map((app) => app.id)).toEqual(["linear"]);
  expect(searchApps(apps, "linear zzz")).toEqual([]);
  expect(searchApps(apps, "  ")).toEqual([]);
});
