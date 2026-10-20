import type { Fact } from "@ace/core";
import type { Question } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { message, tool, toolDone } from "./facts.ts";
import { scenario } from "./ux-facts.ts";

const root = "root";

/** The agent looked around before asking. */
const explored: Fact[] = [
  tool(root, "find-config", {
    kind: "search",
    title: "Search .editorconfig",
    detail: { kind: "search", query: ".editorconfig" },
  }),
  toolDone(root, "find-config"),
  tool(root, "read-package", {
    kind: "file.read",
    title: "Read package.json",
    detail: { kind: "file.read", path: "package.json" },
  }),
  toolDone(root, "read-package"),
];

/** An `ask_user` step and the blocking question raised from it. */
function asks(item: string, interaction: string, questions: Question[]): Fact[] {
  return [
    tool(root, item, {
      kind: "ask_user",
      title: questions[0]?.text ?? "Question",
      detail: { kind: "ask_user" },
    }),
    {
      type: "interaction.opened",
      agent: root,
      interaction,
      item,
      blocking: true,
      request: { kind: "question", questions },
    },
  ];
}

const indentation: Question = {
  id: "indent",
  header: "Indentation",
  text: "Tabs or Spaces?",
  options: [
    { id: "tabs", label: "Tabs", description: "Matches the existing files" },
    { id: "spaces", label: "Spaces", description: "2 spaces, like the web app" },
  ],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

const waiting = (interaction: string) => ({
  pending: true,
  after: [{ kind: "await" as const, interaction }],
});

/** Questions answered each way the strip offers: options with notes, free text, a secret. */
export function questionKinds(): Scenario[] {
  return [
    scenario(
      "question-pick",
      "Codex asks how to indent",
      [...explored, ...asks("ask-indent", "indent", [indentation])],
      waiting("indent"),
    ),
    scenario(
      "question-text",
      "Codex asks what to call the config",
      asks("ask-name", "name", [
        {
          id: "name",
          header: "Name",
          text: "What should the config file be called?",
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: false,
        },
      ]),
      waiting("name"),
    ),
    scenario(
      "question-secret",
      "Codex asks for a registry token",
      asks("ask-token", "token", [
        {
          id: "token",
          header: "Token",
          text: "Paste the npm token for the private registry",
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: true,
        },
      ]),
      waiting("token"),
    ),
    scenario("question-answered", "Codex set up the formatter after your answer", [
      ...explored,
      ...asks("ask-indent", "indent", [indentation]),
      {
        type: "interaction.closed",
        interaction: "indent",
        state: "resolved",
        resolution: { kind: "question", answers: { indent: ["spaces"] } },
      },
      toolDone(root, "ask-indent"),
      message(root, "reply", "assistant", "Done. The formatter is set up with 2 spaces."),
    ]),
  ];
}
