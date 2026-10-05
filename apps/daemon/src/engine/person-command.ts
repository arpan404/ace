import { Command } from "@ace/protocol";

/** Public commands cannot claim an origin or title source reserved for host agents. */
export function personCommand(command: Command): Command {
  const p = command.payload;
  if (p.type === "thread.create" || p.type === "thread.send") {
    const { origin: _origin, trigger: _trigger, ...person } = p;
    return Command.parse({ ...command, payload: { ...person, trigger: "user" } });
  }
  if (p.type === "thread.prepare") {
    const { titleSource: _source, ...person } = p;
    return Command.parse({ ...command, payload: person });
  }
  return command;
}
