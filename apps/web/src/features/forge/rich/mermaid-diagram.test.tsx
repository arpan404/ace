import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ThemeProvider } from "@/theme/theme-provider.tsx";
import { diagramSource, MermaidDiagram } from "./mermaid-diagram.tsx";

// Mermaid needs a laid-out document to measure text, which this one isn't: it is stood in for at
// its module boundary, answering as it does.
const answers = vi.hoisted(() => ({ next: [] as ((source: string) => Promise<string>)[] }));
vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    async render(_id: string, source: string) {
      const answer = answers.next.shift();
      if (!answer) throw new Error("No answer");
      return { svg: await answer(source) };
    },
  },
}));

function page(source: string) {
  return render(
    <ThemeProvider
      environment={{
        storage: { getItem: () => null, setItem() {}, removeItem() {} },
        root: document.createElement("div"),
      }}
    >
      <MermaidDiagram source={source} code={<pre>{source}</pre>} />
    </ThemeProvider>,
  );
}

test("a diagram's own configuration never reaches the renderer", () => {
  const source = [
    "---",
    "config:",
    "  htmlLabels: true",
    "---",
    '%%{init: {"flowchart": {"htmlLabels": true}, "securityLevel": "loose"}}%%',
    "flowchart LR",
    "  A --> B",
  ].join("\n");
  expect(diagramSource(source)).toBe("\nflowchart LR\n  A --> B");
  expect(diagramSource('graph TD\n%%{ init: { "theme": "dark" } }%%\nA-->B')).toBe(
    "graph TD\n\nA-->B",
  );
});

test("a diagram draws as an image from a data URL, with no trace left in the page", async () => {
  answers.next.push(async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>');
  const { container } = page("flowchart LR\n  A --> B");
  const image = await screen.findByRole("img", { name: "Diagram" });
  expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(container.querySelector("pre")).toBeNull();
  expect(document.body.querySelectorAll("svg")).toHaveLength(0);
});

test("a diagram mermaid can't draw keeps its code once mermaid has answered", async () => {
  let refused = false;
  answers.next.push(async () => {
    refused = true;
    throw new Error("Parse error");
  });
  const { container } = page("not a diagram {{{");
  await waitFor(() => expect(refused).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.querySelector("pre")?.textContent).toBe("not a diagram {{{");
  expect(screen.queryByRole("img")).toBeNull();
});
