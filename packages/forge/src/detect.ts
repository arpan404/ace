import type { ForgeRepository as Repository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import type { CommandRunner } from "./command.ts";
import { repositoryFromRemote } from "./remote.ts";
export { repositoryFromRemote } from "./remote.ts";

export async function detectRepository(
  runner: CommandRunner,
  signal: AbortSignal,
  options: {
    remote?: string;
    hosts?: Readonly<Record<string, Repository["forge"]>>;
    aliases?: Readonly<Record<string, string>>;
  } = {},
): Promise<Repository> {
  const result = await runner({ command: "git", args: ["remote", "-v"], signal, mode: "json" });
  if (result.code !== 0) throw new ForgeError("cli");
  const remotes = result.stdout.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    return match ? [{ name: match[1], url: match[2] }] : [];
  });
  const chosen = options.remote
    ? remotes.find((remote) => remote.name === options.remote)
    : (remotes.find((remote) => remote.name === "origin") ?? remotes[0]);
  if (!chosen) throw new ForgeError("not_found");
  return repositoryFromRemote(chosen.url, options.hosts, options.aliases);
}
