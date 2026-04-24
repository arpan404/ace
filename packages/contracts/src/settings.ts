import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  GeminiModelOptions,
  GitHubCopilotModelOptions,
  OpenCodeModelOptions,
} from "./model";
import { ModelSelection } from "./orchestration";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals([
  "updated_at",
  "last_user_message",
  "created_at",
  "manual",
]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "last_user_message";

export const SidebarThreadSortOrder = Schema.Literals([
  "updated_at",
  "created_at",
  "last_user_message",
  "manual",
]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const BrowserSearchEngine = Schema.Literals(["duckduckgo", "google", "brave", "startpage"]);
export type BrowserSearchEngine = typeof BrowserSearchEngine.Type;
export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "duckduckgo";

export const WorkspaceEditorOpenMode = Schema.Literals(["split", "full"]);
export type WorkspaceEditorOpenMode = typeof WorkspaceEditorOpenMode.Type;
export const DEFAULT_WORKSPACE_EDITOR_OPEN_MODE: WorkspaceEditorOpenMode = "split";

export const BrowserOpenMode = Schema.Literals(["split", "full"]);
export type BrowserOpenMode = typeof BrowserOpenMode.Type;
export const DEFAULT_BROWSER_OPEN_MODE: BrowserOpenMode = "split";

export const EditorLineNumbers = Schema.Literals(["off", "on", "relative"]);
export type EditorLineNumbers = typeof EditorLineNumbers.Type;
export const DEFAULT_EDITOR_LINE_NUMBERS: EditorLineNumbers = "on";
export const DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB = 100;

/** UI (sans) font preset — applied via CSS `--font-ui` in the web client. */
export const UiFontFamily = Schema.Literals([
  "plus-jakarta",
  "inter",
  "system-ui",
  "dm-sans",
  "source-sans-3",
]);
export type UiFontFamily = typeof UiFontFamily.Type;
export const DEFAULT_UI_FONT_FAMILY: UiFontFamily = "plus-jakarta";

/** Monospace font preset — applied via CSS `--font-mono` in the web client. */
export const UiMonoFontFamily = Schema.Literals([
  "jetbrains",
  "fira-code",
  "ibm-plex-mono",
  "system-mono",
]);
export type UiMonoFontFamily = typeof UiMonoFontFamily.Type;
export const DEFAULT_UI_MONO_FONT_FAMILY: UiMonoFontFamily = "jetbrains";

/** Base `html` font size scale (affects rem-based UI sizing). */
export const UiFontSizeScale = Schema.Literals(["compact", "normal", "comfortable"]);
export type UiFontSizeScale = typeof UiFontSizeScale.Type;
export const DEFAULT_UI_FONT_SIZE_SCALE: UiFontSizeScale = "normal";

/** Body letter-spacing preset. */
export const UiLetterSpacing = Schema.Literals(["tight", "normal", "relaxed"]);
export type UiLetterSpacing = typeof UiLetterSpacing.Type;
export const DEFAULT_UI_LETTER_SPACING: UiLetterSpacing = "normal";

export const ClientSettingsSchema = Schema.Struct({
  browserOpenMode: BrowserOpenMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_BROWSER_OPEN_MODE),
  ),
  browserSearchEngine: BrowserSearchEngine.pipe(
    Schema.withDecodingDefault(() => DEFAULT_BROWSER_SEARCH_ENGINE),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  editorLineNumbers: EditorLineNumbers.pipe(
    Schema.withDecodingDefault(() => DEFAULT_EDITOR_LINE_NUMBERS),
  ),
  editorMinimap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  editorNeovimMode: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  editorRenderWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  editorStickyScroll: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  editorSuggestions: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  editorWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  threadHydrationCacheMemoryMb: NonNegativeInt.pipe(
    Schema.withDecodingDefault(() => DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
  uiFontFamily: UiFontFamily.pipe(Schema.withDecodingDefault(() => DEFAULT_UI_FONT_FAMILY)),
  uiMonoFontFamily: UiMonoFontFamily.pipe(
    Schema.withDecodingDefault(() => DEFAULT_UI_MONO_FONT_FAMILY),
  ),
  uiFontSizeScale: UiFontSizeScale.pipe(
    Schema.withDecodingDefault(() => DEFAULT_UI_FONT_SIZE_SCALE),
  ),
  uiLetterSpacing: UiLetterSpacing.pipe(
    Schema.withDecodingDefault(() => DEFAULT_UI_LETTER_SPACING),
  ),
  workspaceEditorOpenMode: WorkspaceEditorOpenMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_WORKSPACE_EDITOR_OPEN_MODE),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;
export const DEFAULT_PROVIDER_CLI_MAX_OPEN = 5;
export const DEFAULT_PROVIDER_CLI_IDLE_TTL_SECONDS = 300;
export const DEFAULT_ADD_PROJECT_BASE_DIRECTORY = "";

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const GitHubCopilotSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("copilot"),
  cliUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type GitHubCopilotSettings = typeof GitHubCopilotSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("cursor-agent"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CursorSettings = typeof CursorSettings.Type;

export const GeminiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("gemini"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type GeminiSettings = typeof GeminiSettings.Type;

export const OpenCodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("opencode"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableToolStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableThinkingStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  gitSshKeyPassphrase: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  notifyOnAgentCompletion: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  notifyOnApprovalRequired: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  notifyOnUserInputRequired: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ADD_PROJECT_BASE_DIRECTORY),
  ),
  providerCliMaxOpen: PositiveInt.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_CLI_MAX_OPEN),
  ),
  providerCliIdleTtlSeconds: PositiveInt.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_CLI_IDLE_TTL_SECONDS),
  ),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    })),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    githubCopilot: GitHubCopilotSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    gemini: GeminiSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const GitHubCopilotModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(GitHubCopilotModelOptions.fields.reasoningEffort),
});

const OpenCodeModelOptionsPatch = Schema.Struct({
  variant: Schema.optionalKey(OpenCodeModelOptions.fields.variant),
  fastMode: Schema.optionalKey(OpenCodeModelOptions.fields.fastMode),
});

const GeminiModelOptionsPatch = Schema.Struct({
  ...(GeminiModelOptions.fields satisfies Record<string, never>),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("githubCopilot")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(GitHubCopilotModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("cursor")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("gemini")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(GeminiModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("opencode")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(OpenCodeModelOptionsPatch),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GitHubCopilotSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  cliUrl: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GeminiSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableToolStreaming: Schema.optionalKey(Schema.Boolean),
  enableThinkingStreaming: Schema.optionalKey(Schema.Boolean),
  gitSshKeyPassphrase: Schema.optionalKey(TrimmedString),
  notifyOnAgentCompletion: Schema.optionalKey(Schema.Boolean),
  notifyOnApprovalRequired: Schema.optionalKey(Schema.Boolean),
  notifyOnUserInputRequired: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  providerCliMaxOpen: Schema.optionalKey(PositiveInt),
  providerCliIdleTtlSeconds: Schema.optionalKey(PositiveInt),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      githubCopilot: Schema.optionalKey(GitHubCopilotSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      gemini: Schema.optionalKey(GeminiSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
