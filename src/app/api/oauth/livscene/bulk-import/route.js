import { NextResponse } from "next/server";
import {
  getLivsceneBulkImportManager,
  parseBulkAccounts,
} from "@/lib/oauth/services/livsceneBulkImportManager";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const { parsed, invalidLines } = parseBulkAccounts(accounts);

    if (!parsed.length) {
      return NextResponse.json(
        { error: "At least one account entry is required" },
        { status: 400 },
      );
    }

    if (invalidLines.length > 0) {
      return NextResponse.json(
        {
          error:
            "Invalid account format. Use one account per line: email@gmail.com:password or email@gmail.com|password",
          invalidLines,
        },
        { status: 400 },
      );
    }

    let proxyPoolIds = null;
    let proxyUrl = null;
    if (Array.isArray(body?.proxyPoolIds) && body.proxyPoolIds.length > 0) {
      proxyPoolIds = body.proxyPoolIds.filter(Boolean);
    } else if (body?.proxyPoolId) {
      proxyPoolIds = [body.proxyPoolId];
    } else if (body?.proxyUrl) {
      proxyUrl = String(body.proxyUrl).trim() || null;
    }

    const manager = getLivsceneBulkImportManager();
    const job = await manager.startJob({
      accounts,
      concurrency: body?.concurrency,
      engine: body?.engine,
      proxyUrl,
      proxyPoolIds,
      aff: body?.aff,
    });

    return NextResponse.json({ success: true, job });
  } catch (error) {
    const status = Array.isArray(error?.invalidLines) ? 400 : 500;
    return NextResponse.json(
      {
        error:
          error?.error ||
          error?.message ||
          "Failed to start Livscene bulk import",
        ...(Array.isArray(error?.invalidLines)
          ? { invalidLines: error.invalidLines }
          : {}),
      },
      { status },
    );
  }
}
