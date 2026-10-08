import type { RegistryAgent } from "@ace/protocol";

/*
 * The official ACP registry as the fake daemon's Mac (darwin-aarch64) reads it: sixteen entries
 * from the real index, three of them not installable here (a format ace can't unpack, two
 * without a build for this platform). Gemini CLI is installed, one release behind.
 */

const cdn = "https://cdn.agentclientprotocol.com/registry/v1/latest";

/** How the fake plans an entry: the package it pins, or the archive and entrypoint it unpacks. */
export interface FakeDistribution {
  npm?: string;
  uv?: string;
  binary?: { archive: string; cmd: string; args?: string[]; sha256: boolean };
}

export interface FakeRegistryEntry {
  agent: RegistryAgent;
  distribution: FakeDistribution;
  /** Bytes a binary download takes, for progress. */
  size?: number;
}

function entry(
  id: string,
  fields: Pick<RegistryAgent, "name" | "version" | "description" | "authors"> &
    Partial<Pick<RegistryAgent, "availability" | "homepage" | "license" | "coverage">> & {
      loginHint?: string;
      icon?: false;
    },
  distribution: FakeDistribution,
  size?: number,
): FakeRegistryEntry {
  const available = fields.availability ?? "available";
  const runtimes: NonNullable<RegistryAgent["runtimes"]> =
    available === "available"
      ? [
          ...(distribution.binary ? (["binary"] as const) : []),
          ...(distribution.npm ? (["npm"] as const) : []),
          ...(distribution.uv ? (["uv"] as const) : []),
        ]
      : [];
  return {
    agent: {
      acpAgentId: `official:${id}`,
      name: fields.name,
      version: fields.version,
      description: fields.description,
      source: `${cdn}/registry.json`,
      authors: fields.authors,
      availability: available,
      coverage: fields.coverage ?? "generic",
      auth: "unknown",
      loginHint: fields.loginHint ?? "Use the agent CLI's own login or configuration command",
      visibility: "limited",
      isolation: "unsupported",
      runtimes,
      ...(fields.icon === false ? {} : { icon: `${cdn}/${id}.svg` }),
      ...(fields.homepage ? { homepage: fields.homepage } : {}),
      ...(fields.license ? { license: fields.license } : {}),
    },
    distribution,
    ...(size ? { size } : {}),
  };
}

const release = (repo: string, tag: string, file: string) =>
  `https://github.com/${repo}/releases/download/${tag}/${file}`;

export function registryFixture(): FakeRegistryEntry[] {
  return [
    entry(
      "amp-acp",
      {
        name: "Amp",
        version: "0.9.0",
        description: "ACP wrapper for Amp - the frontier coding agent",
        authors: ["tao12345666333"],
        license: "Apache-2.0",
        homepage: "https://github.com/tao12345666333/amp-acp",
      },
      {
        binary: {
          archive: release("tao12345666333/amp-acp", "v0.9.0", "amp-acp-darwin-aarch64.tar.gz"),
          cmd: "./amp-acp",
          sha256: true,
        },
      },
      18_400_000,
    ),
    entry(
      "auggie",
      {
        name: "Auggie CLI",
        version: "0.36.0",
        description:
          "Augment Code's powerful software agent, backed by industry-leading context engine",
        authors: ["Augment Code <support@augmentcode.com>"],
        license: "proprietary",
        homepage: "https://www.augmentcode.com/",
        coverage: "source_profile",
        loginHint: "auggie login",
      },
      { npm: "@augmentcode/auggie@0.36.0" },
    ),
    entry(
      "claude-acp",
      {
        name: "Claude Agent",
        version: "0.87.0",
        description: "ACP wrapper for Anthropic's Claude",
        authors: ["Anthropic", "Zed Industries", "JetBrains"],
        license: "proprietary",
        homepage: "https://github.com/agentclientprotocol/claude-agent-acp",
        loginHint: "claude, then /login",
      },
      { npm: "@agentclientprotocol/claude-agent-acp@0.87.0" },
    ),
    entry(
      "cline",
      {
        name: "Cline",
        version: "3.0.69",
        description:
          "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
        authors: ["Cline Bot Inc."],
        license: "Apache-2.0",
        homepage: "https://cline.bot/cli",
      },
      { npm: "cline@3.0.69" },
    ),
    entry(
      "codex-acp",
      {
        name: "Codex",
        version: "2.1.1",
        description: "ACP adapter for OpenAI's coding assistant",
        authors: ["OpenAI", "JetBrains s.r.o", "Zed Industries"],
        license: "Apache-2.0",
        homepage: "https://github.com/agentclientprotocol/codex-acp",
        coverage: "source_profile",
        loginHint: "codex login",
      },
      { npm: "@agentclientprotocol/codex-acp@2.1.1" },
    ),
    entry(
      "factory-droid",
      {
        name: "Factory Droid",
        version: "0.235.0",
        description: "Factory Droid - AI coding agent powered by Factory AI",
        authors: ["Factory AI"],
        license: "proprietary",
        homepage: "https://factory.ai/product/cli",
      },
      { npm: "droid@0.235.0" },
    ),
    entry(
      "fast-agent",
      {
        name: "fast-agent",
        version: "0.10.1",
        description: "Code and build agents with comprehensive multi-provider support",
        authors: ["enquiries@fast-agent.ai"],
        license: "Apache 2.0",
        homepage: "https://fast-agent.ai",
        icon: false,
      },
      { uv: "fast-agent-acp==0.10.1" },
    ),
    entry(
      "gemini",
      {
        name: "Gemini CLI",
        version: "0.63.0",
        description: "Google's official CLI for Gemini",
        authors: ["Google"],
        license: "Apache-2.0",
        homepage: "https://geminicli.com",
        loginHint: "gemini",
      },
      { npm: "@google/gemini-cli@0.63.0" },
    ),
    entry(
      "github-copilot-cli",
      {
        name: "GitHub Copilot",
        version: "1.0.93",
        description: "GitHub's AI pair programmer",
        authors: ["GitHub"],
        license: "proprietary",
        homepage: "https://github.com/features/copilot/cli/",
      },
      { npm: "@github/copilot@1.0.93" },
    ),
    entry(
      "goose",
      {
        name: "goose",
        version: "1.53.0",
        description: "A local, extensible, open source AI agent that automates engineering tasks",
        authors: ["Block"],
        license: "Apache-2.0",
        homepage: "https://block.github.io/goose/",
        availability: "unsupported_distribution",
      },
      {
        binary: {
          archive: release("block/goose", "v1.53.0", "goose-aarch64-apple-darwin.tar.bz2"),
          cmd: "./goose",
          args: ["acp"],
          sha256: true,
        },
      },
    ),
    entry(
      "harn",
      {
        name: "Harn",
        version: "0.10.157",
        description: "Harn runs .harn agent pipelines as a native ACP coding agent over stdio.",
        authors: ["Burin Labs"],
        license: "Apache-2.0",
        homepage: "https://harnlang.com",
        availability: "unsupported_target",
        icon: false,
      },
      {},
    ),
    entry(
      "kimi",
      {
        name: "Kimi CLI",
        version: "1.52.0",
        description: "Moonshot AI's coding assistant",
        authors: ["Moonshot AI"],
        license: "MIT",
        homepage: "https://moonshotai.github.io/kimi-cli/",
      },
      {
        binary: {
          archive: release(
            "MoonshotAI/kimi-cli",
            "1.52.0",
            "kimi-1.52.0-aarch64-apple-darwin.tar.gz",
          ),
          cmd: "./kimi",
          args: ["acp"],
          sha256: true,
        },
      },
      41_800_000,
    ),
    entry(
      "mistral-vibe",
      {
        name: "Mistral Vibe",
        version: "2.26.0",
        description: "Mistral's open-source coding assistant",
        authors: ["Mistral AI"],
        license: "Apache-2.0",
        homepage: "https://mistral.ai/products/vibe",
      },
      {
        binary: {
          archive: release(
            "mistralai/mistral-vibe",
            "v2.26.0",
            "vibe-acp-darwin-aarch64-2.26.0.tar.gz",
          ),
          cmd: "./vibe-acp",
          sha256: true,
        },
      },
      27_300_000,
    ),
    entry(
      "opencode",
      {
        name: "OpenCode",
        version: "1.18.35",
        description: "The open source coding agent",
        authors: ["Anomaly"],
        license: "MIT",
        homepage: "https://opencode.ai",
      },
      {
        binary: {
          archive: release("anomalyco/opencode", "v1.18.35", "opencode-darwin-arm64.zip"),
          cmd: "./opencode",
          args: ["acp"],
          sha256: true,
        },
      },
      52_600_000,
    ),
    entry(
      "poolside",
      {
        name: "Poolside",
        version: "1.0.16",
        description: "Poolside's coding agent",
        authors: ["Poolside <feedback@poolside.ai>"],
        license: "proprietary",
        homepage: "https://poolside.ai",
        availability: "unsupported_target",
      },
      {},
    ),
    entry(
      "qwen-code",
      {
        name: "Qwen Code",
        version: "0.25.0",
        description: "Alibaba's Qwen coding assistant",
        authors: ["Alibaba Qwen Team"],
        license: "Apache-2.0",
        homepage: "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
        loginHint: "qwen: configure a CLI-owned provider",
      },
      { npm: "@qwen-code/qwen-code@0.25.0" },
    ),
  ];
}
