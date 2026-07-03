"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";

export type OverflowMenuItem = {
  label: string;
  danger?: boolean;
  onSelect: () => void;
};

// Generic action menu. Items are passed pre-filtered, so focus order and refs
// always match what's actually rendered (no fixed index slots).
export function OverflowMenu({
  items,
  trigger,
  triggerClassName = "btn btn-ghost btn-sm",
  triggerAriaLabel = "More actions",
}: {
  items: OverflowMenuItem[];
  trigger?: ReactNode;
  triggerClassName?: string;
  triggerAriaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function closeMenu({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        closeMenu({ restoreFocus: false });
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  function focusItem(index: number) {
    itemRefs.current[index]?.focus();
  }

  function focusByOffset(offset: number) {
    const activeIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    focusItem(nextIndex);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByOffset(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByOffset(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    }
  }

  function runAction(action: () => void) {
    action();
    // Restore focus to the trigger; if the action removed the card (trash,
    // restore), the browser simply drops focus with it.
    closeMenu();
  }

  return (
    <div className="lead-card__overflow" style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        className={triggerClassName}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={trigger ? undefined : triggerAriaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusItem(0));
          }
        }}
      >
        {trigger ?? <Icon name="more" size={13} />}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="lead-card__overflow-menu"
          role="menu"
          onKeyDown={handleMenuKeyDown}
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-md)",
            display: "grid",
            gap: 4,
            minWidth: 176,
            padding: 6,
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 20,
          }}
        >
          {items.map((item, index) => (
            <div key={item.label} style={{ display: "grid", gap: 4 }}>
              {item.danger && index > 0 && !items[index - 1]?.danger ? (
                <div role="separator" style={{ borderTop: "1px solid var(--line)", margin: "2px 0" }} />
              ) : null}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className={`btn btn-sm ${item.danger ? "btn-danger-ghost lead-card__menu-item--danger" : "btn-ghost"}`}
                type="button"
                role="menuitem"
                onClick={() => runAction(item.onSelect)}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
