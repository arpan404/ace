import { expect, test, vi } from "vitest";
import { DeviceId, ThreadId } from "@ace/protocol";
import { createOffshiftSession } from "./offshift.ts";
import type { SocketContext, SocketService } from "./socket.ts";

function context(overrides: {
  authorize?: (scope: string) => boolean;
  canRead?: boolean;
  offshifts?: { person: (...args: never[]) => Promise<never> } | undefined;
  sent?: unknown[];
  host?: boolean;
}): SocketContext {
  const sent = overrides.sent ?? [];
  return {
    options: {
      store: { devices: { get: () => undefined } },
      ...(overrides.offshifts === undefined ? {} : { offshifts: overrides.offshifts }),
    },
    authorize: (overrides.authorize ?? (() => true)) as SocketContext["authorize"],
    canReadThread: () => overrides.canRead ?? true,
    hostCredential: () => overrides.host ?? true,
    device: () => undefined,
    send: (message: unknown) => {
      sent.push(message);
    },
  } as unknown as SocketContext;
}

const threadId = ThreadId.parse("thread-1");
const device = DeviceId.parse("device-1");

async function handled(session: SocketService, message: unknown): Promise<unknown> {
  if (!session.handle) throw new Error("Offshift session handles nothing");
  return session.handle(message as never, device);
}

test("messages for other services are ignored", async () => {
  const sent: unknown[] = [];
  const session = createOffshiftSession(context({ sent }));
  await expect(handled(session, { type: "verify.request", op: {} })).resolves.toBe(false);
  expect(sent).toEqual([]);
});

test("a read the device may see calls the person's read and answers it", async () => {
  const sent: unknown[] = [];
  const person = vi.fn().mockResolvedValue({ ok: true, view: { run: { id: "login" } } });
  const session = createOffshiftSession(context({ sent, offshifts: { person: person as never } }));
  const op = { action: "get", runId: "login" } as const;
  await expect(
    handled(session, { type: "offshift.request", requestId: "r1", threadId, op }),
  ).resolves.toBe(true);
  expect(person).toHaveBeenCalledWith(threadId, op, "r1", {
    kind: "person",
    deviceId: null,
    device: null,
  });
  expect(sent).toMatchObject([{ type: "offshift.result", requestId: "r1", ok: true }]);
});

test("a change needs operate scope and a readable thread", async () => {
  const forbidden: unknown[] = [];
  const session = createOffshiftSession(
    context({
      sent: forbidden,
      authorize: () => false,
      offshifts: { person: (async () => ({ ok: true })) as never },
    }),
  );
  await handled(session, {
    type: "offshift.request",
    requestId: "r2",
    threadId,
    op: { action: "step", runId: "login", expectedVersion: 5, stepId: "repro", state: "done" },
  });
  expect(forbidden).toMatchObject([
    { type: "offshift.result", requestId: "r2", ok: false, error: "forbidden" },
  ]);

  const unreadable: unknown[] = [];
  const unreadableSession = createOffshiftSession(
    context({
      sent: unreadable,
      canRead: false,
      offshifts: { person: (async () => ({ ok: true })) as never },
    }),
  );
  await handled(unreadableSession, {
    type: "offshift.request",
    requestId: "r3",
    threadId,
    op: { action: "get", runId: "login" },
  });
  expect(unreadable).toMatchObject([
    { type: "offshift.result", requestId: "r3", ok: false, error: "forbidden" },
  ]);
});

test("without the service the person hears it is unavailable", async () => {
  const sent: unknown[] = [];
  const session = createOffshiftSession(context({ sent, offshifts: undefined }));
  await handled(session, {
    type: "offshift.request",
    requestId: "r4",
    threadId,
    op: { action: "get", runId: "login" },
  });
  expect(sent).toMatchObject([
    { type: "offshift.result", requestId: "r4", ok: false, error: "unavailable" },
  ]);
});
