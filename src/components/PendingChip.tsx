import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

// Small "N pending" chip for venture pages: the approvals inbox lives on the
// home page (one fixed place), so venture pages just signal and link.

export function PendingChip({ ventureId }: { ventureId: string }) {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { count, error } = await supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .eq("venture_id", ventureId)
      .eq("status", "pending");
    if (!error) setCount(count ?? 0);
  }, [ventureId]);

  useEffect(() => {
    void load();
    if (!supabase) return;
    const channel = supabase
      .channel(`pending-chip-${ventureId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "proposals" }, () => void load())
      .subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      void supabase?.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, ventureId]);

  if (count === 0) return null;
  return (
    <Link to="/#approvals" className="chip chip-paused chip-link">
      {count} pending
    </Link>
  );
}
