import { z } from "zod";
import { MarketEntryName, MarketHash } from "./marketplace-base.ts";
import {
  PackageHeartbeat,
  PackageKnowledgePage,
  PackageModelRoles,
  PackagePluginCommands,
} from "./marketplace-package.ts";
import { MarketDraftId, MarketVisibility } from "./marketplace-publisher.ts";

export const ShareTemplateId = z.string().regex(/^template_[a-z0-9_]{1,64}$/);
const Schedule = z.object({
  name: z.string().max(200),
  instruction: z.string().max(20_000),
  schedule: z.string().max(500),
});
const Skills = z.array(z.string().max(100)).max(32);
const Notes = z.array(z.string().max(2000)).max(50);
const Connector = z.object({
  id: z.string().max(100),
  why: z.string().max(500),
  required: z.boolean(),
});

const File = z.object({
  path: z.string().min(1).max(512),
  text: z.string().max(512 * 1024),
  executable: z.boolean(),
});
const References = z.array(z.string().max(120)).max(32);
const Knowledge = z.array(PackageKnowledgePage).max(32);

export const TemplateGrantTarget = z.strictObject({
  draft: MarketDraftId,
  publisher: z.string().min(1).max(64),
  name: MarketEntryName,
  hash: MarketHash,
  version: z.literal("1.0.0"),
  visibility: MarketVisibility,
});
export type TemplateGrantTarget = z.infer<typeof TemplateGrantTarget>;

export const ShareTemplateReview = z.strictObject({
  reviewed: z.literal(true),
  revision: MarketHash,
  visibility: MarketVisibility,
  knowledge: Knowledge.optional(),
  include_heartbeat: z.boolean().optional(),
  event_routines: References.optional(),
  surfaces: References.optional(),
  contracts: References.optional(),
  plugins: References.optional(),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  task: z.string().min(1).max(20_000),
  notes: Notes,
  skills: Skills,
  routines: z.array(Schedule).max(32),
  connectors: z.array(z.string().max(100)).max(32),
});

export const ShareTemplateDraft = z.object({
  bot: z.string(),
  surface_files: z.array(File).max(16).default([]),
  left_out: z.array(z.string()).max(64),
  recipe: z.looseObject({
    format: z.literal("spade-bot"),
    version: z.literal(3),
    name: z.string(),
    blurb: z.string(),
    task: z.string(),
    face: z.unknown().optional(),
    style: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
    knowledge: Knowledge.optional(),
    heartbeat: PackageHeartbeat.optional(),
    model_roles: PackageModelRoles.optional(),
    plugin_commands: PackagePluginCommands.optional(),
    plugins: References.optional(),
    surfaces: z
      .array(z.looseObject({ id: z.string(), file: z.string() }))
      .max(16)
      .optional(),
    contracts: z
      .array(z.looseObject({ name: z.string() }))
      .max(16)
      .optional(),
    model: z.enum(["capable", "fast"]),
    skills: Skills,
    notes: Notes,
    triggers: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("message") }),
          Schedule.extend({ kind: z.literal("schedule") }),
          z.object({
            kind: z.literal("event"),
            name: z.string(),
            instruction: z.string(),
            event: z.string(),
          }),
          z.object({ kind: z.literal("webhook"), name: z.string(), instruction: z.string() }),
        ]),
      )
      .max(33),
    needs: z.object({ connectors: z.array(Connector).max(32) }),
  }),
  skills: z
    .array(
      z.object({
        reference: z.string().regex(/^skills\/[a-z0-9][a-z0-9-]{0,63}$/),
        text: z.string().max(512 * 1024),
        files: z.array(File).max(512).default([]),
      }),
    )
    .max(32),
});

export const ShareTemplateDetails = z.object({
  revision: MarketHash,
  draft: ShareTemplateDraft,
  visibility: MarketVisibility.nullable(),
  shareId: z.uuidv7().nullish(),
});

export type ShareTemplateDraft = z.infer<typeof ShareTemplateDraft>;
export type ShareTemplateDetails = z.infer<typeof ShareTemplateDetails>;
export type ShareTemplateReview = z.infer<typeof ShareTemplateReview>;
