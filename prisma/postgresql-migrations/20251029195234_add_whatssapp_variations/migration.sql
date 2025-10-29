/*
  Warnings:

  - The primary key for the `WhatsappContact` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `WhatsappJidVariation` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "public"."WhatsappJidVariation" DROP CONSTRAINT "WhatsappJidVariation_contact_id_fkey";

-- DropIndex
DROP INDEX "public"."idx_jid_variation";

-- AlterTable
ALTER TABLE "WhatsappContact" DROP CONSTRAINT "WhatsappContact_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "WhatsappContact_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "WhatsappJidVariation" DROP CONSTRAINT "WhatsappJidVariation_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "contact_id" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "WhatsappJidVariation_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "WhatsappJidVariation" ADD CONSTRAINT "WhatsappJidVariation_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "WhatsappContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
