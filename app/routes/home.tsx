import type { Route } from "./+types/home";
import { SalesLoopCRM } from "../crm/sales-loop-crm";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  createSavedView,
  deleteSavedView,
  listContacts,
  listDeals,
  listSavedViews,
  listUnreadReplies,
} from "../lib/crm.server";
import { handleContactIntent } from "../lib/contact-intents.server";
import { rateLimit, UNIPILE_SYNC_RULE } from "../lib/ratelimit.server";
import { syncReplies } from "../lib/unipile-sync.server";
import { MAX_SAVED_VIEWS, UNIPILE_STRIP_LIMIT, validateSavedView } from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sales Loop CRM" },
    {
      name: "description",
      content: "Two-loop outbound CRM: queue, contacts, and touchpoint history.",
    },
  ];
}

export const links = crmFontLinks;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Throws a redirect to /login when there's no valid, allowlisted session.
  const user = await requireUser(request, ctx);
  // Resolve the avatar server-side so the UI renders purely from loader data.
  const avatar = ownerAvatar(user.name);
  // One instant for every relative figure on the page, so the contact rows and
  // the reply cards can't disagree about what "today" is.
  const now = Date.now();
  try {
    // Saved views are read per-viewer: shared ones plus this user's private ones.
    // Deals are read here purely to power the detail panel's "Also at [Company]"
    // block. It is a small table and the panel needs whichever company the user
    // happens to click, which the loader cannot know — so the whole set comes
    // down once rather than a round trip per panel open.
    const [contacts, savedViews, deals, replies] = await Promise.all([
      listContacts(DB, now),
      listSavedViews(DB, user.email),
      listDeals(DB),
      // The New replies strip. Read here rather than fetched by the client so it
      // renders with the first paint like everything else on this page — and so
      // the relative "2d ago" on a card comes from the same `now` the contact
      // rows use. NO Unipile call: this is D1 only, and pulling new replies is
      // the Sync button's job.
      listUnreadReplies(DB, now, UNIPILE_STRIP_LIMIT),
    ]);
    return {
      contacts,
      savedViews,
      deals,
      replies,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it. A throw here usually means the D1 schema is missing/outdated
    // (run `npm run db:migrate:remote` to apply pending migrations).
    console.error("[loader] failed to load contacts:", err);
    throw err;
  }
}

/**
 * `savedViewId` is returned by a successful createSavedView so the client can
 * select the view it just made — guessing "the newest one" from the revalidated
 * loader would race a concurrent save by one of the other users. It also acts as
 * the discriminator that tells the client's settle effect this success was a view
 * save and not some unrelated intent. Same device as /templates' `templateId`.
 *
 * `syncMessage` is the same device again, for the same reason. A sync's outcome
 * is a sentence that has to be shown ("6 new replies, 2 moved to Replied, 3 from
 * people not in the CRM"), and the client's settle effect routes results by
 * which optional field is present — a plain `message` there already means
 * "an import partially failed, hold the modal open", so reusing it would open
 * the CSV modal on a successful sync.
 */
type ActionResult =
  | { ok: true; message?: string; savedViewId?: string; syncMessage?: string }
  | { ok: false; error: string };

function parseJson(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse((value ?? "null").toString());
  } catch {
    return null;
  }
}

/**
 * Contact intents live in ../lib/contact-intents.server.ts, shared with /lifecycle
 * so the detail slide-over behaves identically wherever it is rendered.
 *
 * The two saved-view intents are handled here rather than there on purpose: a
 * saved view is page configuration, not a contact write, and only this page
 * renders the builder. `handleContactIntent` returns null for an intent it does
 * not know precisely so a route can layer its own around it — see its docblock.
 * They carry their own try/catch because that helper's is internal to it, so an
 * error here would otherwise escape and hand the client D1's table and column
 * names.
 */
export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  try {
    switch (intent) {
      case "createSavedView": {
        const result = validateSavedView({
          name: form.get("name")?.toString(),
          shared: form.get("shared")?.toString(),
          conditions: parseJson(form.get("conditions")),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const created = await createSavedView(DB, result.value, {
          email: user.email,
          name: user.name,
        });
        if (!created.ok) {
          return { ok: false, error: `You can save up to ${MAX_SAVED_VIEWS} views.` };
        }
        return { ok: true, savedViewId: created.id };
      }
      /**
       * Pull new replies from Unipile.
       *
       * Layered here, around handleContactIntent, for the same reason the two
       * saved-view intents are: this reaches a third party under a live key and
       * needs its own rate limit, neither of which belongs in a helper whose
       * whole contract is "contact writes against D1". The two reply intents
       * that ARE pure D1 writes (marking a card read) do live in that helper,
       * so /lifecycle gets them for free.
       *
       * /settings runs the identical operation through the same module. The
       * button is on both pages because the strip is where a reply is noticed
       * and settings is where the connection is managed.
       */
      case "syncReplies": {
        const limit = await rateLimit(DB, UNIPILE_SYNC_RULE, user.email);
        if (!limit.allowed) {
          return {
            ok: false,
            error: `Too many syncs. Try again in ${limit.retryAfterSeconds}s.`,
          };
        }
        const res = await syncReplies(DB, {
          apiKey: ctx.UNIPILE_API_KEY,
          dsn: ctx.UNIPILE_DSN,
          actor: user.name,
        });
        if (!res.ok) return { ok: false, error: res.error };
        // Per-account failures are appended rather than swallowed: one dead
        // LinkedIn session among four healthy mailboxes would otherwise produce
        // a cheerful banner about the mailboxes alone.
        const failures = res.summary.failures.length
          ? ` ${res.summary.failures.join(" ")}`
          : "";
        return { ok: true, syncMessage: res.summary.message + failures };
      }
      case "deleteSavedView": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing view id." };
        const removed = await deleteSavedView(DB, id, user.email, user.name);
        if (!removed) return { ok: false, error: "That view no longer exists." };
        return { ok: true };
      }
    }
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names, and this value is rendered straight into the
    // UI — the reference id ties the two together.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }

  const result = await handleContactIntent(form, {
    DB,
    user,
    HYPERAGENT_TRIGGER_URL: ctx.HYPERAGENT_TRIGGER_URL,
    HYPERAGENT_API_KEY: ctx.HYPERAGENT_API_KEY,
  });
  return result ?? { ok: false, error: "Unknown action." };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <SalesLoopCRM
      contacts={loaderData.contacts}
      savedViews={loaderData.savedViews}
      deals={loaderData.deals}
      replies={loaderData.replies}
      viewer={loaderData.viewer}
    />
  );
}
