// Pure rules of the cross-publish pipeline — no I/O, so every one of them is
// unit-tested (content-publish.test.ts):
//
//  - which platforms carry image content (Instagram, Facebook this phase);
//  - the Kingdom Building OS "every 3rd post" CTA rule;
//  - how the per-venture captions are composed from the owner's final
//    caption, the credit, and the CTA line;
//  - how an approved post fans out into (venture, platform) publish targets:
//    the source venture plus every venture_cross_publish target, each over
//    the platforms of the post that venture has a stack row for. The
//    executor (report-poller.ts) resolves keys and accounts per target from
//    THAT venture's rows only — venture isolation lives in that lookup.

export const CONTENT_PLATFORMS: readonly string[] = ["instagram", "facebook"];

// Every Nth PUBLISHED post on the cross-publish venture carries the
// invitation back to the source venture.
export const CTA_EVERY_N_POSTS = 3;

// "(count of published posts + 1) divisible by 3" — the next post is the
// 3rd, 6th, 9th…
export function ctaDueForNextPost(publishedCount: number, every: number = CTA_EVERY_N_POSTS): boolean {
  if (!Number.isFinite(publishedCount) || publishedCount < 0) return false;
  return (Math.floor(publishedCount) + 1) % every === 0;
}

// "@handle" normalization: strip surrounding junk, guarantee the leading @.
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^[("'\s]+|[)"'\s.,]+$/g, "");
  if (!cleaned) return null;
  const handle = cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
  return /^@[A-Za-z0-9._-]{1,60}$/.test(handle) ? handle : null;
}

// A repost caption always ends with the credit; appended when the model
// forgot, left alone when it is already there (case-insensitive).
export function ensureCredit(caption: string, credit: string | null): string {
  const text = caption.trim();
  if (!credit) return text;
  if (text.toLowerCase().includes(credit.toLowerCase())) return text;
  return `${text}\n\nvia ${credit}`;
}

export interface ComposeCaptionsArgs {
  sourceSlug: string;
  targetSlugs: string[];
  caption: string;
  credit: string | null;
  sourceKind: "repost" | "riff";
  ctaDue: boolean;
  ctaLine: string | null;
}

// One caption per venture slug. Targets get the source caption verbatim,
// plus the CTA line when (and only when) one is due.
export function composeCaptions(args: ComposeCaptionsArgs): Record<string, string> {
  // A riff may credit the inspiration; a repost must.
  const sourceCaption = args.sourceKind === "repost" ? ensureCredit(args.caption, args.credit) : args.caption.trim();
  const cta = args.ctaDue && args.ctaLine?.trim() ? args.ctaLine.trim() : null;
  const captions: Record<string, string> = { [args.sourceSlug]: sourceCaption };
  for (const slug of args.targetSlugs) {
    if (slug === args.sourceSlug) continue;
    captions[slug] = cta ? `${sourceCaption}\n\n${cta}` : sourceCaption;
  }
  return captions;
}

export interface TargetVenture {
  id: string;
  slug: string;
  name: string;
}

export interface StackRow {
  ventureId: string;
  platform: string;
  accountId: string | null;
  pageId: string | null; // LinkedIn company page / Facebook Page id
  youtubePrivacy?: string | null; // youtube rows only (migration 007)
  enabled: boolean;
}

export interface PublishTargetSpec {
  ventureId: string;
  ventureSlug: string;
  ventureName: string;
  platform: string;
  caption: string;
  stack: StackRow | null; // null = the venture has no row for this platform (the executor records a failure)
}

export interface ExpandTargetsArgs {
  source: TargetVenture;
  crossTargets: TargetVenture[];
  platforms: string[]; // the post's platform list (content_calendar.platforms)
  stacks: StackRow[];
  captions: Record<string, string>; // per venture slug; missing → the post body
  body: string;
}

// The ledger key for a (venture, platform) pair — social_publishes is
// unique on (calendar_id, venture_id, platform) since migration 009.
export function ledgerKey(ventureId: string, platform: string): string {
  return `${ventureId}:${platform}`;
}

export function expandPublishTargets(args: ExpandTargetsArgs): PublishTargetSpec[] {
  const ventures: TargetVenture[] = [args.source];
  for (const t of args.crossTargets) {
    if (!ventures.some((v) => v.id === t.id)) ventures.push(t);
  }
  const byKey = new Map(args.stacks.map((s) => [ledgerKey(s.ventureId, s.platform), s]));
  const targets: PublishTargetSpec[] = [];
  for (const venture of ventures) {
    const caption = args.captions[venture.slug] ?? args.captions[args.source.slug] ?? args.body;
    for (const platform of args.platforms) {
      targets.push({
        ventureId: venture.id,
        ventureSlug: venture.slug,
        ventureName: venture.name,
        platform,
        caption,
        stack: byKey.get(ledgerKey(venture.id, platform)) ?? null,
      });
    }
  }
  return targets;
}

// "CouplesTherapy101 → Instagram, Facebook; Kingdom Building OS → Instagram, Facebook"
export function describeTargetList(targets: { name: string; platforms: string[] }[], label: (p: string) => string = (p) => p): string {
  return targets.map((t) => `${t.name} → ${t.platforms.map(label).join(", ")}`).join("; ");
}
