import { BrowserArtifactFiles } from "./browser-artifact-files.ts";
import { createHash } from "node:crypto";
import { FilesService } from "@ace/files";
import type { ThreadId } from "@ace/protocol";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { ServiceContext } from "./services/types.ts";

/** Shared persistent upload/mutation owner per execution root, independent of ACE_WORKSPACE_ROOT. */
export class FilesWorkspaces {
    await this.browserArtifacts.sweep(signal);
