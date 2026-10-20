import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ref, Snapshot } from "./test-support.ts";
import { setup, tabs, executablePath, cleanups } from "./parity-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

it.skipIf(!executablePath)(
  "an opened tab is its own page while agent popups reuse the page that opened them",
  async () => {
    const f = await setup();
    const initial = tabs.parse(await f.execute({ action: "tabs" }));
    const next = z
      .object({ tabId: z.string(), tabs: tabs.shape.tabs })
      .parse(await f.execute({ action: "tabs", operation: "open", url: f.url + "/other" }));
    expect(next.tabs).toHaveLength(2);
    expect(next.tabId).not.toBe(initial.activeTabId);
    await f.until(
      () =>
        f.service.state("thread").tabs?.find((tab) => tab.tabId === next.tabId)?.url ===
        f.url + "/other",
    );
    const first = initial.activeTabId;
    // The reloaded page's iframe commits invalidate refs; take them after the page loads.
    await f.execute({ action: "wait_for", text: "Fixture ready", tabId: first });
    await f.execute({
      action: "click",
      tabId: first,
      ref: ref(await f.execute({ action: "snapshot", tabId: first }), "Popup"),
    });
    await f.until(
      () =>
        f.service.state("thread").tabs?.find((tab) => tab.tabId === first)?.url ===
        f.url + "/other",
    );
    expect(f.service.state("thread").tabs).toHaveLength(2);
  },
);
it.skipIf(!executablePath)(
  "semantic input and same/cross origin frame refs change the intended elements",
  async () => {
    const f = await setup();
    await f.execute({ action: "wait_for", text: "Popup" });
    const snap = await f.execute({ action: "snapshot" });
    const nodes = Snapshot.parse(snap).nodes.filter(
      (node) => node.name === "Frame input" && node.ref,
    );
    expect(nodes).toHaveLength(2);
    for (const node of nodes)
      await f.execute({ action: "type", ref: node.ref, text: "frame-value" });
    expect(
      Snapshot.parse(await f.execute({ action: "snapshot" }))
        .nodes.filter((node) => node.name === "Frame input")
        .map((node) => node.value),
    ).toEqual(["frame-value", "frame-value"]);
    const frameButtons = Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.filter(
      (node) => node.name === "Frame button" && node.role === "button" && node.ref,
    );
    for (const button of frameButtons) await f.execute({ action: "click", ref: button.ref });
    expect(
      Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.filter(
        (node) => node.name === "Clicked frame" && node.role === "button",
      ),
    ).toHaveLength(2);
    const current = await f.execute({ action: "snapshot" });
    await f.execute({ action: "check", ref: ref(current, "Agree") });
    await f.execute({ action: "check", ref: ref(current, "Agree") });
    expect(await f.evaluate("document.querySelector('[type=checkbox]').checked")).toBe(true);
    await f.execute({ action: "uncheck", ref: ref(snap, "Agree") });
    await f.execute({ action: "uncheck", ref: ref(snap, "Agree") });
    expect(await f.evaluate("document.querySelector('[type=checkbox]').checked")).toBe(false);
    await f.execute({ action: "select", ref: ref(snap, "Choice"), values: ["b"] });
    expect(await f.evaluate("document.querySelector('select').value")).toBe("b");
    await f.execute({ action: "hover", ref: ref(snap, "Hover") });
    expect(await f.evaluate("document.body.dataset.hovered")).toBe("1");
    await f.execute({ action: "focus", ref: ref(await f.execute({ action: "snapshot" }), "Name") });
    expect(await f.evaluate("document.activeElement.getAttribute('aria-label')")).toBe("Name");
    await f.execute({
      action: "drag",
      ref: ref(await f.execute({ action: "snapshot" }), "Drag source"),
      toRef: ref(await f.execute({ action: "snapshot" }), "Drop target"),
    });
    expect(await f.evaluate("document.body.dataset.dropped")).toBe("dragged");
    const found = Snapshot.parse(
      await f.execute({ action: "find", role: "button", name: "Clicked frame" }),
    );
    expect(found.nodes.filter((node) => node.ref)).toHaveLength(2);
  },
);
it.skipIf(!executablePath)(
  "dialogs wait for an explicit answer and downloads become flagged artifacts",
  async () => {
    const f = await setup();
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Prompt"),
    });
    await f.until(() => f.service.state("thread").pending_dialog?.type === "prompt");
    const dialog = f.service.state("thread").pending_dialog;
    if (!dialog) throw new Error("dialog");
    await f.execute({
      action: "dialog",
      dialogId: dialog.dialogId,
      accept: true,
      promptText: "answered",
    });
    expect(await f.evaluate("document.body.dataset.answer")).toBe("answered");
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Download"),
    });
    await f.until(() => f.artifacts.length === 1);
    const artifact = f.artifacts[0];
    if (!artifact) throw new Error("artifact");
    expect(artifact).toMatchObject({
      filename: "example.zip",
      mimeType: "application/zip",
      flags: ["archive"],
      bytes: 11,
    });
    expect(await readFile(artifact.path, "utf8")).toBe("zip-fixture");
  },
);
it.skipIf(!executablePath)(
  "an embedder's upload hook can refuse outside paths, while workspace files and known artifacts upload",
  async () => {
    const priorArtifacts = new Set<string>();
    const f = await setup({
      artifactAllowed: (_thread, path) => priorArtifacts.has(path),
      uploadPolicy: () => false,
    });
    await writeFile(join(f.home, "upload.txt"), "upload-content");
    const fileRef = ref(await f.execute({ action: "snapshot" }), "File");
    await f.execute({ action: "upload", ref: fileRef, files: ["upload.txt"] });
    expect(await f.evaluate("document.querySelector('[type=file]').files[0].name")).toBe(
      "upload.txt",
    );
    const outside = await mkdtemp(join(tmpdir(), "ace-outside-"));
    await writeFile(join(outside, "outside.txt"), "outside");
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await expect(
      f.execute({ action: "upload", ref: fileRef, files: [join(outside, "outside.txt")] }),
    ).rejects.toMatchObject({ code: "denied" });
    await symlink(join(outside, "outside.txt"), join(f.home, "linked.txt"));
    await expect(
      f.execute({ action: "upload", ref: fileRef, files: ["linked.txt"] }),
    ).rejects.toMatchObject({ code: "denied" });
    priorArtifacts.add(join(outside, "outside.txt"));
    await f.execute({ action: "upload", ref: fileRef, files: [join(outside, "outside.txt")] });
    expect(await f.evaluate("document.querySelector('[type=file]').files[0].name")).toBe(
      "outside.txt",
    );
  },
);
it.skipIf(!executablePath)(
  "read-only evaluation reads DOM but refuses mutation, navigation and network writes",
  async () => {
    const f = await setup();
    const beforeBody = await f.evaluate("document.body.innerHTML"),
      beforeUrl = f.service.state("thread").url;
    const beforeWrites = f.writes();
    expect(
      await f.execute({ action: "evaluate", mode: "read-only", expression: "document.title" }),
    ).toBe("Parity");
    for (const expression of [
      "document.body.textContent='changed'",
      "location.href='/other'",
      "fetch('/body',{method:'POST'})",
    ])
      await expect(
        f.execute({ action: "evaluate", mode: "read-only", expression }),
      ).rejects.toThrow("Read-only evaluation refused side effects or failed");
    expect(await f.evaluate("document.body.innerHTML")).toBe(beforeBody);
    expect(f.service.state("thread").url).toBe(beforeUrl);
    expect(f.writes()).toBe(beforeWrites);
  },
);
it.skipIf(!executablePath)(
  "a private tab blocks all agent reads, and stays private after the person disconnects",
  async () => {
    const f = await setup();
    keepAgentsOut(f.service, "thread");
    for (const command of [
      { action: "snapshot" },
      { action: "screenshot" },
      { action: "logs" },
      { action: "find", role: "button", name: "Prompt" },
      { action: "wait_for", text: "Popup" },
      { action: "network_body", requestId: "private" },
      { action: "evaluate", expression: "document.body.innerHTML", mode: "read-only" },
      { action: "record_start" },
      { action: "record_stop" },
    ])
      await expect(f.execute(command)).rejects.toMatchObject({ code: "human_private" });
    await expect(f.service.startRecording("thread")).rejects.toMatchObject({
      code: "human_private",
    });
    await expect(f.service.stopRecording("thread")).rejects.toMatchObject({
      code: "human_private",
    });
    await expect(f.service.screenshot("thread")).rejects.toMatchObject({ code: "human_private" });
    // Agents still see that the tab exists, never where it is.
    expect(tabs.parse(await f.execute({ action: "tabs" })).tabs).toEqual([
      expect.objectContaining({ url: "about:blank" }),
    ]);
    f.service.disconnect("human");
    await expect(f.execute({ action: "snapshot" })).rejects.toMatchObject({
      code: "human_private",
    });
    keepAgentsOut(f.service, "thread", false);
    expect(Snapshot.parse(await f.execute({ action: "snapshot" })).nodes.length).toBeGreaterThan(0);
  },
);

it.skipIf(!executablePath)(
  "keeping agents out cancels an in-flight download without publishing its bytes",
  async () => {
    const f = await setup();
    await f.execute({
      action: "click",
      ref: ref(await f.execute({ action: "snapshot" }), "Slow download"),
    });
    await f.until(() => f.service.state("thread").downloads?.[0]?.state === "pending");
    keepAgentsOut(f.service, "thread");
    f.finishSlow();
    await f.until(() => f.service.state("thread").downloads?.[0]?.state === "denied");
    expect(f.artifacts).toEqual([]);
    keepAgentsOut(f.service, "thread", false);
    expect(f.service.state("thread").downloads?.[0]?.path).toBeUndefined();
  },
);
it.skipIf(!executablePath)("oversized downloads never publish artifacts", async () => {
  const f = await setup({ maxDownloadBytes: 8 });
  await f.execute({
    action: "click",
    ref: ref(await f.execute({ action: "snapshot" }), "Download"),
  });
  await f.until(() =>
    /failed|too_large/.test(f.service.state("thread").downloads?.[0]?.state ?? ""),
  );
  expect(f.artifacts).toEqual([]);
  expect(f.service.state("thread").downloads?.[0]?.path).toBeUndefined();
});
it.skipIf(!executablePath)(
  "agent recording tools publish the existing recording artifact",
  async () => {
    const f = await setup();
    expect(await f.execute({ action: "record_start" })).toEqual({ recording: true });
    const recording = z
      .object({ path: z.string(), mimeType: z.string(), bytes: z.number().positive() })
      .parse(await f.execute({ action: "record_stop" }));
    expect(f.artifacts).toEqual([recording]);
    expect((await readFile(recording.path)).byteLength).toBe(recording.bytes);
  },
);

it.skipIf(!executablePath)("each same-URL download needs its own approval", async () => {
  let allowed = true;
  const f = await setup({ downloadPolicy: () => allowed });
  const file = ref(await f.execute({ action: "snapshot" }), "Plain download");
  await f.execute({ action: "click", ref: file });
  await f.until(() => f.service.downloadsList("thread")[0]?.state === "complete");
  allowed = false;
  await f.execute({ action: "click", ref: file });
  await f.until(() => f.service.downloadsList("thread")[1]?.state === "denied");
  expect(f.artifacts).toHaveLength(1);
  expect(await readFile(f.artifacts[0]?.path ?? "", "utf8")).toBe("plain-fixture");
});
it.skipIf(!executablePath)("attachment-like reads cannot authorize a later download", async () => {
  let allowed = true;
  const f = await setup({ downloadPolicy: () => allowed });
  expect(await f.evaluate("fetch('/plain',{headers:{'x-preview':'1'}}).then(r=>r.text())")).toBe(
    "plain-fixture",
  );
  allowed = false;
  await f.execute({
    action: "click",
    ref: ref(await f.execute({ action: "snapshot" }), "Plain download"),
  });
  await f.until(() => f.service.downloadsList("thread")[0]?.state === "denied");
  expect(f.artifacts).toEqual([]);
});
it.skipIf(!executablePath)(
  "a pending dialog holds only its own tab while another tab keeps working",
  async () => {
    const f = await setup(),
      a = f.service.state("thread").activeTabId;
    const b = z
      .object({ tabId: z.string() })
      .parse(await f.execute({ action: "tabs", operation: "open", url: f.url + "/other" })).tabId;
    const pending = z
      .object({ pending_dialog: z.object({ dialogId: z.string(), tabId: z.string() }) })
      .parse(
        await f.execute({
          action: "evaluate",
          tabId: a,
          expression: "document.body.dataset.answer = prompt('Across tabs')",
        }),
      );
    expect(pending.pending_dialog.tabId).toBe(a);
    expect(await f.execute({ action: "snapshot", tabId: a })).toMatchObject({
      pending_dialog: { tabId: a },
    });
    expect(await f.execute({ action: "snapshot", tabId: b })).toMatchObject({ tabId: b });
    expect(
      await f.execute({
        action: "dialog",
        tabId: b,
        dialogId: pending.pending_dialog.dialogId,
        accept: true,
        promptText: "answered",
      }),
    ).toEqual({ ok: true });
    expect(
      await f.execute({
        action: "evaluate",
        tabId: a,
        expression: "document.body.dataset.answer",
      }),
    ).toBe("answered");
  },
);
