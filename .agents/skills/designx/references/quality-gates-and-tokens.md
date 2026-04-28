# Quality and Tokens

## Self-Audit

Score 1-10 before delivery:

- product fit
- hierarchy
- layout originality
- information architecture
- interaction depth
- state completeness
- accessibility
- responsiveness
- implementation quality
- aesthetic consistency

Revise if product fit, hierarchy, accessibility, responsiveness, or states are below 8.

## QA

Check:

- tokens exist
- coherent type/spacing scale
- semantic colors
- intentional aesthetic
- fitting layout archetype
- no card spam
- clear primary action
- loading/empty/error/populated states
- partial/offline/forbidden when relevant
- hover/focus/active states
- keyboard behavior
- 375, 768, 1280, 1440+ where relevant
- no horizontal overflow
- contrast and labels
- reduced motion
- organized components
- realistic sample data
- no lorem ipsum
- no console errors

## Token Template

Use CSS variables or platform equivalent:

```css
:root {
  --font-display: system-ui, sans-serif;
  --font-body: system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  --text-xs: 11px;
  --text-sm: 13px;
  --text-base: 15px;
  --text-md: 17px;
  --text-lg: 20px;
  --text-xl: 24px;
  --text-2xl: 30px;
  --text-3xl: 38px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;

  --radius-sm: 3px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-full: 9999px;

  --duration-fast: 100ms;
  --duration-normal: 200ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  --color-bg: #ffffff;
  --color-surface: #f8fafc;
  --color-text: #0f172a;
  --color-muted: #475569;
  --color-border: #cbd5e1;
  --color-accent: #f97316;
  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-error: #dc2626;
  --color-info: #2563eb;
}
```
