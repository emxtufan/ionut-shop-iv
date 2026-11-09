-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "invoiceProvider" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "proformaSerie" TEXT,
ADD COLUMN     "proformaNumar" TEXT,
ADD COLUMN     "proformaPdfUrl" TEXT,
ADD COLUMN     "proformaCanceledAt" TIMESTAMP(3);

-- Facturile emise până acum au trecut prin FGO
UPDATE "Invoice" SET "invoiceProvider" = 'FGO' WHERE "fgoStatus" IS NOT NULL;
