import { instanceEnv } from "@ace/accounts";
import { logFields } from "@ace/diagnostics";
import type { UtilityModel } from "@ace/models";
import type { CatalogModel, ModelListResult, ProviderKind } from "@ace/protocol";
import { discoverProvider, findExecutable } from "@ace/provider-kit/discovery";
import { createUtilityCli, type UtilityCli, type UtilityLaunch } from "../utility-cli.ts";
import { createUtility } from "../utility-models.ts";
import type { ServiceContext } from "./types.ts";

export type { UtilityService } from "../utility-models.ts";
export interface UtilityDaemonOptions {
  /** The one-shot runner, replaced by scripted providers in tests. */
  run?: UtilityCli;
  /** Where each provider's CLI is; the default finds the person's installed CLI. */
  locate?(target: UtilityModel, signal: AbortSignal): Promise<UtilityLaunch | undefined>;
}

/** The person's installed CLI for a provider and the environment that selects its account. */
async function locateCli(
  context: ServiceContext,
  target: UtilityModel,
  signal: AbortSignal,
): Promise<UtilityLaunch | undefined> {
  const { services } = context;
  const configuration = services.providerConfigurations?.for(target.provider, target.instance);
  if (configuration?.enabled === false) return undefined;
  const account = target.instance
    ? services.accountRegistry?.get(target.instance)?.instance
    : undefined;
  const env = account ? instanceEnv(account, process.env) : { ...process.env };
  const binary = configuration?.binaryPath;
  if (
    target.provider === "claude" ||
    target.provider === "codex" ||
    target.provider === "opencode"
  ) {
    const cli = await discoverProvider(target.provider, {
      signal,
      env,
      ...(binary ? { overrides: { [target.provider]: binary } } : {}),
    });
    if (!cli.installed || !cli.path) return undefined;
    if (target.provider !== "opencode" && cli.auth === "logged_out") return undefined;
    return { path: cli.path, env };
  }
  const command =
    target.provider === "pi"
      ? (binary ?? context.options.pi?.executable ?? "pi")
      : target.provider === "cursor"
        ? "cursor-agent"
        : undefined;
  const path = command ? await findExecutable(command, env) : undefined;
  return path ? { path, env } : undefined;
}

function catalog(context: ServiceContext, provider: ProviderKind): CatalogModel[] {
  const models: CatalogModel[] = [];
  let offset: number | undefined = 0;
  const list = context.services.models;
  if (!list) return models;
  // Three pages cover every provider's catalog; the fallbacks are near the top.
  for (let page = 0; page < 3 && offset !== undefined; page++) {
    const result: ModelListResult = list.list({ provider, offset, limit: 100 });
    models.push(...result.models);
    offset = result.nextOffset;
  }
  return models;
}

/** Titles and commit/PR drafts on the person's utility model, stored per daemon. */
export function startUtility(context: ServiceContext): void {
  const { services, options, store, resources, now, log } = context;
  const run =
    options.utility?.run ??
    createUtilityCli({
      locate: options.utility?.locate ?? ((target, signal) => locateCli(context, target, signal)),
      ...(options.engine?.clock ? { clock: options.engine.clock } : {}),
    });
  const utility = createUtility({
    settings: services.settings,
    statuses: () => services.providerStatuses?.list() ?? [],
    models: (provider) => catalog(context, provider),
    run,
    store,
    now,
    onTitleFailure: (thread, error) =>
      log.log(
        "debug",
        "Thread title generation skipped",
        logFields([
          ["thread", thread],
          ["error", error instanceof Error ? error.message : "unknown"],
        ]),
      ),
  });
  resources.own(() => utility.titles.close());
  services.utility = utility;
}
