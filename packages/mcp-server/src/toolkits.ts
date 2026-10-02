import type { z } from "zod";
import type { ToolContext, ToolDefinition, ToolRegistry } from "./registry.ts";

export interface Toolkit {
  register(registry: ToolRegistry): void;
}
export interface AutomationAdapter<I, O> {
  execute(input: I, context: ToolContext): Promise<O>;
}
/** Browser/preview owners supply schemas and operations; no automation implementation lives here. */
export function registerAutomationTool<I extends z.ZodObject, O extends z.ZodObject>(
  registry: ToolRegistry,
  definition: Omit<ToolDefinition<I, O>, "run" | "capability"> & {
    capability: "browser" | "preview";
  },
  adapter: AutomationAdapter<z.output<I>, z.input<O>>,
): void {
  registry.register({ ...definition, run: (input, context) => adapter.execute(input, context) });
}
export interface BrowserToolkit extends Toolkit {
  readonly capability: "browser";
}
export interface PreviewToolkit extends Toolkit {
  readonly capability: "preview";
}
