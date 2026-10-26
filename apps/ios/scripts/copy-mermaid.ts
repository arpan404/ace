import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies mermaid's standalone build into the app's resources, where the forge pages draw
 * diagrams offline in a sandboxed web view (`ForgeMermaidView`). The copy is generated, never
 * committed:
 *
 *   bun scripts/copy-mermaid.ts
 */
const source = fileURLToPath(import.meta.resolve("mermaid/dist/mermaid.min.js"));
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "Resources", "mermaid.js");
await copyFile(source, target);
console.log(`Copied mermaid to ${target}`);
