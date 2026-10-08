import { z } from "zod";

// The installed SDK owns all credential access and persistence in this isolated child.
// Neither its return value nor its diagnostics leave the process.
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
  login(provider: string, type: "oauth", interaction: Interaction): Promise<unknown>;
  logout(provider: string, options: { signal: AbortSignal }): Promise<void>;
}
const Runtime = z.object({
  login: z.custom<Runtime["login"]>((value) => typeof value === "function"),
  logout: z.custom<Runtime["logout"]>((value) => typeof value === "function"),
});
interface Factory {
  create(options: { refreshOnCreate: false }): Promise<unknown>;
}
const Module = z.object({
  ModelRuntime: z.custom<Factory>(
    (value) =>
      (typeof value === "function" || typeof value === "object") &&
      value !== null &&
      "create" in value &&
      typeof value.create === "function",
  ),
});
const Args = z.tuple([
  z.url().refine((url) => url.startsWith("file:")),
  z.enum(["github-copilot", "openai-codex", "anthropic"]),
  z.enum(["login", "logout"]),
]);
const signal = new AbortController();
process.once("SIGTERM", () => signal.abort());
process.once("SIGINT", () => signal.abort());
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const [entry, provider, action] = Args.parse(process.argv.slice(2));
  const sdk = Module.parse(await import(entry));
  const native = await sdk.ModelRuntime.create({ refreshOnCreate: false });
  const runtime = Runtime.parse(native);
  if (action === "logout") await runtime.logout.call(native, provider, { signal: signal.signal });
  else
    await runtime.login.call(native, provider, "oauth", {
      signal: signal.signal,
      notify(value) {
        const event = Event.parse(value);
        if (event.type === "auth_url" || event.type === "device_code") send(event);
      },
      async prompt(value) {
        const prompt = Prompt.parse(value);
        if (prompt.type === "select") {
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
    });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify({ type: "complete" })}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(0);
} catch {
  process.exit(1);
}
