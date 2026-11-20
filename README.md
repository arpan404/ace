# Spade: easy connect (ace/spade-easy-connect)

Hand run on a throwaway dev home: dev daemon and web, a hand-run debug Spade with
`SPADE_DEV_CATALOGUE` pointing Linear at a local fake OAuth + MCP app, and a scripted fake model
that calls `app_connect_request`. The sign-in loop is real (dynamic registration, PKCE, the
callback); the fake app's "Allow" page was approved by hand. Markdown in one reply shows raw:
this dev home's renderer, unrelated to this work. "On your own network" in Settings shows only
because the dev catalogue marks the fake app local.

Before (main):
- before-1-settings-apps.jpg: Settings › Apps said "Signed out", no account, no last use.
- before-2-reconnect-was-a-text-question.jpg: an older app shows a connect card as a text question.
- before-3-bot-apps.jpg: a bot's Apps had no suggestions.
- before-4-new-bot-no-suggestions.jpg: a template's new bot suggested no apps.

After:
- after-1-request-card.jpg: Boards asks for Linear: the app, its reason, what it may do, Connect Linear.
- after-2-signing-in.jpg: the sign-in in progress in one line (the browser blocked the tab, so it is a link), with Cancel.
- after-3-connected-continues.jpg: settled to "Connected as ada@example.com"; the bot carries on with Linear's tools.
- after-4-reconnect-card.jpg: the sign-in was revoked: the call waits on Reconnect Linear, and the composer offers no Stop.
- after-5-reconnected-retried.jpg: "Reconnected as …", and the held call ran again by itself.
- after-6-coming-soon.jpg: Figma (waiting on its maker): "Not available yet", and the bot carries on.
- after-7-bot-suggested-apps.jpg: a bot's Apps suggest apps for its task; Linear, connected already, leads with Use.
- after-8-used-in-another-bot.jpg: Use gave Linear to Triage with no second sign-in.
- after-9-settings-apps.jpg: Settings › Apps: Working, the account, the bots that use it, when one last did.
- after-10-settings-needs-reconnect.jpg: Needs reconnect, with Reconnect.
- after-11-new-bot-suggestions.jpg: a template's new bot suggests apps for its task.
