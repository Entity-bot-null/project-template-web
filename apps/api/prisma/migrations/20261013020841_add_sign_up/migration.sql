-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MailKind" ADD VALUE 'sign_up_confirmation';
ALTER TYPE "MailKind" ADD VALUE 'sign_up_existing';

-- CreateTable
CREATE TABLE "sign_ups" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_ups_email_key" ON "sign_ups"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sign_ups_token_hash_key" ON "sign_ups"("token_hash");

-- CreateIndex
CREATE INDEX "sign_ups_created_at_idx" ON "sign_ups"("created_at");

-- What the code guarantees, kept by the database too: a token is a SHA-256 in
-- hex, sent links have an expiry and unsent ones none, attempts count up.
ALTER TABLE "sign_ups" ADD CONSTRAINT "sign_ups_token_hash_check"
  CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "sign_ups" ADD CONSTRAINT "sign_ups_token_expiry_check"
  CHECK (("token_hash" IS NULL) = ("expires_at" IS NULL));
ALTER TABLE "sign_ups" ADD CONSTRAINT "sign_ups_failed_attempts_check"
  CHECK ("failed_attempts" >= 0);
