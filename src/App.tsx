import { Navigate, Route, Routes } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { AuthGate } from "./components/AuthGate";
import { SetupScreen } from "./pages/SetupScreen";
import { Home } from "./pages/Home";
import { Venture } from "./pages/Venture";

export default function App() {
  // No env vars yet (fresh deploy): show setup instructions, not a crash.
  if (!supabase) return <SetupScreen />;

  return (
    <AuthGate>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* One route serves every venture and every tab; the tab param is
            validated against the module config inside Venture. */}
        <Route path="/v/:ventureSlug" element={<Venture />} />
        <Route path="/v/:ventureSlug/:tab" element={<Venture />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthGate>
  );
}
