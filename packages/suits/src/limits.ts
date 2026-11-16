/** Size caps on a Suit's folder (ADR 0150): larger files are refused, never read. */
export const suitLimits = {
  manifestBytes: 64 * 1024,
  sceneBytes: 512 * 1024,
  /** suit.css, before the sanitiser reads it. */
  cssBytes: 256 * 1024,
  /** Everything besides suit.json and scene.js: assets and any other file the folder holds. */
  assetBytes: 20 * 1024 * 1024,
  files: 512,
  depth: 8,
} as const;
