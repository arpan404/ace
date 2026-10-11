import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SettingsService } from "@ace/settings";
import { createLogger } from "@ace/diagnostics";
import { nodeBinary } from "@ace/provider-kit/testing";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderLoginProgress } from "@ace/protocol";
import type { DiscoverModels } from "@ace/models";
import { harness } from "./account-management-test-support.ts";
import { ProviderConfigurationsState } from "./provider-configurations.ts";
import { startProviderLogin } from "./services/provider-login.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { readConfig } from "./config.ts";

/** Real stores and production login wiring; only provider executables are controlled fixtures. */
export async function nativeLoginHarness(
  provider: "codex" | "opencode",
  discover?: DiscoverModels,
) {
  const f = await harness(false, discover ? { discover } : {});
  const resources = new Resources();
  const log = createLogger({
    now: () => 100,
    redact: (line) => line,
    sink: { write: async () => {}, close: async () => {} },
  });
  const account = await f.add(provider);
  const instance = f.registry.get(account.id)?.instance;
  if (!instance) throw new Error("Missing managed account");
  f.registry.selectProvider(provider, instance.id);
  f.registry.ingest(instance.id, {
    provider,
    payload: new ProviderPayload('{"auth":"logged_out"}'),
    observedAt: 100,
    timeZone: "UTC",
  });
  const bin = join(f.root, "custom");
  await mkdir(bin);
  const executable = await nodeBinary(
    bin,
    provider,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const home = process.env.HOME;
const signedIn = () => fs.existsSync(home + '/cli-credential');
if (args[0] === '--version') console.log(${JSON.stringify(provider === "codex" ? "codex-cli 0.159.1" : "2.0.22")});
else if (args.includes('--help')) console.log('login logout --with-api-key --device-auth --provider --method');
else if (args.join(' ') === 'login status' || args.includes('list')) console.log(${provider === "codex" ? "signedIn() ? 'Logged in using ChatGPT' : 'Not logged in'" : "signedIn() ? '1 credential' : 'No authenticated integrations'"});
else if (args[0] === 'app-server') readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === 'model/list' ? {data:[{id:'fixture',model:'configured-login-model',displayName:'Fixture',isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'high'}],nextCursor:null} : {};
  console.log(JSON.stringify({id:request.id,result}));
});
else {
  fs.writeFileSync(home + '/login-started', 'controlled process launched');
  if (args.includes('--with-api-key') || args.includes('Manually enter API Key')) {
    let key = ''; process.stdin.on('data', chunk => key += chunk);
    process.stdin.on('end', () => { fs.writeFileSync(home + '/cli-credential', key.trim()); });
  } else {
    console.log('Open https://auth.openai.com/codex/device\\nEnter code: ABCD-12345\\nPress Enter to continue.');
    readline.createInterface({input:process.stdin}).on('line', () => { fs.writeFileSync(home + '/cli-credential', 'browser login'); process.exit(0); });
  }
}
`,
  );
  const replacement = await nodeBinary(
    bin,
    "replacement",
    `
if (process.argv.includes('--version')) console.log(${JSON.stringify(provider === "codex" ? "codex-cli 0.159.1" : "2.0.22")});
else console.log(${JSON.stringify(provider === "codex" ? "Not logged in" : "No authenticated integrations")});
`,
  );
  const settings = new SettingsService({ dataDir: f.dataDir });
  resources.own(() => settings.close());
  await settings.set(
    "providers.configuration",
    [{ provider, instance: instance.id, binaryPath: executable }],
    { kind: "global" },
  );
  const configurations = new ProviderConfigurationsState();
  resources.own(await configurations.start(settings));
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: f.dataDir }),
    signal: new AbortController().signal,
    options: {
      accounts: { env: { ...f.env } },
      providerStatus: {
        env: f.env,
        versions: async () => ({}),
        cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "" }),
      },
    },
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
    id: () => "native-login",
    onListen: [],
  };
  await startProviderLogin(context);
  const sessions = context.services.providerLogin;
  if (!sessions) throw new Error("Missing login sessions");
  const events: ProviderLoginProgress[] = [];
  const waiters = new Map<string, (() => void)[]>();
  sessions.listen((_owner, progress) => {
    events.push(progress);
    for (const resolve of waiters.get(progress.state) ?? []) resolve();
    waiters.delete(progress.state);
  });
  return {
    f,
    instance,
    executable,
    replacement,
    settings,
    context,
    sessions,
    events,
    wait(state: ProviderLoginProgress["state"]) {
      if (events.some((event) => event.state === state)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.set(state, [...(waiters.get(state) ?? []), resolve]);
      });
    },
    async configure(update: { binaryPath?: string; enabled?: boolean }) {
      await settings.set(
        "providers.configuration",
        [{ provider, instance: instance.id, binaryPath: executable, ...update }],
        { kind: "global" },
      );
    },
    async start(method: "login" | "api_key") {
      const result = await sessions.handle("owner", {
        type: "provider.login.start",
        requestId: "start",
        provider,
        instance: instance.id,
        method,
        ...(provider === "opencode" && method === "api_key" ? { upstream: "openai" } : {}),
      });
      if (!result.result.ok) throw new Error("Login not admitted");
      return result.result.progress.session;
    },
    async close() {
      await resources.close();
      await log.close();
      await f.close();
    },
  };
}
