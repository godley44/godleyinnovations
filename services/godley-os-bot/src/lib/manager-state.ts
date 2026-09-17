// The AI Manager's process-local counters, surfaced by the health probe
// (manager stats ride the same @mention answer as the poller stats). Kept in
// its own tiny module so slack-events, manager, and health-text can all
// touch it without import cycles.

export interface ManagerStats {
  messagesHandled: number;
  lastMessageAt: string | null;
  pendingActions: number;
  lastModelLatencyMs: number | null;
  lastModelAt: string | null;
  lastError: string | null;
}

const stats: ManagerStats = {
  messagesHandled: 0,
  lastMessageAt: null,
  pendingActions: 0,
  lastModelLatencyMs: null,
  lastModelAt: null,
  lastError: null,
};

export function recordManagerMessage(): void {
  stats.messagesHandled += 1;
  stats.lastMessageAt = new Date().toISOString();
}

export function recordModelCall(latencyMs: number): void {
  stats.lastModelLatencyMs = latencyMs;
  stats.lastModelAt = new Date().toISOString();
}

export function setPendingActionCount(count: number): void {
  stats.pendingActions = count;
}

export function recordManagerError(message: string): void {
  stats.lastError = message;
}

export function getManagerStats(): ManagerStats {
  return { ...stats };
}
