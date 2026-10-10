import { ForgePrRef, ForgeRepository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

/** Only an HTTPS PR address, never a credential-bearing or arbitrary remote URL. */
export function prFromUrl(value: string): ForgePrRef {
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
    url.hostname !== "github.com" ||
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
