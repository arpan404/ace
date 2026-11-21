import { basicHandlers } from "./basics.ts";
import { botHandlers } from "./bot.ts";
import { botKitHandlers } from "./bot-kit.ts";
import type { Handlers } from "./context.ts";
import { machineHandlers } from "./machine.ts";
import { providerHandlers } from "./providers.ts";
import { agentToolHandlers } from "./agent-tools.ts";
import { marketHandlers } from "./market.ts";
import { orgHandlers } from "./org.ts";
import { spadeHandlers } from "./spade.ts";
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
  ...spadeHandlers,
  ...botHandlers,
  ...botKitHandlers,
  ...marketHandlers,
  ...orgHandlers,
  ...agentToolHandlers,
};
