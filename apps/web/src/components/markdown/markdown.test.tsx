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
