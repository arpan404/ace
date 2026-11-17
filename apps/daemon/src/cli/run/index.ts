import { basicHandlers } from "./basics.ts";
import type { Handlers } from "./context.ts";
import { machineHandlers } from "./machine.ts";
import { providerHandlers } from "./providers.ts";
import { toolHandlers } from "./tools.ts";
import { workHandlers } from "./work.ts";

/**
 * Command id to its handler. Handlers import their command's module only when they run, so
 * `ace start` carries none of the others, and a broken module breaks only its own command.
 */
export const handlers: Handlers = {
  ...basicHandlers,
  ...workHandlers,
  ...machineHandlers,
  ...providerHandlers,
  ...toolHandlers,
};
