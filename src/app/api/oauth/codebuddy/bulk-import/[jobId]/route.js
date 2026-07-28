import { NextResponse } from "next/server";
import {
  getCodeBuddyIntlBulkImportManager,
  buildLookupResponse,
} from "@/lib/oauth/services/codebuddyIntlBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyIntlBulkImportManager();
  const job = await manager.getJobWithPreview(jobId);

  if (!job) {
    return NextResponse.json({
      success: true,
      ...buildLookupResponse(null, { stale: true }),
    });
  }

  return NextResponse.json({
    success: true,
    ...buildLookupResponse(job),
  });
}
