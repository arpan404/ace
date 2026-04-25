import type {
  ProviderKind,
  ProviderRuntimeEvent,
  ServerProvider,
  ServerProviderUsage,
  ServerProviderUsageWindow,
  ThreadTokenUsageSnapshot,
} from "@ace/contracts";

function usageWindow(
  input: Omit<ServerProviderUsageWindow, "confidence" | "source"> &
    Pick<ServerProviderUsageWindow, "confidence" | "source">,
): ServerProviderUsageWindow {
  return input;
}

function percentRemaining(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
}

function remaining(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined) {
    return undefined;
  }
  return Math.max(0, limit - used);
}

function compactJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}") {
      return undefined;
    }
    return json.length > 220 ? `${json.slice(0, 217)}...` : json;
  } catch {
    return undefined;
  }
}

function staticUsageForProvider(provider: ProviderKind): ServerProviderUsage {
  switch (provider) {
    case "codex":
      return {
        headline: "Codex limits available from provider status",
        detail:
          "Codex exposes active session limits via /status and may stream account rate-limit updates.",
        source: "provider-runtime",
        confidence: "provider-reported",
        dashboardUrl: "https://chatgpt.com/codex/settings/usage",
        windows: [
          usageWindow({
            kind: "rolling_5h",
            label: "Local messages / 5h",
            unit: "messages",
            source: "provider-runtime",
            confidence: "provider-reported",
            detail:
              "Plan and model dependent. Codex currently documents local-message, cloud-task, and code-review limits sharing a five-hour window.",
          }),
          usageWindow({
            kind: "weekly",
            label: "Weekly account limit",
            unit: "other",
            source: "provider-runtime",
            confidence: "provider-reported",
            detail:
              "Additional weekly limits can apply and are only trustworthy from Codex itself.",
          }),
        ],
        notes: [
          "API-key Codex usage is token billed through the OpenAI API account instead of ChatGPT plan limits.",
          "ace will replace this static summary with provider-reported rate-limit data when Codex emits it.",
        ],
      };
    case "claudeAgent":
      return {
        headline: "Claude usage is rolling-window based",
        detail:
          "Claude Code reports token/context usage locally; individual Pro and Max account-wide analytics are not exposed as a stable API.",
        source: "provider-runtime",
        confidence: "estimated",
        dashboardUrl: "https://claude.ai/settings/usage",
        windows: [
          usageWindow({
            kind: "rolling_5h",
            label: "Claude session window",
            unit: "other",
            source: "provider-runtime",
            confidence: "provider-reported",
            detail: "Claude limit messages include reset timing when a hard limit is reached.",
          }),
          usageWindow({
            kind: "weekly",
            label: "Claude weekly usage",
            unit: "other",
            source: "provider-dashboard",
            confidence: "unknown",
            detail:
              "Team and Enterprise owners can see analytics. Individual Pro and Max analytics are not available through an official API.",
          }),
        ],
        notes: [
          "ace can show context-window tokens and accumulated token use for work done through ace.",
          "API-key Claude usage should be treated as token spend on the Anthropic Console account.",
        ],
      };
    case "githubCopilot":
      return {
        headline: "Copilot has monthly premium requests plus session limits",
        detail:
          "Premium request allowance is monthly; Copilot also enforces session and weekly token limits.",
        source: "provider-dashboard",
        confidence: "provider-reported",
        dashboardUrl: "https://github.com/settings/billing",
        windows: [
          usageWindow({
            kind: "monthly",
            label: "Premium requests / month",
            unit: "requests",
            source: "provider-dashboard",
            confidence: "provider-reported",
            resetLabel: "1st of each month at 00:00 UTC",
            detail:
              "Free: 50, Pro: 300, Pro+: 1,500. Business and Enterprise depend on seat policy.",
          }),
          usageWindow({
            kind: "weekly",
            label: "Weekly token limit",
            unit: "tokens",
            source: "provider-runtime",
            confidence: "provider-reported",
            detail: "Copilot CLI and IDEs warn near session and weekly limits.",
          }),
        ],
        notes: [
          "GitHub REST billing endpoints can provide exact premium request usage when the token has billing access.",
          "Included models may consume zero premium requests but can still be rate limited.",
        ],
      };
    case "cursor":
      return {
        headline: "Cursor uses a monthly model-usage pool",
        detail:
          "Cursor exposes account usage in its dashboard; ace can only estimate usage that flows through ace.",
        source: "provider-dashboard",
        confidence: "estimated",
        dashboardUrl: "https://cursor.com/dashboard",
        windows: [
          usageWindow({
            kind: "monthly",
            label: "Included model usage",
            unit: "credits",
            source: "provider-dashboard",
            confidence: "unknown",
            detail:
              "Individual plans are usage-pool based: Pro includes $20 of frontier model usage, Pro+ is 3x, and Ultra is 20x.",
          }),
          usageWindow({
            kind: "monthly",
            label: "Team included requests",
            unit: "requests",
            source: "static-plan",
            confidence: "estimated",
            detail: "Team plans document 500 included agent requests per user per month.",
          }),
        ],
        notes: [
          "Cursor Auto and Tab have separate behavior from directly selected frontier models.",
          "Use Cursor's dashboard as source of truth for account-wide remaining percentage.",
        ],
      };
    case "gemini":
      return {
        headline: "Gemini limits depend on auth surface",
        detail:
          "Gemini API, Gemini app, and Gemini Code Assist/Gemini CLI have different quota systems.",
        source: "provider-dashboard",
        confidence: "estimated",
        dashboardUrl: "https://aistudio.google.com/app/apikey",
        windows: [
          usageWindow({
            kind: "daily",
            label: "Gemini Code Assist / CLI",
            unit: "requests",
            source: "static-plan",
            confidence: "estimated",
            resetLabel: "Google Cloud quota reset",
            detail:
              "Standard documents 1,500 max requests per user per day; Enterprise documents 2,000.",
          }),
          usageWindow({
            kind: "api",
            label: "Gemini API project quotas",
            unit: "other",
            source: "provider-dashboard",
            confidence: "provider-reported",
            detail: "API quotas are per project and include RPM, TPM, and RPD.",
          }),
        ],
        notes: [
          "Requests per day reset at midnight Pacific time for Gemini API quotas.",
          "ace can show context-window tokens from Gemini ACP usage updates.",
        ],
      };
    case "opencode":
      return {
        headline: "OpenCode usage follows the selected backing provider",
        detail: "OpenCode can route to many providers, local models, OpenCode Zen, or OpenCode Go.",
        source: "provider-runtime",
        confidence: "estimated",
        dashboardUrl: "https://opencode.ai/auth",
        windows: [
          usageWindow({
            kind: "api",
            label: "Backing provider quota",
            unit: "other",
            source: "provider-dashboard",
            confidence: "unknown",
            detail:
              "Use the backing provider dashboard for account-wide limits unless OpenCode emits token or cost data.",
          }),
          usageWindow({
            kind: "context",
            label: "Local model context",
            unit: "tokens",
            source: "provider-runtime",
            confidence: "provider-reported",
            detail: "OpenCode model metadata can expose context limits for the selected model.",
          }),
        ],
        notes: [
          "OpenCode itself is not a single quota authority.",
          "ace tracks usage for OpenCode sessions when the runtime emits token or cost parts.",
        ],
      };
  }
}

export function attachStaticProviderUsage(provider: ServerProvider): ServerProvider {
  return {
    ...provider,
    usage: provider.usage ?? staticUsageForProvider(provider.provider),
  };
}

function tokenUsageWindow(usage: ThreadTokenUsageSnapshot): ServerProviderUsageWindow {
  const used = usage.usedTokens;
  const limit = usage.maxTokens;
  return usageWindow({
    kind: "context",
    label: "Latest thread context",
    unit: "tokens",
    source: "provider-runtime",
    confidence: "provider-reported",
    used,
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining(used, limit) !== undefined ? { remaining: remaining(used, limit) } : {}),
    ...(percentRemaining(used, limit) !== undefined
      ? { percentRemaining: percentRemaining(used, limit) }
      : {}),
    detail:
      usage.totalProcessedTokens !== undefined
        ? `${usage.totalProcessedTokens.toLocaleString()} total processed tokens in this session.`
        : "Most recent context-window usage reported by the provider runtime.",
  });
}

function processedTokenWindow(usage: ThreadTokenUsageSnapshot): ServerProviderUsageWindow | null {
  if (usage.totalProcessedTokens === undefined || usage.totalProcessedTokens <= 0) {
    return null;
  }
  return usageWindow({
    kind: "session",
    label: "Processed through ace",
    unit: "tokens",
    source: "local-estimate",
    confidence: "estimated",
    used: usage.totalProcessedTokens,
    detail: "Local session total. This does not include usage outside ace.",
  });
}

function replaceRuntimeWindows(
  base: ServerProviderUsage,
  runtimeWindows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const runtimeLabels = new Set(runtimeWindows.map((window) => window.label));
  return [...runtimeWindows, ...base.windows.filter((window) => !runtimeLabels.has(window.label))];
}

export function buildTokenRuntimeUsage(
  provider: ProviderKind,
  usage: ThreadTokenUsageSnapshot,
  previous: ServerProviderUsage | undefined,
): ServerProviderUsage {
  const base = previous ?? staticUsageForProvider(provider);
  const runtimeWindows = [tokenUsageWindow(usage), processedTokenWindow(usage)].filter(
    (window): window is ServerProviderUsageWindow => window !== null,
  );
  return {
    ...base,
    headline:
      usage.maxTokens !== undefined
        ? `${Math.round(percentRemaining(usage.usedTokens, usage.maxTokens) ?? 0)}% context left`
        : "Runtime token usage available",
    detail: "Latest usage reported by the active provider session.",
    source: "provider-runtime",
    confidence: "provider-reported",
    updatedAt: new Date().toISOString(),
    windows: replaceRuntimeWindows(base, runtimeWindows),
  };
}

export function buildRateLimitRuntimeUsage(
  provider: ProviderKind,
  rateLimits: unknown,
  previous: ServerProviderUsage | undefined,
): ServerProviderUsage {
  const base = previous ?? staticUsageForProvider(provider);
  const detail = compactJson(rateLimits);
  const runtimeWindow = usageWindow({
    kind: "other",
    label: "Provider account limits",
    unit: "other",
    source: "provider-runtime",
    confidence: "provider-reported",
    ...(detail ? { detail } : {}),
  });
  return {
    ...base,
    headline: "Provider account limits reported",
    detail: "Raw provider limit data is available from the active runtime.",
    source: "provider-runtime",
    confidence: "provider-reported",
    updatedAt: new Date().toISOString(),
    windows: replaceRuntimeWindows(base, [runtimeWindow]),
  };
}

export function buildRuntimeUsageFromEvent(
  event: ProviderRuntimeEvent,
  previous: ServerProviderUsage | undefined,
): ServerProviderUsage | undefined {
  if (event.type === "thread.token-usage.updated") {
    return buildTokenRuntimeUsage(event.provider, event.payload.usage, previous);
  }
  if (event.type === "account.rate-limits.updated") {
    return buildRateLimitRuntimeUsage(event.provider, event.payload.rateLimits, previous);
  }
  return undefined;
}
