import type { ComponentProps } from "react";

/** Mirrored wings gather around an open diamond; the mark follows its surface's accent. */
export function AceMark(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M11.6 2C10.8 2 10.4 2.6 9.8 3.3L2.9 11.3C1.2 13.3 1.8 15.6 3.8 16.8L7.8 19.3C8.5 19.8 9.3 19.8 9.9 19.1L11 17.7C11.7 16.8 11.5 16.1 10.8 15.4L7.3 12.3C10.3 9.8 11.6 7.6 11.6 5V2Z" />
      <path
        transform="translate(24 0) scale(-1 1)"
        d="M11.6 2C10.8 2 10.4 2.6 9.8 3.3L2.9 11.3C1.2 13.3 1.8 15.6 3.8 16.8L7.8 19.3C8.5 19.8 9.3 19.8 9.9 19.1L11 17.7C11.7 16.8 11.5 16.1 10.8 15.4L7.3 12.3C10.3 9.8 11.6 7.6 11.6 5V2Z"
      />
    </svg>
  );
}
