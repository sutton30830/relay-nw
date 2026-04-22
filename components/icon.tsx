import type { CSSProperties, ReactNode } from "react";

type IconName =
  | "alertTriangle"
  | "arrowRight"
  | "calendar"
  | "check"
  | "checkDouble"
  | "chevronRight"
  | "clock"
  | "copy"
  | "external"
  | "inbox"
  | "info"
  | "message"
  | "more"
  | "phone"
  | "phoneMissed"
  | "refresh"
  | "relay"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "sparkle"
  | "star"
  | "user"
  | "x";

const ICONS: Record<IconName, ReactNode> = {
  alertTriangle: <path d="M10 3 2.5 16.5h15L10 3ZM10 8v4M10 14.5v0.01" />,
  arrowRight: <path d="M4 10h12M11 5l5 5-5 5" />,
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 3v3M13 3v3" />
    </>
  ),
  check: <path d="M4 10.5 8 14.5 16 5.5" />,
  checkDouble: (
    <>
      <path d="M3 11 7 15 14 6.5" />
      <path d="M9 11l1.5 1.5M16 6.5 11 13" />
    </>
  ),
  chevronRight: <path d="M7.5 5 12.5 10 7.5 15" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 2" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13" />
    </>
  ),
  external: <path d="M12 3h5v5M17 3l-7 7M14 10v5.5A1.5 1.5 0 0 1 12.5 17h-8A1.5 1.5 0 0 1 3 15.5v-8A1.5 1.5 0 0 1 4.5 6H10" />,
  inbox: (
    <>
      <path d="M3 12.5V5.5A2 2 0 0 1 5 3.5h10A2 2 0 0 1 17 5.5v7" />
      <path d="M3 12.5h4l1 2h4l1-2h4v3A2 2 0 0 1 15 17.5H5A2 2 0 0 1 3 15.5v-3Z" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v5M10 6.5v0.01" />
    </>
  ),
  message: <path d="M3 5.5A2 2 0 0 1 5 3.5h10A2 2 0 0 1 17 5.5v6A2 2 0 0 1 15 13.5H8l-4 3.5v-3.5A2 2 0 0 1 3 11.5v-6Z" />,
  more: (
    <>
      <circle cx="5" cy="10" r="1.2" />
      <circle cx="10" cy="10" r="1.2" />
      <circle cx="15" cy="10" r="1.2" />
    </>
  ),
  phone: <path d="M5 3.5h2.2l1.4 3.3-1.8 1.1a9 9 0 0 0 4.3 4.3l1.1-1.8 3.3 1.4V14a2.5 2.5 0 0 1-2.5 2.5A11 11 0 0 1 2.5 5.5 2.5 2.5 0 0 1 5 3Z" />,
  phoneMissed: (
    <>
      <path d="M5 3.5h2.2l1.4 3.3-1.8 1.1a9 9 0 0 0 4.3 4.3l1.1-1.8 3.3 1.4V14a2.5 2.5 0 0 1-2.5 2.5A11 11 0 0 1 2.5 5.5 2.5 2.5 0 0 1 5 3Z" />
      <path d="M12.5 2.5l4 4M16.5 2.5l-4 4" />
    </>
  ),
  refresh: <path d="M3.5 9A6.5 6.5 0 0 1 15 5M16.5 11A6.5 6.5 0 0 1 5 15M15 3v3h-3M5 17v-3h3" />,
  relay: <path d="M4 10h4l2-4 2 8 2-4h2" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="M13 13l3.5 3.5" />
    </>
  ),
  send: <path d="M3 10 17 3.5 10.5 17 9 11l-6-1Z" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  shield: <path d="M10 2.5 3.5 5v5c0 3.5 2.5 6.5 6.5 8 4-1.5 6.5-4.5 6.5-8V5L10 2.5Z" />,
  sparkle: <path d="M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8L10 3Z" />,
  star: <path d="M10 3 12.2 7.5 17 8.2l-3.5 3.4.8 4.9L10 14.1 5.7 16.5l.8-4.9L3 8.2l4.8-.7L10 3Z" />,
  user: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c.8-3.2 3.3-5 6-5s5.2 1.8 6 5" />
    </>
  ),
  x: <path d="M5 5l10 10M15 5 5 15" />,
};

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
