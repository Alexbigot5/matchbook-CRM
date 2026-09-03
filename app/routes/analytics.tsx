import type { Route } from "./+types/analytics";
import { AnalyticsPage } from "../crm/analytics-page";
import { appContext } from "../../load-context";
import type { CampaignLoopInput, CampaignStepInput } from "../crm/campaigns";
import { ownerAvatar } from "../crm/data";
import { buildSequencePlan, type StoredSequenceStep } from "../crm/smartlead-map";
import type { EmailTemplate } from "../crm/templates";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  buildAnalyticsLabels,
  countPushedLeadsByCampaign,
  getCampaignBindings,
  listContacts,
  listSequenceStepsByLoop,
  listTemplates,
  type CampaignBinding,
} from "../lib/crm.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Analytics · Sales Loop CRM" },
    {
      name: "description",
      content: "Pipeline, channel and source performance across both sales loops.",
    },
  ];
}

// Same webfonts as the contacts page. The root route loads Inter, so without this
// the page renders in the wrong typeface and every mono figure falls back.
export const links = crmFontLinks;

/** The two loops, in the order the Email campaigns tab offers them. */
const LOOPS = [1, 2] as const;

/**
 * Resolve one loop's sequence into the shape app/crm/campaigns.ts aggregates.
 *
 * The plan is built by the SAME buildSequencePlan() that /smartlead uploads with
 * and that the stats sync replays to attribute numbers — reading it here rather
 * than re-deriving an order means this tab can never disagree with what was sent.
 * A loop with no authored steps still yields the derived plan, which is exactly
 * what the Smartlead page shows it.
 *
 * Counters are summed over the slots the step actually uploads: one variant for a
 * pinned step, every slot with copy for an A/B split. That is the same grouping
 * the stats sync writes them back under, so nothing is double-counted here — but
 * note the sync's own caveat (see CLAUDE.md, "A single Smartlead step can't be
 * split per variant"): an A/B step gets no figures written at all, so it reads as
 * zeroes rather than as a mixture.
 *
 * Deliberately NOT a Smartlead call. This loader reaches no third party, for the
 * reason /smartlead's does not: a page that 500s whenever a vendor is down is
 * worse than a page showing what was last synced.
 */
function buildLoopInput(
  loop: number,
  templates: EmailTemplate[],
  storedSteps: StoredSequenceStep[] | undefined,
  binding: CampaignBinding | undefined,
  leadCounts: Record<string, number>,
): CampaignLoopInput {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const plan = buildSequencePlan(templates, loop, storedSteps);

  const steps: CampaignStepInput[] = plan.included.map((row) => {
    const template = byId.get(row.templateId);
    const uploaded = new Set(row.slots);
    const variants = (template?.variants ?? []).filter((v) => uploaded.has(v.slot));
    const sum = (pick: (v: (typeof variants)[number]) => number) =>
      variants.reduce((n, v) => n + pick(v), 0);
    return {
      seqNumber: row.seqNumber,
      templateId: row.templateId,
      name: row.name,
      variantSlot: row.variantSlot,
      slots: row.slots,
      dayOffset: row.dayOffset,
      subject: row.preview[0]?.subject ?? "",
      sends: sum((v) => v.sends),
      opens: sum((v) => v.opens),
      replies: sum((v) => v.replies),
      meetings: sum((v) => v.meetings),
    };
  });

  return {
    loop,
    campaignName: binding ? binding.campaignName || `Campaign ${binding.campaignId}` : null,
    leadsPushed: binding ? (leadCounts[binding.campaignId] ?? 0) : 0,
    sequencePushedLabel: binding?.sequencePushedLabel ?? null,
    leadsPushedLabel: binding?.leadsPushedLabel ?? null,
    statsSyncedLabel: binding?.statsSyncedLabel ?? null,
    steps,
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Gating is per-route, so this page needs its own check.
  const user = await requireUser(request, ctx);
  const avatar = ownerAvatar(user.name);
  // One reference instant for both the contact date math and the chart's axis —
  // they have to agree on where "today" starts.
  const now = Date.now();
  try {
    const [contacts, templates, bindings, stepsByLoop, leadCounts] = await Promise.all([
      listContacts(DB, now),
      listTemplates(DB, now),
      getCampaignBindings(DB, now),
      listSequenceStepsByLoop(DB),
      countPushedLeadsByCampaign(DB),
    ]);
    return {
      contacts,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
      labels: buildAnalyticsLabels(now),
      campaigns: LOOPS.map((loop) =>
        buildLoopInput(loop, templates, stepsByLoop[loop], bindings[loop], leadCounts),
      ),
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it, and a throw here usually means pending D1 migrations.
    console.error("[loader] failed to load analytics:", err);
    throw err;
  }
}

// No action: this page is read-only. Writes happen on the contacts page.
export default function Analytics({ loaderData }: Route.ComponentProps) {
  return (
    <AnalyticsPage
      contacts={loaderData.contacts}
      viewer={loaderData.viewer}
      labels={loaderData.labels}
      campaigns={loaderData.campaigns}
    />
  );
}
