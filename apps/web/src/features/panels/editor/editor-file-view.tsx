import type { EditorViewerProps } from "@/features/editor-workbench/index.ts";
import { FileViewer } from "../files/file-viewer.tsx";
import { quickOpen } from "../files/quick-open-store.ts";
import { useFileContent } from "../files/use-checkout.ts";
import { useFileActions } from "../files/use-file-actions.ts";

const noUpload = () => {};

/**
 * An editor tab's file the editor doesn't take as text, read only (spec 65): a picture, a PDF in
 * the browser's viewer, video or audio in its players, or a binary or too-large file with
 * Download. The Files tool's own viewer and read, so these show exactly as they always have.
 */
export function EditorFileView(props: EditorViewerProps & { threadId: string }) {
  const { threadId, path } = props;
  const content = useFileContent(threadId, path);
  const actions = useFileActions(threadId, noUpload);
  return (
    <div className="relative min-h-0 flex-1 overflow-auto" tabIndex={-1}>
      <FileViewer
        path={path}
        content={content.data}
        error={content.error}
        source={false}
        wrap={false}
        onToggleWrap={noUpload}
        find={undefined}
        line={undefined}
        onRetry={() => void content.refetch()}
        onDownload={() => void actions.save(path)}
        onFind={() => quickOpen.set(() => threadId)}
      />
    </div>
  );
}
