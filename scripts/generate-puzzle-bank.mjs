// Run with Node 24: node scripts/generate-puzzle-bank.mjs
// Organizer-only seed authoring. Never import this file into the frontend.
import { writeFileSync } from 'node:fs';
import { generatePuzzle, combineGrids } from '../src/features/level1/generator.ts';
const words = [
  // Retained space words (simple 5-6 letter favorites)
  'COMET',
  'ORBIT',
  'PLANET',
  'GALAXY',
  'ROCKET',
  'METEOR',
  'SATURN',
  'COSMIC',
  'NEBULA',
  'SHUTTLE',

  // Real-life / Pop culture / Diverse everyday words (no Z, <=12 chars)
  'SPIDERMAN',
  'BATMAN',
  'AVENGER',
  'CHAMPION',
  'PYRAMID',
  'DIAMOND',
  'VOLCANO',
  'DOLPHIN',
  'PANTHER',
  'PHOENIX',
  'GUITAR',
  'VIKING',
  'SAMURAI',
  'COMPASS',
  'RAINBOW',
  'TSUNAMI',
  'LANTERN',
  'CAMERA',
  'ORIGAMI',
  'FOOTBALL'
];
const sets = new Set();
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const lines = ['-- Private organizer seed: 30 paper puzzles (space & real-life themes). Do not serve as a public asset.',
  '-- Reapplying updates puzzle content while preserving puzzle IDs and references.', 'BEGIN;'];
for (const [i, word] of words.entries()) {
  const p = generatePuzzle(word);
  const combined = combineGrids(p.gridA,p.gridB).values.toSorted((a,b)=>a-b);
  const expected = [...new Set(p.encoding)].toSorted((a,b)=>a-b);
  if (JSON.stringify(combined)!==JSON.stringify(expected)) throw Error('Invalid overlay');
  const signature=JSON.stringify(expected);
  if (sets.has(signature)) throw Error('Duplicate letter set');
  sets.add(signature);
  const code = `EVENT-L1-${String(i+1).padStart(3,'0')}`;
  lines.push(`INSERT INTO public.puzzles (puzzle_code, grid_a, grid_b, correct_answer) VALUES (${literal(code)}, ${literal(JSON.stringify(p.gridA))}::jsonb, ${literal(JSON.stringify(p.gridB))}::jsonb, ${literal(word)}) ON CONFLICT (puzzle_code) DO UPDATE SET grid_a = EXCLUDED.grid_a, grid_b = EXCLUDED.grid_b, correct_answer = EXCLUDED.correct_answer;`);
  lines.push(`INSERT INTO public.level1_puzzle_bank (puzzle_id) SELECT id FROM public.puzzles WHERE puzzle_code=${literal(code)} ON CONFLICT (puzzle_id) DO NOTHING;`);
}
lines.push('COMMIT;');
writeFileSync(new URL('../supabase/seeds/level1_puzzle_bank.sql',import.meta.url), lines.join('\n')+'\n');
console.log('Prepared 30 distinct keywords, letter sets and complementary grid pairs.');
