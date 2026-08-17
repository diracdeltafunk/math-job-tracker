import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { deadlineIso, DEFAULT_DEADLINE_TIME_ZONE } from "@/lib/deadline";

export const WORKFLOW = ["unprocessed", "consider", "will_apply", "applied", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW)[number];

export type JobRow = {
  id: string; user_id: string; source: string; source_id: string; organization: string; title: string;
  position_type: string; location: string; country: string; state: string; subject_areas: string;
  posted_date: string | null; deadline: string | null; deadline_at: number | null; deadline_timezone: string; deadline_qualifier: string;
  workflow_status: WorkflowStatus; processed: number; posting_url: string; application_method: string;
  application_summary: string; materials: string; description: string; notes: string; tags: string;
  is_manual: number; synced_at: string | null; created_at: string; updated_at: string;
};

export function getDatabase() {
  if (!env.DB) throw new Error("The tracker database is not available yet.");
  return env.DB;
}

export async function currentUserId() {
  const requestHeaders = await headers();
  return requestHeaders.get("oai-authenticated-user-id") ?? "local-preview-user";
}

let schemaReady: Promise<void> | undefined;

async function initializeSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
      organization TEXT NOT NULL, title TEXT NOT NULL, position_type TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
      subject_areas TEXT NOT NULL DEFAULT '', posted_date TEXT, deadline TEXT, deadline_at INTEGER,
      deadline_timezone TEXT NOT NULL DEFAULT 'America/New_York', deadline_qualifier TEXT NOT NULL DEFAULT '',
      workflow_status TEXT NOT NULL DEFAULT 'consider', processed INTEGER NOT NULL DEFAULT 0,
      posting_url TEXT NOT NULL, application_method TEXT NOT NULL DEFAULT 'Review posting',
      application_summary TEXT NOT NULL DEFAULT '', materials TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
      is_manual INTEGER NOT NULL DEFAULT 0, synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, source TEXT NOT NULL,
      found INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, checked_at TEXT NOT NULL
    )`),
  ]);

  const columns = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  let changed = false;
  const addColumn = async (name: string, sql: string) => {
    if (names.has(name)) return;
    await db.prepare(sql).run();
    changed = true;
  };

  await addColumn("processed", "ALTER TABLE jobs ADD COLUMN processed INTEGER NOT NULL DEFAULT 0");
  await addColumn("deadline_at", "ALTER TABLE jobs ADD COLUMN deadline_at INTEGER");
  await addColumn("deadline_timezone", "ALTER TABLE jobs ADD COLUMN deadline_timezone TEXT NOT NULL DEFAULT 'America/New_York'");
  await addColumn("deadline_qualifier", "ALTER TABLE jobs ADD COLUMN deadline_qualifier TEXT NOT NULL DEFAULT ''");
  if (names.has("application_url")) {
    await db.prepare("ALTER TABLE jobs DROP COLUMN application_url").run();
    changed = true;
  }

  await db.batch([
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_source ON jobs(user_id, source, source_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_jobs_user_workflow ON jobs(user_id, workflow_status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_jobs_user_processed ON jobs(user_id, processed)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_jobs_user_deadline_at ON jobs(user_id, deadline_at)"),
    db.prepare("DROP INDEX IF EXISTS idx_jobs_user_deadline"),
  ]);
  if (changed) await db.prepare("PRAGMA optimize").run();
}

export function ensureSchema(db: D1Database) {
  schemaReady ??= initializeSchema(db).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export function asJob(row: JobRow) {
  const deadlineAt = deadlineIso(row.deadline_at);
  return {
    id: row.id, userId: row.user_id, source: row.source, sourceId: row.source_id,
    organization: row.organization, title: row.title, positionType: row.position_type,
    location: row.location, country: row.country, state: row.state, subjectAreas: row.subject_areas,
    postedDate: row.posted_date, deadline: deadlineAt ?? row.deadline, deadlineAt,
    deadlineTimeZone: row.deadline_timezone || DEFAULT_DEADLINE_TIME_ZONE,
    deadlineQualifier: row.deadline_qualifier || "", workflowStatus: row.workflow_status,
    processed: Boolean(row.processed), postingUrl: row.posting_url,
    applicationMethod: row.application_method, applicationSummary: row.application_summary,
    materials: row.materials, description: row.description, notes: row.notes, tags: row.tags,
    isManual: Boolean(row.is_manual), syncedAt: row.synced_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
