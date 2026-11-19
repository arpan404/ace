import { realpath } from "node:fs/promises";
import { namedFetch } from "@ace/client/ace-client";
import { userInfo } from "node:os";
import { join } from "node:path";
import { marketOrigin, shippedMarketKeys } from "@ace/marketplace";
import { gitRuntime } from "@ace/plugins";
import {
  marketReadOperations,
  type MarketOperation,
  type MarketResult,
  type MarketServerMessage,
} from "@ace/protocol/marketplace";
import type { SettingsService } from "@ace/settings";
import { betaKeys } from "@ace/settings/beta";
import { pickPorts } from "../marketplace/pick-ports.ts";
import { pluginPort } from "../marketplace/plugin-port.ts";
import { MarketplaceService } from "../marketplace/service.ts";
import { MarketAgent } from "../marketplace/market-agent.ts";
import { hostMarketRefusal } from "../marketplace/fresh-sign-in.ts";
import { spadePort } from "../marketplace/spade-port.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import type { ServiceContext } from "./types.ts";

/** ace's marketplace (ADR 0168) under the per-user ace root. Nothing waits on the network here. */
export async function startMarketplace(context: ServiceContext): Promise<void> {
  const { config, services, resources } = context;
  const plugins = pluginPort(() => services.plugins);
  const marketplace = await MarketplaceService.open({
    root: join(await realpath(config.dataDir), "marketplace"),
    now: context.now,
    id: context.id,
    // Every call this makes goes to the market, so each names the daemon (ADR 0189).
    fetch: namedFetch((url, init) => fetch(url, init), config.aceClient),
    origin: config.marketUrl ?? marketOrigin,
    keys: shippedMarketKeys,
    git: gitRuntime(),
    suits: () => services.suits,
    plugins: () => (services.plugins ? plugins : undefined),
    spade: spadePort(() => services.spade?.ready()?.connection),
    pick: pickPorts({
      spade: () => services.spade?.ready()?.connection,
      skills: () => services.skillLibrary,
      plugins: () => services.plugins,
      aceData: config.dataDir,
      names: () => [userInfo().username],
    }),
    // Settings › Beta: off, the service refuses requests, queued work, fetches and install steps.
    enabled: () => marketplaceTurnedOn(services.settings),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  });
  resources.own(() => marketplace.close());
  services.marketplace = marketplace;
  services.marketAgent = new MarketAgent({
    marketplace,
    store: context.store,
    engine: () => services.engine,
    settings: () => services.settings,
    id: context.id,
  });
}

/**
 * Settings › Beta's marketplace switch (`beta.marketplace`), read wherever the service starts
 * work so a change applies at once. Off with no settings to read. What was installed from the marketplace is never gated
 * here: suits, skills and plugins run from their own services.
 */
export async function marketplaceTurnedOn(settings: SettingsService | undefined): Promise<boolean> {
  try {
    return (await settings?.get(betaKeys.marketplace))?.value === true;
  } catch {
    return false;
  }
}

/**
 * `marketplace.request` (reads need the device read scope; the rest admin, as plugin mutations
 * do), and once welcomed the `marketplace.changed` pushes.
 */
export function createMarketplaceSession(context: SocketContext): SocketService {
  const { options, tasks, authorize, send } = context;
  let stop: (() => void) | undefined;
  return {
    welcomed() {
      stop = options.marketplace?.subscribe((counts) => {
        if (!context.connected() || !authorize("read")) return;
        const message: MarketServerMessage = { type: "marketplace.changed", ...counts };
        send(message);
      });
    },
    close() {
      stop?.();
      stop = undefined;
    },
    handle(message) {
      if (message.type !== "marketplace.request") return false;
      const scope = marketReadOperations.includes(message.operation.op) ? "read" : "admin";
      const reply = (result: MarketResult) => {
        if (!context.connected()) return;
        const answer: MarketServerMessage = {
          type: "marketplace.result",
          requestId: message.requestId,
          result,
        };
        send(answer);
      };
      if (!authorize(scope)) {
        reply({ op: "error", code: "forbidden", message: `${scope} scope required` });
        return true;
      }
      // A publish mints its market grant through this machine's ace account, for this request
      // alone; it never reaches the socket, the disk or a log. An agent's shell names its thread
      // (ADR 0178 §12.5): its person-only actions become a request there instead.
      // Without a thread the caller says it is the person, which the host token alone can't
      // prove: person-only actions from it need a fresh ace sign-in (`fresh-sign-in.ts`).
      const { operation, thread } = message;
      const agent = options.marketAgent;
      const asPerson = async (market: MarketAgent) =>
        (await hostMarketRefusal({
          operation,
          unproven: context.personProven?.() !== true,
          fresh: () => market.freshSignIn(),
        })) ?? market.asPerson(operation);
      const run = agent
        ? () => (thread ? agent.forAgent(thread, operation) : asPerson(agent))
        : // A server started with the marketplace service alone (tests): as the person.
          options.marketplace && !thread
          ? async () =>
              (await hostMarketRefusal({
                operation,
                unproven: context.personProven?.() !== true,
                fresh: () => machineFresh(options),
              })) ?? serviceAlone(options, operation)
          : undefined;
      if (!run) {
        reply({ op: "error", code: "unavailable", message: "The marketplace isn't ready yet" });
        return true;
      }
      const task = run()
        .then(reply)
        .catch((error: unknown) => {
          options.log?.(error);
          reply({
            op: "error",
            code: "failed",
            message:
              error instanceof Error ? error.message.slice(0, 2000) : "Marketplace request failed",
          });
        });
      tasks.add(task);
      // The task answers its own failure above; this only forgets it.
      void task.finally(() => tasks.delete(task)).catch(() => {});
      return true;
    },
  };
}

/** The marketplace as the person reaches it, for a server given the service without its agent. */
function serviceAlone(
  options: SocketContext["options"],
  operation: MarketOperation,
): Promise<MarketResult> {
  const { marketplace, machineAccount: account, hostId } = options;
  const grant = account ? () => account.marketGrant(hostId) : undefined;
  return (
    marketplace?.request(operation, operation.op === "publish" ? { grant } : {}) ??
    Promise.resolve({
      op: "error",
      code: "unavailable",
      message: "The marketplace isn't ready yet",
    })
  );
}

/** Whether the machine's account signed in within ten minutes, for a server without its agent. */
async function machineFresh(options: SocketContext["options"]): Promise<boolean> {
  const { machineAccount: account, hostId } = options;
  return account ? account.freshSignIn(hostId) : false;
}
