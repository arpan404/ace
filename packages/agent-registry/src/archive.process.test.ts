import { expect, test } from "vitest";
import { pack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { readFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry, temporary, body, sample } from "./testing/support.ts";
import { digest } from "./index.ts";
async function tar(
  name: string,
  type: "file" | "symlink" = "file",
  following: readonly { name: string; content: string }[] = [],
): Promise<Uint8Array> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    archive.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected tar bytes");
      chunks.push(chunk);
    });
    archive.once("end", resolve);
    archive.once("error", reject);
  });
  archive.entry(
    { name, type, ...(type === "symlink" ? { linkname: "../../escape" } : {}) },
    type === "file" ? "synthetic executable" : "",
  );
  for (const entry of following) archive.entry({ name: entry.name, type: "file" }, entry.content);
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}
test.each(["traversal", "absolute"])(
  "archive path %s is rejected without publishing or writing outside its private root",
  async (kind) => {
    const work = await temporary();
    const escaped = join(work.root, "escape");
    const name = kind === "traversal" ? "../../../escape" : escaped;
    const bytes = await tar(name);
    const entry = sample();
    entry.distribution.binary = {
      "linux-x86_64": {
        archive: "https://example.org/agent.tgz",
        cmd: "agent",
        args: [],
        env: {},
        sha256: digest(bytes),
      },
    };
    const service = await registry(
      work.root,
      async () => new Response(body([entry])),
      async () => new Response(Buffer.from(bytes)),
    );
    try {
      await service.catalog.refresh();
      const preview = await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      });
      if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
      const reply = await service.handle({
        type: "registry.install-intent",
        requestId: "install",
        intentId: "intent",
        digest: preview.result.plan.digest,
      });
      expect(reply.result.ok).toBe(false);
      expect(service.inventory.list()).toEqual([]);
      await expect(access(escaped)).rejects.toThrow();
    } finally {
      await service.close();
      await work.close();
    }
  },
);
test("regular tar entries install while symlink artifacts cannot become a launch binding", async () => {
  for (const type of ["file", "symlink"] as const) {
    const work = await temporary();
    const bytes = await tar("agent", type);
    const entry = sample();
    entry.distribution.binary = {
      "linux-x86_64": {
        archive: "https://example.org/agent.tgz",
        cmd: "agent",
        args: [],
        env: {},
        sha256: digest(bytes),
      },
    };
    const service = await registry(
      work.root,
      async () => new Response(body([entry])),
      async () => new Response(Buffer.from(bytes)),
    );
    try {
      await service.catalog.refresh();
      const preview = await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      });
      if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
      const reply = await service.handle({
        type: "registry.install-intent",
        requestId: "install",
        intentId: "intent",
        digest: preview.result.plan.digest,
      });
      if (type === "file") {
        if (!reply.result.ok || !("installation" in reply.result))
          throw new Error("No installation");
        expect(
          await readFile((await service.resolve(reply.result.installation)).command, "utf8"),
        ).toBe("synthetic executable");
      } else {
        expect(reply.result.ok).toBe(false);
        expect(service.inventory.list()).toEqual([]);
      }
    } finally {
      await service.close();
      await work.close();
    }
  }
});

test("archive symlinks cannot redirect subsequent entries into an external directory", async () => {
  const work = await temporary();
  // ../../escape is relative to installations/<digest>/files/link.
  const external = join(work.root, "installations", "escape");
  await mkdir(external, { recursive: true });
  const bytes = await tar("link", "symlink", [
    { name: "link/created", content: "escaped" },
    { name: "agent", content: "synthetic executable" },
  ]);
  const entry = sample();
  entry.distribution.binary = {
    "linux-x86_64": {
      archive: "https://example.org/agent.tgz",
      cmd: "agent",
      args: [],
      env: {},
      sha256: digest(bytes),
    },
  };
  const service = await registry(
    work.root,
    async () => new Response(body([entry])),
    async () => new Response(Buffer.from(bytes)),
  );
  try {
    await service.catalog.refresh();
    const preview = await service.handle({
      type: "registry.install-plan",
      requestId: "plan",
      acpAgentId: "official:sample",
      runtime: "binary",
    });
    if (!preview.result.ok || !("plan" in preview.result)) throw new Error("Missing plan");
    const result = await service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "approved",
      digest: preview.result.plan.digest,
    });
    expect(result.result.ok).toBe(false);
    await expect(access(join(external, "created"))).rejects.toThrow();
    expect(service.inventory.list()).toEqual([]);
  } finally {
    await service.close();
    await work.close();
  }
});
