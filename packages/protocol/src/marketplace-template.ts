import { z } from "zod";
import { MarketHash } from "./marketplace-base.ts";
import { MarketVisibility } from "./marketplace-publisher.ts";

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

export const ShareTemplateReview = z.strictObject({
  revision: MarketHash,
  visibility: MarketVisibility,
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
  left_out: z.array(z.string()).max(64),
  recipe: z.looseObject({
    format: z.literal("spade-bot"),
    version: z.literal(3),
    name: z.string(),
    blurb: z.string(),
    task: z.string(),
    face: z.unknown().optional(),
    model: z.enum(["capable", "fast"]),
    skills: Skills,
    notes: Notes,
    triggers: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("message") }),
          Schedule.extend({ kind: z.literal("schedule") }),
        ]),
      )
      .max(33),
    needs: z.object({ connectors: z.array(Connector).max(32) }),
  }),
  skills: z
    .array(
      z.object({
        reference: z.string().regex(/^skills\/[a-z0-9][a-z0-9-]{0,63}$/),
        text: z.string().max(16_000),
      }),
    )
    .max(32),
});

export const ShareTemplateDetails = z.object({
  revision: MarketHash,
  draft: ShareTemplateDraft,
  visibility: MarketVisibility.nullable(),
});

export type ShareTemplateDraft = z.infer<typeof ShareTemplateDraft>;
export type ShareTemplateDetails = z.infer<typeof ShareTemplateDetails>;
export type ShareTemplateReview = z.infer<typeof ShareTemplateReview>;
