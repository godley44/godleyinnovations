// Migrations are run by hand, so the deployed app is sometimes ahead of the
// database. Every Supabase error passes through here so "relation does not
// exist" becomes an instruction ("run migration X") instead of a dead screen.

interface PgError {
  code?: string;
  message?: string;
  details?: string;
}

export function explainDbError(err: unknown): string {
  const e = (err ?? {}) as PgError;
  const msg = e.message ?? String(err);

  // 42P01: undefined table. The app expects a table a migration hasn't
  // created yet.
  if (e.code === "42P01") {
    return (
      `The database is missing a table this screen needs (${extractQuoted(msg)}). ` +
      "The app is ahead of the database: open supabase/migrations/ in the repo, " +
      "find the first migration you haven't run, and run it in the Supabase SQL editor. " +
      "Everything else keeps working meanwhile."
    );
  }

  // 42703 (undefined column) / PGRST204 (PostgREST can't find a column on
  // write): same situation, column-sized.
  if (e.code === "42703" || e.code === "PGRST204") {
    return (
      `The database is missing a column this screen writes (${extractQuoted(msg)}). ` +
      "Run the latest file in supabase/migrations/ via the Supabase SQL editor, then retry."
    );
  }

  // 23514: a CHECK constraint rejected a value — usually the app's option
  // list is newer than the database's constraint.
  if (e.code === "23514") {
    return (
      "The database rejected a value its rules don't allow yet " +
      `(${extractQuoted(msg)}). Run the latest migration in supabase/migrations/, then retry.`
    );
  }

  // 42501 / PGRST301: RLS said no. Almost always: signed in with an email
  // that is not the owner email baked into is_owner() in migration 001.
  if (e.code === "42501" || e.code === "PGRST301") {
    return (
      "The database refused access. You are probably signed in with an email " +
      "that isn't the owner email set in migration 001 (is_owner function)."
    );
  }

  return `Database error: ${msg}`;
}

function extractQuoted(msg: string): string {
  const m = msg.match(/["']([^"']+)["']/);
  return m ? m[1] : msg;
}
