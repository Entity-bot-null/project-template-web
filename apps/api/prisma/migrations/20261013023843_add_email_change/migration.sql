-- account_tokens is written by every reset and change of email: never wait
-- long for its lock (docs/database.md#safe-migrations).
SET lock_timeout = '5s';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountTokenPurpose" ADD VALUE 'email_change';
ALTER TYPE "AccountTokenPurpose" ADD VALUE 'email_revert';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MailKind" ADD VALUE 'email_change_confirmation';
ALTER TYPE "MailKind" ADD VALUE 'email_change_existing';
ALTER TYPE "MailKind" ADD VALUE 'email_changed';

-- AlterTable
ALTER TABLE "account_tokens" ADD COLUMN     "target_email" TEXT;

-- Exactly the email tokens name a target address. Compared as text: a value
-- added to an enum above cannot be used until this migration commits.
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_target_email_check"
  CHECK (("purpose"::text IN ('email_change', 'email_revert')) = ("target_email" IS NOT NULL));
