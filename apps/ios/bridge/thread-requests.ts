import type { CommandPayload, Interaction } from "@ace/protocol";
import {
  browserHelpDetail,
  browserHelpTitle,
  consentUrl,
  elicitationContent,
  elicitationForm,
} from "@ace/ui-core";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * The agent's other requests, besides approvals and questions: a plan to approve or send back,
 * an MCP server's form or consent page (elicitation), and a browser tab that needs the person.
 * Their card rows, and the canonical resolution for what the person chose, validated against the
 * request as the web validates it (`@ace/ui-core` form rules). Pure over the interaction.
 */

type Resolution = Extract<CommandPayload, { type: "interaction.resolve" }>["resolution"];
type Request = Interaction["request"];

const planLimit = 8192;
const todoLimit = 32;

/** What the person chose on a request card, as Swift sends it. */
export const RequestAnswer = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    decision: z.enum(["approve", "reject", "cancel"]),
    feedback: z.string().max(8192).optional(),
  }),
  z.object({
    kind: z.literal("form"),
    action: z.enum(["accept", "decline", "cancel"]),
    values: z.record(z.string().max(256), z.string().max(8192)).optional(),
  }),
  z.object({ kind: z.literal("help"), outcome: z.enum(["done", "skipped"]) }),
]);
export type RequestAnswer = z.infer<typeof RequestAnswer>;

function planRow(request: Extract<Request, { kind: "plan_review" }>) {
  return {
    title: preview(request.title ?? "Review the plan"),
    summary: preview(request.summary ?? "", 2048),
    markdown: preview(request.markdown, planLimit),
    truncated: request.markdown.length > planLimit,
    todos: (request.todos ?? []).slice(0, todoLimit).map((todo) => ({
      text: preview(todo.content, 512),
      status: todo.status,
    })),
  };
}

function formMode(request: Extract<Request, { kind: "elicitation" }>) {
  return request.mode ?? (request.url ? "url" : "form");
}

function formRow(request: Extract<Request, { kind: "elicitation" }>) {
  const mode = formMode(request);
  const form = mode === "form" ? elicitationForm(request.schema) : undefined;
  const url = mode === "url" ? consentUrl(request.url) : undefined;
  const fields = Object.entries(form?.properties ?? {}).map(([key, property]) => ({
    key,
    title: preview(property.title ?? key, 256),
    detail: preview(property.description ?? "", 512),
    type: property.type,
    required: form?.required.includes(key) ?? false,
    initial: property.default === undefined ? "" : preview(String(property.default), 512),
    choices:
      property.enum?.map((entry, at) => ({
        value: String(entry),
        label: preview(property.enumNames?.[at] ?? String(entry), 128),
      })) ??
      (property.type === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : []),
    minimum: property.minimum ?? null,
    maximum: property.maximum ?? null,
  }));
  return {
    server: preview(request.server, 256),
    title: preview(request.title ?? request.message),
    message: preview(request.message, 2048),
    mode,
    url: url ? preview(url, 2048) : "",
    // A form ace can't draw, or a consent page without a safe address, can only be declined.
    unsupported: mode === "url" ? !url : !form,
    fields,
  };
}

/** The card fields a plan review, form or browser request adds to its interaction row. */
export function requestRow(request: Request) {
  return {
    plan: request.kind === "plan_review" ? planRow(request) : null,
    form: request.kind === "elicitation" ? formRow(request) : null,
    help:
      request.kind === "browser_help"
        ? {
            title: preview(browserHelpTitle(request)),
            detail: preview(browserHelpDetail(request) ?? "", 1024),
          }
        : null,
  };
}

/**
 * The canonical resolution for a request card, or undefined when the choice doesn't fit the
 * request: plan feedback must say what should change; a form is accepted only with values that
 * pass its schema, and a consent page only when it has a safe address.
 */
export function requestResolution(
  interaction: Interaction | undefined,
  answer: RequestAnswer,
): Resolution | undefined {
  if (interaction?.state !== "pending") return undefined;
  const request = interaction.request;
  if (answer.kind === "plan") {
    if (request.kind !== "plan_review") return undefined;
    if (answer.decision !== "reject") return { kind: "plan_review", decision: answer.decision };
    const feedback = answer.feedback?.trim();
    return feedback ? { kind: "plan_review", decision: "reject", feedback } : undefined;
  }
  if (answer.kind === "help")
    return request.kind === "browser_help"
      ? { kind: "browser_help", outcome: answer.outcome }
      : undefined;
  if (request.kind !== "elicitation") return undefined;
  if (answer.action !== "accept") return { kind: "elicitation", action: answer.action };
  const mode = formMode(request);
  if (mode === "url")
    return consentUrl(request.url) ? { kind: "elicitation", action: "accept" } : undefined;
  const form = elicitationForm(request.schema);
  if (!form) return undefined;
  const values = answer.values ?? {};
  if (Object.keys(values).some((key) => !(key in form.properties))) return undefined;
  const result = elicitationContent(form, values);
  return result.valid
    ? { kind: "elicitation", action: "accept", content: result.content }
    : undefined;
}
