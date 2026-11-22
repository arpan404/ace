import { expect, it } from "vitest";
import { CommandId, DeviceId, ThreadId, type Command, type ServerMessage } from "@ace/protocol";
import { MaintenanceGate } from "@ace/service";
import { commandLane, CommandLanes } from "./command-lanes.ts";
import { admitCommand, type CommandAdmission } from "./socket-commands.ts";
import type { ServerOptions } from "./server-options.ts";

// ADR 0209 §4.2: a command decided at admission waits in its thread's lane; the access it was
// allowed under may end meanwhile, so it is decided again the moment it runs.

const device = DeviceId.parse("phone");
const command = (id: string): Command => ({
  id: CommandId.parse(id),
  deviceId: device,
  payload: {
    type: "thread.send",
    threadId: ThreadId.parse("t_tree"),
    input: [{ type: "text", text: "go on" }],
  },
});

it("a command whose access ended while it waited in its lane is refused when its turn comes", async () => {
  const lanes = new CommandLanes();
  const ran: string[] = [];
  const sent: ServerMessage[] = [];
  // An earlier command holds the thread's lane.
  const busy = Promise.withResolvers<void>();
  void lanes.run(
    commandLane(command("cmd_first"), device),
    device,
    "cmd_first",
    () => busy.promise,
  );
  let stillAllowed = true;
  const admission: CommandAdmission = {
    options: { store: { getThread: () => undefined } } as unknown as ServerOptions,
    device,
    routes: [
      {
        types: ["thread.send"],
        scope: () => "operate",
        accept: async (accepted) => {
          ran.push(accepted.id);
        },
      },
    ],
    maintenance: new MaintenanceGate(() => 0),
    lanes,
    flights: { count: 0 },
    open: () => true,
    authorize: () => true,
    personProven: () => false,
    send: (message) => sent.push(message),
    delay: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    recheck: () => stillAllowed,
  };
  const admitted = admitCommand(command("cmd_waiting"), admission);
  // Her standing lapses while the command waits its turn.
  stillAllowed = false;
  busy.resolve();
  await admitted;
  await lanes.settled();
  expect(ran).toEqual([]);
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "error", code: "forbidden", commandId: "cmd_waiting" }),
  );
});
