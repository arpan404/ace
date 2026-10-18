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
        row: {
          ...row,
          text: "Content unavailable. Check your machine.",
          truncated: true,
          step: null,
          attachments: [],
        },
      };
    case "thread.block":
      return { ...patch, row: { ...row, work: null, agents: null, ending: null, started: null } };
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
          heading: "Approval details unavailable",
          reason: "",
          riskText: "",
          ...degradedChoices(row),
          ...degradedRequest(row),
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

const Entries = z.array(z.record(z.string(), z.unknown()));
const Questions = z.array(
  z.object({ options: z.array(z.record(z.string(), z.unknown())) }).catchall(z.unknown()),
);

/** Verbs and option ids stay; scopes, labels and question words become placeholders. */
function degradedChoices(row: Record<string, unknown>): Record<string, unknown> {
  const decisions = Entries.safeParse(row.decisions);
  const others = Entries.safeParse(row.others);
  const questions = Questions.safeParse(row.questions);
  return {
    ...(decisions.success
      ? { decisions: decisions.data.map((decision) => Object.assign(decision, { scope: "" })) }
      : {}),
    ...(others.success
      ? {
          others: others.data.map((other, index) =>
            Object.assign(other, { label: `Action ${index + 1}` }),
          ),
        }
      : {}),
    ...(questions.success
      ? {
          questions: questions.data.map((question, index) =>
            Object.assign(question, {
              header: "",
              text: `Question ${index + 1}. Check the full request on your machine.`,
              options: question.options.map((option, at) =>
                Object.assign(option, { label: `Option ${at + 1}`, detail: "" }),
              ),
            }),
          ),
        }
      : {}),
  };
}

const Form = z
  .object({ fields: z.array(z.object({ choices: Entries }).catchall(z.unknown())) })
  .catchall(z.unknown());

/** Plans, forms and browser requests keep their field keys and choice values; words go. */
function degradedRequest(row: Record<string, unknown>): Record<string, unknown> {
  const form = Form.safeParse(row.form);
  return {
    ...(row.plan
      ? {
          plan: {
            title: "Plan details unavailable",
            summary: "",
            markdown: "Check the full plan on your machine.",
            truncated: true,
            todos: [],
          },
        }
      : {}),
    ...(form.success
      ? {
          form: Object.assign(form.data, {
            title: "Request details unavailable",
            message: "Check the full request on your machine.",
            fields: form.data.fields.map((field, index) =>
              Object.assign(field, {
                title: `Field ${index + 1}`,
                detail: "",
                choices: field.choices.map((choice, at) =>
                  Object.assign(choice, { label: `Choice ${at + 1}` }),
                ),
              }),
            ),
          }),
        }
      : {}),
    ...(row.help ? { help: { title: "Browser request", detail: "" } } : {}),
  };
}
