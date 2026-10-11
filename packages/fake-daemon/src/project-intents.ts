import type { Command, CommandResult } from "@ace/protocol";
import type { FakeProjects } from "./projects.ts";

/** Own command receipts and active clone/publication flights across reconnects. */
export function projectIntent(command: Command, ports: {
  refusal: string | undefined;
  receipts: Map<string, { deviceId: Command["deviceId"]; result: CommandResult }>;
  flights: Map<string, { device: string; result: Promise<CommandResult> }>;
  projects: Pick<FakeProjects, "clone" | "publish">;
}): Promise<CommandResult> {
  const payload = command.payload;
  if (payload.type !== "workspace.clone" && payload.type !== "workspace.publish")
    return Promise.resolve({ commandId: command.id, ok: false, error: "command_failed" });
  if (ports.refusal) return Promise.resolve({ commandId: command.id, ok: false, error: ports.refusal });
  const prior = ports.receipts.get(command.id);
  if (prior) return Promise.resolve(prior.deviceId === command.deviceId ? prior.result
    : { commandId: command.id, ok: false, error: "forbidden" });
  const pending = ports.flights.get(command.id);
  if (pending) return pending.device === command.deviceId ? pending.result
    : Promise.resolve({ commandId: command.id, ok: false, error: "forbidden" });
  const result = (payload.type === "workspace.publish"
    ? ports.projects.publish(payload, command.deviceId)
    : ports.projects.clone(payload, command.id, command.deviceId)).then((outcome) => {
    const receipt = { commandId: command.id, ...outcome };
    ports.receipts.set(command.id, { deviceId: command.deviceId, result: receipt });
    ports.flights.delete(command.id);
    return receipt;
  });
  ports.flights.set(command.id, { device: command.deviceId, result });
  return result;
}
