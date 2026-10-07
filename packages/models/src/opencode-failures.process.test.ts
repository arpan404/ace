import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverOpenCodeModels } from "@ace/adapter-opencode";
import { ModelCatalog, createModelDiscovery, openModelStorage } from "./index.ts";
import { Clock, fakeCli, instance, workspace } from "./testing/support.ts";

const native = (providerID: string, modelID: string) => ({
  id: `${providerID}/${modelID}`,
  providerID,
  modelID,
  name: modelID,
  enabled: true,
  status: "active",
  limit: { context: 200000, output: 8192 },
  capabilities: { tools: true, input: ["text/plain", "image/png"], output: ["text/plain"] },
  variants: [],
});
const operations = [
  "server.info",
  "event.subscribe",
  "session.create",
  "session.get",
  "session.switchModel",
  "session.list",
  "session.active",
  "session.prompt",
  "session.interrupt",
  "session.message.list",
  "session.permission.list",
  "session.permission.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.inbox.list",
  "shell.list",
  "shell.get",
  "shell.remove",
  "model.list",
];
async function setup(
  onTestFinished: (cleanup: () => Promise<void>) => void,
  extraEnv: Record<string, string> = {},
) {
  const work = await workspace();
  const clock = new Clock();
  let fault = "";
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_CONNECTIONS: JSON.stringify(
        ["opencode-go", "github-copilot"].map((id) => ({
          id,
          connections: [{ type: "credential" }],
        })),
      ),
      PRIVATE_TOKEN: "synthetic-private-token",
      ...extraEnv,
    },
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (payload: unknown, status = 200) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (path === "/api/info") {
      if (fault === "startup") {
        json({ message: "Startup metadata rejected synthetic-private-token" }, 400);
        return;
      }
      json({ version: "2.0.22", pid: process.pid });
      return;
    }
    if (path === "/openapi.json") {
      json({
        openapi: "3.1.0",
        paths: Object.fromEntries(
          operations.map((operationId) => ["/" + operationId, { get: { operationId } }]),
        ),
      });
      return;
    }
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"ready","type":"server.connected","data":{}}\n\n');
      return;
    }
    if (path === "/api/model") {
      if (fault === "instance" || fault === "instance-unknown") {
        json(
          { message: "synthetic-private-token upstream failure" },
          fault === "instance" ? 503 : 400,
        );
        return;
      }
      json({
        location: { directory: work.path },
        data: [
          native("opencode-go", "go-current"),
          ...(fault ? [] : [native("github-copilot", "copilot-good")]),
        ],
        ...(fault && fault !== "missing"
          ? {
              errors: [
                {
                  providerID: "github-copilot",
                  error: {
                    ...(fault === "auth" ? { status: 401 } : {}),
                    message: "Copilot catalog rejected synthetic-private-token",
                  },
                },
              ],
            }
          : {}),
      });
      return;
    }
    if (path === "/api/model/default") {
      json({ location: { directory: work.path }, data: native("opencode-go", "go-current") });
      return;
    }
    json({}, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fake address");
  const notices: {
    source: string | undefined;
    code: string;
    reason: string | undefined;
    stage: string | undefined;
  }[] = [];
  const path = join(work.path, "models.sqlite");
  const catalog = new ModelCatalog({
    instances: [config],
    storage: openModelStorage(path),
    now: () => clock.now,
    deadline: clock.deadline,
    discover: createModelDiscovery({
      opencode: (_instance, signal) =>
        discoverOpenCodeModels(
          {
            attach: {
              url: `http://127.0.0.1:${address.port}/`,
              authorization: "Basic fake-transport",
              version: "2.0.22",
            },
          },
          work.path,
          signal,
        ),
    }),
    onError: (_provider, _instance, error, source, diagnostic) =>
      notices.push({
        source,
        code: error.code,
        reason: diagnostic?.reason,
        stage: diagnostic?.stage,
      }),
  });
  onTestFinished(async () => {
    await catalog.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await work.close();
  });
  return {
    catalog,
    notices,
    path,
    fail: (value: string) => {
      fault = value;
      clock.now++;
    },
  };
}

test.for(["auth", "unknown"])(
  "OpenCode preserves healthy models and the last good failed source after a %s listing error",
  async (fault, { onTestFinished }) => {
    const h = await setup(onTestFinished);
    await h.catalog.refresh();
    expect(h.catalog.list().models.map((row) => row.id)).toEqual([
      "github-copilot/copilot-good",
      "opencode-go/go-current",
    ]);
    expect(
      h.catalog.list().models.find((row) => row.nativeProviderId === "opencode-go"),
    ).toMatchObject({ inputModalities: ["text", "image"], isDefault: true });
    h.fail(fault);
    await h.catalog.refresh();
    const result = h.catalog.list();
    expect(result.models.map((row) => row.id)).toEqual([
      "github-copilot/copilot-good",
      "opencode-go/go-current",
    ]);
    expect(result.instances[0]?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ id: "opencode-go" }),
          status: "fresh",
        }),
        expect.objectContaining({
          source: expect.objectContaining({ id: "github-copilot" }),
          status: "stale",
          error: expect.objectContaining({
            code: fault === "auth" ? "auth_expired" : "discovery_failed",
          }),
        }),
      ]),
    );
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      source: "github-copilot",
      code: fault === "auth" ? "auth_expired" : "discovery_failed",
    });
    if (fault === "unknown") expect(h.notices[0]?.reason).toContain("Copilot catalog rejected");
    expect(JSON.stringify(h.notices)).not.toContain("synthetic-private-token");
    expect(JSON.stringify(result)).not.toMatch(/Copilot catalog rejected|synthetic-private-token/);
    await h.catalog.close();
    const storage = openModelStorage(h.path);
    try {
      expect(JSON.stringify(storage.load())).not.toMatch(
        /Copilot catalog rejected|synthetic-private-token/,
      );
    } finally {
      await storage.close();
    }
  },
);

test("OpenCode reports an instance metadata failure once and retains both sources' models", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished);
  await h.catalog.refresh();
  h.fail("instance");
  await h.catalog.refresh();
  expect(h.catalog.list().models).toHaveLength(2);
  expect(h.catalog.list().instances[0]).toMatchObject({
    stale: true,
    errorDetail: { code: "unreachable" },
  });
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toMatchObject({ source: undefined, code: "unreachable" });
  expect(JSON.stringify(h.notices)).not.toContain("synthetic-private-token");
});

test("OpenCode explains missing source metadata without failing a healthy source", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished);
  await h.catalog.refresh();
  h.fail("missing");
  await h.catalog.refresh();
  expect(h.catalog.list().models).toHaveLength(2);
  expect(h.catalog.list().instances[0]?.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: expect.objectContaining({ id: "opencode-go" }),
        status: "fresh",
      }),
      expect.objectContaining({
        source: expect.objectContaining({ id: "github-copilot" }),
        status: "stale",
      }),
    ]),
  );
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toMatchObject({
    source: "github-copilot",
    reason: expect.stringContaining("no enabled chat model metadata"),
  });
});

test("OpenCode logs a sanitized unknown HTTP reason once with the failing endpoint", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished);
  await h.catalog.refresh();
  h.fail("instance-unknown");
  await h.catalog.refresh();
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toMatchObject({
    source: undefined,
    code: "discovery_failed",
    stage: "metadata",
    reason: expect.stringContaining("/api/model:"),
  });
  expect(h.notices[0]?.reason).toContain("upstream failure");
  expect(JSON.stringify(h.notices)).not.toContain("synthetic-private-token");
  expect(JSON.stringify(h.catalog.list())).not.toMatch(/upstream failure|synthetic-private-token/);
});

test("OpenCode fills missing source metadata through IDs alongside healthy HTTP metadata", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished, { FAKE_MODEL_IDS: "github-copilot/copilot-recovered" });
  await h.catalog.refresh();
  h.fail("missing");
  await h.catalog.refresh();
  expect(h.catalog.list().models.map((row) => row.id)).toEqual([
    "github-copilot/copilot-recovered",
    "opencode-go/go-current",
  ]);
  expect(h.catalog.list().instances[0]?.sources?.every((source) => source.status === "fresh")).toBe(
    true,
  );
  expect(h.notices).toEqual([]);
});

test("a failed OpenCode ID fallback cannot erase healthy HTTP models", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished, { FAKE_MODEL_FAILURE: "1" });
  await h.catalog.refresh();
  h.fail("missing");
  await h.catalog.refresh();
  expect(h.catalog.list().models.map((row) => row.id)).toEqual([
    "github-copilot/copilot-good",
    "opencode-go/go-current",
  ]);
  expect(
    h.catalog.list().instances[0]?.sources?.find((source) => source.source.id === "opencode-go"),
  ).toMatchObject({ status: "fresh" });
  expect(h.notices).toEqual([
    {
      source: "github-copilot",
      code: "discovery_failed",
      stage: "model-ids",
      reason: "OpenCode model listing failed",
    },
  ]);
});

test("OpenCode reports an unknown startup metadata failure once without attributing it to either source", async ({
  onTestFinished,
}) => {
  const h = await setup(onTestFinished);
  await h.catalog.refresh();
  h.fail("startup");
  await h.catalog.refresh();
  expect(h.catalog.list().models).toHaveLength(2);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toMatchObject({
    source: undefined,
    code: "discovery_failed",
    stage: "metadata",
    reason: expect.stringContaining("server startup:"),
  });
  expect(h.notices[0]?.reason).toContain("/api/info:");
  expect(h.notices[0]?.reason).toContain("Startup metadata rejected");
  expect(JSON.stringify(h.notices)).not.toContain("synthetic-private-token");
  expect(JSON.stringify(h.catalog.list())).not.toMatch(
    /Startup metadata rejected|synthetic-private-token/,
  );
});
