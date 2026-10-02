import { createScriptedAdapter } from "../index.ts";
import { capabilities, createTranslator } from "../translator.test-helper.ts";

export default createScriptedAdapter({
  provider: "codex",
  capabilities,
  createTranslator,
  steps: [],
});
