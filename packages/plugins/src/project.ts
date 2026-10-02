import { codexAgent, codexCommand } from "./codex-components.ts";
import { isAbsolute, join } from "node:path";
import { PluginInstall } from "@ace/protocol/plugins";
import { PluginManifest, normalizePath, limits } from "./manifest.ts";
import { agentPluginSchema } from "./import.ts";
import {
  body,
  claudeEvents,
  codexEvents,
  expandRoot,
  nativeHooks,
  outputFile,
  override,
  payloadFiles,
  skillFiles,
  textFile,
} from "./project-shared.ts";
import type { McpServer } from "./manifest.ts";
import type { PluginProjection, PluginSnapshot, Provider } from "./types.ts";

function resolveServer(server: McpServer, root: string): Record<string, unknown> {
  if (server.type !== "stdio") return server;
  let command = expandRoot(server.command, root);
  if (command.startsWith("./")) command = join(root, normalizePath(command));
  return {
    type: "stdio",
    command,
    args: server.args.map((arg) => expandRoot(arg, root)),
    env: Object.fromEntries(
      Object.entries(server.env).map(([key, value]) => [key, expandRoot(value, root)]),
    ),
    ...(server.cwd === undefined
      ? {}
      : {
          cwd:
            server.cwd === "." || server.cwd === "./"
              ? root
              : server.cwd.startsWith("${")
                ? expandRoot(server.cwd, root)
                : join(root, normalizePath(server.cwd)),
        }),
  };
}
const cursorEvents = new Set([
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "workspaceOpen",
]);
const cursorMapping: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  Stop: "stop",
  PreCompact: "preCompact",
  UserPromptSubmit: "beforeSubmitPrompt",
};

/** Session startup projection, with no filesystem access and no provider execution. */
export function projectPlugins(
  provider: Provider,
  installed: readonly PluginSnapshot[],
  options: { root: string },
): PluginProjection {
  if (!isAbsolute(options.root)) throw new Error("Projection root must be absolute");
  if (installed.length > limits.installs) throw new Error("Plugin count limit");
  const projection: PluginProjection = {
    env: {},
    args: [],
    files: [],
    sessionConfig: {},
    unsupported: [],
  };
  const mcp: Record<string, Record<string, unknown>> = Object.create(null);
  const commands: Record<string, unknown> = Object.create(null);
  const agents: Record<string, unknown> = Object.create(null);
  const rules: string[] = [];
  const rulePaths: string[] = [];
  const skillRoots: string[] = [];
  const plugins: {
    name: string;
    source: { source: string; path: string };
    policy: { installation: string; authentication: string };
    category: string;
  }[] = [];
  const names = new Set<string>();
  let bytes = 0;
  let selectedFiles = 0;
  for (const plugin of installed) {
    PluginInstall.parse(plugin.install);
    PluginManifest.parse(plugin.manifest);
    if (
      plugin.install.name !== plugin.manifest.name ||
      plugin.install.version !== plugin.manifest.version
    )
      throw new Error("Install identity mismatch");
    const name = plugin.manifest.name;
    if (names.has(name)) throw new Error("Duplicate installed plugin");
    names.add(name);
    selectedFiles += plugin.files.length;
    if (selectedFiles > limits.files) throw new Error("Selected plugins exceed file limit");
    for (const file of plugin.files) {
      normalizePath(file.path);
      bytes += file.bytes;
    }
    if (bytes > limits.total || plugin.files.length > limits.files)
      throw new Error("Projection byte limit");
    projection.unsupported.push(...plugin.unsupported.map((reason) => `${name}: ${reason}`));
    const base = `generated/plugins/${name}`;
    const payloadRoot = join(options.root, base, "payload");
    const isAcp = provider === "acp" || provider === "antigravity";
    projection.files.push(...payloadFiles(plugin, base));
    if (!isAcp) {
      projection.files.push(...skillFiles(plugin, base, payloadRoot));
      skillRoots.push(join(options.root, base, "skills"));
    }
    for (const [serverName, server] of Object.entries(plugin.manifest.mcpServers)) {
      const key = `ace-${name}__${serverName}`;
      if (mcp[key]) throw new Error("MCP namespace collision");
      mcp[key] = resolveServer(server, payloadRoot);
    }
    for (const skill of isAcp ? plugin.manifest.skills : [])
      projection.unsupported.push(`${name}: ${provider} cannot inject skill ${skill.name}`);
    const skillNames = new Set(plugin.manifest.skills.map((skill) => skill.name));
    for (const entry of plugin.manifest.commands) {
      const content = expandRoot(textFile(plugin, entry.path), payloadRoot);
      if (provider === "claude" || provider === "cursor")
        projection.files.push(outputFile(`${base}/commands/${entry.name}.md`, content));
      else if (provider === "codex")
        codexCommand(
          name,
          entry.name,
          content,
          entry.description ?? entry.name,
          base,
          skillNames,
          projection,
        );
      else if (provider === "opencode")
        commands[`ace-${name}__${entry.name}`] = {
          template: body(content),
          description: entry.description ?? entry.name,
        };
      else
        projection.unsupported.push(
          `${name}: ${provider} cannot inject slash command ${entry.name}`,
        );
    }
    for (const entry of plugin.manifest.agents) {
      const content = expandRoot(textFile(plugin, entry.path), payloadRoot);
      if (provider === "claude" || provider === "cursor")
        projection.files.push(outputFile(`${base}/agents/${entry.name}.md`, content));
      else if (provider === "codex")
        codexAgent(
          name,
          entry.name,
          content,
          entry.description ?? entry.name,
          base,
          options.root,
          projection,
        );
      else if (provider === "opencode")
        agents[`ace-${name}__${entry.name}`] = {
          prompt: body(content),
          description: entry.description ?? entry.name,
          mode: "subagent",
        };
      else projection.unsupported.push(`${name}: ${provider} cannot inject agent ${entry.name}`);
    }
    for (const entry of plugin.manifest.rules) {
      const original = expandRoot(textFile(plugin, entry.path), payloadRoot);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original);
      const conditional =
        frontmatter !== null &&
        (/^\s*globs\s*:/m.test(frontmatter[1] ?? "") ||
          !/^alwaysApply:\s*true\s*$/m.test(frontmatter[1] ?? ""));
      if (provider !== "cursor" && conditional) {
        projection.unsupported.push(
          `${name}: ${provider} cannot preserve conditional rule ${entry.name}`,
        );
        continue;
      }
      const content = body(original);
      const path = `${base}/rules/${entry.name}.md`;
      if (isAcp)
        projection.unsupported.push(`${name}: ${provider} cannot inject rule ${entry.name}`);
      else if (provider === "cursor")
        projection.files.push(
          outputFile(
            `${base}/rules/${entry.name}.mdc`,
            frontmatter
              ? original
              : `---\ndescription: ${JSON.stringify(entry.description ?? entry.name)}\nalwaysApply: true\n---\n${content}`,
          ),
        );
      else {
        projection.files.push(outputFile(path, content));
        rulePaths.push(join(options.root, path));
        rules.push(content);
      }
    }
    if (provider === "claude") {
      projection.files.push(
        outputFile(
          `${base}/.claude-plugin/plugin.json`,
          JSON.stringify({ name, version: plugin.manifest.version }),
        ),
      );
      const native = nativeHooks(plugin, "${CLAUDE_PLUGIN_ROOT}/payload", claudeEvents, projection);
      projection.files.push(
        outputFile(`${base}/hooks/hooks.json`, JSON.stringify({ hooks: native })),
      );
      projection.args.push("--plugin-dir", join(options.root, base));
    } else if (provider === "cursor") {
      const native: Record<string, unknown[]> = Object.create(null);
      for (const hook of plugin.manifest.hooks) {
        const event = cursorMapping[hook.event] ?? hook.event;
        if (!cursorEvents.has(event)) {
          projection.unsupported.push(`${name}: unsupported hook ${hook.event}`);
          continue;
        }
        (native[event] ??= []).push({
          command: expandRoot(hook.command, "${CURSOR_PLUGIN_ROOT}/payload"),
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
        });
      }
      projection.files.push(
        outputFile(
          `${base}/.cursor-plugin/plugin.json`,
          JSON.stringify({ name, version: plugin.manifest.version }),
        ),
      );
      projection.files.push(
        outputFile(`${base}/hooks/hooks.json`, JSON.stringify({ hooks: native })),
      );
      const servers = Object.fromEntries(
        Object.entries(plugin.manifest.mcpServers).map(([key, server]) => [
          `ace-${name}__${key}`,
          resolveServer(server, payloadRoot),
        ]),
      );
      projection.files.push(
        outputFile(`${base}/mcp.json`, JSON.stringify({ mcpServers: servers })),
      );
      projection.args.push("--plugin-dir", join(options.root, base));
    } else if (provider === "codex") {
      projection.files.push(
        outputFile(
          `${base}/plugin.json`,
          JSON.stringify({ $schema: agentPluginSchema, name, version: plugin.manifest.version }),
        ),
      );
      plugins.push({
        name,
        source: { source: "local", path: `./plugins/${name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      });
      projection.files.push(
        outputFile(
          `${base}/hooks/hooks.json`,
          JSON.stringify({
            hooks: nativeHooks(plugin, "${PLUGIN_ROOT}/payload", codexEvents, projection),
          }),
        ),
      );
      override(projection, `plugins.${JSON.stringify(`${name}@ace`)}.enabled`, true);
    } else
      for (const hook of plugin.manifest.hooks)
        projection.unsupported.push(`${name}: ${provider} cannot inject hook ${hook.event}`);
  }
  if (provider === "claude") {
    if (Object.keys(mcp).length) {
      projection.files.push(outputFile("generated/mcp.json", JSON.stringify({ mcpServers: mcp })));
      projection.args.push("--mcp-config", join(options.root, "generated/mcp.json"));
    }
    if (rules.length) {
      projection.files.push(outputFile("generated/instructions.md", rules.join("\n\n")));
      projection.args.push(
        "--append-system-prompt-file",
        join(options.root, "generated/instructions.md"),
      );
    }
  } else if (provider === "codex") {
    if (plugins.length) {
      projection.files.push(
        outputFile(
          "generated/.agents/plugins/marketplace.json",
          JSON.stringify({ name: "ace", plugins }),
        ),
      );
      override(projection, "marketplaces.ace.source_type", "local");
      override(projection, "marketplaces.ace.source", join(options.root, "generated"));
    }
    for (const [key, server] of Object.entries(mcp)) {
      if (server.type === "sse") {
        projection.unsupported.push(`${key}: Codex does not support SSE MCP`);
        continue;
      }
      const { type: _type, headers, ...config } = server;
      override(projection, `mcp_servers.${JSON.stringify(key)}`, {
        ...config,
        ...(headers ? { http_headers: headers } : {}),
      });
    }
    if (rules.length) override(projection, "developer_instructions", rules.join("\n\n"));
  } else if (provider === "opencode") {
    const servers: Record<string, unknown> = Object.create(null);
    for (const [key, server] of Object.entries(mcp)) {
      if (server.type === "stdio") {
        if (server.cwd) {
          projection.unsupported.push(`${key}: OpenCode cannot inject MCP cwd`);
          continue;
        }
        servers[key] = {
          type: "local",
          command: [server.command, ...(Array.isArray(server.args) ? server.args : [])],
          environment: server.env,
          enabled: true,
        };
      } else
        servers[key] = { type: "remote", url: server.url, headers: server.headers, enabled: true };
    }
    projection.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      skills: { paths: skillRoots },
      mcp: servers,
      command: commands,
      agent: agents,
      instructions: rulePaths,
    });
  } else if (provider === "acp" || provider === "antigravity") {
    projection.sessionConfig.mcpServers = [];
    for (const [name, server] of Object.entries(mcp)) {
      if (server.cwd) {
        projection.unsupported.push(`${name}: ACP cannot inject MCP cwd`);
        continue;
      }
      if (server.type === "stdio")
        projection.sessionConfig.mcpServers.push({
          name,
          command: server.command,
          args: server.args,
          env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
        });
      else
        projection.sessionConfig.mcpServers.push({
          name,
          type: server.type,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({
            name: key,
            value,
          })),
        });
    }
  }
  let invocationBytes = 0;
  for (const value of [...projection.args, ...Object.values(projection.env)])
    if (
      (invocationBytes += Buffer.byteLength(value)) > 128 * 1024 ||
      Buffer.byteLength(value) > 64 * 1024
    )
      throw new Error("Provider override exceeds byte limit");
  return projection;
}
