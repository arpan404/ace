import { z } from "zod";
import { DaemonHealth, Device, PairingResponse } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { readLocalToken } from "../local-token.ts";
import { hostConnection, reachLocalDaemon } from "./connection.ts";
import { deviceIds, deviceListLines, pairingLines } from "./render/device.ts";
import { terminalQr } from "./qr.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { emit, result } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
const Devices = z.array(Device.loose());
const Revoked = z.looseObject({ revoked: z.boolean() });
const durations: Record<string, { ms: number; words: string }> = {
  "5m": { ms: 5 * 60_000, words: "5 minutes" },
  "1h": { ms: 60 * 60_000, words: "1 hour" },
  "24h": { ms: 24 * 60 * 60_000, words: "1 day" },
  "1d": { ms: 24 * 60 * 60_000, words: "1 day" },
  "7d": { ms: 7 * 24 * 60 * 60_000, words: "7 days" },
  "30d": { ms: 30 * 24 * 60 * 60_000, words: "30 days" },
};
/** `--ttl 1h` and the like; the daemon refuses lifetimes it doesn't offer. */
function duration(args: Args, name: string) {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const known = durations[value];
  if (!known)
    throw usageFailure(`--${name} takes 5m, 1h, 24h, 1d, 7d or 30d.`, { argument: `--${name}` });
  return known;
}
export async function accessCommand(args: Args, home: string) {
  const command = args.words[0];
  if (command === "token") {
    validateArgs(args, [], 1);
    const token = readLocalToken(home);
    return result(args, args.flags.json || args.flags.jq ? { token } : token);
  }
  if (command === "status") {
    validateArgs(args, [], 1);
    try {
      const { origin, token } = hostConnection(home);
      // Keep the remote, remote-access and service facts the health schema does not name.
      return result(
        args,
        DaemonHealth.loose().parse(await accessRequest(origin, "/v1/status", { token })),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
      )
        return result(args, { running: false });
      throw error;
    }
  }
  throw new CliFailure("refused", `Unknown access command ${command ?? ""}.`);
}

/** `ace device list|pair|revoke`: who is paired with this machine (ADR 0176 §7). */
export async function deviceCommand(
  args: Args,
  home: string,
  verb: "list" | "pair" | "revoke",
  now: () => number = Date.now,
) {
  const { origin, token } = await reachLocalDaemon(home);
  if (verb === "list") {
    const devices = Devices.parse(await accessRequest(origin, "/v1/devices", { token }));
    return emit(args, devices, {
      human: (list) => deviceListLines(list, now()),
      quiet: deviceIds,
    });
  }
  if (verb === "revoke") {
    const id = args.words[0] ?? "";
    try {
      const revoked = Revoked.parse(
        await accessRequest(origin, `/v1/devices/${encodeURIComponent(id)}`, {
          method: "DELETE",
          token,
        }),
      );
      return emit(args, revoked, { human: () => `Revoked ${id}.`, quiet: () => [] });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP 404"))
        throw new CliFailure("refused", `No paired device ${id}.`, undefined, {
          code: "not_found",
          hint: "See them with ace device list.",
        });
      throw error;
    }
  }
  const label = option(args, "label");
  const ttl = duration(args, "ttl");
  const deviceTtl = duration(args, "device-ttl");
  const paired = PairingResponse.parse(
    await accessRequest(origin, "/v1/pairings", {
      method: "POST",
      token,
      body: {
        ...(args.words[0] ? { scopes: args.words[0].split(",") } : {}),
        ...(label ? { label } : {}),
        ...(ttl ? { ttlMs: ttl.ms } : {}),
        ...(deviceTtl ? { deviceTtlMs: deviceTtl.ms } : {}),
      },
    }),
  );
  return emit(args, paired, {
    human: (value) =>
      pairingLines(value, ttl?.words ?? "5 minutes", deviceTtl?.words, terminalQr(value.url)),
    quiet: (value) => [value.url],
  });
}
