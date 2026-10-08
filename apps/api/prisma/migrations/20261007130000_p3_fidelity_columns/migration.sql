-- AlterTable
ALTER TABLE "asset"."asset_metadata" ADD COLUMN     "code_lines" INTEGER;

-- AlterTable
ALTER TABLE "exchange"."swap_contracts" ADD COLUMN     "target_dossier_digest" TEXT,
ADD COLUMN     "target_sha256" TEXT,
ADD COLUMN     "target_version_id" UUID;

-- AlterTable
ALTER TABLE "exchange"."swap_offers" ADD COLUMN     "claims" JSONB,
ADD COLUMN     "offered_dossier_digest" TEXT,
ADD COLUMN     "offered_sha256" TEXT,
ADD COLUMN     "offered_version_id" UUID;
