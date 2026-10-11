import type { ReactNode } from "react";
import type { ForgePrDetail, ForgePrRow, ForgeFile, ForgePrFiles } from "@ace/protocol";
import type { LineRange, LineTarget } from "@/features/panels/index.ts";

/** Adapters supply only capabilities confirmed by their own fresh daemon resource. */
export interface PrWorkspaceContext {
  workspaceId: string;
  detail: ForgePrDetail;
  disabled: boolean;
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
  comment?(body: string, context: PrWorkspaceContext): Promise<void>;
  review?(body: string, context: PrWorkspaceContext): Promise<void>;
  closeWithComment?(body: string, context: PrWorkspaceContext): Promise<void>;
  resolveInWorktree?(context: PrWorkspaceContext): void;
  viewed?(
    file: ForgeFile,
    context: PrDiffContext,
  ):
    | {
        checked: boolean;
        disabled: boolean;
        change(checked: boolean): Promise<void>;
      }
    | undefined;
  viewedCount?(context: PrDiffContext): number;
  onLineComment?(path: string, range: LineRange, context: PrDiffContext): void;
  annotation?(path: string, target: LineTarget, context: PrDiffContext): ReactNode;
  /** #520 resolves bare references; known PR URLs already navigate inside ace. */
  reference?(number: number, context: PrWorkspaceContext): void;
}
export interface PrListExtensions {
  actions?(row: ForgePrRow): ReactNode;
  beforeRows?: ReactNode;
}
