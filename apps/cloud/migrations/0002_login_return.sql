-- Where a sign-in's browser goes when it ends (ADR 0100): the apps' ace:// link or the web
-- app's landing page, checked against the allowlist when the sign-in starts. NULL keeps the
-- backend's own "You're signed in" page. It only ever receives a status, never a credential.
ALTER TABLE logins ADD COLUMN return_to TEXT;
