import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the academic job tracker", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Academic Job Tracker<\/title>/i);
  assert.doesNotMatch(html, /Find the right openings|Keep every thread|og:image|\/og\.png/i);
  assert.match(html, /To consider/);
  assert.match(html, /Will apply/);
  assert.match(html, /Applied/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps tracker source free of starter skeleton artifacts", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Sync MathJobs/);
  assert.match(page, /Application brief/);
  assert.match(page, /Advanced search/);
  assert.match(layout, /Academic Job Tracker/);
  assert.doesNotMatch(layout, /og\.png|openGraph|twitter/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /_sites-preview|Starter Project/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("keeps personalization deployment-only and the application-link field removed", async () => {
  const [page, styles, jobsRoute, triageRoute, database, viteConfig, workflow, guide, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/triage/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/tracker-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"),
    readFile(new URL("../AI_SETUP_GUIDE.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${page}\n${jobsRoute}\n${triageRoute}`, /applicationUrl|Apply ↗|Application link/);
  assert.match(page, /formatShortDeadline/);
  assert.match(page, /collapsed-organization[^]*collapsed-deadline/);
  assert.match(page, /collapsed-organization" title=\{job\.organization\}/);
  assert.match(styles, /\.job-card\.is-collapsed \{[^}]*overflow: hidden/);
  assert.match(styles, /\.collapsed-organization \{[^}]*flex: 1 1 0;[^}]*text-overflow: ellipsis/);
  assert.match(triageRoute, /configuredTriageProfile/);
  assert.match(triageRoute, /TRIAGE_PROFILE deployment secret is configured/);
  assert.doesNotMatch(triageRoute, /export const TRIAGE_PROFILE\s*=/);
  assert.match(viteConfig, /TRIAGE_PROFILE/);
  assert.match(workflow, /secrets\.TRIAGE_PROFILE/);
  assert.match(guide, /Triage unprocessed/);
  assert.match(guide, /daily usage limits/);
  assert.match(guide, /already owns a repository[^]*do \*\*not\*\* create/i);
  assert.match(guide, /Use this template/);
  await assert.rejects(access(new URL("../config/triage-profile.ts", import.meta.url)));
  assert.match(database, /DROP COLUMN application_url/);
  assert.doesNotMatch(viteConfig, /openai\/sites|hosting\.json/);
  assert.doesNotMatch(packageJson, /drizzle|tailwind|sites-vite-plugin|site-creator/);
});
