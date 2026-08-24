import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "../../../../../lib/supabase/server";
import { AskChat } from "./ask-chat";

export const dynamic = "force-dynamic";

export default async function AskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireUser();
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name")
    .eq("id", id)
    .single();
  if (!monitor) notFound();

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1>{monitor.name} — ask</h1>
        <div className="spacer" />
        <Link className="btn" href={`/monitors/${id}`}>Dashboard</Link>
      </div>
      <AskChat monitorId={monitor.id} />
    </>
  );
}
