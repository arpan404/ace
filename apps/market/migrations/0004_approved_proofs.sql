-- A verified publisher's approved proofs (§13), kept apart from `proofs`: `approved_proofs` is
-- what the signed verified list granted the mark on (shown on the profile, re-checked weekly),
-- while `proofs` is the publisher's latest application, which maintainers' queue shows.
ALTER TABLE publishers ADD COLUMN approved_proofs TEXT NOT NULL DEFAULT '[]';
UPDATE publishers SET approved_proofs = proofs WHERE verified = 1;
