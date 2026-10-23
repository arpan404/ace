import { useState } from "react";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrMarkdown } from "./pr-markdown.tsx";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { detail } from "./pr-workspace.fixture.ts";

const context: PrWorkspaceContext = {
  workspaceId: "api",
  detail,
  disabled: false,
  refresh: async () => true,
};

function MarkdownExample() {
  const [opened, setOpened] = useState("");
  return (
    <>
      <PrMarkdown
        text="See #7, `#8` and [the pull request](https://github.com/acme/ace/pull/9)."
        context={context}
        onOpen={(number) => setOpened(`Opened ${number}`)}
      />
      <p>{opened}</p>
    </>
  );
}
test("Markdown references and PR links open ace views while inline code remains literal", async () => {
  render(<MarkdownExample />);
  await userEvent.click(await screen.findByRole("button", { name: "#7" }));
  await screen.findByText("Opened 7");
  expect(screen.queryByRole("link", { name: "#8" })).toBeNull();
  expect(screen.queryByRole("button", { name: "#8" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "the pull request" }));
  await screen.findByText("Opened 9");
});
