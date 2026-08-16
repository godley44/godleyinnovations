// Per-venture page emphasis. The simplest defensible version: a hardcoded
// map from venture slug to the cards that lead its overview, ahead of the
// default module layout. Ventures not listed here keep the default page
// exactly as it was. When a third venture wants its own lead card, this map
// grows one line — if it ever needs logic, promote it into module config.

export type LeadCard = "weekly-brief";

export const VENTURE_LEAD_CARDS: Record<string, LeadCard[]> = {
  "lil-bull": ["weekly-brief"],
};
