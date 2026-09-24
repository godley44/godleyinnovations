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
  // The venture content agent (high-touch channels) shares the counters'
  // home: messages it handled, images it mirrored, packages it filed.
  contentMessagesHandled: number;
  contentImagesIngested: number;
  contentFilings: number;
}

const stats: ManagerStats = {
  messagesHandled: 0,
  lastMessageAt: null,
  pendingActions: 0,
  lastModelLatencyMs: null,
  lastModelAt: null,
  lastError: null,
  contentMessagesHandled: 0,
  contentImagesIngested: 0,
  contentFilings: 0,
};

export function recordContentMessage(): void {
  stats.contentMessagesHandled += 1;
}

export function recordContentImage(): void {
  stats.contentImagesIngested += 1;
}

export function recordContentFiling(): void {
  stats.contentFilings += 1;
}

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
