-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "VideoStatus" ADD VALUE 'FAILED';

-- DropForeignKey
ALTER TABLE "WatchProgress" DROP CONSTRAINT "WatchProgress_userId_fkey";

-- DropForeignKey
ALTER TABLE "WatchProgress" DROP CONSTRAINT "WatchProgress_videoId_fkey";

-- AlterTable
ALTER TABLE "Video" DROP COLUMN "videoFile",
ADD COLUMN     "bunnyVideoId" TEXT;

-- DropTable
DROP TABLE "WatchProgress";

-- CreateIndex
CREATE UNIQUE INDEX "Video_bunnyVideoId_key" ON "Video"("bunnyVideoId");

