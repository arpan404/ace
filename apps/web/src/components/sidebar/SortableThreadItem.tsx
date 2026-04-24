import { type CSSProperties, type ReactNode } from "react";
import { type ThreadId } from "@ace/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface SortableThreadHandleProps {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
  setNodeRef: ReturnType<typeof useSortable>["setNodeRef"];
  style: CSSProperties;
  isDragging: boolean;
  isOver: boolean;
}

export function SortableThreadItem({
  threadId,
  disabled = false,
  children,
}: {
  threadId: ThreadId;
  disabled?: boolean;
  children: (handleProps: SortableThreadHandleProps) => ReactNode;
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
  } = useSortable({ id: threadId, disabled });

  return children({
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    style: {
      transform: CSS.Translate.toString(transform),
      transition,
    },
    isDragging,
    isOver,
  });
}
