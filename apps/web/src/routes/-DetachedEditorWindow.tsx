import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { ServerStateBootstrap } from "../rpc/serverStateBootstrap";
import { UiTypographyBridge } from "../components/UiTypographyBridge";
import { DetachedEditorWindowContent } from "./-DetachedEditorWindowContent";

export function DetachedEditorWindow(props: {
  search: {
    kind: "editor";
    threadId: string | null;
    connectionUrl: string | null;
    editorStateInstanceId: string | null;
    placement: string | null;
    workspaceMode: string | null;
  };
}) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <UiTypographyBridge />
        <ServerStateBootstrap />
        <DetachedEditorWindowContent
          connectionUrl={props.search.connectionUrl}
          editorStateInstanceId={props.search.editorStateInstanceId}
          placement={props.search.placement}
          threadId={props.search.threadId}
          workspaceMode={props.search.workspaceMode}
        />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
