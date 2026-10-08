import { expect, test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { AgentCatalog, fileCache } from "./index.ts";
import { temporary, body, sample } from "./testing/support.ts";
test("offline startup and failed refresh retain the last valid atomic catalog", async () => {
  const work = await temporary();
  let payload = body([sample()]);
  let status = 200;
  let requests = 0;
  let seenEtag: string | undefined;
  const server = createServer((request, response) => {
    requests++;
    seenEtag = request.headers["if-none-match"];
    response.writeHead(status, { ETag: '"revision-one"' });
    response.end(payload);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const request: typeof fetch = (_url, options) =>
    fetch(`http://127.0.0.1:${address.port}/registry`, options);
  let id = 0;
  let now = 100;
  const options = {
    cache: fileCache(join(work.root, "snapshot"), () => String(++id)),
    now: () => now,
    target: "linux-x86_64",
    fetch: request,
  };
  let catalog = await AgentCatalog.open(options);
  try {
    expect(catalog.list().agents).toEqual([]);
    expect(requests).toBe(0);
    const first = catalog.refresh();
    const second = catalog.refresh();
    await Promise.all([first, second]);
    expect(requests).toBe(1);
    expect(catalog.list().agents[0]?.acpAgentId).toBe("official:sample");
    payload = "malformed";
    await catalog.refresh();
    expect(seenEtag).toBe('"revision-one"');
    expect(catalog.list()).toMatchObject({
      agents: [{ version: "1.0.0" }],
      error: "refresh_failed",
    });
    payload = "x".repeat(4 * 1024 * 1024 + 1);
    await catalog.refresh();
    expect(catalog.list().agents[0]?.version).toBe("1.0.0");
    status = 503;
    await catalog.refresh();
    await catalog.close();
    now += 86400000;
    catalog = await AgentCatalog.open({
      ...options,
      fetch: async () => {
        throw new Error("Offline");
      },
    });
    expect(catalog.list()).toMatchObject({ stale: true, agents: [{ version: "1.0.0" }] });
    await catalog.refresh();
    expect(catalog.list().agents[0]?.version).toBe("1.0.0");
  } finally {
    await catalog.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await work.close();
  }
});
test("custom registry entries remain source-qualified and cannot acquire official profile coverage", async () => {
  const catalog = await AgentCatalog.open({
    cache: { load: async () => undefined, save: async () => {} },
    now: () => 1,
    target: "linux-x86_64",
    source: "https://third-party.invalid/registry",
    fetch: async () => new Response(body([{ ...sample(), id: "gemini", version: "0.43.0" }])),
  });
  try {
    await catalog.refresh();
    expect(catalog.list().agents[0]?.acpAgentId).toMatch(/^registry-[a-f0-9]+:gemini$/);
    expect(catalog.list().agents[0]?.coverage).toBe("generic");
  } finally {
    await catalog.close();
  }
});
test("listed entries name the runtimes this platform can install and only HTTPS links", async () => {
  const both = {
    ...sample(),
    id: "both",
    icon: "https://cdn.example.org/both.svg",
    website: "http://insecure.example.org",
    repository: "https://github.com/example/both",
    license: "MIT",
    distribution: { ...sample().distribution, npx: { package: "both@1.0.0", args: [], env: {} } },
  };
  const elsewhere = {
    ...sample(),
    id: "elsewhere",
    icon: "javascript:alert(1)",
    distribution: { binary: { "windows-x86_64": sample().distribution.binary?.["linux-x86_64"] } },
  };
  const catalog = await AgentCatalog.open({
    cache: { load: async () => undefined, save: async () => {} },
    now: () => 1,
    target: "linux-x86_64",
    fetch: async () => new Response(body([both, elsewhere])),
  });
  try {
    await catalog.refresh();
    const [first, second] = catalog.list().agents;
    expect(first).toMatchObject({
      runtimes: ["binary", "npm"],
      icon: "https://cdn.example.org/both.svg",
      homepage: "https://github.com/example/both",
      license: "MIT",
    });
    expect(second).toMatchObject({ runtimes: [], availability: "unsupported_target" });
    expect(second?.icon).toBeUndefined();
  } finally {
    await catalog.close();
  }
});
