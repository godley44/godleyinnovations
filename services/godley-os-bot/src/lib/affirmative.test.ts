// The affirmative-reply parser: exact whitelisted phrases confirm or
// cancel; EVERYTHING else is "other" (goes back to the model, which asks).
// A pending action must never execute off a fuzzy match.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReply } from "./affirmative.js";

test("affirmative: the whitelisted confirmations", () => {
  for (const reply of [
    "yes",
    "y",
    "Yes",
    "YES",
    "yes!",
    "yes.",
    "yep",
    "yeah",
    "confirm",
    "Confirmed",
    "approve",
    "approve it",
    "do it",
    "go ahead",
    "ok",
    "okay",
    "👍",
    "  yes  ", // whitespace
    "<@U0BOT> yes", // @mentioning the bot first still confirms
  ]) {
    assert.equal(classifyReply(reply), "affirmative", `"${reply}" must confirm`);
  }
});

test("negative: the whitelisted cancellations", () => {
  for (const reply of ["no", "n", "No.", "nope", "cancel", "cancel it", "stop", "nevermind", "never mind"]) {
    assert.equal(classifyReply(reply), "negative", `"${reply}" must cancel`);
  }
});

test("anything else is other — ambiguity never executes", () => {
  for (const reply of [
    "yes but change the text first", // conditions are not consent
    "yes and also approve the other one",
    "approve the second one", // a NEW request, not a confirmation
    "approve both",
    "maybe",
    "ok?", // a question, not consent
    "sure thing boss, whatever you say",
    "what would yes do exactly?",
    "reject", // ambiguous on an approve confirmation — model asks
    "",
    "   ",
    "yesterday", // must not prefix-match "yes"
    "okey dokey",
  ]) {
    assert.equal(classifyReply(reply), "other", `"${reply}" must NOT be treated as yes/no`);
  }
});
