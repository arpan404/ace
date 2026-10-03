import createQr from "qrcode-generator";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";

/**
 * A QR code drawn as one SVG path, dark modules on white with a quiet zone so phone cameras
 * read it in either theme. `label` is the accessible name; show the payload as text nearby too.
 */
function QrCode(props: { value: string; label: string; size?: number; className?: string }) {
  const { path, count } = useMemo(() => {
    const qr = createQr(0, "M");
    qr.addData(props.value);
    qr.make();
    const modules = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < modules; row++)
      for (let col = 0; col < modules; col++)
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { path: d, count: modules + 8 };
  }, [props.value]);
  const size = props.size ?? 176;
  return (
    <svg
      role="img"
      aria-label={props.label}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      className={cn("rounded-md bg-white", props.className)}
    >
      <path d={path} fill="#111" />
    </svg>
  );
}

export { QrCode };
