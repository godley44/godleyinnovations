import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MODULES } from "../modules/config.ts";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";
import { RecordSection } from "../components/RecordSection";
import { PendingChip } from "../components/PendingChip";
import { WeeklyBriefCard } from "../components/WeeklyBriefCard";
import { VENTURE_LEAD_CARDS } from "../modules/ventureLayout.ts";
import { OverviewTab } from "./tabs/OverviewTab";
import { VentureDetails } from "./tabs/VentureDetails";

export interface VentureRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  thesis: string | null;
  notes: string | null;
}

// A venture's workspace: the "folder" for one project. Tabs come straight
// from the module config; adding a module there adds it to every venture with
// no route changes (and the guard script keeps config honest).
export function Venture() {
  const { ventureSlug, tab } = useParams();
  const navigate = useNavigate();
  const [venture, setVenture] = useState<VentureRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const activeTab = tab ?? "overview";

  const load = useCallback(async () => {
    if (!supabase || !ventureSlug) return;
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("ventures")
      .select("*")
      .eq("slug", ventureSlug)
      .maybeSingle();
    if (error) setError(explainDbError(error));
    else if (!data) setError(`No venture called “${ventureSlug}”. It may have been renamed or deleted.`);
    else setVenture(data as VentureRecord);
    setLoading(false);
  }, [ventureSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const module = MODULES.find((m) => m.slug === activeTab);
  const validTab = activeTab === "overview" || module !== undefined;

  useEffect(() => {
    if (!validTab) navigate(`/v/${ventureSlug}`, { replace: true });
  }, [validTab, navigate, ventureSlug]);

  if (loading) return <div className="center-note">Loading…</div>;
  if (error || !venture) {
    return (
      <div className="page">
        <p className="error-banner">{error ?? "Venture not found."}</p>
        <Link to="/">← All ventures</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <Link to="/" className="muted">
            ← All ventures
          </Link>
          <h1>
            {venture.name} <span className={`chip chip-${venture.status}`}>{venture.status}</span>{" "}
            <PendingChip ventureId={venture.id} />
          </h1>
          {venture.thesis && <p className="muted">{venture.thesis}</p>}
        </div>
      </header>

      <nav className="tabs">
        <Link to={`/v/${venture.slug}`} className={activeTab === "overview" ? "tab active" : "tab"}>
          Overview
        </Link>
        {MODULES.map((m) => (
          <Link
            key={m.slug}
            to={`/v/${venture.slug}/${m.slug}`}
            className={activeTab === m.slug ? "tab active" : "tab"}
          >
            {m.title}
          </Link>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <>
          {(VENTURE_LEAD_CARDS[venture.slug] ?? []).includes("weekly-brief") && (
            <WeeklyBriefCard ventureId={venture.id} />
          )}
          <OverviewTab ventureId={venture.id} />
          <VentureDetails venture={venture} onChanged={load} />
        </>
      ) : (
        module?.sections.map((section) => (
          <RecordSection key={section.id} ventureId={venture.id} spec={section} />
        ))
      )}
    </div>
  );
}
