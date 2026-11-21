import { object, string, type Data } from "./data.ts";
import type { ToolStatus } from "@ace/protocol";
import type { AcpQuirks } from "./quirks/types.ts";
import { mergeToolData, toolDetail, toolStatus } from "./tools.ts";
import { shellSurvivesPrompt } from "./settlement.ts";
interface NativeTool {
  owner: string;
  data: Data;
  status: ToolStatus;
  shell: boolean;
}
const terminal = new Set(["succeeded", "failed", "cancelled", "declined"]);
/**
 * Whether a tool's live update holds the session's next prompt: the root's work while no prompt
 * is open, other than a shell that outlived its prompt (that one blocks prompts on its own). The
 * one rule for both the session's input gate (`busy`) and the work the translator reports as
 * holding prompts, so a Stop always sees what the gate waits on.
 */
export function holdsNextPrompt(promptOpen: boolean, ofRoot: boolean, survivedShell: boolean) {
  return !promptOpen && ofRoot && !survivedShell;
}
/** Pure native settlement, indexed by live tools rather than prior notifications. */
export class ShellSettlement {
  readonly quirks: AcpQuirks;
  readonly tools = new Map<string, NativeTool>();
  readonly unsettled = new Set<string>();
  /** Root tools that started or still ran after the prompt answered: work with no prompt open. */
  readonly afterPrompt = new Set<string>();
  /** The root session's id, once known. */
  root = "";
  promptOpen = false;
  constructor(quirks: AcpQuirks) {
    this.quirks = quirks;
  }
  receive(params: Data): void {
    const update = object(params["update"]);
    if (!["tool_call", "tool_call_update"].includes(string(update["sessionUpdate"]))) return;
    const owner = string(params["sessionId"]);
    const id = string(update["toolCallId"]);
    if (!id) return;
    const key = JSON.stringify([owner, id]);
    const tool = this.tools.get(key) ?? { owner, data: {}, status: "pending", shell: false };
    mergeToolData(tool.data, update);
    tool.status = toolStatus(update, tool.status);
    tool.shell = toolDetail(tool.data, this.quirks).kind === "shell";
    if (terminal.has(tool.status)) this.forget(key);
    else {
      this.tools.set(key, tool);
      if (holdsNextPrompt(this.promptOpen, owner === this.root, this.unsettled.has(key)))
        this.afterPrompt.add(key);
    }
  }
  knows(owner: string, id: string): boolean {
    return this.tools.has(JSON.stringify([owner, id]));
  }
  /** The person answered (or ace cancelled) the request for a tool: a refusal settles it, an allow starts it. */
  answered(owner: string, id: string, refused: boolean): void {
    const key = JSON.stringify([owner, id]);
    const tool = this.tools.get(key);
    if (!tool) return;
    if (refused) this.forget(key);
    else tool.status = "running";
  }
  promptStarted(): void {
    this.promptOpen = true;
  }
  /** `reason` is the prompt's stop reason, or "" when the prompt failed. */
  promptEnded(owner: string, reason: string): void {
    this.promptOpen = false;
    for (const [key, tool] of this.tools) {
      if (tool.owner !== owner && reason !== "cancelled") continue;
      if (tool.shell && shellSurvivesPrompt(this.quirks.provider, reason, tool.status))
        this.unsettled.add(key);
      else if (!this.unsettled.has(key)) this.tools.delete(key);
    }
  }
  forget(key: string): void {
    this.tools.delete(key);
    this.unsettled.delete(key);
    this.afterPrompt.delete(key);
  }
  /** A shell outlived its prompt with no proof it ended: new input is refused (ADR 0109). */
  get blocked(): boolean {
    return this.unsettled.size > 0;
  }
  /** Work the agent does after its prompt answered: new input waits for it, never refused. */
  get busy(): boolean {
    return this.afterPrompt.size > 0;
  }
}
