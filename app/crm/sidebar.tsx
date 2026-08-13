// The CRM's left rail, shared by the contacts, analytics and templates pages.
//
// Imports only ./data, ./ui and react-router — deliberately NOT sales-loop-crm.tsx,
// so /analytics doesn't pull that whole module into its bundle.
//
// The two pages hold their own filter state (each has a different amount of it),
// so this component is purely presentational: callers pass tab descriptors built
// with buildViewTabs/buildOwnerTabs and handle the clicks themselves. That split
// matters — the contacts page's setView also resets its Loop 2 source filter, a
// concern the sidebar must not own.

import { Form, Link } from "react-router";
import type { Contact, Viewer } from "./data";
import { OWNERS } from "./data";
import { Box, IconBoard, IconChart, IconContacts, IconMail, MONO, css } from "./ui";

export type SidebarTab = {
  key: string;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** VIEWS rows: the 8px colour square. */
  dot?: string;
  /** OWNER rows: the 18px initial square. Both set, or neither. */
  avatarColor?: string;
  avatarInitial?: string;
};

const tabBtn = (active: boolean) =>
  `display:flex;align-items:center;justify-content:space-between;width:100%;padding:7px 8px;border:none;background:${active ? "#eeeee9" : "none"};border-radius:8px;font-size:13px;font-weight:${active ? "500" : "450"};color:${active ? "#1a1a1a" : "#575753"};cursor:pointer;font-family:inherit;margin-bottom:1px;`;

/**
 * VIEWS rows. Counts are over the FULL contact list, not the filtered one — the
 * rail reports what each filter would yield, so it must not be filtered itself.
 * Loop 1 and Loop 2 overlap: a contact resumed into Loop 1 counts in both.
 *
 * `counts` overrides what each row reports, and `labels` what the "all" row is
 * called. /templates passes both, because there these rows filter templates, not
 * contacts — a row reading "Loop 1 · 21" beside a list of three templates would
 * be telling the user something untrue. The other two pages omit them and keep
 * the contact counts.
 */
export function buildViewTabs(
  contacts: Contact[],
  active: string,
  onSelect: (key: string) => void,
  counts?: { all: number; loop1: number; loop2: number },
  allLabel = "All contacts",
): SidebarTab[] {
  return [
    {
      key: "all",
      label: allLabel,
      dot: "#c4c4be",
      count: counts ? counts.all : contacts.length,
    },
    {
      key: "loop1",
      label: "Loop 1",
      dot: "#9a9a95",
      count: counts ? counts.loop1 : contacts.filter((c) => c.loops.includes(1)).length,
    },
    {
      key: "loop2",
      label: "Loop 2",
      dot: "#e0930a",
      count: counts ? counts.loop2 : contacts.filter((c) => c.loops.includes(2)).length,
    },
  ].map((t) => ({ ...t, active: active === t.key, onClick: () => onSelect(t.key) }));
}

/** OWNER rows. Same full-list rule as buildViewTabs. */
export function buildOwnerTabs(
  contacts: Contact[],
  active: string,
  onSelect: (key: string) => void,
): SidebarTab[] {
  return [
    { key: "all", label: "Everyone", count: contacts.length },
    {
      key: "Tom",
      label: "Tom",
      count: contacts.filter((c) => c.owner === "Tom").length,
      avatarColor: OWNERS.Tom.color,
      avatarInitial: OWNERS.Tom.initial,
    },
    {
      key: "Britton",
      label: "Britton",
      count: contacts.filter((c) => c.owner === "Britton").length,
      avatarColor: OWNERS.Britton.color,
      avatarInitial: OWNERS.Britton.initial,
    },
    {
      key: "unassigned",
      label: "Unassigned",
      count: contacts.filter((c) => !c.owner).length,
    },
  ].map((o) => ({ ...o, active: active === o.key, onClick: () => onSelect(o.key) }));
}

function SidebarRow({ tab }: { tab: SidebarTab }) {
  return (
    <Box
      as="button"
      onClick={tab.onClick}
      style={css(tabBtn(tab.active))}
      hover={css("background:#f0f0ec;")}
    >
      <span style={css("display:flex; align-items:center; gap:9px;")}>
        {tab.dot && (
          <span style={css(`width:8px; height:8px; border-radius:3px; background:${tab.dot};`)} />
        )}
        {tab.avatarColor && tab.avatarInitial && (
          <span
            style={css(
              `width:18px; height:18px; border-radius:5px; background:${tab.avatarColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600;`,
            )}
          >
            {tab.avatarInitial}
          </span>
        )}
        <span>{tab.label}</span>
      </span>
      <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{tab.count}</span>
    </Box>
  );
}

// Stacked vertically rather than as a segmented control: with four destinations
// a `flex:1` row compresses each to a quarter of 212px, which truncates
// "Analytics" and "Lifecycle".
//
// The `border:1px solid transparent` is load-bearing — the active state adds a
// real 1px border, and without a transparent one on the inactive state every item
// jumps 2px as you navigate between pages.
const NAV_ITEM =
  "width:100%; display:flex; align-items:center; justify-content:flex-start; gap:8px; padding:6px 9px; border:1px solid transparent; border-radius:8px; font-size:12.5px; text-decoration:none; font-family:inherit;";

function NavLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  // The active item is a span, not a Link: there is nothing to navigate to, and
  // the non-interactive element is the de facto "you are here" marker.
  if (active) {
    return (
      <span
        style={css(
          NAV_ITEM +
            "background:#fff; border-color:#e6e6e2; color:#1a1a1a; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.06);",
        )}
      >
        {children}
        {label}
      </span>
    );
  }
  return (
    <Box
      as={Link}
      to={to}
      style={css(NAV_ITEM + "background:none; color:#75756f; font-weight:450;")}
      hover={css("color:#3a3a38; background:#f2f2ee;")}
    >
      {children}
      {label}
    </Box>
  );
}

export function Sidebar({
  nav,
  viewTabs,
  ownerTabs,
  viewer,
  ownerNote,
}: {
  nav: "contacts" | "lifecycle" | "analytics" | "templates";
  viewTabs: SidebarTab[];
  ownerTabs: SidebarTab[];
  viewer: Viewer;
  /**
   * Optional caption under the OWNER group. /templates passes one because its
   * owner rows are inert there — an unexplained control that does nothing when
   * clicked is what generates bug reports.
   */
  ownerNote?: string;
}) {
  return (
    <aside
      style={css(
        "width:236px; flex:0 0 236px; border-right:1px solid #ededea; background:#fbfbfa; display:flex; flex-direction:column; padding:16px 12px;",
      )}
    >
      <div style={css("display:flex; align-items:center; gap:9px; padding:4px 8px 16px 8px;")}>
        <div
          style={css(
            "width:24px; height:24px; border-radius:6px; background:#1a1a1a; color:#fff; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600;",
          )}
        >
          M
        </div>
        <div style={css("font-size:14px; font-weight:600; letter-spacing:-0.01em;")}>
          Match Book CRM
        </div>
      </div>

      <div style={css("display:flex; flex-direction:column; gap:2px; margin:0 0 8px;")}>
        <NavLink to="/" label="Contacts" active={nav === "contacts"}>
          <IconContacts style={css("width:13px; height:13px;")} />
        </NavLink>
        <NavLink to="/analytics" label="Analytics" active={nav === "analytics"}>
          <IconChart style={css("width:13px; height:13px;")} />
        </NavLink>
        <NavLink to="/lifecycle" label="Lifecycle" active={nav === "lifecycle"}>
          <IconBoard style={css("width:13px; height:13px;")} />
        </NavLink>
        <NavLink to="/templates" label="Templates" active={nav === "templates"}>
          <IconMail style={css("width:13px; height:13px;")} />
        </NavLink>
      </div>

      <div
        style={css(
          "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; padding:8px 8px 6px;",
        )}
      >
        Views
      </div>
      {viewTabs.map((tab) => (
        <SidebarRow key={tab.key} tab={tab} />
      ))}

      <div
        style={css(
          "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; padding:18px 8px 6px;",
        )}
      >
        Owner
      </div>
      {ownerTabs.map((tab) => (
        <SidebarRow key={tab.key} tab={tab} />
      ))}
      {ownerNote && (
        <div style={css("padding:6px 8px 0; font-size:11px; color:#a3a39d; line-height:1.45;")}>
          {ownerNote}
        </div>
      )}

      {/* margin-top:auto pins the footer — nothing may be appended below it. */}
      <div
        style={css(
          "margin-top:auto; padding:12px 8px 10px; border-top:1px solid #ededea; font-size:11px; color:#a3a39d; line-height:1.5;",
        )}
      >
        <div>
          <span style={css("color:#575753;")}>Loop 1</span> · always-on outbound
        </div>
        <div>
          <span style={css("color:#b45309;")}>Loop 2</span> · event/community blitz
        </div>
      </div>

      {/* /logout is its own route with its own action, so this keeps working on a
          page (like analytics) that defines no action of its own. */}
      <div
        style={css(
          "display:flex; align-items:center; gap:8px; padding:10px 8px 2px; border-top:1px solid #ededea;",
        )}
      >
        <span
          style={css(
            `width:20px; height:20px; border-radius:6px; background:${viewer.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto;`,
          )}
        >
          {viewer.initial}
        </span>
        <span
          style={css(
            "font-size:12px; font-weight:500; color:#575753; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
          )}
        >
          {viewer.name}
        </span>
        <Form method="post" action="/logout">
          <Box
            as="button"
            type="submit"
            title="Sign out"
            style={css(
              "background:none; border:none; padding:3px 6px; border-radius:6px; font-size:11px; font-family:inherit; color:#a3a39d; cursor:pointer;",
            )}
            hover={css("background:#f0f0ec; color:#575753;")}
          >
            Sign out
          </Box>
        </Form>
      </div>
    </aside>
  );
}
