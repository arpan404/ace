import { expect, test } from "vitest";
import { DeviceId, ThreadId } from "@ace/protocol";
import { ToolEnvVault } from "@ace/accounts";
import type { SocketContext } from "./socket.ts";
import { createProviderToolEnvSession } from "./provider-tool-env.ts";

const thread = ThreadId.parse("thread-aaaaaaaa");
const device = DeviceId.parse("device");
function context(
  vault: ToolEnvVault,
  overrides: Partial<{
    operate: boolean;
    secret: boolean;
    live: boolean;
  }> = {},
): { context: SocketContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const stub = {
    authorize: (scope: string) => overrides.operate !== false && scope === "operate",
    canSubmitSecret: () => overrides.secret !== false,
    connected: () => true,
    send: (message: unknown) => {
      sent.push(message);
    },
    options: {
      toolEnvVault: vault,
      store: {
        getThread: (id: string) =>
          id === thread && overrides.live !== false ? { deletedAt: undefined } : undefined,
      },
    },
  } as unknown as SocketContext;
  return { context: stub, sent };
}

test("submit stores filtered entries, blanks transport copies and reports the count", async () => {
  const vault = new ToolEnvVault();
  const { context: ctx, sent } = context(vault);
  const message = {
    type: "provider.toolEnv.submit" as const,
    requestId: "r1",
    threadId: thread,
    entries: [{ key: "GH_TOKEN" as const, value: "gho_session" }],
  };
  const service = createProviderToolEnvSession(ctx);
  expect(await service.handle?.(message, device)).toBe(true);
  expect(vault.get(thread)).toEqual({ GH_TOKEN: "gho_session" });
  expect(message.entries[0]?.value).toBe("");
  expect(sent).toEqual([
    { type: "provider.toolEnv.result", requestId: "r1", result: { ok: true, stored: 1 } },
  ]);
});

test("submit is forbidden without operate scope or secret submission rights", async () => {
  for (const overrides of [{ operate: false }, { secret: false }]) {
    const vault = new ToolEnvVault();
    const { context: ctx, sent } = context(vault, overrides);
    const service = createProviderToolEnvSession(ctx);
    expect(
      await service.handle?.(
        {
          type: "provider.toolEnv.submit" as const,
          requestId: "r1",
          threadId: thread,
          entries: [{ key: "GH_TOKEN" as const, value: "gho_session" }],
        },
        device,
      ),
    ).toBe(true);
    expect(vault.size).toBe(0);
    expect(sent).toEqual([
      {
        type: "provider.toolEnv.result",
        requestId: "r1",
        result: { ok: false, error: "forbidden" },
      },
    ]);
  }
});

test("unknown threads and other message types are refused or ignored", async () => {
  const vault = new ToolEnvVault();
  const { context: ctx, sent } = context(vault, { live: false });
  const service = createProviderToolEnvSession(ctx);
  expect(
    await service.handle?.(
      {
        type: "provider.toolEnv.submit" as const,
        requestId: "r1",
        threadId: thread,
        entries: [{ key: "GH_TOKEN" as const, value: "gho_session" }],
      },
      device,
    ),
  ).toBe(true);
  expect(sent).toEqual([
    { type: "provider.toolEnv.result", requestId: "r1", result: { ok: false, error: "not_found" } },
  ]);
  expect(
    await service.handle?.({ type: "provider.login.poll", requestId: "x", session: "y" }, device),
  ).toBe(false);
});

test("clear releases the thread's entries", async () => {
  const vault = new ToolEnvVault();
  vault.submit(thread, { GH_TOKEN: "gho_session" });
  const { context: ctx, sent } = context(vault);
  const service = createProviderToolEnvSession(ctx);
  expect(
    await service.handle?.(
      { type: "provider.toolEnv.clear" as const, requestId: "r2", threadId: thread },
      device,
    ),
  ).toBe(true);
  expect(vault.get(thread)).toBeUndefined();
  expect(sent).toEqual([
    { type: "provider.toolEnv.result", requestId: "r2", result: { ok: true, stored: 0 } },
  ]);
});
