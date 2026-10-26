import { expect, it } from "vitest";
import { CommandId, DeviceId, HostId } from "@ace/protocol";
import { setup } from "../remote-test-support.ts";

it("a device without projects is refused a transfer with its code and words, over its socket", async () => {
  const f = await setup();
  const paired = await f.pair(["read", "operate"]);
  const issued = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, issued.ticket);
  expect((await client.next()).type).toBe("welcome");
  client.send({
    type: "command",
    command: {
      id: CommandId.parse("move-it"),
      deviceId: DeviceId.parse(paired.device.id),
      payload: {
        type: "thread.continueOn",
        threadId: f.thread.id,
        hostId: HostId.parse("host-studio"),
        includeChanges: true,
      },
    },
  });

  const answer = await client.next();
  expect(answer).toMatchObject({
    type: "commandResult",
    commandId: "move-it",
    ok: false,
    error: "forbidden",
    code: "forbidden",
  });
  expect(answer.type === "commandResult" ? answer.detail : undefined).toMatch(/Projects allowed/);
});
