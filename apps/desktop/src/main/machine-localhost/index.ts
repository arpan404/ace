import { app, type WebContents } from "electron";
import { emit } from "../ipc.ts";
import { DeviceTabs } from "./device-tabs.ts";
import { loopbackTunnel } from "./loopback-tunnel.ts";
import { MachineSessions } from "./machine-sessions.ts";
import type { MachineTunnel } from "./tunnel-contract.ts";

/**
 * Device tabs and the machines' localhost proxies, as the app runs them (ADR 0194). The tunnel
 * of each machine is opened here in the main process, beside its proxy, so a page's bytes go
 * from the proxy's socket into the tunnel's connection without crossing to a renderer.
 *
 * `ACE_DEV_LOOPBACK_TUNNEL=1` sends every machine's localhost to this computer's own, to try
 * device tabs against a local dev server without a second machine.
 */
export function machineLocalhost(options: {
  log(message: string): void;
  tunnel?(machineId: string): MachineTunnel | undefined;
}) {
  const dev = process.env["ACE_DEV_LOOPBACK_TUNNEL"] === "1" && !app.isPackaged;
  const local = dev ? loopbackTunnel() : undefined;
  const sessions = new MachineSessions({
    tunnel: (machineId) => local ?? options.tunnel?.(machineId),
    now: Date.now,
    log: options.log,
  });
  const tabs = new DeviceTabs({
    sessions,
    state: (host: WebContents, state) => emit(host, "deviceTab.state", state),
    openTab: (host: WebContents, request) => emit(host, "deviceTab.openTab", request),
    log: options.log,
  });
  app.once("will-quit", () => {
    tabs.closeAll();
    local?.close();
    void sessions.close();
  });
  return { tabs, sessions };
}
