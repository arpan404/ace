import { DaemonHealth, PairingResponse } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { readLocalToken } from "../local-token.ts";
import { hostConnection } from "./connection.ts";
import { terminalQr } from "./qr.ts";
import { validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";
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
      return result(args, DaemonHealth.parse(await accessRequest(origin, "/v1/status", { token })));
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
  const { origin, token } = hostConnection(home);
  if (command === "pair") {
    validateArgs(args, [], 1, 2);
    const paired = PairingResponse.parse(
      await accessRequest(origin, "/v1/pairings", {
        method: "POST",
        token,
        body: args.words[1] ? { scopes: args.words[1].split(",") } : {},
      }),
    );
    return result(
      args,
      args.flags.json || args.flags.jq
        ? paired
        : `${paired.url}\nValid for 5 minutes, single use.\n${terminalQr(paired.url)}`,
    );
  }
  const verb = args.words[1];
  validateArgs(args, [], verb === "revoke" ? 3 : 2);
  if (verb === "list") return result(args, await accessRequest(origin, "/v1/devices", { token }));
  if (verb === "revoke" && args.words[2])
    return result(
      args,
      await accessRequest(origin, `/v1/devices/${encodeURIComponent(args.words[2])}`, {
        method: "DELETE",
        token,
      }),
    );
  throw new CliFailure("refused", "Usage: ace devices list|revoke ID");
}
