import type { Fact } from "@ace/core";
import type { ProviderAdapter } from "@ace/engine-api";

/** Hand-written synthetic provider for public replay tests, never a real CLI. */
export const createTranslator: ProviderAdapter["createTranslator"] = ({ rootKey }) => {
  let noticeDue: number | undefined;
  return {
    translate(frame, now) {
      switch (frame.data) {
        case "start":
          return [
            {
              type: "agent.seen",
              agent: rootKey,
              origin: "root",
              fidelity: "full",
              native: { provider: "codex", nativeId: rootKey },
              cwd: "/fixture",
            },
            { type: "turn.started", agent: rootKey, trigger: "user" },
          ];
        case "message":
          return [
            {
              type: "item.upsert",
              agent: rootKey,
              item: "message",
              draft: {
                type: "message",
                role: "assistant",
                parts: [{ type: "text", text: "hello" }],
                complete: false,
              },
            },
          ];
        case "delta":
          return [
            {
              type: "item.delta",
              agent: rootKey,
              item: "message",
              field: "text",
              append: String(now),
            },
          ];
        case "child":
          return [
            {
              type: "agent.seen",
              agent: "child",
              parent: rootKey,
              origin: "provider_subagent",
              fidelity: "summary",
              native: { provider: "codex", nativeId: "child" },
              cwd: "/fixture",
            },
            { type: "turn.started", agent: "child", trigger: "spawn" },
            { type: "turn.ended", agent: "child", outcome: "completed" },
          ];
        case "approval":
          return [
            {
              type: "interaction.opened",
              agent: rootKey,
              interaction: "approval",
              blocking: true,
              request: {
                kind: "approval",
                title: "Allow?",
                options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
              },
            },
          ];
        case "resolve":
          return [
            {
              type: "interaction.closed",
              interaction: "approval",
              state: "resolved",
              resolution: { kind: "approval", optionId: "yes" },
            },
          ];
        case "finish":
          noticeDue = now + 10;
          return [
            {
              type: "item.upsert",
              agent: rootKey,
              item: "message",
              draft: { type: "message", complete: true },
            },
            { type: "turn.ended", agent: rootKey, outcome: "completed" },
            { type: "wake.expected", agent: rootKey, until: now + 20 },
          ];
        case "question":
          return [
            {
              type: "interaction.opened",
              agent: rootKey,
              interaction: "question",
              blocking: false,
              request: { kind: "question", questions: [] },
            },
          ];
        case "exit":
          return [{ type: "process.exited", deliberate: true }];
        default:
          return [];
      }
    },
    tick(now): Fact[] {
      if (noticeDue === undefined || now < noticeDue) return [];
      noticeDue = undefined;
      return [
        {
          type: "item.upsert",
          agent: rootKey,
          item: "notice",
          draft: { type: "notice", level: "info", text: `timer at ${now}`, complete: true },
        },
      ];
    },
  };
};

export const capabilities = {
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
} as const;
