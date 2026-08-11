// The single source of truth for what tabs exist in a venture workspace and
// what they read/write. The app renders from this; scripts/check-config.mjs
// validates it against supabase/migrations/*.sql so a tab can never point at
// a table or option list the database doesn't have.
//
// Keep this file pure data (no react, no supabase imports): the guard script
// imports it under plain Node.

import type { ModuleSpec } from "./types.ts";

// These option lists must mirror the CHECK constraints in the migrations.
// The guard script fails the build if they drift.
export const LEDGER_CATEGORIES = [
  "sale",
  "advertising",
  "operations",
  "equipment",
  "fees",
  "funding",
  "other",
] as const;

export const MODULES: ModuleSpec[] = [
  {
    slug: "financials",
    title: "Financials",
    sections: [
      {
        id: "ledger",
        title: "Money ledger",
        table: "money_ledger",
        scope: "venture",
        orderBy: { column: "occurred_on", ascending: false },
        emptyHint:
          "Every dollar in or out goes here. Sales and ad spend entered on their own tabs land in this same ledger.",
        fields: [
          { key: "occurred_on", label: "Date", type: "date", required: true },
          {
            key: "amount_cents",
            label: "Amount",
            type: "money",
            required: true,
            moneyDirection: "signed",
          },
          {
            key: "category",
            label: "Category",
            type: "select",
            options: LEDGER_CATEGORIES,
            required: true,
          },
          { key: "counterparty", label: "Who", type: "text", placeholder: "customer / vendor" },
          { key: "item", label: "What", type: "text" },
          { key: "note", label: "Note", type: "longtext" },
        ],
      },
    ],
  },
  {
    slug: "sales",
    title: "Sales",
    sections: [
      {
        // Not a separate table: a lens on the ledger. A sale recorded here IS
        // the financial record — the Financials tab shows the same row.
        id: "sales",
        title: "Sales",
        table: "money_ledger",
        scope: "venture",
        fixed: { category: "sale" },
        orderBy: { column: "occurred_on", ascending: false },
        emptyHint: "Record each sale here. It lands directly in the money ledger.",
        fields: [
          { key: "occurred_on", label: "Date", type: "date", required: true },
          {
            key: "amount_cents",
            label: "Amount",
            type: "money",
            required: true,
            moneyDirection: "in",
          },
          { key: "counterparty", label: "Customer", type: "text" },
          { key: "item", label: "What was sold", type: "text" },
          { key: "note", label: "Note", type: "longtext" },
        ],
      },
    ],
  },
  {
    slug: "advertising",
    title: "Advertising",
    sections: [
      {
        id: "campaigns",
        title: "Campaigns",
        table: "ad_campaigns",
        scope: "venture",
        orderBy: { column: "starts_on", ascending: false },
        emptyHint:
          "Campaigns hold the plan (dates, budget). Actual ad dollars go in Ad spend below so the books stay whole.",
        fields: [
          { key: "name", label: "Campaign", type: "text", required: true },
          { key: "platform", label: "Platform", type: "text", placeholder: "Meta / Google / flyers", required: true },
          { key: "starts_on", label: "Starts", type: "date", required: true },
          { key: "ends_on", label: "Ends", type: "date" },
          { key: "budget_cents", label: "Budget", type: "money", moneyDirection: "in" },
          { key: "note", label: "Note", type: "longtext" },
        ],
      },
      {
        // Ad spend is ledger rows, category 'advertising' — same reasoning as
        // Sales. Campaign metadata and money never live in the same table.
        id: "ad-spend",
        title: "Ad spend",
        table: "money_ledger",
        scope: "venture",
        fixed: { category: "advertising" },
        orderBy: { column: "occurred_on", ascending: false },
        emptyHint: "Each ad payment goes here and lands in the money ledger as spend.",
        fields: [
          { key: "occurred_on", label: "Date", type: "date", required: true },
          {
            key: "amount_cents",
            label: "Amount",
            type: "money",
            required: true,
            moneyDirection: "out",
          },
          { key: "counterparty", label: "Paid to", type: "text" },
          { key: "item", label: "For", type: "text", placeholder: "which campaign / placement" },
          { key: "note", label: "Note", type: "longtext" },
        ],
      },
    ],
  },
  {
    slug: "social",
    title: "Social",
    sections: [
      {
        id: "accounts",
        title: "Accounts",
        table: "social_accounts",
        scope: "venture",
        orderBy: { column: "created_at", ascending: true },
        emptyHint: "Add each social account this venture owns.",
        fields: [
          {
            key: "platform",
            label: "Platform",
            type: "select",
            options: [
              "youtube",
              "instagram",
              "tiktok",
              "x",
              "facebook",
              "linkedin",
              "twitch",
              "other",
            ],
            required: true,
          },
          { key: "handle", label: "Handle", type: "text", required: true },
          { key: "url", label: "URL", type: "url" },
        ],
      },
      {
        id: "snapshots",
        title: "Follower snapshots",
        table: "social_snapshots",
        scope: { via: { parentTable: "social_accounts", fkColumn: "account_id" } },
        orderBy: { column: "taken_on", ascending: false },
        emptyHint:
          "Once in a while, jot down follower counts. Growth is computed by comparing snapshots — nothing to keep in sync.",
        fields: [
          {
            key: "account_id",
            label: "Account",
            type: "select", // options are the venture's accounts, resolved at runtime
            required: true,
          },
          { key: "taken_on", label: "Date", type: "date", required: true },
          { key: "follower_count", label: "Followers", type: "number", required: true },
          { key: "note", label: "Note", type: "text" },
        ],
      },
    ],
  },
  {
    slug: "websites",
    title: "Websites",
    sections: [
      {
        id: "websites",
        title: "Websites & domains",
        table: "websites",
        scope: "venture",
        orderBy: { column: "created_at", ascending: true },
        emptyHint: "Every site and domain this venture runs, with its renewal date.",
        fields: [
          { key: "label", label: "Label", type: "text", required: true, placeholder: "main site / shop" },
          { key: "url", label: "URL", type: "url", required: true },
          { key: "host", label: "Host / registrar", type: "text" },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["live", "building", "down", "retired"],
            required: true,
          },
          { key: "renewal_on", label: "Next renewal", type: "date" },
          { key: "note", label: "Note", type: "longtext" },
        ],
      },
    ],
  },
  {
    slug: "support",
    title: "Support",
    sections: [
      {
        id: "tickets",
        title: "Tickets",
        table: "support_tickets",
        scope: "venture",
        orderBy: { column: "opened_on", ascending: false },
        emptyHint: "Anything a customer asked for that you owe an answer on.",
        fields: [
          { key: "opened_on", label: "Opened", type: "date", required: true },
          { key: "customer", label: "Customer", type: "text" },
          { key: "channel", label: "Channel", type: "text", placeholder: "email / IG DM / phone" },
          { key: "subject", label: "Subject", type: "text", required: true },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["open", "waiting", "closed"],
            required: true,
          },
          { key: "resolution", label: "Resolution", type: "longtext" },
        ],
      },
    ],
  },
];
