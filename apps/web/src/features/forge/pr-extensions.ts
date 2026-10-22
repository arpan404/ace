import type { ReactNode } from "react";
import type { ForgePrDetail, ForgePrRow, ForgePrFiles } from "@ace/protocol";

/** Adapters supply only capabilities confirmed by their own fresh daemon resource. */
export interface PrWorkspaceContext {
  workspaceId: string;
  detail: ForgePrDetail;
  disabled: boolean;
  /** The conversation is locked and this account can't comment, review or react. */
  commentsLocked?: boolean | undefined;
  refresh(): Promise<boolean>;
}
/** The exact hosted range displayed, including historical commit and its first parent. */
export interface PrDiffContext extends PrWorkspaceContext {
  files: ForgePrFiles;
}
export interface PrWorkspaceExtensions {
  headerActions?(context: PrWorkspaceContext): ReactNode;
  overflow?(context: PrWorkspaceContext): ReactNode;
  reviewers?(context: PrWorkspaceContext): ReactNode;
  labels?(context: PrWorkspaceContext): ReactNode;
  editDescription?(context: PrWorkspaceContext): void;
  summary?(context: PrWorkspaceContext): ReactNode;
  resolveInWorktree?(context: PrWorkspaceContext): void;
  /** #520 resolves bare references; known PR URLs already navigate inside ace. */
  reference?(number: number, context: PrWorkspaceContext): void;
}
export interface PrListExtensions {
  actions?(row: ForgePrRow): ReactNode;
  beforeRows?: ReactNode;
}
