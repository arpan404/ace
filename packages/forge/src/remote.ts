import { z } from "zod";
import {
  ForgeRepository,
  originApiHost,
  publicForgeHosts,
  type ForgeRepository as Repository,
} from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

/** GitHub's documented SSH-over-HTTPS endpoint names the same host. */
const hostEquivalents: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/**
 * `aliases` maps SSH host aliases (`~/.ssh/config` `Host` entries) to the real host name,
 * as resolved by `sshHostAliases`. Unresolved hosts are matched literally.
 */
export function repositoryFromRemote(
  remote: unknown,
  hosts: Readonly<Record<string, Repository["forge"]>> = {},
  aliases: Readonly<Record<string, string>> = {},
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
  host = aliases[host]?.toLowerCase() ?? host;
  host = hostEquivalents[host] ?? host;
  // Self-hosted installations must be mapped explicitly, never guessed from a hostname.
  const forge = publicForgeHosts[host] ?? hosts[host];
  if (forge === "origin" && host !== originApiHost) throw new ForgeError("unsupported");
  if (forge === "origin") path = path.replace(/^git\//, "");
  if (!forge) throw new ForgeError("unsupported");
  const parts = path
    .replace(/\/?$/, "")
    .replace(/\.git$/, "")
    .split("/");
  const name = parts.pop();
  if (forge !== "gitlab" && parts.length !== 1) throw new ForgeError("unsupported");
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
