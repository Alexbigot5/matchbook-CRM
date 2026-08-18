import type { Route } from "./+types/api.prospect";
import { appContext } from "../../load-context";
import { ago } from "../crm/data";
import {
  buildRunView,
  composeBrief,
  dedupeProspects,
  mapColumns,
  mapRow,
  toContactRow,
  type Prospect,
  type ProspectRun,
  type RunCounts,
} from "../crm/prospecting";
import {
  createOrigamiClient,
  DEFAULT_RETRY_AFTER_SECONDS,
  type OrigamiAgentCreated,
  type OrigamiClient,
  type OrigamiFlatRow,
  type OrigamiResult,
  type OrigamiRun,
} from "../lib/origami.server";
import {
  PROSPECT_POLL_RULE,
  PROSPECT_RUN_RULE,
  rateLimit,
} from "../lib/ratelimit.server";
import { requireUser } from "../lib/session.server";
import {
  createManyContacts,
  createProspectRun,
  findRunningProspectRun,
  latestProspectRun,
  listContacts,
  listProspects,
  listProspectThread,
  listProspectsForRuns,
  markProspectsPromoted,
  replaceProspects,
  updateProspectRun,
  type StoredProspectRun,
} from "../lib/crm.server";
import {
  asString,
  csvCell,
  isValidLoop,
  isValidOwner,
  isValidProspectStatus,
  LIMITS,
  MAX_PROSPECT_ROW_PAGES,
  MAX_PROSPECTS_PER_RUN,
  validateIds,
  validateImportRows,
  validateProspectPrompt,
  validateProspectRows,
} from "../lib/validate";

// ---------------------------------------------------------------------------
// The prospecting agent's resource route (no default component).
//
// SESSION-GATED, unlike /api/hyperagent. That route authenticates machines with
// a shared bearer token, and the same reasoning that keeps template copy off it
// applies harder here: a token that can spend a third party's credits and inject
// contacts into a dataset four people share is a worse primitive than one that
// moves counters. Every entry point below runs requireUser first.
//
// WHY THE GET MUTATES. Origami runs are asynchronous and take one to five
// minutes. A Cloudflare Worker cannot hold a request open for that, and this app
// has no Durable Object, no queue and no cron — D1 is the only store. So the run
// is a state machine persisted in `prospect_runs`, and EACH POLL ADVANCES IT ONE
// STEP. That makes this loader impure, deliberately: it is idempotent, it is the
// only way to drive the work forward without background execution, and it means
// a run survives a page refresh or a closed laptop.
//
// WHY POLLING IS A GET AND NOT AN INTENT. A POST to any route revalidates every
// loader in React Router, so polling through the action would refetch the whole
// contact list every few seconds for the entire length of a five-minute run. A
// GET reached through `fetcher.load` revalidates nothing. The `promote` POST is
// a POST precisely because it SHOULD revalidate — that is what makes the new
// contacts appear in the table behind the panel.
//
// THE POLL BUDGET. Origami rate-limits 100 requests per minute PER ORGANIZATION,
// shared across every key that org has issued. The client polls this route every
// few seconds so its elapsed timer stays honest; `next_poll_at` in D1 is what
// stops that becoming an Origami call every few seconds. Read advanceRun() with
// that in mind: most polls do a single D1 read and return.
// ---------------------------------------------------------------------------

const json = <T,>(data: T, status = 200) => Response.json(data, { status });

/** Rows a run may promote at once. Bounded for the same reason MAX_IDS is. */
const MAX_PROMOTE = 200;

/**
 * How long a run may go without moving before it is treated as abandoned.
 *
 * Nothing advances a run except a poll, so a closed tab strands one in flight
 * and the one-run-at-a-time guard would then lock the feature forever. Origami's
 * runs finish in one to five minutes, so fifteen leaves a wide margin for a slow
 * one while still self-healing inside a coffee break.
 */
const STALE_RUN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Provider error translation
// ---------------------------------------------------------------------------

/**
 * Turn an Origami failure into a sentence a salesperson can act on.
 *
 * Only the codes with a real user-facing remedy are named. Everything else falls
 * through to the client's already-redacted message, which is more useful than a
 * generic apology when someone is reading `wrangler tail`.
 */
function friendlyProviderError(err: { error: string; code?: string; status?: number }): string {
  switch (err.code) {
    case "CONCURRENT_LIMIT_EXCEEDED":
      return "Origami is already running an agent. Wait for it to finish, then try again.";
    case "SUBSCRIPTION_REQUIRED":
      return "This Origami plan doesn't include API access. Upgrade the plan to use prospecting.";
    case "UNAUTHORIZED":
      return "Origami rejected the API key. Check ORIGAMI_API_KEY.";
    case "PROJECT_NOT_FOUND":
      return "The configured Origami project no longer exists. Check ORIGAMI_PROJECT_ID.";
    default:
      break;
  }
  if (err.status === 401) return "Origami rejected the API key. Check ORIGAMI_API_KEY.";
  if (err.status === 429) {
    return "Origami is rate-limiting this account. Wait a minute and try again.";
  }
  return err.error;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * The client's view of a run. Note what does NOT cross: the Origami agent and
 * run ids, `next_poll_at`, and the creator's email. The panel addresses a run by
 * our own id and nothing else, so nothing it holds could be replayed against
 * Origami directly.
 */
function toClientRun(run: StoredProspectRun, now: number): ProspectRun {
  const startedAt = run.createdAtMs || now;
  return {
    id: run.id,
    // Sent only so the client can tell two threads apart, never used to address
    // Origami — the server resolves the provider ids from the row itself.
    agentId: run.agentId ? "thread" : null,
    prompt: run.prompt,
    status: run.status,
    stage: run.stage,
    summary: run.summary,
    question: run.question,
    error: run.error,
    tableId: run.tableId,
    counts: run.counts,
    nextActions: [],
    // Both precomputed here against one `now`, so no Date math runs while React
    // renders and SSR matches hydration. Same rule as every other loader.
    agoLabel: ago(Math.floor((now - startedAt) / 86_400_000)),
    elapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
  };
}

/** The whole thread plus its prospects, in one payload the panel maps directly. */
async function threadPayload(
  db: D1Database,
  runs: StoredProspectRun[],
  now: number,
) {
  const byRun = await listProspectsForRuns(db, runs.map((r) => r.id));
  const turns = runs.map((run) =>
    buildRunView(toClientRun(run, now), byRun.get(run.id) ?? []),
  );
  // Derived from OUR stage, not from Origami's status. A run can be `completed`
  // at Origami and still owe us the `reading` step that turns its table into
  // prospects — keying this on status stopped the panel polling in that window,
  // so a finished run sat there showing nothing until someone reopened it.
  const active = runs.some((r) => r.stage !== "ready" && r.stage !== "failed");
  return {
    ok: true as const,
    // The panel polls while this is true and stops when it isn't.
    running: active,
    turns,
  };
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Advance one run by at most one step, then return.
 *
 * Never loops waiting for the provider: one poll does one thing. The stages are
 *
 *   researching -> ask Origami whether the run is done yet (rate-paced by
 *                  next_poll_at), and record the terminal outcome
 *   reading     -> read the table it built, map, dedupe, store
 *   ready/failed-> nothing; the client stops polling
 */
async function advanceRun(
  db: D1Database,
  client: OrigamiClient,
  run: StoredProspectRun,
  now: number,
): Promise<void> {
  if (run.stage === "ready" || run.stage === "failed") return;

  if (run.stage === "starting" || run.stage === "researching") {
    // No provider ids means POST /agents never came back. There is nothing to
    // poll and nothing to resume — the run is closed out rather than left
    // spinning forever in front of someone watching a timer.
    if (!run.agentId || !run.providerRunId) {
      await updateProspectRun(db, run.id, {
        status: "errored",
        stage: "failed",
        error: run.error ?? "The run never started at Origami.",
      });
      return;
    }

    // The whole point of next_poll_at. Origami's Retry-After is 15s and their
    // per-org budget is 100 requests/minute; the client polls far faster than
    // that so its timer stays live, and most of those polls stop right here.
    if (run.nextPollAt && now < run.nextPollAt) return;

    const res = await client.getRun(run.agentId, run.providerRunId);
    if (!res.ok) {
      // A failed poll is not a failed run: the run is still going at Origami,
      // and this could be a blip or a shared-quota 429. Back off and try again
      // rather than declaring a billed run dead.
      const backoff = (res.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000;
      await updateProspectRun(db, run.id, {
        nextPollAt: now + backoff,
        error: friendlyProviderError(res),
      });
      return;
    }

    await recordRunOutcome(db, run, res.data, res.retryAfterSeconds, now);
    return;
  }

  if (run.stage === "reading") {
    await readTable(db, client, run);
  }
}

/**
 * Fold a polled run object into the row.
 *
 * `Retry-After` is the discriminator Origami documents: it is present only while
 * the run is `running`, and its absence means stop polling. `status` is checked
 * too, because trusting a header alone to decide whether work is finished is a
 * bad bet on a beta API.
 */
async function recordRunOutcome(
  db: D1Database,
  run: StoredProspectRun,
  data: OrigamiRun | undefined,
  retryAfterSeconds: number | undefined,
  now: number,
): Promise<void> {
  const status = isValidProspectStatus(data?.status) ? data.status : "running";

  if (status === "running") {
    await updateProspectRun(db, run.id, {
      status,
      stage: "researching",
      nextPollAt: now + (retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000,
      // Clear any transient poll error now that we've heard from them again.
      error: null,
    });
    return;
  }

  const response = data?.response ?? null;
  const actions = Array.isArray(response?.actions) ? response.actions : [];
  const tables = Array.isArray(response?.tables) ? response.tables : [];
  // The table with the most leads, not the first: a run that creates a scratch
  // table before its real one lists both, and the results are in the big one.
  const table = [...tables].sort((a, b) => (b.leadCount ?? 0) - (a.leadCount ?? 0))[0];

  // Origami documents response.text as null on errored and timed_out, so this
  // must never be rendered as a summary for those.
  const summary = typeof response?.text === "string" ? response.text : null;

  const questions = Array.isArray(data?.todo?.pendingQuestions)
    ? data.todo.pendingQuestions
    : [];
  // Only the first: the panel asks one thing at a time, and answering it starts
  // a follow-up run that re-raises anything still outstanding.
  const rawQuestion = questions[0];
  const question =
    typeof rawQuestion === "string"
      ? rawQuestion.slice(0, LIMITS.prospectPrompt)
      : typeof (rawQuestion as { text?: string })?.text === "string"
        ? (rawQuestion as { text: string }).text.slice(0, LIMITS.prospectPrompt)
        : null;

  const dead = status === "errored" || status === "timed_out";
  const tableId = asString(table?.id) || null;

  await updateProspectRun(db, run.id, {
    status,
    // A terminal run with a table still has reading to do. One with neither a
    // table nor a question has nothing left, whatever its status says.
    stage: dead ? "failed" : tableId ? "reading" : "ready",
    nextPollAt: null,
    summary,
    actions,
    question,
    tableId,
    error: dead
      ? status === "timed_out"
        ? "Origami timed out on this run. Sending a follow-up continues from here."
        : "Origami couldn't finish this run."
      : null,
    counts: {
      found: Number(table?.leadCount) || 0,
      read: 0,
      skipped: 0,
      dedupedEmail: 0,
      dedupedName: 0,
      verified: 0,
      likely: 0,
      noEmail: 0,
      missingColumns: [],
    },
  });
}

/**
 * Read the table the agent built, map it onto contacts, dedupe, store.
 *
 * Bounded twice: MAX_PROSPECT_ROW_PAGES pages, and MAX_PROSPECTS_PER_RUN rows.
 * An agent asked for twenty leads can build a table of thousands — the brief is
 * a suggestion, not a LIMIT clause — and every stored row is serialized into the
 * panel and rendered.
 */
async function readTable(
  db: D1Database,
  client: OrigamiClient,
  run: StoredProspectRun,
): Promise<void> {
  if (!run.tableId) {
    await updateProspectRun(db, run.id, { stage: "ready" });
    return;
  }

  const columnsRes = await client.listColumns(run.tableId);
  if (!columnsRes.ok) {
    // The run itself succeeded and Origami still holds the table, so this is
    // recoverable: leave the stage alone and let the next poll retry the read.
    await updateProspectRun(db, run.id, { error: friendlyProviderError(columnsRes) });
    return;
  }
  const map = mapColumns(columnsRes.data?.items ?? []);

  const raw: OrigamiFlatRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROSPECT_ROW_PAGES; page++) {
    const rowsRes = await client.listRows(run.tableId, cursor);
    if (!rowsRes.ok) {
      // Same reasoning, with one addition: a partial read must not be stored as
      // if it were the whole table, or the panel reports "12 found" for a run
      // that found forty.
      await updateProspectRun(db, run.id, { error: friendlyProviderError(rowsRes) });
      return;
    }
    raw.push(...(rowsRes.data?.items ?? []));
    cursor = rowsRes.data?.nextCursor ?? undefined;
    if (!cursor || raw.length >= MAX_PROSPECTS_PER_RUN) break;
  }

  // A flat row is either { slug: value } at the top level or under `cells`,
  // depending on how the endpoint frames it. Both are accepted rather than
  // betting on one shape of a beta API.
  const mapped = raw
    .slice(0, MAX_PROSPECTS_PER_RUN)
    .map((row) => mapRow((row.cells as Record<string, unknown>) ?? row, map));

  const validated = validateProspectRows(mapped);
  if (!validated.ok) {
    await updateProspectRun(db, run.id, { stage: "ready", error: validated.error });
    return;
  }

  const contacts = await listContacts(db, Date.now());
  const deduped = dedupeProspects(validated.rows, contacts);
  await replaceProspects(db, run.id, deduped);

  const fresh = deduped.filter((p) => !p.dedupe);
  const counts: RunCounts = {
    found: run.counts?.found || deduped.length,
    read: deduped.length,
    skipped: validated.skipped,
    dedupedEmail: deduped.filter((p) => p.dedupe === "email").length,
    dedupedName: deduped.filter((p) => p.dedupe === "name").length,
    verified: fresh.filter((p) => p.emailConfidence === "verified").length,
    likely: fresh.filter((p) => p.emailConfidence === "likely").length,
    noEmail: fresh.filter((p) => p.emailConfidence === "none").length,
    missingColumns: map.missing,
  };

  await updateProspectRun(db, run.id, { stage: "ready", counts, error: null });
}

// ---------------------------------------------------------------------------
// GET: poll, restore, export
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB, ORIGAMI_API_KEY, ORIGAMI_PROJECT_ID } = ctx;
  const user = await requireUser(request, ctx);

  const url = new URL(request.url);
  const runId = asString(url.searchParams.get("run"));
  const wantsCsv = url.searchParams.get("format") === "csv";

  try {
    const limit = await rateLimit(DB, PROSPECT_POLL_RULE, user.email);
    if (!limit.allowed) {
      return json(
        { ok: false, error: `Slow down for ${limit.retryAfterSeconds}s.` },
        429,
      );
    }

    // No run named: restore whatever this viewer was last looking at. Called
    // when the panel opens, which is why it is not in the contacts-page loader —
    // most visits never open the panel and shouldn't pay for these queries.
    const anchorId = runId || (await latestProspectRun(DB, user.email))?.id || "";
    if (!anchorId) {
      return json({ ok: true, running: false, turns: [], configured: !!ORIGAMI_API_KEY });
    }

    if (wantsCsv) return csvResponse(DB, anchorId, user.email);

    // Scoped by created_by, so one viewer cannot poll another's run.
    let runs = await listProspectThread(DB, anchorId, user.email);
    if (!runs.length) {
      return json({ ok: true, running: false, turns: [], configured: !!ORIGAMI_API_KEY });
    }

    // Only the newest run can be mid-flight: an agent does one at a time.
    const active = runs[runs.length - 1];
    if (ORIGAMI_API_KEY && active.stage !== "ready" && active.stage !== "failed") {
      const client = createOrigamiClient(ORIGAMI_API_KEY, ORIGAMI_PROJECT_ID);
      await advanceRun(DB, client, active, Date.now());
      runs = await listProspectThread(DB, anchorId, user.email);
    }

    const payload = await threadPayload(DB, runs, Date.now());
    return json({ ...payload, configured: !!ORIGAMI_API_KEY });
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names, and this value renders straight into the UI.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[prospect:loader] ref=${ref}`, err);
    return json({ ok: false, error: `Something went wrong. Reference: ${ref}` }, 500);
  }
}

/**
 * Export the run's staged rows.
 *
 * Ours, not a proxy of Origami's own `?format=csv`: these are the mapped,
 * deduped rows the user is actually looking at, and building the file here keeps
 * output escaping in csvCell with the rest of it. That escaping is not
 * decoration — a scraped company name beginning `=` is a formula Excel and
 * Sheets will execute.
 */
async function csvResponse(db: D1Database, runId: string, viewerEmail: string) {
  const runs = await listProspectThread(db, runId, viewerEmail);
  if (!runs.length) return json({ ok: false, error: "That run no longer exists." }, 404);

  const prospects = await listProspects(db, runId);
  const header = ["Name", "Title", "Company", "Email", "Email confidence", "LinkedIn", "Location", "Source"];
  const lines = [header.join(",")];
  for (const p of prospects) {
    if (p.dedupe) continue;
    lines.push(
      [
        p.name,
        p.title ?? "",
        p.company ?? "",
        p.email ?? "",
        p.emailConfidence,
        p.linkedin ?? "",
        p.location ?? "",
        p.sourceUrl ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="prospects.csv"`,
    },
  });
}

// ---------------------------------------------------------------------------
// POST: start, promote, cancel
// ---------------------------------------------------------------------------

/**
 * `runId` rides on the failure variant too, and it is load-bearing: a run whose
 * provider call failed still has a row, and the panel needs its id to show the
 * failed turn in the thread rather than dropping the brief the user just typed.
 */
type ActionResult =
  | { ok: true; runId?: string; message?: string }
  | { ok: false; error: string; runId?: string };

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  const ctx = context.get(appContext);
  const { DB, ORIGAMI_API_KEY, ORIGAMI_PROJECT_ID } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const intent = asString(form.get("intent"));

  try {
    // Same order as /smartlead's action: authenticate, meter, check config,
    // then construct the client. Promotion is metered on the loose bucket
    // because it never reaches Origami; only starting a run spends credits.
    const rule = intent === "startRun" ? PROSPECT_RUN_RULE : PROSPECT_POLL_RULE;
    const limit = await rateLimit(DB, rule, user.email);
    if (!limit.allowed) {
      return json<ActionResult>({
        ok: false,
        error:
          intent === "startRun"
            ? `That's a lot of research. Try again in ${limit.retryAfterSeconds}s.`
            : `Too many requests. Try again in ${limit.retryAfterSeconds}s.`,
      });
    }

    switch (intent) {
      case "startRun":
        return startRun(DB, form, user, ORIGAMI_API_KEY, ORIGAMI_PROJECT_ID);
      case "promote":
        return promote(DB, form, user.email);
      case "cancel":
        return cancel(DB, form, user.email, ORIGAMI_API_KEY, ORIGAMI_PROJECT_ID);
      default:
        return json<ActionResult>({ ok: false, error: "Unknown action." });
    }
  } catch (err) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[prospect:${intent}] ref=${ref}`, err);
    return json<ActionResult>({ ok: false, error: `Something went wrong. Reference: ${ref}` });
  }
}

/**
 * Start a run, or send a follow-up on an existing thread.
 *
 * The row is written BEFORE the provider call, so a run whose POST never
 * returned still has a record explaining itself rather than vanishing. The
 * Idempotency-Key is our own row id: Origami replays the first response for 24
 * hours, so a double-submit cannot start (or bill) two runs.
 */
async function startRun(
  db: D1Database,
  form: FormData,
  user: { email: string; name: string },
  apiKey: string,
  projectId: string,
): Promise<Response> {
  const parsed = validateProspectPrompt(form.get("prompt"));
  if (!parsed.ok) return json<ActionResult>({ ok: false, error: parsed.error });

  if (!apiKey) {
    return json<ActionResult>({
      ok: false,
      error: "Origami isn't connected. Set the ORIGAMI_API_KEY secret.",
    });
  }

  // An Origami agent runs one at a time and the org's concurrent pool is as
  // small as one on a starter plan. Catching this here costs a read; losing the
  // race costs a 429 and a confusing message.
  //
  // But a run in this table is only evidence that one was STARTED. Nothing
  // advances it except a poll, so a browser closed mid-run, a lost tab or a bug
  // in the panel leaves a row that is "in flight" forever and locks the feature
  // permanently. Anything that has not moved in STALE_RUN_MS is therefore closed
  // out rather than believed — Origami's own runs finish in one to five minutes,
  // so this is generous by a wide margin.
  const inFlight = await findRunningProspectRun(db, user.email);
  if (inFlight) {
    const lastMoved = inFlight.updatedAtMs ?? inFlight.createdAtMs ?? 0;
    if (Date.now() - lastMoved < STALE_RUN_MS) {
      return json<ActionResult>({
        ok: false,
        error: "A run is already going. Wait for it to finish, or cancel it, before starting another.",
        // Named so the panel can show the run that is in the way. Without this
        // the user gets a refusal and no route to the thing refusing them.
        runId: inFlight.id,
      });
    }
    await updateProspectRun(db, inFlight.id, {
      status: "timed_out",
      stage: "failed",
      nextPollAt: null,
      error: "This run stopped reporting progress and was closed out.",
    });
  }

  // A follow-up continues the same agent, which keeps its workspace and
  // conversation — that is how a needs_input question gets answered, and how a
  // run that stopped early is resumed.
  const threadRunId = asString(form.get("runId"));
  let agentId: string | null = null;
  let previousRunId: string | null = null;
  if (threadRunId) {
    const thread = await listProspectThread(db, threadRunId, user.email);
    const last = thread[thread.length - 1];
    if (last?.agentId) {
      agentId = last.agentId;
      previousRunId = last.id;
    }
  }

  const runId = await createProspectRun(db, {
    prompt: parsed.prompt,
    agentId,
    previousRunId,
    createdBy: user.email,
    createdByName: user.name,
  });

  const client = createOrigamiClient(apiKey, projectId);
  // Composed server-side from the stored prompt, so the client cannot replace
  // the column contract — the same reason triggerAgent builds its payload from
  // stored data rather than from the form.
  const brief = composeBrief(parsed.prompt);

  const res: OrigamiResult<OrigamiAgentCreated> = agentId
    ? await client.sendRun(agentId, brief, runId)
    : await client.createAgent(brief, runId);

  if (!res.ok) {
    const error = friendlyProviderError(res);
    await updateProspectRun(db, runId, { status: "errored", stage: "failed", error });
    return json<ActionResult>({ ok: false, error, runId });
  }

  // POST /agents answers with { agent, run }; POST /agents/{id}/runs answers
  // with the run alone. Both are read defensively — this is the one response
  // whose shape we cannot re-request, and the v2 API is documented as beta.
  const payload: OrigamiAgentCreated = res.data ?? {};
  const resolvedAgent =
    agentId || asString(payload.agent?.id) || asString(payload.agentId) || null;
  const runObject: OrigamiRun = payload.run ?? payload;
  const providerRunId = asString(runObject?.id) || null;

  if (!resolvedAgent || !providerRunId) {
    const error = "Origami started the run but didn't say where to find it.";
    await updateProspectRun(db, runId, { status: "errored", stage: "failed", error });
    return json<ActionResult>({ ok: false, error, runId });
  }

  await updateProspectRun(db, runId, {
    agentId: resolvedAgent,
    providerRunId,
    status: isValidProspectStatus(runObject?.status) ? runObject.status : "running",
    stage: "researching",
    // First poll is due immediately: the run may already be terminal by the time
    // the panel asks, and their Retry-After only appears on the poll response.
    nextPollAt: null,
  });

  return json<ActionResult>({ ok: true, runId });
}

/**
 * Add the ticked prospects to the CRM.
 *
 * Goes through validateImportRows + createManyContacts — the SAME path a CSV
 * import uses — rather than a bespoke insert. That is what makes the email
 * check, the owner and status whitelists, the per-row skip and the batched write
 * behave identically here, and it means a change to import rules cannot forget
 * this caller.
 */
async function promote(db: D1Database, form: FormData, viewerEmail: string): Promise<Response> {
  const runId = asString(form.get("runId"));
  if (!runId) return json<ActionResult>({ ok: false, error: "Missing run." });

  const thread = await listProspectThread(db, runId, viewerEmail);
  if (!thread.length) return json<ActionResult>({ ok: false, error: "That run no longer exists." });

  const ids = validateIds(parseJson(form.get("ids")));
  if (!ids.ok) return json<ActionResult>({ ok: false, error: ids.error });
  if (ids.ids.length > MAX_PROMOTE) {
    return json<ActionResult>({
      ok: false,
      error: `Too many at once: ${ids.ids.length}. The maximum is ${MAX_PROMOTE}.`,
    });
  }

  const loopRaw = Number(form.get("loop"));
  const loop = isValidLoop(loopRaw) ? loopRaw : 1;
  const ownerRaw = asString(form.get("owner"));
  const owner = ownerRaw && ownerRaw !== "Unassigned" && isValidOwner(ownerRaw) ? ownerRaw : null;
  const sourceRaw = asString(form.get("source")).slice(0, LIMITS.source);
  // A Loop 2 contact's source is the community or event it came from. Loop 1 has
  // no such origin, so a source typed there is dropped rather than stored as a
  // label that means nothing on that side of the app.
  const source = loop === 2 && sourceRaw ? sourceRaw : null;

  const wanted = new Set(ids.ids);
  const selected = (await listProspects(db, runId)).filter(
    // Already-promoted rows are skipped, not rejected: that is what makes a
    // second click a no-op instead of a duplicate contact.
    (p) => wanted.has(p.id) && !p.promotedContactId && !p.dedupe,
  );
  if (!selected.length) {
    return json<ActionResult>({ ok: false, error: "Those prospects were already added." });
  }

  const rows = validateImportRows(
    selected.map((p: Prospect) => toContactRow(p, { loop, owner, source })),
  );
  if (!rows.ok) return json<ActionResult>({ ok: false, error: rows.error });

  const added = await createManyContacts(db, rows.rows);
  await markProspectsPromoted(db, runId, selected.map((p) => p.id));

  return json<ActionResult>({
    ok: true,
    runId,
    message:
      `Added ${added} to Loop ${loop}.` +
      (rows.skipped ? ` Skipped ${rows.skipped} that couldn't be imported.` : ""),
  });
}

/** Stop the agent's current run. Whatever it built so far is kept. */
async function cancel(
  db: D1Database,
  form: FormData,
  viewerEmail: string,
  apiKey: string,
  projectId: string,
): Promise<Response> {
  const runId = asString(form.get("runId"));
  const thread = await listProspectThread(db, runId, viewerEmail);
  const run = thread[thread.length - 1];
  if (!run) return json<ActionResult>({ ok: false, error: "That run no longer exists." });

  if (apiKey && run.agentId) {
    const res = await createOrigamiClient(apiKey, projectId).cancelRun(run.agentId);
    if (!res.ok) return json<ActionResult>({ ok: false, error: friendlyProviderError(res) });
  }

  // Marked cancelled locally either way. If the provider call was skipped
  // because the key is gone, the run is unreachable regardless, and leaving it
  // "running" would block every future start behind hasRunningProspectRun.
  await updateProspectRun(db, run.id, {
    status: "cancelled",
    // Not "failed": Origami keeps whatever a cancelled run built, so a table it
    // already produced is still worth reading.
    stage: run.tableId ? "reading" : "ready",
    nextPollAt: null,
  });
  return json<ActionResult>({ ok: true, runId: run.id, message: "Run cancelled." });
}

function parseJson(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse((value ?? "null").toString());
  } catch {
    return null;
  }
}
