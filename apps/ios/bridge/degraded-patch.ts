import { z } from "zod";
import { ApprovalOption } from "@ace/protocol";

const Row = z.record(z.string(), z.unknown());
const Options = z.array(ApprovalOption.passthrough());

/** Replace display details only. Canonical identities, state, actions and ordering stay exact. */
export function degradedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const parsed = Row.safeParse(patch.row);
  if (!parsed.success) {
    if (typeof patch.message === "string")
      return { ...patch, message: "Update details unavailable. Check your machine." };
    return patch;
  }
  const row = parsed.data;
  switch (patch.type) {
    case "inbox.row":
    case "thread.metadata":
      return {
        ...patch,
        row: {
          ...row,
          title: "Details unavailable",
          project: "",
          branch: "",
          machine: "",
          model: "",
        },
      };
    case "thread.item":
      return {
        ...patch,
        row: { ...row, text: "Content unavailable. Check your machine.", truncated: true },
      };
    case "pending":
      return { ...patch, row: { ...row, text: "Saved input details unavailable" } };
    case "thread.interaction": {
      const options = Options.safeParse(row.options);
      if (!options.success) return patch;
      const labels: Record<string, string> = {
        allow_once: "Allow once",
        allow_session: "Allow for session",
        allow_always: "Always allow",
        deny: "Deny",
        deny_always: "Always deny",
        cancel: "Cancel",
      };
      return {
        ...patch,
        row: {
          ...row,
          title: "Approval details unavailable",
          description: "Check the full request on your machine.",
          command: "",
          truncated: true,
          options: options.data.map((option, index) =>
            Object.assign(option, {
              label: labels[option.kind] ?? `Action ${index + 1}`,
            }),
          ),
        },
      };
    }
    default:
      return patch;
  }
}
