import { z } from "zod";

// The installed SDK owns all credential access and persistence in this isolated child.
// Neither its return value nor its diagnostics leave the process. An API key arrives on stdin
// and goes straight to the SDK's own prompt; it is never written anywhere by this worker.
const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_url"), url: z.string().max(8192) }),
  z.object({
    type: z.literal("device_code"),
    verificationUri: z.string().max(8192),
    userCode: z.string().max(32),
  }),
  z.object({ type: z.literal("progress") }),
  z.object({ type: z.literal("info") }),
]);
const Prompt = z.object({
  type: z.enum(["text", "secret", "select", "manual_code"]),
  options: z.array(z.object({ id: z.string() })).optional(),
  signal: z.instanceof(AbortSignal).optional(),
});
interface Interaction {
  signal: AbortSignal;
  notify(event: unknown): void;
  prompt(prompt: unknown): Promise<string>;
}
interface Runtime {
  login(
    provider: string,
    type: "oauth" | "api_key",
    interaction: Interaction,
    options?: { getDeviceId?: () => string },
  ): Promise<unknown>;
  logout(provider: string, options: { signal: AbortSignal }): Promise<void>;
  getProviders?: () => readonly unknown[];
  listCredentials?: () => Promise<readonly unknown[]>;
}
const Runtime = z.object({
  login: z.custom<Runtime["login"]>((value) => typeof value === "function"),
  logout: z.custom<Runtime["logout"]>((value) => typeof value === "function"),
});
const callable = (value: unknown) => typeof value === "function" || typeof value === "object";
const Module = z.object({
  ModelRuntime: z.custom<{ create(options: { refreshOnCreate: false }): Promise<unknown> }>(
    (value) => callable(value) && value !== null && typeof Object(value).create === "function",
  ),
  // Pi's own settings own the installation id OpenAI's sign-in identifies the host by.
  SettingsManager: z
    .custom<{ create(cwd: string): { getOrCreateDeviceId(): string } }>(
      (value) => callable(value) && value !== null && typeof Object(value).create === "function",
    )
    .optional()
    .catch(undefined),
});
const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const Args = z.union([
  z.tuple([z.url().refine((url) => url.startsWith("file:")), z.literal("providers")]),
  z.tuple([
    z.url().refine((url) => url.startsWith("file:")),
    z.enum(["login", "logout", "api_key"]),
    ProviderId,
  ]),
]);
/** Only names and which sign-ins exist leave; never a credential. */
const ProviderInfo = z
  .object({
    id: ProviderId,
    name: z.string().max(128),
    auth: z
      .object({
        oauth: z
          .object({ name: z.string().max(128).catch("") })
          .optional()
          .catch(undefined),
      })
      .catch({}),
  })
  .passthrough();
const signal = new AbortController();
process.once("SIGTERM", () => signal.abort());
process.once("SIGINT", () => signal.abort());
const send = (value: unknown) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
async function readKey(): Promise<string> {
  let key = "";
  for await (const chunk of process.stdin) {
    key += String(chunk);
    if (key.length > 16384) throw new Error("Key too long");
  }
  return key.trim();
}
try {
  const args = Args.parse(process.argv.slice(2));
  const sdk = Module.parse(await import(args[0]));
  const native = await sdk.ModelRuntime.create({ refreshOnCreate: false });
  const runtime = Runtime.parse(native);
  const methods = native as Runtime;
  if (args[1] === "providers") {
    const providers =
      typeof methods.getProviders === "function"
        ? methods.getProviders.call(native).flatMap((entry) => {
            const parsed = ProviderInfo.safeParse(entry);
            return parsed.success
              ? [
                  {
                    id: parsed.data.id,
                    name: parsed.data.name,
                    ...(parsed.data.auth.oauth ? { oauth: parsed.data.auth.oauth.name } : {}),
                  },
                ]
              : [];
          })
        : undefined;
    const signedIn =
      typeof methods.listCredentials === "function"
        ? (await methods.listCredentials.call(native)).flatMap((credential) => {
            const id = ProviderId.safeParse(Object(credential).providerId);
            return id.success ? [id.data] : [];
          })
        : undefined;
    await send({
      type: "providers",
      ...(providers ? { providers } : {}),
      ...(signedIn ? { signedIn: [...new Set(signedIn)] } : {}),
    });
    process.exit(0);
  }
  const [, action, provider] = args;
  if (action === "logout") await runtime.logout.call(native, provider, { signal: signal.signal });
  else if (action === "api_key") {
    const key = await readKey();
    if (!key) throw new Error("Empty key");
    await runtime.login.call(native, provider, "api_key", {
      signal: signal.signal,
      notify() {},
      async prompt(value) {
        if (Prompt.parse(value).type === "secret") return key;
        throw new Error("Unsupported Pi key prompt");
      },
    });
  } else {
    const settings = sdk.SettingsManager?.create(process.cwd());
    await runtime.login.call(
      native,
      provider,
      "oauth",
      {
        signal: signal.signal,
        notify(value) {
          const event = Event.parse(value);
          if (event.type === "auth_url" || event.type === "device_code") void send(event);
        },
        async prompt(value) {
          const prompt = Prompt.parse(value);
          if (prompt.type === "select") {
            // Codex's legacy flow signs in anywhere with a device code; others use their browser.
            const method = provider === "openai-codex" ? "device_code" : "browser";
            if (prompt.options?.some((option) => option.id === method)) return method;
          }
          // Pi's Copilot flow asks for an optional enterprise host; use GitHub.com.
          if (provider === "github-copilot" && prompt.type === "text") return "";
          if (prompt.type === "manual_code") {
            // Browser flows race this optional fallback against their own local callback server.
            // Keep the fallback pending; the SDK cancels it when the browser callback wins.
            return new Promise<string>((_resolve, reject) => {
              const pending = prompt.signal ?? signal.signal;
              const cancel = () => reject(new Error("Cancelled"));
              pending.addEventListener("abort", cancel, { once: true });
              if (pending.aborted) cancel();
            });
          }
          throw new Error("Unsupported Pi login prompt");
        },
      },
      settings ? { getDeviceId: () => settings.getOrCreateDeviceId() } : {},
    );
  }
  await send({ type: "complete" });
  process.exit(0);
} catch {
  process.exit(1);
}
