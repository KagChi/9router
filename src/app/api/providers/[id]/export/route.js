import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";

export async function GET(_req, { params }) {
  const { id: providerId } = await params;
  const connections = await getProviderConnections({ provider: providerId });

  // Strip internal fields, keep everything useful
  const exportData = connections.map(
    ({ id, createdAt, updatedAt, ...rest }) => ({
      ...rest,
      provider: providerId,
    }),
  );

  return NextResponse.json(
    { provider: providerId, count: exportData.length, connections: exportData },
    {
      headers: {
        "Content-Disposition": `attachment; filename="${providerId}-connections.json"`,
      },
    },
  );
}
