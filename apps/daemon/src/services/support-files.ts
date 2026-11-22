import { publishArtifact } from "../publish-artifact.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { FilesService, FileError } from "@ace/files";
import { supportBundleWriter } from "../files-support.ts";
import { connectedDoctorReport } from "../diagnostics-report.ts";
import type { ServiceContext } from "./types.ts";

export { conversationBundle } from "../support-bundle-id.ts";

/** A private artifact registry works before the person has added any project. */
export async function startSupportFiles(owner: ServiceContext) {
  const { config, now, id, resources, services } = owner;
  const root = join(config.dataDir, "support");
  const empty = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(empty, { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const writer = supportBundleWriter(
    config.dataDir,
    root,
    {
      home: homedir(),
      env: process.env,
      ...(config.workspaceRoot ? { workspace: config.workspaceRoot } : {}),
    },
    now,
    {
      settings: config,
      report:
        owner.options.diagnostics?.doctor ??
        (() => connectedDoctorReport(config, process.env, now)),
    },
  );
  let pending: Promise<string> | undefined;
  const files = await FilesService.create({
    workspace: empty,
    dataDir: join(root, "registry"),
    artifactRoots: [artifacts],
    now,
    id,
    authorize: () => true,
    exportSupport(_device, assertAuthorized, includeThreads) {
      if (pending) throw new FileError("BUSY", "A support export is already running");
      // An organization's host hands no member content to its operator (ADR 0209 §3).
      if (includeThreads && owner.orgHost?.org() !== undefined)
        throw new FileError("FORBIDDEN", "An organization's host doesn't export conversations.");
      /**
       * Asked as it starts and again before it is published: a bundle of conversations begun on
       * a person's machine is never published on an organization's host (ADR 0209 §3).
       */
      const guard = () => {
        assertAuthorized();
        if (includeThreads && owner.orgHost?.org() !== undefined)
          throw new FileError("FORBIDDEN", "An organization's host doesn't export conversations.");
      };
      pending = (async () => {
        guard();
        return publishArtifact(
          files,
          artifacts,
          {
            size: 36 * 1024 ** 2,
            id: `${includeThreads ? "local-support" : "support"}-${id()}`,
            path: `support-${id()}.tar.gz`,
            name: "ace-support.tar.gz",
            category: "support",
            write: (temporary) => writer(temporary, includeThreads),
          },
          guard,
        );
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  });
  resources.own(async () => {
    await pending?.catch(() => {});
    await files.close();
  });
  await files.sweep(owner.signal);
  services.supportFiles = files;
}
