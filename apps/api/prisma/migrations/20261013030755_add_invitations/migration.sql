-- The foreign key below takes a short lock on users, which every request
-- reads and writes: never wait long for it (docs/database.md#safe-migrations).
SET lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "MailKind" ADD VALUE 'invitation';

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "invited_by_id" UUID,
    "token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_email_key" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_created_at_idx" ON "invitations"("created_at");

-- CreateIndex
CREATE INDEX "invitations_invited_by_id_idx" ON "invitations"("invited_by_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the code guarantees, kept by the database too: a token is a SHA-256 in
-- hex, and sent invitations have an expiry and unsent ones none.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_hash_check"
  CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_expiry_check"
  CHECK (("token_hash" IS NULL) = ("expires_at" IS NULL));
