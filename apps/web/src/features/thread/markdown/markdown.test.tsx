import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

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

test("code spans and fences keep their text exactly", () => {
  const { container } = render(
    <Markdown text={'Use `a < b && c` here.\n\n```ts\nif (a < b) return "x";\n```'} />,
  );
  expect(screen.getByText("a < b && c").tagName).toBe("CODE");
  expect(container.querySelector("pre code")?.textContent).toBe('if (a < b) return "x";');
});

test("lists, tables and task items render as their elements", () => {
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
