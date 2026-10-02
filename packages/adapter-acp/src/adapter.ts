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
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}
export function createAcpAdapter(
  quirks: AcpQuirks = genericQuirks,
  options: AdapterOptions = {},
): ProviderAdapter {
  return {
    provider: quirks.provider,
    capabilities: (cli) =>
      cli.installed ? quirks.capabilities(cli.version) : genericQuirks.capabilities(),
    createTranslator: (init) =>
      createAcpTranslator(
        { ...init, identity: options.identity?.() ?? createTranslatorIdentity(randomUUID()) },
        quirks,
      ),
    async openSession(ctx) {
      const command = options.command ?? quirks.command;
      if (!command) throw new Error("A generic ACP adapter requires a user-installed command");
      const path =
        quirks.provider === "cursor"
          ? (
              await discoverProviders({
                overrides: { cursor: command },
                ...(options.env ? { env: options.env } : {}),
              })
            ).cursor.path
          : await findExecutable(
              command,
              options.env ? { ...process.env, ...options.env } : process.env,
            );
      if (!path) throw new Error(`Installed ACP CLI not found: ${command}`);
      return openAcpSession(ctx, quirks, {
        command: path,
        args: options.args ?? quirks.args,
        ...(options.env ? { env: options.env } : {}),
      });
    },
  };
}
export const cursorAdapter = createAcpAdapter(cursorQuirks);
export const antigravityAdapter = createAcpAdapter(antigravityQuirks);
export const adapter = cursorAdapter;
