import type { ProviderInstance } from "@ace/protocol/accounts";
import type { z } from "zod";
import { TokenStore, UsageSource, type UsageDeclaration } from "./declaration.ts";

/*
 * The usage sources ace ships, keyed by native provider or ACP registry agent id. A new ACP
 * agent gets usage by adding an entry here: data checked by the declaration schema, no code.
 * The CLI's own command comes first; a token source follows ADR 0002's usage exception. Each
 * entry names where its endpoint and answer shape were confirmed.
 */

type Declared = { cli: string; sources: z.input<typeof UsageSource>[] };

/** cursor-agent's own `about --format json`: its login's email and plan, no model turn. */
const cursorAbout = ["about", "--format", "json"];

/** One of Cursor's included-usage meters, which reset with the billing cycle. */
const cursorMeter = (label: string, field: string) => ({
  each: [],
  label,
  amount: { path: ["planUsage", field], scale: "percent" as const },
  resetsAt: { path: ["billingCycleEnd"], unit: "ms" as const },
});

/**
 * Cursor's dashboard `GetCurrentPeriodUsage` (Connect JSON), the call cursor-agent 2026.10.01's
 * `/usage` makes with its login (`src/usage-data.ts`), confirmed read-only against a signed-in
 * CLI. Included usage can run past 100% on bonus and on-demand spend, so the meters never hold.
 */
function cursorUsage(token: z.input<typeof TokenStore>, platform: "darwin" | "linux") {
  return {
    kind: "token-http" as const,
    platforms: [platform],
    token,
    // The CLI's login is shared by every home on this machine: only its own account reads it.
    identity: { args: cursorAbout, path: ["userEmail"] },
    request: {
      method: "POST" as const,
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      headers: {
        authorization: "Bearer {token}",
        "connect-protocol-version": "1",
        "x-cursor-client-type": "cli",
      },
      body: {},
    },
    mapping: {
      windows: [
        cursorMeter("included", "totalPercentUsed"),
        cursorMeter("included_auto", "autoPercentUsed"),
        cursorMeter("included_api", "apiPercentUsed"),
      ],
    },
  };
}

/**
 * On Windows cursor-agent 2026.10.22 keeps its login in `%APPDATA%\Cursor\auth.json` (its
 * `cli-credentials` file store; it uses no Credential Manager entry).
 */
function windowsCursorUsage(): z.input<typeof UsageSource> {
  return {
    ...cursorUsage(
      { from: "file", files: ["$APPDATA/Cursor/auth.json"], path: ["accessToken"] },
      "linux",
    ),
    platforms: ["win32"],
  };
}

/** One of OpenCode Go's meters, under its key in the answer's `usage`. */
const goMeter = (key: string, label: string) => ({
  each: ["usage", key],
  label,
  amount: { path: ["percent"], scale: "percent" as const },
  resetsAt: { path: ["resetsAt"], unit: "iso" as const },
});

/**
 * OpenCode Go's usage route, read with the `opencode-go` key OpenCode stores. Confirmed read-only
 * with a signed-in OpenCode 2.0.29. Go is one of OpenCode's providers, so a full meter never
 * holds the account: its other providers still work.
 */
function openCodeGo(token: z.input<typeof TokenStore>): z.input<typeof UsageSource> {
  return {
    kind: "token-http",
    token,
    request: {
      method: "GET",
      url: "https://opencode.ai/zen/go/v1/usage",
      headers: { authorization: "Bearer {token}" },
    },
    mapping: {
      windows: [
        { ...goMeter("rolling", "five_hour"), durationMins: 300 },
        { ...goMeter("weekly", "weekly"), durationMins: 10080 },
        goMeter("monthly", "monthly"),
      ],
    },
  };
}

const declarations: Record<string, Declared> = {
  // Antigravity CLI 1.3.5 (`agy`): `-p /usage` is its built-in slash command, answered with no
  // model turn (`num_turns` 0, no tokens) and no browser while signed in. Signed out, print mode
  // says "authentication required" and exits. Each group's models share a weekly limit and the
  // other group's keep working, so a spent group never holds the account. `agy` reads its own
  // default login, the one ace's Antigravity provider runs with.
  "official:antigravity-acp": {
    cli: "Antigravity",
    sources: [
      {
        kind: "command",
        executable: "agy",
        args: ["-p", "/usage", "--output-format", "json"],
        timeoutMs: 15_000,
        scratchCwd: true,
        signedOut: ["authentication required", "not signed in"],
        mapping: {
          expect: [
            { path: ["status"], equals: "SUCCESS" },
            { path: ["command", "name"], equals: "usage" },
          ],
          windows: [
            {
              group: { each: ["command", "data", "groups", "*"], name: ["name"] },
              each: ["buckets", "*"],
              name: ["window"],
              amount: { path: ["remaining_fraction"], scale: "remainingFraction" },
              resetsAt: { path: ["reset_time"], unit: "iso" },
              // The only window 1.3.5 reports; another is shown without a length, not guessed.
              durationByName: { path: ["window"], minutes: { weekly: 10080 } },
            },
          ],
        },
      },
    ],
  },
  cursor: {
    cli: "Cursor",
    sources: [
      {
        kind: "command",
        args: cursorAbout,
        timeoutMs: 15_000,
        identity: { path: ["userEmail"] },
        mapping: { windows: [], plan: ["subscriptionTier"] },
      },
      // macOS keychain item cursor-agent writes (`<name>-access-token` / `<name>-user`).
      cursorUsage(
        { from: "keychain", service: "cursor-access-token", account: "cursor-user" },
        "darwin",
      ),
      // Elsewhere cursor-agent keeps its login in `$XDG_CONFIG_HOME/cursor/auth.json`.
      cursorUsage(
        { from: "file", files: ["$XDG_CONFIG_HOME/cursor/auth.json"], path: ["accessToken"] },
        "linux",
      ),
      ...(process.platform === "win32" ? [windowsCursorUsage()] : []),
    ],
  },
  // Gemini CLI 0.43 with Google sign-in: the Code Assist quota its `/stats` shows. Endpoints,
  // request bodies and answers are those of its bundled `CodeAssistServer` (`loadCodeAssist`
  // names the project and tier, `retrieveUserQuota` the per-model buckets). Its default store is
  // `~/.gemini/oauth_creds.json`; the access token lasts an hour and only the CLI renews it.
  // One model's bucket running out leaves the others, so buckets never hold the account.
  "official:gemini": {
    cli: "Gemini CLI",
    sources: [
      {
        kind: "token-http",
        token: {
          from: "file",
          files: ["~/.gemini/oauth_creds.json"],
          path: ["access_token"],
          expires: { path: ["expiry_date"], unit: "ms" },
        },
        prelude: {
          request: {
            method: "POST",
            url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
            headers: { authorization: "Bearer {token}" },
            body: {
              metadata: {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
              },
            },
          },
          capture: ["cloudaicompanionProject"],
          plan: [
            ["paidTier", "name"],
            ["currentTier", "name"],
          ],
        },
        request: {
          method: "POST",
          url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
          headers: { authorization: "Bearer {token}" },
          body: { project: "{captured}" },
        },
        mapping: {
          windows: [
            {
              each: ["buckets", "*"],
              name: ["modelId"],
              amount: { path: ["remainingFraction"], scale: "remainingFraction" },
              resetsAt: { path: ["resetTime"], unit: "iso" },
            },
          ],
        },
      },
    ],
  },
  // OpenCode v2 keeps credentials in its SQLite `credential` table, older ones in auth.json:
  // under the implicit home (`$XDG_DATA_HOME/opencode`) or an ace-managed one (`data/opencode`).
  opencode: {
    cli: "OpenCode",
    sources: [
      openCodeGo({
        from: "sqlite",
        files: ["opencode.db", "data/opencode/opencode.db"],
        table: "credential",
        keyColumn: "integration_id",
        key: "opencode-go",
        valueColumn: "value",
        path: ["key"],
      }),
      openCodeGo({
        from: "file",
        files: ["auth.json", "data/opencode/auth.json"],
        path: ["opencode-go", "key"],
      }),
    ],
  },
};

/** The usage source declared for an account's provider or ACP agent, if any. */
export function usageDeclaration(
  instance: Pick<ProviderInstance, "provider" | "acpAgentId" | "homeStrategy">,
): UsageDeclaration | undefined {
  // An agent's declared source reads its CLI's own default login, never an account ace added in
  // a managed home: those would show the default login's limits as their own.
  if (instance.provider === "acp" && instance.homeStrategy === "managed") return undefined;
  const key = instance.provider === "acp" ? instance.acpAgentId : instance.provider;
  const declared =
    key !== undefined && Object.hasOwn(declarations, key) ? declarations[key] : undefined;
  return declared && { ...declared, sources: declared.sources.map((s) => UsageSource.parse(s)) };
}
