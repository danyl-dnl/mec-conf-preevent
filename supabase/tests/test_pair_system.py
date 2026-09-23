import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
import json

ROOT       = Path(__file__).resolve().parents[2]
BASELINE   = ROOT / "supabase/migrations/20260922000000_create_participants.sql"
MIGRATION1 = ROOT / "supabase/migrations/20260923063000_secure_participant_account_linking.sql"
MIGRATION2 = ROOT / "supabase/migrations/20260923140000_create_admin_authorization.sql"
MIGRATION3 = ROOT / "supabase/migrations/20260923160000_admin_roster_import.sql"
MIGRATION4 = ROOT / "supabase/migrations/20260923170000_admin_list_participants.sql"
MIGRATION5 = ROOT / "supabase/migrations/20260923180000_admin_pair_system.sql"

def literal(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

AUTH_FIXTURE = """
CREATE SCHEMA auth;
CREATE TABLE auth.users (
    id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz,
    is_anonymous boolean DEFAULT false, raw_user_meta_data jsonb DEFAULT '{}'
);
CREATE TABLE auth.identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users,
    provider text NOT NULL, identity_data jsonb NOT NULL
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
"""

class PairSystemTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-admin-pair-", dir="/tmp")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.data   = Path(cls.temp.name) / "data"
        cls.socket = Path(cls.temp.name) / "socket"
        cls.socket.mkdir(mode=0o700)
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        subprocess.run(
            ["initdb", "-D", str(cls.data), "-U", "postgres", "-A", "trust",
             "--no-locale", "--encoding=UTF8"],
            env=cls.env, check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["pg_ctl", "-D", str(cls.data), "-l", str(Path(cls.temp.name) / "server.log"),
             "-o", f"-k {cls.socket} -c listen_addresses=''", "-w", "start"],
            env=cls.env, check=True, capture_output=True, text=True,
        )
        cls.addClassCleanup(lambda: subprocess.run(
            ["pg_ctl", "-D", str(cls.data), "-m", "fast", "-w", "stop"],
            env=cls.env, check=True, capture_output=True, text=True,
        ))
        cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;")
        cls.sql(AUTH_FIXTURE)
        cls.sql(BASELINE.read_text())
        cls.sql("BEGIN;\n" + MIGRATION1.read_text() + "\nCOMMIT;")
        cls.sql("BEGIN;\n" + MIGRATION2.read_text() + "\nCOMMIT;")
        cls.sql("BEGIN;\n" + MIGRATION3.read_text() + "\nCOMMIT;")
        cls.sql("BEGIN;\n" + MIGRATION4.read_text() + "\nCOMMIT;")
        cls.sql("BEGIN;\n" + MIGRATION5.read_text() + "\nCOMMIT;")

    @classmethod
    def sql(cls, query, *, database="postgres", success=True):
        result = subprocess.run(
            ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
             "-h", str(cls.socket), "-U", "postgres", "-d", database],
            input=query, env=cls.env,
            capture_output=True, text=True, timeout=20,
        )
        if success and result.returncode:
            raise AssertionError(result.stderr)
        if not success and not result.returncode:
            raise AssertionError("Query succeeded unexpectedly.")
        return result.stdout.strip(), result.stderr.strip()

    def setUp(self):
        self.sql("TRUNCATE public.pairs CASCADE; TRUNCATE public.participants CASCADE; TRUNCATE public.admins CASCADE; TRUNCATE auth.users CASCADE;")

    def q_json(self, query, uid=None):
        prefix = f"SET request.jwt.claim.sub = '{uid}'; SET ROLE authenticated; " if uid else ""
        out, _ = self.sql(prefix + "SELECT COALESCE(json_agg(t), '[]'::json) FROM (" + query + ") t")
        return json.loads(out) if out.strip() else []

    def create_admin(self):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id) VALUES ('{uid}')")
        self.sql(f"INSERT INTO public.admins (auth_user_id) VALUES ('{uid}')")
        return uid

    def create_participant(self, pcode):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id) VALUES ('{uid}')")
        self.sql(f"INSERT INTO public.participants (auth_user_id, participant_code, name, registered_email) VALUES ('{uid}', '{pcode}', 'Name', '{pcode}@a.com')")
        return uid

    def test_schema_exists(self):
        res = self.q_json("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('pairs', 'pair_members')")
        tables = [r["table_name"] for r in res]
        self.assertIn("pairs", tables)
        self.assertIn("pair_members", tables)

    def test_rls_enabled(self):
        res = self.q_json("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('pairs', 'pair_members')")
        for r in res:
            self.assertTrue(r["relrowsecurity"], f"RLS not enabled on {r['relname']}")

    def test_fragment_slot_check(self):
        admin_uid = self.create_admin()
        self.create_participant("A")
        self.create_participant("B")
        
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('A', 'B')")
        
        # Manually try to add a 'C' slot
        self.sql("INSERT INTO public.pair_members (pair_id, participant_id, fragment_slot) VALUES ((SELECT id FROM public.pairs LIMIT 1), (SELECT id FROM public.participants WHERE participant_code='A'), 'C')", success=False)

    def test_security_create_pair(self):
        self.create_participant("C")
        self.create_participant("D")
        
        # Anon
        self.sql("SET ROLE anon; SELECT public.admin_create_pair('C', 'D')", success=False)
        
        # Authenticated non-admin
        non_admin = str(uuid.uuid4())
        self.sql(f"SET request.jwt.claim.sub = '{non_admin}'; SET ROLE authenticated; SELECT public.admin_create_pair('C', 'D')", success=False)
        
        # Admin
        admin_uid = self.create_admin()
        out, _ = self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('C', 'D')")
        self.assertIn('"success": true', out)

    def test_same_participant_rejected(self):
        admin_uid = self.create_admin()
        self.create_participant("E")
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('E', 'E')", success=False)

    def test_already_paired_rejected(self):
        admin_uid = self.create_admin()
        self.create_participant("F1")
        self.create_participant("F2")
        self.create_participant("F3")
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('F1', 'F2')")
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('F1', 'F3')", success=False)

    def test_unknown_participant_rejected(self):
        admin_uid = self.create_admin()
        self.create_participant("G1")
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('G1', 'FAKE')", success=False)

    def test_direct_mutation_denied(self):
        admin_uid = self.create_admin()
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; INSERT INTO public.pairs (pair_code) VALUES ('XX-1')", success=False)

    def test_list_pairs_and_unpaired(self):
        admin_uid = self.create_admin()
        self.create_participant("H1")
        self.create_participant("H2")
        self.create_participant("H3")
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; SELECT public.admin_create_pair('H1', 'H2')")
        
        pairs = self.q_json("SELECT * FROM public.admin_list_pairs()", uid=admin_uid)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["member_a_code"], "H1")
        self.assertEqual(pairs[0]["member_b_code"], "H2")
        
        unpaired = self.q_json("SELECT * FROM public.admin_list_unpaired_participants()", uid=admin_uid)
        codes = [u["participant_code"] for u in unpaired]
        self.assertIn("H3", codes)
        self.assertNotIn("H1", codes)
        self.assertNotIn("H2", codes)

if __name__ == '__main__':
    unittest.main()
