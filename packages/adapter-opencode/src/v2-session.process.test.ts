import { expect, it } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";
function info(id: string, parentID?: string, directory = "/one") {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    location: { directory },
    projectID: "project-one",
    time: { created: 1, updated: 2, idle: 2 },
    outcome: "succeeded",
  };
}
it("correlates host commands before native prompt frames and projects the same identity", async () => {
  const h = await setup();
  await h.session.send(
    [
      { type: "text", text: "Handoff context" },
      { type: "text", text: "ace result" },
    ],
    "queue",
    "ace-wake",
  );
  const identity = h.inputMessages[0];
  if (!identity) throw new Error("Missing host correlation");
  expect(identity.commandId).toBe("ace-wake");
  const promptIndex = h.frames.findIndex(
    (frame) =>
      frame.dir === "send" &&
      frame.channel === "http" &&
      String(object(frame.data).path).endsWith("/prompt"),
  );
  expect(promptIndex).toBeGreaterThanOrEqual(identity.beforeFrame);
  expect(Object.values(h.projection.view.items)).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      nativeId: identity.nativeId,
      parts: [{ type: "text", text: "Handoff context\nace result" }],
    }),
  );
});
it("the installed boundary serves JSON readiness under a stdin lease and secrets stay out of frames", async () => {
  const h = await setup();
  await h.session.send([{ type: "text", text: "input" }], "queue");
  const requests = array(await h.control("/test/requests")).map(object);
  const create = requests.find((r) => r.path === "/api/session" && r.method === "POST");
  expect(create?.body).toMatchObject({
    location: { directory: "/one" },
    model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
  });
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "queue" });
  expect(JSON.stringify(h.frames)).not.toContain("ephemeral-test-secret");
  expect(h.frames.some((f) => f.channel === "stdout" || f.channel === "stderr")).toBe(false);
  await h.adapter.close();
  expect(h.exits).toHaveLength(1);
});
it.each([
  { env: { ACE_TEST_OPENCODE_VERSION: "1.18.33" } },
  { env: { ACE_TEST_SERVER_VERSION: "2.0.23" } },
  { env: { ACE_TEST_HTML: "1" } },
  { env: { ACE_TEST_MISSING_OPERATION: "session.prompt" } },
])(
  "unsupported versions, HTML or missing operations prevent session creation: %j",
  async ({ env }) => {
    await expect(setup({ discovery: { env } })).rejects.toThrow("2.0.22");
  },
);
it("native steer and queue each admit a distinct input without a local retry queue", async () => {
  const h = await setup();
  await h.session.send([{ type: "text", text: "first" }], "steer");
  await h.session.send([{ type: "text", text: "second" }], "queue");
  const prompts = array(await h.control("/test/requests"))
    .map(object)
    .filter((r) => String(r.path).endsWith("/prompt"))
    .map((r) => object(r.body));
  expect(prompts.map((p) => p.delivery)).toEqual(["steer", "queue"]);
  expect(new Set(prompts.map((p) => p.id)).size).toBe(2);
  expect(prompts.map((p) => p.text)).toEqual(["first", "second"]);
});
it("an uncertain admission reconciles a committed inbox item without sending the prompt twice", async () => {
  const h = await setup();
  await h.control("/test/state", { fault: { promptDisconnect: true } });
  const recovery = h.recovered();
  await expect(h.session.send([{ type: "text", text: "one input" }], "queue")).rejects.toThrow(
    "uncertain",
  );
  await recovery;
  const requests = array(await h.control("/test/requests"))
    .map(object)
    .filter((r) => String(r.path).endsWith("/prompt"));
  expect(requests.map((r) => object(r.body).text)).toEqual(["one input"]);
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "queue" });
});
it("interrupt acknowledgement preserves work, and a no-op interrupt never settles it", async () => {
  const h = await setup();
  await h.publish("session.execution.started");
  await h.publish("session.tool.input.started", {
    assistantMessageID: "a",
    id: "tool",
    name: "shell",
  });
  await h.session.interrupt({ cascade: false });
  expect(h.projection.view.thread.status.state).toBe("working");
  await h.control("/test/state", { fault: { noopInterrupt: true } });
  await expect(h.session.interrupt({ cascade: true })).rejects.toThrow("not accepted");
  expect(h.projection.view.thread.status.state).toBe("working");
  await h.publish("session.execution.interrupted");
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
});
it("SDK command errors and projected snapshots cannot expose the transport password", async () => {
  const h = await setup();
  await h.control("/test/state", { fault: { interruptFailure: true } });
  await expect(h.session.interrupt({ cascade: false })).rejects.toThrow(
    "OpenCode interrupt request failed",
  );
  expect(JSON.stringify(h.frames)).not.toContain("ephemeral-test-secret");
  expect(JSON.stringify(h.projection.view)).not.toContain("ephemeral-test-secret");
});
it("child permission replies use the owning session and always means a project grant", async () => {
  const h = await setup(),
    child = "child";
  await h.publish("session.created", {
    sessionID: child,
    parentID: h.session.nativeSessionId,
    projectID: "project-one",
    location: { directory: "/one" },
  });
  await h.publish("permission.asked", {
    sessionID: child,
    id: "ask",
    action: "edit",
    resources: ["file.ts"],
    save: ["*.ts"],
    source: { type: "tool", messageID: "a", id: "t" },
  });
  await h.session.resolve(`permission:${child}:ask`, { kind: "approval", optionId: "always" });
  const reply = array(await h.control("/test/requests"))
    .map(object)
    .find((r) => r.path === `/api/session/${child}/permission/ask/reply`);
  expect(reply?.body).toEqual({ decision: "always" });
  expect(Object.values(h.projection.view.interactions)[0]?.request).toMatchObject({
    kind: "approval",
    options: [{ id: "once" }, { id: "always", kind: "allow_always" }, { id: "reject" }],
  });
});
it("form answers keep field keys and multi-select values, generic dismissal keeps feedback", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.publish("form.created", {
    form: {
      id: "q",
      sessionID: root,
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        { key: "q0", title: "Indent", type: "string" },
        {
          key: "q1",
          title: "Features",
          type: "multiselect",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    },
  });
  await h.session.resolve(`form:${root}:q`, {
    kind: "question",
    answers: { q0: ["Tabs"], q1: ["a", "b"] },
  });
  await h.publish("form.replied", { id: "q", answer: { q0: "Tabs", q1: ["a", "b"] } });
  expect(Object.values(h.projection.view.interactions)[0]?.resolution).toMatchObject({
    answers: { q0: ["Tabs"], q1: ["a", "b"] },
  });
  await h.publish("form.created", {
    form: {
      id: "dismiss",
      sessionID: root,
      title: "Dismissal",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string" }],
    },
  });
  await h.session.resolve(`form:${root}:dismiss`, {
    kind: "question",
    answers: {},
    dismissed: true,
    feedback: "Ask later",
  });
  await h.publish("form.cancelled", { id: "dismiss" });
  expect(
    Object.values(h.projection.view.interactions).find(
      (interaction) => interaction.state === "cancelled",
    )?.resolution,
  ).toMatchObject({
    dismissed: true,
    feedback: "Ask later",
  });
  await h.publish("form.created", {
    form: { id: "f", sessionID: root, title: "Generic", fields: [{ key: "age", type: "number" }] },
  });
  await h.session.resolve(`form:${root}:f`, {
    kind: "elicitation",
    action: "cancel",
    content: { feedback: "Declined by owner" },
  });
  await h.publish("form.cancelled", { id: "f" });
  expect(
    Object.values(h.projection.view.interactions).find(
      (interaction) => interaction.request.kind === "elicitation",
    )?.resolution,
  ).toMatchObject({ action: "cancel", content: { feedback: "Declined by owner" } });
  const requests = array(await h.control("/test/requests")).map(object);
  expect(requests.find((r) => String(r.path).endsWith("/form/q/reply"))?.body).toEqual({
    answer: { q0: "Tabs", q1: ["a", "b"] },
  });
  expect(
    requests.find((r) => r.method === "DELETE" && String(r.path).endsWith("/form/dismiss"))?.query,
  ).toEqual({ message: "Ask later" });
  expect(requests.find((r) => String(r.path).endsWith("/form/f"))?.query).toEqual({
    message: "Declined by owner",
  });
});
it("reconnect recovers missing children, permissions and owned shells, keeping the thread unsettled", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    sessions: [info("child", root)],
    active: { child: { type: "running" } },
    permissions: [{ sessionID: "child", id: "ask", action: "edit", resources: ["x"] }],
    shells: [{ id: "shell", status: "running", cwd: "/one", metadata: { sessionID: root } }],
  });
  const recovery = h.recovered();
  await h.control("/test/drop", {});
  await recovery;
  expect(Object.values(h.projection.view.agents).map((a) => a.native.nativeId)).toContain("child");
  expect(h.projection.view.thread.status.state).toBe("needs_you");
  expect(
    Object.values(h.projection.view.backgroundTasks).some(
      (t) => t.kind === "shell" && t.status === "running",
    ),
  ).toBe(true);
  await h.session.stopTask("shell:shell");
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .some((r) => r.method === "DELETE" && r.path === "/api/shell/shell"),
  ).toBe(true);
});
it("foreign directories, forks, global forms and unowned shells cannot enter a thread", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/events", [
    {
      type: "session.created",
      directory: "/other",
      data: {
        sessionID: "foreign",
        parentID: root,
        projectID: "foreign",
        location: { directory: "/other" },
      },
    },
    {
      type: "session.created",
      data: {
        sessionID: "fork",
        parentID: root,
        projectID: "project-one",
        location: { directory: "/one" },
        fork: { sessionID: root },
      },
    },
    {
      type: "form.created",
      data: { form: { id: "global", sessionID: "global", title: "MCP", fields: [] } },
    },
    {
      type: "shell.created",
      data: { info: { id: "unowned", cwd: "/one", status: "running", metadata: {} } },
    },
  ]);
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  expect(Object.values(h.projection.view.agents)).toHaveLength(1);
  expect(Object.values(h.projection.view.interactions)).toHaveLength(0);
  expect(Object.values(h.projection.view.backgroundTasks)).toHaveLength(0);
  expect(h.projection.view.thread.status.state).toBe("done");
});
it("opaque child and history pages preserve scope, and later recovery refreshes only the changed head", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  const messages = Array.from({ length: 260 }, (_, n) => ({
    id: `m-${n}`,
    type: "assistant",
    time: { completed: n + 1 },
    content: [{ type: "text", text: `text-${n}` }],
  }));
  await h.control("/test/state", {
    sessions: Array.from({ length: 130 }, (_, n) => info(`child-${n}`, root)),
    messages: { [root]: messages },
  });
  let recovery = h.recovered();
  await h.control("/test/drop", {});
  await recovery;
  const first = array(await h.control("/test/requests")).map(object);
  const rootHistory = first.filter((r) => r.path === `/api/session/${root}/message`);
  expect(rootHistory.map((r) => object(r.query).cursor)).toEqual([
    undefined,
    "messages:128",
    "messages:256",
    undefined,
  ]);
  const childPages = first.filter(
    (r) => r.path === "/api/session" && object(r.query).parentID === root,
  );
  expect(childPages.map((r) => object(r.query))).toEqual([
    { parentID: root, directory: "/one", project: "project-one", order: "asc", limit: "128" },
    {
      parentID: root,
      directory: "/one",
      project: "project-one",
      limit: "128",
      cursor: "children:128",
    },
    { parentID: root, directory: "/one", project: "project-one", order: "asc", limit: "128" },
    {
      parentID: root,
      directory: "/one",
      project: "project-one",
      limit: "128",
      cursor: "children:128",
    },
  ]);
  recovery = h.recovered();
  await h.control("/test/drop", {});
  await recovery;
  const second = array(await h.control("/test/requests"))
    .map(object)
    .slice(first.length);
  expect(
    second
      .filter((r) => r.path === `/api/session/${root}/message`)
      .every((r) => !object(r.query).cursor),
  ).toBe(true);
  expect(second.some((r) => String(r.path).includes("/log"))).toBe(false);
});
it("newer child work, inbox and forms beat stale absent and idle recovery snapshots", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    beforeRead: [
      { type: "session.execution.started", data: { sessionID: root } },
      {
        type: "session.tool.input.started",
        data: { sessionID: root, assistantMessageID: "a", id: "live", name: "shell" },
      },
      { type: "session.inbox.enqueued", data: { sessionID: root, inboxID: "in-flight" } },
      {
        type: "form.created",
        data: {
          form: {
            id: "new-form",
            sessionID: root,
            title: "Confirm",
            fields: [{ key: "value", type: "string" }],
          },
        },
      },
    ],
  });
  const recovered = h.recovered();
  await h.control("/test/drop", {});
  await recovered;
  expect(h.projection.view.thread.status.state).toBe("needs_you");
  expect(Object.values(h.projection.view.runs).some((r) => r.state === "active")).toBe(true);
  expect(Object.values(h.projection.view.backgroundTasks).some((t) => t.status === "running")).toBe(
    true,
  );
  await h.publish("form.cancelled", { id: "new-form" });
  await h.publish("session.execution.succeeded");
  expect(h.projection.view.thread.status.state).toBe("waiting");
});

it("sends wait behind recovery and an unowned root cannot keep that barrier open", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/state", { fault: { holdHistory: true } });
  const from = h.frames.length;
  const recovered = h.recovered(from);
  await h.control("/test/drop", {});
  await h.seen(
    (f) =>
      f.dir === "send" &&
      String(object(f.data).path).split("?")[0] === `/api/session/${root}/message`,
    from,
  );
  const sending = h.session.send([{ type: "text", text: "after recovery" }], "queue");
  await h.control("/test/events", [
    { type: "session.execution.started", directory: "/other", data: { sessionID: "foreign" } },
  ]);
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt")),
  ).toEqual([]);
  await h.control("/test/release", {});
  await recovered;
  await sending;
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt"))
      .map((r) => object(r.body).text),
  ).toEqual(["after recovery"]);
});

it("native OpenCode URI attachments embed the verified image MIME and bytes", async () => {
  const imageData = (
    await (
      await import("node:fs/promises")
    ).readFile(new URL("../../context/fixtures/colours.png", import.meta.url))
  ).toString("base64");

  const h = await setup();
  await h.session.send(
    [
      { type: "text", text: "inspect" },
      { type: "image", mimeType: "image/png", url: `data:image/png;base64,${imageData}` },
    ],
    "queue",
  );
  const prompt = array(await h.control("/test/requests"))
    .map(object)
    .find((r) => String(r.path).endsWith("/prompt"));
  expect(object(prompt?.body).files).toEqual([{ uri: `data:image/png;base64,${imageData}` }]);
  await expect(
    h.session.send([{ type: "file", mimeType: "image/png", path: "/tmp/extensionless" }], "queue"),
  ).rejects.toThrow();
});
