import type { Command, DeviceId, DeviceScope, ServerMessage } from "@ace/protocol";
import type { MaintenanceGate } from "@ace/service";
import { commandNotDispatched } from "./command-not-dispatched.ts";
import { commandLane, settledWithin, type CommandLanes } from "./command-lanes.ts";
import type { ServerOptions } from "./server-options.ts";
import type { CommandRegistration } from "./services/socket.ts";

/** A fast command finishes before the socket reads on, keeping its order with later reads. */
const commandGraceMs = 250;
/** Commands one socket may leave running before its input waits for them. */
const commandFlights = 64;

/** What command admission needs from one authenticated socket. */
export interface CommandAdmission {
  options: ServerOptions;
  device: DeviceId;
  routes: readonly CommandRegistration[];
  maintenance: MaintenanceGate;
  lanes: CommandLanes;
  /** Commands this socket left running on their lanes. */
  flights: { count: number };
  open(): boolean;
  authorize(scope: DeviceScope): boolean;
  send(message: ServerMessage): void;
  delay(run: () => void, milliseconds: number): () => void;
}

/**
 * Admit one command: scope, device and maintenance checks, then its lane. Resolves once the
 * command settles or its grace runs out, so the socket can read on while slow work continues.
 */
export async function admitCommand(command: Command, admission: CommandAdmission): Promise<void> {
  const { options, device, maintenance, lanes, authorize, send } = admission;
  const route = admission.routes.find((service) => service.types.includes(command.payload.type));
  const scope = route?.scope(command) ?? "operate";
  // Refusals carry the command id so the client settles that intent alone and keeps
  // its connection; transient ones leave the intent pending for a retry.
  const refuse = (code: string, text: string, retryable = false) =>
    send({
      type: "error",
      code,
      message: text,
      commandId: command.id,
      ...(retryable ? { retryable } : {}),
    });
  const refuseBeforeAccept = (code: string, text: string, retryable = false) => {
    const receipt = route?.refused?.(command, code);
    if (receipt) {
      send({ type: "commandResult", ...receipt });
      return;
    }
    if (command.payload.type !== "forge.issue.write") {
      refuse(code, text, retryable);
      return;
    }
    // An admission refusal says nothing about an earlier attempt with this ID.
    // Look up only the authenticated device's receipt, never the payload's owner.
    const uncertain = {
      commandId: command.id,
      ok: false,
      error: "action_outcome_uncertain",
    };
    try {
      const previous = options.store.commandReceipt(command.id, device);
      send({
        type: "commandResult",
        ...(previous
          ? previous.error === "client_action_pending"
            ? uncertain
            : previous
          : commandNotDispatched(command, code)),
      });
    } catch {
      send({ type: "commandResult", ...uncertain });
    }
  };
  if (!authorize(scope)) {
    refuseBeforeAccept("forbidden", `${scope} scope required`);
    return;
  }
  if (!admission.open()) return;
  if (!authorize(scope)) {
    refuseBeforeAccept("forbidden", `${scope} scope required`);
    return;
  }
  if (command.deviceId !== device) {
    refuseBeforeAccept("device_mismatch", "Command device must match hello");
    return;
  }
  if (!maintenance.admitCommand(command)) {
    refuseBeforeAccept(
      "maintenance",
      "New work is paused. Resume new work in ace to continue.",
      true,
    );
    return;
  }
  if (!route) {
    refuseBeforeAccept("not_implemented", "Command is not supported");
    return;
  }
  // Accepted commands run on their thread's lane, not on this socket's input queue:
  // a command still waiting after the grace keeps running while the socket goes on.
  const task = lanes.run(commandLane(command, device), device, command.id, async () => {
    try {
      await route.accept(command, device);
    } catch (error) {
      options.log?.(error);
      refuse("command_failed", "Command transaction rolled back", true);
    }
  });
  admission.flights.count++;
  void task.finally(() => admission.flights.count--);
  // Bounded work per socket: past the cap the queue waits, so TCP backpressure applies.
  if (admission.flights.count > commandFlights) await task;
  else await settledWithin(task, commandGraceMs, admission.delay);
}
