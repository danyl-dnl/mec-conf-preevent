import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

export const supabase = createClient(supabaseUrl, supabaseKey);


export async function testSupabaseConnection() {
  const { error } = await supabase.auth.getSession();

  if (error) {
    console.error("Supabase test failed:", error.message);
    return;
  }

  console.log("Supabase Auth request completed successfully!");
}