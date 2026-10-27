import { z } from "zod";
import { DeviceId } from "./ids.ts";

/**
 * What agents from a linked machine may do here, one grant per capability per calling device
 * (ADR 0105). The target holds them; the calling machine only reads its effective levels.
 */
export const MachineCapability = z.enum(["agents", "browser", "devices", "screen", "commands"]);
export type MachineCapability = z.infer<typeof MachineCapability>;
/** Off, Read only, or Read and act. */
export const MachineGrantLevel = z.enum(["off", "read", "operate"]);
export type MachineGrantLevel = z.infer<typeof MachineGrantLevel>;
export const MachineGrants = z.object({
  agents: MachineGrantLevel,
  browser: MachineGrantLevel,
  devices: MachineGrantLevel,
  screen: MachineGrantLevel,
  commands: MachineGrantLevel,
});
export type MachineGrants = z.infer<typeof MachineGrants>;

/** One calling device's grants here: each level, and which the person set apart. */
export const MachineDeviceGrants = z.object({
  deviceId: DeviceId,
  grants: MachineGrants,
  /** Capabilities with a level of their own; the rest follow the defaults. */
  chosen: z.array(MachineCapability).max(5),
});
export type MachineDeviceGrants = z.infer<typeof MachineDeviceGrants>;
