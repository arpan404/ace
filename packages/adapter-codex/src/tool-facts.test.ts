import { expect, it } from "vitest";
import { CodexCatalogCache, readCodexToolFacts, toolFactsDeadlineMs } from "./tool-facts.ts";
import { codexToolListing } from "./tool-search.ts";

/** An app-server that answers from `config` and a one-page catalog, or never when stalled. */
function appServer(config: Record<string, unknown>, models: string[], stalled = false) {
  const sent: string[] = [];
  const request = (method: string) => {
    sent.push(method);
    if (stalled) return new Promise<unknown>(() => {});
    if (method === "config/read") return Promise.resolve({ config });
    return Promise.resolve({ data: models.map((model) => ({ id: model, model })) });
  };
  return { request, sent };
}
/** A clock the test moves: callbacks run when `advance` passes their delay. */
function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    schedule(run: () => void, delayMs: number) {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
}
const signal = new AbortController().signal;

async function listing(
  server: ReturnType<typeof appServer>,
  model: string | undefined,
  catalogs = new CodexCatalogCache(),
  time = clock(),
) {
  const facts = await readCodexToolFacts({
    request: server.request,
    cwd: "/work",
    model,
    signal,
    schedule: time.schedule,
    catalogs,
  });
  return codexToolListing(facts);
}

it("a dated name under a provider's catalog URL gets the fixed list, as Codex matches it exactly", async () => {
  const config = {
    model_provider: "custom",
    model_providers: { custom: { model_catalog_url: "https://models.example/catalog" } },
  };
  expect(await listing(appServer(config, ["custom-model"]), "custom-model-2026-10-27")).toBe(
    "static",
  );
  // The exact slug's metadata is the catalog author's, which ace cannot see.
  expect(await listing(appServer(config, ["custom-model"]), "custom-model")).toBe("all");
  // Without the URL, Codex's own catalog matches the same dated name by prefix.
  expect(await listing(appServer({}, ["gpt-5.5"]), "gpt-5.5-2026-09-01")).toBe("all");
});

it("Bedrock Runtime decides from config alone, without reading the catalog", async () => {
  const server = appServer({ model_provider: "amazon-bedrock-runtime" }, []);
  expect(await listing(server, undefined)).toBe("static");
  expect(server.sent).toEqual(["config/read"]);
});

it("a stalled app-server leaves every tool listed once the discovery deadline passes", async () => {
  const time = clock();
  const pending = listing(appServer({}, [], true), "gpt-oss:20b", new CodexCatalogCache(), time);
  let settled = false;
  void pending.then(() => (settled = true));
  time.advance(toolFactsDeadlineMs - 1);
  await Promise.resolve();
  expect(settled).toBe(false);
  time.advance(1);
  expect(await pending).toBe("all");
});

it("threads on one app-server read its catalog once, and again when the config names another catalog", async () => {
  const catalogs = new CodexCatalogCache();
  const server = appServer({ model: "gpt-oss:20b", model_provider: "ollama" }, ["gpt-5.5"]);
  expect(await listing(server, undefined, catalogs)).toBe("static");
  expect(await listing(server, "gpt-5.5", catalogs)).toBe("all");
  expect(server.sent.filter((method) => method === "model/list")).toHaveLength(1);
  const custom = appServer(
    {
      model_provider: "custom",
      model_providers: { custom: { model_catalog_url: "https://models.example/catalog" } },
    },
    ["custom-model"],
  );
  expect(await listing(custom, "gpt-5.5", catalogs)).toBe("static");
  expect(custom.sent).toContain("model/list");
});
