import { stripVTControlCharacters } from "node:util";
import type { Interaction, Item } from "@ace/protocol";
import type { Outcome } from "./output.ts";
export type ChatRecord =
  | { type: "ready" | "help" }
  | { type: "thread"; threadId: string; idempotencyKey?: string }
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      complete: boolean;
      preview: boolean;
    }
  | { type: "delta"; id: string; text: string }
  | { type: "item"; item: Item }
  | { type: "interaction"; interaction: Interaction }
  | { type: "status"; status: Outcome | "in_progress"; working: boolean; threadId: string }
  | { type: "receipt"; receipt: unknown }
  | { type: "error"; status: Outcome; message: string; admission?: unknown }
  | { type: "detached"; threadId: string | undefined };
export interface ChatRenderState {
  active: string | undefined;
  messages: Map<string, { text: string | undefined; length: number }>;
}
export function chatRenderState(): ChatRenderState {
  return { active: undefined, messages: new Map() };
}
function safeText(text: string): string {
  // Strip incomplete terminal sequences too, including ones split across deltas.
  // oxlint-disable-next-line eslint/no-control-regex -- Terminal rendering excludes executable controls.
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export interface ChatPreview {
  id: string;
  text: string;
}
export function previewChat(
  previous: ChatPreview | undefined,
  record: Extract<ChatRecord, { type: "delta" | "message" }>,
  columns: number,
) {
  const text =
    record.type === "message"
      ? record.text
      : (previous?.id === record.id ? previous.text : "") + record.text;
  const tail = Array.from(safeText(text).replace(/\s+/g, " ")).slice(-256).join("");
  const width = Math.max(1, Math.min(10000, columns));
  const prefix = width > 8 ? "ai> " : "";
  const visible = Array.from(tail)
    .slice(-Math.max(1, Math.floor((width - prefix.length - 1) / 2)))
    .join("");
  return { state: { id: record.id, text: tail }, line: prefix + visible };
}
const help =
  "Enter a prompt. /stop interrupts the tree; /steer TEXT redirects it; /model MODEL selects a model; /resume [THREAD] resumes held work. /approve [INTERACTION] [OPTION] and /deny [INTERACTION] answer permissions. /quit detaches. Use // to send text beginning with /.";
/** Presentation state is bounded; the SDK owns transcript and reconnect state. */
export function renderChat(state: ChatRenderState, record: ChatRecord): string {
  const clean = safeText;
  const close = () => {
    const newline = state.active ? "\n" : "";
    state.active = undefined;
    return newline;
  };
  const remember = (id: string, text: string | undefined, length: number) => {
    state.messages.delete(id);
    state.messages.set(id, {
      text: text !== undefined && text.length <= 65536 ? text : undefined,
      length,
    });
    if (state.messages.size > 128) {
      const oldest = state.messages.keys().next().value;
      if (oldest !== undefined) state.messages.delete(oldest);
    }
  };
  if (record.type === "message") {
    const previous = state.messages.get(record.id);
    const append = previous?.text !== undefined && record.text.startsWith(previous.text);
    const text = append ? record.text.slice(previous.length) : record.text;
    const prefix =
      state.active === record.id && (!previous || append)
        ? ""
        : close() + `${record.role}${previous && !append ? " (updated)" : ""}: `;
    if (!text && previous) {
      if (record.complete && state.active === record.id) return close();
      return "";
    }
    remember(record.id, record.text, record.text.length);
    state.active = record.complete ? undefined : record.id;
    return (
      prefix +
      clean(text) +
      (record.preview ? "\n[Stored message preview]" : "") +
      (record.complete ? "\n" : "")
    );
  }
  if (record.type === "delta") {
    const previous = state.messages.get(record.id);
    const text = previous
      ? previous.text === undefined
        ? undefined
        : previous.text + record.text
      : record.text;
    remember(record.id, text, (previous?.length ?? 0) + record.text.length);
    const prefix = state.active === record.id ? "" : close() + "assistant: ";
    state.active = record.id;
    return prefix + clean(record.text);
  }
  let text: string;
  switch (record.type) {
    case "ready":
      text = "ace chat. Type /help for commands.";
      break;
    case "help":
      text = help;
      break;
    case "thread":
      text = `Thread ${record.threadId}`;
      break;
    case "status":
      text =
        record.status === "in_progress"
          ? record.working
            ? "Working"
            : "Waiting"
          : {
              ok: "Tree complete",
              failed: "Work failed or was cancelled",
              "needs-human": "Needs human input",
              uncertain: "Work state is uncertain",
              timeout: "Observation timed out",
              refused: "Operation refused",
            }[record.status];
      break;
    case "interaction": {
      const request = record.interaction.request;
      text =
        request.kind === "approval"
          ? `Approval ${record.interaction.id} in ${record.interaction.threadId}: ${request.title}\nAllow once? [y/n] Or /approve ${record.interaction.id} OPTION.\n${request.options.map((option) => `${option.id}: ${option.label}`).join("\n")}`
          : request.kind === "plan_review"
            ? `Plan review ${record.interaction.id}\n${request.markdown}\nApprove? [y/n]`
            : `Input ${record.interaction.id} needs an answer in ace (${request.kind}).`;
      break;
    }
    case "item":
      text = record.item.type === "notice" ? record.item.text : `[${record.item.type}]`;
      break;
    case "receipt":
      return "";
    case "error":
      text = record.message;
      break;
    case "detached":
      text = record.threadId
        ? `Detached from ${record.threadId}. Resume with ace chat --thread ${record.threadId}.`
        : "Chat closed.";
      break;
  }
  return close() + clean(text) + "\n";
}
