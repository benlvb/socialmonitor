"use server";

import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { isAllowedEmail } from "../../lib/allowlist";

export interface AuthState {
  error?: string;
  message?: string;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!isAllowedEmail(email)) return { error: "This email is not on the allowlist." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  redirect("/");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!isAllowedEmail(email)) return { error: "This email is not on the allowlist." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };
  return { message: "Account created. If email confirmation is on, check your inbox — then sign in." };
}
