import { NextResponse } from "next/server";
import {
  getLivsceneBulkImportManager,
  buildLookupResponse,
} from "@/lib/oauth/services/livsceneBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const manager = getLivsceneBulkImportManager();
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
