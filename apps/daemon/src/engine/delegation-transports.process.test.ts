import { afterEach, expect, test } from "vitest";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { CursorTranslator } from "@ace/adapter-cursor";
import { Capabilities, type ContentPart, type ThreadId } from "@ace/protocol";
import type { Frame, SessionContext } from "@ace/engine-api";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const inputText = (parts: ContentPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

// CLI boundary doubles emit native transport frames through the production translators.
// Not executed (tests run at merge).
test.each([
  ["opencode", "switch"],
  ["opencode", "merge"],
  ["cursor", "switch"],
  ["cursor", "merge"],
] as const)(
  "%s result attribution survives %s context, replay and a copied user wake",
  async (provider, transition) => {
    const h = transitionHarness();
    cleanup.push(h.close);
    let sequence = 0;
    let latest:
      | { context: SessionContext; commandId: string; id: string; parts: ContentPart[] }
      | undefined;
    const native = "transport-session";
    const emit = (context: SessionContext, dir: Frame["dir"], channel: string, data: unknown) =>
      context.onFrame({ seq: ++sequence, t: h.clock.now(), dir, channel, data });
    function cursorEvent(
      context: SessionContext,
      kind: "send" | "result",
      commandId: string,
      body: unknown,
      replayed?: true,
    ) {
      emit(context, kind === "send" ? "send" : "recv", "sdk", {
        schemaVersion: 1,
        generation: "transport-generation",
        operationId: commandId,
        commandId,
        segment: 0,
        kind,
        body,
        ...(replayed ? { replayed } : {}),
      });
    }
    function sendInput(
      context: SessionContext,
      commandId: string,
      id: string,
      parts: ContentPart[],
    ) {
      if (provider === "cursor") return cursorEvent(context, "send", commandId, { input: parts });
      emit(context, "send", "http", {
        method: "POST",
        path: `/api/session/${native}/prompt`,
        body: { id, text: inputText(parts) },
      });
    }
    function replayInput(
      context: SessionContext,
      commandId: string,
      id: string,
      parts: ContentPart[],
    ) {
      if (provider === "cursor") {
        cursorEvent(context, "send", commandId, { input: parts }, true);
        cursorEvent(context, "result", commandId, { status: "finished" }, true);
      } else
        emit(context, "recv", "snapshot.message", {
          sessionID: native,
          message: { id, type: "user", text: inputText(parts) },
        });
    }
    h.registry.register(
      {
        provider,
        ...(provider === "cursor" ? { backend: "cursor-sdk" as const } : {}),
        capabilities: () =>
          Capabilities.parse({
            resume: true,
            permissions: {
              modes: ["read-only", "ask", "auto-review", "full-access"],
              toolGate: true,
            },
          }),
        createTranslator(init) {
          return provider === "cursor" ? new CursorTranslator(init) : new OpenCodeTranslator(init);
        },
        async openSession(context) {
          if (provider === "cursor")
            emit(context, "recv", "sdk", {
              schemaVersion: 1,
              generation: "transport-generation",
              operationId: "open",
              segment: 0,
              kind: "open",
              body: { cwd: h.home },
              agentId: native,
            });
          else
            emit(context, "recv", "snapshot.info", {
              root: true,
              info: { id: native, location: { directory: h.home } },
            });
          return {
            nativeSessionId: native,
            ...(provider === "cursor" ? { backend: "cursor-sdk" as const } : {}),
            async send(parts, _delivery, commandId) {
              if (!commandId) throw new Error("Missing command identity");
              const id = provider === "cursor" ? commandId : `native-${commandId}`;
              context.onInputMessage?.({ commandId, nativeId: id });
              latest = { context, commandId, id, parts };
              if (provider === "opencode")
                emit(context, "note", "input.sending", { id, commandId });
              sendInput(context, commandId, id, parts);
              if (provider === "cursor")
                emit(context, "recv", "sdk", {
                  schemaVersion: 1,
                  generation: "transport-generation",
                  operationId: commandId,
                  commandId,
                  segment: 0,
                  kind: "result",
                  body: { status: "finished" },
                });
              else {
                replayInput(context, commandId, id, parts);
                emit(context, "recv", "snapshot.active", {
                  sessionID: native,
                  running: true,
                  revision: commandId,
                });
                emit(context, "recv", "snapshot.active", {
                  sessionID: native,
                  running: false,
                  idleAt: 1,
                  outcome: "succeeded",
                });
              }
            },
            async interrupt() {},
            async resolve() {},
            async stopTask() {},
            async close() {},
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "mock" },
    );
    const parent = await h.create();
    const child = await h.fork(parent);
    expect(h.command({ type: "thread.switch", threadId: parent, selection: { provider } }).ok).toBe(
      true,
    );
    await h.engine.flush();
    if (transition === "merge") {
      const item = Object.values(h.store.snapshotThread(child).items).find(
        (candidate) => candidate.type === "message",
      );
      if (!item) throw new Error("Missing citation");
      expect(
        h.command({
          type: "thread.merge",
          threadId: child,
          summary: "Merged child decision",
          citations: [{ threadId: child, itemId: item.id }],
        }).ok,
      ).toBe(true);
      await h.engine.flush();
    }
    const agent = h.store.getThread(parent)?.rootAgentId;
    if (!agent) throw new Error("Missing parent agent");
    const commandId = `wake-${provider}-${transition}`;
    const wake = `[ace-origin:delegation.settled:${commandId}]\nChild result context`;
    h.engine.delegationSettled(
      parent,
      agent,
      commandId,
      [
        {
          threadId: child,
          outcome: "completed",
          result: "Child result",
          truncated: false,
          before: null,
        },
      ],
      "ace-input",
      wake,
    );
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: parent,
          delivery: "queue",
          trigger: "subagent_result",
          input: [{ type: "text", text: wake }],
        },
        commandId,
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const sent = latest;
    if (!sent) throw new Error("Missing native send");
    expect(sent.parts[0]).not.toEqual({ type: "text", text: wake });
    expect(sent.parts).toContainEqual({ type: "text", text: wake });
    assertTranscript(parent);
    await h.restart();
    expect(
      h.command({
        type: "thread.send",
        threadId: parent,
        delivery: "queue",
        input: [{ type: "text", text: "Continue" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    const resumed = latest;
    if (!resumed) throw new Error("Missing resumed transport");
    replayInput(resumed.context, sent.commandId, sent.id, sent.parts);
    await h.engine.flush();
    assertTranscript(parent);
    const resultsBeforeCopy = h.store
      .readItemPage(parent, h.store.headSeq() + 1, 100)
      .items.filter((entry) => entry.type === "delegation.settled");
    expect(
      h.command({
        type: "thread.send",
        threadId: parent,
        delivery: "queue",
        input: [{ type: "text", text: wake }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    const copied = latest;
    if (!copied) throw new Error("Missing copied user message");
    expect(copied.id).not.toBe(sent.id);
    await h.restart();
    expect(
      h.command({
        type: "thread.send",
        threadId: parent,
        delivery: "queue",
        input: [{ type: "text", text: "Resume copied input" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    const reopened = latest;
    if (!reopened) throw new Error("Missing user replay session");
    replayInput(reopened.context, copied.commandId, copied.id, copied.parts);
    await h.engine.flush();
    const copiedPage = h.store.readItemPage(parent, h.store.headSeq() + 1, 100).items;
    expect(copiedPage).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "user",
        nativeId: copied.id,
        parts: [{ type: "text", text: wake }],
      }),
    );
    expect(copiedPage.filter((entry) => entry.type === "delegation.settled")).toEqual(
      resultsBeforeCopy,
    );
    const unknownIdentity = `external-${"x".repeat(300)}`;
    replayInput(reopened.context, unknownIdentity, unknownIdentity, [
      { type: "text", text: "Uncorrelated native input" },
    ]);
    await h.engine.flush();
    const unknownPage = h.store.readItemPage(parent, h.store.headSeq() + 1, 100);
    const unknownInput = unknownPage.items.find(
      (entry) =>
        entry.type === "message" &&
        entry.parts.some(
          (part) => part.type === "text" && part.text === "Uncorrelated native input",
        ),
    );
    expect(unknownInput).toMatchObject({
      type: "message",
      role: "user",
      parts: [{ type: "text", text: "Uncorrelated native input" }],
    });
    expect(
      unknownPage.items.some(
        (entry) => "raw" in entry && JSON.stringify(entry.raw).includes(unknownIdentity),
      ),
    ).toBe(true);
    expect(h.errors).toEqual([]);
    function assertTranscript(thread: ThreadId) {
      const items = h.store.readItemPage(thread, h.store.headSeq() + 1, 100).items;
      expect(
        items.some(
          (item) =>
            item.type === "message" &&
            item.role === "user" &&
            item.parts?.some((part) => part.type === "text" && part.text.includes(wake)),
        ),
      ).toBe(false);
      expect(items.filter((item) => item.type === "delegation.settled")).toHaveLength(1);
      expect(items).toContainEqual(
        expect.objectContaining({
          type: "delegation.settled",
          origin: "ace",
          results: [expect.objectContaining({ threadId: child, result: "Child result" })],
        }),
      );
    }
  },
);
