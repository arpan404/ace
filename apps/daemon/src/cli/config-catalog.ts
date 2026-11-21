import type { SettingsKey } from "@ace/protocol";

/**
 * What each global setting is, in the words of the app's Settings, for `ace config list` and
 * `ace config get` (ADR 0178 §7). Every settings key has a line here or a reason it can't be
 * set from the CLI; a test fails when a key is added to `SettingsValues` without one.
 */
export const settingSummaries: Readonly<Partial<Record<SettingsKey, string>>> = {
  "storage.retention": "How long each kind of data is kept before cleanup, as a JSON file",
  "storage.scheduledCleanup": "Clean up old data on a schedule",
  "storage.worktreeRetentionDays":
    "Days before a settled thread's worktree is removed; none keeps them",
  "storage.backupWorktrees": "Commit and push settled, unmerged worktrees before removing them",
  "storage.retentionDays": "Days idle threads, unused attachments and logs are kept",
  "logs.maxBytes": "Disk cap for each log stream, rotated files included",
  "sourceControl.preferences": "Git hosts and the default remote, as a JSON file",
  "providers.configuration": "Per-provider configuration, as a JSON file",
  "host.displayName": "This machine's name on your other devices",
  "host.icon": "This machine's icon, as a JSON file",
  "projects.roots": "Folders ace looks in for projects, comma-separated",
  "threads.followUpBehavior": "What a message to a working thread does: steer it or queue",
  "threads.forkOnSwitch": "Fork a thread when you switch its provider",
  "threads.limitPolicy": "What a thread does at a usage limit",
  "providers.default": "The provider new threads use",
  "providers.coder.provider": "Who builds (runRole build); none leaves it to the caller",
  "providers.coder.model": "The builder's model",
  "providers.coder.tier": "The builder's service tier",
  "providers.coder.reasoningEffort": "The builder's reasoning effort",
  "providers.reviewer.provider": "Who reviews (runRole review); none leaves it to the caller",
  "providers.reviewer.model": "The reviewer's model",
  "providers.reviewer.tier": "The reviewer's service tier",
  "providers.reviewer.reasoningEffort": "The reviewer's reasoning effort",
  "providers.planner.provider": "Who plans (runRole judgment); none leaves it to the caller",
  "providers.planner.model": "The planner's model",
  "providers.planner.tier": "The planner's service tier",
  "providers.planner.reasoningEffort": "The planner's reasoning effort",
  "providers.verifier.provider": "Who verifies (runRole verify); none leaves it to the caller",
  "providers.verifier.model": "The verifier's model",
  "providers.verifier.tier": "The verifier's service tier",
  "providers.verifier.reasoningEffort": "The verifier's reasoning effort",
  "providers.codex.toolSource":
    "The Codex home whose tools every Codex account gets; none is the default",
  "providers.claude.chrome": "Start Claude Code with Claude in Chrome",
  "browser.backend": "Where agents' browsers run",
  "browser.backendLoss": "What a browser does when the app that showed it closes",
  "browser.profile": "Keep a browser's cookies and storage, or open it privately",
  "browser.profileScope": "Which kept profile browsers open in",
  "browser.downloadDir": "Where ace's own Chrome saves downloads; empty uses Downloads",
  "browser.userChrome.storageReads": "Let agents read cookies and storage in your Chrome",
  "computer.blockedApps": "Apps agents may not use with computer use, comma-separated",
  "computer.lockedUse": "Let agents work while this Mac is locked",
  "spade.enabled": "Run Spade, ace's assistant (same as ace spade on|off)",
  "beta.spade": "Beta: show Spade on this machine (same as ace feature on|off spade)",
  "beta.marketplace": "Beta: ace's marketplace (same as ace feature on|off marketplace)",
  "market.askBeforeAgentPublish":
    "Ask you before an agent publishes to the market (off by default)",
  "devices.emulatorWindow": "Android emulators ace starts also open their own window",
  "media.encode": "Who encodes live video (always ace-media)",
  "media.delivery": "Who delivers live video to viewers",
  "devices.enabled": "Let ace watch and drive this machine's simulators and emulators",
  "access.defaultMode": "The access new threads start with",
  "access.nativeModes": "A provider's own permission mode instead of ace's, as a JSON file",
  "threads.useWorktree": "Start new threads in their own worktree",
  "worktree.preparationTimeoutMs": "How long Git may take to prepare a worktree, in milliseconds",
  "threads.autoSettleAfter": "Settle finished threads after this long",
  "threads.unresponsiveAfter": "Call a silent thread unresponsive after this long",
  "threads.settleOnMerge": "Settle a thread when its pull request merges",
  "threads.settleOnClose": "Settle a thread when its pull request closes",
  "threads.sortBy": "How the thread list is ordered below Pinned",
  "remote.enabled": "Remote access: your other devices may connect",
  "remote.lan": "Remote access on this computer's local network",
  "remote.tailscale": "Remote access on this computer's Tailscale address",
  "remote.relay": "Remote access through a relay",
  "remote.agentAccess": "What agents on your other machines may do here",
  "remote.agentTransfers": "Let agents move projects and threads to other machines",
  "remote.transferIgnoredFiles": "Transfers also carry files Git ignores, such as .env",
  "remote.hostedPairingLink": "Pairing links open the hosted web app",
  "remote.machineLocalhost": "Open this machine's localhost on your devices",
  "remote.relayMcp": "Outside MCP clients reach this machine through ace's relay",
  "remote.relayWebhooks": "Automation webhooks reach this machine through ace's relay",
  "remote.tailscaleWebhooks": "Automation webhooks reach this machine on Tailscale",
  "remote.publicUrlWebhooks": "Automation webhooks reach this machine at your public URL",
  "remote.tailscaleMcp": "Outside MCP clients on your tailnet reach this machine",
  "remote.mcpPublicUrl":
    "Your own public HTTPS address for outside MCP clients; none for no address",
  "remote.relayUrl": "Your own relay's address; empty uses ace's",
  "notifications.remotePush": "Wake paired phones through ace's push gateway",
  "notifications.pushGatewayUrl": "The push gateway's address",
  "automations.enabled": "Run automations",
  "agents.maxRunningChildren": "Delegated children one thread runs at once; none sets no limit",
  "generation.model": "The model for titles and commit drafts, as a JSON file; none picks one",
  "generation.autoDraftCommits": "Draft the commit message as the Commit dialog opens",
  "clients.theme": "The app's theme, as a JSON file",
  "clients.keybindings": "The app's keybindings, as a JSON file",
};

/** Keys the CLI never writes, and why: a person reading `ace config get KEY` learns it. */
export const unsettable: Readonly<Partial<Record<SettingsKey, string>>> = {
  "browser.downloadDefault": "is reported by the daemon, not set",
  "remote.transport": "is replaced by remote.lan, remote.tailscale and remote.relay",
  "threads.keepSettledFor": "is no longer read: settled threads stay in their project",
};

/** The first CLI's short names, kept as aliases for good (ADR 0178 §8). */
export const keyAliases: Readonly<Record<string, SettingsKey>> = {
  "retention-days": "storage.retentionDays",
  "log-cap": "logs.maxBytes",
  "preparation-timeout": "worktree.preparationTimeoutMs",
};

/** The variable that overrides a saved value, for the keys the daemon reads one for. */
export const settingEnv: Readonly<Partial<Record<SettingsKey, string>>> = {
  "storage.retentionDays": "ACE_RETENTION_DAYS",
  "logs.maxBytes": "ACE_LOG_MAX_BYTES",
  "worktree.preparationTimeoutMs": "ACE_WORKTREE_PREPARATION_TIMEOUT_MS",
  "notifications.pushGatewayUrl": "ACE_PUSH_GATEWAY_URL",
};
