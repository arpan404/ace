import type { LaunchPlan } from "@ace/agent-registry";
import { randomUUID } from "node:crypto";
import { createTranslatorIdentity, type TranslatorIdentity } from "./identity.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { discoverProviders, findExecutable } from "@ace/provider-kit/discovery";
import { cursorQuirks } from "./quirks/cursor.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { openAcpSession } from "./session.ts";
import { createAcpTranslator } from "./translator.ts";
export interface AdapterOptions {
  identity?(): TranslatorIdentity;
  acceptsIdentity?: NonNullable<ProviderAdapter["acceptsIdentity"]>;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  resolveLaunch?(ctx: import("@ace/engine-api").SessionContext): Promise<LaunchPlan>;
}
export function createAcpAdapter(
  quirks: AcpQuirks = genericQuirks,
  options: AdapterOptions = {},
): ProviderAdapter {
  return {
    provider: quirks.provider,
    ...(options.acceptsIdentity ? { acceptsIdentity: options.acceptsIdentity } : {}),
    capabilities: (cli) =>
      cli.installed ? quirks.capabilities(cli.version) : genericQuirks.capabilities(),
    createTranslator: (init) => {
      const translator = createAcpTranslator(
        { ...init, identity: options.identity?.() ?? createTranslatorIdentity(randomUUID()) },
        quirks,
      );
      if (!init.acpIdentity) return translator;
      const identity = init.acpIdentity;
      const identify = (facts: ReturnType<typeof translator.translate>) =>
        facts.map((fact) =>
          fact.type === "agent.seen" && fact.native
            ? { ...fact, native: { ...fact.native, ...identity } }
            : fact,
        );
      return {
        translate: (frame, now) => identify(translator.translate(frame, now)),
        tick: (now) => identify(translator.tick(now)),
        ...(translator.nextDeadline ? { nextDeadline: () => translator.nextDeadline?.() } : {}),
      };
    },
    async openSession(ctx) {
      if (options.resolveLaunch) {
        const plan = await options.resolveLaunch(ctx);
        return openAcpSession(ctx, quirks, {
          command: plan.command,
          args: [...plan.args],
          env: { ...ctx.env, ...plan.env },
          version: plan.version,
          ...(plan.profile ? { profile: plan.profile } : {}),
        });
      }
      const command = options.command ?? quirks.command;
      if (!command) throw new Error("A generic ACP adapter requires a user-installed command");
      let path: string | undefined;
      let version: string | undefined;
      if (quirks.provider === "cursor") {
        const cli = (
          await discoverProviders({
            overrides: { cursor: command },
            ...(options.env ? { env: options.env } : {}),
          })
        ).cursor;
        path = cli.path;
        version = cli.version;
      } else {
        path = await findExecutable(
          command,
          options.env ? { ...process.env, ...options.env } : process.env,
        );
      }
      if (!path) throw new Error(`Installed ACP CLI not found: ${command}`);
      return openAcpSession(ctx, quirks, {
        command: path,
        args: options.args ?? quirks.args,
        env: { ...options.env, ...ctx.env },
        ...(version ? { version } : {}),
      });
    },
  };
}
export const cursorAdapter = createAcpAdapter(cursorQuirks);
export const antigravityAdapter = createAcpAdapter(antigravityQuirks);
export const adapter = cursorAdapter;
