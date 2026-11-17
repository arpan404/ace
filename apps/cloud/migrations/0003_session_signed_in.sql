-- When each session signed in (ADR 0173 §2): a market grant carries it as `authAt`, and actions
-- that need a recent sign-in check it. Sessions from before this column count as signed in long
-- ago, so they sign in again for those actions. Adding a column with a constant default rewrites
-- nothing.
ALTER TABLE sessions ADD COLUMN signed_in INTEGER NOT NULL DEFAULT 0;
