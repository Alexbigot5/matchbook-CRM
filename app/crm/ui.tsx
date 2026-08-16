import { useState } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";

function kebabToCamel(s: string) {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Document-level CSS for the CRM shell. Both pages render it into an inline
// <style>, so it lives here rather than in either page component — importing it
// from sales-loop-crm.tsx would pull that whole module into the analytics bundle.
export const GLOBAL_CSS = `
  .slcrm * { box-sizing: border-box; }
  .slcrm { font-family: 'Geist', system-ui, sans-serif; color: #1a1a1a; -webkit-font-smoothing: antialiased; }
  .slcrm ::-webkit-scrollbar { width: 10px; height: 10px; }
  .slcrm ::-webkit-scrollbar-thumb { background: #e2e2df; border-radius: 6px; border: 3px solid #fff; }
  .slcrm ::-webkit-scrollbar-thumb:hover { background: #d0d0cd; }
  @keyframes slcrm-slideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes slcrm-fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slcrm-slideDown { from { transform: translateY(-12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;

// Prefix for every numeric in the CRM. GLOBAL_CSS only sets the sans stack.
export const MONO = "font-family:'Geist Mono',monospace;";

// The webfonts GLOBAL_CSS and MONO reference. Every route rendering the CRM shell
// must re-export this as its own `links()` — the root route loads Inter, so a page
// that forgets this silently renders in the wrong typeface with no mono at all.
export function crmFontLinks() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap",
    },
  ];
}

// Parse an inline CSS string (as used throughout the original template) into a
// React style object, so ported markup can keep its style strings verbatim.
export function css(style: string): CSSProperties {
  const o: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    o[prop.startsWith("--") ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim();
  }
  return o as CSSProperties;
}

type BoxProps = {
  // Any element type, not just intrinsic tags — the sidebar renders `as={Link}`
  // so a router link can carry the same hover styling as everything else.
  as?: ElementType;
  hover?: CSSProperties;
  focus?: CSSProperties;
  style?: CSSProperties;
  children?: ReactNode;
} & Record<string, any>;

// Replaces the original template's `style-hover` / `style-focus` pseudo-class
// attributes by merging the extra styles while hovered/focused.
export function Box({
  as = "div",
  hover,
  focus,
  style,
  children,
  ...rest
}: BoxProps) {
  const [isHover, setHover] = useState(false);
  const [isFocus, setFocus] = useState(false);
  const Tag = as as any;
  const merged: CSSProperties = {
    ...style,
    ...(isHover && hover ? hover : {}),
    ...(isFocus && focus ? focus : {}),
  };
  const handlers: Record<string, any> = {};
  if (hover) {
    handlers.onMouseEnter = (e: any) => {
      setHover(true);
      rest.onMouseEnter?.(e);
    };
    handlers.onMouseLeave = (e: any) => {
      setHover(false);
      rest.onMouseLeave?.(e);
    };
  }
  if (focus) {
    handlers.onFocus = (e: any) => {
      setFocus(true);
      rest.onFocus?.(e);
    };
    handlers.onBlur = (e: any) => {
      setFocus(false);
      rest.onBlur?.(e);
    };
  }
  const isVoid = as === "input";
  return isVoid ? (
    <Tag style={merged} {...rest} {...handlers} />
  ) : (
    <Tag style={merged} {...rest} {...handlers}>
      {children}
    </Tag>
  );
}

export function IconSearch({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function IconUpload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M12 15V4m0 0L8 8m4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
// `size`/`style` are optional additions, so no existing call site changes — the
// templates page's compact "+ New" button needs a smaller glyph than 15px.
export function IconPlus({ size = 15, style }: { size?: number; style?: CSSProperties } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
export function IconFilter({ size = 15, style }: { size?: number; style?: CSSProperties } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
export function IconSave({ size = 15, style }: { size?: number; style?: CSSProperties } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 4v5h7V4M8 20v-5h8v5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
export function IconPencil({ size = 15, style }: { size?: number; style?: CSSProperties } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14.5 7.5 16.5 9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function IconWarn({ size = 15, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M12 8v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.1" fill="currentColor" />
      <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
export function IconChevronDown({ style }: { style?: CSSProperties }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={style}>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconCheck({ style }: { style?: CSSProperties }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={style}>
      <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconClose({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function IconTrash({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function IconContacts({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function IconChart({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M5 19V11M12 19V5M19 19v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
// Same envelope geometry as CH.email.icon in ./data.ts, so the Templates nav
// glyph and the Email channel chip read as the same object.
export function IconMail({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="m4 8 8 5.5L20 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
// Kanban board glyph for the Lifecycle nav item. Three columns of differing
// height — deliberately distinct from IconChart, which is also vertical bars but
// grounded on a common baseline.
export function IconBoard({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="4" width="5" height="12" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="10" y="4" width="5" height="16" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="17" y="4" width="4" height="8" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

// Paper plane for the Smartlead nav item. An envelope would collide with
// IconMail (Templates) — both pages are about email, so the glyphs have to carry
// the distinction: Templates is the message, Smartlead is the sending of it.
export function IconSend({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M21 3 10.5 13.5M21 3l-6.75 18-3.75-7.5L3 9.75 21 3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCalendar({ style }: { style?: CSSProperties }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
