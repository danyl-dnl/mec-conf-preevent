"""Admin-only atomic deletion; never removes pairs, progress or auth accounts."""
import json
from concurrent.futures import ThreadPoolExecutor
import test_partner_verification as verification


class RosterDeleteTests(verification.VerificationTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sql((verification.ROOT / 'supabase/migrations/20260924020000_admin_delete_participants.sql').read_text())
        cls.sql((verification.ROOT / 'supabase/migrations/20260924030000_allow_delete_paired_participants.sql').read_text())

    def setUp(self):
        super().setUp()
        self.admin = self.create_admin()

    def delete(self, codes):
        array = 'ARRAY[' + ','.join("'" + code.replace("'","''") + "'" for code in codes) + ']::text[]'
        return json.loads(self.q_one(f'SELECT public.admin_delete_participants({array})',uid=self.admin))

    def denied(self, expression, uid=None):
        return self.sql(f"SET request.jwt.claim.sub='{uid or self.admin}'; SET ROLE authenticated; SELECT public.admin_delete_participants({expression})",success=False)

    def test_single_and_bulk_delete_leave_auth_accounts(self):
        a=self.create_participant('A'); b=self.create_participant('B'); c=self.create_participant('C')
        self.assertEqual(self.delete(['A']),{'deleted':1})
        self.assertEqual(self.delete(['B','C']),{'deleted':2})
        self.assertEqual(self.q_one('SELECT count(*) FROM public.participants'),'0')
        self.assertEqual(self.q_one(f"SELECT count(*) FROM auth.users WHERE id IN ('{a}','{b}','{c}')"),'3')

    def test_paired_participant_deletion_dissolves_pair_and_unpairs_partner(self):
        for code in ['A','B','C']: self.create_participant(code)
        self.create_pair(self.admin,'A','B')
        self.assertEqual(self.delete(['A','C']),{'deleted':2})
        # Participant B remains unpaired in the roster
        self.assertEqual(self.q_one('SELECT count(*) FROM public.participants'),'1')
        self.assertEqual(self.q_one("SELECT participant_code FROM public.participants"),'B')
        # Pair and pair_members were cleanly dissolved
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pairs'),'0')
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pair_members'),'0')

    def test_missing_or_malformed_selection_never_partially_deletes(self):
        self.create_participant('A')
        for expression in ["ARRAY['A','missing']", "ARRAY['A','A']", 'NULL', 'ARRAY[]::text[]',
                           "ARRAY['']", "ARRAY['A',NULL]", "array_fill('A'::text,ARRAY[1001])"]:
            self.denied(expression)
            self.assertEqual(self.q_one('SELECT count(*) FROM public.participants'),'1')

    def test_nonadmin_and_anon_cannot_delete(self):
        user=self.create_participant('A')
        self.denied("ARRAY['A']",user)
        self.sql("SET ROLE anon; SELECT public.admin_delete_participants(ARRAY['A'])",success=False)
        self.sql("SET ROLE authenticated; DELETE FROM public.participants",success=False)
        self.assertEqual(self.q_one('SELECT count(*) FROM public.participants'),'1')
        self.assertEqual(self.q_one("SELECT prosecdef AND proowner='postgres'::regrole AND proconfig=ARRAY['search_path=\"\"'] FROM pg_proc WHERE proname='admin_delete_participants'"),'t')

    def test_concurrent_pairing_and_deletion_cannot_orphan_pair_members(self):
        for code in ['A','B']: self.create_participant(code)
        def pair():
            try: self.create_pair(self.admin,'A','B'); return 'paired'
            except AssertionError: return 'pair_rejected'
        def delete():
            try: self.delete(['A']); return 'deleted'
            except AssertionError: return 'delete_rejected'
        with ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(pair); b=pool.submit(delete); results={a.result(),b.result()}
        self.assertIn(results,[{'paired','delete_rejected'},{'deleted','pair_rejected'}])
        self.assertEqual(self.q_one('SELECT count(*) FROM public.pair_members m LEFT JOIN public.participants p ON p.id=m.participant_id WHERE p.id IS NULL'),'0')
