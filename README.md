# Academic job tracker

A compact personal tracker for academic job postings. It syncs the MathJobs RSS
feed, stores every posting in Cloudflare D1, uses Cloudflare Workers AI to
research and triage postings, and tracks the application workflow from initial
review through submission.

## How it works

- **Sync MathJobs** imports new RSS records as unprocessed postings.
- **Triage** fetches the posting and up to two relevant application or hiring
  pages, asks Workers AI for a structured review, and saves the deadline,
  application process, materials, fit decision, and supporting notes.
- The main workspace contains **To consider**, **Will apply**, and **Applied**
  queues. All records, including unprocessed and archived postings, remain
  searchable in **All postings**.
- The app is intentionally single-user and does not contain authentication.

## Development

Prerequisite: Node.js `>=22.13.0`.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The placeholder D1 ID is sufficient for local development because Wrangler
uses a local database by default. Useful checks:

```bash
npm run lint
npm test
npm run build
```

## Personalizing the triage reviewer

All candidate-specific preferences live in the `TRIAGE_PROFILE` deployment
secret. They are not tracked in source or available to downstream forks, and
they are not used when the secret is absent. The extraction rules, deadline
logic, HTML cleanup, location normalization, and structured output schema are
generic and should normally remain unchanged.

[`AI_SETUP_GUIDE.md`](AI_SETUP_GUIDE.md) is written for an AI coding agent or
desktop LLM harness. It covers repository setup, Cloudflare configuration, a
structured interview for job-search preferences, first deployment, and an
acceptance test.

To begin, give your AI agent this guide URL:

<https://raw.githubusercontent.com/diracdeltafunk/math-job-tracker/master/AI_SETUP_GUIDE.md>

The current Workers AI model is `@cf/openai/gpt-oss-120b`. It is configured in
`app/api/triage/route.ts` and does not require a separate AI-provider key.

## Cloudflare and GitHub setup

1. Create a Cloudflare D1 database, for example:

   ```bash
   npx wrangler login
   npx wrangler d1 create academic-job-tracker
   ```

2. Copy `.env.example` to `.env.local` and fill in the returned database ID for
   local production builds.
3. Add these GitHub repository variables:

   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_WORKER_NAME`
   - `CLOUDFLARE_D1_DATABASE_NAME`
   - `CLOUDFLARE_D1_DATABASE_ID`

4. Add these GitHub Actions secrets:

   - `CLOUDFLARE_API_TOKEN`, using Cloudflare's **Edit Cloudflare Workers** token
     template and scoped to the selected account.
   - `TRIAGE_PROFILE`, containing the approved candidate-specific decision
     policy.

GitHub Actions builds and deploys after every push to `master`. The first app
request creates the D1 tables and indexes. Later schema upgrades are applied by
the same idempotent initialization code in `lib/tracker-db.ts`.

## Public-template hygiene

If a private development repository has ever contained personal configuration,
credentials, account IDs, or database IDs, do not make that repository public:
deleting the current files does not erase Git history. Export the sanitized
working tree into a brand-new public repository with fresh history, audit the
tracked files, and use that repository as the forkable template. A template
created this way starts with a clean commit and can be safely forked.

## Branch rule

Work in progress belongs in a separate branch. Merge into `master` only when a
change is ready to deploy.

## Recovery and backups

[Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
is always enabled; no scheduled backup job is needed. It provides point-in-time
recovery to any minute within the last **7 days on the Workers Free plan** or
**30 days on the Workers Paid plan**, at no additional cost.

After building with the production values from `.env.local`, inspect a restore
point with:

```bash
npx wrangler d1 time-travel info academic-job-tracker \
  --config dist/server/wrangler.json \
  --timestamp="2026-08-17T12:00:00Z"
```

Restore only after confirming the timestamp. This overwrites the live database:

```bash
npx wrangler d1 time-travel restore academic-job-tracker \
  --config dist/server/wrangler.json \
  --timestamp="2026-08-17T12:00:00Z"
```

For backups retained longer than Time Travel's window, Cloudflare also supports
scheduled D1 exports to R2. That is deliberately not enabled here: this small,
recoverable tracker is well covered by Time Travel, and an R2 export workflow
would add credentials and restore procedures that must be maintained.

## Data and review workflow

- `POST /api/jobs` with `{ "action": "sync" }` imports new MathJobs records.
- `GET /api/jobs` returns records and supports `q`, `source`, `location`, `type`,
  `workflow`, and `processed` filters.
- `PATCH /api/jobs/:id` updates editable posting fields and workflow state.
  Deadlines are stored as integer Unix timestamps for sorting, with timezone and
  context stored separately.
- `POST /api/triage` with `{ "jobId": "..." }` reviews one posting. Passing
  `{ "force": true }` re-triages a processed posting while preserving an
  existing **Will apply** or **Applied** state.

The triage prompt prefers full-consideration, priority, or review-start dates
over later “until filled” language; defaults missing deadline times/timezones to
11:59 PM ET; normalizes locations; decodes HTML entities; and evaluates teaching
load in terms of both courses and administrative burden.
