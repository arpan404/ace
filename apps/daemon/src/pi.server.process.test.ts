import { expect, test } from "vitest";
import { fixture } from "./socket-test-support.ts";
import { setup as remoteSetup } from "./remote-test-support.ts";
import type { PiControlResult } from "@ace/protocol";
import type { PiService } from "./services/pi.ts";
/** Native control boundary, synthetic references only. No provider CLI is launched. */
function nativeControls(): PiService {
  let fork = 0;
  return {
    register() {},
    async handle(request): Promise<PiControlResult> {
      return {
        type: "pi.result",
        requestId: request.requestId,
        result:
          request.operation.kind === "profile"
            ? {
                ok: true,
                profile: {
                  version: "0.85.1",
                  supported: true,
                  rollbackConversation: true,
                  extensionDialogs: true,
                  mcpExtension: true,
                  permissions: ["unrestricted", "read_only"],
                },
              }
            : { ok: true, nativeSessionId: `synthetic-fork-${++fork}` },
      };
    },
  };
}
test("read-scoped clients can inspect Pi profiles but cannot invoke native history controls", async () => {
  const f = await remoteSetup({ pi: nativeControls() });
  const device = await f.pair(["read"]);
  const client = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await client.next();
  client.send({
    type: "pi.control",
    requestId: "profile",
    threadId: f.thread.id,
    operation: { kind: "profile" },
  });
  expect(await client.next()).toMatchObject({ type: "pi.result", result: { ok: true } });
  client.send({
    type: "pi.control",
    requestId: "rollback",
    threadId: f.thread.id,
    operation: { kind: "rollback", entryId: "entry" },
  });
  expect(await client.next()).toMatchObject({
    type: "pi.result",
    result: { ok: false, error: "operate scope and thread access required" },
  });
});
test("Pi wire receipts replay results once and reject reuse for changed operations", async () => {
  const f = await fixture({ pi: nativeControls() });
  try {
    const client = await f.connect();
    await client.next();
    const request = {
      type: "pi.control" as const,
      requestId: "fork",
      threadId: f.thread.id,
      operation: { kind: "fork" as const },
    };
    client.send(request);
    const result = await client.next();
    expect(result).toMatchObject({
      type: "pi.result",
      result: { ok: true, nativeSessionId: "synthetic-fork-1" },
    });
    client.send(request);
    expect(await client.next()).toEqual(result);
    client.send({ ...request, operation: { kind: "rollback", entryId: "entry" } });
    expect(await client.next()).toMatchObject({
      type: "pi.result",
      result: { ok: false, error: "Pi request id reused for different content" },
    });
    client.send({ ...request, requestId: "fork-again" });
    expect(await client.next()).toMatchObject({
      type: "pi.result",
      result: { ok: true, nativeSessionId: "synthetic-fork-2" },
    });
  } finally {
    await f.close();
  }
});
