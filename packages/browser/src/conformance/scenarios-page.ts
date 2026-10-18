import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import type { ConformancePage, ConformanceScenario } from "./engine.ts";
import { Snapshot, eventually, ref, visit } from "./scenario-support.ts";

/** Clicks `button`, waits for its dialog and answers it as the agent would. */
async function answerDialog(
  page: ConformancePage,
  button: string,
  type: "alert" | "confirm" | "prompt",
  answer: { accept: boolean; promptText?: string },
) {
  await page.execute({
    action: "click",
    ref: ref(await page.execute({ action: "snapshot" }), button),
  });
  const dialog = await eventually(() => {
    const pending = page.service.state(page.threadId).pending_dialog;
    expect(pending?.type).toBe(type);
    return z.object({ dialogId: z.string() }).parse(pending);
  });
  await page.execute({ action: "dialog", dialogId: dialog.dialogId, ...answer });
  await eventually(() => expect(page.service.state(page.threadId).pending_dialog).toBeUndefined());
}

const Entries = z.object({ entries: z.array(z.object({ text: z.string() })) });

export const pageScenarios: ConformanceScenario[] = [
  {
    id: "dialogs",
    title: "alert, confirm and prompt wait for the agent's answer and the page gets it",
    async run(page) {
      await visit(page, "/dialogs", "Prompt");
      await answerDialog(page, "Alert", "alert", { accept: true });
      expect(await page.evaluate("document.body.dataset.alerted")).toBe("yes");
      await answerDialog(page, "Confirm", "confirm", { accept: false });
      expect(await page.evaluate("document.body.dataset.confirmed")).toBe("false");
      await answerDialog(page, "Prompt", "prompt", { accept: true, promptText: "Grace" });
      expect(await page.evaluate("document.body.dataset.prompted")).toBe("Grace");
    },
  },
  {
    id: "downloads",
    title: "a download is reported and its bytes are published as an artifact",
    async run(page) {
      // An engine that cannot see downloads says so here, before anything waits for one.
      expect(await page.execute({ action: "downloads" })).toEqual({ downloads: [] });
      await visit(page, "/download", "Download page");
      await page.execute({
        action: "click",
        ref: ref(await page.execute({ action: "snapshot" }), "Get report"),
      });
      const artifact = await eventually(() => {
        const found = page.artifacts.find((candidate) => candidate.filename === "report.zip");
        expect(found).toBeDefined();
        return found;
      }, 30_000);
      expect(await readFile(artifact?.path ?? "", "utf8")).toBe("conformance-download");
      const listed = z
        .object({ downloads: z.array(z.object({ state: z.string(), filename: z.string() })) })
        .parse(await page.execute({ action: "downloads" }));
      expect(listed.downloads).toContainEqual(
        expect.objectContaining({ filename: "report.zip", state: "complete" }),
      );
    },
  },
  {
    id: "upload",
    title: "a workspace file uploads into a file input by ref",
    async run(page) {
      await writeFile(join(page.workspace, "notes.txt"), "uploaded-content");
      await visit(page, "/upload", "Upload page");
      const input = ref(await page.execute({ action: "snapshot" }), "Attachment");
      await page.execute({ action: "upload", ref: input, files: ["notes.txt"] });
      expect(
        await page.evaluate(
          "(async () => { const f = document.querySelector('input').files[0]; return f.name + ':' + await f.text(); })()",
        ),
      ).toBe("notes.txt:uploaded-content");
    },
  },
  {
    id: "frames",
    title: "same-origin and cross-site frames are readable and their elements act by ref",
    async run(page) {
      await visit(page, "/frames", "Frames ready");
      const snapshot = Snapshot.parse(await page.execute({ action: "snapshot" }));
      const names = snapshot.nodes.map((node) => node.name);
      expect(names).toContain("Same frame button");
      expect(names).toContain("Cross frame button");
      for (const label of ["Same", "Cross"]) {
        await page.execute({
          action: "type",
          ref: ref(snapshot, `${label} frame input`),
          text: `${label}-typed`,
        });
        await page.execute({ action: "click", ref: ref(snapshot, `${label} frame button`) });
      }
      const after = Snapshot.parse(await page.execute({ action: "snapshot" }));
      expect(after.nodes.map((node) => node.name)).toEqual(
        expect.arrayContaining(["Same clicked", "Cross clicked"]),
      );
      expect(
        after.nodes
          .filter((node) => node.name.endsWith("frame input"))
          .map((node) => node.value)
          .toSorted(),
      ).toEqual(["Cross-typed", "Same-typed"]);
    },
  },
  {
    id: "browser-warnings",
    title: "the browser's own warnings about a page (CSP) and its console warnings reach its logs",
    async run(page) {
      await visit(page, "/policy", "Policy page");
      await eventually(async () => {
        const warnings = Entries.parse(
          await page.execute({ action: "logs", kind: "console", level: "warning" }),
        );
        expect(warnings.entries.map((entry) => entry.text)).toContainEqual(
          expect.stringContaining("conformance-warning-marker"),
        );
        const console = Entries.parse(await page.execute({ action: "logs", kind: "console" }));
        expect(console.entries.map((entry) => entry.text)).toContainEqual(
          expect.stringMatching(/^\[security\] .*blocked\.png/),
        );
      });
    },
  },
  {
    id: "logs",
    title: "the page's console messages and network requests are in its logs",
    async run(page) {
      await visit(page, "/logs", "Ping pong");
      await eventually(async () => {
        const console = Entries.parse(await page.execute({ action: "logs", kind: "console" }));
        expect(console.entries.map((entry) => entry.text)).toContainEqual(
          expect.stringContaining("conformance-console-marker"),
        );
        const network = Entries.parse(await page.execute({ action: "logs", kind: "network" }));
        expect(network.entries.map((entry) => entry.text)).toContainEqual(
          expect.stringContaining("/api/ping"),
        );
      });
    },
  },
];
