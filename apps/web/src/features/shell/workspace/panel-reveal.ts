/**
 * The side and bottom panel's colour over a Suit's app scene: `--suit-right-panel-reveal` of the
 * scene shows through (the Suit's `reveal["right-panel"]`, held to what keeps the panel's text
 * readable; theme/suits/suit-layers.ts). Solid without a scene, and by default.
 */
export const panelReveal =
  "[[data-suit-scene]_&]:bg-[color:color-mix(in_oklab,var(--panel)_calc(100%_-_var(--suit-right-panel-reveal,0)*100%),transparent)]";
