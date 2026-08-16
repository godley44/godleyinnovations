// Rendered when the Supabase env vars aren't set. A fresh Vercel deploy hits
// this instead of a blank page, and it tells you exactly what to do.
import { missingEnvVars } from "../lib/supabase";

export function SetupScreen() {
  return (
    <div className="auth-wrap">
      <h1>Godley Innovations Studio</h1>
      <p>
        The app is deployed but not connected to a database yet. Missing
        environment variable{missingEnvVars.length > 1 ? "s" : ""}:
      </p>
      <ul>
        {missingEnvVars.map((v) => (
          <li key={v}>
            <code>{v}</code>
          </li>
        ))}
      </ul>
      <ol>
        <li>Create a project at supabase.com (free tier is fine).</li>
        <li>
          In Supabase: Project Settings → API. Copy the <em>Project URL</em> and
          the <em>anon public</em> key. (Never the service_role key — that one
          must never reach a browser.)
        </li>
        <li>
          In Vercel: Project → Settings → Environment Variables. Add{" "}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>.
        </li>
        <li>Redeploy, then run the migrations in supabase/migrations/ (in order) in the Supabase SQL editor.</li>
      </ol>
    </div>
  );
}
