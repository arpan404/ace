import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { marketOrigin, shippedMarketKeys } from "@ace/marketplace";
import { gitRuntime } from "@ace/plugins";
import {
  marketReadOperations,
  type MarketResult,
  type MarketServerMessage,
} from "@ace/protocol/marketplace";
import type { SettingsService } from "@ace/settings";
import { betaKeys } from "@ace/settings/beta";
import { pickPorts } from "../marketplace/pick-ports.ts";
import { pluginPort } from "../marketplace/plugin-port.ts";
import { MarketplaceService } from "../marketplace/service.ts";
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
    fetch: (url, init) => fetch(url, init),
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
      const marketplace = options.marketplace;
      if (!marketplace) {
        reply({ op: "error", code: "unavailable", message: "The marketplace isn't ready yet" });
        return true;
      }
      // A publish mints its market grant through this machine's ace account, for this request
      // alone; it never reaches the socket, the disk or a log.
      const account = options.machineAccount;
      const grant = account ? () => account.marketGrant(options.hostId) : undefined;
      const task = marketplace
        .request(message.operation, message.operation.op === "publish" ? { grant } : {})
        .then(reply);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
