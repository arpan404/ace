import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, htmlToolkit, type HtmlLayoutPort } from "./index.ts";
import { scope } from "./test-support.ts";

const page = (head: string, body = "<p>Queue states</p>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

function render(layout?: HtmlLayoutPort) {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const published: string[] = [];
  htmlToolkit(
    {
      async publish(_caller, input) {
        published.push(input.html);
        return { itemId: "item-1" };
      },
    },
    layout,
  ).register(registry);
  const principal = new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root"),
    new AbortController().signal,
  ).principal;
  return {
    published,
    async call(html: string) {
      const result = await registry.call(
        "html_render",
        { title: "Queue", html },
        principal,
        new AbortController().signal,
      );
      const text = z.object({ text: z.string() }).parse(result.content[0]).text;
      return { refused: result.isError === true, text };
    },
  };
}

const measured = (problems: { code: string; message: string }[]): HtmlLayoutPort => ({
  async measure() {
    return problems;
  },
});

it("a page that overflows the phone once laid out is refused with that problem, and nothing is published", async () => {
  const tool = render(
    measured([{ code: "overflow", message: "At 360px the page is wider than the chat" }]),
  );
  const result = await tool.call(page("<style>.pair{grid-template-columns:300px 300px}</style>"));
  expect(result.refused).toBe(true);
  expect(result.text).toContain("overflow: At 360px the page is wider than the chat");
  expect(tool.published).toEqual([]);
});

it("a width the markup guess would refuse publishes when the page measures fine on a phone", async () => {
  const tool = render(measured([]));
  const html = page("<style>@container (max-width:900px){.side{width:420px}}</style>");
  expect((await tool.call(html)).refused).toBe(false);
  expect(tool.published).toEqual([html]);
});

it("when the page can't be laid out, the markup guess still refuses a width wider than the phone", async () => {
  const tool = render({ measure: async () => undefined });
  const result = await tool.call(page("<style>.card{width:480px}</style>"));
  expect(result.refused).toBe(true);
  expect(result.text).toContain("fixed-width");
  expect(tool.published).toEqual([]);
});

it("a page that breaks the frame at any width is refused before it is laid out", async () => {
  const tool = render(measured([]));
  const result = await tool.call(page("<style>.app{height:100vh}</style>"));
  expect(result.refused).toBe(true);
  expect(result.text).toContain("viewport-height");
  expect(tool.published).toEqual([]);
});
