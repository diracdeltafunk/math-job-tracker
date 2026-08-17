import { DEFAULT_DEADLINE_TIME_ZONE, normalizeTimeZone, parseDeadlineInput } from "@/lib/deadline";
import { asJob, currentUserId, ensureSchema, getDatabase, type JobRow, WORKFLOW, type WorkflowStatus } from "@/lib/tracker-db";

const RSS_URL = "https://www.mathjobs.org/jobs?joblist-0-0----rss--";
const MATHJOBS = "https://www.mathjobs.org";

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const number = code.toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(number) && number > 0 ? String.fromCodePoint(number) : _;
    });
}

function stripHtml(value: string) {
  return decodeEntities(value).replace(/<br\s*\/?>(\s*)/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function readTag(source: string, names: string[]) {
  for (const name of names) {
    const match = source.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function absoluteUrl(value: string) {
  if (!value) return "";
  try { return new URL(decodeEntities(value), MATHJOBS).toString(); } catch { return value; }
}

function sourceIdFrom(value: string) {
  const match = value.match(/(?:list\/|jobs\/[^/]+\/)(\d+)/i) ?? value.match(/(\d{4,})/);
  return match?.[1] ?? value;
}

function parseRss(xml: string) {
  const blocks = [...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].map((match) => match[1]);
  return blocks.map((block) => {
    const rawTitle = stripHtml(readTag(block, ["title"]));
    const rawLink = readTag(block, ["link", "guid"]) || readTag(block, ["id"]);
    const postingUrl = absoluteUrl(rawLink);
    const description = stripHtml(readTag(block, ["description", "content:encoded", "summary"]));
    const organization = stripHtml(readTag(block, ["organization", "employer", "author", "dc:creator"]));
    const title = rawTitle.replace(/^\[[^\]]+\]\s*/, "");
    const sourceId = sourceIdFrom(readTag(block, ["guid", "id"]) || postingUrl || rawTitle);
    const published = readTag(block, ["pubDate", "published", "dc:date"]);
    const titleParts = rawTitle.match(/^(.*?):\s*(?:\[[^\]]+\]\s*)?(.+)$/);
    let publishedDate: string | null = null;
    if (published && !Number.isNaN(Date.parse(published))) publishedDate = new Date(published).toISOString().slice(0, 10);
    return {
      sourceId, organization: organization || titleParts?.[1] || "MathJobs employer", title: titleParts?.[2] || title || "MathJobs posting",
      postingUrl: postingUrl || `${MATHJOBS}/jobs/list/${sourceId}`, published: publishedDate, description,
    };
  }).filter((job) => job.sourceId && job.postingUrl);
}

async function syncMathJobs(db: D1Database, userId: string) {
  const response = await fetch(RSS_URL, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`MathJobs feed returned ${response.status}.`);
  const jobs = parseRss(await response.text());
  if (!jobs.length) throw new Error("MathJobs returned no readable postings.");
  const now = new Date().toISOString();
  const existingRows = await db.prepare("SELECT source_id FROM jobs WHERE user_id = ? AND source = 'mathjobs'")
    .bind(userId).all<{ source_id: string }>();
  const existingIds = new Set(existingRows.results.map((row) => row.source_id));
  const added = jobs.filter((job) => !existingIds.has(job.sourceId)).length;
  const statements: D1PreparedStatement[] = [];

  // Eleven bound values per row keeps each statement below D1's 100-parameter
  // limit while avoiding the former two-query-per-posting sync loop.
  for (let start = 0; start < jobs.length; start += 8) {
    const chunk = jobs.slice(start, start + 8);
    const values = chunk.map(() => "(?, ?, 'mathjobs', ?, ?, ?, '', '', '', '', '', ?, NULL, NULL, 'America/New_York', '', 'unprocessed', 0, ?, 'Review posting', '', '', ?, '', '', 0, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((job) => [
      `mathjobs-${job.sourceId}`, userId, job.sourceId, job.organization, job.title,
      job.published, job.postingUrl, job.description, now, now, now,
    ]);
    statements.push(db.prepare(`INSERT INTO jobs (
      id, user_id, source, source_id, organization, title, position_type, location, country, state,
      subject_areas, posted_date, deadline, deadline_at, deadline_timezone, deadline_qualifier,
      workflow_status, processed, posting_url, application_method, application_summary, materials,
      description, notes, tags, is_manual, synced_at, created_at, updated_at
    ) VALUES ${values}
    ON CONFLICT(user_id, source, source_id) DO UPDATE SET
      organization = CASE WHEN jobs.processed = 0 THEN excluded.organization ELSE jobs.organization END,
      title = CASE WHEN jobs.processed = 0 THEN excluded.title ELSE jobs.title END,
      posting_url = excluded.posting_url,
      description = excluded.description,
      posted_date = excluded.posted_date,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`).bind(...bindings));
  }
  statements.push(db.prepare("INSERT INTO sync_runs (user_id, source, found, added, checked_at) VALUES (?, 'mathjobs', ?, ?, ?)").bind(userId, jobs.length, added, now));
  await db.batch(statements);
  return { found: jobs.length, added, checkedAt: now };
}

export async function GET(request: Request) {
  try {
    const db = getDatabase();
    const userId = await currentUserId();
    await ensureSchema(db);
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const workflow = url.searchParams.get("workflow") ?? ""; const source = url.searchParams.get("source") ?? "";
    const location = url.searchParams.get("location")?.trim().toLowerCase() ?? ""; const type = url.searchParams.get("type")?.trim().toLowerCase() ?? "";
    const conditions = ["user_id = ?"]; const params: (string | number)[] = [userId];
    if (workflow && WORKFLOW.includes(workflow as WorkflowStatus)) { conditions.push("workflow_status = ?"); params.push(workflow); }
    if (source) { conditions.push("source = ?"); params.push(source); }
    if (q) { conditions.push("(lower(organization) LIKE ? OR lower(title) LIKE ? OR lower(subject_areas) LIKE ? OR lower(description) LIKE ?)"); const query = `%${q}%`; params.push(query, query, query, query); }
    if (location) { conditions.push("lower(location) LIKE ?"); params.push(`%${location}%`); }
    if (type) { conditions.push("lower(position_type) LIKE ?"); params.push(`%${type}%`); }
    const processed = url.searchParams.get("processed");
    if (processed === "true" || processed === "false") { conditions.push("processed = ?"); params.push(processed === "true" ? 1 : 0); }
    const rows = await db.prepare(`SELECT * FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END, deadline_at ASC, posted_date DESC, organization ASC`).bind(...params).all<JobRow>();
    const lastSync = await db.prepare("SELECT checked_at, found, added FROM sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first<{ checked_at: string; found: number; added: number }>();
    return Response.json({ jobs: rows.results.map(asJob), lastSync: lastSync ? { checkedAt: lastSync.checked_at, found: lastSync.found, added: lastSync.added } : null, rssUrl: RSS_URL });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to load jobs." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const db = getDatabase(); const userId = await currentUserId(); await ensureSchema(db);
    const body = await request.json() as Record<string, string>;
    if (body.action === "sync") return Response.json({ sync: await syncMathJobs(db, userId) });
    const now = new Date().toISOString(); const id = `manual-${crypto.randomUUID()}`;
    const fields = {
      organization: body.organization?.trim() || "Unspecified employer", title: body.title?.trim() || "Untitled posting",
      positionType: body.positionType?.trim() || "", location: body.location?.trim() || "", subjectAreas: body.subjectAreas?.trim() || "",
      deadlineInput: body.deadlineAt?.trim() || body.deadline?.trim() || "", deadlineTimeZone: normalizeTimeZone(body.deadlineTimeZone, DEFAULT_DEADLINE_TIME_ZONE), deadlineQualifier: body.deadlineQualifier?.trim() || "", postingUrl: body.postingUrl?.trim() || "",
      applicationMethod: body.applicationMethod?.trim() || "Review posting", applicationSummary: body.applicationSummary?.trim() || "",
      materials: body.materials?.trim() || "", notes: body.notes?.trim() || "",
    };
    if (!fields.postingUrl) return Response.json({ error: "A posting link is required." }, { status: 400 });
    const parsedDeadline = parseDeadlineInput(fields.deadlineInput, fields.deadlineTimeZone);
    if (fields.deadlineInput && !parsedDeadline) return Response.json({ error: "Deadline must be an ISO timestamp or YYYY-MM-DD with an optional time." }, { status: 400 });
    await db.prepare(`INSERT INTO jobs (id, user_id, source, source_id, organization, title, position_type, location, country, state, subject_areas, posted_date, deadline, deadline_at, deadline_timezone, deadline_qualifier, workflow_status, processed, posting_url, application_method, application_summary, materials, description, notes, tags, is_manual, synced_at, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, '', '', ?, NULL, NULL, ?, ?, ?, 'unprocessed', 0, ?, ?, ?, ?, '', ?, '', 1, NULL, ?, ?)`)
      .bind(id, userId, id, fields.organization, fields.title, fields.positionType, fields.location, fields.subjectAreas, parsedDeadline?.epochSeconds ?? null, parsedDeadline?.timeZone ?? fields.deadlineTimeZone, fields.deadlineQualifier, fields.postingUrl, fields.applicationMethod, fields.applicationSummary, fields.materials, fields.notes, now, now).run();
    const created = await db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<JobRow>();
    return Response.json({ job: created ? asJob(created) : null }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to add posting." }, { status: 500 }); }
}
