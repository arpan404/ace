import { z } from "zod";
import { ForgeCreatePrInput } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

/** Render reviewed thread text once, with identical validation for every host. */
export function prCreateText(threadId: string, input: ForgeCreatePrInput) {
  const value = ForgeCreatePrInput.parse(input);
  if (value.base === undefined) throw new ForgeError("base_missing");
  const fields: Record<string, string> = {
    threadId: z.string().min(1).max(256).parse(threadId),
    branch: value.branch,
    title: value.title,
    summary: value.summary,
  };
  const render = (template: string) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const field = fields[key];
      if (!Object.hasOwn(fields, key) || field === undefined) throw new ForgeError("invalid_data");
      return field;
    });
  return {
    branch: value.branch,
    base: value.base,
    draft: value.draft,
    title: z.string().min(1).max(256).parse(render(value.template.title)),
    body: z.string().max(65_536).parse(render(value.template.body)),
  };
}
