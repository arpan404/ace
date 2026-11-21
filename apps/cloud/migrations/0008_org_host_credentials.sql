-- Organization credentials for org hosts (ADR 0206 §2.1). A machine credential is `session` (it
-- lives on the ace session it was exchanged from, ADR 0190) or `org`: issued to an org host at
-- enrollment, with no person's session behind it, so a member signing out, a lapsed session or a
-- deprovisioned person never takes the host off the relay. An `org` credential names the
-- organization's own principal (`org:<org id>`), is bound to one enrollment, renews only with
-- the host key while that enrollment is current, and goes when the host is released. A new
-- column with a constant default rewrites nothing (ADR 0170).
ALTER TABLE machine_credentials ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';
