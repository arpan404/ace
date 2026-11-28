import { Script } from "node:vm";
import { fileURLToPath } from "node:url";

export async function buildBridge(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../bridge/main.ts", import.meta.url))],
    target: "browser",
    format: "iife",
    minify: true,
    // The editor's generated loader has a module-relative fallback. iOS supplies the bytes.
    define: { "import.meta.url": JSON.stringify("file:///client.js") },
  });
  const output = built.outputs[0];
  if (!built.success || !output) throw new AggregateError(built.logs, "The bridge didn't build");
  const source = await output.text();
  // JSContext loads a script. Bun also emits module-only syntax unless it is replaced above.
  void new Script(source, { filename: "client.js" });
  return source;
}

if (import.meta.main) {
  await Bun.write(new URL("../Resources/client.js", import.meta.url), await buildBridge());
}
