import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentMcp } from "./agent-mcp-test-support.ts";
import { executablePath, fixture, toolPort } from "./test-support.ts";

const buttonLines = (snapshot: string) =>
  snapshot.split("\n").filter((line) => /button "Item \d+"/.test(line)).length;

describe.skipIf(!executablePath)("default result sizes", () => {
  it("a snapshot shows 80 lines by default, says how many more exist, and shows more on request", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "for (let i = 0; i < 150; i++) { const b = document.createElement('button'); b.textContent = 'Item ' + i; document.body.append(b) } void 0",
    );
    const agent = agentMcp(toolPort(f.service));
    const first = agent.raw(await agent.ok("browser_snapshot"));
    expect(first).toMatch(/\[truncated: 80 of \d+ nodes shown\..*pass a larger maxNodes\.\]/);
    expect(buttonLines(first)).toBeLessThan(80);
    const larger = agent.raw(await agent.ok("browser_snapshot", { maxNodes: 400 }));
    expect(buttonLines(larger)).toBe(150);
    expect(larger).not.toContain("[truncated");
  });

  it("logs return the 25 latest entries by default, count the older ones, and return more on request", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("for (let i = 0; i < 40; i++) console.log('marker ' + i); void 0");
    const agent = agentMcp(toolPort(f.service));
    const Page = z.object({
      entries: z.array(z.object({ text: z.string().optional() }).passthrough()),
      more: z.number().optional(),
      truncated: z.string().optional(),
    });
    const markers = (page: z.infer<typeof Page>) =>
      page.entries.filter((entry) => JSON.stringify(entry).includes("marker "));
    await expect
      .poll(async () =>
        markers(
          Page.parse(agent.json(await agent.ok("browser_logs", { kind: "console", limit: 200 }))),
        ),
      )
      .toHaveLength(40);
    const latest = Page.parse(agent.json(await agent.ok("browser_logs", { kind: "console" })));
    expect(latest.entries).toHaveLength(25);
    expect(JSON.stringify(latest.entries.at(-1))).toContain("marker 39");
    expect(latest.more).toBeGreaterThanOrEqual(15);
    expect(latest.truncated).toContain("pass a larger limit");
  });
});
