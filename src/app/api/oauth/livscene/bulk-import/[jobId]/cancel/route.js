import { NextResponse } from "next/server";
import { getLivsceneBulkImportManager } from "@/lib/oauth/services/livsceneBulkImportManager";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { jobId } = await params;
  const manager = getLivsceneBulkImportManager();
  const job = manager.cancelJob(jobId);
  return NextResponse.json({ success: true, job });
}
