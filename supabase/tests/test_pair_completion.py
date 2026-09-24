"""Trusted completion, concurrency, privacy, progress and recovery tests."""
import json
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
import test_partner_verification as verification
import test_level1_puzzles as puzzle


class CompletionTests(verification.VerificationTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sql((verification.ROOT / 'supabase/migrations/20260923200000_level1_puzzles.sql').read_text())
        cls.sql((verification.ROOT / 'supabase/migrations/20260923210000_pair_photo_completion.sql').read_text())

    def setUp(self):
        super().setUp()
        self.sql('TRUNCATE public.puzzles CASCADE')
        self.admin = self.create_admin()
        self.a = self.create_participant('A')
        self.b = self.create_participant('B')
        self.create_pair(self.admin, 'A', 'B')
        self.pair = self.q_one('SELECT pair_code FROM public.pairs')

    call = puzzle.PuzzleTests.call
    denied = puzzle.PuzzleTests.denied
    configure = puzzle.PuzzleTests.configure
    verify = puzzle.PuzzleTests.verify

    def service(self, query, success=True):
        result, error = self.sql('SET ROLE service_role; ' + query, success=success)
        return json.loads(result) if success and result else error

    def ready(self):
        self.configure()
        self.verify()
        self.call("SELECT public.submit_level1_answer('hello')", self.a)

    def claim(self, actor=None):
        return self.service(f"SELECT public.begin_pair_photo_upload('{actor or self.a}')")

    def finish(self, claim, actor=None, success=True, url=None):
        url = url or 'https://res.cloudinary.com/test/image/upload/v1/' + claim['photo_public_id'] + '.jpg'
        return self.service(f"SELECT public.finalize_pair_photo_upload('{actor or self.a}', '{claim['upload_token']}', '{url}', '{claim['photo_public_id']}')", success=success)

    def progress(self):
        return self.call("SELECT COALESCE(json_agg(t), '[]') FROM public.admin_level1_progress() t")

    def test_generated_puzzle_private_roundtrip(self):
        # Generate fresh, disposable content using the actual admin generator.
        generated = json.loads(subprocess.check_output([
            'node', '--input-type=module', '-e',
            "import {generatePuzzle} from './src/features/level1/generator.ts'; console.log(JSON.stringify(generatePuzzle('spider man')))",
        ], cwd=verification.ROOT, text=True))
        a = json.dumps(generated['gridA'])
        b = json.dumps(generated['gridB'])
        self.call(f"SELECT public.admin_create_puzzle('GENERATED', '{a}', '{b}', 'SPIDERMAN')")
        self.call(f"SELECT public.admin_assign_puzzle_to_pair('{self.pair}', 'GENERATED')")
        allowed = {'status', 'name', 'participant_code', 'fragment_slot', 'assigned_grid',
                   'mutual_verified', 'solved', 'photo_uploaded', 'completed', 'completed_at'}
        for verified in (False, True):
            if verified:
                self.verify()
            for uid, slot, grid in [(self.a, 'A', generated['gridA']), (self.b, 'B', generated['gridB'])]:
                state = self.call('SELECT public.get_my_level1_state()', uid)
                self.assertEqual(set(state), allowed)
                self.assertEqual(state['fragment_slot'], slot)
                self.assertEqual(state['assigned_grid'], grid)
                self.assertNotIn('SPIDERMAN', json.dumps(state))
                self.assertEqual(state['status'], 'READY_TO_SOLVE' if verified else 'FIND_PARTNER')
        # Independently combine the persisted fragments returned to their owners.
        saved_a = self.call('SELECT public.get_my_level1_state()', self.a)['assigned_grid']
        saved_b = self.call('SELECT public.get_my_level1_state()', self.b)['assigned_grid']
        survivors = []
        for row_a, row_b in zip(saved_a, saved_b):
            for cell_a, cell_b in zip(row_a, row_b):
                self.assertNotEqual(cell_a == '', cell_b == '')
                if '█' not in (cell_a, cell_b):
                    survivors.append(int(cell_a or cell_b))
        self.assertEqual(sorted(survivors), sorted([19, 16, 9, 4, 5, 18, 13, 1, 14]))
        self.denied('SELECT correct_answer, grid_a, grid_b FROM public.puzzles')
        self.assertEqual(self.call("SELECT public.submit_level1_answer(' spiderman ')", self.a)['status'], 'SOLVED')
        for uid, grid in [(self.a, generated['gridA']), (self.b, generated['gridB'])]:
            state = self.call('SELECT public.get_my_level1_state()', uid)
            self.assertEqual(set(state), allowed | {'solved_at'})
            self.assertEqual(state['assigned_grid'], grid)
            self.assertNotIn('SPIDERMAN', json.dumps(state))

    def test_requires_valid_solved_mutual_pair(self):
        self.assertEqual(self.claim()['status'], 'NOT_ELIGIBLE')
        self.configure()
        self.assertEqual(self.claim()['status'], 'NOT_ELIGIBLE')
        self.verify()
        self.assertEqual(self.claim()['status'], 'NOT_ELIGIBLE')
        self.assertEqual(self.claim(self.admin)['status'], 'NOT_ELIGIBLE')
        self.assertEqual(self.claim(str(uuid.uuid4()))['status'], 'NOT_ELIGIBLE')
        # Finalization independently rechecks the gate, even for a formerly valid reservation.
        self.call("SELECT public.submit_level1_answer('hello')", self.a)
        claim = self.claim()
        self.sql('UPDATE public.pairs SET solved_at = NULL')
        self.assertIn('not ready', self.finish(claim, success=False))

    def test_success_shared_private_and_idempotent(self):
        self.ready()
        claim = self.claim()
        completed = self.finish(claim)
        self.assertEqual(completed['status'], 'COMPLETED')
        self.assertTrue(completed['completed_at'])
        self.assertEqual(self.finish(claim), completed)
        self.assertEqual(self.claim(self.b)['status'], 'ALREADY_COMPLETED')
        for actor in (self.a, self.b):
            state = self.call('SELECT public.get_my_level1_state()', actor)
            self.assertEqual(state['status'], 'COMPLETED')
            self.assertTrue(state['photo_uploaded'])
            self.assertTrue(state['completed'])
            self.assertEqual(state['completed_at'], completed['completed_at'])
            self.assertEqual(set(state), {'status', 'participant_code', 'name', 'fragment_slot', 'assigned_grid', 'mutual_verified', 'solved', 'solved_at', 'photo_uploaded', 'completed', 'completed_at'})
        self.assertEqual(self.q_one('SELECT photo_url IS NOT NULL AND photo_public_id IS NOT NULL AND completed_at IS NOT NULL AND photo_upload_token IS NULL FROM public.pairs'), 't')

    def test_concurrent_claim_and_finalize(self):
        self.ready()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.claim, (self.a, self.b)))
        self.assertEqual(sorted(x['status'] for x in results), ['RESERVED', 'UPLOAD_IN_PROGRESS'])
        claim = next(x for x in results if x['status'] == 'RESERVED')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.finish(claim), range(2)))
        self.assertEqual(results[0], results[1])

    def test_expired_or_released_reservation_uses_same_asset(self):
        self.ready()
        first = self.claim()
        self.sql("UPDATE public.pairs SET photo_upload_started_at = now() - interval '6 minutes'")
        second = self.claim(self.b)
        self.assertNotEqual(first['upload_token'], second['upload_token'])
        self.assertEqual(first['photo_public_id'], second['photo_public_id'])
        self.assertIn('not authorized', self.finish(first, success=False))
        self.service(f"SELECT public.release_pair_photo_upload('{self.a}', '{second['upload_token']}')")
        self.assertEqual(self.claim()['status'], 'RESERVED')

    def test_finalization_checks_actor_token_metadata_and_verification(self):
        self.ready()
        claim = self.claim()
        self.assertIn('not authorized', self.finish(claim, actor=self.admin, success=False))
        forged = dict(claim, upload_token=str(uuid.uuid4()))
        self.assertIn('not authorized', self.finish(forged, success=False))
        self.assertIn('Invalid photo', self.finish(claim, url='https://evil.example/photo', success=False))
        self.call("SELECT public.admin_reset_partner_verification('A')")
        self.assertIn('not ready', self.finish(claim, success=False))

    def test_trusted_functions_and_direct_mutation_denied(self):
        self.ready()
        claim = self.claim()
        queries = [f"SELECT public.begin_pair_photo_upload('{self.a}')",
                   f"SELECT public.release_pair_photo_upload('{self.a}', '{claim['upload_token']}')",
                   f"SELECT public.finalize_pair_photo_upload('{self.a}', '{claim['upload_token']}', 'https://res.cloudinary.com/test/image/upload/x.jpg', '{claim['photo_public_id']}')",
                   "UPDATE public.pairs SET completed_at = now()"]
        for role in ('authenticated', 'anon'):
            for query in queries:
                self.sql(f"SET request.jwt.claim.sub = '{self.a}'; SET ROLE {role}; " + query, success=False)
        for name in ('begin_pair_photo_upload', 'finalize_pair_photo_upload', 'release_pair_photo_upload'):
            self.assertEqual(self.q_one(f"SELECT prosecdef AND proowner = 'postgres'::regrole AND proconfig = ARRAY['search_path=\"\"'] AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM pg_proc WHERE proname = '{name}'"), 't')

    def test_admin_progress_security_and_lock_recovery(self):
        self.configure()
        self.call("SELECT public.verify_my_partner('wrong')", self.a)
        self.call("SELECT public.verify_my_partner('wrong')", self.a)
        self.call("SELECT public.verify_my_partner('A')", self.b)
        row = self.progress()[0]
        self.assertTrue(row['a_locked'])
        self.assertFalse(row['b_locked'])
        self.assertTrue(row['b_verified'])
        self.assertFalse(row['mutual_verified'])
        self.assertEqual(set(row), {'pair_code', 'member_a_code', 'member_a_name', 'member_b_code', 'member_b_name', 'puzzle_code', 'a_verified', 'b_verified', 'mutual_verified', 'a_locked', 'b_locked', 'solved', 'photo_uploaded', 'completed', 'completed_at'})
        self.denied('SELECT * FROM public.admin_level1_progress()')
        self.sql('SET ROLE anon; SELECT * FROM public.admin_level1_progress()', success=False)
        self.denied("SELECT public.admin_reset_partner_verification('A')")
        self.call("SELECT public.admin_reset_partner_verification('A')")
        row = self.progress()[0]
        self.assertFalse(row['a_locked'])
        self.assertTrue(row['b_verified'])
        self.assertFalse(row['a_verified'])

    def test_reset_does_not_clear_completion_or_solved_state(self):
        self.ready()
        self.finish(self.claim())
        before = self.progress()[0]
        self.call("SELECT public.admin_reset_partner_verification('A')")
        after = self.progress()[0]
        for key in ('solved', 'photo_uploaded', 'completed', 'completed_at'):
            self.assertEqual(before[key], after[key])
        self.assertTrue(after['b_verified'])
        self.assertEqual(self.call('SELECT public.get_my_level1_state()', self.a)['status'], 'COMPLETED')
