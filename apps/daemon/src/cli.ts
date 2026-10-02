#!/usr/bin/env node
import { z } from "zod";
import { serviceCommand } from "@ace/service";
import { PairingResponse } from "@ace/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import createQr from "qrcode-generator";
import { readModelInstances } from "./models.ts";
import { readConfig } from "./config.ts";
import { createDevThread, stubHandler } from "./commands.ts";
import { accessRequest } from "./client-access.ts";
import { doctor } from "./doctor.ts";

const HostConnection = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
function hostConnection(dataDir: string): { origin: string; token: string } {
  return HostConnection.parse({
    origin: readFileSync(join(dataDir, "daemon-endpoint"), "utf8"),
    token: readFileSync(join(dataDir, "daemon-token"), "utf8"),
  });
}

function terminalQr(value: string): string {
  const qr = createQr(0, "M");
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col);
  const lines: string[] = [];
  for (let row = -4; row < size + 4; row += 2) {
    let line = "";
    for (let col = -4; col < size + 4; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // Explicit black on white preserves the quiet zone in dark terminals.
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`\u001b[30;47m${line}\u001b[0m`);
  }
  return lines.join("\n") + "\n";
}
async function main(args: string[]): Promise<void> {
  const config = readConfig();
  const command = args[0] ?? "start";
  if (command === "start") {
    if (args.length > 1) throw new Error("Usage: ace start");
    const { startDaemon } = await import("./index.ts");
    const development = process.env.ACE_DEV === "1";
    const daemon = await startDaemon(
      config,
      stubHandler({ development }),
      [],
      undefined,
      readModelInstances(),
    );
    try {
      if (development && daemon.store.listThreads().length === 0)
        createDevThread(daemon.store, daemon.store.createWorkspace(process.cwd(), "Development"));
    } catch (error) {
      await daemon.close();
      throw error;
    }
    process.stdout.write(`ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}\n`);
    if (daemon.remoteUrl)
      process.stdout.write(
        `Remote: ${daemon.remoteUrl}\nPublic-key SHA-256: ${daemon.fingerprint}\n`,
      );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void daemon.close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "service") {
    process.stdout.write(
      JSON.stringify(await serviceCommand(config.dataDir, args.slice(1))) + "\n",
    );
    return;
  }
  if (command === "doctor") {
    process.stdout.write(JSON.stringify(await doctor(), null, 2) + "\n");
    return;
  }
  if (command === "status") {
    if (args.length !== 1) throw new Error("Usage: ace status");
    let status: unknown;
    try {
      const { origin, token } = hostConnection(config.dataDir);
      status = await accessRequest(origin, "/v1/status", { token });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      )
        status = { running: false };
      else throw error;
    }
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return;
  }
  if (command !== "pair" && command !== "devices")
    throw new Error(
      "Usage: ace start|status|service install|uninstall|start|stop|status|pair [scopes]|devices list|devices revoke <id>|doctor",
    );
  const { origin, token } = hostConnection(config.dataDir);
  if (command === "pair") {
    if (args.length > 2) throw new Error("Usage: ace pair [read,operate,admin]");
    const result = PairingResponse.parse(
      await accessRequest(origin, "/v1/pairings", {
        method: "POST",
        token,
        body: args[1] ? { scopes: args[1].split(",") } : {},
      }),
    );
    process.stdout.write(
      `${result.url}\nValid for 5 minutes, single use.\n${terminalQr(result.url)}`,
    );
    return;
  }
  if (command === "devices" && args[1] === "list" && args.length === 2) {
    process.stdout.write(
      JSON.stringify(await accessRequest(origin, "/v1/devices", { token }), null, 2) + "\n",
    );
    return;
  }
  if (command === "devices" && args[1] === "revoke" && args[2] && args.length === 3) {
    process.stdout.write(
      JSON.stringify(
        await accessRequest(origin, `/v1/devices/${encodeURIComponent(args[2])}`, {
          method: "DELETE",
          token,
        }),
      ) + "\n",
    );
    return;
  }
  throw new Error(
    "Usage: ace start|status|service install|uninstall|start|stop|status|pair [scopes]|devices list|devices revoke <id>|doctor",
  );
}
await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
