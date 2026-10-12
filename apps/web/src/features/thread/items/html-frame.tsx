import { useEffect, useRef, useState } from "react";
import { HtmlHeightMessage } from "@ace/protocol";
import { visualizationUrl, type HtmlTheme } from "@ace/html";

export function HtmlFrame(props: {
  html: string;
  title: string;
  theme: HtmlTheme;
  height: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [measured, setMeasured] = useState(320);
  const source = visualizationUrl(props.html, props.theme);
  useEffect(() => {
    let pending: number | undefined;
    const resized = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const parsed = HtmlHeightMessage.safeParse(event.data);
      if (!parsed.success) return;
      if (pending !== undefined) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => setMeasured(Math.ceil(parsed.data.height)));
    };
    window.addEventListener("message", resized);
    return () => {
      window.removeEventListener("message", resized);
      if (pending !== undefined) cancelAnimationFrame(pending);
    };
  }, []);
  return (
    <iframe
      ref={frame}
      title={props.title}
      src={source}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height: Math.max(80, Math.min(props.height, measured)) }}
    />
  );
}
