-- users is read and written by every request: never wait long for its lock
-- (docs/database.md#safe-migrations).
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('password_reset');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MailKind" ADD VALUE 'password_reset';
ALTER TYPE "MailKind" ADD VALUE 'password_changed';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "security_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "account_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "AccountTokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "security_version" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "account_tokens_user_id_purpose_idx" ON "account_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "account_tokens_expires_at_idx" ON "account_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants (schema.prisma: User.securityVersion, AccountToken). On users the
-- constraint is added without checking existing rows, then validated, which
-- does not block reads or writes meanwhile.
ALTER TABLE "users" ADD CONSTRAINT "users_security_version_check" CHECK ("security_version" >= 0) NOT VALID;
ALTER TABLE "users" VALIDATE CONSTRAINT "users_security_version_check";
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_security_version_check" CHECK ("security_version" >= 0);
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_expiry_check" CHECK ("expires_at" > "created_at");
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_used_check" CHECK ("used_at" IS NULL OR "used_at" >= "created_at");
