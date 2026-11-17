import { z } from "zod";
import { AccountSummary, ProviderInstance } from "./accounts.ts";
import { FleetLink } from "./fleet.ts";
import { MachineAccountStatus } from "./machine-access.ts";
import { ModelListResult } from "./models.ts";
import { OutsideAccessRequest, OutsideGrantEntry } from "./outside-clients.ts";
import { ProviderLoginProgress } from "./provider-login.ts";
import { ProviderStatus } from "./provider-status.ts";
import { Device, PairingResponse } from "./remote.ts";

/**
 * `--json` success values for providers, accounts, access and the agent tools (ADR 0176 §7),
 * by the command table's `output` key. Shapes the old commands printed are kept, so scripts
 * that parsed them keep working; fields are only added.
 */

/** `ace provider list` (`ace providers status`): the daemon's provider list as it answers. */
export const CliProviderList = z.object({
  ok: z.literal(true),
  providers: z.array(ProviderStatus),
});

/** `ace provider capabilities`: everything at once, for agents that want it. */
export const CliProviderCapabilities = z.looseObject({
  providers: z.array(ProviderStatus),
  models: z.unknown(),
  permissions: z.array(z.looseObject({ provider: z.string(), result: z.unknown() })),
  tools: z.unknown(),
});

/** `ace provider login`: signed in, or where it stopped for the person. */
export const CliProviderLogin = z.union([
  z.object({ provider: z.string(), status: z.literal("ok") }),
  ProviderLoginProgress.extend({ sessionReleased: z.literal(true) }).loose(),
]);

/** `ace provider account add`. */
export const CliAccountAdd = z.looseObject({ ok: z.boolean(), status: z.unknown() });

/** `ace remote list`: the profiles, and `local` or the profile every command goes to. */
export const CliRemoteProfile = z.looseObject({
  id: z.string(),
  name: z.string(),
  origin: z.string(),
  fingerprint: z.string(),
  deviceId: z.string(),
});
export const CliRemoteList = z.object({ active: z.string(), profiles: z.array(CliRemoteProfile) });
export const CliRemoteAdd = z.union([
  CliRemoteProfile,
  z.object({ profile: CliRemoteProfile, device: Device }),
]);

/** `ace mcp list`: where outside clients connect, and every grant. */
export const CliMcpList = z.looseObject({ url: z.string(), grants: z.array(OutsideGrantEntry) });
/** `ace mcp add`: the new grant and the snippets that set a client up. */
export const CliMcpAdd = z.looseObject({
  id: z.string(),
  expiresAt: z.number().nullable(),
  setup: z.string(),
  claude: z.string(),
  codex: z.string(),
});

/** `ace browser screenshot|record`: the file it wrote. */
export const CliBrowserArtifact = z.object({
  path: z.string(),
  mimeType: z.string(),
  artifactId: z.string(),
});

export const cliAccessOutputs = {
  "provider.list": CliProviderList,
  "provider.show": ProviderStatus,
  "provider.capabilities": CliProviderCapabilities,
  "provider.login": CliProviderLogin,
  "provider.account.list": z.array(AccountSummary.loose()),
  "provider.account.show": AccountSummary.loose(),
  "provider.account.add": CliAccountAdd,
  "provider.account.discover": z.array(ProviderInstance.loose()),
  "model.list": ModelListResult.loose(),
  "account.status": MachineAccountStatus,
  "machine.list": z.object({ machines: z.array(FleetLink) }),
  "device.list": z.array(Device),
  "device.pair": PairingResponse,
  "device.revoke": z.looseObject({ revoked: z.boolean() }),
  "remote.list": CliRemoteList,
  "remote.add": CliRemoteAdd,
  "remote.use": z.object({ active: z.string() }),
  "remote.remove": z.object({ removed: z.string() }),
  "mcp.list": CliMcpList,
  "mcp.add": CliMcpAdd,
  "mcp.revoke": z.looseObject({ revoked: z.string() }),
  "mcp.request.list": z.object({ requests: z.array(OutsideAccessRequest) }),
  "mcp.request.decide": z.object({ request: z.string(), decision: z.enum(["allow", "deny"]) }),
  "browser.artifact": CliBrowserArtifact,
  /** `ace sim …` and `ace cloud codex …` print the tool's own result. */
  "agent-tool": z.unknown(),
} satisfies Record<string, z.ZodType>;
