import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { brandArt, type Brand } from "@ace/ui-core/provider-icons";
import { ProviderIcon } from "../components/ui/provider-icons.tsx";

/** Fake-browser visual fixture, never imported by the shipped app. */
export function showProviderMarks(size: 12 | 16 | 20) {
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Provider marks");
  Object.assign(panel.style, {
    position: "fixed",
    inset: "0",
    zIndex: "200",
    background: "var(--background)",
    color: "var(--foreground)",
    padding: "16px",
    overflow: "auto",
  });
  document.body.append(panel);
  createRoot(panel).render(
    createElement(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
          gap: "8px",
        },
      },
      Object.keys(brandArt).flatMap((brand) =>
        ["color", "mono"].map((variant) =>
          createElement(
            "div",
            {
              key: `${brand}-${variant}`,
              style: { display: "flex", gap: "8px", alignItems: "center" },
            },
            createElement(ProviderIcon, {
              provider: "opencode",
              brand: brand as Brand,
              size,
              variant: variant === "mono" ? "mono" : "color",
              label: `${brand} ${variant}`,
            }),
            createElement("span", { style: { fontSize: "12px" } }, `${brand} ${variant}`),
          ),
        ),
      ),
    ),
  );
}
