import { z } from "zod";
import { ForgeRepository, type ForgeRepository as Repository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import type { CommandRunner } from "./command.ts";

export function repositoryFromRemote(
  remote: unknown,
  hosts: Readonly<Record<string, "github" | "gitlab">> = {},
): Repository {
  const value = z.string().max(4_096).parse(remote);
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):([^/].*)$/.exec(value);
  if (scp && !value.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ForgeError("unsupported");
    }
    if (!["https:", "ssh:", "git:"].includes(url.protocol)) throw new ForgeError("unsupported");
    host = url.hostname;
    path = url.pathname.replace(/^\//, "");
  }
  host = host.toLowerCase();
  const forge = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : hosts[host];
  if (!forge) throw new ForgeError("unsupported");
  const parts = path
    .replace(/\/?$/, "")
    .replace(/\.git$/, "")
    .split("/");
  const name = parts.pop();
  if (forge === "github" && parts.length !== 1) throw new ForgeError("unsupported");
  const parsed = ForgeRepository.safeParse({ forge, host, owner: parts.join("/"), name });
  if (
    !parsed.success ||
    parts.some((part) => part === "." || part === "..") ||
    name === "." ||
    name === ".."
  )
    throw new ForgeError("unsupported");
  return parsed.data;
}
export async function detectRepository(
  runner: CommandRunner,
  signal: AbortSignal,
  options: { remote?: string; hosts?: Readonly<Record<string, "github" | "gitlab">> } = {},
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
  return repositoryFromRemote(chosen.url, options.hosts);
}
