"""Private bank construction, allocation, concurrency, exhaustion and RPC privacy."""
import json
from concurrent.futures import ThreadPoolExecutor
import test_partner_verification as verification


class PuzzleBankTests(verification.VerificationTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for migration in ['20260923200000_level1_puzzles.sql', '20260923210000_pair_photo_completion.sql',
                          '20260924010000_level1_puzzle_bank.sql']:
            cls.sql((verification.ROOT / 'supabase/migrations' / migration).read_text())

    def setUp(self):
        super().setUp()
        self.sql('TRUNCATE public.puzzles CASCADE')
        self.sql((verification.ROOT / 'supabase/seeds/level1_puzzle_bank.sql').read_text())
        self.admin = self.create_admin()

    def call(self, sql, uid=None):
        return json.loads(self.q_one(sql, uid=uid or self.admin))

    def make_pair(self, a, b):
        return self.call(f"SELECT public.admin_create_pair_with_puzzle('{a}', '{b}')")

    def test_seed_has_30_unique_valid_paper_puzzles_and_is_idempotent(self):
        rows = json.loads(self.q_one('SELECT json_agg(p) FROM public.puzzles p'))
        self.assertEqual(len(rows), 30)
        signatures = set()
        for row in rows:
            expected = {ord(c) - 64 for c in row['correct_answer']}
            signatures.add(tuple(sorted(expected)))
            survivors = []
            for grid in [row['grid_a'], row['grid_b']]:
                self.assertEqual(len(grid), 5)
                self.assertTrue(all(len(r) == 5 for r in grid))
                self.assertLess(sum(c.isdigit() for r in grid for c in r), 13)
            for ar, br in zip(row['grid_a'], row['grid_b']):
                for a, b in zip(ar, br):
                    self.assertNotEqual(a == '', b == '')
                    if '█' not in (a, b): survivors.append(int(a or b))
            self.assertEqual(set(survivors), expected)
            self.assertEqual(len(survivors), len(expected))
            self.assertTrue(all(1 <= n <= 25 for n in survivors))
        self.assertEqual(len(signatures), 30)
        self.sql((verification.ROOT / 'supabase/seeds/level1_puzzle_bank.sql').read_text())
        self.assertEqual(self.call('SELECT public.admin_puzzle_bank_status()'), dict(total=30, available=30, pending_pairs=0))

    def test_new_pair_gets_private_complementary_puzzle(self):
        a = self.create_participant('A'); b = self.create_participant('B')
        pair = self.make_pair('A', 'B')
        grids = json.loads(self.q_one('SELECT json_build_object(\'A\', p.grid_a, \'B\', p.grid_b) FROM public.puzzles p JOIN public.pairs r ON r.puzzle_id=p.id'))
        for uid, slot in [(a,'A'),(b,'B')]:
            result = self.call('SELECT public.get_my_level1_state()', uid)
            self.assertEqual(result['status'], 'FIND_PARTNER')
            self.assertEqual(result['fragment_slot'], slot)
            self.assertEqual(result['assigned_grid'], grids[slot])
            self.assertEqual(set(result), {'status','name','participant_code','fragment_slot','assigned_grid',
                'mutual_verified','solved','photo_uploaded','completed','completed_at'})
        self.assertEqual(set(pair), {'success','pair_code','member_a','member_b'})
        self.assertEqual(self.call('SELECT public.admin_puzzle_bank_status()')['available'], 29)

    def test_concurrent_creations_get_different_puzzles(self):
        for code in ['A','B','C','D']: self.create_participant(code)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda codes: self.make_pair(*codes), [('A','B'),('C','D')]))
        self.assertEqual(len(results), 2)
        self.assertEqual(self.q_one('SELECT count(DISTINCT puzzle_id) FROM public.pairs'), '2')
        self.assertEqual(self.q_one('SELECT count(DISTINCT assigned_pair_id) FROM public.level1_puzzle_bank'), '2')

    def test_exhaustion_rolls_back_pair_creation(self):
        self.sql('DELETE FROM public.level1_puzzle_bank')
        for code in ['A','B']: self.create_participant(code)
        self.sql(f"SET request.jwt.claim.sub='{self.admin}'; SET ROLE authenticated; SELECT public.admin_create_pair_with_puzzle('A','B')", success=False)
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pairs'), '0')
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pair_members'), '0')

    def test_backfill_preserves_existing_assignment_and_verification(self):
        for code in ['A','B','C','D']: self.create_participant(code)
        self.make_pair('A','B')
        old_id = self.q_one('SELECT puzzle_id FROM public.pairs')
        self.create_pair(self.admin,'C','D')
        self.sql("UPDATE public.pair_members SET verified_at=now()")
        self.assertEqual(self.call('SELECT public.admin_assign_pending_puzzles()'), {'assigned': 1})
        self.assertEqual(self.call('SELECT public.admin_assign_pending_puzzles()'), {'assigned': 0})
        self.assertEqual(self.q_one(f"SELECT count(*) FROM public.pairs WHERE puzzle_id='{old_id}'"), '1')
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pair_members WHERE verified_at IS NOT NULL'), '4')

    def test_backfill_exhaustion_is_atomic(self):
        for code in ['A','B','C','D']: self.create_participant(code)
        self.create_pair(self.admin,'A','B'); self.create_pair(self.admin,'C','D')
        self.sql('DELETE FROM public.level1_puzzle_bank WHERE puzzle_id NOT IN (SELECT puzzle_id FROM public.level1_puzzle_bank LIMIT 1)')
        self.sql(f"SET request.jwt.claim.sub='{self.admin}'; SET ROLE authenticated; SELECT public.admin_assign_pending_puzzles()", success=False)
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pairs WHERE puzzle_id IS NOT NULL'), '0')
        self.assertEqual(self.q_one('SELECT count(*) FROM public.level1_puzzle_bank WHERE assigned_pair_id IS NOT NULL'), '0')

    def test_bank_and_allocator_are_not_accessible_to_participants(self):
        user = self.create_participant('A')
        for query in ['SELECT * FROM public.level1_puzzle_bank', "SELECT public.allocate_level1_bank_puzzle('x')",
                      'SELECT public.admin_puzzle_bank_status()', 'SELECT public.admin_assign_pending_puzzles()',
                      "SELECT public.admin_create_pair_with_puzzle('A','B')",
                      "SELECT public.admin_create_bank_puzzle('X','[[\"1\"]]','[[\"\"]]','A')"]:
            for role in ['anon','authenticated']:
                self.sql(f"SET request.jwt.claim.sub='{user}'; SET ROLE {role}; {query}", success=False)

    def test_custom_bank_save_is_atomic_and_rejects_duplicate_keyword(self):
        self.call("SELECT public.admin_create_bank_puzzle('CUSTOM','[[\"1\"]]','[[\"\"]]','TEST')")
        self.assertEqual(self.call('SELECT public.admin_puzzle_bank_status()')['total'],31)
        self.sql(f"SET request.jwt.claim.sub='{self.admin}'; SET ROLE authenticated; SELECT public.admin_create_bank_puzzle('CUSTOM2','[[\"1\"]]','[[\"\"]]',' test ')", success=False)
        self.assertEqual(self.q_one("SELECT count(*) FROM public.puzzles WHERE puzzle_code='CUSTOM2'"),'0')

    def test_manual_assignment_cannot_reuse_a_reserved_bank_puzzle(self):
        for code in ['A','B','C','D']: self.create_participant(code)
        self.make_pair('A','B')
        self.create_pair(self.admin,'C','D')
        pending = self.q_one('SELECT pair_code FROM public.pairs WHERE puzzle_id IS NULL')
        used = self.q_one('SELECT puzzle_code FROM public.puzzles WHERE id IN (SELECT puzzle_id FROM public.pairs)')
        self.sql(f"SET request.jwt.claim.sub='{self.admin}'; SET ROLE authenticated; SELECT public.admin_assign_puzzle_to_pair('{pending}','{used}')", success=False)
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pairs WHERE puzzle_id IS NULL'),'1')
        self.call(f"SELECT public.admin_assign_puzzle_to_pair('{pending}','EVENT-L1-030')")
        self.assertEqual(self.call('SELECT public.admin_puzzle_bank_status()')['available'],28)
