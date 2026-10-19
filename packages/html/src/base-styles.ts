/**
 * The style kit every visualization page starts with, so an agent's page reads as part of ace
 * rather than an embedded document: plain elements (headings, buttons, inputs, sliders, tables,
 * details) take the app's type, hairlines, corners and accent, and a few component classes cover
 * what pages keep rebuilding (cards, stats, badges, callouts, tabs, grids).
 *
 * It sits in the `ace` cascade layer, so any style the page writes itself wins without needing
 * more specificity. It sets no SVG paint, so a chart's own `fill`/`stroke` attributes stand.
 * Every value reads a theme variable (`themeProperties`) with a fallback, so an exported page
 * still looks right outside the app. The visualize skill documents the classes.
 */
export const baseStyles = `@layer ace{
:root{
--ace-ink:var(--foreground,#1d1d1f);--ace-ink-2:var(--muted-foreground,#6e6e73);--ace-ink-3:var(--subtle-foreground,var(--muted-foreground,#8e8e93));
--ace-line:var(--border,rgb(127 127 127/.22));--ace-edge:var(--input,var(--border,rgb(127 127 127/.32)));
--ace-surface:var(--card,rgb(127 127 127/.06));--ace-raised:var(--surface-2,var(--card,rgb(127 127 127/.1)));
--ace-wash:var(--hover,rgb(127 127 127/.1));--ace-field:var(--field,transparent);
--ace-accent:var(--accent,#0a84ff);--ace-on-accent:var(--accent-foreground,#fff);--ace-accent-text:var(--accent-text,var(--accent,#0a84ff));
--ace-r:var(--radius,8px);--ace-r-sm:6px;--ace-r-lg:12px;
--ace-focus:0 0 0 2px var(--background,transparent),0 0 0 4px color-mix(in srgb,var(--ace-accent) 55%,transparent);
--ace-ease:cubic-bezier(.2,.7,.2,1);
}
html{font:14px/1.55 var(--font-sans,system-ui);color:var(--ace-ink);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;accent-color:var(--ace-accent)}
body{padding:2px 0}
body>*:first-child{margin-top:0}body>*:last-child{margin-bottom:0}
@media (prefers-reduced-motion:no-preference){body{animation:ace-in .32s var(--ace-ease) both}}
@keyframes ace-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
::selection{background:color-mix(in srgb,var(--ace-accent) 28%,transparent)}
h1,h2,h3,h4{margin:1.4em 0 .5em;line-height:1.25;font-weight:600;letter-spacing:-.011em;text-wrap:balance}
h1{font-size:1.5rem;letter-spacing:-.02em}h2{font-size:1.2rem;letter-spacing:-.016em}h3{font-size:1rem}h4{font-size:.875rem;color:var(--ace-ink-2)}
p,ul,ol,dl,blockquote,figure,table,pre{margin:0 0 .85em}
p{text-wrap:pretty}
ul,ol{padding-left:1.35em}li{margin:.2em 0}li::marker{color:var(--ace-ink-3)}
a{color:var(--ace-accent-text);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px}
strong,b{font-weight:600}small{font-size:.8125rem;color:var(--ace-ink-2)}
hr{border:0;border-top:1px solid var(--ace-line);margin:1.25em 0}
blockquote{padding-left:12px;border-left:2px solid var(--ace-edge);color:var(--ace-ink-2)}
code,kbd,samp,pre{font-family:var(--font-mono,ui-monospace,monospace);font-size:.86em}
:not(pre)>code{padding:.1em .38em;border-radius:4px;background:var(--ace-wash)}
pre{padding:12px 14px;border-radius:var(--ace-r-lg);background:var(--ace-surface);border:1px solid var(--ace-line);overflow:auto;line-height:1.5}
kbd{display:inline-block;min-width:1.6em;padding:.05em .4em;border:1px solid var(--ace-edge);border-bottom-width:2px;border-radius:4px;text-align:center;font-size:.78em;color:var(--ace-ink-2)}
img,video,canvas{max-width:100%}img{height:auto}svg{max-width:100%}
figure{margin-inline:0}figcaption{margin-top:6px;font-size:.8125rem;color:var(--ace-ink-2)}
:focus-visible{outline:none;box-shadow:var(--ace-focus)}

button,.button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--ace-edge);border-radius:var(--ace-r);background:var(--ace-surface);color:var(--ace-ink);font:500 .8125rem/1 var(--font-sans,system-ui);cursor:pointer;white-space:nowrap;user-select:none;transition:background-color .15s,border-color .15s,color .15s,transform .1s,box-shadow .15s}
button:hover,.button:hover{background:var(--ace-wash)}
button:active,.button:active{transform:scale(.98)}
button:disabled,button[aria-disabled=true]{opacity:.45;cursor:default;transform:none}
button.primary,.button.primary{background:var(--ace-accent);border-color:transparent;color:var(--ace-on-accent)}
button.primary:hover,.button.primary:hover{background:color-mix(in srgb,var(--ace-accent) 88%,var(--ace-ink))}
button.ghost,.button.ghost{background:transparent;border-color:transparent;color:var(--ace-ink-2)}
button.ghost:hover{background:var(--ace-wash);color:var(--ace-ink)}
button.danger{color:var(--destructive,#d70015)}
button.small{height:24px;padding:0 8px;font-size:.75rem;border-radius:var(--ace-r-sm)}
button.icon{width:30px;padding:0}
input:not([type]),input[type=text],input[type=number],input[type=search],input[type=email],input[type=url],input[type=date],input[type=time],select,textarea{appearance:none;height:30px;padding:0 10px;border:1px solid var(--ace-edge);border-radius:var(--ace-r);background:var(--ace-field);color:var(--ace-ink);font:inherit;font-size:.8125rem;transition:border-color .15s,box-shadow .15s;max-width:100%}
textarea{height:auto;min-height:72px;padding:8px 10px;line-height:1.5;resize:vertical}
select{padding-right:28px;background-image:linear-gradient(45deg,transparent 50%,var(--ace-ink-3) 50%),linear-gradient(135deg,var(--ace-ink-3) 50%,transparent 50%);background-position:calc(100% - 15px) 50%,calc(100% - 11px) 50%;background-size:4px 4px;background-repeat:no-repeat}
input:focus-visible,select:focus-visible,textarea:focus-visible{border-color:var(--ace-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ace-accent) 22%,transparent)}
::placeholder{color:var(--ace-ink-3)}
input[type=checkbox],input[type=radio]{width:15px;height:15px;margin:0;vertical-align:-2px}
input[type=range]{appearance:none;width:100%;height:20px;margin:0;background:transparent;cursor:pointer;--ace-fill:50%}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--ace-line)}
input[type=range]::-webkit-slider-thumb{appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--background,#fff);border:1.5px solid var(--ace-accent);box-shadow:0 1px 2px rgb(0 0 0/.18);transition:transform .12s}
input[type=range]:active::-webkit-slider-thumb{transform:scale(1.15)}
input[type=range]::-moz-range-track{height:4px;border-radius:999px;background:var(--ace-line)}
input[type=range]::-moz-range-progress{height:4px;border-radius:999px;background:var(--ace-accent)}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--background,#fff);border:1.5px solid var(--ace-accent)}
input[type=range]:focus-visible{box-shadow:none}
input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:var(--ace-focus)}
label{font-size:.8125rem;color:var(--ace-ink-2)}
label:has(input[type=checkbox],input[type=radio]){display:inline-flex;align-items:center;gap:8px;color:var(--ace-ink);cursor:pointer}
fieldset{margin:0 0 .85em;padding:0;border:0}legend{padding:0;margin-bottom:6px;font-weight:600;font-size:.8125rem}
progress,meter{appearance:none;width:100%;height:6px;border:0;border-radius:999px;background:var(--ace-line);overflow:hidden;vertical-align:middle}
progress::-webkit-progress-bar{background:var(--ace-line)}progress::-webkit-progress-value{background:var(--ace-accent);border-radius:999px;transition:width .3s var(--ace-ease)}progress::-moz-progress-bar{background:var(--ace-accent)}
meter::-webkit-meter-bar{background:var(--ace-line);border:0}meter::-webkit-meter-optimum-value{background:var(--success,#34c759)}meter::-webkit-meter-suboptimum-value{background:var(--warning,#ff9f0a)}meter::-webkit-meter-even-less-good-value{background:var(--destructive,#ff3b30)}
table{width:100%;border-collapse:collapse;font-size:.8125rem;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--ace-line);vertical-align:top}
th{font-weight:500;color:var(--ace-ink-2);font-size:.75rem;white-space:nowrap}
thead th{border-bottom-color:var(--ace-edge)}
tbody tr{transition:background-color .12s}tbody tr:hover{background:var(--ace-wash)}
tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
caption{caption-side:bottom;padding-top:8px;font-size:.75rem;color:var(--ace-ink-3);text-align:left}
details{border:1px solid var(--ace-line);border-radius:var(--ace-r-lg);margin:0 0 .85em;overflow:hidden}
details>summary{list-style:none;display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;font-weight:500;user-select:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--ace-ink-3);border-bottom:1.5px solid var(--ace-ink-3);transform:rotate(-45deg);transition:transform .18s var(--ace-ease);flex:none}
details[open]>summary::before{transform:rotate(45deg)}
details>summary:hover{background:var(--ace-wash)}
details>:not(summary){margin:0;padding:0 12px 12px}

.card{padding:14px 16px;border:1px solid var(--ace-line);border-radius:var(--ace-r-lg);background:var(--ace-surface)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.card.raised{background:var(--ace-raised);box-shadow:0 1px 2px rgb(0 0 0/.06),0 4px 16px -6px rgb(0 0 0/.12)}
.card.plain{background:transparent}
.stack{display:flex;flex-direction:column;gap:12px}.stack.tight{gap:6px}.stack.loose{gap:20px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.row.between{justify-content:space-between}.row.end{justify-content:flex-end}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--min,180px)),1fr))}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}
.stat{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--ace-line);border-radius:var(--ace-r-lg);background:var(--ace-surface);min-width:0}
.stat .label{font-size:.75rem;color:var(--ace-ink-2)}
.stat .value{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;line-height:1.2;font-variant-numeric:tabular-nums}
.stat .delta{font-size:.75rem;color:var(--ace-ink-2)}
.up{color:var(--success,#248a3d)}.down{color:var(--destructive,#d70015)}
.badge,.pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:var(--ace-wash);color:var(--ace-ink-2);font-size:.6875rem;font-weight:500;line-height:1;white-space:nowrap;vertical-align:middle}
.badge::before{content:none}
.badge.dot::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.success,.callout.success{--tone:var(--success,#248a3d)}.badge.warning,.callout.warning{--tone:var(--warning,#c93400)}.badge.danger,.callout.danger{--tone:var(--destructive,#d70015)}.badge.info,.callout.info{--tone:var(--info,var(--ace-accent))}.badge.accent{--tone:var(--ace-accent)}
.badge:is(.success,.warning,.danger,.info,.accent){color:var(--tone);background:color-mix(in srgb,var(--tone) 14%,transparent)}
.callout{--tone:var(--info,var(--ace-accent));display:flex;gap:10px;padding:10px 14px;border-radius:var(--ace-r-lg);background:color-mix(in srgb,var(--tone) 9%,transparent);border:1px solid color-mix(in srgb,var(--tone) 24%,transparent);margin:0 0 .85em}
.callout>:last-child{margin-bottom:0}
.callout strong:first-child{color:var(--tone)}
.tabs,[role=tablist]{display:inline-flex;gap:2px;padding:2px;border-radius:var(--ace-r);background:var(--ace-wash);margin:0 0 12px;max-width:100%;overflow-x:auto}
:is(.tabs,[role=tablist])>button{height:26px;padding:0 10px;border:0;border-radius:var(--ace-r-sm);background:transparent;color:var(--ace-ink-2);font-weight:500}
:is(.tabs,[role=tablist])>button:hover{background:transparent;color:var(--ace-ink)}
:is(.tabs,[role=tablist])>button:is([aria-selected=true],[aria-pressed=true],.active){background:var(--background,#fff);color:var(--ace-ink);box-shadow:0 1px 2px rgb(0 0 0/.1),0 0 0 .5px var(--ace-line)}
.muted{color:var(--ace-ink-2)}.subtle{color:var(--ace-ink-3)}.mono{font-family:var(--font-mono,ui-monospace,monospace)}.num{font-variant-numeric:tabular-nums}
.eyebrow{font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ace-ink-3)}
.lead{font-size:1rem;color:var(--ace-ink-2)}
.divider{height:1px;background:var(--ace-line);margin:12px 0;border:0}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--c,currentColor);vertical-align:baseline}
.bar{height:6px;border-radius:999px;background:var(--ace-line);overflow:hidden}.bar>span{display:block;height:100%;width:var(--value,0%);background:var(--c,var(--ace-accent));border-radius:inherit;transition:width .4s var(--ace-ease)}
.fade-in{animation:ace-in .3s var(--ace-ease) both}
.chart{color:var(--ace-ink-2);font-size:11px}
.chart .grid-line,.chart .axis{stroke:var(--ace-line)}
}`;
