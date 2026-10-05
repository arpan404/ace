import { afterEach, expect, test } from "vitest";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { CursorTranslator } from "@ace/adapter-cursor";
import { Capabilities, type ContentPart, ThreadId } from "@ace/protocol";
import type { Frame, SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const inputText = (parts: ContentPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

// CLI boundary doubles emit native transport frames through the production translators.
test.each([
  ["opencode", "switch"],
  ["opencode", "merge"],
  ["cursor", "handoff"],
  ["cursor", "merged handoff"],
] as const)(
  "%s result attribution survives %s context, replay and a copied user wake",
  async (provider, transition) => {
    const diagnostics: { threadId: ThreadId; raw: unknown }[] = [];
    const h = transitionHarness({
      onProviderDiagnostic: (threadId, raw) => diagnostics.push({ threadId, raw }),
    });
    cleanup.push(h.close);
    let sequence = 0;
    let latest:
      | { context: SessionContext; commandId: string; id: string; parts: ContentPart[] }
      | undefined;
    const native = "transport-session";
    const emit = (context: SessionContext, dir: Frame["dir"], channel: string, data: unknown) => {
      const payload = new ProviderPayload(JSON.stringify(data));
      return context.onFrame({
        seq: ++sequence,
        t: h.clock.now(),
        dir,
        channel,
        data: payload.data,
        payload,
      });
    };
    async function cursorEvent(
      context: SessionContext,
      kind: "send" | "result",
      commandId: string,
      body: unknown,
      replayed?: true,
    ) {
      await emit(context, kind === "send" ? "send" : "recv", "sdk", {
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
    async function sendInput(
      context: SessionContext,
      commandId: string,
      id: string,
      parts: ContentPart[],
    ) {
      if (provider === "cursor") return cursorEvent(context, "send", commandId, { input: parts });
      await emit(context, "send", "http", {
        method: "POST",
        path: `/api/session/${native}/prompt`,
        body: { id, text: inputText(parts) },
      });
    }
    async function replayInput(
      context: SessionContext,
      commandId: string,
      id: string,
      parts: ContentPart[],
    ) {
      if (provider === "cursor") {
        await cursorEvent(context, "send", commandId, { input: parts }, true);
        await cursorEvent(context, "result", commandId, { status: "finished" }, true);
      } else
        await emit(context, "recv", "snapshot.message", {
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
              nativeAutoReview: false,
            },
            steer: false,
            interruptCascades: false,
            fork: false,
            subagentTranscripts: false,
            backgroundTaskControl: false,
            backgroundVisibility: "none",
            planMode: false,
            tokenUsage: false,
            imageInput: false,
            rewindFiles: false,
          }),
        createTranslator(init) {
          return provider === "cursor" ? new CursorTranslator(init) : new OpenCodeTranslator(init);
        },
        async openSession(context) {
          if (provider === "cursor")
            context.onSessionIdentity?.({
              backend: "cursor-sdk",
              instanceId: "account-a",
              nativeSessionId: native,
            });
          if (provider === "cursor")
            await emit(context, "recv", "sdk", {
              schemaVersion: 1,
              generation: "transport-generation",
              operationId: "open",
              segment: 0,
              kind: "open",
              body: { cwd: h.home },
              agentId: native,
            });
          else
            await emit(context, "recv", "snapshot.info", {
              root: true,
              info: { id: native, location: { directory: h.home } },
            });
          return {
            nativeSessionId: native,
            ...(provider === "cursor"
              ? { backend: "cursor-sdk" as const, instanceId: "account-a" }
              : {}),
            async send(parts, _delivery, commandId) {
              if (!commandId) throw new Error("Missing command identity");
              const id = provider === "cursor" ? commandId : `native-${commandId}`;
              context.onInputMessage?.({ commandId, nativeId: id });
              latest = { context, commandId, id, parts };
              if (provider === "opencode")
                await emit(context, "note", "input.sending", { id, commandId });
              await sendInput(context, commandId, id, parts);
              if (provider === "cursor")
                await emit(context, "recv", "sdk", {
                  schemaVersion: 1,
                  generation: "transport-generation",
                  operationId: commandId,
                  commandId,
                  segment: 0,
                  kind: "result",
                  body: { status: "finished" },
                });
              else {
                await replayInput(context, commandId, id, parts);
                await emit(context, "recv", "snapshot.active", {
                  sessionID: native,
                  running: true,
                  revision: commandId,
                });
                await emit(context, "recv", "snapshot.active", {
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
    let parent = await h.create();
    let child = await h.fork(parent);
    if (provider === "opencode") {
      expect(
        h.command({ type: "thread.switch", threadId: parent, selection: { provider } }).ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.store.getThread(parent)?.provider).toBe(provider);
    }
    if (provider === "cursor") {
      // SDK runtime changes preserve the source checkpoint and use a fresh portable handoff.
      const recipient = ThreadId.parse(`cursor-${transition}`);
      expect(
        h.command({
          type: "thread.create",
          threadId: recipient,
          title: "SDK recipient",
          workspaceId: h.workspace,
          provider,
          accountId: "account-a",
          handoffFrom: parent,
          input: [{ type: "text", text: "Initialize SDK recipient" }],
        }).ok,
      ).toBe(true);
      parent = recipient;
      await h.engine.flush();
      expect(latest?.parts[0]).toEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("source history") }),
      );
      child = await h.fork(parent);
    }
    if (transition === "merge" || transition === "merged handoff") {
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
    assertTranscript(parent);
    await h.engine.flush();
    const sent = latest;
    expect(h.errors).toEqual([]);
    if (!sent) throw new Error("Missing native send");
    if (provider === "opencode" || transition === "merged handoff")
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
    await replayInput(resumed.context, sent.commandId, sent.id, sent.parts);
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
    await replayInput(reopened.context, copied.commandId, copied.id, copied.parts);
    await h.engine.flush();
    const copiedPage = h.store.readItemPage(parent, h.store.headSeq() + 1, 100).items;
    expect(copiedPage).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "user",
        nativeId: copied.id,
        parts: [expect.objectContaining({ type: "text", text: wake })],
      }),
    );
    expect(copiedPage.filter((entry) => entry.type === "delegation.settled")).toEqual(
      resultsBeforeCopy,
    );
    const unknownIdentity = `external-${"x".repeat(300)}`;
    await replayInput(reopened.context, unknownIdentity, unknownIdentity, [
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
      parts: [expect.objectContaining({ type: "text", text: "Uncorrelated native input" })],
    });
    // SDK envelopes are retained on the provider diagnostic stream; OpenCode attaches raw to items.
    const retained =
      provider === "cursor"
        ? diagnostics.filter((entry) => entry.threadId === parent)
        : unknownPage.items;
    expect(
      retained.some(
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
