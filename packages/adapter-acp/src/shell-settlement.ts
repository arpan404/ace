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
/** Pure native settlement, indexed by live tools rather than prior notifications. */
export class ShellSettlement {
  readonly quirks: AcpQuirks;
  readonly tools = new Map<string, NativeTool>();
  readonly unsettled = new Set<string>();
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
    if (["succeeded", "failed", "cancelled", "declined"].includes(tool.status)) {
      this.tools.delete(key);
      this.unsettled.delete(key);
    } else this.tools.set(key, tool);
  }
  promptEnded(owner: string, reason: string): void {
    for (const [key, tool] of this.tools) {
      if (tool.owner !== owner && reason !== "cancelled") continue;
      if (tool.shell && shellSurvivesPrompt(this.quirks.provider, reason)) this.unsettled.add(key);
      else if (!this.unsettled.has(key)) this.tools.delete(key);
    }
  }
  get blocked(): boolean {
    return this.unsettled.size > 0;
  }
}
