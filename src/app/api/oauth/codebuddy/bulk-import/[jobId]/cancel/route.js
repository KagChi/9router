import { NextResponse } from "next/server";
import { getCodeBuddyIntlBulkImportManager } from "@/lib/oauth/services/codebuddyIntlBulkImportManager";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { jobId } = await params;
  const manager = getCodeBuddyIntlBulkImportManager();
  const job = manager.cancelJob(jobId);
  return NextResponse.json({ success: true, job });
}
