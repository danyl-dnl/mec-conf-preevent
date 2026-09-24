# Level 1 paper-style puzzle authoring

Enter a puzzle code and hidden keyword, generate a preview, then save. Generation
and preview do not write to the database. Saving uses `admin_create_bank_puzzle`, which calls the existing puzzle-creation
RPC and registers the puzzle in the private allocation bank atomically. Editing the keyword
invalidates the preview. Generating a preview alone does not create live puzzles or change assignments.

Keywords contain 1–12 ASCII letters A–Y. Whitespace is ignored and letters are
uppercased. Z, punctuation, digits, and other characters are rejected. Existing
server answer normalization is unchanged: case-insensitive, surrounding whitespace
trimmed. Participants enter the keyword without internal spaces.

## Complementary shading rule

1. Convert the keyword to alphabet positions, then deduplicate the values.
2. Shuffle the unique clues into distinct positions of a 5×5 matrix.
3. At each clue position, put its number on one fragment and leave the other empty.
4. At every other position, shade one fragment and leave the other empty.
5. Balance number ownership and shading independently between A and B, each with
   a maximum count difference of one. Randomly assign any extra cell.

Only NUMBER + EMPTY, EMPTY + NUMBER, SHADED + EMPTY and EMPTY + SHADED are
valid coordinate pairs. There are no numbered decoys, STEP markers or encoded
letter ordering. At most six cells per fragment contain numbers under the
12-letter limit; at least 19 are shaded or empty.

Compare matching coordinates on both phones. Ignore any coordinate shaded on
either side. Keep the number from each remaining clue coordinate, convert it
using A=1 through Y=25, and discover the keyword from the resulting letter set.

SPIDERMAN has nine clues: {19,16,9,4,5,18,13,1,14}.
BATMAN encodes {2,1,20,13,14}: its repeated A uses one cell. The letter set does
not encode order or multiplicity and can fit multiple words. A one-value keyword
also cannot split its sole clue between both participants. These are properties
of the requested paper mechanic, not guarantees of unique word recovery or
cryptographic secrecy. The private backend answer validates the intended word.

## Storage, rendering and admin overlay

The existing generic JSON string-grid contract is preserved. An empty string
means EMPTY; the reserved string `█` means SHADED; decimal strings `1` through
`25` are NUMBER cells. The renderer draws shading with a filled hatch pattern,
empty cells with borders, and centered numbers. Other stored strings still render
as legacy text; existing puzzles are not regenerated or migrated.

The admin preview shows the full letter-by-letter encoding, both fragments,
and an actual combined overlay calculated only from those fragments. It also
shows surviving values/letters in spatial reading order and the expected keyword.
It explicitly explains deduplication and lack of word ordering.

`combineGrids` checks the two permitted pair types and unique numbers. Shaded
positions disappear from its overlay; numbers opposite empty cells survive. It
does not consult the keyword. Tests independently compare the resulting values
with the expected unique alphabet set.

Only grid A, grid B, and the correct answer are sent to the admin save RPC. No encoding or combined overlay is added to participant-facing APIs. The
participant gets only their assigned grid. The bank adds private allocation records and admin-only wrapper RPCs. Existing
auth, roster, partner verification, answer validation, uploads, completion and
admin authorization rules are preserved.

## Verification

- `npm test`: randomized construction invariants, real overlay combination,
  duplicate-letter handling, rendering, state privacy and photo-handler tests.
- `python3 -m unittest discover -s supabase/tests`: temporary isolated PostgreSQL
  databases, including generated-grid storage and participant RPC isolation.
  Requires PostgreSQL tools and permission for local shared memory.
- `npm run build`: TypeScript and Vite production build.
- `npm run lint` and `git diff --check`.

Mobile layout uses fluid width, five equal columns, square cells, and no fixed
minimum width. Rendering/CSS contract tests cover these properties. Browser visual
QA remains unverified: earlier local-file preview navigation was blocked by the
browser URL policy.

## Thirty-puzzle bank and automatic assignment

`supabase/seeds/level1_puzzle_bank.sql` holds 30 space-themed keywords and their
validated complementary grids. These server-side seed files are not frontend
assets. Every seed has a distinct keyword and distinct unique-letter clue set.
The authoring script is `scripts/generate-puzzle-bank.mjs`; running it rewrites
local seed layouts. Reapplying the SQL seed does not replace saved content.

Apply migration `20260924010000_level1_puzzle_bank.sql` before the seed.
`admin_create_pair_with_puzzle` wraps the existing pairing RPC and allocator in
one transaction. Both manual and random pairing use it. If the bank is exhausted,
the new pair rolls back rather than being left without a puzzle. Random pairing
stops on a failure and reports how many prior pairs were confirmed.

Bank reservations are private and each is locked during allocation. A reservation
cannot be reused for another pair, even through manual assignment. Custom puzzles
saved in the admin generator join the bank; duplicate bank keywords are rejected.
Existing non-bank puzzle assignments retain their previous behavior.

The admin panel displays total/unused puzzles and pending pairs. The
`admin_assign_pending_puzzles` RPC fills only pairs with no puzzle, preserving
verification, attempts, answers, photo state, and existing assignments. It is
idempotent; if there are not enough unused puzzles, the entire backfill rolls back.
The status and allocator APIs never return keywords or combined solutions.
