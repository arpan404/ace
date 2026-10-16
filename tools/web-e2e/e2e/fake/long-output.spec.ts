import { expect, test } from "@playwright/test";
import type { FakeDaemon } from "@ace/fake-daemon";

declare global {
  interface Window {
    longOutput: {
      start(): void;
      sent: number;
      arrived: number;
      thinking?: number;
      message?: number;
      delta?: number;
      frames: number[];
      input: number[];
    };
  }
}

/** Real UI and output.read protocol; the only substitute is the provider/daemon boundary. */
test("long source-backed thinking and answers stream visibly without clicks or scroll jumps", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      aceFakeSetup: (daemon: FakeDaemon) => {
        const id = "long-output";
        const texts = new Map<string, string>();
        const original = daemon.output.bind(daemon);
        daemon.output = (streamId, offset, limit) => {
          const text = texts.get(streamId);
          if (text === undefined) return original(streamId, offset, limit);
          const end = Math.min(text.length * 2, offset + limit);
          const bytes = new Uint8Array(end - offset);
          const view = new DataView(bytes.buffer);
          for (let at = offset; at < end; at += 2)
            view.setUint16(at - offset, text.charCodeAt(at / 2), true);
          return { bytes, nextOffset: end, eof: end === text.length * 2 };
        };
        daemon.createThread({ id, workspaceId: "ace", provider: "codex", title: "Long output" });
        daemon.apply(id, [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: "root" },
            cwd: "/tmp/ace-long-output",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "long-turn", trigger: "user" },
          {
            type: "item.upsert",
            agent: "root",
            item: "ask",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: "Stream a long answer while thinking" }],
            },
          },
        ]);
        daemon.apply(id, [
          {
            type: "item.upsert",
            agent: "root",
            item: "warm",
            draft: {
              type: "message",
              role: "assistant",
              complete: false,
              parts: [{ type: "text", text: "Renderer warm-up ready." }],
            },
          },
        ]);
        window.longOutput = {
          sent: 0,
          arrived: 0,
          frames: [],
          input: [],
          start() {
            daemon.apply(id, [
              {
                type: "item.upsert",
                agent: "root",
                item: "warm",
                draft: { type: "message", complete: true },
              },
            ]);
            const metrics = window.longOutput;
            metrics.arrived = performance.now();
            let previous = metrics.arrived;
            const frame = (now: number) => {
              metrics.frames.push(now - previous);
              previous = now;
              if (metrics.sent < 100) requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
            document.addEventListener("keydown", () => {
              const at = performance.now();
              requestAnimationFrame(() => metrics.input.push(performance.now() - at));
            });
            const observer = new MutationObserver(() => {
              const feed = document.querySelector('[data-thread-column] [role="feed"]');
              const text = feed?.textContent ?? "";
              if (!metrics.thinking && text.includes("Thinking past preview"))
                metrics.thinking = performance.now();
              if (!metrics.message && text.includes("Answer past preview"))
                metrics.message = performance.now();
              if (!metrics.delta && text.includes("Section 1")) metrics.delta = performance.now();
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
            });
            const thought =
              "Thinking preview\n\n" + "reasoning ".repeat(600) + "Thinking past preview";
            const answer =
              "Answer preview\n\n" +
              "The answer stays readable. ".repeat(800) +
              "Answer past preview";
            texts.set("thought", thought);
            texts.set("answer", answer);
            daemon.apply(id, [
              {
                type: "item.upsert",
                agent: "root",
                item: "thought",
                draft: {
                  type: "reasoning",
                  complete: false,
                  text: thought.slice(0, 4096),
                  source: { streamId: "thought", bytes: thought.length * 2, encoding: "utf-16le" },
                },
              },
              {
                type: "item.upsert",
                agent: "root",
                item: "answer",
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: false,
                  parts: [
                    {
                      type: "text",
                      text: answer.slice(0, 4096),
                      source: {
                        streamId: "answer",
                        bytes: answer.length * 2,
                        encoding: "utf-16le",
                      },
                    },
                  ],
                },
              },
            ]);
            const timer = setInterval(() => {
              metrics.sent++;
              const append =
                "\n\n## Section " +
                metrics.sent +
                "\n\n" +
                "The streaming transcript should remain readable and scroll continuously. ".repeat(
                  20,
                );
              texts.set("answer", (texts.get("answer") ?? "") + append);
              daemon.apply(id, [
                { type: "item.delta", agent: "root", item: "answer", field: "text", append },
              ]);
              if (metrics.sent === 100) {
                clearInterval(timer);
                observer.disconnect();
              }
            }, 50);
          },
        };
      },
    });
  });
  await page.goto("/t/long-output", { waitUntil: "domcontentloaded" });
  const feed = page.locator("[data-thread-column]").getByRole("feed", { name: "Transcript" });
  await feed.getByText("Stream a long answer while thinking").waitFor({ timeout: 60000 });
  // Wait for an actual parsed paragraph: cold fallback visibility is covered separately.
  // This measures steady streaming without charging Vite's first worker compilation to it.
  await expect(feed.locator("p").filter({ hasText: "Renderer warm-up ready." })).toBeVisible();
  await page.evaluate(() => window.longOutput.start());
  await expect(feed.getByText(/Answer past preview/)).toBeVisible();
  await expect(feed.getByText(/Thinking past preview/)).toBeAttached();
  expect(await page.evaluate(() => window.longOutput.sent)).toBeLessThan(100);
  await expect(feed.getByRole("status", { name: "Streaming", exact: true })).toBeAttached();
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  await viewport.hover({ force: true });
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page
    .getByRole("combobox", { name: "Message", exact: true })
    .fill("Check input during the stream");
  await page.keyboard.type("12345");
  await expect
    .poll(() => page.evaluate(() => window.longOutput.sent), { timeout: 15000 })
    .toBe(100);
  await expect(feed.getByText("Section 100", { exact: true })).toBeAttached();

  const evidence = await page.evaluate((initialTop) => {
    const metrics = window.longOutput;
    const frames = metrics.frames.toSorted((a, b) => a - b);
    return {
      scrollStart: initialTop,
      scrollEnd: document.querySelector("[data-thread-column] [data-virtual-viewport]")?.scrollTop,
      thinkingMs: metrics.thinking === undefined ? null : metrics.thinking - metrics.arrived,
      messageMs: metrics.message === undefined ? null : metrics.message - metrics.arrived,
      firstDeltaMs: metrics.delta === undefined ? null : metrics.delta - metrics.arrived - 50,
      frameCount: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      maxFrameMs: frames.at(-1),
      framesOver50Ms: frames.filter((ms) => ms > 50).length,
      maxInputToFrameMs: Math.max(...metrics.input),
    };
  }, top);
  console.log("long-output evidence", JSON.stringify(evidence));
  expect(Math.abs((evidence.scrollEnd ?? 0) - top)).toBeLessThan(2);
  await info.attach("long-output-metrics", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  for (const width of [390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme);
      await page.screenshot({
        path: info.outputPath("long-output-" + width + "-" + scheme + ".jpg"),
        type: "jpeg",
        quality: 60,
        animations: "disabled",
      });
    }
  }
  // Timing is reported, not a machine-load-sensitive CI assertion. Visibility and scrolling
  // above are the regression gates; no completed message or reasoning fact was ever sent.
});
