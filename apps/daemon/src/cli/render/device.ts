import type { Device } from "@ace/protocol";
import { formatAge, formatAgo } from "@ace/ui-core/time";
import { columns } from "./provider-columns.ts";

/** `ace device …` for a person. Pure: `now` comes from the caller. */
export function deviceListLines(devices: readonly Device[], now: number): string[] {
  const shown = devices.filter((device) => device.revokedAt === null);
  const revoked = devices.length - shown.length;
  if (!shown.length)
    return [
      "No devices paired. Pair one with ace device pair.",
      ...(revoked ? [`${revoked} revoked.`] : []),
    ];
  return [
    ...columns(
      shown.map((device) => [
        device.id,
        device.name,
        `seen ${formatAgo(device.lastSeenAt, now)}`,
        device.expiresAt ? expiry(device.expiresAt, now) : undefined,
      ]),
    ),
    ...(revoked ? ["", `${revoked} revoked. Their records stay; --json lists them.`] : []),
  ];
}

function expiry(at: number, now: number): string {
  return at <= now ? "access ended" : `access ends in ${formatAge(now, at)}`;
}

export function deviceIds(devices: readonly Device[]): string[] {
  return devices.filter((device) => device.revokedAt === null).map((device) => device.id);
}

/** The pairing link, its lifetime and the QR code to scan. */
export function pairingLines(
  paired: { url: string },
  lifetime: string,
  deviceLifetime: string | undefined,
  qr: string,
): string[] {
  return [
    paired.url,
    `Valid for ${lifetime}, single use.${deviceLifetime ? ` The device keeps access for ${deviceLifetime}.` : ""}`,
    qr,
  ];
}
