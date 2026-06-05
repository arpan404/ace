import {
  asObject,
  asReadonlyArray as asArray,
  asTrimmedNonEmptyString as asString,
} from "../unknown.ts";
import type { ProviderSlashCommand } from "@ace/contracts";
import {
  hasAcpSessionCloseCapability,
  hasAcpSessionForkCapability,
  hasAcpSessionResumeCapability,
} from "../acpCapabilities.ts";

export type CursorPromptCapabilities = {
  readonly image: boolean;
  readonly audio: boolean;
  readonly embeddedContext: boolean;
};

export type CursorPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type CursorPermissionOption = {
  readonly optionId: string;
  readonly kind?: CursorPermissionOptionKind;
  readonly name?: string;
};

export type CursorAuthMethod = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

export type CursorInitializeState = {
  readonly protocolVersion?: number;
  readonly agentCapabilities: {
    readonly loadSession: boolean;
    readonly resumeSession: boolean;
    readonly closeSession: boolean;
    readonly forkSession: boolean;
    readonly promptCapabilities: CursorPromptCapabilities;
  };
  readonly authMethods: ReadonlyArray<CursorAuthMethod>;
};

export type CursorSessionModeDefinition = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

export type CursorSessionModeState = {
  readonly currentModeId?: string;
  readonly availableModes: ReadonlyArray<CursorSessionModeDefinition>;
};

export type CursorSessionModelDefinition = {
  readonly modelId: string;
  readonly name?: string;
};

export type CursorSessionModelState = {
  readonly currentModelId?: string;
  readonly availableModels: ReadonlyArray<CursorSessionModelDefinition>;
};

export type CursorSessionConfigOptionValue = {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
};

export type CursorSessionConfigOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly currentValue: string;
  readonly options: ReadonlyArray<CursorSessionConfigOptionValue>;
};

export type CursorAvailableCommand = ProviderSlashCommand;

export type CursorMcpServer = {
  readonly name: string;
  readonly type?: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly headers?: Record<string, string>;
};

export type CursorSessionMetadata = {
  readonly initialize: CursorInitializeState;
  readonly configOptions: ReadonlyArray<CursorSessionConfigOption>;
  readonly modes?: CursorSessionModeState;
  readonly models?: CursorSessionModelState;
  readonly availableCommands: ReadonlyArray<CursorAvailableCommand>;
  readonly mcpServers: ReadonlyArray<CursorMcpServer>;
  readonly defaultModeId?: string;
};

export const EMPTY_CURSOR_PROMPT_CAPABILITIES: CursorPromptCapabilities = {
  image: false,
  audio: false,
  embeddedContext: false,
};

export const EMPTY_CURSOR_INITIALIZE_STATE: CursorInitializeState = {
  agentCapabilities: {
    loadSession: false,
    resumeSession: false,
    closeSession: false,
    forkSession: false,
    promptCapabilities: EMPTY_CURSOR_PROMPT_CAPABILITIES,
  },
  authMethods: [],
};

export const EMPTY_CURSOR_SESSION_METADATA: CursorSessionMetadata = {
  initialize: EMPTY_CURSOR_INITIALIZE_STATE,
  configOptions: [],
  availableCommands: [],
  mcpServers: [],
};

function sanitizeCursorDisplayLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const suffixMatch = /\s+\(([^()]+)\)$/.exec(normalized);
  if (!suffixMatch) {
    return normalized;
  }

  const statuses = (suffixMatch[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (statuses.length === 0) {
    return normalized;
  }

  return statuses.every((entry) => entry === "current" || entry === "default")
    ? normalized.slice(0, suffixMatch.index).trim()
    : normalized;
}

function parseCursorPromptCapabilities(value: unknown): CursorPromptCapabilities {
  const record = asObject(value);
  return {
    image: record?.image === true,
    audio: record?.audio === true,
    embeddedContext: record?.embeddedContext === true,
  };
}

function parseCursorAuthMethods(value: unknown): ReadonlyArray<CursorAuthMethod> {
  const methods = asArray(value);
  if (!methods) {
    return [];
  }
  const parsed: Array<CursorAuthMethod> = [];
  for (const method of methods) {
    const entry = asObject(method);
    if (!entry) {
      continue;
    }
    const id = asString(entry.id);
    if (!id) {
      continue;
    }
    const normalized: { id: string; name?: string; description?: string } = { id };
    const name = asString(entry.name);
    if (name) {
      normalized.name = name;
    }
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    parsed.push(normalized);
  }
  return parsed;
}

export function parseCursorInitializeState(value: unknown): CursorInitializeState {
  const record = asObject(value);
  const agentCapabilities = asObject(record?.agentCapabilities);
  return {
    ...(typeof record?.protocolVersion === "number"
      ? { protocolVersion: record.protocolVersion }
      : {}),
    agentCapabilities: {
      loadSession: agentCapabilities?.loadSession === true,
      resumeSession: hasAcpSessionResumeCapability(value),
      closeSession: hasAcpSessionCloseCapability(value),
      forkSession: hasAcpSessionForkCapability(value),
      promptCapabilities: parseCursorPromptCapabilities(agentCapabilities?.promptCapabilities),
    },
    authMethods: parseCursorAuthMethods(record?.authMethods),
  };
}

export function parseCursorSessionModeState(value: unknown): CursorSessionModeState | undefined {
  const record = asObject(value);
  const availableModesRaw =
    asArray(record?.availableModes) ?? asArray(record?.available_modes) ?? asArray(record?.modes);
  const availableModes: Array<CursorSessionModeDefinition> = [];
  if (availableModesRaw) {
    for (const mode of availableModesRaw) {
      const entry = asObject(mode);
      if (!entry) {
        continue;
      }
      const id =
        asString(entry.id) ??
        asString(entry.modeId) ??
        asString(entry.mode_id) ??
        asString(entry.value) ??
        asString(entry.mode);
      if (!id) {
        continue;
      }
      const normalized: { id: string; name?: string; description?: string } = { id };
      const name = asString(entry.name) ?? asString(entry.label) ?? asString(entry.title);
      if (name) {
        normalized.name = name;
      }
      const description = asString(entry.description);
      if (description) {
        normalized.description = description;
      }
      availableModes.push(normalized);
    }
  }
  const currentModeId =
    asString(record?.currentModeId) ??
    asString(record?.current_mode_id) ??
    asString(record?.modeId) ??
    asString(record?.mode_id) ??
    asString(record?.mode);
  if (!currentModeId && availableModes.length === 0) {
    return undefined;
  }
  return {
    ...(currentModeId ? { currentModeId } : {}),
    availableModes,
  };
}

export function parseCursorSessionModelState(value: unknown): CursorSessionModelState | undefined {
  const record = asObject(value);
  const availableModelsRaw =
    asArray(record?.availableModels) ??
    asArray(record?.available_models) ??
    asArray(record?.models);
  const availableModels: Array<CursorSessionModelDefinition> = [];
  if (availableModelsRaw) {
    for (const model of availableModelsRaw) {
      const entry = asObject(model);
      if (!entry) {
        continue;
      }
      const modelId =
        asString(entry.modelId) ??
        asString(entry.model_id) ??
        asString(entry.id) ??
        asString(entry.value) ??
        asString(entry.model);
      if (!modelId) {
        continue;
      }
      const normalized: { modelId: string; name?: string } = { modelId };
      const name = asString(entry.name) ?? asString(entry.label) ?? asString(entry.title);
      if (name) {
        normalized.name = sanitizeCursorDisplayLabel(name);
      }
      availableModels.push(normalized);
    }
  }
  const currentModelId =
    asString(record?.currentModelId) ??
    asString(record?.current_model_id) ??
    asString(record?.modelId) ??
    asString(record?.model_id) ??
    asString(record?.model);
  if (!currentModelId && availableModels.length === 0) {
    return undefined;
  }
  return {
    ...(currentModelId ? { currentModelId } : {}),
    availableModels,
  };
}

function parseCursorConfigOptionValues(
  value: unknown,
): ReadonlyArray<CursorSessionConfigOptionValue> {
  const options = asArray(value);
  if (!options) {
    return [];
  }
  const parsed: Array<CursorSessionConfigOptionValue> = [];
  for (const option of options) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const optionValue = asString(entry.value);
    const rawName = asString(entry.name);
    const name = rawName ? sanitizeCursorDisplayLabel(rawName) : optionValue;
    if (!optionValue || !name) {
      continue;
    }
    const normalized: { value: string; name: string; description?: string } = {
      value: optionValue,
      name,
    };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    parsed.push(normalized);
  }
  return parsed;
}

export function parseCursorConfigOptions(value: unknown): ReadonlyArray<CursorSessionConfigOption> {
  const configOptions = asArray(value);
  if (!configOptions) {
    return [];
  }
  const parsed: Array<CursorSessionConfigOption> = [];
  for (const option of configOptions) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const id = asString(entry.id);
    const name = asString(entry.name);
    const currentValue = asString(entry.currentValue);
    if (!id || !name || !currentValue) {
      continue;
    }
    const normalized: {
      id: string;
      name: string;
      currentValue: string;
      options: ReadonlyArray<CursorSessionConfigOptionValue>;
      description?: string;
      category?: string;
    } = {
      id,
      name,
      currentValue,
      options: parseCursorConfigOptionValues(entry.options),
    };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    const category = asString(entry.category);
    if (category) {
      normalized.category = category;
    }
    parsed.push(normalized);
  }
  return parsed;
}

export function parseCursorAvailableCommands(
  value: unknown,
): ReadonlyArray<CursorAvailableCommand> {
  const valueRecord = asObject(value);
  const commands =
    asArray(value) ??
    asArray(valueRecord?.commands) ??
    asArray(valueRecord?.availableCommands) ??
    asArray(valueRecord?.available_commands);
  if (!commands) {
    return [];
  }
  const parsed: Array<CursorAvailableCommand> = [];
  for (const command of commands) {
    const entry = asObject(command);
    if (!entry) {
      continue;
    }
    const name = asString(entry.name);
    if (!name) {
      continue;
    }
    const normalized: {
      name: string;
      description?: string;
      inputHint?: string;
      kind?: "provider";
      promptPrefix?: string;
    } = {
      name,
      kind: "provider",
      promptPrefix: `/${name}`,
    };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    const input = asObject(entry.input);
    const inputHint = asString(input?.hint);
    if (inputHint) {
      normalized.inputHint = inputHint;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function parseCursorStringArray(value: unknown): ReadonlyArray<string> | undefined {
  const values = asArray(value)
    ?.map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return values && values.length > 0 ? values : undefined;
}

function parseCursorStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asObject(value);
  if (!record) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const name = key.trim();
    const stringValue = asString(rawValue);
    if (name && stringValue) {
      normalized[name] = stringValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseCursorMcpServer(name: string, value: unknown): CursorMcpServer | null {
  const serverName = asString(name);
  const record = asObject(value);
  if (!serverName || !record) {
    return null;
  }
  const command = asString(record.command);
  const url = asString(record.url) ?? asString(record.httpUrl) ?? asString(record.http_url);
  if (!command && !url) {
    return null;
  }
  const explicitType = asString(record.type)?.toLowerCase();
  const normalized: CursorMcpServer = {
    name: serverName,
    ...(explicitType === "http" || explicitType === "sse" || explicitType === "stdio"
      ? { type: explicitType }
      : command
        ? { type: "stdio" as const }
        : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(parseCursorStringArray(record.args) ? { args: parseCursorStringArray(record.args)! } : {}),
    ...(parseCursorStringArray(record.tools)
      ? { tools: parseCursorStringArray(record.tools)! }
      : {}),
    ...(parseCursorStringRecord(record.env) ? { env: parseCursorStringRecord(record.env)! } : {}),
    ...(parseCursorStringRecord(record.headers)
      ? { headers: parseCursorStringRecord(record.headers)! }
      : {}),
  };
  return normalized;
}

export function parseCursorMcpServers(value: unknown): ReadonlyArray<CursorMcpServer> {
  const record = asObject(value);
  const container = asObject(record?.mcpServers) ?? asObject(record?.mcp_servers) ?? record;
  if (!container) {
    return [];
  }
  return Object.entries(container)
    .map(([name, server]) => parseCursorMcpServer(name, server))
    .filter((server): server is CursorMcpServer => server !== null);
}

export function findCursorConfigOption(
  configOptions: ReadonlyArray<CursorSessionConfigOption>,
  input: { readonly category?: string; readonly id?: string },
): CursorSessionConfigOption | undefined {
  const normalizedCategory = input.category?.trim().toLowerCase();
  const normalizedId = input.id?.trim().toLowerCase();
  return configOptions.find((option) => {
    if (normalizedCategory && option.category?.trim().toLowerCase() === normalizedCategory) {
      return true;
    }
    return normalizedId !== undefined && option.id.trim().toLowerCase() === normalizedId;
  });
}

function replaceCursorConfigOptionCurrentValue(
  configOptions: ReadonlyArray<CursorSessionConfigOption>,
  optionId: string | undefined,
  currentValue: string | undefined,
): ReadonlyArray<CursorSessionConfigOption> {
  if (!optionId || !currentValue) {
    return configOptions;
  }
  return configOptions.map((option) =>
    option.id === optionId && option.currentValue !== currentValue
      ? { ...option, currentValue }
      : option,
  );
}

function cursorModeStateFromConfigOption(
  option: CursorSessionConfigOption | undefined,
): CursorSessionModeState | undefined {
  if (!option) {
    return undefined;
  }
  return {
    currentModeId: option.currentValue,
    availableModes: option.options.map((entry) => ({
      id: entry.value,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
    })),
  };
}

function cursorModelStateFromConfigOption(
  option: CursorSessionConfigOption | undefined,
): CursorSessionModelState | undefined {
  if (!option) {
    return undefined;
  }
  return {
    currentModelId: option.currentValue,
    availableModels: option.options.map((entry) => ({
      modelId: entry.value,
      name: entry.name,
    })),
  };
}

function mergeCursorModeStates(
  primary: CursorSessionModeState | undefined,
  secondary: CursorSessionModeState | undefined,
): CursorSessionModeState | undefined {
  const currentModeId = primary?.currentModeId ?? secondary?.currentModeId;
  const availableModes =
    primary?.availableModes && primary.availableModes.length > 0
      ? primary.availableModes
      : (secondary?.availableModes ?? []);
  if (!currentModeId && availableModes.length === 0) {
    return undefined;
  }
  return {
    ...(currentModeId ? { currentModeId } : {}),
    availableModes,
  };
}

function mergeCursorModelStates(
  primary: CursorSessionModelState | undefined,
  secondary: CursorSessionModelState | undefined,
): CursorSessionModelState | undefined {
  const currentModelId = primary?.currentModelId ?? secondary?.currentModelId;
  const availableModels =
    primary?.availableModels && primary.availableModels.length > 0
      ? primary.availableModels
      : (secondary?.availableModels ?? []);
  if (!currentModelId && availableModels.length === 0) {
    return undefined;
  }
  return {
    ...(currentModelId ? { currentModelId } : {}),
    availableModels,
  };
}

export function buildCursorSessionMetadata(input: {
  readonly previous?: CursorSessionMetadata | undefined;
  readonly initialize?: CursorInitializeState | undefined;
  readonly configOptions?: ReadonlyArray<CursorSessionConfigOption> | undefined;
  readonly modes?: CursorSessionModeState | undefined;
  readonly models?: CursorSessionModelState | undefined;
  readonly availableCommands?: ReadonlyArray<CursorAvailableCommand> | undefined;
  readonly mcpServers?: ReadonlyArray<CursorMcpServer> | undefined;
  readonly currentModeId?: string | undefined;
  readonly currentModelId?: string | undefined;
}): CursorSessionMetadata {
  const previous = input.previous ?? EMPTY_CURSOR_SESSION_METADATA;
  let configOptions = input.configOptions ?? previous.configOptions;
  const requestedModeOption = findCursorConfigOption(configOptions, {
    category: "mode",
    id: "mode",
  });
  configOptions = replaceCursorConfigOptionCurrentValue(
    configOptions,
    requestedModeOption?.id,
    input.currentModeId,
  );
  const requestedModelOption = findCursorConfigOption(configOptions, {
    category: "model",
    id: "model",
  });
  configOptions = replaceCursorConfigOptionCurrentValue(
    configOptions,
    requestedModelOption?.id,
    input.currentModelId,
  );
  const modeConfigState = cursorModeStateFromConfigOption(
    findCursorConfigOption(configOptions, { category: "mode", id: "mode" }),
  );
  const modelConfigState = cursorModelStateFromConfigOption(
    findCursorConfigOption(configOptions, { category: "model", id: "model" }),
  );
  const explicitModes = input.modes ?? previous.modes;
  const explicitModels = input.models ?? previous.models;
  let modes =
    input.configOptions !== undefined
      ? mergeCursorModeStates(modeConfigState, explicitModes)
      : mergeCursorModeStates(explicitModes, modeConfigState);
  let models =
    input.configOptions !== undefined
      ? mergeCursorModelStates(modelConfigState, explicitModels)
      : mergeCursorModelStates(explicitModels, modelConfigState);
  if (input.currentModeId) {
    modes = {
      currentModeId: input.currentModeId,
      availableModes: modes?.availableModes ?? [],
    };
  }
  if (input.currentModelId) {
    models = {
      currentModelId: input.currentModelId,
      availableModels: models?.availableModels ?? [],
    };
  }
  const currentModeId = modes?.currentModeId;
  const defaultModeId =
    (input.currentModeId && input.currentModeId !== "plan" ? input.currentModeId : undefined) ??
    (currentModeId && currentModeId !== "plan" ? currentModeId : undefined) ??
    previous.defaultModeId ??
    currentModeId;
  return {
    initialize: input.initialize ?? previous.initialize,
    configOptions,
    ...(modes ? { modes } : {}),
    ...(models ? { models } : {}),
    availableCommands: input.availableCommands ?? previous.availableCommands,
    mcpServers: input.mcpServers ?? previous.mcpServers,
    ...(defaultModeId ? { defaultModeId } : {}),
  };
}

function cursorProviderCapabilities(metadata: CursorSessionMetadata) {
  return {
    sessionResumeMode: metadata.initialize.agentCapabilities.resumeSession
      ? ("native" as const)
      : ("local-replay" as const),
    ...(metadata.initialize.agentCapabilities.forkSession
      ? {
          sessionForkMode: "native" as const,
          sideConversationMode: "native-fork" as const,
        }
      : {
          sessionForkMode: "local-replay" as const,
          sideConversationMode: "replay-fork" as const,
        }),
  };
}

export function cursorSessionMetadataSnapshot(
  metadata: CursorSessionMetadata,
): Record<string, unknown> {
  return {
    initialize: metadata.initialize,
    capabilities: cursorProviderCapabilities(metadata),
    configOptions: metadata.configOptions,
    ...(metadata.modes ? { modes: metadata.modes } : {}),
    ...(metadata.models ? { models: metadata.models } : {}),
    ...(metadata.availableCommands.length > 0
      ? { availableCommands: metadata.availableCommands }
      : {}),
    ...(metadata.mcpServers.length > 0 ? { mcpServers: metadata.mcpServers } : {}),
    ...(metadata.defaultModeId ? { defaultModeId: metadata.defaultModeId } : {}),
  };
}
