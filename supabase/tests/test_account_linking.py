"""Run: python3 supabase/tests/test_account_linking.py

Requires PostgreSQL 17+ binaries on PATH; uses only Python's standard library.
Creates and removes a private temporary PostgreSQL cluster (Unix socket only).
Never accepts a remote database URL. Auth tables/uid() below are minimal local
fixtures, not a replacement for Supabase's JWT verification or OAuth testing.
"""

import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "supabase/migrations/20260922000000_create_participants.sql"
MIGRATION = ROOT / "supabase/migrations/20260923063000_secure_participant_account_linking.sql"


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


class AccountLinkingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-linking-", dir="/tmp")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.data = Path(cls.temp.name) / "data"
        cls.socket = Path(cls.temp.name) / "socket"
        cls.socket.mkdir(mode=0o700)
        # Do not inherit connection targets, passwords, or user psql startup files.
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        subprocess.run(["initdb", "-D", str(cls.data), "-U", "postgres", "-A", "trust",
                        "--no-locale", "--encoding=UTF8"], env=cls.env,
                       check=True, capture_output=True, text=True)
        subprocess.run(["pg_ctl", "-D", str(cls.data), "-l", str(Path(cls.temp.name) / "server.log"),
                        "-o", f"-k {cls.socket} -c listen_addresses=''", "-w", "start"],
                       env=cls.env, check=True, capture_output=True, text=True)
        cls.addClassCleanup(lambda: subprocess.run(
            ["pg_ctl", "-D", str(cls.data), "-m", "fast", "-w", "stop"],
            env=cls.env, check=True, capture_output=True, text=True))
        cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;")
        cls.sql(AUTH_FIXTURE)
        cls.sql(BASELINE.read_text())
        cls.sql("BEGIN;\n" + MIGRATION.read_text() + "\nCOMMIT;")

    @classmethod
    def sql(cls, query, *, database="postgres", success=True):
        result = subprocess.run(
            ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", str(cls.socket),
             "-U", "postgres", "-d", database], input=query, env=cls.env,
            capture_output=True, text=True, timeout=20)
        if success and result.returncode:
            raise AssertionError(result.stderr)
        if not success and not result.returncode:
            raise AssertionError("Expected SQL to fail, but it succeeded")
        return result.stdout.strip() if success else result.stderr

    def setUp(self):
        self.sql("TRUNCATE public.participants, auth.identities, auth.users;")

    def user(self, email="approved@example.test", *, provider="google", verified=True,
             confirmed=True, anonymous=False, identity_email=None):
        user_id = str(uuid.uuid4())
        identity = {"email": identity_email if identity_email is not None else email,
                    "email_verified": verified}
        self.sql(f"""INSERT INTO auth.users(id,email,email_confirmed_at,is_anonymous)
            VALUES ({literal(user_id)}, {literal(email)},
                    {'now()' if confirmed else 'NULL'}, {'true' if anonymous else 'false'});
            INSERT INTO auth.identities(user_id,provider,identity_data)
            VALUES ({literal(user_id)}, {literal(provider)}, {literal(json.dumps(identity))});""")
        return user_id

    def participant(self, email="approved@example.test", linked=None):
        return self.sql(f"""INSERT INTO public.participants
            (participant_code,name,registered_email,auth_user_id)
            VALUES ({literal(str(uuid.uuid4()))}, 'Local test', {literal(email)}, {literal(linked)})
            RETURNING id;""")

    def call(self, user_id=None, *, role="authenticated"):
        return self.sql(f"SET ROLE {role}; SET request.jwt.claim.sub = {literal(user_id or '')};"
                        "SELECT public.link_current_participant();")

    def snapshot(self):
        return self.sql("SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'[]') "
                        "FROM public.participants p;")

    def denied_unchanged(self, user_id, expected="LINKING_DENIED"):
        before = self.snapshot()
        self.assertEqual(self.call(user_id), expected)
        self.assertEqual(self.snapshot(), before)

    def test_success_and_idempotency_and_own_profile_rls(self):
        user_id = self.user()
        self.participant()
        self.participant("other@example.test")
        self.assertEqual(self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
                                  "SELECT count(*) FROM public.participants;"), "0")
        self.assertEqual(self.call(user_id), "LINKED")
        self.denied_unchanged(user_id, "ALREADY_LINKED")
        self.assertEqual(self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user_id)};"
                                  "SELECT count(*) FROM public.participants;"), "1")
        self.assertEqual(self.sql("SELECT count(*) FROM public.participants WHERE auth_user_id IS NOT NULL;"), "1")

    def test_unregistered_does_not_create(self):
        self.denied_unchanged(self.user(), "NOT_REGISTERED")

    def test_missing_and_unknown_caller(self):
        self.participant()
        self.denied_unchanged(None)
        self.denied_unchanged(str(uuid.uuid4()))

    def test_anonymous_auth_user(self):
        self.participant()
        self.denied_unchanged(self.user(anonymous=True))

    def test_unverified_non_google_and_unconfirmed(self):
        self.participant()
        for options in ({"verified": False}, {"verified": "true"}, {"verified": None},
                        {"provider": "github"}, {"confirmed": False},
                        {"identity_email": "different@example.test"}):
            with self.subTest(options=options):
                self.denied_unchanged(self.user(**options))

    def test_missing_verification_or_identity(self):
        self.participant()
        user_id = self.user()
        self.sql(f"UPDATE auth.identities SET identity_data = identity_data - 'email_verified' "
                 f"WHERE user_id = {literal(user_id)};")
        self.denied_unchanged(user_id)
        self.sql(f"DELETE FROM auth.identities WHERE user_id = {literal(user_id)};")
        self.denied_unchanged(user_id)

    def test_ambiguous_google_identities(self):
        self.participant()
        user_id = self.user()
        self.sql(f"INSERT INTO auth.identities(user_id,provider,identity_data) "
                 f"SELECT user_id,provider,identity_data FROM auth.identities WHERE user_id={literal(user_id)};")
        self.denied_unchanged(user_id)

    def test_participant_belongs_to_someone_else(self):
        owner = self.user("owner@example.test")
        self.participant(linked=owner)
        self.denied_unchanged(self.user())

    def test_user_already_linked_elsewhere(self):
        user_id = self.user()
        self.participant("old@example.test", linked=user_id)
        self.participant()
        self.denied_unchanged(user_id)

    def test_email_normalization(self):
        self.participant("  Approved@Example.Test  ")
        self.assertEqual(self.call(self.user(" APPROVED@example.test ",
                                             identity_email="approved@EXAMPLE.test")), "LINKED")

    def test_user_metadata_cannot_select_roster_row(self):
        user_id = self.user("unregistered@example.test")
        self.participant()
        self.sql(f"UPDATE auth.users SET raw_user_meta_data = "
                 f"'{json.dumps({'email': 'approved@example.test', 'email_verified': True})}'::jsonb "
                 f"WHERE id = {literal(user_id)};")
        self.denied_unchanged(user_id, "NOT_REGISTERED")

    def test_direct_writes_and_anon_reads_denied(self):
        user_id = self.user()
        self.participant(linked=user_id)
        before = self.snapshot()
        for role in ("anon", "authenticated"):
            for command in ("UPDATE public.participants SET name='tampered'",
                            "DELETE FROM public.participants", "TRUNCATE public.participants",
                            "INSERT INTO public.participants(participant_code,name,registered_email) "
                            "VALUES ('FORGED','Forged','forged@example.test')"):
                with self.subTest(role=role, command=command):
                    error = self.sql(f"SET ROLE {role}; SET request.jwt.claim.sub={literal(user_id)};"
                                     + command + ";", success=False)
                    self.assertIn("permission denied", error)
                    self.assertEqual(self.snapshot(), before)
        self.assertIn("permission denied", self.sql("SET ROLE anon; SELECT * FROM public.participants;", success=False))

    def test_rpc_permissions_signature_and_search_path(self):
        for role, expected in (("anon", "f"), ("authenticated", "t"), ("service_role", "f")):
            self.assertEqual(self.sql(f"SELECT has_function_privilege('{role}', "
                                      "'public.link_current_participant()', 'EXECUTE');"), expected)
        self.assertIn("permission denied", self.sql("SET ROLE anon; SELECT public.link_current_participant();", success=False))
        self.assertEqual(self.sql("SELECT prosecdef AND pronargs=0 AND proconfig=ARRAY['search_path=\"\"'] "
                                  "FROM pg_proc WHERE oid='public.link_current_participant()'::regprocedure;"), "t")
        self.assertIn("does not exist", self.sql("SET ROLE authenticated; "
                      "SELECT public.link_current_participant('forged@example.test');", success=False))
        self.assertEqual(self.sql("SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a "
                                  "WHERE p.oid='public.link_current_participant()'::regprocedure AND a.grantee=0;"), "0")

    def test_email_constraints_and_service_access(self):
        for value in (None, "", "   ", "\t\n\r "):
            with self.subTest(value=value):
                self.sql("INSERT INTO public.participants(participant_code,name,registered_email) "
                         f"VALUES ('INVALID','Invalid',{literal(value)});", success=False)
        self.assertEqual(self.sql("SELECT has_table_privilege('service_role','public.participants',"
                                  "'SELECT,INSERT,UPDATE,DELETE');"), "t")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_policies WHERE schemaname='public' "
                                  "AND tablename='participants' AND cmd <> 'SELECT';"), "0")

    def test_concurrent_same_caller(self):
        user_id = self.user()
        self.participant()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.call(user_id), range(8)))
        self.assertEqual(results.count("LINKED"), 1)
        self.assertEqual(results.count("ALREADY_LINKED"), 7)

    def test_concurrent_different_callers_same_roster(self):
        users = [self.user(), self.user()]
        self.participant()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.call, users))
        self.assertCountEqual(results, ["LINKED", "LINKING_DENIED"])
        self.assertEqual(self.sql("SELECT count(*) FROM public.participants WHERE auth_user_id IS NOT NULL;"), "1")

    def test_unique_conflict_race_is_safe(self):
        user_id = self.user()
        target = self.participant()
        other = self.participant("other@example.test")
        # Hold an uncommitted link on a different row. The RPC's SELECT cannot
        # see it, but its UPDATE must wait for the unique constraint then deny.
        blocker = subprocess.Popen(
            ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", str(self.socket),
             "-U", "postgres", "-d", "postgres"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            blocker.stdin.write(f"BEGIN; UPDATE public.participants SET auth_user_id={literal(user_id)} "
                                f"WHERE id={literal(other)}; SELECT 'locked';\n")
            blocker.stdin.flush()
            self.assertEqual(blocker.stdout.readline().strip(), "locked")
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.call, user_id)
                deadline = time.monotonic() + 10
                while self.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='transactionid' "
                               "AND query LIKE '%link_current_participant%';") == "0":
                    if time.monotonic() > deadline:
                        self.fail("RPC did not reach unique-constraint wait")
                    time.sleep(0.05)
                blocker.stdin.write("COMMIT;\n\\q\n")
                blocker.stdin.flush()
                self.assertEqual(future.result(timeout=10), "LINKING_DENIED")
            self.assertEqual(self.sql(f"SELECT auth_user_id IS NULL FROM public.participants WHERE id={literal(target)};"), "t")
        finally:
            if blocker.poll() is None:
                blocker.terminate()
            blocker.communicate(timeout=5)

    def test_migration_refuses_invalid_existing_roster(self):
        self.sql("CREATE DATABASE invalid_roster;")
        try:
            self.sql(AUTH_FIXTURE, database="invalid_roster")
            self.sql(BASELINE.read_text(), database="invalid_roster")
            for value in (None, "", " \t\n"):
                self.sql("TRUNCATE public.participants; INSERT INTO public.participants"
                         f"(participant_code,name,registered_email) VALUES ('BAD','Bad',{literal(value)});",
                         database="invalid_roster")
                error = self.sql("BEGIN;\n" + MIGRATION.read_text() + "\nCOMMIT;",
                                 database="invalid_roster", success=False)
                self.assertIn("missing or blank registered_email", error)
                self.assertEqual(self.sql("SELECT count(*) FROM public.participants;", database="invalid_roster"), "1")
                self.assertEqual(self.sql("SELECT to_regprocedure('public.link_current_participant()') IS NULL;",
                                          database="invalid_roster"), "t")
        finally:
            self.sql("DROP DATABASE invalid_roster;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
