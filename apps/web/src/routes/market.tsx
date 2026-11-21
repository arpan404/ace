import { createFileRoute, Navigate, useNavigate, useRouter } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { MarketScreen } from "@/features/marketplace/index.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/**
 * `/market?at=bot/inbox`: the Marketplace as a page (ADR 0168 §12), `at` saying where in it
 * (`market-address.ts`), so a link, a reload or Back lands where the person was. Off in
 * Settings › Beta, it goes home.
 */
export const Route = createFileRoute("/market")({
  validateSearch: z.object({
    at: z.catch(z.optional(z.string().check(z.maxLength(300))), undefined),
  }),
  component: Market,
});

function Market() {
  const { at } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const on = useBetaEnabled("marketplace");
  if (on === false) return <Navigate to="/" replace />;
  return (
    <MarketScreen
      at={at}
      onMove={(value, replace) =>
        void navigate({
          to: "/market",
          search: value === "discover" ? {} : { at: value },
          replace,
        })
      }
      onBack={() => router.history.back()}
    />
  );
}
