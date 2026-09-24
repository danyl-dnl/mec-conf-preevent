import { createClient } from "@supabase/supabase-js";

const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || process.env || {};
const supabaseUrl = env.VITE_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || "placeholder-key";

export const supabase = createClient(supabaseUrl, supabaseKey);


export async function testSupabaseConnection() {
  const { error } = await supabase.auth.getSession();

  if (error) {
    console.error("Supabase test failed:", error.message);
    return;
  }

  console.log("Supabase Auth request completed successfully!");
}