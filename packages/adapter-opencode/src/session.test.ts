import { describe, expect, it } from "vitest";
import { object, array } from "./data.ts";
import { setup } from "./testing/session-harness.ts";
describe("OpenCode HTTP session", () => {
  it("targets the engine root even when its key matches a native child session", async () => {
    const h = await setup();
    const session = await h.open("/two", undefined, "ses_child");
    await h.publish(
      "session.created",
      { info: { id: "ses_child", parentID: session.nativeSessionId } },
      "/two",
    );
    await h.wait(
      (f) => object(object(object(object(f.data).payload).properties).info).id === "ses_child",
    );
    await session.interrupt({ agent: "ses_child", cascade: false });
    await session.stopTask("ses_child");
    const paths = array(object(await h.control("/test/requests")).requests)
      .map(object)
      .filter((r) => String(r.path).endsWith("/abort"))
      .map((r) => r.path);
    expect(paths).toEqual([
      `/session/${session.nativeSessionId}/abort`,
      "/session/ses_child/abort",
    ]);
    await session.close("shutdown");
  });
  it("shares one authenticated server and addresses each project directory", async () => {
    const h = await setup();
    const other = await h.open("/two");
    await h.session.send(
      [
        { type: "text", text: "offline test" },
        { type: "image", mimeType: "image/png", url: "data:image/png;base64,AA==" },
        { type: "file", path: "/one/x.ts" },
      ],
      "queue",
    );
    await other.send([{ type: "text", text: "second" }], "queue");
    const info = object(await h.control("/test/requests"));
    expect(info.connections).toBe(1);
    const requests = array(info.requests).map(object);
    expect(requests.filter((r) => r.path === "/session").map((r) => r.directory)).toEqual([
      "/one",
      "/two",
    ]);
    const prompt = requests.find(
      (r) => r.path === `/session/${h.session.nativeSessionId}/prompt_async`,
    );
    expect(prompt).toMatchObject({
      directory: "/one",
      body: {
        model: { providerID: "provider", modelID: "model" },
        parts: [
          { type: "text", text: "offline test" },
          { type: "file", mime: "image/png" },
          { type: "file", url: "file:///one/x.ts" },
        ],
      },
    });
    expect(object(prompt?.body).messageID).toMatch(/^msg_/);
    await expect(h.session.close("idle")).rejects.toThrow("unsettled");
    await h.session.close("user");
    await other.interrupt({ cascade: true });
    await other.close("shutdown");
    expect(h.exits).toHaveLength(2);
  });
  it("queues a second input until the child and root are both idle", async () => {
    const h = await setup();
    const id = h.session.nativeSessionId;
    await h.session.send([{ type: "text", text: "first" }], "queue");
    await h.publish("session.created", {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: id },
    });
    await h.publish("session.status", { sessionID: "ses_child", status: { type: "busy" } });
    await h.wait(
      (f) =>
        f.channel === "sse" &&
        object(object(object(f.data).payload).properties).sessionID === "ses_child" &&
        object(object(f.data).payload).type === "session.status",
    );
    const queued = h.session.send([{ type: "text", text: "second" }], "queue");
    await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
    await h.wait(
      (f) =>
        object(object(object(f.data).payload).properties).sessionID === id &&
        object(object(object(object(f.data).payload).properties).status).type === "idle",
    );
    expect(
      array(object(await h.control("/test/requests")).requests)
        .map(object)
        .filter((r) => String(r.path).endsWith("/prompt_async")),
    ).toHaveLength(1);
    await h.publish("session.status", { sessionID: "ses_child", status: { type: "idle" } });
    await queued;
    expect(
      array(object(await h.control("/test/requests")).requests)
        .map(object)
        .filter((r) => String(r.path).endsWith("/prompt_async")),
    ).toHaveLength(2);
    await h.session.close("shutdown");
  });
  it("routes ordered answers, dismissals, plan decisions and approval replies", async () => {
    const h = await setup();
    await h.publish("question.asked", {
      id: "que_x",
      sessionID: h.session.nativeSessionId,
      questions: [{ question: "First" }, { question: "Second" }],
    });
    await h.wait((f) => object(object(object(f.data).payload).properties).id === "que_x");
    await h.session.resolve("que_x", {
      kind: "question",
      answers: { "que_x#1": ["B"], "que_x#0": ["A"] },
    });
    await h.session.resolve("que_dismiss", { kind: "question", answers: {}, dismissed: true });
    await h.session.resolve("que_plan", { kind: "plan_review", decision: "approve" });
    await h.session.resolve("que_plan", { kind: "plan_review", decision: "reject" });
    await h.session.resolve("per_x", { kind: "approval", optionId: "always", message: "okay" });
    const requests = array(object(await h.control("/test/requests")).requests).map(object);
    expect(requests.find((r) => r.path === "/question/que_x/reply")?.body).toEqual({
      answers: [["A"], ["B"]],
    });
    expect(requests.find((r) => r.path === "/question/que_dismiss/reject")).toBeDefined();
    expect(requests.find((r) => r.path === "/question/que_plan/reply")?.body).toEqual({
      answers: [["Yes"]],
    });
    expect(requests.find((r) => r.path === "/question/que_plan/reject")).toBeDefined();
    expect(requests.find((r) => r.path === "/permission/per_x/reply")?.body).toEqual({
      reply: "always",
      message: "okay",
    });
    await h.session.close("shutdown");
  });
  it("aborts known descendants and stops a background child independently", async () => {
    const h = await setup();
    await h.publish("session.created", {
      info: { id: "ses_child", parentID: h.session.nativeSessionId },
    });
    await h.wait(
      (f) => object(object(object(object(f.data).payload).properties).info).id === "ses_child",
    );
    await h.session.interrupt({ cascade: true });
    await h.session.stopTask("ses_child");
    const paths = array(object(await h.control("/test/requests")).requests)
      .map(object)
      .filter((r) => String(r.path).endsWith("/abort"))
      .map((r) => r.path);
    expect(paths).toEqual([
      "/session/ses_child/abort",
      `/session/${h.session.nativeSessionId}/abort`,
      "/session/ses_child/abort",
    ]);
    await h.session.close("shutdown");
  });
  it("resynchronizes missed child messages, statuses and interactions after SSE loss", async () => {
    const h = await setup();
    const id = h.session.nativeSessionId;
    await h.control("/test/state", {
      sessions: [{ id: "ses_child", parentID: id, directory: "/one" }],
      statuses: { [id]: { type: "busy" }, ses_child: { type: "idle" } },
      messages: {
        ses_child: [
          {
            info: {
              id: "msg_child",
              sessionID: "ses_child",
              role: "assistant",
              parentID: "msg_input",
              time: { completed: 42 },
            },
            parts: [
              {
                id: "p_recovered",
                sessionID: "ses_child",
                messageID: "msg_child",
                type: "text",
                text: "recovered output",
              },
            ],
          },
        ],
      },
      questions: [{ id: "que_recovered", sessionID: id, questions: [{ question: "Continue?" }] }],
    });
    await h.control("/test/drop", {});
    await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "disconnected");
    await h.wait(
      (f) =>
        f.channel === "sse" &&
        object(object(object(object(f.data).payload).properties).part).id === "p_recovered",
    );
    await h.wait(
      (f) =>
        f.channel === "sse" &&
        object(object(object(f.data).payload).properties).id === "que_recovered",
    );
    await h.session.resolve("que_recovered", {
      kind: "question",
      answers: { "que_recovered#0": ["Yes"] },
    });
    const info = object(await h.control("/test/requests"));
    expect(info.connections).toBe(2);
    expect(
      h.frames.some(
        (f) => f.channel === "http" && object(f.data).path === `/session/${id}/children`,
      ),
    ).toBe(true);
    await h.session.close("shutdown");
  });
  it("rejects queued work on close and restarts its owned process for a later session", async () => {
    const h = await setup();
    await h.session.send([{ type: "text", text: "first" }], "queue");
    const queued = h.session.send([{ type: "text", text: "queued" }], "queue");
    const rejection = expect(queued).rejects.toThrow("closed");
    const pid = object(await h.control("/test/requests")).pid;
    await h.session.close("shutdown");
    await rejection;
    const later = await h.open("/two");
    expect(object(await h.control("/test/requests")).pid).not.toBe(pid);
    await later.close("idle");
  });
  it("does not append a buffered delta that the REST snapshot already contains", async () => {
    const h = await setup();
    const id = h.session.nativeSessionId;
    const messages = [
      {
        info: { id: "msg_snapshot", sessionID: id, role: "assistant", parentID: "msg_user" },
        parts: [
          { id: "p_snapshot", sessionID: id, messageID: "msg_snapshot", type: "text", text: "ab" },
        ],
      },
    ];
    await h.control("/test/state", {
      statuses: { [id]: { type: "busy" } },
      duringMessage: {
        sessionID: id,
        messages,
        event: {
          payload: {
            type: "message.part.delta",
            properties: { sessionID: id, partID: "p_snapshot", field: "text", delta: "b" },
          },
        },
      },
    });
    await h.control("/test/drop", {});
    await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
    expect(
      Object.values(h.projection.view.items).find(
        (i) => i.type === "message" && i.parts.some((p) => p.type === "text" && p.text === "ab"),
      ),
    ).toBeDefined();
    expect(Object.values(h.projection.view.items).filter((i) => i.type === "message")).toHaveLength(
      1,
    );
    expect(h.renderedText).not.toContain("abb");
    await h.session.close("shutdown");
  });
  it("holds queued input through background-result delivery and the resumed parent turn", async () => {
    const h = await setup();
    const id = h.session.nativeSessionId;
    await h.session.send([{ type: "text", text: "first" }], "queue");
    await h.publish("session.created", { info: { id: "ses_child", parentID: id } });
    await h.publish("message.part.updated", {
      part: {
        id: "p_spawn",
        callID: "spawn",
        sessionID: id,
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          metadata: { background: true, sessionId: "ses_child" },
        },
      },
    });
    await h.publish("session.status", { sessionID: "ses_child", status: { type: "busy" } });
    await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
    await h.wait(
      (f) =>
        object(object(object(f.data).payload).properties).sessionID === id &&
        object(object(object(object(f.data).payload).properties).status).type === "idle",
    );
    const queued = h.session.send([{ type: "text", text: "second" }], "queue");
    await h.publish("session.status", { sessionID: "ses_child", status: { type: "idle" } });
    await h.wait(
      (f) =>
        object(object(object(f.data).payload).properties).sessionID === "ses_child" &&
        object(object(object(object(f.data).payload).properties).status).type === "idle",
    );
    expect(
      array(object(await h.control("/test/requests")).requests)
        .map(object)
        .filter((r) => String(r.path).endsWith("/prompt_async")),
    ).toHaveLength(1);
    await h.publish("message.part.updated", {
      part: {
        id: "p_result",
        sessionID: id,
        type: "text",
        synthetic: true,
        text: '<task id="ses_child" state="completed">result</task>',
      },
    });
    await h.publish("session.status", { sessionID: id, status: { type: "busy" } });
    const mark = h.frames.length;
    await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
    await queued;
    expect(
      h.frames.some(
        (f) =>
          f.seq >= mark &&
          f.channel === "http" &&
          f.dir === "send" &&
          String(object(f.data).path).endsWith("/prompt_async"),
      ),
    ).toBe(true);
    await h.session.close("shutdown");
  });
});
