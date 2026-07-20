import { useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";

function kebabToCamel(s: string) {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
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
  as?: keyof JSX.IntrinsicElements;
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
export function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
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
export function IconCalendar({ style }: { style?: CSSProperties }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
