/*
 * Where a machine settings change goes while Settings is open: the machine whose page shows, or
 * every paired machine. A machine takes a change only when it is connected and this device may
 * change it; one that is offline keeps its own value, and one this device may only view is never
 * a target. The footer under the scope control says so, in these words on every client.
 */

export interface ScopeMachine {
  id: string;
  name: string;
  /** Connected now. */
  connected: boolean;
  /** This device may change it (not view-only). */
  canOperate: boolean;
}

export interface SettingsScopePlan {
  /** Machines a change goes to, by id. */
  send: string[];
  /** One line under the scope control. */
  footer: string;
}

export function settingsScopePlan(input: {
  all: boolean;
  /** The machine whose page is showing. */
  current: string;
  machines: readonly ScopeMachine[];
}): SettingsScopePlan {
  const machines = input.all
    ? input.machines
    : input.machines.filter((machine) => machine.id === input.current);
  const viewOnly = machines.filter((machine) => !machine.canOperate);
  const offline = machines.filter((machine) => machine.canOperate && !machine.connected);
  // The page's own machine takes a change made on its page even while it reconnects: the write
  // waits on the connection and fails in words if it can't go.
  const send = machines.filter(
    (machine) =>
      machine.canOperate && (machine.connected || (!input.all && machine.id === input.current)),
  );
  const sentences: string[] = [];
  if (send.length)
    sentences.push(
      `Saved on ${listWords(send.map((machine) => machine.name))}${input.all ? "" : " only"}.`,
    );
  else if (!viewOnly.length) sentences.push("No machine can take changes now.");
  if (input.all && offline.length)
    sentences.push(
      offline.length === 1
        ? `${offline[0]?.name} isn't connected and keeps its own.`
        : `${listWords(offline.map((machine) => machine.name))} aren't connected and keep their own.`,
    );
  if (viewOnly.length)
    sentences.push(
      `${listWords(viewOnly.map((machine) => machine.name))} ${viewOnly.length === 1 ? "is" : "are"} view-only from this phone.`,
    );
  return { send: send.map((machine) => machine.id), footer: sentences.join(" ") };
}

/** "studio", "studio and mini", "studio, mini and laptop". */
function listWords(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
