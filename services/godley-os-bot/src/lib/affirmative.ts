// The affirmative-reply parser for the confirm-before-act gate. STRICT BY
// DESIGN: only an exact whitelisted phrase confirms or cancels; everything
// else — "yes but change the text", "approve the second one", "maybe" — is
// "other" and goes back to the model, which asks instead of guessing. A
// pending action is never executed off a fuzzy match.

export type ReplyIntent = "affirmative" | "negative" | "other";

const AFFIRMATIVE = new Set([
  "yes",
  "y",
  "yep",
  "yeah",
  "yea",
  "confirm",
  "confirmed",
  "approve",
  "approve it",
  "approved",
  "do it",
  "go ahead",
  "ok",
  "okay",
  "👍",
]);

// "reject" is deliberately NOT here: as a reply to "Approve X?" it is
// ambiguous (cancel the confirmation? file a rejection instead?) — it falls
// to "other" and the model asks.
const NEGATIVE = new Set([
  "no",
  "n",
  "nope",
  "cancel",
  "cancel it",
  "stop",
  "abort",
  "nevermind",
  "never mind",
  "don't",
  "dont",
]);

export function classifyReply(raw: string): ReplyIntent {
  const normalized = raw
    .replace(/<@[^>]+>/g, "") // strip Slack @mentions (e.g. of the bot)
    .toLowerCase()
    .replace(/[.!…]+$/g, "") // trailing punctuation, but not "?" — "ok?" is a question
    .replace(/\s+/g, " ")
    .trim();
  if (AFFIRMATIVE.has(normalized)) return "affirmative";
  if (NEGATIVE.has(normalized)) return "negative";
  return "other";
}
