import { readFile } from "node:fs/promises";
import { DeviceToken } from "@ace/protocol";
import { redeemPairing, accessRequest } from "../client-access.ts";
import { Profiles, RemoteProfile, profileSummary } from "./profiles.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { prompt, result } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function remoteCommand(args: Args, home: string) {
  const profiles = new Profiles(home);
  try {
    const verb = args.words[1];
    validateArgs(
      args,
      ["fingerprint", "device", "token-file"],
      verb === "list" ? 2 : verb === "add" ? 4 : 3,
    );
    if (verb === "list")
      return result(args, {
        active: profiles.selected() ?? "local",
        profiles: profiles.list().map(profileSummary),
      });
    const name = args.words[2];
    if (!name) throw new CliFailure("refused", "Remote profile name required");
    if (verb === "use") {
      profiles.use(name);
      return result(args, { active: name });
    }
    if (verb === "remove") {
      profiles.remove(name);
      return result(args, { removed: name });
    }
    if (verb !== "add") throw new CliFailure("refused", "Usage: ace remote add|list|use|remove");
    const tokenFile = option(args, "token-file");
    if (!tokenFile)
      throw new CliFailure(
        "refused",
        "Use --token-file PATH or --token-file - for an ace device token",
      );
    const token = DeviceToken.parse(
      (tokenFile === "-"
        ? await prompt({ words: [], flags: {} }, 0)
        : await readFile(tokenFile, "utf8")
      ).trim(),
    );
    const profile = RemoteProfile.omit({ id: true }).parse({
      name,
      origin: args.words[3],
      fingerprint: option(args, "fingerprint"),
      deviceId: option(args, "device"),
      token,
    });
    // Confirm the supplied pin before admitting a credential-bearing profile.
    await accessRequest(profile.origin, "/v1/tickets", {
      method: "POST",
      fingerprint: profile.fingerprint,
      token,
    });
    return result(args, profileSummary(profiles.add(profile)));
  } finally {
    profiles.close();
  }
}
export async function redeemCommand(args: Args, home: string) {
  validateArgs(args, ["name", "profile"], 2, 3);
  const url = await prompt(args, 2);
  const parsed = new URL(url.trim());
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const name = option(args, "name") ?? "ace CLI";
  const credential = await redeemPairing(url.trim(), name);
  const profiles = new Profiles(home);
  try {
    const profile = profiles.add({
      name: option(args, "profile") ?? "remote",
      origin: `${parsed.origin}/`,
      fingerprint: fragment.get("fingerprint") ?? "",
      deviceId: credential.device.id,
      token: credential.token,
    });
    return result(args, { profile: profileSummary(profile), device: credential.device });
  } finally {
    profiles.close();
  }
}
