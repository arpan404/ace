import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { GrantStore } from "../external-mcp/grants.ts";
import { GrantTokens } from "../external-mcp/tokens.ts";
import { SpadeGrantDelivery } from "../spade/delivery.ts";
import { SpadeGrantAuthenticator } from "../spade/grant-auth.ts";
import { SpadeGrants } from "../spade/grant.ts";
import { nodeSpadeLinkRuntime, spadeAceCall } from "../spade/link-runtime.ts";
import { SpadeLink, type SpadeLinkRuntime } from "../spade/link.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { spadeDisabled } from "../spade/disabled.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { spadeHostThread } from "./spade-host.ts";
import { spadeSwitch } from "./spade-switch.ts";
import type { ServiceContext } from "./types.ts";

/** Test seams for Spade's service; production uses the defaults. */
export interface DaemonSpadeOptions {
  /** The environment `DISABLE_SPADE` is read from; the daemon's by default. */
  env?: NodeJS.ProcessEnv;
  /** Spade's registration with the service manager; `@ace/service` by default. */
  service?: SpadeServiceControl;
  runtime?: SpadeLinkRuntime;
  pollMs?: { waiting: number; ready: number };
}

/**
 * Spade as a service the daemon doesn't run (ADR 0123): `spade.*` reads its state and forwards
 * to it, `spade.enabled` registers or removes it, and its durable grant gives it the host
 * thread's lease on the daemon's MCP endpoint and is handed to it over its own API.
 */
export async function startSpade(context: ServiceContext): Promise<void> {
  const { config, log, services, store } = context;
  const options = context.options.spade ?? {};
  const disabled = spadeDisabled(options.env ?? process.env);
  const dataDir = join(config.dataDir, "spade");
  const service = options.service ?? aceSpadeService(config.dataDir, process.platform);
  const link = new SpadeLink({
    dataDir,
    runtime: options.runtime ?? nodeSpadeLinkRuntime({ service, now: context.now }),
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
  });
  services.spade = link;
  context.resources.own(() => link.close(), "spade");
  const host = spadeHostThread(context, link, dataDir);
  if (disabled) {
    // Left out of this build: no service, grant or forwarding, whatever the setting says.
    return;
  }

  const sql = {
    statement: (text: string) => store.statement(text),
    atomic: <T>(run: () => T) => store.atomic(() => run()),
  };
  const grantStore = new GrantStore(sql, context.now, context.id);
  const grants = new SpadeGrants(
    grantStore,
    new GrantTokens({ sql, grants: grantStore, now: context.now, random: randomBytes }),
  );
  const auth = new SpadeGrantAuthenticator({
    verify: (bearer) => grants.verify(bearer),
    hostThread: () => host.current(),
    capabilities: () => daemonMcpCapabilities(services),
    open: (scope, lifetime) => {
      const mcp = services.mcp;
      if (!mcp) throw new Error("ace's MCP endpoint isn't running");
      return mcp.openSession(scope, lifetime);
    },
  });
  const stopAuth = services.mcp?.addAuthenticator((bearer) => auth.authenticate(bearer));
  context.resources.own(() => {
    stopAuth?.();
    auth.close();
  }, "spade grant");
  if (!services.mcp) log.log("warn", "Spade's grant can't reach ace's tools: no MCP endpoint");

  const delivery = new SpadeGrantDelivery({
    grants,
    call: spadeAceCall,
    ready: () => link.ready()?.connection,
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    log: (level, message) => log.log(level, message),
  });
  context.resources.own(() => delivery.close(), "spade grant delivery");
  // Each Spade that appears gets the grant if it lacks it, so one made while Spade was down
  // reaches it when its server.json next appears.
  context.resources.own(
    link.onReady((ready) => void delivery.deliver(ready.connection)),
    "spade grant arrival",
  );
  // The person revoking Spade's grant in Settings: its lease ends and Spade forgets it.
  const outside = services.externalMcp?.outside;
  if (outside)
    context.resources.own(
      outside.onEnded((grantId) => {
        if (!grants.owns(grantId)) return;
        auth.end(grantId);
        void delivery.withdraw(link.ready()?.connection);
      }),
      "spade grant revoked",
    );

  const settings = services.settings;
  if (!settings) return;
  const toggle = spadeSwitch({
    service,
    link,
    grants,
    host,
    delivery,
    endLease: () => auth.end(),
    now: context.now,
    log: (level, message) => log.log(level, message),
  });
  const stop = await settings.subscribe({ keys: ["spade.enabled"], scope: {} }, (notification) => {
    if (notification.type !== "changed") return;
    const entry = notification.entries.find((each) => each.key === "spade.enabled");
    if (entry) void toggle.set(entry.value === true, "changed");
  });
  context.resources.own(stop, "spade setting");
  // Not awaited: registering a service can be slow, and the daemon's start doesn't wait on Spade.
  void toggle.set((await settings.get("spade.enabled")).value === true, "started");
}
