import { z } from "zod";

export const TrayTab = z.enum(["agents", "apps", "usage"]);
export type TrayTab = z.infer<typeof TrayTab>;

export const TrayAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tab"), tab: TrayTab }),
  z.object({ action: z.literal("thread"), id: z.string().max(128) }),
  z.object({ action: z.enum(["open", "usage", "settings", "quit", "quitCompletely"]) }),
  z.object({ action: z.literal("pause"), paused: z.boolean() }),
  z.object({ action: z.literal("enable"), enabled: z.boolean() }),
  z.object({ action: z.enum(["takeover", "stop", "reset"]), id: z.string().max(256) }),
]);
export type TrayAction = z.infer<typeof TrayAction>;
