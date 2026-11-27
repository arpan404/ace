// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `commands.json`, the fixtures for T3's Rust command lanes and command status.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-command-vectors.ts
 *
 * `commandState` (`apps/daemon/src/command-status.ts`) produces bytes a client reads (a
 * `commandResult` and a `command.status` entry); `commandLane` (`command-lanes.ts`) produces the
 * key that orders commands, never sent. Both are recorded from the TypeScript.
 */

import { join } from "node:path";
import type { Command, DeviceId } from "@ace/protocol";
import { commandLane } from "../../../../../apps/daemon/src/command-lanes.ts";
import { commandState } from "../../../../../apps/daemon/src/command-status.ts";
import { writeVectors } from "../../../vectors/vectors-io.ts";

const device = "phone" as DeviceId;

const commands: Command[] = [
  {
    id: "c1" as Command["id"],
    deviceId: device,
    payload: {
      type: "thread.send",
      threadId: "t_tree" as never,
      input: [{ type: "text", text: "go on" }],
    },
  },
  {
    id: "c2" as Command["id"],
    deviceId: device,
    payload: { type: "thread.interrupt", threadId: "t_tree" as never },
  },
  {
    id: "c3" as Command["id"],
    deviceId: device,
    payload: { type: "thread.moved", threadId: "t_other" as never },
  },
  {
    id: "c4" as Command["id"],
    deviceId: device,
    payload: { type: "workspace.archive", workspaceId: "w_one" as never },
  },
  {
    id: "c5" as Command["id"],
    deviceId: device,
    payload: { type: "thread.fork", link: { threadId: "t_tree" } },
  },
  {
    id: "c6" as Command["id"],
    deviceId: device,
    payload: { type: "device.ping" },
  } as unknown as Command,
];

const lanes = commands.map((command) => ({
  command: JSON.stringify(command),
  device,
  key: commandLane(command, device),
}));

const receipts: { name: string; receipt: unknown }[] = [
  { name: "unknown", receipt: null },
  {
    name: "stored ok",
    receipt: { commandId: "c1", ok: true },
  },
  {
    name: "stored failure",
    receipt: { commandId: "c1", ok: false, error: "provider_failed" },
  },
  {
    name: "pending reservation",
    receipt: { commandId: "c1", ok: false, error: "client_action_pending" },
  },
];

const statuses = receipts.map(({ name, receipt }) => {
  const state = commandState("c1" as never, receipt as never, false);
  return {
    name,
    commandId: "c1",
    receipt: receipt === null ? null : JSON.stringify(receipt),
    inFlight: false,
    state: state.state,
    result: state.result === undefined ? null : JSON.stringify(state.result),
  };
});
statuses.push({
  name: "running even with a receipt",
  commandId: "c1",
  receipt: JSON.stringify({ commandId: "c1", ok: true }),
  inFlight: true,
  state: commandState("c1" as never, { commandId: "c1", ok: true } as never, true).state,
  result: null,
});

writeVectors(join(import.meta.dir, "commands.json"), { lanes, statuses });
