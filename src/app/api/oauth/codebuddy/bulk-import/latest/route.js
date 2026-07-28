import { NextResponse } from "next/server";
import {
  getCodeBuddyIntlBulkImportManager,
  buildLookupResponse,
} from "@/lib/oauth/services/codebuddyIntlBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const manager = getCodeBuddyIntlBulkImportManager();
  const searchParams = new URL(request.url).searchParams;
  const scope = searchParams.get("scope");
  const includeRecentTerminal =
    scope === "recent" || scope === "recoverable" || scope === "all";
  const job = await manager.getLatestJobWithPreview({ includeRecentTerminal });

  if (!job) {
    return NextResponse.json({
      success: true,
      ...buildLookupResponse(null),
    });
  }

  return NextResponse.json({
    success: true,
    ...buildLookupResponse(job),
  });
}
