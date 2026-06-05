import { describe, expect, it } from "vitest";

import {
  providerCommandDisplayBadges,
  providerCommandDisplayDescription,
  providerCommandDisplayItemMatchesQuery,
  providerCommandDisplaySearchText,
} from "./providerCommandDisplay";

describe("provider command display", () => {
  it("summarizes provider command metadata as compact badges", () => {
    expect(
      providerCommandDisplayBadges({
        name: "claude-project",
        metadata: {
          model: "sonnet",
          allowedTools: ["Read", "Grep"],
          disableModelInvocation: true,
        },
      }),
    ).toEqual(["sonnet", "2 tools", "no model"]);
  });

  it("includes arguments and metadata in searchable text", () => {
    expect(
      providerCommandDisplaySearchText({
        name: "claude-project",
        metadata: {
          model: "sonnet",
          allowedTools: ["Read"],
          arguments: ["target", "format"],
          context: "fork",
          agent: "Explore",
          hooks: {
            SkillStart: [{ type: "command" }],
          },
        },
      }),
    ).toBe("sonnet read target format fork explore skillstart");
    expect(
      providerCommandDisplayBadges({
        name: "claude-project",
        metadata: {
          model: "sonnet",
          allowedTools: ["Read"],
          context: "fork",
          agent: "Explore",
          hooks: {
            SkillStart: [{ type: "command" }],
          },
        },
      }),
    ).toEqual(["sonnet", "Read", "fork"]);
  });

  it("includes modern Claude subagent metadata in command search", () => {
    const command = {
      name: "safe-researcher",
      metadata: {
        provider: "claude",
        source: "agent",
        model: "claude-haiku-4-5",
        tools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Write", "Edit"],
        permissionMode: "plan",
        mcpServers: {
          docs: { command: "docs-mcp" },
        },
        maxTurns: 8,
        skills: ["repo-map"],
        initialPrompt: "Summarize the active repository context.",
        effort: "high",
        background: true,
        isolation: "worktree",
        color: "teal",
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "claude-haiku-4-5 read grep glob write edit plan claude teal repo-map initial prompt initial message background async asynchronous worktree 8 docs command docs-mcp high",
    );
    expect(providerCommandDisplayBadges(command)).toEqual([
      "claude-haiku-4-5",
      "3 tools",
      "blocks 2",
    ]);
  });

  it("searches nested MCP server and hook metadata without expanding compact badges", () => {
    const command = {
      name: "hooked-agent",
      metadata: {
        mcpServers: {
          docs: {
            command: "docs-mcp",
            args: ["--stdio"],
          },
          repo: {
            command: "repo-mcp",
          },
        },
        hooks: {
          SkillStart: [
            {
              type: "command",
              command: "./scripts/skill-start.sh",
            },
          ],
        },
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "docs command docs-mcp args --stdio repo command repo-mcp skillstart command ./scripts/skill-start.sh",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["2 MCPs", "SkillStart"]);
  });

  it("matches composer command items by description and metadata badges", () => {
    const item = {
      command: "claude-project",
      label: "Claude Project",
      description: "Skill - [target] [format]",
      metadataBadges: ["sonnet", "2 tools"],
    };

    expect(providerCommandDisplayItemMatchesQuery(item, "sonnet")).toBe(true);
    expect(providerCommandDisplayItemMatchesQuery(item, "target")).toBe(true);
    expect(providerCommandDisplayItemMatchesQuery(item, "claude")).toBe(true);
    expect(providerCommandDisplayItemMatchesQuery(item, "missing")).toBe(false);
  });

  it("matches composer command items by hidden metadata search text", () => {
    const item = {
      command: "release-manager",
      label: "Release Manager",
      description: "Agent - <prompt>",
      metadataBadges: ["2 models", "2 tools", "2 skills"],
      metadataSearchText:
        "claude opus 4.5 gpt-5.2 read_file grep github-copilot release-review implement release plan custom-mcp",
    };

    expect(providerCommandDisplayItemMatchesQuery(item, "custom-mcp")).toBe(true);
    expect(providerCommandDisplayItemMatchesQuery(item, "implement release")).toBe(true);
    expect(providerCommandDisplayItemMatchesQuery(item, "unknown server")).toBe(false);
  });

  it("handles provider command metadata aliases", () => {
    const command = {
      name: "root-meta",
      metadata: {
        model_id: "pi-root-model",
        tools: ["Read", "Bash"],
        args: ["subject"],
        noModel: true,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe("pi-root-model read bash subject");
    expect(providerCommandDisplayBadges(command)).toEqual(["pi-root-model", "2 tools", "no model"]);
  });

  it("handles object tool metadata and JSON schema arguments", () => {
    const command = {
      name: "schema-meta",
      metadata: {
        model: "sonnet",
        tools: [{ name: "Read" }, { id: "Grep" }],
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            format: { type: "string" },
          },
          required: ["target"],
        },
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe("sonnet read grep target format");
    expect(providerCommandDisplayBadges(command)).toEqual(["sonnet", "2 tools", "args"]);
  });

  it("handles list and object model metadata", () => {
    const command = {
      name: "multi-model-agent",
      metadata: {
        model: ["Claude Opus 4.5", { id: "GPT-5.2" }],
        tools: ["Read"],
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe("claude opus 4.5 gpt-5.2 read");
    expect(providerCommandDisplayBadges(command)).toEqual(["2 models", "Read"]);
  });

  it("includes provider agent metadata in search and compact badges", () => {
    const command = {
      name: "opencode-reviewer",
      metadata: {
        provider: "opencode",
        source: "agent",
        mode: "subagent",
        model: "opencode/gpt-5.1-codex",
        color: "accent",
        permission: {
          read: "allow",
          bash: {
            "git *": "ask",
            "rm *": "deny",
          },
          skill: {
            "docs-*": "allow",
          },
          task: {
            "*": "deny",
            reviewer: "allow",
          },
        },
        taskPermission: {
          "*": "deny",
          reviewer: "allow",
        },
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "opencode/gpt-5.1-codex subagent opencode accent read allow bash git * ask rm * deny skill docs-* allow task * deny reviewer allow",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["opencode/gpt-5.1-codex", "subagent"]);
  });

  it("includes OpenCode command agent and subtask metadata in search and badges", () => {
    const command = {
      name: "review-fast",
      metadata: {
        provider: "opencode",
        source: "command",
        agent: "review",
        subtask: true,
        model: "opencode/gpt-5.1-codex",
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "opencode/gpt-5.1-codex opencode review subtask side chat side conversation",
    );
    expect(providerCommandDisplayBadges(command)).toEqual([
      "opencode/gpt-5.1-codex",
      "review",
      "subtask",
    ]);
  });

  it("includes provider skills, handoffs, and MCP servers in command search", () => {
    const command = {
      name: "release-manager",
      metadata: {
        provider: "github-copilot",
        source: "agent",
        model: ["Claude Opus 4.5", "GPT-5.2"],
        tools: ["read_file", "grep"],
        skills: ["release-review", "migration-audit"],
        annotations: {
          team: "Release Engineering",
          workflow: "release-readiness",
        },
        handoffs: [{ label: "Implement Release Plan", agent: "agent" }],
        mcpServers: {
          "custom-mcp": {
            type: "local",
            command: "some-command",
          },
        },
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "claude opus 4.5 gpt-5.2 read_file grep github-copilot release-review migration-audit team release engineering workflow release-readiness implement release plan custom-mcp command some-command",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["2 models", "2 tools", "2 skills"]);
  });

  it("shows provider delegation aliases as compact badges", () => {
    expect(
      providerCommandDisplayBadges({
        name: "handoff-agent",
        metadata: {
          provider: "github-copilot",
          source: "agent",
          handoffs: [{ label: "Implement Release Plan", agent: "agent" }],
        },
      }),
    ).toEqual(["Implement Release Plan"]);
    expect(
      providerCommandDisplayBadges({
        name: "multi-agent",
        metadata: {
          agentNames: ["reviewer", "implementer"],
        },
      }),
    ).toEqual(["2 agents"]);
  });

  it("includes Copilot prompt-file agent, model, and tools in command search", () => {
    const command = {
      name: "release-ready",
      metadata: {
        provider: "github-copilot",
        source: "prompt",
        agent: "plan",
        model: "GPT-5.2",
        tools: ["search/codebase"],
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "gpt-5.2 search/codebase github-copilot plan",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["GPT-5.2", "search/codebase", "plan"]);
  });

  it("includes Copilot skill metadata in command search and badges", () => {
    const command = {
      name: "docs-visible",
      metadata: {
        provider: "github-copilot",
        source: "skill",
        arguments: ["topic"],
        tools: ["search", "read_file"],
        model: "GPT-5.2",
        annotations: {
          team: "Docs",
        },
        disableModelInvocation: true,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "gpt-5.2 search read_file topic github-copilot team docs manual invocation no automatic invocation",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["GPT-5.2", "2 tools", "manual"]);
  });

  it("includes Copilot custom agent target metadata in command search and badges", () => {
    const command = {
      name: "vscode-only",
      metadata: {
        provider: "github-copilot",
        source: "agent",
        infer: false,
        userInvocable: true,
        disableModelInvocation: true,
        target: ["vscode"],
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "github-copilot manual invocation no automatic invocation user invocable picker selectable vscode",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["manual", "vscode"]);
  });

  it("includes remote-agent auth metadata in command search and badges", () => {
    const command = {
      name: "remote-auth",
      metadata: {
        provider: "gemini",
        source: "remote-agent",
        kind: "remote",
        agentCardUrl: "https://example.com/remote-auth/.well-known/agent.json",
        authType: "oauth2",
        auth: {
          type: "oauth2",
          scheme: "bearer",
          scopes: ["repo:read"],
        },
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "gemini remote https://example.com/remote-auth/.well-known/agent.json oauth2 scheme bearer scopes repo:read",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["remote", "oauth2 auth"]);
  });

  it("includes Gemini local agent execution metadata in command search and badges", () => {
    const command = {
      name: "security-auditor",
      metadata: {
        provider: "gemini",
        source: "agent",
        kind: "local",
        model: "gemini-3-flash-preview",
        tools: ["read_file", "grep_search"],
        temperature: 0.2,
        maxTurns: 10,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "gemini-3-flash-preview read_file grep_search gemini local 10 0.2",
    );
    expect(providerCommandDisplayBadges(command)).toEqual([
      "gemini-3-flash-preview",
      "2 tools",
      "local",
    ]);
  });

  it("includes Gemini dynamic command metadata in command search and badges", () => {
    const command = {
      name: "context",
      metadata: {
        provider: "gemini",
        source: "command",
        arguments: ["args"],
        shellInjection: true,
        fileInjection: true,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "args gemini shell command injection dynamic command file injection context injection dynamic command",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["[args]", "shell", "files"]);
  });

  it("includes Cursor rule globs and always-applied state in command search", () => {
    const command = {
      name: "rule:component",
      metadata: {
        provider: "cursor",
        source: "rule",
        globs: ["**/*.tsx", "apps/web/**"],
        alwaysApply: true,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "cursor **/*.tsx apps/web/** always apply always-on",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["always"]);
  });

  it("includes Cursor subagent model and execution metadata in command search", () => {
    const command = {
      name: "background-verifier",
      metadata: {
        provider: "cursor",
        source: "agent",
        model: "inherit",
        readOnly: true,
        isBackground: true,
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "inherit cursor read only read-only background async asynchronous",
    );
    expect(providerCommandDisplayBadges(command)).toEqual(["inherit", "read-only", "background"]);
  });

  it("includes Pi agent package and thinking metadata in command search", () => {
    const command = {
      name: "code-analysis.scout",
      metadata: {
        provider: "pi",
        source: "agent",
        package: "code-analysis",
        model: "openai/gpt-5.4-mini",
        tools: ["read_file", "grep"],
        agents: ["reviewer", "worker"],
        thinking: "high",
      },
    };

    expect(providerCommandDisplaySearchText(command)).toBe(
      "openai/gpt-5.4-mini read_file grep pi reviewer worker code-analysis high",
    );
    expect(providerCommandDisplayBadges(command)).toEqual([
      "openai/gpt-5.4-mini",
      "2 tools",
      "high",
    ]);
  });

  it("uses the command kind as the default description noun", () => {
    expect(providerCommandDisplayDescription({ name: "frontend-design" }, "skill")).toBe("Skill");
    expect(
      providerCommandDisplayDescription(
        { name: "frontend-design", inputHint: "[target]" },
        "skill",
      ),
    ).toBe("Skill - [target]");
  });
});
