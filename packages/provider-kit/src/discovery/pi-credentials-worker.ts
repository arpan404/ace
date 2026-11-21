// Lists which providers the installed Pi SDK holds a credential for: ids only. The SDK reads its
// own store; no credential, token or key leaves this process.
import { silenceConsole } from "../console-guard.ts";

// Stdout carries only the listing, which the parent parses whole. SDK logs may name secrets, so
// the console is silenced before the SDK is imported.
silenceConsole();
const [entry] = process.argv.slice(2);
try {
  if (!entry?.startsWith("file:")) throw new Error("SDK entry required");
  const sdk = (await import(entry)) as {
    ModelRuntime?: { create?: (options: { refreshOnCreate: false }) => Promise<unknown> };
  };
  const factory = sdk.ModelRuntime;
  if (typeof factory?.create !== "function") throw new Error("Pi SDK without ModelRuntime");
  const runtime = (await factory.create({ refreshOnCreate: false })) as {
    listCredentials?: () => Promise<readonly { providerId?: unknown }[]>;
  };
  if (typeof runtime.listCredentials !== "function") throw new Error("Pi SDK without listing");
  const listed = await runtime.listCredentials();
  const providers = [
    ...new Set(
      listed.flatMap((credential) =>
        typeof credential.providerId === "string" ? [credential.providerId] : [],
      ),
    ),
  ];
  process.stdout.write(`${JSON.stringify({ providers })}\n`, () => process.exit(0));
} catch {
  process.exit(1);
}
