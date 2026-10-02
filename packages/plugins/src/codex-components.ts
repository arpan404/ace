import { createHash } from "node:crypto";
import { join } from "node:path";
import { body, outputFile, override, toml } from "./project-shared.ts";
import type { PluginProjection } from "./types.ts";

export function codexCommand(
  plugin: string,
  name: string,
  content: string,
  description: string,
  base: string,
  occupied: Set<string>,
  projection: PluginProjection,
): void {
  const identity = `ace-${plugin}-command-${name}`;
  const prefix = identity.replace(/[^a-z0-9]+/g, "-");
  let skill = prefix.slice(0, 64);
  if (prefix !== identity || prefix.length > 64 || occupied.has(skill)) {
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    skill = `${prefix.slice(0, 51).replace(/-+$/, "")}-${hash}`;
  }
  if (occupied.has(skill)) throw new Error("Command skill name collision");
  occupied.add(skill);
  const summary = (description.trim() || name).slice(0, 1024).replace(/[\uD800-\uDBFF]$/u, "");
  projection.files.push(
    outputFile(
      `${base}/skills/${skill}/SKILL.md`,
      `---\nname: ${skill}\ndescription: ${JSON.stringify(summary)}\n---\nTreat $ARGUMENTS as the text supplied with this skill invocation.\n\n${body(content)}`,
    ),
  );
  projection.files.push(
    outputFile(
      `${base}/skills/${skill}/agents/openai.yaml`,
      "policy:\n  allow_implicit_invocation: false\n",
    ),
  );
}
export function codexAgent(
  plugin: string,
  name: string,
  content: string,
  description: string,
  base: string,
  root: string,
  projection: PluginProjection,
): void {
  const path = `${base}/agents/${name}.toml`;
  projection.files.push(
    outputFile(
      path,
      `name=${toml(`ace-${plugin}__${name}`)}\ndescription=${toml(description)}\ndeveloper_instructions=${toml(body(content))}\n`,
    ),
  );
  override(
    projection,
    `agents.${JSON.stringify(`ace-${plugin}__${name}`)}.config_file`,
    join(root, path),
  );
  override(
    projection,
    `agents.${JSON.stringify(`ace-${plugin}__${name}`)}.description`,
    description,
  );
}
