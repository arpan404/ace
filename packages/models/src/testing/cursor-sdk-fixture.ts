/** Synthetic metadata based on @cursor/sdk 1.0.35 options.d.ts. No service capture. */
export const cursorSdkModels = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Synthetic model with all declared SDK fields",
    aliases: ["composer"],
    parameters: [
      {
        id: "reasoning_effort",
        displayName: "Effort",
        futureParameterType: "new-enum",
        values: [
          { value: "", displayName: "Automatic" },
          { value: "high", displayName: "High", futureValueHint: "new" },
        ],
      },
      { id: "speed", values: [{ value: "fast" }, { value: "" }] },
    ],
    variants: [
      {
        displayName: "Automatic",
        description: "Default settings",
        futureVariant: { enabled: true },
        isDefault: true,
        params: [
          { id: "reasoning_effort", value: "" },
          { id: "speed", value: "", futureSelection: "new" },
        ],
      },
      { displayName: "High effort", params: [{ id: "reasoning_effort", value: "high" }] },
    ],
    future: { category: "new-enum-value", apiKey: "sentinel-key" },
  },
  { id: "minimal", displayName: "Minimal" },
  {
    id: "nullable",
    displayName: null,
    description: null,
    aliases: null,
    parameters: null,
    variants: null,
    newerField: { enabled: true },
  },
];

export const cursorSdkMixedModels = [
  cursorSdkModels[0],
  { id: null, displayName: "Malformed" },
  ...cursorSdkModels.slice(1),
];
