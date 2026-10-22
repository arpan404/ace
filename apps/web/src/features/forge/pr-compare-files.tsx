import { useMemo } from "react";
import type { ForgeFile } from "@ace/protocol";
import { useFileChanges } from "@/lib/diffs/use-file-diffs.ts";
import { DeferredFileDiffBlock, useFileViews } from "@/features/panels/index.ts";
import { hostedFileChanges, hostedFileStatus } from "./pr-code-model.ts";

const FileDiffBlock = DeferredFileDiffBlock.Component;

/**
 * Changed files between two branches, read only: the PR Code tab's diff blocks without review,
 * for a pull request that doesn't exist yet. A file GitHub sent no patch for says so.
 */
export function PrCompareFiles(props: { files: readonly ForgeFile[] }) {
  const inputs = useMemo(() => hostedFileChanges(props.files), [props.files]);
  const diffs = useFileChanges(inputs);
  const byPath = useMemo(() => new Map(diffs.files.map((diff) => [diff.path, diff])), [diffs]);
  const views = useFileViews(diffs.files);
  return (
    <div className="space-y-2">
      {props.files.map((file) => {
        const diff = byPath.get(file.path);
        if (!diff)
          return (
            <div key={file.path} className="flex h-8 items-center text-xs text-subtle-foreground">
              <span className="truncate font-mono">{file.path}</span>
            </div>
          );
        return (
          <div key={file.path}>
            <FileDiffBlock
              file={{
                ...diff,
                status: hostedFileStatus(file),
                additions: file.additions,
                deletions: file.deletions,
              }}
              view={views.viewOf(diff)}
              onView={(next) => views.setView(file.path, next)}
              mode="unified"
              wrap={false}
              highlighted={() => false}
              renderAnnotation={() => null}
              body={
                file.patch === null ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    GitHub shows this file's changes once the pull request is open.
                  </p>
                ) : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}
