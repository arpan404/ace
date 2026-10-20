import { agentControlToolCatalog } from "./agent-control.ts";
import { builtinToolCatalog, handoffToolCatalog } from "./catalog.ts";
import { contextToolCatalog } from "./context-tool.ts";
import { htmlToolCatalog } from "./html-tools.ts";
import { imageToolCatalog } from "./image-tools.ts";
import { knowledgeToolCatalog } from "./knowledge-tools.ts";
import { metaToolCatalog } from "./meta-tools.ts";

const catalogs: readonly (readonly { name: string; riskClass?: string | undefined }[])[] = [
  agentControlToolCatalog,
  builtinToolCatalog,
  handoffToolCatalog,
  contextToolCatalog,
  htmlToolCatalog,
  imageToolCatalog,
  knowledgeToolCatalog,
  metaToolCatalog,
];

/**
 * Bare names of the ace tools in this package's catalogues whose risk class is read-only: they
 * read and change nothing, so a provider asking before every action can let them through. The
 * guide is registered per topic list rather than from a catalogue; it only reads. Browser,
 * screen and device tools are catalogued in their own packages and are not listed here.
 */
export const readOnlyAceTools: readonly string[] = [
  "guide",
  ...catalogs.flatMap((catalog) =>
    catalog.filter((tool) => tool.riskClass === "read-only").map((tool) => tool.name),
  ),
];
