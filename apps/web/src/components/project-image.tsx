import { useState, type ReactNode } from "react";

/** Failed or missing custom artwork keeps the project's existing mark. */
export function ProjectImage(props: {
  icon?: string | null | undefined;
  fallback: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  if (!props.icon || failed === props.icon) return props.fallback;
  return (
    <img
      key={props.icon}
      src={props.icon}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      decoding="async"
      className={props.className ?? "h-4 w-4 shrink-0 rounded-xs object-contain"}
      onError={() => setFailed(props.icon ?? undefined)}
    />
  );
}
