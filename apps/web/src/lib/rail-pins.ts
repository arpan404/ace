import { RailPins } from "@ace/ui-core";
import { useDeviceSetting } from "./device-setting.ts";

const none: RailPins = [];

/*
 * The accounts pinned to the rail on this device, by account id, in the order pinned. The Usage
 * page pins them; the rail's bars and card show them, else the accounts used most this week.
 */
export function useRailPins(): [RailPins, (pins: RailPins) => void] {
  return useDeviceSetting("ace.usage.railPins", RailPins, none);
}
