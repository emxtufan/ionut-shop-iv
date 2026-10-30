-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "billing" JSONB;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "buyerType" TEXT,
ADD COLUMN     "buyerCui" TEXT,
ADD COLUMN     "buyerRegCom" TEXT,
ADD COLUMN     "buyerCountry" TEXT,
ADD COLUMN     "buyerCounty" TEXT,
ADD COLUMN     "buyerCity" TEXT,
ADD COLUMN     "buyerAddress" TEXT,
ADD COLUMN     "buyerPhone" TEXT,
ADD COLUMN     "fgoStatus" TEXT,
ADD COLUMN     "fgoSerie" TEXT,
ADD COLUMN     "fgoNumar" TEXT,
ADD COLUMN     "fgoPdfUrl" TEXT,
ADD COLUMN     "fgoError" TEXT,
ADD COLUMN     "fgoWarning" TEXT,
ADD COLUMN     "fgoAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fgoNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "fgoPaidAt" TIMESTAMP(3),
ADD COLUMN     "fgoSpvAt" TIMESTAMP(3),
ADD COLUMN     "invoiceEmailedAt" TIMESTAMP(3),
ADD COLUMN     "fgoStornoWanted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fgoStornoSerie" TEXT,
ADD COLUMN     "fgoStornoNumar" TEXT,
ADD COLUMN     "fgoStornoPdfUrl" TEXT,
ADD COLUMN     "fgoStornoDoneAt" TIMESTAMP(3),
ADD COLUMN     "stornoEmailedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_fgoSerie_fgoNumar_key" ON "Invoice"("fgoSerie", "fgoNumar");

-- CreateIndex
CREATE INDEX "Invoice_fgoStatus_fgoNextAttemptAt_idx" ON "Invoice"("fgoStatus", "fgoNextAttemptAt");
