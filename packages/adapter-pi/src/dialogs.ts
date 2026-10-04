import { piDialogApproval } from "./tool-approval.ts";
import type { InteractionRequest, InteractionResolution } from "@ace/protocol";
import type { Dialog } from "./native.ts";
export function dialogRequest(dialog: Dialog): InteractionRequest {
  const target = piDialogApproval(dialog);
  if (target)
    return {
      kind: "approval",
      target,
      title: `Pi ${target.tool}`,
      defaultToNo: true,
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "deny" },
      ],
    };
  if (dialog.method === "confirm")
    return {
      kind: "question",
      questions: [
        {
          id: dialog.id,
          text: dialog.title + (dialog.message ? `\n${dialog.message}` : ""),
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          multiSelect: false,
          allowOther: false,
        },
      ],
    };
  return {
    kind: "question",
    questions: [
      {
        id: dialog.id,
        text: dialog.title + (dialog.prefill ? `\n${dialog.prefill}` : ""),
        options: (dialog.options ?? []).map((label, index) => ({ id: String(index), label })),
        multiSelect: false,
        allowOther: dialog.method !== "select",
      },
    ],
  };
}
export function dialogResponse(
  dialog: Dialog,
  resolution: InteractionResolution,
): Record<string, unknown> {
  const base = { type: "extension_ui_response", id: dialog.id };
  if (piDialogApproval(dialog)) {
    if (resolution.kind !== "approval" || !["allow", "deny"].includes(resolution.optionId))
      throw new Error("Pi requires a one-shot tool approval");
    return { ...base, confirmed: resolution.optionId === "allow" };
  }
  if (dialog.method === "confirm") {
    if (resolution.kind !== "question") throw new Error("Expected Pi confirmation answer");
    if (resolution.dismissed) return { ...base, cancelled: true };
    const answers = resolution.answers[dialog.id];
    if (!answers || answers.length !== 1 || !["yes", "no"].includes(answers[0] ?? ""))
      throw new Error("Invalid Pi confirmation");
    return { ...base, confirmed: answers[0] === "yes" };
  }

  if (resolution.kind !== "question") throw new Error("Expected Pi question resolution");
  if (resolution.dismissed) return { ...base, cancelled: true };
  const answers = resolution.answers[dialog.id];
  if (!answers || answers.length !== 1) throw new Error("Pi dialogs require one answer");
  const answer = answers[0];
  if (answer === undefined) throw new Error("Missing answer");
  if (dialog.method === "select") {
    const index = Number(answer);
    const value = dialog.options?.[index];
    if (!Number.isInteger(index) || String(index) !== answer || value === undefined)
      throw new Error("Unknown Pi selection");
    return { ...base, value };
  }
  return { ...base, value: answer };
}
