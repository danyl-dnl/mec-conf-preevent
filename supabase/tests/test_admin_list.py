"""Run: python3 supabase/tests/test_admin_list.py

Requires PostgreSQL 17+ binaries on PATH; uses only Python's standard library.
Creates and removes a private temporary PostgreSQL cluster (Unix socket only).
Never accepts a remote database URL. Auth tables/uid() below are minimal local
fixtures.

Applies migrations in order:
  1. 20260922000000_create_participants.sql        (baseline)
  2. 20260923063000_secure_participant_account_linking.sql
  3. 20260923140000_create_admin_authorization.sql
  4. 20260923160000_admin_roster_import.sql
  5. 20260923170000_admin_list_participants.sql (this step)
"""

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


class AdminListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-admin-list-", dir="/tmp")
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
        # Reset tables for each test but keep TEST-001 setup
        self.sql("TRUNCATE public.participants CASCADE; TRUNCATE public.admins CASCADE;")
        self.test001_id = str(uuid.uuid4())
        self.test001_auth_id = str(uuid.uuid4())
        self.sql(f"""
            INSERT INTO auth.users (id, email) VALUES ({literal(self.test001_auth_id)}, 'admin@test.invalid');
            INSERT INTO public.participants (id, auth_user_id, participant_code, name, registered_email, branch)
            VALUES ({literal(self.test001_id)}, {literal(self.test001_auth_id)}, 'TEST-001', 'Admin', 'admin@test.invalid', NULL);
            INSERT INTO public.admins (auth_user_id) VALUES ({literal(self.test001_auth_id)});
        """)

    def test_admin_can_list_roster(self):
        # Admin requests list
        stdout, _ = self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(self.test001_auth_id)};
            SELECT row_to_json(r)::text FROM public.admin_list_participants() r;
        """)
        rows = [json.loads(line) for line in stdout.splitlines() if line]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["participant_code"], "TEST-001")
        self.assertEqual(row["name"], "Admin")
        self.assertEqual(row["branch"], None)
        self.assertEqual(row["registered_email"], "admin@test.invalid")
        self.assertEqual(row["is_linked"], True)
        self.assertNotIn("auth_user_id", row)
        self.assertNotIn("id", row)

    def test_non_admin_authenticated_rejected(self):
        non_admin_auth_id = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id, email) VALUES ({literal(non_admin_auth_id)}, 'user@test.invalid');")
        out, err = self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(non_admin_auth_id)};
            SELECT * FROM public.admin_list_participants();
        """, success=False)
        self.assertIn("Permission denied", err)

    def test_anon_rejected(self):
        out, err = self.sql("""
            SET ROLE anon;
            SELECT * FROM public.admin_list_participants();
        """, success=False)
        self.assertIn("permission denied", err)

    def test_public_execute_denied(self):
        stdout, _ = self.sql("""
            SELECT has_function_privilege('public', 'public.admin_list_participants()', 'EXECUTE');
        """)
        self.assertEqual(stdout, "f")

    def test_function_properties(self):
        stdout, _ = self.sql("""
            SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig
            FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public' AND p.proname = 'admin_list_participants';
        """)
        secdef, owner, config = stdout.split('|')
        self.assertEqual(secdef, "t")
        self.assertEqual(owner, "postgres")
        self.assertEqual(config, '{"search_path=\\"\\""}')

    def test_deterministic_ordering_and_linking(self):
        p1 = str(uuid.uuid4())
        p2 = str(uuid.uuid4())
        self.sql(f"""
            INSERT INTO public.participants (id, auth_user_id, participant_code, name, registered_email, branch)
            VALUES ({literal(p1)}, NULL, 'MEC-002', 'User B', 'b@test.com', 'CS');
            INSERT INTO public.participants (id, auth_user_id, participant_code, name, registered_email, branch)
            VALUES ({literal(p2)}, NULL, 'MEC-001', 'User A', 'a@test.com', 'EC');
        """)
        stdout, _ = self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(self.test001_auth_id)};
            SELECT participant_code, is_linked FROM public.admin_list_participants();
        """)
        lines = stdout.splitlines()
        self.assertEqual(lines, ["MEC-001|f", "MEC-002|f", "TEST-001|t"])

    def test_no_mutations_or_sequence_consumption(self):
        # Set sequence to 5
        self.sql("SELECT setval('public.participant_code_seq', 5, false);")
        self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(self.test001_auth_id)};
            SELECT * FROM public.admin_list_participants();
        """)
        stdout, _ = self.sql("SELECT last_value, is_called FROM public.participant_code_seq;")
        self.assertEqual(stdout, "5|f")

    def test_participant_rls_remains_intact(self):
        user_auth_id = str(uuid.uuid4())
        self.sql(f"""
            INSERT INTO auth.users (id, email) VALUES ({literal(user_auth_id)}, 'user@test.invalid');
            INSERT INTO public.participants (id, auth_user_id, participant_code, name, registered_email, branch)
            VALUES (gen_random_uuid(), {literal(user_auth_id)}, 'MEC-999', 'Self', 'user@test.invalid', 'CS');
        """)
        stdout, _ = self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(user_auth_id)};
            SELECT participant_code FROM public.participants;
        """)
        # User should only see their own row
        self.assertEqual(stdout.strip(), "MEC-999")

    def test_authenticated_lacks_direct_mutation(self):
        user_auth_id = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id, email) VALUES ({literal(user_auth_id)}, 'user2@test.invalid');")
        _, err = self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub TO {literal(user_auth_id)};
            UPDATE public.participants SET name = 'Hacked';
        """, success=False)
        self.assertIn("permission denied for table participants", err)

if __name__ == "__main__":
    unittest.main()
