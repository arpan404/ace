import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { ActivityScreen } from "@/features/activity/index.ts";

/** `?item=` shows one Activity item on its own, by its card key ("event:…", "run:…"). */
const Search = z.object({
  item: z.catch(z.optional(z.string().check(z.maxLength(1024))), undefined),
});

export const Route = createFileRoute("/activity/")({
  validateSearch: (search) => Search.parse(search),
  component: ActivityScreen,
});
