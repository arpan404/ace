import { query, type CanUseTool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { interruptOnce, probe } from "../process.ts";
import type { Scenario } from "../scenarios.ts";
import type { Driver, RunContext } from "./types.ts";

type Question = { question: string; options?: Array<{ label: string }> };

function decide(
  toolName: string,
  input: Record<string, unknown>,
  scenario: Scenario,
): Awaited<ReturnType<CanUseTool>> {
  if (toolName === "AskUserQuestion") {
    const questions = (input["questions"] ?? []) as Question[];
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = q.options?.[0]?.label ?? "Tabs";
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  if (toolName === "ExitPlanMode" && scenario.planDecision === "reject") {
    return { behavior: "deny", message: "Plan recorded. Do not implement it." };
  }
  return { behavior: "allow", updatedInput: input };
}

/** Keeps the input stream open after the first prompt so background results can arrive. */
async function* singlePrompt(text: string, signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const claude: Driver = {
  id: "claude",
  async version() {
    const out = await probe("claude", ["--version"]);
    return out.split(/\s+/)[0] ?? out;
  },
  async run(ctx: RunContext) {
    const { rec, scenario, workspace } = ctx;
    const executable = await probe("which", ["claude"]);
    const done = new AbortController();

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const { signal: _signal, ...meta } = options;
      rec.frame("recv", "can_use_tool", { toolName, input, options: meta });
      ctx.interactions.open();
      try {
        const result = decide(toolName, input, scenario);
        rec.frame("send", "can_use_tool", { requestId: options.requestId, result });
        return result;
      } finally {
        ctx.interactions.close();
      }
    };

    const q = query({
      prompt: singlePrompt(scenario.prompt, done.signal),
      options: {
        cwd: workspace,
        ...(ctx.model ? { model: ctx.model } : {}),
        pathToClaudeCodeExecutable: executable,
        permissionMode: scenario.planMode ? "plan" : "default",
        settingSources: [],
        includePartialMessages: true,
        includeHookEvents: true,
        forwardSubagentText: true,
        perTaskStopAffordance: true,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "ace-recorder/0.0.0" },
        stderr: (data: string) => rec.frame("stderr", "sdk", data, false),
        canUseTool,
      },
    });

    const triggerInterrupt = interruptOnce(scenario.interruptAfterToolStartMs, () => {
      rec.note("interrupt-sent");
      q.interrupt().then(
        (result) => rec.note("interrupt-result", result),
        (error: unknown) => rec.note("interrupt-error", String(error)),
      );
    });

    const pump = (async () => {
      for await (const message of q) {
        const type = (message as { type: string }).type;
        rec.frame("recv", "sdk", message, type !== "keep_alive");
        if (type === "result") rec.mark("turn-end");
        if (type === "assistant" && message.type === "assistant") {
          const blocks = message.message.content as Array<{ type: string; name?: string }>;
          const bash = blocks.some((b) => b.type === "tool_use" && b.name === "Bash");
          if (bash && message.parent_tool_use_id === null) triggerInterrupt();
        }
      }
    })();

    try {
      await Promise.race([ctx.settled(), pump]);
    } finally {
      done.abort();
      q.close();
      await pump.catch((error: unknown) => rec.note("stream-error", String(error)));
    }
  },
};
