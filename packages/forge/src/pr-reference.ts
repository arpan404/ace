import { ForgePrRef, ForgeRepository } from "@ace/protocol/forge";
import { repositoryFromRemote } from "./remote.ts";
import { ForgeError } from "./errors.ts";

/** Only an HTTPS PR address, never a credential-bearing or arbitrary remote URL. */
export function prFromUrl(
  value: string,
  hosts: readonly string[] = ["github.com", "gitlab.com", "origin.cursor.com"],
): ForgePrRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError("invalid_data");
  }
  if (
    url.hostname === "cursor.com" &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port
  ) {
    const origin = /^\/codebase\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (origin)
      return ForgePrRef.parse({
        repository: {
          forge: "origin",
          host: "origin.cursor.com",
          owner: origin[1],
          name: origin[2],
        },
        number: Number(origin[3]),
      });
  }
  if (
    url.protocol === "https:" &&
    hosts.includes(url.hostname.toLowerCase()) &&
    !url.username &&
    !url.password &&
    !url.port
  ) {
    const gitlab = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (gitlab) {
      const parts = (gitlab[1] ?? "").split("/");
      const name = parts.pop();
      return ForgePrRef.parse({
        repository: {
          forge: "gitlab",
          host: url.hostname.toLowerCase(),
          owner: parts.join("/"),
          name,
        },
        number: Number(gitlab[2]),
      });
    }
  }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|checks|commits))?\/?$/.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    !hosts.includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    !match
  )
    throw new ForgeError("invalid_data");
  return ForgePrRef.parse({
    repository: {
      forge: "github",
      host: url.hostname.toLowerCase(),
      owner: match[1],
      name: match[2],
    },
    number: Number(match[3]),
  });
}

export function prRepository(value: string, fallback: ForgeRepository): ForgeRepository {
  const parts = value.split("/");
  if (parts.length !== 2 && parts.length !== 3) throw new ForgeError("invalid_data");
  const host = parts.length === 3 ? (parts[0] ?? "") : fallback.host;
  const owner = parts.at(-2) ?? "";
  const name = parts.at(-1) ?? "";
  if (host === fallback.host) return ForgeRepository.parse({ ...fallback, owner, name });
  return repositoryFromRemote(`https://${host}/${owner}/${name}.git`, { [host]: "github" });
}

export function prUrl(pr: ForgePrRef): string {
  const repo = pr.repository;
  if (repo.forge === "origin")
    return `https://cursor.com/codebase/${repo.owner}/${repo.name}/pull/${pr.number}`;
  if (repo.forge !== "github" && repo.forge !== "gitlab") throw new ForgeError("unsupported");
  return `https://${repo.host}/${repo.owner}/${repo.name}/${repo.forge === "github" ? "pull" : "-/merge_requests"}/${pr.number}`;
}

/** Browser-safe issue identity uses the same repository restrictions as PR addresses. */
export function issueFromUrl(value: string): import("@ace/protocol/forge-issues").ForgeIssueRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError("invalid_data");
  }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (
    !match ||
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new ForgeError("invalid_data");
  return prFromUrl(`https://${url.host}/${match[1]}/${match[2]}/pull/${match[3]}`);
}
