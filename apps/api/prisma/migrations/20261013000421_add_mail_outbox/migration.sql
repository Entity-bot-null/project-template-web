-- CreateEnum
CREATE TYPE "MailKind" AS ENUM ('test');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'expired');

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" UUID NOT NULL,
    "kind" "MailKind" NOT NULL,
    "status" "MailStatus" NOT NULL DEFAULT 'pending',
    "recipient" TEXT,
    "recipient_hash" TEXT NOT NULL,
    "user_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_dedupe_key_key" ON "mail_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "mail_messages_status_next_attempt_at_idx" ON "mail_messages"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "mail_messages_recipient_hash_created_at_idx" ON "mail_messages"("recipient_hash", "created_at");

-- CreateIndex
CREATE INDEX "mail_messages_created_at_idx" ON "mail_messages"("created_at");

-- CreateIndex
CREATE INDEX "mail_messages_user_id_idx" ON "mail_messages"("user_id");

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The outbox's invariants, enforced for every writer (schema.prisma, MailMessage).
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_recipient_hash_check" CHECK ("recipient_hash" ~ '^[0-9a-f]{64}$');
-- A claimed message always has a lease, so a crashed worker's claim ends.
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_sending_lease_check" CHECK ("status" <> 'sending' OR "locked_until" IS NOT NULL);
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_sent_at_check" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));
-- The address is kept only while it may be needed: a message still to send
-- has it, a sent or dropped one never does (a failed one keeps it for a retry
-- until the retention sweep clears it).
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_recipient_check" CHECK (
    ("status" IN ('pending', 'sending') AND "recipient" IS NOT NULL)
    OR ("status" IN ('sent', 'expired') AND "recipient" IS NULL)
    OR "status" = 'failed'
);
