-- Every enqueue writes mail_messages, inside the sign-up, recovery, change of
-- email and invitation transactions: never wait long for its lock
-- (docs/database.md#safe-migrations).
SET lock_timeout = '5s';

-- A new id for each claim (mail.store.ts): with the attempt number, it fences
-- what a worker may record, even after a manual retry starts the attempts
-- again. The previous release leaves it as it is and fences by the attempt
-- number alone, as it did.
-- AlterTable
ALTER TABLE "mail_messages" ADD COLUMN "claim_id" UUID;
