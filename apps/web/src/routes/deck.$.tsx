import { createFileRoute } from "@tanstack/react-router";

/** Any old `/deck/…` address; its parent sends it on to `/offsets/…`. */
export const Route = createFileRoute("/deck/$")({});
