import { RailMeasure } from "@ace/ui-core";
import { useDeviceSetting } from "./device-setting.ts";

/*
 * What the rail's Usage bars show on this device: each account's week (the default) or its
 * session. Settings › General sets it; the rail reads it, and both update together.
 */
export function useRailMeasure(): [RailMeasure, (measure: RailMeasure) => void] {
  return useDeviceSetting("ace.usage.railMeasure", RailMeasure, "week");
}
