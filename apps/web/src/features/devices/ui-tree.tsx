import type { ScreenUITreeResult } from "@ace/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import type { Bounds } from "./device-stage.tsx";
import { shortRefs, type RefNode } from "./ui-tree-refs.ts";

export type TreeState =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; tree: ScreenUITreeResult };

/** The screen's accessibility tree while `active`, read again on `reload`. */
export function useUiTree(read: () => Promise<ScreenUITreeResult | undefined>, active: boolean) {
  // Each read is numbered; until the newest one answers, the tree shows as loading.
  const [answer, setAnswer] = useState<{ attempt: number; tree: TreeState }>();
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    if (!active) return;
    let alive = true;
    latest
      .current()
      .then((result) => {
        if (alive && result) setAnswer({ attempt, tree: { state: "ready", tree: result } });
      })
      .catch((error: unknown) => {
        if (alive)
          setAnswer({
            attempt,
            tree: {
              state: "failed",
              message: error instanceof Error ? error.message : "The screen couldn't be read.",
            },
          });
      });
    return () => {
      alive = false;
    };
  }, [active, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const tree: TreeState = answer?.attempt === attempt ? answer.tree : { state: "loading" };
  return { tree, reload };
}

function TreeRows(props: {
  nodes: readonly RefNode[];
  depth: number;
  onHighlight(bounds: Bounds | undefined): void;
}) {
  return (
    <ul
      role={props.depth === 0 ? "tree" : "group"}
      aria-label={props.depth === 0 ? "UI tree" : undefined}
    >
      {props.nodes.map(({ node, ref, children }) => (
        <li
          key={node.ref}
          role="treeitem"
          aria-label={[ref && `@${ref}`, node.role, node.name].filter(Boolean).join(" ")}
        >
          <div
            onPointerEnter={() => props.onHighlight(node.bounds)}
            onPointerLeave={() => props.onHighlight(undefined)}
            className="flex h-6 items-center gap-2 rounded-sm pr-2 hover:bg-hover"
            style={{ paddingLeft: `${8 + props.depth * 12}px` }}
          >
            {ref && <span className="shrink-0 font-mono text-subtle-foreground">@{ref}</span>}
            <span className="shrink-0 text-muted-foreground">{node.role}</span>
            {node.name && <span className="min-w-0 truncate text-foreground">{node.name}</span>}
          </div>
          {children.length > 0 && (
            <TreeRows nodes={children} depth={props.depth + 1} onHighlight={props.onHighlight} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The refs tree agents see (`@eN`, role, name). Hovering a row outlines that element's bounds on
 * the stage.
 */
export function UiTree(props: {
  tree: TreeState;
  onReload(): void;
  onHighlight(bounds: Bounds | undefined): void;
}) {
  const { tree } = props;
  if (tree.state === "loading")
    return <ListSkeleton label="UI tree" shape="row" rows={5} className="px-3" />;
  if (tree.state === "failed")
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-2 text-ui text-muted-foreground">
        <span>Couldn't read the screen. {tree.message}</span>
        <Button size="sm" variant="ghost" onClick={props.onReload}>
          Retry
        </Button>
      </div>
    );
  if (tree.tree.nodes.length === 0)
    return <p className="px-3 py-2 text-ui text-subtle-foreground">Nothing on screen to read</p>;
  return (
    <div
      className="h-full overflow-auto px-1 py-1 text-xs"
      onPointerLeave={() => props.onHighlight(undefined)}
    >
      <TreeRows nodes={shortRefs(tree.tree.nodes)} depth={0} onHighlight={props.onHighlight} />
      {tree.tree.truncated && (
        <p className="px-2 py-1 text-subtle-foreground">The tree is cut short here.</p>
      )}
    </div>
  );
}
