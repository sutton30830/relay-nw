"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";

type OverflowMenuProps = {
  showMarkContacted: boolean;
  showMarkBooked: boolean;
  showDelete: boolean;
  onMarkContacted: () => void;
  onMarkBooked: () => void;
  onDelete: () => void;
};

export function OverflowMenu({
  showMarkContacted,
  showMarkBooked,
  showDelete,
  onMarkContacted,
  onMarkBooked,
  onDelete,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasActions = showMarkContacted || showMarkBooked || showDelete;

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

  if (!hasActions) {
    return null;
  }

  function focusItem(index: number) {
    const visibleItems = itemRefs.current.filter(Boolean);
    visibleItems[index]?.focus();
  }

  function focusByOffset(offset: number) {
    const visibleItems = itemRefs.current.filter(Boolean);
    const activeIndex = visibleItems.findIndex((item) => item === document.activeElement);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const nextIndex = (currentIndex + offset + visibleItems.length) % visibleItems.length;
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
      focusItem(itemRefs.current.filter(Boolean).length - 1);
    }
  }

  function runAction(action: () => void) {
    action();
    closeMenu();
  }

  return (
    <div className="lead-card__overflow" style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        className="btn btn-ghost btn-sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusItem(0));
          }
        }}
      >
        <Icon name="more" size={13} />
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
          {showMarkContacted ? (
            <button
              ref={(node) => {
                itemRefs.current[0] = node;
              }}
              className="btn btn-ghost btn-sm"
              type="button"
              role="menuitem"
              onClick={() => runAction(onMarkContacted)}
            >
              Mark contacted
            </button>
          ) : null}
          {showMarkBooked ? (
            <button
              ref={(node) => {
                itemRefs.current[1] = node;
              }}
              className="btn btn-ghost btn-sm"
              type="button"
              role="menuitem"
              onClick={() => runAction(onMarkBooked)}
            >
              Mark as booked
            </button>
          ) : null}
          {showDelete ? (
            <>
              <div role="separator" style={{ borderTop: "1px solid var(--line)", margin: "2px 0" }} />
              <button
                ref={(node) => {
                  itemRefs.current[2] = node;
                }}
                className="btn btn-danger-ghost btn-sm lead-card__menu-item--danger"
                type="button"
                role="menuitem"
                onClick={() => runAction(onDelete)}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
