import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { createLogger } from "@ace/diagnostics";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { nodeBinary } from "@ace/provider-kit/testing";
import { probeOutput } from "@ace/provider-kit/process";
import { harness } from "./account-management-test-support.ts";
import { ProviderConfigurationsState } from "./provider-configurations.ts";
import { startProviderLogin } from "./services/provider-login.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { readConfig } from "./config.ts";

const cases = [
  ...["preparation", "login", "completion"].flatMap((phase) =>
    ["binary path", "disabled", "login revision"].map((change) => ({ phase, change })),
  ),
  { phase: "completion", change: "unchanged" },
];

test.each(cases)(
  "native login respects $change changes during $phase without committing stale auth or models",
  async ({ phase, change }) => {
    const f = await harness();
    const resources = new Resources();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const log = createLogger({
      now: () => 100,
      redact: (value) => value,
      sink: { write: async () => {}, close: async () => {} },
    });
    try {
      const account = await f.add();
      const instance = f.registry.get(account.id)?.instance;
      if (!instance) throw new Error("Missing managed account");
      f.registry.ingest(instance.id, {
        provider: "codex",
        payload: new ProviderPayload('{"auth":"logged_out"}'),
        observedAt: 100,
        timeZone: "UTC",
      });
      const bin = join(f.root, "custom");
      await mkdir(bin);
      const executable = await nodeBinary(
        bin,
        "codex",
        `
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const marker = process.env.CODEX_HOME + '/configured-login-ran';
if (args[0] === '--version') console.log('codex-cli 0.159.1');
else if (args.includes('--help')) console.log('Usage: codex login --device-auth');
else if (args.join(' ') === 'login status') console.log(fs.existsSync(marker) ? 'Logged in using ChatGPT' : 'Not logged in');
else if (args[0] === 'app-server') readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'model/list' ? {data:[{id:'fixture',model:'configured-login-model',displayName:'Fixture',isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'high'}],nextCursor:null} : {};
  console.log(JSON.stringify({id:request.id,result}));
});
else if (args[0] === 'login') {
  console.log('Open https://auth.openai.com/codex/device\\nEnter code: ABCD-12345\\nPress Enter to continue.');
  readline.createInterface({input:process.stdin}).on('line', () => {fs.writeFileSync(marker, 'controlled login completed'); process.exit(0);});
} else throw new Error('Unexpected fixture command');
`,
      );
      const replacement = await nodeBinary(
        bin,
        "other-codex",
        `
if (process.argv.includes('--version')) console.log('codex-cli 0.159.1');
else console.log('Not logged in');
`,
      );
      const settings = new SettingsService({ dataDir: f.dataDir });
      resources.own(() => settings.close());
      await settings.set(
        "providers.configuration",
        [{ provider: "codex", instance: instance.id, binaryPath: executable }],
        { kind: "global" },
      );
      const configurations = new ProviderConfigurationsState();
      resources.own(await configurations.start(settings));
      let completing = false;
      const context: ServiceContext = {
        config: readConfig({ ACE_HOME: f.dataDir }),
        options: {
          accounts: {
            env: f.env,
            discovery: {
              async probe(path, args, options) {
                const result = await probeOutput(path, args, options);
                if (
                  args.join(" ") === "login status" &&
                  ((phase === "preparation" && !completing) ||
                    (phase === "completion" && completing))
                ) {
                  entered.resolve();
                  await release.promise;
                }
                return result;
              },
            },
          },
        },
        signal: new AbortController().signal,
        services: {
          accountRegistry: f.registry,
          accounts: f.accounts,
          models: f.models,
          providerConfigurations: configurations,
        },
        store: f.store,
        resources,
        log,
        now: () => 100,
        id: () => "guarded-login",
        onListen: [],
      };
      await startProviderLogin(context);
      const sessions = context.services.providerLogin;
      if (!sessions) throw new Error("Missing login service");
      sessions.listen((_owner, progress) => {
        if (progress.state === "awaiting_input") waiting.resolve();
      });
      const started = await sessions.handle("owner", {
        type: "provider.login.start",
        requestId: "start",
        provider: "codex",
        instance: instance.id,
      });
      if (!started.result.ok) throw new Error("Login was not admitted");
      const session = started.result.progress.session;
      if (phase === "preparation") await entered.promise;
      else {
        await waiting.promise;
        completing = true;
        if (phase === "completion") {
          await sessions.handle("owner", {
            type: "provider.login.input",
            requestId: "finish",
            session,
            input: { confirm: true },
          });
          await entered.promise;
        }
      }
      if (change === "login revision") f.registry.loginChanged(instance.id);
      else if (change !== "unchanged")
        await settings.set(
          "providers.configuration",
          [
            {
              provider: "codex",
              instance: instance.id,
              binaryPath: change === "binary path" ? replacement : executable,
              enabled: change !== "disabled",
            },
          ],
          { kind: "global" },
        );
      const revision = f.registry.get(instance.id)?.instance.loginRevision;
      release.resolve();
      if (phase === "login")
        await sessions.handle("owner", {
          type: "provider.login.input",
          requestId: "finish",
          session,
          input: { confirm: true },
        });
      const completed = await sessions.completed("owner", session);
      expect(completed.state).toBe(change === "unchanged" ? "succeeded" : "failed");
      expect(f.registry.summary(instance.id, 100)?.quota.auth).toBe(
        change === "unchanged" ? "logged_in" : "logged_out",
      );
      expect(f.models.hasInstance(instance.id)).toBe(change === "unchanged");
      if (change === "unchanged") {
        expect(
          f.models.list({ instance: instance.id }).models.map((model) => model.nativeModelId),
        ).toContain("configured-login-model");
        expect(f.registry.get(instance.id)?.instance.loginRevision).not.toBe(revision);
      } else expect(f.registry.get(instance.id)?.instance.loginRevision).toBe(revision);
      if (phase === "preparation" || phase === "login")
        await expect(
          readFile(join(instance.homeDir, "configured-login-ran")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      else
        expect(await readFile(join(instance.homeDir, "configured-login-ran"), "utf8")).toBe(
          "controlled login completed",
        );
      expect(f.accounts.isChangingAccount(instance.id)).toBe(false);
    } finally {
      release.resolve();
      await resources.close();
      await log.close();
      await f.close();
    }
  },
);
