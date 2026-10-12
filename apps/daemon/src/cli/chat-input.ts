import { CliFailure } from "./output.ts";
export type ChatAction =
  | { kind: "send" | "steer"; text: string }
  | { kind: "model"; model: string }
  | { kind: "resume"; thread: string | undefined }
  | { kind: "approve" | "deny"; interaction: string | undefined; option: string | undefined }
  | { kind: "stop" | "quit" | "help" | "empty" };
/** Terminal syntax only; provider input and permissions remain daemon-owned. */
export function chatAction(line: string): ChatAction {
  if (line.length > 65536) throw new CliFailure("refused", "Chat input exceeds 64 KiB");
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "send", text: line };
  if (text.startsWith("//")) return { kind: "send", text: line.replace("//", "/") };
  const split = text.indexOf(" ");
  const verb = split < 0 ? text : text.slice(0, split);
  const value = split < 0 ? "" : text.slice(split + 1).trim();
  if (["/stop", "/quit", "/help"].includes(verb) && !value) {
    if (verb === "/stop") return { kind: "stop" };
    return { kind: verb === "/quit" ? "quit" : "help" };
  }
  if (verb === "/steer" && value) return { kind: "steer", text: value };
  if (verb === "/model" && value) return { kind: "model", model: value };
  if (verb === "/resume" && !value.includes(" "))
    return { kind: "resume", thread: value || undefined };
  if (verb === "/approve" || verb === "/deny") {
    const words = value ? value.split(/\s+/) : [];
    if (words.length <= 2)
      return {
        kind: verb === "/approve" ? "approve" : "deny",
        interaction: words[0],
        option: words[1],
      };
  }
  throw new CliFailure("refused", "Unknown chat command. Type /help.");
}
