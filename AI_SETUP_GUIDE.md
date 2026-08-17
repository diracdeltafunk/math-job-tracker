# AI-guided setup for Academic Job Tracker

This document is written for an AI coding agent or desktop LLM harness. If a
user gives you a link to this file and asks for help setting up the tracker,
follow the process below. Guide the user interactively; do not merely summarize
these instructions.

The goal is a personal deployment with:

- a repository owned by the user;
- a Cloudflare Worker, D1 database, and Workers AI binding owned by the user;
- automated deployment from the user's `master` branch; and
- a triage profile based only on the user's job-search preferences.

## Operating rules for the agent

1. Work only in the user's fork or personal copy, never in the upstream
   template repository.
2. Pause when the user must sign in, approve access, create an account, or copy
   a credential. Resume after they confirm completion.
3. Never print an API token, paste one into chat, put one in a command argument,
   or commit one to Git. Put credentials directly into GitHub Actions secrets.
4. Treat the candidate profile as private configuration. It may not be a
   credential, but store it as the `TRIAGE_PROFILE` Actions secret so it is not
   copied into source or exposed in routine logs.
5. Keep Cloudflare account and database IDs out of source even though they are
   identifiers rather than credentials. Store them as GitHub Actions variables.
6. Do not deploy until every required secret and variable is configured.
7. Ask a few profile questions at a time. Synthesize and show the complete
   profile for approval before storing it.
8. Make no changes to the generic extraction, deadline, location, or structured
   output rules unless the user explicitly asks for an application change.

## Configuration map

Configure these values in the user's repository under **Settings → Secrets and
variables → Actions**:

| Name | GitHub setting | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Allows the deployment workflow to deploy the Worker |
| `TRIAGE_PROFILE` | Secret | Candidate-specific preferences used by the triage model |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Selects the user's Cloudflare account |
| `CLOUDFLARE_WORKER_NAME` | Variable | Names the deployed Worker |
| `CLOUDFLARE_D1_DATABASE_NAME` | Variable | Names the D1 database |
| `CLOUDFLARE_D1_DATABASE_ID` | Variable | Binds the Worker to that D1 database |

The repository must not contain real values in `.env`, `.env.local`,
`.dev.vars`, Wrangler configuration, source files, documentation examples, or
committed build output. The app deliberately refuses to triage when
`TRIAGE_PROFILE` is absent.

## Phase 1: make the user's repository

Ask for the user's GitHub username and desired repository name. Explain that a
fork of a public repository is public. If they require a private repository,
create a new private repository from the sanitized template instead of using
GitHub's fork button.

For the normal public setup, have the user fork the sanitized public template
on GitHub, or use GitHub CLI:

```bash
gh repo fork diracdeltafunk/math-job-tracker --clone
cd math-job-tracker
npm ci
```

Confirm that `git remote -v` identifies the user's fork as `origin`. Do not
continue if `origin` is the upstream project.

Before adding any personal settings, perform a quick source audit:

- there should be no tracked `.env` or `.dev.vars` file;
- `.github/workflows/deploy.yml` should reference
  `secrets.TRIAGE_PROFILE`, not contain a candidate profile;
- the triage route should read `TRIAGE_PROFILE` from the Worker environment;
- search tracked files for another candidate's name, email address, website,
  Cloudflare account ID, D1 database ID, and tokens;
- run `git status` and confirm the worktree is understood before editing.

If the source contains another person's profile or credentials, stop and tell
the user not to use that repository. A public template should have been created
from a sanitized working tree with fresh Git history.

GitHub disables workflows in forks by default. Leave Actions disabled until
the Cloudflare configuration is complete. Do not change the deployment branch:
this project intentionally deploys only from `master`.

## Phase 2: create the Cloudflare resources

Ask whether the user already has a Cloudflare account. If not, guide them to
create a free account. They do not need to transfer a domain; the default
`workers.dev` address is sufficient.

From the cloned repository, authenticate Wrangler and create one D1 database:

```bash
npx wrangler login
npx wrangler d1 create academic-job-tracker
```

The login command opens an interactive Cloudflare authorization page. The D1
command returns the database name and UUID. Record both without adding them to a
tracked file. `npx wrangler whoami` can be used to confirm the selected account
and its account ID.

Ask the user for a short, globally unique Worker name, for example
`academic-job-tracker-alex`. Avoid spaces and punctuation other than hyphens.

Next, guide the user through creating a deployment token in the Cloudflare
dashboard:

1. Open **My Profile → API Tokens → Create Token**.
2. Select the **Edit Cloudflare Workers** template.
3. Scope it to only the account that owns the new D1 database.
4. Create and copy the token once.

Cloudflare's official GitHub Actions guide recommends this token template and
account scoping. The token is a credential: never ask the user to paste it into
chat or display it in terminal output.

## Phase 3: interview the user for the triage profile

Explain that the profile controls only fit decisions. Generic code already
handles page fetching, HTML cleanup, location normalization, deadline
prioritization, structured output, and database updates.

Interview the user in the following rounds. Ask roughly three to five concise
questions, wait for answers, then continue. Skip questions already answered.

### Round A: career stage and eligible roles

Ask:

- What is the candidate's current role and career stage?
- Which ranks and contract types are realistic now?
- Which roles are automatic exclusions: postdocs, visiting jobs, adjunct work,
  senior/tenured ranks, soft-money roles, or something else?
- How should titles whose meaning varies by country be interpreted? In
  particular, clarify `Lecturer`, `Assistant Professor`, and local equivalents
  of tenure-track employment.

### Round B: research fit

Ask:

- What are the candidate's main research areas, in both specialist and broad
  language?
- Which adjacent areas are plausible or attractive?
- Are general/open-field searches desirable?
- Which fields are clear mismatches even if the institution is excellent?

Encourage enough vocabulary for the model to recognize neighboring fields, but
do not turn the profile into a CV or include personal contact information.

### Round C: institution, teaching, and students

Ask:

- What balance of research and teaching does the candidate want?
- Which institution types are attractive: R1, liberal arts, regional public,
  community college, research institute, industry, or others?
- What teaching loads are comfortable, borderline, and unacceptable? Interpret
  loads such as `2-2` as two courses each semester and ask about preparations,
  class sizes, coordination, advising, and administrative burden—not only raw
  classroom hours.
- How important are student preparation, research support, sabbaticals, startup
  funding, and graduate supervision?
- Are unusually prestigious institutions allowed to override a normally
  unacceptable teaching load or role type? If so, define the exception.

### Round D: geography and practical constraints

Ask:

- Which countries, regions, or cities are preferred, acceptable, or excluded?
- Are there citizenship, visa, family, safety, political, or diplomatic
  considerations?
- How should salary and cost of living affect non-local jobs?
- Is relocation required, acceptable, or undesirable? Are remote or hybrid
  roles relevant?
- What timezone should be used when a deadline date has no stated time or
  timezone? If the user has no preference, retain the app default of 11:59 PM
  America/New_York.

### Round E: decision threshold and tie-breakers

Ask:

- Because this tracker has only `consider` and `archived` triage outcomes, how
  inclusive should `consider` be?
- What facts should always cause archiving?
- What positive signals should rescue an otherwise borderline posting?
- How should uncertainty be handled when teaching load, permanence, salary, or
  field fit is not stated?
- Are there special institutions or programs the candidate always wants to
  inspect personally?

## Phase 4: synthesize and approve the profile

Write a compact plain-text policy using headings like these:

```text
Candidate and search posture:
...

Target roles and seniority:
...

Research fit:
...

Institution and teaching preferences:
...

Geography and practical constraints:
...

Automatic archive rules:
...

Borderline cases and positive signals:
...

Decision policy:
...
```

The profile should be specific enough to make consistent decisions, but it
should contain no phone number, home address, private email, account credential,
or irrelevant biography. Do not repeat generic rules already enforced by the
app. Preserve nuanced country-specific title meanings rather than using a single
US definition worldwide.

Show the full draft to the user. Ask them to correct omissions and ambiguous
rules. Only after explicit approval should you store it as `TRIAGE_PROFILE`.

## Phase 5: configure GitHub

Set the four non-sensitive repository variables. With GitHub CLI, commands have
this form:

```bash
gh variable set CLOUDFLARE_ACCOUNT_ID --body "ACCOUNT_ID"
gh variable set CLOUDFLARE_WORKER_NAME --body "WORKER_NAME"
gh variable set CLOUDFLARE_D1_DATABASE_NAME --body "DATABASE_NAME"
gh variable set CLOUDFLARE_D1_DATABASE_ID --body "DATABASE_UUID"
```

Set the two secrets through hidden or direct-input UI. With GitHub CLI, run each
command without `--body`, paste the value directly into its input, and finish
input with Ctrl-D:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set TRIAGE_PROFILE
```

Do not create a local file containing the Cloudflare token. If a temporary file
is unavoidable for the multiline profile, create it outside the repository,
upload it through standard input, then securely remove it. Never commit it.

Verify names without attempting to retrieve secret values:

```bash
gh variable list
gh secret list
```

Expected variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_WORKER_NAME`
- `CLOUDFLARE_D1_DATABASE_NAME`
- `CLOUDFLARE_D1_DATABASE_ID`

Expected secrets:

- `CLOUDFLARE_API_TOKEN`
- `TRIAGE_PROFILE`

## Phase 6: enable Actions and deploy

On the fork's **Actions** tab, enable workflows. GitHub documents that workflows
do not run in forked repositories until explicitly enabled.

The deployment workflow supports a manual run, which is preferable for the
first deployment because the fork event itself occurred before configuration:

```bash
gh workflow run deploy.yml
gh run watch
```

If the workflow fails its configuration check, do not bypass the check. Find
the missing variable or secret and rerun it. If Cloudflare rejects deployment,
verify the account ID, token account scope, and Worker permission before
creating a broader token.

After a successful run, open the deployed `workers.dev` URL from the workflow
or Cloudflare dashboard. The first request initializes the database schema.

## Phase 7: perform a small acceptance test

Use the live site and verify, in order:

1. **Sync MathJobs** completes and imports records.
2. A newly imported record is marked unprocessed.
3. Triage exactly one unprocessed posting.
4. The saved record has a real deadline when a full-consideration, priority, or
   review-start date is present.
5. The record is moved to either **To consider** or the archive according to the
   approved profile.
6. **Edit**, **mark unprocessed**, and **re-triage** work as expected.

Do not launch a full-batch triage until this one-record test succeeds. Workers
AI usage is normally inexpensive at this scale, but a full batch creates real
usage and makes a bad profile harder to diagnose.

## Phase 8: explain the finished site to the user

End the setup session with a brief, plain-language tour:

- **Sync MathJobs** imports new feed records as unprocessed postings without
  overwriting existing workflow decisions.
- **Triage unprocessed** researches each waiting posting, extracts the useful
  deadline and application details, and uses the approved profile to place it
  in **To consider** or the archive.
- Individual cards can be triaged, edited, marked processed or unprocessed,
  re-triaged, archived, and moved through **To consider**, **Will apply**, and
  **Applied**.
- **All postings** includes every record and provides filters and deadline
  sorting. The three dashboard columns are only the active workflow queues.
- **Add posting** records jobs that are not in the MathJobs feed.
- Data lives in the user's Cloudflare D1 database; D1 Time Travel is the short-
  term recovery mechanism.

Always include this free-tier disclaimer in the handoff, adapted only for
clarity:

> Cloudflare's free Workers AI tier has daily usage limits. After the first
> MathJobs sync, there may be more unprocessed postings than the account can
> triage in one day. Press **Triage unprocessed**: it will save as many reviews
> as the current allowance permits, and any failures will remain unprocessed.
> If Cloudflare starts returning usage-limit errors, wait for the daily
> allowance to reset and press the button again the next day. A large initial
> backlog should normally clear over several days.

## Ongoing use and maintenance

- Make changes in a feature branch. Merge into `master` only when ready to
  deploy.
- To change job preferences, update only the `TRIAGE_PROFILE` repository secret
  and run the deployment workflow again.
- The profile is injected during the build. Changing the GitHub secret alone
  does not alter the live Worker until a deployment completes.
- Cloudflare D1 Time Travel provides point-in-time recovery. Confirm a restore
  timestamp before running a restore because restoring overwrites the live
  database.
- The app is intentionally single-user and has no authentication. Do not store
  sensitive application documents or personal correspondence in it. Add
  Cloudflare Access separately if the user wants access control.

## Completion report

When setup is complete, report:

- the user's repository URL;
- the Worker URL;
- the configured Worker and D1 names, but not the API token or profile text;
- whether the first deployment and one-record triage test passed;
- whether Actions is enabled;
- any remaining manual step;
- how to update the profile later;
- the short site tour from Phase 8; and
- the free-tier triage disclaimer from Phase 8.

## Official references

- [Cloudflare: deploy Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare: D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare: Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cloudflare: D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [GitHub: workflows in forked repositories](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories)
- [GitHub: using secrets in Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub CLI: `gh secret set`](https://cli.github.com/manual/gh_secret_set)
- [GitHub CLI: `gh variable set`](https://cli.github.com/manual/gh_variable_set)
