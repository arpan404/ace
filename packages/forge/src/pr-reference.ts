import { ForgePrRef, ForgeRepository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

/** Only an HTTPS PR address, never a credential-bearing or arbitrary remote URL. */
export function prFromUrl(value: string, hosts: readonly string[] = ["github.com"]): ForgePrRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError("invalid_data");
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
  return ForgeRepository.parse({
    forge: "github",
    host: parts.length === 3 ? parts[0] : fallback.host,
    owner: parts.at(-2),
    name: parts.at(-1),
  });
}

export function prUrl(pr: ForgePrRef): string {
  const repo = pr.repository;
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
