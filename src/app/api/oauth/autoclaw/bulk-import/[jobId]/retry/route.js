import { NextResponse } from "next/server";
import { getAutoClawBulkImportManager } from "@/lib/oauth/services/autoclawBulkImportManager";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { jobId } = await params;
  let workerId;
  try {
    const body = await request.json();
    workerId = body.workerId;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  if (!workerId) {
    return NextResponse.json({ ok: false, error: "workerId required" }, { status: 400 });
  }
  const manager = getAutoClawBulkImportManager();
  const result = await manager.retryWorker(jobId, workerId);
  return NextResponse.json(result);
}
