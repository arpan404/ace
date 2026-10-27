import type { APIRoute } from "astro";
import { product } from "../content/product.ts";

/** Lets browsers and phones show ace's name and icon when the site is saved or shared. */
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      name: product.name,
      short_name: product.name,
      description: product.description,
      start_url: "/",
      display: "browser",
      background_color: "#11100f",
      theme_color: "#11100f",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    }),
    { headers: { "content-type": "application/manifest+json" } },
  );
