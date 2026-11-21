import { expect, test } from "vitest";
import { legalDocuments, type LegalDocument } from "./legal.ts";

/** Every paragraph and list item a person reads on a legal page, and its description. */
const passages = (document: LegalDocument) => [
  document.description,
  document.intro,
  ...document.sections.flatMap((section) =>
    section.body.flatMap((block) => (typeof block === "string" ? [block] : block.list)),
  ),
];

// The relay reads an outside MCP client's requests and replies when the person turns that on.
const promise = /can't read|never (receive|see)s? (them|your code)|never your prompts/i;

test("every promise that ace can't read or never receives your work names the outside-MCP exception", () => {
  const broken = legalDocuments.flatMap((document) =>
    passages(document)
      .filter((text) => promise.test(text) && !/MCP/.test(text))
      .map((text) => `${document.path}: ${text}`),
  );
  expect(broken).toEqual([]);
});
