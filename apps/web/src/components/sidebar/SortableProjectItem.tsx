import { type CSSProperties, type ReactNode, useCallback } from "react";
import { ProjectId } from "@ace/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

export function SortableProjectItem({
  projectId,
  disabled = false,
  measureElement,
  style,
  virtualIndex,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  measureElement?: (element: HTMLElement | null) => void;
  style?: CSSProperties;
  virtualIndex?: number;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  const setMeasuredNodeRef = useCallback(
    (element: HTMLLIElement | null) => {
      setNodeRef(element);
      measureElement?.(element);
    },
    [measureElement, setNodeRef],
  );
  const sortableTransform = CSS.Translate.toString(transform);
  const composedTransform = [style?.transform, sortableTransform].filter(Boolean).join(" ");

  return (
    <li
      ref={setMeasuredNodeRef}
      style={{
        ...style,
        transform: composedTransform || undefined,
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      data-index={virtualIndex}
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}
