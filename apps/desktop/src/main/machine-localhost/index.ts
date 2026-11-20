import { randomBytes } from "node:crypto";
import { app, type WebContents } from "electron";
import { nodeTunnelDialer } from "@ace/client/machine-tunnel/node";
import { emit } from "../ipc.ts";
import { DeviceTabs } from "./device-tabs.ts";
import { loopbackTunnel } from "./loopback-tunnel.ts";
import { MachineSessions } from "./machine-sessions.ts";
import { MachineTunnels } from "./tunnels.ts";

const schedule = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Device tabs and the machines' localhost proxies, as the app runs them (ADR 0194). The tunnel
 * of each machine is opened here in the main process, beside its proxy, so a page's bytes go
 * from the proxy's socket into the tunnel's connection without crossing to a renderer. A
 * machine's proxy lasts while it has a device tab or a window leases its tunnel; its tunnel and
 * credential, while a window leases it.
 *
 * `ACE_DEV_LOOPBACK_TUNNEL=1` sends every machine's localhost to this computer's own, to try
 * device tabs against a local dev server without a second machine.
 */
export function machineLocalhost(options: { log(message: string): void }) {
  const dev = process.env["ACE_DEV_LOOPBACK_TUNNEL"] === "1" && !app.isPackaged;
  const local = dev ? loopbackTunnel() : undefined;
  const unused = (machineId: string) => {
    if (!tabs.holds(machineId) && !tunnels.holds(machineId)) void sessions.release(machineId);
  };
  const tunnels: MachineTunnels = new MachineTunnels({
    dialer: nodeTunnelDialer(),
    schedule,
    idle: unused,
  });
  const sessions = new MachineSessions({
    tunnel: (machineId) => local ?? tunnels.tunnel(machineId),
    secret: () => randomBytes(32).toString("base64url"),
    now: Date.now,
    log: options.log,
  });
  const tabs: DeviceTabs = new DeviceTabs({
    sessions,
    state: (host: WebContents, state) => emit(host, "deviceTab.state", state),
    openTab: (host: WebContents, request) => emit(host, "deviceTab.openTab", request),
    focusAddress: (host: WebContents, request) => emit(host, "deviceTab.focusAddress", request),
    left: (host, machineId) => tunnels.release(host, machineId),
    idle: unused,
    platform: process.platform,
    log: options.log,
  });
  // Only a machine proxy's own challenge, from its own partition, gets that proxy's secret.
  app.on("login", (event, contents, _details, ask, callback) => {
    const answer = sessions.proxyLogin(ask, contents ?? undefined);
    if (!answer) return;
    event.preventDefault();
    callback(answer.username, answer.password);
  });
  app.once("will-quit", () => {
    tabs.closeAll();
    local?.close();
    tunnels.close();
    void sessions.close();
  });
  return {
    tabs,
    sessions,
    tunnels,
    /**
     * A window's page reloaded (its device tabs stay, to be taken back) or went away (they close
     * with it): either way the leases it held end, until it tells its paths again.
     */
    forgetHost(contentsId: number, gone: boolean) {
      tunnels.forgetSender(contentsId);
      if (gone) tabs.forgetHost(contentsId);
    },
  };
}
