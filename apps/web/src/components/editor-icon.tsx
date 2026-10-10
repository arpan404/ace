import { FileCodeIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { useEditorAppIcon } from "@/lib/editors.ts";
import { cn } from "@/lib/cn.ts";
import vscode from "@/assets/editors/vscode.svg";
import cursor from "@/assets/editors/cursor.svg";
import zed from "@/assets/editors/zed.png";
import sublime from "@/assets/editors/sublime.ico";
import idea from "@/assets/editors/idea.svg";

const marks: Record<string, { src: string; monochrome?: boolean }> = {
  code: { src: vscode },
  subl: { src: sublime },
  idea: { src: idea },
  cursor: { src: cursor, monochrome: true },
  zed: { src: zed, monochrome: true },
};

/** The installed app's OS icon, or its published brand mark in a browser. */
export function EditorIcon(props: { id: string | undefined; size?: number; className?: string }) {
  const native = useEditorAppIcon(props.id ?? "");
  const size = props.size ?? 16;
  const mark = marks[props.id ?? ""];
  const fallback = mark ? (
    mark.monochrome ? (
      <span
        aria-hidden
        data-app-icon={props.id}
        className={cn("inline-block shrink-0 bg-current", props.className)}
        style={{
          width: size,
          height: size,
          maskImage: `url(${JSON.stringify(mark.src)})`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    ) : (
      <img
        alt=""
        data-app-icon={props.id}
        src={mark.src}
        width={size}
        height={size}
        className={cn("shrink-0 object-contain", props.className)}
        draggable={false}
      />
    )
  ) : (
    <FileCodeIcon aria-hidden size={size} className={props.className} />
  );
  return native ? (
    <NativeIcon
      key={native}
      src={native}
      id={props.id}
      size={size}
      className={props.className}
      fallback={fallback}
    />
  ) : (
    fallback
  );
}

function NativeIcon(props: {
  src: string;
  id: string | undefined;
  size: number;
  className: string | undefined;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    props.fallback
  ) : (
    <img
      alt=""
      data-app-icon={props.id}
      src={props.src}
      width={props.size}
      height={props.size}
      className={cn("shrink-0 object-contain", props.className)}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
