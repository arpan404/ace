import { createFileRoute } from "@tanstack/react-router";

/** Any old `/offsets/…` address; its parent sends it on to `/offshifts/…`. */
export const Route = createFileRoute("/offsets/$")({});
