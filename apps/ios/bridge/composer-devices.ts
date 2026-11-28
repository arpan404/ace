import type { ClientCore } from "@ace/client";
import { AppDevice } from "@ace/protocol";
import { hostPlatform, type PickerDevice } from "@ace/ui-core";
import { machineKind } from "@ace/ui-core/fleet-map";
import { z } from "zod";

/*
 * The devices `@` offers on the phone (ADR 0198): the machine this thread runs on, then its
 * simulators and emulators as its own devices list names them. Read leniently through the SDK,
 * as the web's picker reads another machine's list; a source that can't be read lists nothing.
 */

const DeviceList = z.object({ devices: z.array(z.unknown()).max(1024).catch([]) });
// Short: the files `@` lists wait on this read, and a slow device list mustn't hold them.
const quiet = { timeoutMs: 3_000 };
const osWords: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** A simulator, emulator or phone a machine's devices list, as a picker row. */
function appRow(device: z.infer<typeof AppDevice>, machine: PickerDevice["machine"]): PickerDevice {
  const physical = device.serial !== undefined && device.platform === "android";
  return {
    id: device.id,
    name: device.name,
    kind: physical ? "phone" : device.platform === "ios" ? "simulator" : "emulator",
    machine,
    os: device.runtime,
    model: physical ? undefined : device.name,
    online: device.state === "booted",
  };
}

/** This machine and the devices ace knows on it, for `@` a device. */
export async function readMentionDevices(
  owner: Pick<ClientCore, "request">,
  id: () => string,
): Promise<PickerDevice[]> {
  const [identity, listed] = await Promise.all([
    owner.request({ type: "host.identity", requestId: id() }, quiet).catch(() => undefined),
    owner
      .request({ type: "devices.request", operation: { op: "list" } }, quiet)
      .catch(() => undefined),
  ]);
  const host = identity?.identity;
  const name = host?.displayName.trim() || "This computer";
  const platform = hostPlatform(host?.platform);
  const machine = { id: host?.hostId ?? "", name, here: true as const };
  const rows: PickerDevice[] = [];
  if (machine.id)
    rows.push({
      id: machine.id,
      name,
      kind: machineKind({ icon: host?.icon?.kind, name, platform }),
      machine,
      os: platform ? osWords[platform] : undefined,
      online: true,
    });
  const devices = listed?.ok ? (DeviceList.safeParse(listed.data).data?.devices ?? []) : [];
  for (const raw of devices) {
    const read = AppDevice.safeParse(raw);
    if (read.success) rows.push(appRow(read.data, machine));
  }
  return rows;
}
