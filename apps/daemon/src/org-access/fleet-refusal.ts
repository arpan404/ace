import { MachineFailure, type MachineTransport } from "../machines/transport.ts";

/*
 * The issuer's end of ADR 0209 §4.2's refusal: an organization's host makes no fleet link and
 * calls no machine (parcels, describes, transfers' probes), so nothing leaves it by a machine
 * route, however the request was asked for. Its receiving end refuses every paired device and
 * every dedicated relay channel.
 */

const refused = () =>
  new MachineFailure(
    "refused",
    "machine_forbidden",
    "An organization's host doesn't link to or call other machines.",
    true,
  );

/** Runs `link` only on a person's machine. */
export async function refuseOnOrgHost<T>(
  org: string | undefined,
  link: () => Promise<T>,
): Promise<T> {
  if (org !== undefined) throw refused();
  return link();
}

/** A machine transport that refuses every call while this machine is an organization's host. */
export function orgHostRefuses(
  org: () => string | undefined,
  transport: MachineTransport,
): MachineTransport {
  return (profile, body, options) =>
    org() === undefined ? transport(profile, body, options) : Promise.reject(refused());
}
