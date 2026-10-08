import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { longAnswer, markdownSamples } from "./markdown-samples.fixture.ts";
import { Markdown } from "./markdown.tsx";
import { Prose } from "./prose.tsx";

test("agent text never injects markup: raw HTML shows as text", () => {
  const { container } = render(
    <Markdown text={'Before <img src=x onerror="alert(1)"> after\n\n<script>alert(2)</script>'} />,
  );
  expect(container.querySelector("img, script")).toBeNull();
  expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(container.textContent).toContain("<script>alert(2)</script>");
});

test("only web and mail links are live; other schemes render as plain text", () => {
  render(
    <Markdown
      text={"[docs](https://ace.dev/docs) [run](javascript:alert(1)) [mail](mailto:a@b.c)"}
    />,
  );
  expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe(
    "https://ace.dev/docs",
  );
  expect(screen.getByRole("link", { name: "mail" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "run" })).toBeNull();
  expect(screen.getByText(/run/)).toBeTruthy();
});

test("code spans stay readable and copying a fence preserves its text exactly", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <Markdown text={'Use `a < b && c` here.\n\n```ts\nif (a < b) return "x";\n```'} />,
  );
  expect(screen.getByText("a < b && c").textContent).toBe("a < b && c");
  expect(container.textContent).toContain('if (a < b) return "x";');
  await user.click(screen.getByRole("button", { name: /^(Copy code|Copied)$/ }));
  expect(await navigator.clipboard.readText()).toBe('if (a < b) return "x";');
});

test("task checkboxes show completion and table cells stay readable", () => {
  render(
    <Markdown
      text={"- [x] tests pass\n- [ ] docs\n\n| file | lines |\n| --- | --- |\n| replay.ts | +29 |"}
    />,
  );
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
  expect(screen.getByRole("columnheader", { name: "file" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "replay.ts" })).toBeTruthy();
});

test("images draw only bytes already on the page; web images become links, local files names", async () => {
  const dot =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=";
  const { container } = render(
    <Markdown
      text={`Before ![chart](${dot}) then ![logo](https://cdn.example.com/brand/logo.png) and ![diagram](/Users/dev/acme/out/diagram.png)`}
    />,
  );
  expect((await screen.findByRole("img", { name: "chart" })).getAttribute("src")).toBe(dot);
  // Nothing loads from the web host until the person follows the link.
  const logo = screen.getByRole("link", { name: /logo/ });
  expect(logo.getAttribute("href")).toBe("https://cdn.example.com/brand/logo.png");
  expect(logo.textContent).toContain("cdn.example.com");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(screen.getByText("diagram (diagram.png)")).toBeTruthy();
  expect(container.textContent).not.toContain("/Users/");
});

test("selected finished text stays selected while the rest of an answer streams", async () => {
  const stream = "thread/answer-1";
  const { rerender } = render(
    <Markdown stream={stream} streaming text={"Para one.\n\nPara two\n"} />,
  );
  const first = await screen.findByText("Para one.");
  const selection = window.getSelection();
  if (!selection) throw new Error("Text selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(first);
  selection.removeAllRanges();
  selection.addRange(range);
  rerender(
    <Markdown stream={stream} streaming text={"Para one.\n\nPara two\nkeeps going.\n\n- item"} />,
  );
  await screen.findByRole("listitem");
  expect(selection.toString()).toBe("Para one.");
  expect(screen.getByText(/Para two/).textContent).toBe("Para two\nkeeps going.");
  rerender(<Markdown stream={stream} text={"Para one.\n\nPara two\nkeeps going.\n\n- item one"} />);
  await screen.findByText("item one");
  expect(selection.toString()).toBe("Para one.");
  selection.removeAllRanges();
});

test("copying code preserves what has arrived before and after its fence closes", async () => {
  const user = userEvent.setup();
  const stream = "thread/answer-2";
  const { rerender } = render(<Markdown stream={stream} streaming text={"```ts\nconst a = 1"} />);
  await user.click(await screen.findByRole("button", { name: "Copy code" }));
  expect(await navigator.clipboard.readText()).toBe("const a = 1");
  rerender(<Markdown stream={stream} text={"```ts\nconst a = 1;\n```\n\nDone.\n"} />);
  await screen.findByText("Done.");
  await user.click(screen.getByRole("button", { name: /^(Copy code|Copied)$/ }));
  expect(await navigator.clipboard.readText()).toBe("const a = 1;");
});

test("the writing marker stays visible as an answer becomes a list, code and a table", async () => {
  const tail = <span role="status" aria-label="Streaming" />;
  const view = render(<Markdown streaming text="Checking the retry path" tail={tail} />);
  await screen.findByText("Checking the retry path");
  expect(screen.getByRole("status", { name: "Streaming" })).toBeTruthy();
  view.rerender(<Markdown streaming text="- Keep the saved cursor" tail={tail} />);
  expect((await screen.findByRole("listitem")).textContent).toContain("Keep the saved cursor");
  expect(screen.getByRole("status", { name: "Streaming" })).toBeTruthy();
  view.rerender(<Markdown streaming text={"```ts\nconst cursor = 12"} tail={tail} />);
  await userEvent.click(await screen.findByRole("button", { name: "Copy code" }));
  expect(await navigator.clipboard.readText()).toBe("const cursor = 12");
  expect(screen.getByRole("status", { name: "Streaming" })).toBeTruthy();
  const table = "| check | result |\n| --- | --- |\n| replay | passed |";
  view.rerender(<Markdown streaming text={table} tail={tail} />);
  expect(await screen.findByRole("cell", { name: /^passed/ })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Streaming" })).toBeTruthy();
  view.rerender(<Markdown text={table} />);
  await waitFor(() => expect(screen.queryByRole("status", { name: "Streaming" })).toBeNull());
});

test("a streamed answer, once finished, has the same readable content as its whole text", async () => {
  for (const [name, text] of Object.entries({ ...markdownSamples, long: longAnswer })) {
    const whole = render(<Markdown text={text} />);
    const expected = whole.container.textContent;
    const links = screen.queryAllByRole("link").map((link) => link.getAttribute("href"));
    whole.unmount();
    const stream = `thread/${name}`;
    const streamed = render(<Markdown stream={stream} streaming text="" />);
    for (let at = 0; at < text.length; at += 97)
      streamed.rerender(<Markdown stream={stream} streaming text={text.slice(0, at + 97)} />);
    streamed.rerender(<Markdown stream={stream} text={text} />);
    await waitFor(() => expect(streamed.container.textContent, name).toBe(expected));
    expect(screen.queryAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(links);
    streamed.unmount();
  }
});

test("a message waits for the lazy renderer without showing its markdown source", async () => {
  const view = render(<Prose text="**New thread message**" />);
  expect(screen.getByRole("status", { name: "Loading message" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("**New thread message**");
  expect(await screen.findByText("New thread message")).toBeTruthy();
});
