import {
  parseSpadeCaseReview,
  parseSpadeCases,
  parseSpadeKeptCase,
  type SpadeCaseMark,
  type SpadeCaseReviewLine,
  type SpadeCaseSummary,
} from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's cases (ADR 0204 §1, spade/docs/quality.md): finished runs the person kept as tests.
 * The review reads what keeping would write, already redacted; keeping writes it; the profile
 * lists them and deletes one.
 */

const path = (bot: string) => `/v1/agents/${segment(bot)}/cases`;

/** The cache key of a bot's cases on a machine. */
export const casesKey = (machine: string, bot: string) => ["spade", "cases", machine, bot];

export interface KeepCase {
  reply: string;
  mark?: SpadeCaseMark | undefined;
  why?: string | undefined;
  /** Values the person marked to hide on the review. */
  hide?: readonly string[];
}

const body = (keep: KeepCase) => ({
  reply: keep.reply,
  ...(keep.mark ? { mark: keep.mark } : {}),
  ...(keep.why?.trim() ? { why: keep.why.trim() } : {}),
  ...(keep.hide?.length ? { hide: [...keep.hide] } : {}),
});

/** What keeping would write, line by line, as Spade will keep it. */
export async function reviewCase(
  target: SpadeTarget,
  bot: string,
  keep: KeepCase,
  signal?: AbortSignal,
): Promise<readonly SpadeCaseReviewLine[]> {
  const answer = await spadeHttp(target, "POST", `${path(bot)}/preview`, {
    body: body(keep),
    signal,
  });
  const lines = parseSpadeCaseReview(answer);
  if (!lines) throw new Error("Spade's answer about this run didn't make sense.");
  return lines;
}

export async function keepCase(
  target: SpadeTarget,
  bot: string,
  keep: KeepCase,
): Promise<SpadeCaseSummary> {
  const kept = parseSpadeKeptCase(await spadeHttp(target, "POST", path(bot), { body: body(keep) }));
  if (!kept) throw new Error("Spade's answer about the kept test didn't make sense.");
  return kept;
}

export async function deleteCase(target: SpadeTarget, bot: string, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `${path(bot)}/${segment(id)}`);
}

/** Bot `bot`'s kept cases, newest first. */
export function useSpadeCases(bot: string) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  return useQuery({
    queryKey: casesKey(machine, bot),
    queryFn: async ({ signal }) => {
      const cases = parseSpadeCases(await spadeHttp(client, "GET", path(bot), { signal }));
      if (!cases) throw new Error("Spade's answer about kept tests didn't make sense.");
      return cases;
    },
  });
}
