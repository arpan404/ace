import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import type { CodeScope } from "@ace/ui-core";
import type { PrWorkspaceContext } from "./pr-extensions.ts";

/** What the Code tab is given: the pull request, where to land, and who holds the commit choice. */
export interface PrFilesProps {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  context: PrWorkspaceContext;
  /** A file to scroll to (the Summary's Changes), at a line when given; a new `seq` asks again. */
  focus?: { path: string; line?: number | undefined; seq: number } | undefined;
  /** Which commits show, when the page holds the choice (the Timeline's commits open here). */
  scope?: CodeScope | undefined;
  onScope?: ((scope: CodeScope) => void) | undefined;
}
