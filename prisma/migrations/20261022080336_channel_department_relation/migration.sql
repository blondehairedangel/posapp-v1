-- AddForeignKey
ALTER TABLE "communication_channels" ADD CONSTRAINT "communication_channels_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
