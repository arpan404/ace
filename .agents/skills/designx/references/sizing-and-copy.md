# Sizing and Copy

## Sizing

Default to restrained, device-aware sizing. Oversized type, giant cards, and large whitespace need a product reason.

Use:

- `rem`, `%`, `fr`, `minmax()`, `clamp()`
- content-based max widths
- container queries where useful
- stable dimensions for boards, grids, controls, tiles, and toolbars

Typography:

- dense app body: 13-15px
- standard app body: 14-16px
- mobile body: 15-17px
- marketing/editorial body: 16-19px
- app headings: restrained
- hero type: only for marketing/brand pages

Controls:

- desktop compact row: 32-36px
- desktop standard row: 40-44px
- touch target: 44pt/48dp minimum
- icon-only buttons need stable square dimensions

Responsive behavior:

- desktop: persistent nav, split panes, dense tables
- tablet: collapse secondary panels, keep key actions visible
- phone: bottom/stack nav, single-column flows, no hover-only controls
- no horizontal overflow
- layout changes behavior, not only width

Check 375, 430, 768, 1024, 1280, 1440+ widths when relevant.

## Copy

Use plain product language. Every visible word must help users understand, decide, or act.

Avoid:

- filler subtitles
- slogans inside tools
- dramatic labels
- fake SaaS jargon
- implementation terms for normal users
- helper text that repeats the label

Prefer:

- Dashboard
- Projects
- Reports
- Tasks
- Schedule
- Team
- Files
- Settings
- Activity
- Search
- Filter
- Export
- Save
- Cancel
- Create
- Edit
- Delete

Avoid unless domain requires:

- Command Center
- Operations Nexus
- Mission Control
- Intelligence Suite
- Control Matrix
- Orchestration Center

Buttons:

- verb-first
- short and concrete
- examples: Save, Create project, Export CSV, Invite member, Approve invoice
- avoid: Proceed, Utilize, Execute, Initiate, Leverage

Headings:

- describe content, not design concept
- good: Recent activity, Budget status, Open issues
- bad: Operational Command Feed, Financial Intelligence Layer

Empty states:

- one plain headline
- one useful sentence
- one primary action

Product tone:

- consumer: warm, simple
- enterprise/admin: precise, neutral
- construction/field: practical, direct
- finance: exact, conservative
- developer tool: technical only when domain-correct
- marketing: persuasive but not bloated

Review visible copy before delivery:

- necessary?
- clear to target user?
- familiar nav labels?
- action-oriented buttons?
- no inflated or technical wording?
