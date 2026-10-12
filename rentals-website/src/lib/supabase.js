import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://ipnjbzbsnmkfrjaaidoj.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwbmpiemJzbm1rZnJqYWFpZG9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NjY5MjYsImV4cCI6MjEwNzM0MjkyNn0.KvJ3Q8gsgiRedOLL2R_Zrg2Cf5HVIlIofDWp8sM-Tsw';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
