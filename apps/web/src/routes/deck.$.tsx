import { createFileRoute } from "@tanstack/react-router";

/** Any old `/deck/…` address; its parent sends it on to `/offshifts/…`. */
export const Route = createFileRoute("/deck/$")({});
