import { NextResponse } from "next/server";
import { getCombos, getModelAliases } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/public/combos — public, no auth
export async function GET() {
  try {
    const [combos, aliases] = await Promise.all([
      getCombos(),
      getModelAliases().catch(() => ({})),
    ]);
    return NextResponse.json({ combos, aliases });
  } catch {
    return NextResponse.json({ combos: [], aliases: {} });
  }
}
