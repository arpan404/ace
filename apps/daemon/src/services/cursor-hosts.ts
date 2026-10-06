import { CursorHostSlots } from "@ace/adapter-cursor/slots";
import type { ServiceContext } from "./types.ts";

/** Service composition owns a shared lifetime/capacity index, never a global process manager. */
export function cursorHosts(context: ServiceContext): CursorHostSlots {
  context.services.cursorHosts ??=
    context.options.engine?.cursor?.slots ??
    new CursorHostSlots(context.options.engine?.cursor?.limits?.maxWorkers ?? 8);
  return context.services.cursorHosts;
}
