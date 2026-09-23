"""Run: python3 supabase/tests/test_admin_authorization.py

Requires PostgreSQL 17+ binaries on PATH; uses only Python's standard library.
Creates and removes a private temporary PostgreSQL cluster (Unix socket only).
Never accepts a remote database URL. Auth tables/uid() below are minimal local
fixtures, not a replacement for Supabase's JWT verification or OAuth testing.

Applies migrations in order:
  1. 20260922000000_create_participants.sql        (baseline)
  2. 20260923063000_secure_participant_account_linking.sql
  3. 20260923140000_create_admin_authorization.sql (this step)

All tests run against the temporary cluster only.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid


ROOT       = Path(__file__).resolve().parents[2]
BASELINE   = ROOT / "supabase/migrations/20260922000000_create_participants.sql"
MIGRATION1 = ROOT / "supabase/migrations/20260923063000_secure_participant_account_linking.sql"
MIGRATION2 = ROOT / "supabase/migrations/20260923140000_create_admin_authorization.sql"


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


class AdminAuthorizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-admin-", dir="/tmp")
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
            raise AssertionError("Expected SQL to fail, but it succeeded")
        return result.stdout.strip() if success else result.stderr

    def setUp(self):
        # Reset state between tests: clear admins, participants, and auth tables.
        self.sql("TRUNCATE public.admins, public.participants, auth.identities, auth.users;")

    # ------------------------------------------------------------------ helpers

    def user(self, email="organizer@example.test"):
        """Insert a minimal verified Google user; return auth_user_id."""
        user_id = str(uuid.uuid4())
        import json
        self.sql(f"""
            INSERT INTO auth.users(id, email, email_confirmed_at, is_anonymous)
            VALUES ({literal(user_id)}, {literal(email)}, now(), false);
            INSERT INTO auth.identities(user_id, provider, identity_data)
            VALUES ({literal(user_id)}, 'google',
                    {literal(json.dumps({'email': email, 'email_verified': True}))});
        """)
        return user_id

    def set_admin(self, user_id):
        """Privileged insert — simulates Dashboard SQL editor (postgres role)."""
        self.sql(f"INSERT INTO public.admins(auth_user_id) VALUES ({literal(user_id)});")

    def call_check_admin_status(self, user_id, *, role="authenticated"):
        return self.sql(
            f"SET ROLE {role}; "
            f"SET request.jwt.claim.sub = {literal(user_id or '')}; "
            "SELECT public.check_admin_status();"
        )

    # ------------------------------------------------------------------ schema / RLS

    def test_admins_table_exists(self):
        result = self.sql(
            "SELECT EXISTS ("
            "  SELECT 1 FROM pg_tables"
            "  WHERE schemaname = 'public' AND tablename = 'admins'"
            ");"
        )
        self.assertEqual(result, "t")

    def test_rls_enabled_on_admins(self):
        result = self.sql(
            "SELECT relrowsecurity FROM pg_class"
            " WHERE oid = 'public.admins'::regclass;"
        )
        self.assertEqual(result, "t")

    def test_no_rls_policies_for_public_users(self):
        """No SELECT/INSERT/UPDATE/DELETE policies exist for anon or authenticated."""
        count = self.sql(
            "SELECT count(*) FROM pg_policies"
            " WHERE schemaname = 'public' AND tablename = 'admins';"
        )
        self.assertEqual(count, "0")

    # ------------------------------------------------------------------ direct table access denied

    def test_authenticated_cannot_select_admins(self):
        user_id = self.user()
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            "SELECT * FROM public.admins;",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_authenticated_cannot_insert_admins(self):
        user_id = self.user()
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            f"INSERT INTO public.admins(auth_user_id) VALUES ({literal(user_id)});",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_authenticated_cannot_update_admins(self):
        user_id = self.user()
        self.set_admin(user_id)
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            f"UPDATE public.admins SET created_at = now() WHERE auth_user_id = {literal(user_id)};",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_authenticated_cannot_delete_admins(self):
        user_id = self.user()
        self.set_admin(user_id)
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            f"DELETE FROM public.admins WHERE auth_user_id = {literal(user_id)};",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_anon_cannot_select_admins(self):
        error = self.sql(
            "SET ROLE anon; SELECT * FROM public.admins;",
            success=False,
        )
        self.assertIn("permission denied", error)

    # ------------------------------------------------------------------ is_admin() not directly callable

    def test_authenticated_cannot_directly_execute_is_admin(self):
        user_id = self.user()
        self.assertIn(
            "f",
            self.sql(
                f"SELECT has_function_privilege('authenticated',"
                f" 'public.is_admin()', 'EXECUTE');"
            ),
        )
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            "SELECT public.is_admin();",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_anon_cannot_directly_execute_is_admin(self):
        self.assertEqual(
            self.sql(
                "SELECT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE');"
            ),
            "f",
        )

    # ------------------------------------------------------------------ check_admin_status() permissions

    def test_check_admin_status_not_granted_to_anon(self):
        self.assertEqual(
            self.sql(
                "SELECT has_function_privilege('anon',"
                " 'public.check_admin_status()', 'EXECUTE');"
            ),
            "f",
        )

    def test_anon_cannot_execute_check_admin_status(self):
        error = self.sql(
            "SET ROLE anon; SELECT public.check_admin_status();",
            success=False,
        )
        self.assertIn("permission denied", error)

    def test_check_admin_status_granted_to_authenticated(self):
        self.assertEqual(
            self.sql(
                "SELECT has_function_privilege('authenticated',"
                " 'public.check_admin_status()', 'EXECUTE');"
            ),
            "t",
        )

    # ------------------------------------------------------------------ check_admin_status() behavior

    def test_authenticated_non_admin_returns_not_admin(self):
        user_id = self.user()
        result = self.call_check_admin_status(user_id)
        self.assertEqual(result, "NOT_ADMIN")

    def test_authenticated_admin_returns_is_admin(self):
        user_id = self.user()
        self.set_admin(user_id)
        result = self.call_check_admin_status(user_id)
        self.assertEqual(result, "IS_ADMIN")

    def test_deleting_admin_row_revokes_status(self):
        user_id = self.user()
        self.set_admin(user_id)
        self.assertEqual(self.call_check_admin_status(user_id), "IS_ADMIN")
        # Privileged delete — simulates Dashboard removal
        self.sql(f"DELETE FROM public.admins WHERE auth_user_id = {literal(user_id)};")
        self.assertEqual(self.call_check_admin_status(user_id), "NOT_ADMIN")

    def test_non_admin_unaffected_when_another_user_is_admin(self):
        admin_id = self.user("admin@example.test")
        other_id = self.user("participant@example.test")
        self.set_admin(admin_id)
        self.assertEqual(self.call_check_admin_status(admin_id), "IS_ADMIN")
        self.assertEqual(self.call_check_admin_status(other_id), "NOT_ADMIN")

    def test_on_delete_cascade_removes_admin_row(self):
        user_id = self.user()
        self.set_admin(user_id)
        self.assertEqual(self.call_check_admin_status(user_id), "IS_ADMIN")
        # Simulate auth.users row being deleted (e.g., user account removed)
        self.sql(f"DELETE FROM auth.identities WHERE user_id = {literal(user_id)};")
        self.sql(f"DELETE FROM auth.users WHERE id = {literal(user_id)};")
        count = self.sql(
            f"SELECT count(*) FROM public.admins WHERE auth_user_id = {literal(user_id)};"
        )
        self.assertEqual(count, "0")

    # ------------------------------------------------------------------ function signatures / security

    def test_is_admin_function_properties(self):
        """is_admin() must be STABLE, SECURITY DEFINER, search_path=''."""
        row = self.sql(
            "SELECT provolatile = 's' AND prosecdef AND pronargs = 0"
            "   AND proconfig = ARRAY['search_path=\"\"']"
            " FROM pg_proc WHERE oid = 'public.is_admin()'::regprocedure;"
        )
        self.assertEqual(row, "t")

    def test_check_admin_status_function_properties(self):
        """check_admin_status() must be SECURITY DEFINER, search_path=''."""
        row = self.sql(
            "SELECT prosecdef AND pronargs = 0"
            "   AND proconfig = ARRAY['search_path=\"\"']"
            " FROM pg_proc WHERE oid = 'public.check_admin_status()'::regprocedure;"
        )
        self.assertEqual(row, "t")

    def test_is_admin_no_public_grantee(self):
        """PUBLIC (grantee oid=0) must not have EXECUTE on is_admin()."""
        count = self.sql(
            "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a"
            " WHERE p.oid = 'public.is_admin()'::regprocedure AND a.grantee = 0;"
        )
        self.assertEqual(count, "0")

    def test_check_admin_status_no_public_grantee(self):
        """PUBLIC (grantee oid=0) must not have EXECUTE on check_admin_status()."""
        count = self.sql(
            "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a"
            " WHERE p.oid = 'public.check_admin_status()'::regprocedure AND a.grantee = 0;"
        )
        self.assertEqual(count, "0")

    # ------------------------------------------------------------------ existing participant system unchanged

    def test_participant_permissions_unchanged(self):
        """Existing participant table grants must be unaffected."""
        # authenticated has SELECT, not INSERT/UPDATE/DELETE
        self.assertEqual(
            self.sql("SELECT has_table_privilege('authenticated', 'public.participants', 'SELECT');"),
            "t",
        )
        for priv in ("INSERT", "UPDATE", "DELETE"):
            self.assertEqual(
                self.sql(f"SELECT has_table_privilege('authenticated', 'public.participants', '{priv}');"),
                "f",
                msg=f"authenticated should NOT have {priv} on participants",
            )

    def test_link_current_participant_permissions_unchanged(self):
        """link_current_participant() grant profile must be untouched."""
        self.assertEqual(
            self.sql("SELECT has_function_privilege('authenticated',"
                     " 'public.link_current_participant()', 'EXECUTE');"),
            "t",
        )
        self.assertEqual(
            self.sql("SELECT has_function_privilege('anon',"
                     " 'public.link_current_participant()', 'EXECUTE');"),
            "f",
        )

    def test_participant_rls_policy_still_own_row_only(self):
        """The own-profile SELECT policy on participants must still exist."""
        count = self.sql(
            "SELECT count(*) FROM pg_policies"
            " WHERE schemaname = 'public' AND tablename = 'participants'"
            " AND cmd = 'SELECT';"
        )
        self.assertEqual(count, "1")

    def test_internal_call_chain_works(self):
        """
        Verify the key permission model:
          - authenticated cannot call is_admin() directly
          - authenticated CAN call check_admin_status()
          - check_admin_status() internally calls is_admin() via SECURITY DEFINER
            and returns the correct result

        This is the critical proof that revoking direct access to is_admin()
        does NOT break check_admin_status(), because SECURITY DEFINER functions
        run with the definer's (postgres) privileges, not the caller's.
        """
        user_id = self.user()
        self.set_admin(user_id)

        # Step 1: direct call to is_admin() by authenticated must fail
        error = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            "SELECT public.is_admin();",
            success=False,
        )
        self.assertIn("permission denied", error)

        # Step 2: check_admin_status() — which calls is_admin() internally — must succeed
        result = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
            "SELECT public.check_admin_status();"
        )
        self.assertEqual(result, "IS_ADMIN")

        # Step 3: same non-admin user — check the chain returns NOT_ADMIN correctly
        other_id = self.user("other@example.test")
        result = self.sql(
            f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(other_id)};"
            "SELECT public.check_admin_status();"
        )
        self.assertEqual(result, "NOT_ADMIN")


if __name__ == "__main__":
    unittest.main(verbosity=2)
