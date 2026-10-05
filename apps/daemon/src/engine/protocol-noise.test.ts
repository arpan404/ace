import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { replayFixture } from "@ace/adapter-testkit";
import { protocolNoiseCases } from "./protocol-noise-test-support.ts";

for (const corpus of protocolNoiseCases) {
  test(`${corpus.name} keeps protocol noise out of the transcript and retains evidence through later output`, () => {
    const frames = [...corpus.setup, ...corpus.noise, ...corpus.after].map((frame, i) =>
      Object.assign({}, frame, { seq: i, t: i }),
    );
    const result = replayFixture({
      createTranslator: corpus.create,
      coreConfig: { provider: corpus.provider, silenceMs: 90000 },
      fixture: {
        header: {
          format: "ace-recording/v1",
          provider: corpus.provider,
          cliVersion: "synthetic",
          scenario: "protocol noise",
          startedAt: "2026-10-04",
          platform: "test",
          workspace: "/fixture",
        },
        frames,
      },
    });
    const items = Object.values(result.final.view.items);
    const notices = items.filter((item) => item.type === "notice");
    for (const notice of notices) {
      expect(notice.text).not.toMatch(
        /(?:^[\w-]+(?:[/.][\w-]+)+$|\b(?:frame|event)\s*$|^[0-9a-f-]{32,36}$)/i,
      );
    }
    expect(notices).toEqual([]);
    expect(
      items.some(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "Still here"),
      ),
    ).toBe(true);
    for (const frame of corpus.noise.filter((candidate) =>
      JSON.stringify(candidate.data).includes("future evidence"),
    )) {
      const expected = JSON.stringify(frame.data).replaceAll(
        "synthetic-secret",
        corpus.provider === "opencode" ? "[redacted]" : "synthetic-secret",
      );
      expect(
        result.diagnostics.some((raw) => "data" in raw && JSON.stringify(raw.data) === expected),
      ).toBe(true);
    }
    expect(JSON.stringify(result.diagnostics)).toContain("future evidence");
  });
}

for (const corpus of protocolNoiseCases) {
  test(`${corpus.name} bounds undrained diagnostics to the latest translation and drains once`, () => {
    const translator = corpus.create({
      threadId: ThreadId.parse("diagnostic-burst"),
      rootKey: "root",
    });
    for (const [i, frame] of corpus.setup.entries())
      translator.translate(Object.assign({}, frame, { seq: i, t: i }), i);
    const unknown = corpus.noise.find((candidate) =>
      JSON.stringify(candidate.data).includes("future evidence"),
    );
    if (!unknown) throw new Error("Corpus requires unknown evidence");
    for (let i = 0; i < 256; i++)
      translator.translate(Object.assign({}, unknown, { seq: i + 100, t: i + 100 }), i + 100);
    const diagnostics = translator.takeDiagnostics?.() ?? [];
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).toContain("future evidence");
    expect(translator.takeDiagnostics?.()).toEqual([]);
  });
}
