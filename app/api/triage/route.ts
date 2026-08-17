import { env } from "cloudflare:workers";
import { DEFAULT_DEADLINE_TIME_ZONE, normalizeTimeZone, parseDeadlineInput } from "@/lib/deadline";
import { normalizeLocation } from "@/lib/location";
import { asJob, currentUserId, ensureSchema, getDatabase, type JobRow } from "@/lib/tracker-db";

const AI_MODEL = "@cf/openai/gpt-oss-120b";
const MAX_PAGE_CHARS = 100_000;
const MAX_NOTE_CHARS = 2_400;

type WorkerAI = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type TriageResult = {
  organization?: unknown; title?: unknown; positionType?: unknown; location?: unknown;
  subjectAreas?: unknown; deadlineAt?: unknown; deadlineTimeZone?: unknown; deadlineQualifier?: unknown; applicationMethod?: unknown;
  applicationSummary?: unknown; materials?: unknown; workflowStatus?: unknown; triageNote?: unknown;
};

const TRIAGE_TOOL = {
  name: "record_triage",
  description: "Record the complete, evidence-based review of one academic job posting.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      organization: { type: "string" },
      title: { type: "string" },
      positionType: { type: "string" },
      location: { type: "string" },
      subjectAreas: { type: "string" },
      deadlineAt: { type: ["string", "null"], description: "ISO 8601 timestamp with an explicit Z or numeric offset, or null when no dated deadline exists." },
      deadlineTimeZone: { type: "string", description: "IANA timezone used to display the deadline, such as America/New_York." },
      deadlineQualifier: { type: "string", description: "Short context such as full consideration; open until filled, review begins, or final deadline." },
      applicationMethod: { type: "string" },
      applicationSummary: { type: "string" },
      materials: { type: "string" },
      workflowStatus: { type: "string", enum: ["consider", "archived"] },
      triageNote: { type: "string" },
    },
    required: ["organization", "title", "positionType", "location", "subjectAreas", "deadlineAt", "deadlineTimeZone", "deadlineQualifier", "applicationMethod", "applicationSummary", "materials", "workflowStatus", "triageNote"],
  },
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const number = code.toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(number) && number > 0 ? String.fromCodePoint(number) : _;
    });
}

function stripHtml(value: string) {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function absoluteUrl(value: string, base: string) {
  try { return new URL(decodeEntities(value), base).toString(); } catch { return ""; }
}

function extractLinks(html: string, base: string) {
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => absoluteUrl(match[1], base))
    .filter((url) => /^https?:\/\//i.test(url));
}

function relevantLink(url: string, sourceHost: string) {
  try {
    const parsed = new URL(url);
    const sameSite = parsed.hostname === sourceHost || parsed.hostname.endsWith(`.${sourceHost}`);
    const target = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
    return sameSite
      ? /(apply|application|submit|login)/i.test(target)
      : /(apply|application|interfolio|workday|careers|employment|faculty|jobs|portal|forms\.gle|google\.com\/forms)/i.test(target);
  } catch { return false; }
}

async function fetchPage(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "text/html, text/plain;q=0.9", "User-Agent": "academic-job-tracker/triage" },
    });
    if (!response.ok) return { url, text: "", links: [] as string[] };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/(html|text|xml)/i.test(contentType)) return { url, text: "", links: [] as string[] };
    const html = await response.text();
    return { url, text: stripHtml(html).slice(0, MAX_PAGE_CHARS), links: extractLinks(html, url) };
  } catch {
    return { url, text: "", links: [] as string[] };
  } finally {
    clearTimeout(timer);
  }
}

function textField(value: unknown, fallback: string, max = 4_000) {
  const candidate = typeof value === "string" ? value : fallback;
  const text = stripHtml(candidate);
  return text ? text.slice(0, max) : stripHtml(fallback).slice(0, max);
}

function modelText(result: unknown) {
  if (typeof result === "string") return result;
  for (const node of responseNodes(result)) {
    if (!isRecord(node)) continue;
    for (const key of ["response", "output_text"]) {
      if (typeof node[key] === "string" && node[key].trim()) return node[key];
    }
    if (typeof node.content === "string" && node.content.trim()) return node.content;
  }
  return "";
}

function toolArguments(result: unknown) {
  for (const node of responseNodes(result)) {
    if (!Array.isArray(node)) continue;
    for (const call of node) {
      if (!isRecord(call)) continue;
      const functionCall = isRecord(call.function) ? call.function : call;
      if (functionCall.name !== "record_triage") continue;
      const args = functionCall.arguments ?? call.arguments;
      if (typeof args === "string") return args;
      if (args && typeof args === "object") return JSON.stringify(args);
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseNodes(result: unknown) {
  const nodes: unknown[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: result, depth: 0 }];
  const nestedKeys = ["result", "response", "output", "output_text", "choices", "message", "content", "tool_calls"];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    nodes.push(current.value);
    if (current.depth >= 4 || (!isRecord(current.value) && !Array.isArray(current.value))) continue;
    if (Array.isArray(current.value)) {
      for (const value of current.value) queue.push({ value, depth: current.depth + 1 });
      continue;
    }
    for (const key of nestedKeys) {
      if (current.value[key] !== undefined) queue.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
  return nodes;
}

function parseModelJson(text: string): TriageResult {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The triage model did not return structured JSON.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("The triage model returned an invalid result.");
  const requiredKeys = ["organization", "title", "positionType", "location", "subjectAreas", "deadlineAt", "deadlineTimeZone", "deadlineQualifier", "applicationMethod", "applicationSummary", "materials", "workflowStatus", "triageNote"];
  if (!requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(parsed, key))) throw new Error("The triage model returned an incomplete record_triage result.");
  return parsed as TriageResult;
}

function parseTriageResult(result: unknown) {
  const structured = toolArguments(result);
  if (structured) return parseModelJson(structured);
  const text = modelText(result);
  if (text) return parseModelJson(text);
  throw new Error("The triage model did not return a record_triage tool call.");
}

function configuredTriageProfile() {
  const profile = (env as unknown as { TRIAGE_PROFILE?: unknown }).TRIAGE_PROFILE;
  return typeof profile === "string" ? profile.trim() : "";
}

function buildPrompt(job: JobRow, pages: Array<{ url: string; text: string }>, triageProfile: string) {
  const evidence = pages.filter((page) => page.text).map((page) => `SOURCE URL: ${page.url}\n${page.text}`).join("\n\n---\n\n");
  return `You are the academic-job triage reviewer for a personal tracker. Review exactly one posting using the supplied evidence. Read the posting carefully and use the linked application or hiring pages when they are included. Extract facts first, then make a conservative fit decision. Do not guess facts that are not in the evidence; if something is uncertain, say so in triageNote.\n\nText-cleaning rules: return readable human-facing text in every field. Decode HTML entities, including numeric forms such as &#x3C; and &#233;, into their Unicode characters. Remove HTML tags and formatting artifacts such as literal <i>, <b>, and </a> fragments. Preserve meaningful accents, apostrophes, dashes, and mathematical symbols. Never copy an encoded entity or HTML tag into the saved title, organization, location, subject areas, materials, or application summary.\n\nCandidate profile and decision policy:\n${triageProfile}\n\nCurrent tracker record:\n${JSON.stringify({
    id: job.id, organization: job.organization, title: job.title, postingUrl: job.posting_url,
    description: job.description,
  })}\n\nFetched posting/application evidence:\n${evidence || "No page was fetchable; use the tracker description only and be conservative."}\n\nReturn JSON only, with exactly these keys:\n{
  "organization": "string",
  "title": "string",
  "positionType": "string",
  "location": "string",
  "subjectAreas": "string",
  "deadlineAt": "ISO 8601 timestamp with Z or a numeric UTC offset, or null",
  "deadlineTimeZone": "IANA timezone for display, normally America/New_York for ET",
  "deadlineQualifier": "short context for the selected deadline",
  "applicationMethod": "string",
  "applicationSummary": "short, practical description of how to apply",
  "materials": "complete concise list of required materials",
  "workflowStatus": "consider or archived",
  "triageNote": "short explanation of the fit decision and any unresolved uncertainty"
}\n\nDeadline rules (follow exactly):\n- Choose the most actionable dated deadline. A full-consideration date, priority date, or review-begins date is more important than a later 'until filled' date. Put that chosen instant in deadlineAt and put the context in deadlineQualifier (for example, 'full consideration; open until filled').\n- deadlineAt must be a machine-readable ISO 8601 instant with Z or a numeric offset. Never put prose, a bare date, 'open window', or a parenthetical note in deadlineAt.\n- If the posting gives a date but no time, use 23:59:00 in the source timezone when known; otherwise use 23:59:00 America/New_York (ET). If the posting gives a time but no timezone, use the same ET default. Convert the instant correctly to the ISO timestamp. For example, 11:59 PM ET on October 8, 2026 is 2026-10-09T03:59:00Z, and deadlineTimeZone should be America/New_York.\n- If there is genuinely no dated deadline (for example, only 'open until filled'), use deadlineAt null and explain that in deadlineQualifier. Do not invent a calendar date.\n- Preserve the source's meaningful distinction between full consideration, review begins, priority, and final closing dates in deadlineQualifier.\n\nLocation rules: remove postal/ZIP codes. Use 'Hamilton, NY' rather than 'Hamilton, New York 13346, United States', and 'Aarhus, Denmark' rather than 'Aarhus, 8000, Denmark'. For US locations, use the two-letter state abbreviation and omit 'United States'.\n\nFit and teaching rules: 3-3 or 3/3 means three courses in fall plus three courses in spring, not three total. Follow the candidate profile's teaching preferences; do not archive a job merely because it involves teaching. Evaluate total administrative burden: number of preparations, sections, enrollments, advising/service expectations, and signs of hundreds of students or excessive email/coordination. For R1 research jobs, prioritize research-compatible loads. For liberal-arts teaching jobs, weigh institution, student quality, location, and actual workload together.\n\nArchive jobs that are clear field mismatches, postdocs/temporary roles, senior-only roles, or positions explicitly only for people who are already tenured. Do not archive ordinary tenure-track assistant professor roles. A genuinely plausible job goes to consider; do not use will_apply or applied.`;
}

export async function POST(request: Request) {
  try {
    const db = getDatabase();
    await ensureSchema(db);
    const userId = await currentUserId();
    const body = await request.json() as { jobId?: unknown; force?: unknown };
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) return Response.json({ error: "A jobId is required." }, { status: 400 });

    const job = await db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(jobId, userId).first<JobRow>();
    if (!job) return Response.json({ error: "Posting not found." }, { status: 404 });
    const force = body.force === true;
    if (job.processed && !force) return Response.json({ job: asJob(job), skipped: true });

    const triageProfile = configuredTriageProfile();
    if (!triageProfile) {
      return Response.json({ error: "Triage is disabled until the TRIAGE_PROFILE deployment secret is configured." }, { status: 503 });
    }

    const ai = (env as unknown as { AI?: WorkerAI }).AI;
    if (!ai?.run) return Response.json({ error: "The triage model is not configured yet." }, { status: 503 });

    const sourcePage = await fetchPage(job.posting_url);
    const sourceHost = (() => { try { return new URL(job.posting_url).hostname; } catch { return ""; } })();
    const linkedUrls = [...new Set(sourcePage.links.filter((url) => relevantLink(url, sourceHost)))]
      .filter((url) => url !== job.posting_url)
      .slice(0, 2);
    const linkedPages = await Promise.all(linkedUrls.map(fetchPage));
    const result = await ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: "You are a careful academic hiring-posting reviewer. Always call record_triage exactly once with the complete structured review." },
        { role: "user", content: buildPrompt(job, [sourcePage, ...linkedPages], triageProfile).replace("Return JSON only, with exactly these keys:", "Call the record_triage tool exactly once. Put the complete review in its arguments; do not answer with prose or a plain JSON message. The tool arguments must contain exactly these keys:") },
      ],
      tools: [TRIAGE_TOOL],
      tool_choice: "required",
      max_tokens: 2_400,
      temperature: 0.1,
    });
    const triage = parseTriageResult(result);
    const modelWorkflowStatus = triage.workflowStatus === "consider" ? "consider" : "archived";
    const workflowStatus = force && (job.workflow_status === "will_apply" || job.workflow_status === "applied")
      ? job.workflow_status
      : modelWorkflowStatus;
    const deadlineTimeZone = normalizeTimeZone(triage.deadlineTimeZone, DEFAULT_DEADLINE_TIME_ZONE);
    const parsedDeadline = triage.deadlineAt === null || triage.deadlineAt === undefined
      ? null
      : parseDeadlineInput(triage.deadlineAt, deadlineTimeZone);
    if (triage.deadlineAt !== null && triage.deadlineAt !== undefined && !parsedDeadline) {
      throw new Error("The triage model returned an invalid deadlineAt timestamp.");
    }
    const deadlineAt = parsedDeadline?.epochSeconds ?? null;
    const deadlineQualifier = textField(triage.deadlineQualifier, "", 500);
    const sourceUrls = [job.posting_url, ...linkedPages.filter((page) => page.text).map((page) => page.url)];
    const triageNote = textField(triage.triageNote, "No additional fit note returned.", MAX_NOTE_CHARS);
    const notesAddition = `AI triage ${new Date().toISOString().slice(0, 10)}: ${triageNote}\nSources: ${sourceUrls.join(", ")}`;
    const notes = [job.notes?.trim(), notesAddition].filter(Boolean).join("\n\n").slice(0, 8_000);
    const now = new Date().toISOString();

    await db.prepare(`UPDATE jobs SET organization = ?, title = ?, position_type = ?, location = ?, subject_areas = ?, deadline = NULL, deadline_at = ?, deadline_timezone = ?, deadline_qualifier = ?, workflow_status = ?, processed = 1, application_method = ?, application_summary = ?, materials = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(
        textField(triage.organization, job.organization, 500), textField(triage.title, job.title, 500),
        textField(triage.positionType, job.position_type, 300), normalizeLocation(textField(triage.location, job.location, 500)) || normalizeLocation(job.location),
        textField(triage.subjectAreas, job.subject_areas, 600), deadlineAt, deadlineTimeZone, deadlineQualifier, workflowStatus,
        textField(triage.applicationMethod, job.application_method, 500),
        textField(triage.applicationSummary, job.application_summary, 2_000),
        textField(triage.materials, job.materials, 2_000), notes, now, job.id, userId,
      ).run();

    const updated = await db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(job.id, userId).first<JobRow>();
    return Response.json({ job: updated ? asJob(updated) : null, model: AI_MODEL, skipped: false });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Triage failed." }, { status: 500 });
  }
}
