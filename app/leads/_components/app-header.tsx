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

type HeaderSample = {
  active: boolean;
  label: string;
  onToggle: () => void;
  visible: boolean;
};

type HeaderPage = "inbox" | "reports" | "setup" | "settings" | "conversation";

export function AppHeader({
  businessName,
  currentPage,
  sample,
  search,
  showOperations = false,
  switchAccountHref,
}: {
  businessName: string;
  currentPage?: HeaderPage;
  sample?: HeaderSample;
  search?: HeaderSearch;
  showOperations?: boolean;
  switchAccountHref?: string;
}) {
  const businessInitial = businessName.trim().charAt(0).toUpperCase() || "R";
  // Sub-pages get a plain, always-visible way back to the inbox. The
  // conversation view has its own back control, and the inbox is the
  // destination, so neither shows this.
  const showBackToInbox = currentPage != null && currentPage !== "inbox" && currentPage !== "conversation";
  const menuItems = [
    { key: "inbox", href: "/leads", icon: "inbox" as const, label: "Inbox" },
    { key: "setup", href: "/setup", icon: "settings" as const, label: "Setup" },
    { key: "reports", href: "/reports", icon: "inbox" as const, label: "Reports" },
    { key: "settings", href: "/settings", icon: "user" as const, label: "Settings" },
    ...(showOperations
      ? [{ key: "operations", href: "/ops", icon: "shield" as const, label: "Operations" }]
      : []),
  ].filter((item) => item.key !== currentPage);

  return (
    <header className="app-head">
      <Link className="app-head__brand app-head__brand--link" href="/">
        <div className="brand-mark"><Icon name="relay" size={18} /></div>
        <div>
          <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
          <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>{businessName}</h1>
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

        {sample?.visible ? (
          <button
            className={`btn btn-secondary btn-sm app-head__sample ${sample.active ? "btn-sample-on" : ""}`}
            type="button"
            onClick={sample.onToggle}
          >
            {sample.label}
          </button>
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
                <span>Missed-call inbox</span>
              </div>
            </div>

            {menuItems.map((item) => (
              <Link key={item.key} className="mobile-owner-menu__item" href={item.href}>
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

            {sample?.visible ? (
              <button
                className="mobile-owner-menu__item"
                type="button"
                onClick={sample.onToggle}
              >
                <Icon name="sparkle" size={15} />
                {sample.active ? "Hide sample data" : "Sample data"}
              </button>
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
