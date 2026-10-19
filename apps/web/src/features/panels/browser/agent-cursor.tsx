import { useAgent } from "@ace/client-react";
import { agentName } from "@ace/ui-core";
import { AgentCursorIcon } from "@/components/ace-icons.tsx";
import { useLayoutEffect, useState, type RefObject } from "react";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the page's picture is drawn inside its pane, kept current as the pane resizes. */
function usePictureBox(picture: RefObject<HTMLElement | null>): Box | undefined {
  const [box, setBox] = useState<Box>();
  useLayoutEffect(() => {
    const element = picture.current;
    if (!element) return;
    const measure = () =>
      setBox((before) => {
        const next = {
          left: element.offsetLeft,
          top: element.offsetTop,
          width: element.clientWidth,
          height: element.clientHeight,
        };
        return before &&
          before.left === next.left &&
          before.top === next.top &&
          before.width === next.width &&
          before.height === next.height
          ? before
          : next;
      });
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [picture]);
  return box;
}

/**
 * Over the live frames, for a daemon that does not draw cursors in the page itself (or while a
 * recording keeps them out of it): the agent working in the shown tab, as a cursor that glides
 * to where it last clicked, hovered or dropped (`pointer`, in the page's CSS pixels). It moves by transform alone and
 * never takes input: the person keeps using the page under it.
 */
export function AgentCursor(props: {
  threadId: string;
  agentId: string | undefined;
  pointer: { x: number; y: number; sequence: number };
  /** The page's size in the same pixels as `pointer`. */
  page: { width: number; height: number };
  picture: RefObject<HTMLElement | null>;
}) {
  const agent = useAgent(props.threadId, props.agentId ?? "");
  const name = agent ? agentName(agent) : "An agent";
  const box = usePictureBox(props.picture);
  if (!box || !props.page.width || !props.page.height) return null;
  const x = box.left + (props.pointer.x / props.page.width) * box.width;
  const y = box.top + (props.pointer.y / props.page.height) * box.height;
  return (
    <span
      role="img"
      aria-label={`${name} is pointing here`}
      data-agent-cursor=""
      style={{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` }}
      className="pointer-events-none absolute top-0 left-0 transition-transform duration-(--motion-slow) ease-smooth"
    >
      {/* The Pebble's tip, not its box, sits on the point. */}
      <AgentCursorIcon aria-hidden size={22} className="-translate-x-[4px] -translate-y-[4.5px]" />
    </span>
  );
}
