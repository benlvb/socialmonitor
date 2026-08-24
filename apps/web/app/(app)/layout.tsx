import type { ReactNode } from "react";
import Link from "next/link";
import { supabaseConfigured } from "../../lib/supabase/server";
import { signOut } from "./actions";

export default function AppLayout({ children }: { children: ReactNode }) {
  if (!supabaseConfigured()) {
    return (
      <main style={{ maxWidth: 560, margin: "10vh auto", padding: 16 }}>
        <div className="card">
          <h1>socialmonitor — setup required</h1>
          <p>
            Supabase is not configured yet (template-first mode). To activate the app:
          </p>
          <ol>
            <li>Create a Supabase project and apply the migrations in <span className="mono">packages/db/supabase/migrations</span></li>
            <li>Fill <span className="mono">NEXT_PUBLIC_SUPABASE_URL</span>, <span className="mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span>, <span className="mono">SUPABASE_SERVICE_ROLE_KEY</span>, <span className="mono">DATABASE_URL</span></li>
            <li>Restart the app and sign in with an allowlisted email</li>
          </ol>
          <p className="muted">Everything else (worker, adapters, fixtures) already works without credentials.</p>
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">socialmonitor</div>
        <Link href="/">Monitors</Link>
        <Link href="/connections">Connections</Link>
        <div className="spacer" />
        <form action={signOut}>
          <button type="submit" style={{ width: "100%" }}>Sign out</button>
        </form>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
