import { z } from "zod";

/**
 * The shape of `registry.json`: every registration Spade needs from a maker, the facts the
 * person types into the maker's console, and how far along each one is. Never a secret.
 */

/** Where every broker app's maker sends the person back to (ace cloud, `apps/cloud`). */
export const BROKER_CALLBACK = "https://cloud.acehq.dev/v1/oauth/callback/";
/** Spade's OAuth client ID metadata document (ADR 0136), served by the marketing site. */
export const CLIENT_DOCUMENT = "https://acehq.dev/oauth/spade.json";
/** Spade's loopback redirect for approval apps; any port, as RFC 8252 allows. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1/v1/connectors/callback";

const Id = z.string().regex(/^[a-z0-9-]{1,64}$/);
const SecretName = z.string().regex(/^[A-Z0-9_]{1,128}$/);
const Text = z.string().min(1);

export const Status = z.enum(["not-started", "submitted", "approved", "blocked"]);
export type Status = z.infer<typeof Status>;

const common = {
  id: Id,
  name: Text,
  status: Status,
  started: z.iso.date().nullable(),
  /** Lower is done earlier: the longest review queues go first. */
  order: z.int().nonnegative(),
  /** The person's typing time, not the maker's review. */
  minutes: z.int().positive(),
  blocked_on: Text.nullable(),
  /** Caveats to show at the moment of registering. */
  notes: z.array(Text),
};

/** An app ace cloud signs in to for Spade, holding its client secret (ADR 0140, 0141). */
export const BrokerEntry = z.strictObject({
  ...common,
  kind: z.literal("broker"),
  /** The `SHIPPED_APPS` ids this one registration serves. */
  apps: z.array(Id).min(1),
  redirects: z.array(z.url()).min(1),
  scopes: z.array(Text),
  secrets: z.tuple([SecretName, SecretName]),
  console: z.url(),
  where: Text,
});
export type BrokerEntry = z.infer<typeof BrokerEntry>;

/** An app whose public client ID ships in Spade, with no secret (ADR 0137). */
export const PublicEntry = z.strictObject({
  ...common,
  kind: z.literal("public"),
  redirects: z.array(z.url()).min(1),
  scopes: z.array(Text),
  console: z.url(),
  where: Text,
  client_id_file: z.literal("spade/config/connector-apps.json"),
  device_flow: z.literal(true),
});
export type PublicEntry = z.infer<typeof PublicEntry>;

/** Values a form answer can name as `{token}`, so they come from the registry, never a copy. */
export const ANSWER_TOKENS = [
  "name",
  "homepage",
  "privacy",
  "terms",
  "description",
  "contact",
  "client_document",
  "redirect",
] as const;
export type AnswerToken = (typeof ANSWER_TOKENS)[number];

export function isAnswerToken(name: string | undefined): name is AnswerToken {
  return ANSWER_TOKENS.some((known) => known === name);
}

const Answer = Text.refine(
  (answer) => [...answer.matchAll(/\{([a-z_]+)\}/g)].every(([, token]) => isAnswerToken(token)),
  `unknown {token}; known: ${ANSWER_TOKENS.join(", ")}`,
);

/** A maker that must let Spade's client ID metadata document in. */
export const ApprovalEntry = z.strictObject({
  ...common,
  kind: z.literal("approval"),
  /** The request, in the owner's voice. */
  ask: Text,
  channel: Text,
  /** Where to send it; `null` when it is an email. */
  console: z.url().nullable(),
  client_document: z.literal(CLIENT_DOCUMENT),
  redirects: z.tuple([z.literal(LOOPBACK_REDIRECT)]),
  /** The maker's form, when it has one: each field in its order, with the answer to paste. */
  form: z
    .array(z.strictObject({ field: Text, answer: Answer }))
    .min(1)
    .optional(),
});
export type ApprovalEntry = z.infer<typeof ApprovalEntry>;

export const Entry = z.discriminatedUnion("kind", [BrokerEntry, PublicEntry, ApprovalEntry]);
export type Entry = z.infer<typeof Entry>;

/** What every console asks about Spade itself. */
export const Identity = z.strictObject({
  name: Text,
  homepage: z.url(),
  privacy: z.url(),
  terms: z.url(),
  description: Text,
  /** Repository path of the logo to upload. */
  logo: Text,
  contact: z.email(),
});
export type Identity = z.infer<typeof Identity>;

export const Registry = z
  .strictObject({ about: Text, app: Identity, registrations: z.array(Entry).min(1) })
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (const entry of registry.registrations) {
      if (ids.has(entry.id)) context.addIssue({ code: "custom", message: `${entry.id} twice` });
      if (orders.has(entry.order))
        context.addIssue({ code: "custom", message: `${entry.id}: order ${entry.order} twice` });
      ids.add(entry.id);
      orders.add(entry.order);
    }
  });
export type Registry = z.infer<typeof Registry>;

/** What the checks need from each `SHIPPED_APPS` entry in `apps/cloud/src/broker/apps.ts`. */
export type CloudApp = {
  id: string;
  scopes: readonly string[];
  client_id_env: string;
  client_secret_env: string;
};

/** What the checks need from `spade/config/connector-apps.json`. */
export const PublicConfig = z.object({
  apps: z.array(
    z.object({ connector: z.string(), client_id: z.string(), scopes: z.array(z.string()) }),
  ),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** The two legal pages the marketing site declares, and its `_redirects` rules. */
export type LegalSite = {
  privacyPath: string | undefined;
  termsPath: string | undefined;
  redirects: ReadonlyMap<string, string>;
};

/** Registrations in the order to do them. */
export function inOrder(registry: Registry): Entry[] {
  return registry.registrations.toSorted((a, b) => a.order - b.order);
}
