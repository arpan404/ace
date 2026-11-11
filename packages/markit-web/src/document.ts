import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * markit's parsed document, outside the browser: the daemon reads what an answer links with the
 * same parser and flavour the web renders answers with, so the two agree on every link. The
 * Wasm loads on first use. The release bundle ships `markit_wasm_bg.wasm` beside the code and
 * rewrites the path below (tools/release/src/bundle.ts).
 */
const wasm = new URL("../../markit/web/pkg/markit_wasm_bg.wasm", import.meta.url);

const Span = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  kind: z.string(),
  url: z.string().optional(),
  target: z.string().optional(),
  reference_kind: z.string().optional(),
});
/** The parts of markit's document JSON ace reads. Offsets are UTF-16, as JavaScript slices. */
export const MarkitDocument = z.object({ text: z.string(), spans: z.array(Span) });
export type MarkitDocument = z.infer<typeof MarkitDocument>;
export type MarkitFlavor = "default" | "github" | "agent";

type Render = (source: string, flavor: MarkitFlavor) => string;
let engine: Promise<Render> | undefined;
function load(): Promise<Render> {
  engine ??= Promise.all([
    import("../../markit/web/pkg/markit_wasm.js"),
    readFile(fileURLToPath(wasm)),
  ]).then(
    ([glue, bytes]) => {
      glue.initSync({ module: bytes });
      return glue.renderDocumentFlavor;
    },
    (error: unknown) => {
      // A failed load is tried again by the next call rather than failing every later one.
      engine = undefined;
      throw error;
    },
  );
  return engine;
}

/** Parses `source` as markit does. The first call loads the engine. */
export async function markitDocument(
  source: string,
  flavor: MarkitFlavor,
): Promise<MarkitDocument> {
  const render = await load();
  return MarkitDocument.parse(JSON.parse(render(source, flavor)));
}
