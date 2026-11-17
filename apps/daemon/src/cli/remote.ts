import { readFile } from "node:fs/promises";
import { DeviceToken } from "@ace/protocol";
import { parsePairingLink } from "@ace/client/access";
import { redeemPairing, accessRequest } from "../client-access.ts";
import { Profiles, RemoteProfile, profileSummary } from "./profiles.ts";
import { option, type Args } from "./args.ts";
import { emit, prompt } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { remoteAddedLine, remoteListLines, remoteNames } from "./render/remote.ts";
/** `ace remote list|add|use|remove`: profiles for other machines (no daemon needed). */
export async function remoteCommand(
  args: Args,
  home: string,
  verb: "list" | "add" | "use" | "remove",
) {
  const profiles = new Profiles(home);
  try {
    if (verb === "list")
      return emit(
        args,
        { active: profiles.selected() ?? "local", profiles: profiles.list().map(profileSummary) },
        { human: remoteListLines, quiet: remoteNames },
      );
    const name = args.words[0] ?? option(args, "profile");
    if (!name)
      throw usageFailure(`ace remote ${verb} needs NAME.`, {
        code: "missing_argument",
        argument: "NAME",
        hint: "See the profiles with ace remote list.",
      });
    if (verb !== "add" && name !== "local" && !profiles.list().some((p) => p.name === name))
      throw new CliFailure("refused", `No remote profile ${name}.`, undefined, {
        code: "not_found",
        hint: "See the profiles with ace remote list.",
      });
    if (verb === "use") {
      profiles.use(name);
      return emit(
        args,
        { active: name },
        {
          human: () =>
            name === "local"
              ? "Commands go to this machine."
              : `Commands go to ${name} until ace remote use local.`,
          quiet: () => [],
        },
      );
    }
    if (verb === "remove") {
      profiles.remove(name);
      return emit(args, { removed: name }, { human: () => `Removed ${name}.`, quiet: () => [] });
    }
    const tokenFile = option(args, "token-file");
    if (!tokenFile || !args.words[1])
      throw usageFailure("Adding a remote by hand takes ORIGIN and --token-file PATH.", {
        code: "missing_argument",
        argument: tokenFile ? "ORIGIN" : "--token-file",
        hint: "Or add it from a pairing link: ace remote add NAME --link URL.",
      });
    const token = DeviceToken.parse(
      (tokenFile === "-"
        ? await prompt({ words: ["-"], flags: {} }, 0)
        : await readFile(tokenFile, "utf8")
      ).trim(),
    );
    const profile = RemoteProfile.omit({ id: true }).parse({
      name,
      origin: args.words[1],
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
    return emit(args, profileSummary(profiles.add(profile)), {
      human: remoteAddedLine,
      quiet: (added) => [added.name],
    });
  } finally {
    profiles.close();
  }
}
/** `ace remote add NAME --link URL` (`ace pair redeem`): redeem another machine's link. */
export async function redeemCommand(args: Args, home: string, link: string) {
  const url = link === "-" ? await prompt({ words: ["-"], flags: {} }, 0) : link;
  const parsed = parsePairingLink(url);
  const credential = await redeemPairing(url.trim(), option(args, "name") ?? "ace CLI");
  const profiles = new Profiles(home);
  try {
    const profile = profiles.add({
      name: args.words[0] ?? option(args, "profile") ?? "remote",
      origin: parsed.daemon,
      fingerprint: parsed.fingerprint,
      deviceId: credential.device.id,
      token: credential.token,
    });
    return emit(
      args,
      { profile: profileSummary(profile), device: credential.device },
      { human: (value) => remoteAddedLine(value.profile), quiet: (value) => [value.profile.name] },
    );
  } finally {
    profiles.close();
  }
}
