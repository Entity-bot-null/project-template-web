-- Attempts made before the last manual retry (`mail retry --failed`): the
-- limit and the backoff count from there, so a retry no longer lowers
-- "attempts", which fences each claim. A worker that paused past its lease
-- can then never match a later claim of the same row.
-- AlterTable
ALTER TABLE "mail_messages" ADD COLUMN "attempts_base" INTEGER NOT NULL DEFAULT 0;
