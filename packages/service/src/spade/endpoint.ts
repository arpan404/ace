import { z } from "zod";

/*
 * Where Spade listens, from the files it writes in its data folder once it serves requests
 * (ADR 0123): `server.json` `{"address":"127.0.0.1:PORT","pid":…,"version":…,"api":…}` and the
 * 0600 `token` file. Pure: callers read the files.
 */

/** Spade's HTTP API version this build speaks. */
export const spadeApi = 1;
/**
 * The API versions this build accepts: the current one and the previous one, once there is a
 * previous one, so Spade and ace can be updated in either order (ADR 0123 decision 5).
 */
export const acceptedSpadeApis: readonly number[] = [spadeApi];

/** A Spade that can be reached on this machine. */
export interface SpadeEndpoint {
  host: "127.0.0.1";
  port: number;
  version: string;
  api: number;
  pid: number;
}

/** Fields are kept leniently: unknown ones are ignored, never fatal. */
const ServerFile = z.looseObject({
  address: z.string().max(64),
  pid: z.number().int().positive(),
  version: z.string().max(64),
  api: z.number().int().positive(),
});

export type ServerFileReading =
  | { ok: true; endpoint: SpadeEndpoint }
  | { ok: false; reason: "unreadable" | "not_loopback" | "unsupported_api" };

/**
 * Spade's `server.json`, accepted only for a loopback address and an API this build speaks.
 * Anything else (a torn write, another host, a Spade too old or too new) is not reachable.
 */
export function readSpadeServerFile(text: string): ServerFileReading {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const parsed = ServerFile.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "unreadable" };
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(parsed.data.address);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535)
    return { ok: false, reason: "not_loopback" };
  if (!acceptedSpadeApis.includes(parsed.data.api)) return { ok: false, reason: "unsupported_api" };
  const { version, api, pid } = parsed.data;
  return { ok: true, endpoint: { host: "127.0.0.1", port, version, api, pid } };
}

/** Spade's token file: one line of visible ASCII, 16 to 4096 characters. */
export function readSpadeTokenFile(text: string): string | undefined {
  const token = text.trim();
  return /^[\x21-\x7e]{16,4096}$/.test(token) ? token : undefined;
}
