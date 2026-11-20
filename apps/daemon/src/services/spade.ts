import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { logError } from "@ace/diagnostics";
import { newSpadeNonce, proveSpade } from "@ace/service/spade";
import { GrantStore } from "../external-mcp/grants.ts";
import { GrantTokens } from "../external-mcp/tokens.ts";
import { SpadeGrantDelivery } from "../spade/delivery.ts";
import { SpadeGrantAuthenticator } from "../spade/grant-auth.ts";
import { SpadeGrants } from "../spade/grant.ts";
import { brainHttp } from "../spade/brain-http.ts";
import { SpadeBrains } from "../spade/brain-sessions.ts";
import { nodeSpadeLinkRuntime, spadeAceCall } from "../spade/link-runtime.ts";
import { spadeLive } from "../spade/forward.ts";
import { followSpadeNotices } from "../spade/notices.ts";
import { SpadeLink, type SpadeLinkRuntime } from "../spade/link.ts";
import { cliVersion } from "../doctor/install.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { betaKeys, foldLegacySpadeFlag } from "@ace/settings/beta";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { loadSpadePersonKey } from "../local-files.ts";
import { spadeHostThread } from "./spade-host.ts";
import { startSpadeComputers } from "./spade-computers.ts";
import { spadeSwitch } from "./spade-switch.ts";
import type { ServiceContext } from "./types.ts";

/** Test seams for Spade's service; production uses the defaults. */
export interface DaemonSpadeOptions {
  /** The environment Spade's service is planned with; the daemon's by default. */
  env?: NodeJS.ProcessEnv;
  /** Spade's registration with the service manager; `@ace/service` by default. */
  service?: SpadeServiceControl;
  runtime?: SpadeLinkRuntime;
  pollMs?: { waiting: number; ready: number };
  /** How long a bot's finished turn waits for its session's other work (ADR 0133). */
  brainSettleMs?: number;
}

/**
 * Spade as a service the daemon doesn't run (ADR 0123): `spade.*` reads its state and forwards
 * to it, `spade.enabled` registers or removes it, and its durable grant gives it the host
 * thread's lease on the daemon's MCP endpoint and is handed to it over its own API.
 */
export async function startSpade(context: ServiceContext): Promise<void> {
  const { config, log, services, store } = context;
  const options = context.options.spade ?? {};
  const env = options.env ?? process.env;
  const dataDir = join(config.dataDir, "spade");
  const service =
    options.service ??
    aceSpadeService({
      home: config.dataDir,
      env,
      version: () => cliVersion(env, process.argv[1]),
      entry: process.argv[1],
    });
  const link = new SpadeLink({
    dataDir,
    runtime: options.runtime ?? nodeSpadeLinkRuntime({ service, now: context.now }),
    ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    report: (error) => log.log("error", "Spade's status check failed", logError(error)),
    personKey: loadSpadePersonKey(config.dataDir),
  });
  services.spade = link;
  context.resources.own(() => link.close(), "spade");
  const host = spadeHostThread(context, link, dataDir);
  // Spade's notices that reach the person now become ace's alerts (ADR 0195).
  const notices = followSpadeNotices({
    ready: () => link.ready(),
    onReady: (listener) => link.onReady(listener),
    hostThread: () => host.current()?.threadId,
    notify: async (notification) => {
      await services.notifications?.notify(notification);
    },
    live: spadeLive,
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    report: (error) => log.log("warn", "A Spade notice didn't reach ace's alerts", logError(error)),
  });
  context.resources.own(() => notices.close(), "spade notices");
  services.spadeComputers = startSpadeComputers(
    context,
    () => host.current(),
    join(dataDir, "workspace"),
  );
  // Settings › Beta's Spade switch (`beta.spade`, ADR 0139): while it is off Spade gets no
  // service, grant or forwarding, whatever `spade.enabled` says. Followed below, once the
  // switch exists.
  let shown = (await services.settings?.get(betaKeys.spade))?.value === true;
  link.setHidden(!shown);

  const sql = {
    statement: (text: string) => store.statement(text),
    atomic: <T>(run: () => T) => store.atomic(() => run()),
  };
  const grantStore = new GrantStore(sql, context.now, context.id);
  const grants = new SpadeGrants(
    grantStore,
    new GrantTokens({ sql, grants: grantStore, now: context.now, random: randomBytes }),
    context.now,
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
  const brains = new SpadeBrains({
    store,
    engine: () => services.engine,
    project: () => host.current(),
    roster: () => {
      const thread = host.current();
      const delegations = services.agentControl?.delegations;
      if (!thread || !delegations) return undefined;
      return delegations.models(
        { sessionId: "spade:brains", threadId: thread.threadId, agentId: thread.agentId },
        {},
      );
    },
    id: context.id,
    ...(options.brainSettleMs === undefined ? {} : { settleMs: options.brainSettleMs }),
    clock: {
      now: () => Date.now(),
      after(ms, run) {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  });
  services.spadeBrainSeq = (threadId) => brains.streamSeq(threadId);
  services.spadeGrantVerify = (bearer) => grants.verify(bearer) !== undefined;
  services.spadeBrains = brainHttp({ brains, verify: services.spadeGrantVerify });
  if (!services.mcp) log.log("warn", "Spade's grant can't reach ace's tools: no MCP endpoint");

  const delivery = new SpadeGrantDelivery({
    now: context.now,
    grants,
    call: spadeAceCall,
    prove: async (connection) =>
      (await proveSpade(connection, newSpadeNonce(), AbortSignal.timeout(2000))) !== undefined,
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
  // Shown with Spade's status, and revoked from there (Settings > Spade), never among outside
  // clients' grants.
  const showGrant = () => link.setGrant(grants.summary());
  context.resources.own(grants.onChange(showGrant), "spade grant status");
  showGrant();
  link.setRevoker(async () => {
    const connection = link.ready()?.connection;
    const revoked = grants.revoke();
    if (!revoked) return false;
    auth.end(revoked);
    log.log("info", "Spade's grant for ace was revoked");
    await delivery.withdraw(connection);
    return true;
  });

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
  // Both settings as last heard, kept here so every decision uses the newest of each: an answer
  // read before a change is never applied after it.
  let enabled = false;
  let heardBeta = false;
  let heardEnabled = false;
  const apply = (why: "started" | "changed") => void toggle.set(shown && enabled, why);
  // Turning Spade off in Beta stops its service and retires its grant, as `spade.enabled` off
  // does, but leaves that setting and Spade's data as they are: turning it on again puts back
  // what the setting says, and a grant the person revoked stays revoked (`started` reconciles
  // that way).
  const showSpade = (visible: boolean) => {
    if (visible === shown) return;
    shown = visible;
    link.setHidden(!visible);
    log.log(
      "info",
      visible
        ? "Spade is turned on in Settings › Beta"
        : "Spade is turned off in Settings › Beta: its service stops; its data is kept",
    );
    apply(visible ? "started" : "changed");
  };
  const stop = await settings.subscribe(
    { keys: [betaKeys.spade, "spade.enabled"], scope: {} },
    (notification) => {
      if (notification.type !== "changed") return;
      const entry = notification.entries.find((each) => each.key === "spade.enabled");
      if (entry) {
        heardEnabled = true;
        enabled = entry.value === true;
      }
      const beta = notification.entries.find((each) => each.key === betaKeys.spade);
      if (beta) heardBeta = true;
      if (beta && (beta.value === true) !== shown) showSpade(beta.value === true);
      else if (entry) apply("changed");
    },
  );
  context.resources.own(stop, "spade setting");
  // Read again once subscribed, so a change between the first read and the subscription isn't
  // lost; a value the subscription already reported is newer and wins.
  const [betaNow, enabledNow] = await Promise.all([
    settings.get(betaKeys.spade),
    settings.get("spade.enabled"),
  ]);
  if (!heardEnabled) enabled = enabledNow.value === true;
  if (!heardBeta && (betaNow.value === true) !== shown) {
    shown = betaNow.value === true;
    link.setHidden(!shown);
  }
  // Not awaited: registering a service can be slow, and the daemon's start doesn't wait on Spade.
  apply("started");
  // A home from before Settings › Beta may still show Spade through `features.json`: folded into
  // `beta.spade` once, off the start path (ADR 0170), and followed through the subscription.
  void foldLegacySpadeFlag(settings, config.dataDir).then(
    (turnedOn) => {
      if (turnedOn) log.log("info", "Spade's features.json flag moved to Settings › Beta");
    },
    (error: unknown) =>
      log.log("warn", `Moving Spade's features.json flag failed: ${String(error)}`),
  );
}
