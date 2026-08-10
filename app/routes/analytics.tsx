import type { Route } from "./+types/analytics";
import { AnalyticsPage } from "../crm/analytics-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import { buildAnalyticsLabels, listContacts } from "../lib/crm.server";

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
    return {
      contacts: await listContacts(DB, now),
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
      labels: buildAnalyticsLabels(now),
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
    />
  );
}
