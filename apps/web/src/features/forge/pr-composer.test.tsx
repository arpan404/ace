import { useState } from "react";
import { expect, test } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { PrComposer } from "./pr-composer.tsx";
import { PrMarkdown } from "./pr-markdown.tsx";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { detail } from "./pr-workspace.fixture.ts";
const context: PrWorkspaceContext = {
  workspaceId: "api",
  detail,
  disabled: false,
  refresh: async () => true,
};

function ComposerExample(props: { disabled?: boolean; acknowledge?: Promise<void> }) {
  const [posted, setPosted] = useState("");
  return (
    <TooltipProvider delay={0}>
      <ToastProvider>
        <PrComposer
          context={{ ...context, disabled: props.disabled ?? false }}
          extensions={{
            comment: async (body) => {
              await props.acknowledge;
              setPosted(`Comment posted: ${body}`);
            },
            review: async (body) => {
              await props.acknowledge;
              setPosted(`Review posted: ${body}`);
            },
            closeWithComment: async (body) => {
              await props.acknowledge;
              setPosted(`Closed: ${body}`);
            },
          }}
        />
        <p>{posted}</p>
      </ToastProvider>
    </TooltipProvider>
  );
}
test("a comment is posted through the capability and the composer dismisses after success", async () => {
  render(<ComposerExample />);
  await userEvent.click(screen.getByRole("button", { name: "Write a comment or review" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Comment body" }), "Keep the cursor");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  await screen.findByText("Comment posted: Keep the cursor");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment body" })).toBeNull());
});

test("successful submission preserves newer text in the open composer until that text is submitted", async () => {
  const acknowledgement = Promise.withResolvers<void>();
  render(<ComposerExample acknowledge={acknowledgement.promise} />);
  await userEvent.click(screen.getByRole("button", { name: "Write a comment or review" }));
  const body = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment body" });
  await userEvent.type(body, "Ready to ship");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Comment" }).disabled).toBe(true);
  await userEvent.type(body, " and another thought");
  await act(async () => acknowledgement.resolve());
  await screen.findByText("Comment posted: Ready to ship");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment body" }).value).toBe(
    "Ready to ship and another thought",
  );
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  await screen.findByText("Comment posted: Ready to ship and another thought");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment body" })).toBeNull());
});
test("closing with a comment requires a second explicit confirmation", async () => {
  render(<ComposerExample />);
  await userEvent.click(screen.getByRole("button", { name: "Write a comment or review" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Comment body" }), "Superseded");
  await userEvent.click(screen.getByRole("button", { name: "Close with comment" }));
  expect(screen.queryByText("Closed: Superseded")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Confirm close with comment" }));
  await screen.findByText("Closed: Superseded");
});
test("stale detail disables both comment and close writes while keeping the draft readable", async () => {
  render(<ComposerExample disabled />);
  await userEvent.click(screen.getByRole("button", { name: "Write a comment or review" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Comment body" }), "Save this draft");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Comment" }).disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Close with comment" }).disabled,
  ).toBe(true);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment body" }).value).toBe(
    "Save this draft",
  );
});
test("unavailable write capabilities produce no composer or review buttons", () => {
  render(
    <TooltipProvider>
      <ToastProvider>
        <PrComposer context={context} />
      </ToastProvider>
    </TooltipProvider>,
  );
  expect(screen.queryByRole("button", { name: "Write a comment or review" })).toBeNull();
});
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
