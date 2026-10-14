import type { ListedTool } from "./agent.ts";
import { estimateTokens, type TaskMetrics } from "./trace.ts";

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly gate: boolean;
  /** Absent when the task could not run here, such as no Chromium for the browser task. */
  readonly metrics?: TaskMetrics;
  readonly note: string;
}
export interface CatalogueMetrics {
  readonly tools: number;
  /** Full `tools/list` JSON: descriptors, schemas, annotations and metadata. */
  readonly toolsListBytes: number;
  /** What a model reads per tool: name, description and input schema. */
  readonly descriptorBytes: number;
  readonly outputSchemaBytes: number;
  readonly largestOutputSchemas: readonly { name: string; bytes: number }[];
  readonly readOnlyWithoutHint: readonly string[];
  /** Instruction bytes each provider receives across every channel ace uses for it. */
  readonly instructionBytes: Readonly<Record<string, number>>;
}
export interface EvalReport {
  readonly label: string;
  readonly tasks: readonly TaskRow[];
  /** Absent when a filtered run skipped the catalogue measurement. */
  readonly catalogue?: CatalogueMetrics | undefined;
}

const bytes = (value: unknown) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

export function measureCatalogue(
  tools: readonly ListedTool[],
  instructionBytes: Record<string, number>,
): CatalogueMetrics {
  const outputs = tools
    .map((tool) => ({ name: tool.name, bytes: tool.outputSchema ? bytes(tool.outputSchema) : 0 }))
    .toSorted((a, b) => b.bytes - a.bytes);
  return {
    tools: tools.length,
    toolsListBytes: bytes({ tools }),
    descriptorBytes: bytes(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
    outputSchemaBytes: outputs.reduce((sum, entry) => sum + entry.bytes, 0),
    largestOutputSchemas: outputs.slice(0, 3),
    readOnlyWithoutHint: tools
      .filter((tool) => tool["_meta"]?.["ace/riskClass"] === "read-only")
      .filter((tool) => tool.annotations?.["readOnlyHint"] !== true)
      .map((tool) => tool.name),
    instructionBytes,
  };
}

const kb = (value: number) => `${(value / 1024).toFixed(1)} KB`;
const cell = (metrics: TaskMetrics | undefined, pick: (metrics: TaskMetrics) => number | string) =>
  metrics ? String(pick(metrics)) : "n/a";

export function renderMarkdown(report: EvalReport): string {
  const lines = [
    `# ace MCP eval: ${report.label}`,
    "",
    "Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.",
    "Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.",
    "",
    "| Task | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note |",
    "| --- | :-: | :-: | --: | --: | --: | --: | --: | --: | --- |",
    ...report.tasks
      .map((task) =>
        [
          task.id,
          task.gate ? "hard" : "",
          cell(task.metrics, (m) => (m.success ? "yes" : "no")),
          cell(task.metrics, (m) => m.aceCalls),
          cell(task.metrics, (m) => m.ownToolCalls),
          cell(task.metrics, (m) => m.failedCalls),
          cell(task.metrics, (m) => m.identicalRetries),
          cell(task.metrics, (m) => m.turns),
          cell(task.metrics, (m) => m.tokens.toLocaleString("en-US")),
          task.note.replaceAll("|", "\\|"),
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
    "",
    ...(report.catalogue ? renderCatalogue(report.catalogue) : []),
  ];
  return lines.join("\n");
}

function renderCatalogue(catalogue: CatalogueMetrics): string[] {
  return [
    "| Catalogue (full-access thread, Claude delivery) | Value |",
    "| --- | --: |",
    `| Tools listed | ${catalogue.tools} |`,
    `| tools/list bytes | ${kb(catalogue.toolsListBytes)} |`,
    `| Descriptor bytes (name, description, input schema) | ${kb(catalogue.descriptorBytes)} (~${estimateTokens(catalogue.descriptorBytes).toLocaleString("en-US")} tokens) |`,
    `| Output schema bytes | ${kb(catalogue.outputSchemaBytes)} |`,
    ...catalogue.largestOutputSchemas.map(
      (entry) => `| Largest output schema: ${entry.name} | ${kb(entry.bytes)} |`,
    ),
    `| Read-only tools without readOnlyHint | ${catalogue.readOnlyWithoutHint.length} |`,
    ...Object.entries(catalogue.instructionBytes).map(
      ([provider, size]) =>
        `| Instructions delivered to ${provider} | ${size.toLocaleString("en-US")} B |`,
    ),
    "",
  ];
}
