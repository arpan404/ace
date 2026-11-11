import { z } from "zod";
import { ForgeRepository, ForgePrRef } from "@ace/protocol/forge";
import { ForgePrRow } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";
import { redactData } from "./redact.ts";
import { prUrl } from "./pr-reference.ts";

/*
 * Bitbucket Cloud REST 2.0 records (developer.atlassian.com/cloud/bitbucket/rest), decoded
 * leniently: unknown fields are kept in `raw`, unknown states read as unknown.
 */

export const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
/** Pull request endpoints name abbreviated hashes (12 characters on Bitbucket Cloud). */
const shortHash = z.string().regex(/^[a-f0-9]{7,64}$/);
export const account = z.looseObject({
  uuid: z.string().optional(),
  nickname: z.string().optional(),
  display_name: z.string().optional(),
  username: z.string().optional(),
});
export type Account = z.infer<typeof account>;
const endpoint = z.looseObject({
  branch: z.looseObject({ name: z.string() }),
  commit: z.looseObject({ hash: shortHash }),
  repository: z.looseObject({ full_name: z.string() }).nullable().optional(),
});
export const participant = z.looseObject({
  user: account.nullable().optional(),
  role: z.string().optional(),
  approved: z.boolean().optional(),
  state: z.string().nullable().optional(),
  participated_on: z.string().nullable().optional(),
});
export const pull = z.looseObject({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.string(),
  draft: z.boolean().optional(),
  author: account.nullable().optional(),
  source: endpoint,
  destination: endpoint,
  created_on: z.string().optional(),
  updated_on: z.string().optional(),
  comment_count: z.number().int().nonnegative().optional(),
  participants: z.array(participant).max(1000).optional(),
});
export type Pull = z.infer<typeof pull>;
/** One page of a Bitbucket list: `values`, and `next` while more remain. */
export function page<T extends z.ZodType>(row: T, max: number) {
  return z.looseObject({
    values: z.array(row).max(max),
    next: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  });
}

export function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
export function ref(repository: ForgeRepository, number: number) {
  return decode(ForgePrRef, { repository, number });
}
/** Who someone is, as Bitbucket shows them: nickname, else display name. */
export function name(person: Account | null | undefined): string {
  return clipText(person?.nickname ?? person?.display_name ?? "");
}
/**
 * OPEN is open, or draft when Bitbucket's draft flag is set; DECLINED and SUPERSEDED are
 * closed; anything Bitbucket adds later is unknown, never open.
 */
export function state(p: Pull): "open" | "draft" | "closed" | "merged" | "unknown" {
  if (p.state === "MERGED") return "merged";
  if (p.state === "DECLINED" || p.state === "SUPERSEDED") return "closed";
  if (p.state !== "OPEN") return "unknown";
  return p.draft === true ? "draft" : "open";
}
export function row(repo: ForgeRepository, p: Pull) {
  const s = state(p);
  if (s === "unknown") return null;
  // Rows carry no head: Bitbucket lists only abbreviated hashes, never a commit to pin to.
  return decode(ForgePrRow, {
    ref: ref(repo, p.id),
    title: clipText(p.title),
    url: prUrl({ repository: repo, number: p.id }),
    author: name(p.author),
    state: s,
    labels: [],
    updatedAt: p.updated_on ?? "",
    headBranch: clipText(p.source.branch.name),
    baseBranch: clipText(p.destination.branch.name),
    raw: redactData(p),
  });
}
/** The repository a pull request's source branch lives in: the repository itself or a fork. */
export function sourceRepository(repo: ForgeRepository, p: Pull): ForgeRepository | null {
  const full = p.source.repository?.full_name;
  if (!full) return null;
  const [owner, slug, ...rest] = full.split("/");
  if (!owner || !slug || rest.length) throw new ForgeError("invalid_data");
  return decode(ForgeRepository, { forge: repo.forge, host: repo.host, owner, name: slug });
}
/** Whether a full hash is the commit an abbreviated one names. */
export function abbreviates(short: string, full: string): boolean {
  return full.startsWith(short) && short.length >= 7;
}
