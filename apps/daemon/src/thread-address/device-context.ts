import type { DeviceContextItem, FleetLink } from "@ace/protocol";

/*
 * What the agent reads of a device the person named with `@` (ADR 0198): which it is, where,
 * whether it can be reached now, and how to use it with the tools the agent already has. The
 * machine is checked again here; one this machine no longer links to is left out, so a chip
 * naming a removed machine stays the person's plain words. Pure.
 */

const kindWords: Record<DeviceContextItem["kind"], string> = {
  laptop: "a laptop",
  desktop: "a desktop",
  server: "a server",
  phone: "a paired phone",
  tablet: "a paired tablet",
  browser: "a paired browser",
  simulator: "an iOS simulator",
  emulator: "an Android emulator",
};

/** Whether the item names a machine itself rather than a device on one. */
const isMachine = (item: DeviceContextItem) => item.id === item.machine.id;

/**
 * The block the agent reads, or undefined when the machine is gone. `links` are this machine's
 * links to the person's other machines.
 */
export function deviceContextText(
  item: DeviceContextItem,
  links: readonly Pick<FleetLink, "hostId" | "profile" | "name" | "status">[],
): string | undefined {
  const link = item.machine.here
    ? undefined
    : links.find((each) => each.hostId === item.machine.id);
  if (!item.machine.here && !link) return undefined;
  // A linked machine reads as its link says now; the person's app may have seen it earlier.
  const online = link ? link.status === "online" && item.online : item.online;
  const where = item.machine.here
    ? "this machine, where you run"
    : `the machine "${link?.name ?? item.machine.name}"`;
  const what = isMachine(item)
    ? `${item.machine.here ? "This machine" : `The machine "${link?.name ?? item.name}"`}${item.os ? ` (${item.os})` : ""}`
    : `"${item.name}", ${kindWords[item.kind]}${item.model ? ` (${item.model})` : ""}${item.os ? `, ${item.os}` : ""}, on ${where}`;
  const lines = [
    `<device id=${JSON.stringify(item.id)} machine=${JSON.stringify(item.machine.id)} kind="${item.kind}" online="${online}">`,
    `The person named a device for this work: ${what}.`,
    online
      ? "It can be reached now."
      : "It is offline now: don't try to use it; say so, and carry on without it or wait.",
  ];
  if (link)
    lines.push(
      `Use it by passing machine "${link.profile}" to delegate, run, browser and screen tools.`,
    );
  if (item.kind === "simulator" || item.kind === "emulator")
    lines.push(`Drive it with the screen and simulator tools, device id "${item.id}".`);
  lines.push("</device>");
  return lines.join("\n");
}
