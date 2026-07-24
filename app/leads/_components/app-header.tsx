"use client";

import Link from "next/link";
import type { RefObject } from "react";
import { Icon } from "@/components/icon";

type HeaderSearch = {
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
};

type HeaderPage = "inbox" | "reports" | "setup" | "settings" | "conversation" | "operations" | "customers" | "requests" | "team";

const OWNER_NAV_ITEMS = [
  { key: "inbox", href: "/leads", icon: "inbox" as const, label: "Inbox" },
  { key: "reports", href: "/reports", icon: "chart" as const, label: "Reports" },
  { key: "setup", href: "/setup", icon: "settings" as const, label: "Setup" },
  { key: "settings", href: "/settings", icon: "user" as const, label: "Settings" },
];

export function AppHeader({
  businessName,
  currentPage,
  search,
  showOperations = false,
  switchAccountHref,
  variant = "owner",
}: {
  businessName: string;
  currentPage?: HeaderPage;
  search?: HeaderSearch;
  showOperations?: boolean;
  switchAccountHref?: string;
  variant?: "owner" | "operations";
}) {
  const isOperations = variant === "operations";
  const businessInitial = businessName.trim().charAt(0).toUpperCase() || "R";
  // Sub-pages get a plain, always-visible way back to the inbox. The
  // conversation view has its own back control, and the inbox is the
  // destination, so neither shows this.
  const showBackToInbox = currentPage != null && currentPage !== "inbox" && currentPage !== "conversation";
  const operationsNavItems = [
    { key: "operations", href: "/ops", icon: "inbox" as const, label: "Operations" },
    { key: "customers", href: "/ops/customers", icon: "user" as const, label: "Customers" },
    { key: "requests", href: "/ops/setup-requests", icon: "message" as const, label: "Requests" },
    { key: "team", href: "/ops/team", icon: "settings" as const, label: "Team" },
  ];
  const navItems = isOperations ? operationsNavItems : OWNER_NAV_ITEMS;
  const menuItems = [
    ...navItems,
    ...(isOperations
      ? [
          { key: "runbook", href: "/ops/runbook", icon: "info" as const, label: "Runbook" },
          { key: "back-to-inbox", href: "/leads", icon: "arrowLeft" as const, label: "Back to my inbox" },
        ]
      : []),
    ...(!isOperations && showOperations
      ? [{ key: "operations", href: "/ops", icon: "shield" as const, label: "Operations" }]
      : []),
  ];

  return (
    <header className="app-head">
      <Link className="app-head__brand app-head__brand--link" href="/">
        <div className="brand-mark"><Icon name={isOperations ? "shield" : "relay"} size={18} /></div>
        <div>
          <p className="t-eyebrow" style={{ fontSize: 10 }}>{isOperations ? "Relay NW · Operations" : "Relay NW"}</p>
          <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>{isOperations ? "Operations" : businessName}</h1>
        </div>
        {currentPage === "inbox" ? (
          <span className="live-dot" title="Auto-refreshes every few seconds">
            <span className="live-dot__pulse" />
            <span className="live-dot__core" />
            Live
          </span>
        ) : null}
      </Link>

      <div className="app-head__right">
        {currentPage && currentPage !== "conversation" ? (
            <nav className="app-head__nav" aria-label={isOperations ? "Operations navigation" : "Owner navigation"}>
            {navItems.map((item) => {
              const isCurrent = item.key === currentPage;
              return (
                <Link
                  key={item.key}
                  className={`app-head__nav-link ${isCurrent ? "app-head__nav-link--active" : ""}`}
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                >
                  <Icon name={item.icon} size={14} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        ) : null}

        {showBackToInbox ? (
          <Link className="btn btn-secondary btn-sm app-head__back" href="/leads">
            <Icon name="arrowLeft" size={14} /> Inbox
          </Link>
        ) : null}

        {search ? (
          <div className="search app-head__desktop-search">
            <Icon name="search" size={14} />
            <input
              ref={search.inputRef}
              className="search__input"
              placeholder={search.placeholder ?? "Search name, phone, message..."}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
            />
            <span className="kbd">⌘K</span>
          </div>
        ) : null}

        <details className="mobile-owner-menu">
          <summary className="mobile-owner-menu__trigger" aria-label="Open account menu">
            <span>{businessInitial}</span>
            <Icon name="more" size={16} />
          </summary>
          <div className="mobile-owner-menu__panel">
            <div className="mobile-owner-menu__profile">
              <div className="mobile-owner-menu__avatar">{businessInitial}</div>
              <div>
                <p>{businessName}</p>
                <span>{isOperations ? "Operations" : "Missed-call inbox"}</span>
              </div>
            </div>

            {menuItems.map((item) => (
              <Link
                key={item.key}
                className={`mobile-owner-menu__item ${item.key === currentPage ? "mobile-owner-menu__item--active" : ""}`}
                href={item.href}
                aria-current={item.key === currentPage ? "page" : undefined}
              >
                <Icon name={item.icon} size={15} />
                {item.label}
              </Link>
            ))}

            {switchAccountHref ? (
              <Link className="mobile-owner-menu__item" href={switchAccountHref}>
                <Icon name="external" size={15} />
                Switch business
              </Link>
            ) : null}

            <form action="/api/leads-logout" method="POST">
              <button className="mobile-owner-menu__item mobile-owner-menu__item--muted" type="submit">
                <Icon name="external" size={15} />
                Log out
              </button>
            </form>
          </div>
        </details>
      </div>
    </header>
  );
}
