import { ApprovalTarget } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { decisions, obj, questions, raw, str, type Obj } from "./native.ts";
import { toolDraft } from "./item.ts";

export function openRequest(
  agent: string,
  key: string,
  method: string,
  p: Obj,
  knownItem: boolean,
): Fact[] {
  const item = str(p["itemId"]);
  const facts: Fact[] = [];
  if (item && !knownItem)
    facts.push({
      type: "item.upsert",
      agent,
      item,
      draft: toolDraft(
        { kind: method.endsWith("requestUserInput") ? "ask_user" : "custom" },
        method,
        p,
        "running",
        method,
      ),
    });
  const request = method.endsWith("requestUserInput")
    ? { kind: "question" as const, questions: questions(p["questions"], false) }
    : method === "mcpServer/elicitation/request"
      ? {
          kind: "elicitation" as const,
          server: str(p["serverName"]),
          message: str(p["message"]),
          schema: p["requestedSchema"],
          ...(typeof p["url"] === "string" ? { url: p["url"] } : {}),
        }
      : {
          kind: "approval" as const,
          title: str(p["command"], method),
          target: (() => {
            const parsed = ApprovalTarget.safeParse({
              tool:
                p["networkApprovalContext"] || p["additionalPermissions"]
                  ? "codex-permissions-escalation"
                  : method,
              command: p["command"],
              cwd: p["cwd"],
              access: typeof p["command"] === "string" ? "execute" : "unknown",
              input: p,
            });
            return parsed.success ? parsed.data : undefined;
          })(),
          options:
            method === "item/permissions/requestApproval"
              ? decisions(["accept", "decline", "cancel"])
              : decisions(p["availableDecisions"]),
        };
  facts.push({
    type: "interaction.opened",
    agent,
    interaction: key,
    blocking: true,
    request,
    ...(item ? { item } : {}),
    raw: raw(method, p),
  });
  return facts;
}
export function turnError(
  value: unknown,
): NonNullable<Extract<Fact, { type: "turn.ended" }>["error"]> {
  const error = obj(value);
  const info = str(error["codexErrorInfo"], Object.keys(obj(error["codexErrorInfo"]))[0]);
  const message = str(error["message"], "Codex turn failed");
  return {
    kind:
      /usageLimit|rateLimit/.test(info) || /usage limit|rate limit/i.test(message)
        ? "quota"
        : /auth/i.test(info) || /authentication failed|not logged in/i.test(message)
          ? "auth"
          : /Stream|network|Connection/.test(info)
            ? "network"
            : "provider",
    message,
  };
}

const requestMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
export function isInteractiveRequest(method: string): boolean {
  return requestMethods.has(method);
}
