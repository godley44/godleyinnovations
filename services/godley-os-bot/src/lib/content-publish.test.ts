// The pure cross-publish rules: the every-3rd-post CTA trigger, caption
// composition (credit appended, CTA only when due), and the fan-out of one
// approved post into per-(venture, platform) targets that only ever resolve
// through each venture's own stack rows.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeCaptions,
  ctaDueForNextPost,
  describeTargetList,
  ensureCredit,
  expandPublishTargets,
  ledgerKey,
  normalizeHandle,
  type StackRow,
} from "./content-publish.js";

test("the KBOS CTA is due on every 3rd published post: (count + 1) divisible by 3", () => {
  assert.equal(ctaDueForNextPost(0), false, "first post: no CTA");
  assert.equal(ctaDueForNextPost(1), false);
  assert.equal(ctaDueForNextPost(2), true, "third post: CTA");
  assert.equal(ctaDueForNextPost(3), false);
  assert.equal(ctaDueForNextPost(5), true, "sixth post: CTA");
  assert.equal(ctaDueForNextPost(-1), false, "a broken count never triggers");
  assert.equal(ctaDueForNextPost(Number.NaN), false);
});

test("handles normalize to @handle; junk is refused", () => {
  assert.equal(normalizeHandle("templarpilled"), "@templarpilled");
  assert.equal(normalizeHandle(" (@templarpilled) "), "@templarpilled");
  assert.equal(normalizeHandle("@a.b_c-d"), "@a.b_c-d");
  assert.equal(normalizeHandle(""), null);
  assert.equal(normalizeHandle("not a handle at all"), null);
  assert.equal(normalizeHandle(undefined), null);
});

test("a repost caption always ends with the credit — appended once, never twice", () => {
  assert.equal(ensureCredit("Reading the room.", "@templarpilled"), "Reading the room.\n\nvia @templarpilled");
  assert.equal(ensureCredit("Reading the room. via @TemplarPilled", "@templarpilled"), "Reading the room. via @TemplarPilled");
  assert.equal(ensureCredit("no credit needed", null), "no credit needed");
});

test("captions per venture: target gets the same caption, plus the CTA only when due", () => {
  const base = {
    sourceSlug: "couplestherapy101",
    targetSlugs: ["kingdom-building-os"],
    caption: "Reading the room.",
    credit: "@templarpilled",
    sourceKind: "repost" as const,
  };
  assert.deepEqual(composeCaptions({ ...base, ctaDue: false, ctaLine: "Come see @CouplesTherapy101" }), {
    couplestherapy101: "Reading the room.\n\nvia @templarpilled",
    "kingdom-building-os": "Reading the room.\n\nvia @templarpilled",
  });
  assert.deepEqual(composeCaptions({ ...base, ctaDue: true, ctaLine: "Come see @CouplesTherapy101" }), {
    couplestherapy101: "Reading the room.\n\nvia @templarpilled",
    "kingdom-building-os": "Reading the room.\n\nvia @templarpilled\n\nCome see @CouplesTherapy101",
  });
  // A riff keeps the caption as written (credit optional), the CTA rule is the same.
  assert.deepEqual(composeCaptions({ ...base, sourceKind: "riff", credit: null, ctaDue: true, ctaLine: "Psst: @CouplesTherapy101" }), {
    couplestherapy101: "Reading the room.",
    "kingdom-building-os": "Reading the room.\n\nPsst: @CouplesTherapy101",
  });
});

const CT = { id: "v-ct", slug: "couplestherapy101", name: "CouplesTherapy101" };
const KB = { id: "v-kb", slug: "kingdom-building-os", name: "Kingdom Building OS" };
const STACKS: StackRow[] = [
  { ventureId: "v-ct", platform: "instagram", accountId: "ct-ig", pageId: null, enabled: true },
  { ventureId: "v-ct", platform: "facebook", accountId: "ct-fb", pageId: "ct-page", enabled: true },
  { ventureId: "v-kb", platform: "instagram", accountId: "kb-ig", pageId: null, enabled: true },
  // KBOS has no facebook row on purpose.
];

test("fan-out: source + every cross-publish target × the post's platforms, each resolved through ITS OWN stack row", () => {
  const targets = expandPublishTargets({
    source: CT,
    crossTargets: [KB],
    platforms: ["instagram", "facebook"],
    stacks: STACKS,
    captions: { couplestherapy101: "ct caption", "kingdom-building-os": "kb caption + cta" },
    body: "ct caption",
  });
  assert.deepEqual(
    targets.map((t) => [t.ventureSlug, t.platform, t.caption, t.stack?.accountId ?? null]),
    [
      ["couplestherapy101", "instagram", "ct caption", "ct-ig"],
      ["couplestherapy101", "facebook", "ct caption", "ct-fb"],
      ["kingdom-building-os", "instagram", "kb caption + cta", "kb-ig"],
      ["kingdom-building-os", "facebook", "kb caption + cta", null],
    ],
  );
  const kbFacebook = targets.find((t) => t.ventureSlug === "kingdom-building-os" && t.platform === "facebook")!;
  assert.equal(kbFacebook.stack, null, "a missing stack row is surfaced as null, never borrowed from the source venture");
  const ctFacebook = targets.find((t) => t.ventureSlug === "couplestherapy101" && t.platform === "facebook")!;
  assert.equal(ctFacebook.stack?.pageId, "ct-page");
});

test("fan-out: a legacy text post (no cross targets, no captions) is exactly the old behavior — source × platforms with the body", () => {
  const targets = expandPublishTargets({
    source: { id: "v-lb", slug: "lil-bull", name: "Lil Bull" },
    crossTargets: [],
    platforms: ["twitter", "linkedin"],
    stacks: [{ ventureId: "v-lb", platform: "twitter", accountId: "lb-tw", pageId: null, enabled: true }],
    captions: {},
    body: "Fresh setup is live.",
  });
  assert.deepEqual(
    targets.map((t) => [t.ventureSlug, t.platform, t.caption, t.stack?.accountId ?? null]),
    [
      ["lil-bull", "twitter", "Fresh setup is live.", "lb-tw"],
      ["lil-bull", "linkedin", "Fresh setup is live.", null],
    ],
  );
});

test("fan-out: the source listed among the cross targets is not doubled; a target without a caption falls back to the source's", () => {
  const targets = expandPublishTargets({
    source: CT,
    crossTargets: [CT, KB],
    platforms: ["instagram"],
    stacks: STACKS,
    captions: { couplestherapy101: "ct caption" },
    body: "body",
  });
  assert.deepEqual(
    targets.map((t) => [t.ventureSlug, t.caption]),
    [
      ["couplestherapy101", "ct caption"],
      ["kingdom-building-os", "ct caption"],
    ],
  );
});

test("ledger keys and the human target list", () => {
  assert.equal(ledgerKey("v-ct", "instagram"), "v-ct:instagram");
  assert.equal(
    describeTargetList(
      [
        { name: "CouplesTherapy101", platforms: ["instagram", "facebook"] },
        { name: "Kingdom Building OS", platforms: ["instagram"] },
      ],
      (p) => (p === "instagram" ? "Instagram" : "Facebook"),
    ),
    "CouplesTherapy101 → Instagram, Facebook; Kingdom Building OS → Instagram",
  );
});
