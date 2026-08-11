// Shapes for the declarative module config (see config.ts). The whole app's
// tab structure is data, not code, so one guard script can validate all of it
// against the SQL migrations before every push.

export type FieldType =
  | "text"
  | "longtext"
  | "date"
  | "money" // entered as dollars, stored as integer cents in a *_cents column
  | "number"
  | "select"
  | "url";

export interface FieldSpec {
  key: string; // column name in the table
  label: string;
  type: FieldType;
  /** For type 'select': fixed choices. Must mirror the CHECK constraint in SQL. */
  options?: readonly string[];
  required?: boolean;
  placeholder?: string;
  /**
   * For 'money' fields that can go both ways (ledger): 'in' | 'out' | 'signed'.
   * 'in' forces positive, 'out' forces negative, 'signed' shows an in/out
   * toggle. Keeps the sign convention (positive = in) out of the user's head.
   */
  moneyDirection?: "in" | "out" | "signed";
}

export interface SectionSpec {
  /** Stable id, used for React keys and guard checks. */
  id: string;
  title: string;
  /** Postgres table this section reads and writes. */
  table: string;
  /**
   * How rows relate to the current venture:
   * - 'venture': table has a venture_id column, filter/insert directly.
   * - { via } : table references a parent table that has venture_id
   *   (e.g. social_snapshots -> social_accounts). We resolve parent ids first.
   *   The parent must be another section's table so the user can create
   *   parents before children.
   */
  scope: "venture" | { via: { parentTable: string; fkColumn: string } };
  fields: FieldSpec[];
  /**
   * Fixed column values acting as both filter and insert default. This is how
   * a "lens" works: the Sales section is money_ledger with
   * fixed {category: 'sale'}. Same rows as Financials, same truth.
   */
  fixed?: Record<string, string>;
  orderBy: { column: string; ascending: boolean };
  emptyHint: string;
}

export interface ModuleSpec {
  /** URL segment and tab id. */
  slug: string;
  title: string;
  sections: SectionSpec[];
}
