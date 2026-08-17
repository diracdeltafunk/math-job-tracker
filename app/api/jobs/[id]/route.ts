import { DEFAULT_DEADLINE_TIME_ZONE, normalizeTimeZone, parseDeadlineInput } from "@/lib/deadline";
import { asJob, currentUserId, ensureSchema, getDatabase, type JobRow } from "@/lib/tracker-db";

const allowedStatuses = new Set(["unprocessed", "consider", "will_apply", "applied", "archived"]);

async function updateJob(id: string, body: Record<string, unknown>, userId: string) {
  const db = getDatabase();
  await ensureSchema(db);
  if (body.workflowStatus && !allowedStatuses.has(String(body.workflowStatus))) return Response.json({ error: "Unknown workflow status." }, { status: 400 });
  if (body.processed !== undefined && typeof body.processed !== "boolean") return Response.json({ error: "Processed must be a boolean." }, { status: 400 });
  const normalizedBody = { ...body };
  const deadlineInput = normalizedBody.deadlineAt ?? normalizedBody.deadline;
  if (deadlineInput !== undefined) {
    const requestedTimeZone = normalizeTimeZone(normalizedBody.deadlineTimeZone, DEFAULT_DEADLINE_TIME_ZONE);
    const parsedDeadline = parseDeadlineInput(deadlineInput, requestedTimeZone);
    if (deadlineInput !== null && String(deadlineInput).trim() && !parsedDeadline) return Response.json({ error: "Deadline must be an ISO timestamp or YYYY-MM-DD with an optional time." }, { status: 400 });
    normalizedBody.deadlineAt = parsedDeadline?.epochSeconds ?? null;
    normalizedBody.deadlineTimeZone = parsedDeadline?.timeZone ?? requestedTimeZone;
    if (normalizedBody.deadlineQualifier === undefined) normalizedBody.deadlineQualifier = "";
  }
  const columnMap = { organization: "organization", title: "title", positionType: "position_type", location: "location", subjectAreas: "subject_areas", deadlineAt: "deadline_at", deadlineTimeZone: "deadline_timezone", deadlineQualifier: "deadline_qualifier", postingUrl: "posting_url", applicationSummary: "application_summary", materials: "materials", notes: "notes", applicationMethod: "application_method", workflowStatus: "workflow_status", processed: "processed" } as const;
  const updates: string[] = []; const values: Array<string | number | null> = [];
  for (const key of Object.keys(columnMap) as Array<keyof typeof columnMap>) {
    if (normalizedBody[key] !== undefined) {
      updates.push(`${columnMap[key]} = ?`);
      if (key === "processed") values.push(normalizedBody[key] ? 1 : 0);
      else if (key === "deadlineAt" && (normalizedBody[key] === null || String(normalizedBody[key] ?? "").trim() === "")) values.push(null);
      else if (key === "deadlineAt") values.push(Number(normalizedBody[key]));
      else values.push(String(normalizedBody[key] ?? ""));
    }
  }
  if (body.notesAppend !== undefined) {
    const existing = await db.prepare("SELECT notes FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<{ notes: string }>();
    const addition = String(body.notesAppend ?? "").trim();
    if (addition) {
      updates.push("notes = ?");
      values.push([existing?.notes?.trim(), addition].filter(Boolean).join("\n\n"));
    }
  }
  if (!updates.length) return Response.json({ error: "No editable fields provided." }, { status: 400 });
  updates.push("updated_at = ?"); values.push(new Date().toISOString(), id, userId);
  await db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();
  const job = await db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<JobRow>();
  return Response.json({ job: job ? asJob(job) : null });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return updateJob(id, await request.json() as Record<string, unknown>, await currentUserId());
}
