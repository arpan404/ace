import { z } from "zod";
import { trimmedText } from "./marketplace-base.ts";

/*
 * What an agent package adds to a bot recipe (ADR 0200 §3): the version 3 manifest's triggers,
 * declared effects, limits and requirements, as `@ace/marketplace` reads them. Schema only; the
 * reader that refuses what a package may never carry is `readRecipe`, and Spade's is
 * `spade_core::package::read`.
 */

/** The effects a package may declare (ADR 0171 decision 3's words, `credential` never). */
export const PackageEffectWord = z.enum([
  "network",
  "publish",
  "send_as_person",
  "pay",
  "change_access",
]);
export type PackageEffectWord = z.infer<typeof PackageEffectWord>;

/** The runtime modules a package can use (ADR 0200 §4.2), as `spade_core::effect::runtime` names them. */
export const PackageModule = z.enum([
  "task",
  "memory",
  "files",
  "web",
  "apps",
  "agents",
  "ui",
  "schedule",
  "devices",
  "outward",
  "notify",
]);

const Host = z
  .string()
  .max(260)
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/,
  );

/** A grant a package may ask for: driving one site or app, or one tool (ADR 0167 §5). */
export const PackageGrant = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drive_site"), host: z.string().min(1).max(253) }),
  z.strictObject({ kind: z.literal("drive_app"), app: z.string().min(1).max(200) }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    arguments: z.record(z.string().max(64), z.string().max(500)).optional(),
  }),
]);
export type PackageGrant = z.infer<typeof PackageGrant>;

/** One declared effect, with the reason the review shows beside its switch. */
export const PackageEffect = z.strictObject({
  effect: PackageEffectWord,
  hosts: z.array(Host).min(1).max(32).optional(),
  grant: PackageGrant.optional(),
  why: trimmedText(1, 500),
});
export type PackageEffect = z.infer<typeof PackageEffect>;

/** The ace events a package's trigger can wait for. */
export const PackageEvent = z.enum(["thread.finished", "thread.failed", "thread.needs_you"]);

const routineName = trimmedText(1, 60);
const instruction = trimmedText(1, 4000);

/**
 * A version 3 trigger other than a schedule: those read as the recipe's `routines`, which is
 * what version 2 always had.
 */
export const PackageTrigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message") }),
  z.strictObject({
    kind: z.literal("mention"),
    in: z
      .array(z.enum(["threads", "clubs"]))
      .max(2)
      .default(["threads", "clubs"]),
  }),
  z.strictObject({ kind: z.literal("event"), name: routineName, instruction, event: PackageEvent }),
  z.strictObject({ kind: z.literal("webhook"), name: routineName, instruction }),
]);
export type PackageTrigger = z.infer<typeof PackageTrigger>;

/** What it expects to spend and use: alerts and bounds, never a stop (ADR 0166, 0200 §3.6). */
export const PackageLimits = z.strictObject({
  spend_alert: z.strictObject({ usd_per_day: z.number().min(0).max(10_000) }).optional(),
  workers_at_once: z.number().int().min(1).max(64).optional(),
  workspace_mb: z.number().int().min(1).max(1_000_000).optional(),
});
export type PackageLimits = z.infer<typeof PackageLimits>;

export const PackageRequires = z.strictObject({
  runtime: z.string().max(20).optional(),
  spade: z.string().max(40).optional(),
});

/**
 * A card or panel a package ships (ADR 0200 §5). A panel's `state` and each action's `value` are
 * data schemas, a bounded JSON Schema subset `@ace/marketplace` reads strictly
 * (`readSchema`); here they are kept as written.
 */
export type PackageSurface =
  | { kind: "card"; id: string; file: string }
  | {
      kind: "panel";
      id: string;
      file: string;
      title: string;
      state?: unknown;
      actions?:
        | {
            name: string;
            label?: string | undefined;
            value?: unknown;
            confirm?: boolean | undefined;
          }[]
        | undefined;
    };
// Named rather than inferred: recipes ride in many wire messages, whose inferred type would
// otherwise grow past what the compiler writes out.
export const PackageSurface: z.ZodType<PackageSurface> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("card"), id: z.string().max(40), file: z.string().max(200) }),
  z.object({
    kind: z.literal("panel"),
    id: z.string().max(40),
    file: z.string().max(200),
    title: trimmedText(1, 60),
    state: z.unknown().optional(),
    actions: z
      .array(
        z.object({
          name: z.string().max(40),
          label: trimmedText(1, 40).optional(),
          value: z.unknown().optional(),
          confirm: z.boolean().optional(),
        }),
      )
      .max(16)
      .optional(),
  }),
]);

/**
 * A contract another of the person's bots may call (ADR 0200 §7): its input and output schemas
 * in the bounded subset `@ace/marketplace`'s `readSchema` checks, the effects a call may use
 * (within the package's), and examples. Schema only: the subset's rules are the reader's.
 */
export const PackageContract = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  summary: trimmedText(1, 200),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  effects: z.array(PackageEffectWord).max(5).default([]),
  examples: z
    .array(z.strictObject({ input: z.unknown(), output: z.unknown() }))
    .max(8)
    .default([]),
});
export type PackageContract = z.infer<typeof PackageContract>;

/** The version 3 fields a read recipe carries; a version 2 recipe has none of them. */
export const packageFields = {
  requires: PackageRequires.optional(),
  uses: z.array(PackageModule).max(16).optional(),
  triggers: z.array(PackageTrigger).max(40).default([]),
  effects: z.array(PackageEffect).max(32).default([]),
  limits: PackageLimits.optional(),
  contracts: z.array(PackageContract).max(16).optional(),
  tests: z
    .array(z.string().regex(/^tests\/[A-Za-z0-9._-]+\.json$/))
    .max(64)
    .default([]),
  style: z.strictObject({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
  surfaces: z.array(PackageSurface).max(16).optional(),
};

/** A linked bot's package and version, from the signed manifest (ADR 0200 §3.9). */
export const PackageLinkId = z.strictObject({
  source: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  hash: z.string().min(1).max(200),
});
export type PackageLinkId = z.infer<typeof PackageLinkId>;

/**
 * What an update or rollback does to a linked bot, from Spade's plan: each package field
 * replaced, the same, or kept because the person or the bot changed it, and each routine's step.
 */
export const PackageFieldStep = z.enum(["same", "replace", "kept"]);
export const PackagePlan = z.object({
  name: PackageFieldStep,
  task: PackageFieldStep,
  face: PackageFieldStep,
  personality: PackageFieldStep,
  routines: z
    .array(
      z.object({
        step: z.enum(["add", "replace", "remove", "kept"]),
        name: z.string().max(120),
        removed: z.boolean().optional(),
      }),
    )
    .max(64),
  notes_kept: z.number().int().nonnegative(),
  asks_more: z.array(z.string().max(2100)).max(64),
  off: z.array(z.string().max(2100)).max(64),
});
export type PackagePlan = z.infer<typeof PackagePlan>;
