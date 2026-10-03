import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
type CloudRecord = { kind: string; id: string; data: Record<string, unknown>; updatedAt: string };

function authorized(request: Request) {
  const expected = process.env.APP_ACCESS_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(expected && supplied && supplied.length === expected.length && supplied === expected);
}

async function database() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);
  await sql`CREATE TABLE IF NOT EXISTS finance_records (
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kind, record_id)
  )`;
  return sql;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sql = await database();
  if (!sql) return Response.json({ error: "cloud_not_configured" }, { status: 503 });
  let body: { operation?: string; records?: CloudRecord[] };
  try { body = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  if (body.operation === "wipe") {
    await sql`DELETE FROM finance_records`;
    return Response.json({ ok: true });
  }
  const records = Array.isArray(body.records) ? body.records.slice(0, 10000) : [];
  for (const record of records) {
    if (!record?.kind || !record?.id || !record?.data || !record?.updatedAt) continue;
    await sql`INSERT INTO finance_records (kind, record_id, data, updated_at)
      VALUES (${record.kind}, ${record.id}, ${JSON.stringify(record.data)}::jsonb, ${record.updatedAt}::timestamptz)
      ON CONFLICT (kind, record_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
      WHERE finance_records.updated_at < EXCLUDED.updated_at`;
  }
  const result = await sql`SELECT kind, record_id, data, updated_at FROM finance_records ORDER BY kind, record_id`;
  return Response.json({ records: result.map((row) => ({ kind: row.kind, id: row.record_id, data: row.data, updatedAt: new Date(String(row.updated_at)).toISOString() })) });
}

