import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/**
 * The person's subscriptions a bot can think with (ADR 0133): each provider whose CLI ace has
 * installed and signed in, its accounts and models. A bot's model on one is
 * `cli:<provider>[@<account>]/<model>`.
 */
export interface SpadeSubscription {
  provider: string;
  /** The provider's name as people know it ("Codex"). */
  name: string;
  accounts: { id: string; label: string | undefined }[];
  models: { id: string; name: string }[];
}

/** Where a bot's model comes from in the picker: one account of one subscription. */
export interface SpadeSubscriptionSource {
  /** `cli:<provider>@<account>`: unique among endpoints, whose ids have no colon. */
  key: string;
  provider: string;
  account: string;
  /** "Codex", or "Codex · Work" when the provider has more than one account. */
  label: string;
  models: SpadeSubscription["models"];
}

const listing = z.object({
  providers: z
    .array(
      z.object({
        provider: z.string().min(1),
        name: z.string().catch(""),
        accounts: z
          .array(z.object({ id: z.string().min(1), label: z.string().nullish().catch(null) }))
          .catch([]),
        models: z.array(z.object({ id: z.string().min(1), name: z.string().catch("") })).catch([]),
      }),
    )
    .catch([]),
  error: z.string().nullish().catch(null),
});

/** `GET /v1/subscriptions`; `error` when ace couldn't say (it is away). */
export function parseSpadeSubscriptions(
  body: string,
): { providers: SpadeSubscription[]; error: string | undefined } | undefined {
  const parsed = listing.safeParse(spadeRecord(spadeJson(body)));
  if (!parsed.success) return undefined;
  return {
    providers: parsed.data.providers.map((entry) => ({
      provider: entry.provider,
      name: entry.name || entry.provider,
      accounts: entry.accounts.map((a) => ({ id: a.id, label: a.label ?? undefined })),
      models: entry.models.map((m) => ({ id: m.id, name: m.name || m.id })),
    })),
    error: parsed.data.error ?? undefined,
  };
}

/** One picker source per account, in ace's order. */
export function spadeSubscriptionSources(
  providers: readonly SpadeSubscription[],
): SpadeSubscriptionSource[] {
  return providers.flatMap((entry) =>
    entry.accounts.map((account) => ({
      key: `cli:${entry.provider}@${account.id}`,
      provider: entry.provider,
      account: account.id,
      label:
        entry.accounts.length > 1 ? `${entry.name} · ${account.label ?? account.id}` : entry.name,
      models: entry.models,
    })),
  );
}

/** A subscription model reference in its parts; undefined for an endpoint's `endpoint/model`. */
export function splitCliModel(
  ref: string,
): { provider: string; account: string | undefined; model: string } | undefined {
  const match = /^cli:([^@/]+)(?:@([^/]+))?\/(.+)$/.exec(ref);
  if (!match?.[1] || !match[3]) return undefined;
  return { provider: match[1], account: match[2], model: match[3] };
}

/** The picker source a subscription model belongs to, by key. */
export function cliSourceKey(ref: string, sources: readonly SpadeSubscriptionSource[]) {
  const parts = splitCliModel(ref);
  if (!parts) return undefined;
  return (
    sources.find(
      (source) =>
        source.provider === parts.provider &&
        (parts.account === undefined || source.account === parts.account),
    )?.key ?? undefined
  );
}
