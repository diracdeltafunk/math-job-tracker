"use client";

import { ChangeEvent, FormEvent, createContext, useContext, useEffect, useMemo, useState } from "react";

type Workflow = "unprocessed" | "consider" | "will_apply" | "applied" | "archived";
type QueueWorkflow = Exclude<Workflow, "unprocessed" | "archived">;
type Job = {
  id: string; source: string; sourceId: string; organization: string; title: string; positionType: string;
  location: string; subjectAreas: string; postedDate: string | null; deadline: string | null; deadlineAt: string | null; deadlineTimeZone: string; deadlineQualifier: string;
  workflowStatus: Workflow; processed: boolean; postingUrl: string; applicationMethod: string;
  applicationSummary: string; materials: string; description: string; notes: string; tags: string; isManual: boolean;
};

const MATHJOBS_LIST_URL = "https://www.mathjobs.org/jobs/list";

const workflowLabels: Record<Workflow, string> = { unprocessed: "Unprocessed", consider: "To consider", will_apply: "Will apply", applied: "Applied", archived: "Archived" };

function formatDate(value: string | null) {
  if (!value) return "No deadline listed";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function deadlineDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(value: string | null) {
  const date = deadlineDate(value);
  return date ? Math.ceil((date.getTime() - Date.now()) / 86400000) : null;
}

function formatDeadline(value: string | null, timeZone: string, qualifier: string, legacyValue: string | null) {
  if (!value) return legacyValue || "No deadline listed";
  const date = deadlineDate(value);
  if (!date) return legacyValue || "No deadline listed";
  let parts: Intl.DateTimeFormatPart[] = [];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(date);
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  const zoneLabel = timeZone === "America/New_York" ? "ET" : timeZone === "America/Chicago" ? "CT" : timeZone === "America/Denver" ? "MT" : timeZone === "America/Los_Angeles" ? "PT" : timeZone === "UTC" ? "UTC" : timeZone;
  const text = `${part("month")} ${part("day")}, ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${zoneLabel}`;
  return qualifier ? `${text} · ${qualifier}` : text;
}

function formatShortDeadline(value: string | null, timeZone: string) {
  const date = deadlineDate(value);
  if (!date) return "No deadline";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "America/New_York", month: "short", day: "numeric" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(date);
  }
}

function compareDeadlines(a: Job, b: Job) {
  const aTime = a.deadlineAt ? Date.parse(a.deadlineAt) : Number.POSITIVE_INFINITY;
  const bTime = b.deadlineAt ? Date.parse(b.deadlineAt) : Number.POSITIVE_INFINITY;
  return (Number.isNaN(aTime) ? Number.POSITIVE_INFINITY : aTime) - (Number.isNaN(bTime) ? Number.POSITIVE_INFINITY : bTime)
    || a.organization.localeCompare(b.organization)
    || a.title.localeCompare(b.title);
}

type JobDraft = {
  organization: string; title: string; positionType: string; location: string; subjectAreas: string;
  deadlineAt: string; deadlineTimeZone: string; deadlineQualifier: string; postingUrl: string; applicationMethod: string;
  applicationSummary: string; materials: string; notes: string;
};

type TriageRun = { running: boolean; completed: number; total: number; current: string; failures: number; lastError: string };
type TriageActions = {
  onTriage: (job: Job) => void; onRetriage: (job: Job) => void; triagingId: string | null;
  collapsedCards: Record<string, boolean>; onToggleCollapse: (id: string) => void;
};
const TriageContext = createContext<TriageActions | null>(null);

function draftFromJob(job: Job): JobDraft {
  return { organization: job.organization, title: job.title, positionType: job.positionType, location: job.location, subjectAreas: job.subjectAreas, deadlineAt: job.deadlineAt ?? "", deadlineTimeZone: job.deadlineTimeZone || "America/New_York", deadlineQualifier: job.deadlineQualifier || "", postingUrl: job.postingUrl, applicationMethod: job.applicationMethod, applicationSummary: job.applicationSummary, materials: job.materials, notes: job.notes };
}

function EditForm({ draft, onChange, onSave, onCancel }: { draft: JobDraft; onChange: (key: keyof JobDraft, value: string) => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const field = (key: keyof JobDraft) => ({ value: draft[key], onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(key, event.target.value) });
  return <form className="edit-panel" onSubmit={onSave}><div className="edit-grid">
    <label>Employer<input required {...field("organization")} /></label><label>Title<input required {...field("title")} /></label>
    <label>Position type<input {...field("positionType")} /></label><label>Location<input {...field("location")} /></label>
    <label>Subject areas<input {...field("subjectAreas")} /></label><label>Deadline timestamp<input placeholder="2026-10-16T03:59:00Z" {...field("deadlineAt")} /></label>
    <label>Deadline timezone<input placeholder="America/New_York" {...field("deadlineTimeZone")} /></label><label>Deadline context<input placeholder="Full consideration; open until filled" {...field("deadlineQualifier")} /></label>
    <label className="wide">Posting link<input type="url" required {...field("postingUrl")} /></label>
    <label>How to apply<input {...field("applicationMethod")} /></label>
    <label className="wide">Application brief<textarea {...field("applicationSummary")} /></label>
    <label className="wide">Materials<textarea {...field("materials")} /></label>
    <label className="wide">Your notes<textarea {...field("notes")} /></label>
  </div><div className="edit-actions"><button type="button" className="button button-light" onClick={onCancel}>Cancel</button><button type="submit" className="button button-primary">Save changes</button></div></form>;
}

type JobCardProps = {
  job: Job; onMove: (id: string, status: Workflow) => void; onToggleProcessed: (job: Job) => void;
  onStartEdit: (job: Job) => void; editing: boolean; editDraft: JobDraft | null;
  onEditChange: (key: keyof JobDraft, value: string) => void; onSaveEdit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelEdit: () => void;
};

function ArchiveButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="text-button archive-button" aria-label="Archive posting" title="Archive posting" onClick={onClick}><span className="archive-icon" aria-hidden="true"></span></button>;
}

function JobCard({ job, onMove, onToggleProcessed, onStartEdit, editing, editDraft, onEditChange, onSaveEdit, onCancelEdit }: JobCardProps) {
  const days = daysUntil(job.deadlineAt);
  const triageActions = useContext(TriageContext);
  const triaging = triageActions?.triagingId === job.id;
  const collapsed = triageActions?.collapsedCards[job.id] ?? false;
  const deadline = <span className={days !== null && days <= 14 ? "deadline urgent" : "deadline"}>{formatDeadline(job.deadlineAt, job.deadlineTimeZone, job.deadlineQualifier, job.deadline)}</span>;
  if (collapsed) return <article className="job-card is-collapsed"><button type="button" className="job-card-collapsed" aria-label={`Expand ${job.organization}`} aria-expanded="false" onClick={() => triageActions?.onToggleCollapse(job.id)}><span className="collapsed-organization" title={job.organization}>{job.organization}</span><span className="collapsed-separator" aria-hidden="true">—</span><span className="collapsed-deadline">{formatShortDeadline(job.deadlineAt, job.deadlineTimeZone)}</span><span className="collapse-mark" aria-hidden="true">⌄</span></button></article>;
  return <article className="job-card">
    <div className="job-card-topline"><span className={`source-pill ${job.source}`}>{job.source === "mathjobs" ? "MathJobs" : "Manual"}</span>{deadline}<span className={`processing-pill ${job.processed ? "processed" : ""}`}>{job.processed ? "Processed" : "Unprocessed"}</span><button type="button" className="icon-button card-toggle" aria-label={`Collapse ${job.organization}`} title="Collapse posting" aria-expanded="true" onClick={() => triageActions?.onToggleCollapse(job.id)}>⌃</button></div>
    <h3>{job.title}</h3><p className="organization">{job.organization}</p>
    <div className="job-meta"><span>{job.location || "Location not listed"}</span><span>{job.positionType || "Position type not listed"}</span></div>
    <p className="subject-areas">{job.subjectAreas || "Subject areas not listed"}</p>
    {editing && editDraft ? <EditForm draft={editDraft} onChange={onEditChange} onSave={onSaveEdit} onCancel={onCancelEdit} /> : <details className="application-details"><summary>Application brief</summary><div className="details-body">
      <div><strong>How to apply</strong><span>{job.applicationMethod}</span></div>
      <div><strong>Materials</strong><span>{job.materials || "Review the posting for the required dossier."}</span></div>
      {job.applicationSummary && <div><strong>What to know</strong><span>{job.applicationSummary}</span></div>}
      {job.notes && <div><strong>Your notes</strong><span>{job.notes}</span></div>}
    </div></details>}
    <div className="job-actions"><a className="button button-light" href={job.postingUrl} target="_blank" rel="noreferrer">View posting ↗</a><button className="button button-light" onClick={() => onStartEdit(job)}>{editing ? "Editing" : "Edit"}</button><button className="text-button" onClick={() => onToggleProcessed(job)}>{job.processed ? "Mark unprocessed" : "Mark processed"}</button>{job.workflowStatus === "unprocessed" && <><button className="button button-primary" onClick={() => onMove(job.id, "consider")}>To consider</button><ArchiveButton onClick={() => onMove(job.id, "archived")} /></>}{job.workflowStatus === "consider" && <button className="button button-primary" onClick={() => onMove(job.id, "will_apply")}>Will apply</button>}{job.workflowStatus === "will_apply" && <><button className="button button-primary" onClick={() => onMove(job.id, "applied")}>Mark applied</button><button className="text-button" onClick={() => onMove(job.id, "consider")}>Remove from Will apply</button></>}{job.workflowStatus === "applied" && <button className="button button-light" onClick={() => onMove(job.id, "will_apply")}>Undo applied</button>}{job.workflowStatus !== "archived" && job.workflowStatus !== "unprocessed" && <ArchiveButton onClick={() => onMove(job.id, "archived")} />}{job.workflowStatus === "archived" && <button className="text-button" onClick={() => onMove(job.id, "consider")}>Restore</button>}</div>
    <div className="job-actions triage-actions">{!job.processed ? <button className="button button-primary" onClick={() => triageActions?.onTriage(job)} disabled={triaging}>{triaging ? "Triaging…" : "Triage"}</button> : <button className="text-button" onClick={() => triageActions?.onRetriage(job)} disabled={triaging}>{triaging ? "Re-triaging…" : "Re-triage"}</button>}</div>
  </article>;
}

function EmptyState({ label, onReset }: { label: string; onReset?: () => void }) {
  return <div className="empty-state"><span className="empty-mark">—</span><h3>Nothing here yet</h3><p>{label}</p>{onReset && <button className="button button-light" onClick={onReset}>Clear filters</button>}</div>;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]); const [view, setView] = useState<"dashboard" | "all" | "add">("dashboard");
  const [query, setQuery] = useState(""); const [workflowFilter, setWorkflowFilter] = useState<"all" | Workflow>("all"); const [sourceFilter, setSourceFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState(""); const [typeFilter, setTypeFilter] = useState(""); const [processedFilter, setProcessedFilter] = useState<"all" | "processed" | "unprocessed">("all"); const [sort, setSort] = useState("deadline");
  const [syncing, setSyncing] = useState(false); const [notice, setNotice] = useState(""); const [lastSync, setLastSync] = useState<string | null>(null);
  const [triageRun, setTriageRun] = useState<TriageRun>({ running: false, completed: 0, total: 0, current: "", failures: 0, lastError: "" });
  const [triagingId, setTriagingId] = useState<string | null>(null);
  const emptyForm = { organization: "", title: "", positionType: "", location: "", subjectAreas: "", deadlineAt: "", deadlineTimeZone: "America/New_York", deadlineQualifier: "", postingUrl: "", applicationMethod: "", applicationSummary: "", materials: "", notes: "" };
  const [form, setForm] = useState(emptyForm);
  const [collapsedLists, setCollapsedLists] = useState<Record<QueueWorkflow, boolean>>({ consider: false, will_apply: false, applied: false });
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null); const [editDraft, setEditDraft] = useState<JobDraft | null>(null);

  async function refreshJobs() {
    try {
      const response = await fetch("/api/jobs"); const data = await response.json() as { jobs?: Job[]; lastSync?: { checkedAt: string } | null; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to load jobs."); setJobs(data.jobs || []); setLastSync(data.lastSync?.checkedAt || null); setNotice(data.jobs?.length ? "" : "No postings yet. Sync MathJobs or add one manually.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to load postings."); }
  }

  useEffect(() => { const timer = window.setTimeout(() => { void refreshJobs(); }, 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const setForViewport = (isMobile: boolean) => setCollapsedLists(isMobile ? { consider: false, will_apply: true, applied: true } : { consider: false, will_apply: false, applied: false });
    setForViewport(media.matches);
    const handleChange = (event: MediaQueryListEvent) => setForViewport(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  type JobUpdate = Partial<Job>;
  async function updateJob(id: string, changes: JobUpdate) {
    setJobs((current) => current.map((job) => job.id === id ? { ...job, ...changes } : job));
    const response = await fetch(`/api/jobs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
    if (!response.ok) { setNotice("That change could not be saved. Please try again."); void refreshJobs(); return false; }
    return true;
  }

  async function moveJob(id: string, status: Workflow) {
    const job = jobs.find((candidate) => candidate.id === id);
    const changes: JobUpdate = { workflowStatus: status };
    if (job?.workflowStatus === "unprocessed" && status !== "unprocessed") changes.processed = true;
    await updateJob(id, changes);
  }
  async function toggleProcessed(job: Job) { await updateJob(job.id, { processed: !job.processed }); }
  function startEdit(job: Job) { setEditingId(job.id); setEditDraft(draftFromJob(job)); }
  function cancelEdit() { setEditingId(null); setEditDraft(null); }
  function editChange(key: keyof JobDraft, value: string) { setEditDraft((current) => current ? { ...current, [key]: value } : current); }
  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingId || !editDraft) return;
    if (await updateJob(editingId, editDraft)) cancelEdit();
  }

  async function syncMathJobs() {
    setSyncing(true); setNotice("Checking the MathJobs RSS feed for new postings...");
    try {
      const response = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync" }) }); const data = await response.json() as { sync?: { found: number; added: number; checkedAt: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "Sync failed."); const summary = `Checked ${data.sync?.found ?? 0} MathJobs postings and added ${data.sync?.added ?? 0} new unprocessed postings.`; setLastSync(data.sync?.checkedAt || null); await refreshJobs(); setNotice(summary);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Sync failed."); } finally { setSyncing(false); }
  }

  async function triageJob(job: Job, force = false) {
    if (syncing || triageRun.running || triagingId) return;
    if (force && !window.confirm(`Re-triage “${job.title}”? This will refresh its details. Existing Will apply/Applied status will be preserved.`)) return;
    setTriagingId(job.id); setNotice(`${force ? "Re-triaging" : "Triaging"} ${job.title}...`);
    try {
      const response = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, force }) });
      const data = await response.json() as { job?: Job; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error || "Triage failed.");
      setJobs((current) => current.map((candidate) => candidate.id === data.job!.id ? data.job! : candidate));
      setNotice(`${force ? "Re-triaged" : "Triaged"} ${job.title}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Triage failed.");
    } finally {
      setTriagingId(null);
    }
  }

  function retriageJob(job: Job) { void triageJob(job, true); }

  async function triageUnprocessed() {
    if (syncing || triageRun.running || triagingId) return;
    setNotice("Loading untriaged postings...");
    try {
      const queueResponse = await fetch("/api/jobs?processed=false");
      const queueData = await queueResponse.json() as { jobs?: Job[]; error?: string };
      if (!queueResponse.ok) throw new Error(queueData.error || "Unable to load the triage queue.");
      const queue = queueData.jobs || [];
      if (!queue.length) { setTriageRun({ running: false, completed: 0, total: 0, current: "", failures: 0, lastError: "" }); setNotice("Nothing is waiting for triage."); return; }
      setTriageRun({ running: true, completed: 0, total: queue.length, current: queue[0].title, failures: 0, lastError: "" });
      let failures = 0;
      let lastError = "";
      for (let index = 0; index < queue.length; index += 1) {
        const job = queue[index];
        setTriageRun({ running: true, completed: index, total: queue.length, current: job.title, failures, lastError });
        try {
          const response = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
          const data = await response.json() as { job?: Job; error?: string };
          if (!response.ok || !data.job) throw new Error(data.error || "Triage failed.");
          setJobs((current) => current.map((candidate) => candidate.id === data.job!.id ? data.job! : candidate));
        } catch (error) {
          failures += 1;
          lastError = error instanceof Error ? error.message : "Triage failed.";
        }
        setTriageRun({ running: true, completed: index + 1, total: queue.length, current: index + 1 < queue.length ? queue[index + 1].title : "", failures, lastError });
      }
      await refreshJobs();
      setTriageRun({ running: false, completed: queue.length, total: queue.length, current: "", failures, lastError });
      setNotice(failures ? `Triaged ${queue.length - failures} postings; ${failures} failed and remain unprocessed. ${lastError}` : `Triaged all ${queue.length} postings.`);
    } catch (error) {
      setTriageRun({ running: false, completed: 0, total: 0, current: "", failures: 0, lastError: "" });
      setNotice(error instanceof Error ? error.message : "Triage failed.");
    }
  }

  async function addPosting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice("Saving posting..."); const response = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); const data = await response.json() as { job?: Job; error?: string };
    if (!response.ok || !data.job) { setNotice(data.error || "Unable to save posting."); return; }
    setJobs((current) => [data.job!, ...current]); setForm(emptyForm); setNotice("Added as unprocessed."); setWorkflowFilter("unprocessed"); setView("all");
  }

  const counts = useMemo(() => ({ unprocessed: jobs.filter((job) => !job.processed).length, consider: jobs.filter((job) => job.workflowStatus === "consider").length, will_apply: jobs.filter((job) => job.workflowStatus === "will_apply").length, applied: jobs.filter((job) => job.workflowStatus === "applied").length, archived: jobs.filter((job) => job.workflowStatus === "archived").length }), [jobs]);
  const filteredJobs = useMemo(() => {
    const normalized = query.toLowerCase().trim(); const filtered = jobs.filter((job) => { const haystack = [job.organization, job.title, job.location, job.subjectAreas, job.description, job.tags].join(" ").toLowerCase(); return (!normalized || haystack.includes(normalized)) && (workflowFilter === "all" || job.workflowStatus === workflowFilter) && (processedFilter === "all" || (processedFilter === "processed" ? job.processed : !job.processed)) && (sourceFilter === "all" || job.source === sourceFilter) && (!locationFilter || job.location.toLowerCase().includes(locationFilter.toLowerCase())) && (!typeFilter || job.positionType.toLowerCase().includes(typeFilter.toLowerCase())); });
    return filtered.sort((a, b) => sort === "organization" ? a.organization.localeCompare(b.organization) : sort === "posted" ? (b.postedDate || "").localeCompare(a.postedDate || "") : (a.deadlineAt || "9999").localeCompare(b.deadlineAt || "9999"));
  }, [jobs, query, workflowFilter, processedFilter, sourceFilter, locationFilter, typeFilter, sort]);
  const resetFilters = () => { setQuery(""); setWorkflowFilter("all"); setProcessedFilter("all"); setSourceFilter("all"); setLocationFilter(""); setTypeFilter(""); };
  const toggleList = (status: QueueWorkflow) => setCollapsedLists((current) => ({ ...current, [status]: !current[status] }));
  const toggleCard = (id: string) => setCollapsedCards((current) => ({ ...current, [id]: !current[id] }));
  const toggleAllCards = (status: QueueWorkflow) => {
    const sectionJobs = jobs.filter((job) => job.workflowStatus === status);
    const collapse = sectionJobs.some((job) => !collapsedCards[job.id]);
    setCollapsedCards((current) => ({ ...current, ...Object.fromEntries(sectionJobs.map((job) => [job.id, collapse])) }));
  };
  const allCardsCollapsed = (status: QueueWorkflow) => {
    const sectionJobs = jobs.filter((job) => job.workflowStatus === status);
    return sectionJobs.length > 0 && sectionJobs.every((job) => collapsedCards[job.id]);
  };
  const showFiltered = (next: { workflow?: Workflow; processed?: "processed" | "unprocessed" }) => {
    resetFilters();
    setWorkflowFilter(next.workflow ?? "all");
    setProcessedFilter(next.processed ?? "all");
    setView("all");
  };

  return <TriageContext.Provider value={{ onTriage: (job) => { void triageJob(job); }, onRetriage: retriageJob, triagingId, collapsedCards, onToggleCollapse: toggleCard }}><main className="app-shell">
    <header className="topbar"><div className="brand"><strong>Job tracker</strong></div><nav className="main-nav" aria-label="Primary navigation"><button className={view === "dashboard" ? "nav-link active" : "nav-link"} onClick={() => setView("dashboard")}>Workspace</button><button className={view === "all" ? "nav-link active" : "nav-link"} onClick={() => setView("all")}>All postings <span className="nav-count">{jobs.length}</span></button><button className={view === "add" ? "nav-link active" : "nav-link"} onClick={() => setView("add")}>Add posting <span className="plus">+</span></button></nav></header>
    <section className="sync-strip" aria-label="MathJobs sync and triage status"><div className="sync-status"><span className="status-dot"></span><div><strong>{lastSync ? `Last checked ${formatDate(lastSync.slice(0, 10))}` : "MathJobs feed not checked yet"}</strong>{notice && <span>{notice}</span>}</div></div><div className="sync-actions"><button className="button button-light" onClick={triageUnprocessed} disabled={syncing || triageRun.running}>{triageRun.running ? `Triaging ${triageRun.completed}/${triageRun.total}` : "Triage unprocessed"}</button><button className="button button-primary" onClick={syncMathJobs} disabled={syncing || triageRun.running}>{syncing ? "Checking..." : "Sync MathJobs"}</button></div>{triageRun.total > 0 && <div className="triage-progress" aria-live="polite"><div className="triage-progress-label"><strong>{triageRun.running ? `Triage progress: ${triageRun.completed} of ${triageRun.total}` : `Triage finished: ${triageRun.completed} of ${triageRun.total}`}</strong><span>{triageRun.current || (triageRun.lastError || (triageRun.failures ? `${triageRun.failures} failed` : "All saved"))}</span></div><progress max={triageRun.total} value={triageRun.completed}></progress></div>}</section>
    {view === "dashboard" && <><section className="stat-strip" aria-label="Application tracker totals"><div><span>To consider</span><strong>{counts.consider}</strong></div><div><span>Will apply</span><strong>{counts.will_apply}</strong></div><div><span>Applied</span><strong>{counts.applied}</strong></div><div><button type="button" className="stat-link" onClick={() => showFiltered({ processed: "unprocessed" })}><span>Unprocessed</span><strong>{counts.unprocessed}</strong></button></div><div><span>All records</span><strong>{jobs.length}</strong><button type="button" className="stat-sub-link" onClick={() => showFiltered({ workflow: "archived" })}><small>{counts.archived} archived</small></button></div></section><section className="workspace-heading"><h2>Queues</h2><div className="workspace-tools"><input aria-label="Search active lists" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search employer, field, or title" /><button className="button button-light" onClick={() => setView("all")}>Advanced search</button></div></section><section className="list-grid">{(["consider", "will_apply", "applied"] as QueueWorkflow[]).map((status) => { const sectionJobs = jobs.filter((job) => job.workflowStatus === status).filter((job) => !query || [job.organization, job.title, job.subjectAreas].join(" ").toLowerCase().includes(query.toLowerCase())).sort(compareDeadlines); return <div className={`list-column ${status}`} key={status}><div className="list-heading"><button type="button" className="list-title-button" aria-expanded={!collapsedLists[status]} onClick={() => toggleList(status)}><h2>{workflowLabels[status]}</h2></button><button type="button" className="icon-button column-toggle" aria-label={`${allCardsCollapsed(status) ? "Expand" : "Collapse"} all ${workflowLabels[status]} postings`} title={`${allCardsCollapsed(status) ? "Expand" : "Collapse"} all postings`} onClick={() => toggleAllCards(status)}>{allCardsCollapsed(status) ? "⌄⌄" : "⌃⌃"}</button></div>{!collapsedLists[status] && <div className="job-stack">{sectionJobs.slice(0, 8).map((job) => <JobCard key={job.id} job={job} onMove={moveJob} onToggleProcessed={toggleProcessed} onStartEdit={startEdit} editing={editingId === job.id} editDraft={editingId === job.id ? editDraft : null} onEditChange={editChange} onSaveEdit={saveEdit} onCancelEdit={cancelEdit} />)}{sectionJobs.length === 0 && <EmptyState label={status === "consider" ? "Processed matches will appear here after review." : "Move a job here when you are ready."} />}</div>}{!collapsedLists[status] && sectionJobs.length > 8 && <button className="view-more" onClick={() => showFiltered({ workflow: status })}>View all {counts[status]} →</button>}</div>; })}</section></>}
    {view === "all" && <section className="all-view"><div className="workspace-heading"><h2>All postings</h2><a className="rss-link" href={MATHJOBS_LIST_URL} target="_blank" rel="noreferrer">Open MathJobs listings ↗</a></div><div className="filters"><input aria-label="Search all postings" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all postings" /><select aria-label="Workflow filter" value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value as "all" | Workflow)}><option value="all">All workflow states</option>{Object.entries(workflowLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><select aria-label="Processing filter" value={processedFilter} onChange={(event) => setProcessedFilter(event.target.value as "all" | "processed" | "unprocessed")}><option value="all">All processing states</option><option value="unprocessed">Unprocessed</option><option value="processed">Processed</option></select><select aria-label="Source filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All sources</option><option value="mathjobs">MathJobs</option><option value="manual">Manual</option></select><input aria-label="Location filter" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)} placeholder="Location" /><input aria-label="Position type filter" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} placeholder="Position type" /><select aria-label="Sort postings" value={sort} onChange={(event) => setSort(event.target.value)}><option value="deadline">Soonest deadline</option><option value="posted">Newest posted</option><option value="organization">Employer A–Z</option></select><button className="text-button" onClick={resetFilters}>Clear</button></div><div className="query-note"><strong>Processing queue</strong><span>Unprocessed records are waiting for a detailed posting review. Edit any record here, or mark it processed when the review is complete.</span></div><div className="all-results"><div className="result-count">Showing {filteredJobs.length} of {jobs.length} postings</div>{filteredJobs.map((job) => <JobCard key={job.id} job={job} onMove={moveJob} onToggleProcessed={toggleProcessed} onStartEdit={startEdit} editing={editingId === job.id} editDraft={editingId === job.id ? editDraft : null} onEditChange={editChange} onSaveEdit={saveEdit} onCancelEdit={cancelEdit} />)}{!filteredJobs.length && <EmptyState label="Try a broader search or clear the filters." onReset={resetFilters} />}</div></section>}
    {view === "add" && <section className="add-view"><div className="workspace-heading"><h2>Add posting</h2></div><form className="posting-form" onSubmit={addPosting}><div className="form-section"><span className="form-kicker">Posting details</span><div className="form-grid"><label>Employer<input required value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="University or organization" /></label><label>Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Assistant Professor of..." /></label><label>Position type<input value={form.positionType} onChange={(e) => setForm({ ...form, positionType: e.target.value })} placeholder="Tenure-track, postdoc, ..." /></label><label>Location<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="City, state, country" /></label><label>Subject areas<input value={form.subjectAreas} onChange={(e) => setForm({ ...form, subjectAreas: e.target.value })} placeholder="Analysis, geometry, teaching" /></label><label>Deadline timestamp<input value={form.deadlineAt} onChange={(e) => setForm({ ...form, deadlineAt: e.target.value })} placeholder="2026-10-16T03:59:00Z" /></label><label>Deadline timezone<input value={form.deadlineTimeZone} onChange={(e) => setForm({ ...form, deadlineTimeZone: e.target.value })} placeholder="America/New_York" /></label><label>Deadline context<input value={form.deadlineQualifier} onChange={(e) => setForm({ ...form, deadlineQualifier: e.target.value })} placeholder="Full consideration; open until filled" /></label><label className="wide">Posting link<input type="url" required value={form.postingUrl} onChange={(e) => setForm({ ...form, postingUrl: e.target.value })} placeholder="https://..." /></label></div></div><div className="form-section"><span className="form-kicker">Application details</span><div className="form-grid"><label>How to apply<input value={form.applicationMethod} onChange={(e) => setForm({ ...form, applicationMethod: e.target.value })} placeholder="MathJobs application / external portal" /></label><label className="wide">Application brief<textarea value={form.applicationSummary} onChange={(e) => setForm({ ...form, applicationSummary: e.target.value })} placeholder="What is the workflow? Which portal? Any key constraints?" /></label><label className="wide">Materials<textarea value={form.materials} onChange={(e) => setForm({ ...form, materials: e.target.value })} placeholder="CV, cover letter, research statement, references..." /></label><label className="wide">Your notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Why it might fit, questions to answer, people to contact..." /></label></div></div><div className="form-actions"><button type="button" className="button button-light" onClick={() => setView("dashboard")}>Cancel</button><button type="submit" className="button button-primary">Add as unprocessed</button></div></form></section>}
    <footer className="footer"><span>MathJobs: <a href={MATHJOBS_LIST_URL} target="_blank" rel="noreferrer">Open listings ↗</a></span></footer>
  </main></TriageContext.Provider>;
}
