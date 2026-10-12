import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, onTestFinished } from "vitest";
import { AccountService, createInstance, openRegistryIndex } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { startDaemonMcp } from "../mcp.ts";
import { bindMcpSession } from "../services/mcp-session.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { dispatch, text } from "./recovery-test-support.ts";
import { Engine } from "@ace/daemon";

test.each(["send", "open", "preparation failure"])(
  "a Claude account selected during open survives restart after %s",
  async (confirmation) => {
    const frames = scriptFrames();
    let failPreparation = confirmation === "preparation failure";
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: "claude",
      beforeSend: async () => {
        if (failPreparation) throw new Error("Input preparation failed");
      },
    });
    let restarted: Engine | undefined;
    const registry = await openRegistryIndex(join(h.home, "accounts.sqlite"));
    const mcp = await startDaemonMcp(h.store);
    onTestFinished(async () => {
      await restarted?.close();
      await h.close();
      await mcp.close();
      registry.close();
    });
    const homeDir = join(h.home, "selected-claude");
    await mkdir(homeDir);
    const selected = createInstance({
      id: "selected-claude",
      provider: "claude",
      label: "Work",
      homeDir,
    });
    await registry.register(selected);
    registry.ingest(selected.id, {
      provider: "claude",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: h.clock.now(),
      timeZone: "UTC",
    });
    const accounts = new AccountService({
      registry,
      env: { HOME: h.home },
      now: h.clock.now,
      timeZone: "UTC",
    });
    const opens: { instance: string | undefined; resume: string | undefined }[] = [];
    const native = {
      ...h.adapter,
      async openSession(ctx: import("@ace/engine-api").SessionContext) {
        opens.push({ instance: ctx.instanceId, resume: ctx.resume?.nativeSessionId });
        const session = await h.adapter.openSession(ctx);
        let confirmed = Boolean(ctx.resume);
        if (confirmation === "open") {
          confirmed = true;
          ctx.onSessionConfirmed?.("confirmed-transcript");
        }
        return {
          ...session,
          get sessionConfirmed() {
            return confirmed;
          },
          get nativeSessionId() {
            return confirmed ? "confirmed-transcript" : "provisional";
          },
          async send(...args: Parameters<typeof session.send>) {
            confirmed = true;
            ctx.onSessionConfirmed?.("confirmed-transcript");
            await session.send(...args);
          },
        };
      },
    };
    const bound = accounts.bindAdapter({
      ...native,
      create: async () => ({
        ...native,
        openSession: (ctx) =>
          bindMcpSession(native, ctx, {
            mcp,
            store: h.store,
            id: () => "test-mcp",
            capabilities: [],
          }),
      }),
    });
    h.registry.register(bound, { installed: true, auth: "logged_in", loginHint: "" });
    const id = await h.create();
    expect(h.engine.sessionMetadata(id)).toMatchObject({ instanceId: selected.id });
    if (failPreparation) expect(h.engine.sessionMetadata(id)).not.toHaveProperty("nativeSessionId");
    else expect(h.engine.sessionMetadata(id).nativeSessionId).toBe("confirmed-transcript");
    await h.engine.close();
    failPreparation = false;
    restarted = new Engine(h.store, { registry: h.registry, clock: h.clock });
    await restarted.flush();
    dispatch(
      h.store,
      restarted,
      confirmation === "preparation failure"
        ? { type: "queue.resume", threadId: id, expectedRevision: restarted.queue(id).revision }
        : { type: "thread.send", threadId: id, input: text("second") },
      "after-restart",
    );
    await restarted.flush();
    expect(opens).toEqual([
      { instance: selected.id, resume: undefined },
      {
        instance: selected.id,
        resume: confirmation === "preparation failure" ? undefined : "confirmed-transcript",
      },
    ]);
    expect(restarted.queue(id).pendingCount).toBe(0);
    expect(restarted.queue(id).lastFailure).toBeNull();
  },
);
