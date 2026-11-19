import {
  parseSpadeServiceLines,
  parseSpadeServices,
  type SpadeService,
  type SpadeServiceLines,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "../spade-requests.ts";

/* A bot's services (ADR 0160): the list, a service's output, and Stop. */

const base = (bot: string) => `/v1/agents/${segment(bot)}/services`;

export async function readServices(
  target: SpadeTarget,
  bot: string,
  signal?: AbortSignal,
): Promise<SpadeService[]> {
  const services = parseSpadeServices(await spadeHttp(target, "GET", base(bot), { signal }));
  if (!services) throw new Error("Spade's services didn't make sense.");
  return services;
}

/** Up to `lines` lines printed after line `after` (0: the last ones kept). */
export async function readServiceLines(
  target: SpadeTarget,
  bot: string,
  service: string,
  window: { after: number; lines: number },
  signal?: AbortSignal,
): Promise<SpadeServiceLines> {
  const path = `${base(bot)}/${segment(service)}/logs?after=${window.after}&lines=${window.lines}`;
  const lines = parseSpadeServiceLines(await spadeHttp(target, "GET", path, { signal }));
  if (!lines) throw new Error("Spade's service output didn't make sense.");
  return lines;
}

export async function stopService(target: SpadeTarget, bot: string, service: string) {
  await spadeHttp(target, "DELETE", `${base(bot)}/${segment(service)}`);
}
