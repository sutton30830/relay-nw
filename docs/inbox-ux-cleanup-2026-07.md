# Inbox UX cleanup — July 2026

Rule enforced throughout: no UI state the server can silently overwrite. Every optimistic change is remembered until the server confirms it, and rolls back (field-level) on failure.

## P1-A + P2-4 — Call count moved on trash/restore; Trash fragmented callers

**Bug.** "N calls" changed when a lead was trashed or restored, and Trash showed one card per deleted row (screenshot: same number twice, each claiming "29 calls").

**Cause.** `condenseLeadsByPhone` was fed only non-deleted rows and its per-phone row tally doubled as the call count, so soft-delete changed the number. Trash bypassed condensing entirely.

**Fix.** Call counts now come from `countCallsByPhone` over **all** rows (deleted or not) — the count is the truth about the caller and never moves. Trash condenses by phone the same way the live inbox does: one caller, one card, honest count. Deleting a card trashes the caller's whole thread (otherwise the next-newest row would instantly pop back up as a live card); restoring brings the whole thread back. That fan-out lives server-side (`deleteLead`, `updateLead` deleted flag) so it's one request. The conversation page also no longer hides deleted sibling calls from the thread — they're calls that really happened.

**Files.** `app/leads/_utils.ts`, `app/leads/_hooks/use-leads-inbox.ts`, `lib/supabase/leads.ts`.

## P1-B — Restore gave no destination choice

**Bug.** Restore silently returned a lead with its old status; no way to say where it should land.

**Cause.** `restoreLead` PATCHed `{deleted:false}` only.

**Fix.** Restore is now a small menu — "Restore as New / Contacted / Closed" — so the lead never reappears in an unexpected tab. The chosen status lands on the row the inbox shows; optimistic with rollback; counts update. (Undo after a delete restores with the status unchanged, since the user isn't re-triaging.)

**Files.** `app/leads/_components/lead-card.tsx`, `_hooks/use-leads-inbox.ts`, `_api.ts`/route (existing PATCH already accepted `status` + `deleted` together).

## P2-1 + P2-3 — Refresh clobbered optimistic edits; stale rollbacks

**Bug.** Only priority edits were protected from the 8s `router.refresh()`; status, booked, notes, name, job value, delete/restore could snap back. Failure rollback restored a whole stale array snapshot.

**Cause.** `pendingPriorityOverrides` covered one field; mutations captured `previousItems = items`.

**Fix.** Generalized to a pending-writes ledger (`pendingLeadWrites` by id, `pendingPhoneWrites` by phone for name fan-out). Incoming server data is reconciled against it: confirmed fields are dropped, unconfirmed ones stay applied — a stale refresh can never undo what the user just did, and the ledger self-clears on server truth (timestamps compare by truthiness, values by equality). All mutations flow through one `mutateLeads` helper that rolls back only the fields it touched, via functional updaters, and respects sample mode. The optimistic new→contacted flip on reply is registered too.

**Files.** `_hooks/use-leads-inbox.ts`.

## P2-2 — Two detail UIs

The conversation page (`/leads/[id]`) is the canonical detail view for real leads. The drawer remains, deliberately, the detail view for **sample data only** (sample leads have no server row to navigate to); this is now stated in code where the drawer is mounted. Its scroll-reset jank was also fixed (see P3).

## P2-5 — Booked jobs had no home in the filters

**Bug.** `booked` was counted but had no tab.

**Fix + decision note.** A contract test (`tenant-contract.test.mjs`) deliberately encoded "booked is an outcome, not an inbox category or workflow status button." The refined decision: booked stays **out of the status buttons** (`STATUS_OPTIONS` unchanged — it's still an outcome flag set by the toggle/value input), but gets a **Booked view** in the filter row driven by `isBookedLead`, so won jobs are findable regardless of status. The contract test was updated to encode exactly that (outcome view must filter on `isBookedLead`, never `lead.status`).

**Files.** `_constants.ts`, `_types.ts`, `_utils.ts`, `tests/tenant-contract.test.mjs`.

## P2-6 — Blocking `window.confirm` on delete

**Fix.** Delete is soft and now restorable in one tap: the confirm dialog is gone, the menu item is honestly labeled "Move to Trash," and an on-brand toast offers **Undo** for 7 seconds (plus dismiss). Undo restores the whole caller with status untouched.

**Files.** `lead-card.tsx`, `_hooks/use-leads-inbox.ts`, `leads-list.tsx`, `_constants.ts` (`UNDO_DELETE_MS`), `app/globals.css` (`.undo-toast`).

## P2-7 — Generic voicemail summaries

**Bug.** Near-identical filler ("The caller has an urgent request that needs immediate attention.") on multiple cards.

**Cause.** The summarizer had no escape hatch for voicemails with no content, so it padded.

**Fix.** The prompt now requires naming the specific problem/appliance/location/request, forbids filler, and must answer `NO_DETAILS` when there's nothing specific. A server-side guard (`isGenericVoicemailSummary`) additionally catches filler-only output. Either way the summary is stored as `null`, and every surface shows an honest fallback ("No summary — the voicemail didn't say what they need. Listen…") instead of boilerplate. Owner SMS/email fall back to a transcript excerpt.

**Files.** `lib/voicemail-ai.ts`, `_types.ts`, `lead-card.tsx`, `lead-drawer.tsx`, `[id]/conversation-view.tsx`.

## P2-8 — Copy consistency

Verified: every user-facing surface renders `dead` through `STATUS_LABELS` ("Closed") — status pills, segmented control, card meta, filters. No raw "dead" leaks; DB enum untouched. No code change needed.

## P3 — Polish

- Drawer scroll reset collapsed from three rAFs + an 80ms timeout (which fought the user's scrolling) to one pre-paint reset + one frame.
- `OverflowMenu` rewritten as a generic, pre-filtered items menu — focus order and refs always match rendered items (no fixed index slots); it also powers the Restore menu.
- "Summarize" buttons no longer invite retries that can only return the same `NO_DETAILS` result (hidden once a transcript exists); the conversation view notes "No clear summary" inline.

## Left unchanged (deliberately)

- **Status/booked fan-out across sibling rows**: hidden siblings don't affect tabs or counts after condensing (representatives drive both), so per-row writes stay as-is.
- **"Preparing voicemail summary…" window**: bounded to 10 minutes by `isRecentLead`, and the June 2026 server-side stale-processing takeover already recovers crashed runs.
- **Conversation page mutations**: `[id]` has no 8s auto-refresh, and its edits already roll back on failure.
- **DB enum `dead`** and `STATUS_OPTIONS` (New/Contacted/Closed) — untouched.

Verification: `tsc --noEmit` clean; `node --test` 70/70 passing.
