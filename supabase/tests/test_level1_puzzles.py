"""Isolated PostgreSQL tests. Run: python3 -m unittest discover -s supabase/tests."""
import json
import unittest
from test_partner_verification import VerificationTests, ROOT


class PuzzleTests(VerificationTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sql((ROOT / 'supabase/migrations/20260923200000_level1_puzzles.sql').read_text())

    def setUp(self):
        super().setUp()
        self.sql('TRUNCATE public.puzzles CASCADE')
        self.admin = self.create_admin()
        self.a = self.create_participant('A')
        self.b = self.create_participant('B')
        self.create_pair(self.admin, 'A', 'B')
        self.pair = self.q_one('SELECT pair_code FROM public.pairs')

    def call(self, query, uid=None):
        return json.loads(self.q_one(query, uid=uid or self.admin))

    def denied(self, query, uid=None):
        return self.sql(f"SET request.jwt.claim.sub = '{uid or self.a}'; SET ROLE authenticated; " + query, success=False)

    def configure(self):
        self.call('''SELECT public.admin_create_puzzle('P1', '[ ["A", ""], ["", "C"] ]', '[ ["", "B"], ["D", ""] ]', ' HeLLo ')''')
        self.call(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'P1')")

    def verify(self):
        self.call("SELECT public.verify_my_partner('B')", self.a)
        self.call("SELECT public.verify_my_partner('A')", self.b)

    def test_puzzle_table_security(self):
        self.configure()
        self.assertEqual(self.q_one("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.puzzles'::regclass"), 't')
        for role in ('anon', 'authenticated'):
            for query in ('SELECT * FROM public.puzzles', "UPDATE public.puzzles SET correct_answer = 'bad'", 'DELETE FROM public.puzzles'):
                self.sql(f'SET ROLE {role}; {query}', success=False)
        for name in ('admin_create_puzzle', 'admin_list_puzzles', 'admin_assign_puzzle_to_pair', 'get_my_level1_state', 'submit_level1_answer'):
            self.assertEqual(self.q_one(f"SELECT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=\"\"'] AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE proname = '{name}'"), 't')

    def test_grid_validation(self):
        invalid = [None, {}, [], [[]], ['row'], [[1]], [[None]], [['a'], ['b', 'c']], [['a']]*11, [['a']*11], [['a'*129]]]
        for grid in invalid:
            with self.subTest(grid=grid):
                payload = json.dumps(grid).replace("'", "''")
                self.denied(f"SELECT public.admin_create_puzzle('BAD', '{payload}', '[[\"b\"]]', 'answer')", self.admin)
        self.call("SELECT public.admin_create_puzzle('RECT', '[[\"a\",\"b\",\"c\",\"d\"]]', '[[\"\",\"\",\"\",\"\"]]', 'ok')")
        self.denied("SELECT public.admin_create_puzzle('MISMATCH', '[[\"a\"]]', '[[\"b\",\"c\"]]', 'ok')", self.admin)
        for code, answer in [("' '", "'ok'"), ('NULL', "'ok'"), ("'OK'", "' '"), ("'OK'", 'NULL')]:
            self.denied(f"SELECT public.admin_create_puzzle({code}, '[[\"a\"]]', '[[\"b\"]]', {answer})", self.admin)

    def test_admin_create_list_and_assign(self):
        self.configure()
        data = self.call("SELECT row_to_json(t) FROM public.admin_list_puzzles() t")
        self.assertEqual(data, dict(puzzle_code='P1', grid_rows=2, grid_columns=2, assigned_pair_count=1))
        self.verify()
        result = self.call(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'P1')")
        self.assertEqual(result, dict(pair_code=self.pair, puzzle_code='P1'))
        self.assertTrue(self.call('SELECT public.get_my_pair_state()', self.a)['mutual_verified'])
        for query in ["SELECT public.admin_create_puzzle('P2', '[[\"a\"]]', '[[\"b\"]]', 'ok')", 'SELECT * FROM public.admin_list_puzzles()', f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'P1')"]:
            self.denied(query)
        self.denied("SELECT public.admin_assign_puzzle_to_pair('missing', 'P1')", self.admin)
        self.denied(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'missing')", self.admin)

    def test_state_privacy_and_gates(self):
        c = self.create_participant('C')
        self.assertEqual(self.call('SELECT public.get_my_level1_state()', c)['status'], 'NOT_PAIRED')
        self.assertEqual(self.call('SELECT public.get_my_level1_state()', self.a)['status'], 'NO_PUZZLE')
        self.denied("SELECT public.submit_level1_answer('hello')")
        self.configure()
        for uid, grid in [(self.a, [['A', ''], ['', 'C']]), (self.b, [['', 'B'], ['D', '']])]:
            data = self.call('SELECT public.get_my_level1_state()', uid)
            self.assertEqual(data['assigned_grid'], grid)
            self.assertEqual(data['status'], 'FIND_PARTNER')
            self.assertEqual(set(data), {'status', 'name', 'participant_code', 'fragment_slot', 'assigned_grid', 'mutual_verified', 'solved'})
        self.denied("SELECT public.submit_level1_answer('hello')")
        self.call("SELECT public.verify_my_partner('B')", self.a)
        self.denied("SELECT public.submit_level1_answer('hello')")
        self.call("SELECT public.verify_my_partner('A')", self.b)
        self.assertEqual(self.call('SELECT public.get_my_level1_state()', self.a)['status'], 'READY_TO_SOLVE')

    def test_normalized_solve_shared_idempotent_and_reassignment(self):
        self.configure()
        self.verify()
        for answer in ("' '", 'NULL'):
            self.denied(f'SELECT public.submit_level1_answer({answer})')
        self.assertEqual(self.call("SELECT public.submit_level1_answer('wrong')", self.a), {'status': 'INCORRECT'})
        self.assertEqual(self.q_one('SELECT solved_at IS NULL FROM public.pairs'), 't')
        solved = self.call("SELECT public.submit_level1_answer('  HELLO  ')", self.a)
        self.assertEqual(set(solved), {'status', 'solved_at'})
        self.assertEqual(solved['status'], 'SOLVED')
        self.assertIsNotNone(solved['solved_at'])
        other = self.call('SELECT public.get_my_level1_state()', self.b)
        self.assertEqual(other['status'], 'SOLVED')
        self.assertEqual(other['solved_at'], solved['solved_at'])
        self.assertEqual(other['assigned_grid'], [['', 'B'], ['D', '']])
        self.assertEqual(self.call("SELECT public.submit_level1_answer('hello')", self.b), solved)
        self.call(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'P1')")
        self.call("SELECT public.admin_create_puzzle('P2', '[[\"a\"]]', '[[\"b\"]]', 'ok')")
        self.denied(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'P2')", self.admin)

    def test_rpc_auth_and_unlinked_access(self):
        for query in ['SELECT public.get_my_level1_state()', "SELECT public.submit_level1_answer('hello')", 'SELECT * FROM public.admin_list_puzzles()']:
            self.sql('SET ROLE anon; ' + query, success=False)
        self.denied('SELECT public.get_my_level1_state()', self.admin)
        self.denied("SELECT public.submit_level1_answer('hello')", self.admin)


if __name__ == '__main__':
    unittest.main()
