import type { InteractionResolution } from "@ace/protocol";
import type { ServerRequest } from "@ace/provider-kit/jsonrpc";
import { list, obj, str } from "./native.ts";
export function approvalResult(request: ServerRequest, resolution: InteractionResolution): unknown {
  const p = obj(request.params);
  if (request.method === "item/tool/requestUserInput" && resolution.kind === "question")
    return {
      answers: Object.fromEntries(
        Object.entries(resolution.answers).map(([id, answers]) => [
          id,
          { answers: resolution.dismissed ? [] : answers },
        ]),
      ),
    };
  if (request.method === "mcpServer/elicitation/request" && resolution.kind === "elicitation")
    return {
      action: resolution.action,
      ...(resolution.content === undefined ? {} : { content: resolution.content }),
    };
  if (resolution.kind !== "approval")
    throw new Error("Resolution kind does not match the Codex interaction");
  if (request.method === "item/permissions/requestApproval")
    return {
      permissions: resolution.optionId === "accept" ? (p["permissions"] ?? {}) : {},
      scope: "turn",
    };
  const available = list(
    p["availableDecisions"] ?? ["accept", "acceptForSession", "decline", "cancel"],
  );
  const decision = available.find(
    (entry) => str(entry, Object.keys(obj(entry))[0]) === resolution.optionId,
  );
  if (decision === undefined) throw new Error("Approval option is not offered by Codex");
  return { decision };
}
