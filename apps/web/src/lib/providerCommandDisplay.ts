import type { ProviderSlashCommand } from "@ace/contracts";
import type { ProviderExtensionCommandKind } from "@ace/shared/providerSlashCommands";

export type ComposerProviderCommandKind = "provider" | ProviderExtensionCommandKind;

export function providerCommandDisplayDescription(
  command: ProviderSlashCommand,
  commandKind: ComposerProviderCommandKind,
): string {
  const noun =
    commandKind === "plugin"
      ? "Plugin"
      : commandKind === "skill"
        ? "Skill"
        : commandKind === "agent"
          ? "Agent"
          : "Provider command";
  return command.inputHint
    ? `${command.description ?? noun} - ${command.inputHint}`
    : (command.description ?? noun);
}

export function providerCommandDisplaySearchText(command: ProviderSlashCommand): string {
  const metadata = command.metadata;
  if (!metadata) {
    return "";
  }
  const values: string[] = [];
  const models = providerCommandMetadataStringList(
    metadata.model ?? metadata.modelId ?? metadata.model_id,
  );
  if (models.length > 0) {
    values.push(models.join(" "));
  }
  const tools = providerCommandMetadataStringList(
    metadata.allowedTools ?? metadata.allowed_tools ?? metadata.tools ?? metadata.toolNames,
  );
  if (tools.length > 0) {
    values.push(tools.join(" "));
  }
  const disallowedTools = providerCommandMetadataStringList(
    metadata.disallowedTools ?? metadata.disallowed_tools ?? metadata.deniedTools,
  );
  if (disallowedTools.length > 0) {
    values.push(disallowedTools.join(" "));
  }
  const argumentsList = providerCommandMetadataStringList(
    metadata.arguments ?? metadata.args ?? metadata.argumentNames ?? metadata.parameters,
  );
  if (argumentsList.length > 0) {
    values.push(argumentsList.join(" "));
  }
  const modes = providerCommandMetadataStringList(metadata.mode ?? metadata.agentMode);
  if (modes.length > 0) {
    values.push(modes.join(" "));
  }
  const permissionModes = providerCommandMetadataStringList(
    metadata.permissionMode ?? metadata.permission_mode,
  );
  if (permissionModes.length > 0) {
    values.push(permissionModes.join(" "));
  }
  const contexts = providerCommandMetadataStringList(
    metadata.context ?? metadata.executionContext ?? metadata.execution_context,
  );
  if (contexts.length > 0) {
    values.push(contexts.join(" "));
  }
  const providers = providerCommandMetadataStringList(metadata.provider);
  if (providers.length > 0) {
    values.push(providers.join(" "));
  }
  const kinds = providerCommandMetadataStringList(metadata.kind ?? metadata.agentKind);
  if (kinds.length > 0) {
    values.push(kinds.join(" "));
  }
  const colors = providerCommandMetadataStringList(metadata.color);
  if (colors.length > 0) {
    values.push(colors.join(" "));
  }
  const permission = providerCommandMetadataDeepStringList(
    metadata.permission ??
      metadata.permissions ??
      metadata.taskPermission ??
      metadata.task_permission,
  );
  if (permission.length > 0) {
    values.push(permission.join(" "));
  }
  const skills = providerCommandMetadataStringList(metadata.skills ?? metadata.skillNames);
  if (skills.length > 0) {
    values.push(skills.join(" "));
  }
  const annotations = providerCommandMetadataDeepStringList(
    metadata.annotations ??
      metadata.annotation ??
      metadata.customMetadata ??
      metadata.custom_metadata ??
      metadata.providerMetadata ??
      metadata.provider_metadata,
  );
  if (annotations.length > 0) {
    values.push(annotations.join(" "));
  }
  if (metadata.initialPrompt || metadata.initial_prompt || metadata.initialMessage) {
    values.push("initial prompt initial message");
  }
  if (
    metadata.disableModelInvocation === true ||
    metadata.disable_model_invocation === true ||
    metadata.infer === false
  ) {
    values.push("manual invocation no automatic invocation");
  }
  if (
    metadata.disableModelInvocation === false ||
    metadata.disable_model_invocation === false ||
    metadata.infer === true
  ) {
    values.push("automatic invocation");
  }
  if (metadata.userInvocable === false || metadata.user_invocable === false) {
    values.push("hidden from picker programmatic only");
  }
  if (metadata.userInvocable === true || metadata.user_invocable === true) {
    values.push("user invocable picker selectable");
  }
  const agents = providerCommandMetadataStringList(
    metadata.agent ?? metadata.agents ?? metadata.agentNames ?? metadata.handoffs,
  );
  if (agents.length > 0) {
    values.push(agents.join(" "));
  }
  const targets = providerCommandMetadataStringList(
    metadata.target ??
      metadata.targets ??
      metadata.targetEnvironment ??
      metadata.target_environment,
  );
  if (targets.length > 0) {
    values.push(targets.join(" "));
  }
  if (metadata.subtask === true) {
    values.push("subtask side chat side conversation");
  }
  if (metadata.shellInjection === true || metadata.shell_injection === true) {
    values.push("shell command injection dynamic command");
  }
  if (metadata.fileInjection === true || metadata.file_injection === true) {
    values.push("file injection context injection dynamic command");
  }
  if (metadata.readOnly === true || metadata.read_only === true) {
    values.push("read only read-only");
  }
  if (metadata.isBackground === true || metadata.is_background === true) {
    values.push("background async asynchronous");
  }
  if (metadata.background === true) {
    values.push("background async asynchronous");
  }
  const isolation = providerCommandMetadataStringList(metadata.isolation);
  if (isolation.length > 0) {
    values.push(isolation.join(" "));
  }
  const maxTurns = providerCommandMetadataDeepStringList(
    metadata.maxTurns ?? metadata.max_turns ?? metadata.max_turn_count,
  );
  if (maxTurns.length > 0) {
    values.push(maxTurns.join(" "));
  }
  const temperature = providerCommandMetadataDeepStringList(metadata.temperature ?? metadata.temp);
  if (temperature.length > 0) {
    values.push(temperature.join(" "));
  }
  const agentCards = providerCommandMetadataStringList(
    metadata.agentCardUrl ??
      metadata.agent_card_url ??
      metadata.agentCardJson ??
      metadata.agent_card_json,
  );
  if (agentCards.length > 0) {
    values.push(agentCards.join(" "));
  }
  const mcpServers = providerCommandMetadataDeepStringList(
    metadata.mcpServers ?? metadata.mcp_servers ?? metadata.mcp,
  );
  if (mcpServers.length > 0) {
    values.push(mcpServers.join(" "));
  }
  const hooks = providerCommandMetadataDeepStringList(metadata.hooks ?? metadata.hookNames);
  if (hooks.length > 0) {
    values.push(hooks.join(" "));
  }
  const auth = [
    ...providerCommandMetadataStringList(metadata.authType ?? metadata.auth_type),
    ...providerCommandMetadataDeepStringList(metadata.auth ?? metadata.authentication),
  ];
  if (auth.length > 0) {
    values.push(auth.join(" "));
  }
  const globs = providerCommandMetadataStringList(metadata.globs ?? metadata.fileGlobs);
  if (globs.length > 0) {
    values.push(globs.join(" "));
  }
  if (metadata.alwaysApply === true || metadata.always_apply === true) {
    values.push("always apply always-on");
  }
  const packages = providerCommandMetadataStringList(
    metadata.package ?? metadata.packageName ?? metadata.package_name,
  );
  if (packages.length > 0) {
    values.push(packages.join(" "));
  }
  const thinking = providerCommandMetadataStringList(
    metadata.effort ??
      metadata.thinking ??
      metadata.thinkingLevel ??
      metadata.thoughtLevel ??
      metadata.thought_level,
  );
  if (thinking.length > 0) {
    values.push(thinking.join(" "));
  }
  return values.join(" ").toLowerCase();
}

export function providerCommandDisplayItemMatchesQuery(
  item: {
    readonly command: string;
    readonly label: string;
    readonly description?: string | undefined;
    readonly metadataBadges?: ReadonlyArray<string> | undefined;
    readonly metadataSearchText?: string | undefined;
  },
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return [
    item.command,
    item.command.replace(/^[/@$]+/, ""),
    item.label,
    item.description,
    item.metadataSearchText,
    ...(item.metadataBadges ?? []),
  ].some((value) => value?.toLowerCase().includes(normalizedQuery) === true);
}

export function providerCommandDisplayBadges(command: ProviderSlashCommand): string[] {
  const metadata = command.metadata;
  if (!metadata) {
    return [];
  }
  const badges: string[] = [];
  const models = providerCommandMetadataStringList(
    metadata.model ?? metadata.modelId ?? metadata.model_id,
  );
  if (models.length > 0) {
    badges.push(models.length === 1 ? (models[0] ?? "model") : `${models.length} models`);
  }
  const tools = providerCommandMetadataStringList(
    metadata.allowedTools ?? metadata.allowed_tools ?? metadata.tools ?? metadata.toolNames,
  );
  if (tools.length > 0) {
    badges.push(tools.length === 1 ? (tools[0] ?? "tool") : `${tools.length} tools`);
  }
  const disallowedTools = providerCommandMetadataStringList(
    metadata.disallowedTools ?? metadata.disallowed_tools ?? metadata.deniedTools,
  );
  if (disallowedTools.length > 0) {
    badges.push(
      disallowedTools.length === 1
        ? `blocks ${disallowedTools[0] ?? "tool"}`
        : `blocks ${disallowedTools.length}`,
    );
  }
  const mode = firstProviderCommandMetadataString(metadata.mode, metadata.agentMode);
  if (mode) {
    badges.push(mode);
  }
  const kind = firstProviderCommandMetadataString(metadata.kind, metadata.agentKind);
  if (kind) {
    badges.push(kind);
  }
  const permissionMode = firstProviderCommandMetadataString(
    metadata.permissionMode,
    metadata.permission_mode,
  );
  if (permissionMode) {
    badges.push(permissionMode);
  }
  const context = firstProviderCommandMetadataString(
    metadata.context,
    metadata.executionContext,
    metadata.execution_context,
  );
  if (context) {
    badges.push(context);
  }
  const providers = providerCommandMetadataStringList(metadata.provider);
  const isGitHubCopilot = providers.some((provider) => provider.toLowerCase() === "github-copilot");
  if (
    isGitHubCopilot &&
    (metadata.disableModelInvocation === true ||
      metadata.disable_model_invocation === true ||
      metadata.infer === false)
  ) {
    badges.push("manual");
  } else if (
    metadata.disableModelInvocation === true ||
    metadata.disable_model_invocation === true ||
    metadata.noModel === true
  ) {
    badges.push("no model");
  }
  if (
    !isGitHubCopilot &&
    (metadata.disableModelInvocation === false ||
      metadata.disable_model_invocation === false ||
      metadata.infer === true)
  ) {
    badges.push("automatic");
  }
  if (metadata.userInvocable === false || metadata.user_invocable === false) {
    badges.push("programmatic");
  }
  const argumentsList = providerCommandMetadataStringList(
    metadata.arguments ?? metadata.args ?? metadata.argumentNames ?? metadata.parameters,
  );
  if (argumentsList.length > 0) {
    badges.push(argumentsList.length === 1 ? `[${argumentsList[0] ?? "arg"}]` : "args");
  }
  const directAgents = providerCommandMetadataStringList(metadata.agent);
  if (directAgents.length > 0) {
    badges.push(
      directAgents.length === 1 ? (directAgents[0] ?? "agent") : `${directAgents.length} agents`,
    );
  }
  const targets = providerCommandMetadataStringList(
    metadata.target ??
      metadata.targets ??
      metadata.targetEnvironment ??
      metadata.target_environment,
  );
  if (targets.length > 0) {
    badges.push(targets.length === 1 ? (targets[0] ?? "target") : `${targets.length} targets`);
  }
  if (metadata.subtask === true) {
    badges.push("subtask");
  }
  if (metadata.shellInjection === true || metadata.shell_injection === true) {
    badges.push("shell");
  }
  if (metadata.fileInjection === true || metadata.file_injection === true) {
    badges.push("files");
  }
  if (metadata.readOnly === true || metadata.read_only === true) {
    badges.push("read-only");
  }
  if (metadata.isBackground === true || metadata.is_background === true) {
    badges.push("background");
  }
  if (metadata.background === true) {
    badges.push("background");
  }
  const skills = providerCommandMetadataStringList(metadata.skills ?? metadata.skillNames);
  if (skills.length > 0) {
    badges.push(skills.length === 1 ? (skills[0] ?? "skill") : `${skills.length} skills`);
  }
  const annotations = providerCommandMetadataStringList(
    metadata.annotations ??
      metadata.annotation ??
      metadata.customMetadata ??
      metadata.custom_metadata ??
      metadata.providerMetadata ??
      metadata.provider_metadata,
  );
  if (annotations.length > 0) {
    badges.push(
      annotations.length === 1 ? (annotations[0] ?? "annotation") : `${annotations.length} notes`,
    );
  }
  const temperature = providerCommandMetadataDeepStringList(
    metadata.temperature ?? metadata.temp,
  ).at(0);
  if (temperature) {
    badges.push(`temp ${temperature}`);
  }
  const mcpServers = providerCommandMetadataStringList(
    metadata.mcpServers ?? metadata.mcp_servers ?? metadata.mcp,
  );
  if (mcpServers.length > 0) {
    badges.push(mcpServers.length === 1 ? (mcpServers[0] ?? "MCP") : `${mcpServers.length} MCPs`);
  }
  const hooks = providerCommandMetadataStringList(metadata.hooks ?? metadata.hookNames);
  if (hooks.length > 0) {
    badges.push(hooks.length === 1 ? (hooks[0] ?? "hook") : `${hooks.length} hooks`);
  }
  const authType = firstProviderCommandMetadataString(
    metadata.authType,
    metadata.auth_type,
    providerCommandMetadataRecord(metadata.auth)?.type,
    providerCommandMetadataRecord(metadata.authentication)?.type,
  );
  if (authType) {
    badges.push(`${authType} auth`);
  }
  if (metadata.alwaysApply === true || metadata.always_apply === true) {
    badges.push("always");
  }
  const thinking = firstProviderCommandMetadataString(
    metadata.effort,
    metadata.thinking,
    metadata.thinkingLevel,
    metadata.thoughtLevel,
    metadata.thought_level,
  );
  if (thinking) {
    badges.push(thinking);
  }
  const delegationAgents = providerCommandMetadataStringList(
    metadata.agents ?? metadata.agentNames ?? metadata.handoffs,
  );
  if (delegationAgents.length > 0) {
    badges.push(
      delegationAgents.length === 1
        ? (delegationAgents[0] ?? "agent")
        : `${delegationAgents.length} agents`,
    );
  }
  return badges.slice(0, 3);
}

function firstProviderCommandMetadataString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function providerCommandMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerCommandMetadataStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => providerCommandMetadataStringList(entry));
  }
  const record = providerCommandMetadataRecord(value);
  if (!record) {
    return [];
  }
  const directName = firstProviderCommandMetadataString(
    record.name,
    record.id,
    record.label,
    record.value,
  );
  if (directName) {
    return [directName];
  }
  const properties = providerCommandMetadataRecord(record.properties);
  const keys = Object.keys(properties ?? record).filter(
    (key) =>
      ![
        "$schema",
        "additionalProperties",
        "description",
        "items",
        "properties",
        "required",
        "title",
        "type",
      ].includes(key),
  );
  return keys;
}

function providerCommandMetadataDeepStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => providerCommandMetadataDeepStringList(entry));
  }
  const record = providerCommandMetadataRecord(value);
  if (!record) {
    return [];
  }
  const directName = firstProviderCommandMetadataString(
    record.name,
    record.id,
    record.label,
    record.value,
  );
  if (directName) {
    return [directName];
  }
  const values: string[] = [];
  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      [
        "$schema",
        "additionalProperties",
        "description",
        "items",
        "properties",
        "required",
        "title",
        "type",
      ].includes(key)
    ) {
      continue;
    }
    values.push(key, ...providerCommandMetadataDeepStringList(nestedValue));
  }
  return values;
}
