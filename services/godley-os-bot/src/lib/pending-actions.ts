// The confirm-before-act store: when the model wants to run an ACT tool,
// the manager parks it here and asks the owner; only an explicit affirmative
// reply in the same conversation executes it. This is the CODE enforcement
// of the confirmation gate — the system prompt merely explains it.
//
// Deliberately IN-MEMORY, no table (the schema decision): a pending action
// lives at most 10 minutes on a single Render instance, and losing it is
// always safe — it fails CLOSED. After a restart a "yes" finds nothing and
// the manager says so instead of executing; nothing can ever run without a
// live, unexpired entry. Same trade-off the events route already accepts
// for its dedupe map. If pending actions ever need to survive restarts or
// span instances, that is the moment to propose a migration — not before.
//
// One pending action per conversation (channel, or thread within it). A new
// proposal SUPERSEDES the old one — returned so the caller announces the
// replacement, never silently dropped. Expiry is lazy: peek() reports an
// expired entry exactly once (so it can be announced), then forgets it.

export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

// The manager's acts, the manager's account sync, and the content agent's
// filing act share one store type: every one of them is parked here and
// runs only after the owner's exact "yes".
export type ActToolName =
  | "approve_proposal"
  | "reject_proposal"
  | "create_social_draft"
  | "sync_blotato_accounts"
  | "file_for_approval";

export interface ProposedAct {
  tool: ActToolName;
  input: Record<string, unknown>;
  // Human-readable, code-built (never model-written) description of exactly
  // what will happen — this is what the owner confirms.
  summary: string;
}

export interface PendingAction {
  key: string; // conversation key: `${channelId}:${threadTs ?? "channel"}`
  acts: ProposedAct[];
  createdAt: number;
  expiresAt: number;
}

export type PendingLookup =
  | { state: "none" }
  | { state: "pending"; action: PendingAction }
  | { state: "expired"; action: PendingAction };

export class PendingActionStore {
  private readonly byKey = new Map<string, PendingAction>();

  // Injectable clock so the lifecycle is unit-testable without real waits.
  constructor(private readonly now: () => number = Date.now) {}

  propose(key: string, acts: ProposedAct[]): { pending: PendingAction; superseded: PendingAction | null } {
    const existing = this.byKey.get(key);
    const superseded = existing && existing.expiresAt > this.now() ? existing : null;
    const createdAt = this.now();
    const pending: PendingAction = { key, acts, createdAt, expiresAt: createdAt + PENDING_ACTION_TTL_MS };
    this.byKey.set(key, pending);
    return { pending, superseded };
  }

  // Non-destructive for live entries; an expired entry is reported once
  // (state "expired") and removed, so the caller can announce it.
  peek(key: string): PendingLookup {
    const existing = this.byKey.get(key);
    if (!existing) return { state: "none" };
    if (existing.expiresAt <= this.now()) {
      this.byKey.delete(key);
      return { state: "expired", action: existing };
    }
    return { state: "pending", action: existing };
  }

  // Claim for execution: returns the live entry and removes it, so the same
  // confirmation can never execute twice. Expired entries are never handed
  // out for execution.
  take(key: string): PendingAction | null {
    const lookup = this.peek(key);
    if (lookup.state !== "pending") return null;
    this.byKey.delete(key);
    return lookup.action;
  }

  cancel(key: string): PendingAction | null {
    const lookup = this.peek(key);
    if (lookup.state !== "pending") return null;
    this.byKey.delete(key);
    return lookup.action;
  }

  // Live (unexpired) count for the health probe; sweeps expired entries.
  count(): number {
    for (const [key, action] of this.byKey) {
      if (action.expiresAt <= this.now()) this.byKey.delete(key);
    }
    return this.byKey.size;
  }
}
