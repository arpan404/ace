import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expect, it } from "vitest";
import { createOpenCodeRecorder } from "./providers/opencode.ts";
import { Recording } from "./recording.ts";
import { settleWatcher } from "./settle.ts";
import { findScenario } from "./scenarios.ts";

it("records v2 model admission, keyed answers, owned children and paginated history without resending", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ace-recorder-v2-test-"));
  const capture = join(workspace, "capture.jsonl");
  const rec = new Recording(capture, {
    format: "ace-recording/v1",
    provider: "opencode",
    cliVersion: "2.0.22",
    scenario: "question",
    startedAt: "2026-10-03",
    platform: "test",
    workspace,
  });
  let stream: ServerResponse | undefined;
  let serial = 0;
  const inputs: unknown[] = [],
    answers: unknown[] = [],
    permissions: unknown[] = [];
  const history: string[] = [];
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
  const emit = (type: string, data: unknown) =>
    stream?.write(
      `data: ${JSON.stringify({ id: `e${++serial}`, type, data, location: { directory: workspace } })}\n\n`,
    );
  const info = { id: "s-root", projectID: "project-test", location: { directory: workspace } };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (data: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
    let source = "";
    for await (const chunk of request) source += chunk;
    const body: unknown = source ? JSON.parse(source) : undefined;
    if (url.pathname === "/api/info") return void json({ version: "2.0.22", pid: process.pid });
    if (url.pathname === "/openapi.json")
      return void json({
        openapi: "3.1.0",
        paths: Object.fromEntries(
          operations.map((operationId, i) => [`/api/${i}`, { get: { operationId } }]),
        ),
      });
    if (url.pathname === "/api/event") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      emit("server.connected", {});
      return;
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      inputs.push(body);
      return void json({ data: info });
    }
    if (url.pathname.endsWith("/prompt")) {
      const prompt = z.object({ id: z.string() }).parse(body);
      inputs.push(body);
      json({ data: { id: prompt.id, sessionID: "s-root" } });
      emit("session.inbox.delivered", { sessionID: "s-root", inboxID: prompt.id });
      emit("session.execution.started", { sessionID: "s-root" });
      emit("session.created", { ...info, id: undefined, sessionID: "s-child", parentID: "s-root" });
      emit("permission.asked", {
        sessionID: "s-child",
        id: "permission-1",
        action: "read",
        resources: ["src/math.ts"],
      });
      emit("form.created", {
        form: {
          id: "foreign-form",
          sessionID: "s-foreign",
          metadata: { kind: "question" },
          fields: [],
        },
      });
      return;
    }
    if (url.pathname.endsWith("/permission/permission-1/reply")) {
      permissions.push(body);
      response.writeHead(204).end();
      emit("permission.replied", { sessionID: "s-child", id: "permission-1", reply: "once" });
      emit("form.created", {
        form: {
          id: "form-1",
          sessionID: "s-root",
          metadata: { kind: "question" },
          fields: [
            { key: "q0", type: "string", options: [{ value: "Tabs" }, { value: "Spaces" }] },
            { key: "q1", type: "multiselect", options: [{ value: "tests" }, { value: "docs" }] },
          ],
        },
      });
      return;
    }
    if (url.pathname.endsWith("/form/form-1/reply")) {
      answers.push(body);
      response.writeHead(204).end();
      emit("form.replied", {
        sessionID: "s-root",
        id: "form-1",
        answer: { q0: "Tabs", q1: ["tests"] },
      });
      emit("session.execution.succeeded", { sessionID: "s-root" });
      return;
    }
    if (url.pathname.endsWith("/message")) {
      if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            _tag: "InvalidCursorError",
            message: "Cursor cannot be combined with order",
          }),
        );
        return;
      }
      history.push(
        `${url.pathname}?${[...url.searchParams]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("&")}`,
      );
      return void json({
        data: [],
        cursor: { next: url.searchParams.has("cursor") ? null : "opaque-next" },
      });
    }
    if (request.method === "DELETE") return void response.writeHead(204).end();
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local test port");
  const scenario = { ...findScenario("question"), quietMs: 10, maxMs: 2000 };
  const controller = new AbortController();
  const watcher = settleWatcher(rec, scenario, controller.signal);
  try {
    await createOpenCodeRecorder({
      attach: {
        url: `http://127.0.0.1:${address.port}`,
        authorization: "Basic synthetic-secret",
        version: "2.0.22",
      },
    }).run({
      scenario,
      workspace,
      rec,
      signal: controller.signal,
      ...watcher,
      model: "opencode-go/muse-spark-1.3-contributor",
    });
    await rec.close();
    expect(inputs).toEqual([
      expect.objectContaining({
        location: { directory: workspace },
        model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
      }),
      expect.objectContaining({ delivery: "queue", text: expect.stringContaining("q1") }),
    ]);
    expect(permissions).toEqual([{ decision: "once" }]);
    expect(answers).toEqual([{ answer: { q0: "Tabs", q1: ["tests"] } }]);
    expect(history).toEqual([
      "/api/session/s-root/message?limit=128&order=asc",
      "/api/session/s-root/message?cursor=opaque-next&limit=128",
      "/api/session/s-child/message?limit=128&order=asc",
      "/api/session/s-child/message?cursor=opaque-next&limit=128",
    ]);
    const text = await readFile(capture, "utf8");
    expect(text).toContain('"reason":"settled"');
    expect(text).toContain('"sessionID":"s-child"');
    expect(text).not.toMatch(/foreign-form|synthetic-secret|handler-error|incomplete/);
  } finally {
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});
