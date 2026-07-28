import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

export async function POST(req, { params }) {
  const { id: providerId } = await params;
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Accept: { connections: [...] } or raw array
  const connections = Array.isArray(body) ? body : body.connections;
  if (!Array.isArray(connections)) {
    return NextResponse.json(
      { error: "Expected { connections: [...] } or an array" },
      { status: 400 },
    );
  }

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const conn of connections) {
    try {
      // Strip id/createdAt/updatedAt — let createProviderConnection generate them
      const { id, createdAt, updatedAt, ...rest } = conn;
      const data = { ...rest, provider: providerId };
      await createProviderConnection(data);
      imported++;
    } catch (e) {
      skipped++;
      errors.push({
        email: conn.email || conn.name,
        error: e.message || String(e),
      });
    }
  }

  return NextResponse.json({ imported, skipped, errors });
}
