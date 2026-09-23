"""Run: python3 supabase/tests/test_roster_import.py

Requires PostgreSQL 17+ binaries on PATH; uses only Python's standard library.
Creates and removes a private temporary PostgreSQL cluster (Unix socket only).
Applies all migrations in order.
"""

import json
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
MIGRATION3 = ROOT / "supabase/migrations/20260923160000_admin_roster_import.sql"


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


class RosterImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-import-", dir="/tmp")
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
        self.sql("TRUNCATE public.participants, auth.identities, auth.users CASCADE;")
        self.sql("ALTER SEQUENCE public.participant_code_seq RESTART WITH 1;")

        # Setup admin user
        self.admin_id = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(self.admin_id)}, 'admin@mec.ac.in');")
        self.sql(f"INSERT INTO public.admins(auth_user_id) VALUES ({literal(self.admin_id)});")

        # Setup TEST-001 as a linked participant with NULL branch (pre-dates roster import)
        self.test001_user_id = str(uuid.uuid4())
        self.test001_participant_id = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(self.test001_user_id)}, 'test001@mec.ac.in');")
        self.sql(
            f"INSERT INTO public.participants(id, auth_user_id, participant_code, name, registered_email, branch) "
            f"VALUES ({literal(self.test001_participant_id)}, {literal(self.test001_user_id)}, "
            f"'TEST-001', 'Test Participant', 'test001@mec.ac.in', NULL);"
        )

        self.set_admin_context = f"SET request.jwt.claim.sub = {literal(self.admin_id)}; SET ROLE authenticated;"

    def exec_rpc(self, rpc_name, payload, *, success=True):
        payload_json = json.dumps(payload).replace("'", "''")
        query = self.set_admin_context + f"SELECT public.{rpc_name}('{payload_json}'::jsonb);"
        res = self.sql(query, success=success)
        if success:
            return json.loads(res)
        return res

    # ──────────────────────────────────────────────────────
    # FIX 1: Sequence initialization tests
    # ──────────────────────────────────────────────────────

    def test_sequence_initialization_no_existing_mec_codes(self):
        """Sequence starts at 1 when no MEC-NNN codes exist (only TEST-001)."""
        # After setUp, only TEST-001 exists.  The sequence should yield MEC-001.
        self.sql("ALTER SEQUENCE public.participant_code_seq RESTART WITH 1;")
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload)
        code = self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(code, "MEC-001")

    def test_sequence_initialization_expression_skips_existing(self):
        """
        Verify the MIGRATION-TIME initialization expression logic.
        We cannot re-run the migration, so we simulate it by calling setval()
        the same way the migration DO block does, and then verify nextval().
        """
        # Simulate existing MEC-017
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email) "
            "VALUES ('MEC-017', 'Pre Existing', 'preexist@ex.com');"
        )
        # Re-run the same setval logic as in the migration DO block
        self.sql("""
            DO $$
            DECLARE max_val bigint;
            BEGIN
                SELECT pg_catalog.max(
                    pg_catalog.regexp_replace(participant_code, '^MEC-([0-9]+)$', '\\1')::bigint
                )
                INTO max_val
                FROM public.participants
                WHERE participant_code ~ '^MEC-[0-9]+$';

                IF max_val IS NOT NULL THEN
                    PERFORM pg_catalog.setval('public.participant_code_seq', max_val, true);
                ELSE
                    PERFORM pg_catalog.setval('public.participant_code_seq', 1, false);
                END IF;
            END;
            $$;
        """)
        # nextval should now yield 18
        next_val = self.sql("SELECT pg_catalog.nextval('public.participant_code_seq')")
        self.assertEqual(next_val, "18")

    def test_sequence_ignores_non_mec_codes(self):
        """TEST-001, ABC-017, MEC-ABC, MEC- must NOT influence sequence init."""
        for code in ("ABC-017", "MEC-ABC", "MEC-"):
            # TEST-001 is already inserted by setUp; only insert the others
            uid = str(uuid.uuid4())
            self.sql(
                f"INSERT INTO public.participants(participant_code, name, registered_email) "
                f"VALUES ({literal(code)}, 'N', {literal(uid + '@ex.com')});"
            )
        # Re-run init logic
        self.sql("""
            DO $$
            DECLARE max_val bigint;
            BEGIN
                SELECT pg_catalog.max(
                    pg_catalog.regexp_replace(participant_code, '^MEC-([0-9]+)$', '\\1')::bigint
                )
                INTO max_val FROM public.participants WHERE participant_code ~ '^MEC-[0-9]+$';
                IF max_val IS NOT NULL THEN
                    PERFORM pg_catalog.setval('public.participant_code_seq', max_val, true);
                ELSE
                    PERFORM pg_catalog.setval('public.participant_code_seq', 1, false);
                END IF;
            END; $$;
        """)
        next_val = self.sql("SELECT pg_catalog.nextval('public.participant_code_seq')")
        self.assertEqual(next_val, "1")  # none matched; should start at 1

    def test_sequence_large_existing_code(self):
        """MEC-999 existing → first new code is MEC-1000."""
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email) "
            "VALUES ('MEC-999', 'Big', 'big@ex.com');"
        )
        self.sql("""
            DO $$
            DECLARE max_val bigint;
            BEGIN
                SELECT pg_catalog.max(
                    pg_catalog.regexp_replace(participant_code, '^MEC-([0-9]+)$', '\\1')::bigint
                )
                INTO max_val FROM public.participants WHERE participant_code ~ '^MEC-[0-9]+$';
                IF max_val IS NOT NULL THEN PERFORM pg_catalog.setval('public.participant_code_seq', max_val, true);
                ELSE PERFORM pg_catalog.setval('public.participant_code_seq', 1, false); END IF;
            END; $$;
        """)
        next_val = self.sql("SELECT pg_catalog.nextval('public.participant_code_seq')")
        self.assertEqual(next_val, "1000")

    # ──────────────────────────────────────────────────────
    # Basic preview / import
    # ──────────────────────────────────────────────────────

    def test_new_preview(self):
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "NEW")
        self.assertFalse(res[0]["is_blocking"])
        self.assertFalse(res[0]["is_suspicious_email"])

    def test_new_import(self):
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_import_roster", payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["imported"], 1)
        code = self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertTrue(code.startswith("MEC-"))

    def test_preview_causes_zero_mutations(self):
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_preview_roster", payload)
        count = self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(count, "0")

    def test_preview_consumes_no_sequence(self):
        """Sequence should not advance during preview."""
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_preview_roster", payload)
        # Now import a different participant; it must get MEC-001, not MEC-002
        payload2 = [{"row_number": 1, "name": "Bob", "email": "bob@ex.com", "branch": "EC"}]
        self.exec_rpc("admin_import_roster", payload2)
        code = self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'bob@ex.com'")
        self.assertEqual(code, "MEC-001")

    # ──────────────────────────────────────────────────────
    # FIX 2: Suspicious email as orthogonal flag
    # ──────────────────────────────────────────────────────

    def test_suspicious_email_new_participant(self):
        """SUSPICIOUS_EMAIL sets is_suspicious_email=true; category remains NEW."""
        payload = [{"row_number": 1, "name": "Aahil", "email": "aahilfadhl@gmail.con", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "NEW")
        self.assertTrue(res[0]["is_suspicious_email"])
        self.assertFalse(res[0]["is_blocking"])

    def test_suspicious_email_existing_unlinked(self):
        """Existing unlinked gmail.con row: category=UNCHANGED, is_suspicious_email=true."""
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Aahil', 'aahilfadhl@gmail.con', 'CS');"
        )
        payload = [{"row_number": 1, "name": "Aahil", "email": "aahilfadhl@gmail.con", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "UNCHANGED")
        self.assertTrue(res[0]["is_suspicious_email"])

    def test_suspicious_email_linked_participant(self):
        """Linked gmail.con participant: category=ALREADY_ACTIVE, is_suspicious_email=true."""
        link_uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(link_uid)}, 'sus@gmail.con');")
        self.sql(
            f"INSERT INTO public.participants(participant_code, name, registered_email, branch, auth_user_id) "
            f"VALUES ('MEC-998', 'Sus', 'sus@gmail.con', 'CS', {literal(link_uid)});"
        )
        payload = [{"row_number": 1, "name": "Sus", "email": "sus@gmail.con", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "ALREADY_ACTIVE")
        self.assertTrue(res[0]["is_suspicious_email"])

    def test_suspicious_email_importable(self):
        """Suspicious email is non-blocking; backend allows import."""
        payload = [{"row_number": 1, "name": "Aahil", "email": "aahilfadhl@gmail.con", "branch": "CS"}]
        res = self.exec_rpc("admin_import_roster", payload)
        self.assertTrue(res["success"])
        stored = self.sql("SELECT registered_email FROM public.participants WHERE registered_email = 'aahilfadhl@gmail.con'")
        self.assertEqual(stored, "aahilfadhl@gmail.con")  # not silently corrected

    # ──────────────────────────────────────────────────────
    # FIX 3: Name and branch trimming
    # ──────────────────────────────────────────────────────

    def test_name_whitespace_trimmed_on_insert(self):
        payload = [{"row_number": 1, "name": "  Alice Smith  ", "email": "alice@ex.com", "branch": "  CS  "}]
        self.exec_rpc("admin_import_roster", payload)
        name = self.sql("SELECT name FROM public.participants WHERE registered_email = 'alice@ex.com'")
        branch = self.sql("SELECT branch FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(name, "Alice Smith")
        self.assertEqual(branch, "CS")

    def test_name_whitespace_trimmed_no_false_details_update(self):
        """Whitespace-padded CSV values should not produce a false DETAILS_UPDATE."""
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Alice', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "  Alice  ", "email": "alice@ex.com", "branch": "  CS  "}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "UNCHANGED")

    # ──────────────────────────────────────────────────────
    # Email normalization
    # ──────────────────────────────────────────────────────

    def test_email_case_normalization(self):
        payload = [{"row_number": 1, "name": "Alice", "email": "ALICE@EX.COM", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload)
        count = self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(count, "1")

    def test_email_whitespace_normalization(self):
        payload = [{"row_number": 1, "name": "Alice", "email": " Alice@EX.COM ", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload)
        count = self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(count, "1")

    # ──────────────────────────────────────────────────────
    # Validation
    # ──────────────────────────────────────────────────────

    def test_malformed_email(self):
        for bad in ("alice", "simon", "aph", "Abi"):
            payload = [{"row_number": 1, "name": "X", "email": bad, "branch": "CS"}]
            res = self.exec_rpc("admin_preview_roster", payload)
            self.assertEqual(res[0]["category"], "INVALID_EMAIL", f"Expected INVALID for: {bad}")
            self.assertTrue(res[0]["is_blocking"])
            self.exec_rpc("admin_import_roster", payload, success=False)

    def test_blank_name(self):
        for v in ("", "   "):
            payload = [{"row_number": 1, "name": v, "email": "a@ex.com", "branch": "CS"}]
            res = self.exec_rpc("admin_preview_roster", payload)
            self.assertEqual(res[0]["category"], "MISSING_REQUIRED_FIELD")
            self.exec_rpc("admin_import_roster", payload, success=False)

    def test_blank_email(self):
        for v in ("", "   "):
            payload = [{"row_number": 1, "name": "X", "email": v, "branch": "CS"}]
            res = self.exec_rpc("admin_preview_roster", payload)
            self.assertEqual(res[0]["category"], "MISSING_REQUIRED_FIELD")
            self.exec_rpc("admin_import_roster", payload, success=False)

    def test_blank_branch(self):
        for v in ("", "   "):
            payload = [{"row_number": 1, "name": "X", "email": "a@ex.com", "branch": v}]
            res = self.exec_rpc("admin_preview_roster", payload)
            self.assertEqual(res[0]["category"], "MISSING_REQUIRED_FIELD")
            self.exec_rpc("admin_import_roster", payload, success=False)

    def test_oversized_name(self):
        payload = [{"row_number": 1, "name": "A" * 101, "email": "a@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "CONFLICT")
        self.exec_rpc("admin_import_roster", payload, success=False)

    def test_oversized_branch(self):
        payload = [{"row_number": 1, "name": "A", "email": "a@ex.com", "branch": "B" * 51}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "CONFLICT")
        self.exec_rpc("admin_import_roster", payload, success=False)

    def test_oversized_email(self):
        payload = [{"row_number": 1, "name": "A", "email": "a" * 250 + "@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "CONFLICT")
        self.exec_rpc("admin_import_roster", payload, success=False)

    # ──────────────────────────────────────────────────────
    # FIX 4: JSON shape / row_number validation
    # ──────────────────────────────────────────────────────

    def test_malformed_payload_not_array(self):
        self.exec_rpc("admin_import_roster", {"not": "array"}, success=False)
        self.exec_rpc("admin_preview_roster", {"not": "array"}, success=False)

    def test_malformed_payload_null(self):
        query = self.set_admin_context + "SELECT public.admin_import_roster(null::jsonb);"
        self.sql(query, success=False)

    def test_empty_array_rejected(self):
        self.exec_rpc("admin_import_roster", [], success=False)
        self.exec_rpc("admin_preview_roster", [], success=False)

    def test_row_limit(self):
        payload = [{"row_number": i, "name": "N", "email": f"e{i}@x.com", "branch": "CS"} for i in range(201)]
        self.exec_rpc("admin_preview_roster", payload, success=False)
        self.exec_rpc("admin_import_roster", payload, success=False)

    def test_malformed_row_number_string(self):
        """row_number as a non-numeric string must be rejected gracefully."""
        payload = [{"row_number": "foo", "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        # preview should return CONFLICT for this row, not crash
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "CONFLICT")
        self.exec_rpc("admin_import_roster", payload, success=False)

    def test_malformed_row_is_scalar(self):
        """Array members that are not objects must be rejected."""
        query = self.set_admin_context + "SELECT public.admin_import_roster('[1, 2, 3]'::jsonb);"
        self.sql(query, success=False)

    def test_non_string_name_field(self):
        """name provided as a number must be caught as MISSING_REQUIRED_FIELD."""
        payload = [{"row_number": 1, "name": 42, "email": "a@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "MISSING_REQUIRED_FIELD")

    # ──────────────────────────────────────────────────────
    # FIX 8: Duplicate handling
    # ──────────────────────────────────────────────────────

    def test_duplicate_normalized_email_all_flagged(self):
        payload = [
            {"row_number": 1, "name": "Alice", "email": "a@ex.com", "branch": "CS"},
            {"row_number": 2, "name": "Bob",   "email": " A@ex.com ", "branch": "EC"},
        ]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DUPLICATE_IN_FILE")
        self.assertEqual(res[1]["category"], "DUPLICATE_IN_FILE")
        self.assertTrue(res[0]["is_blocking"])
        self.assertTrue(res[1]["is_blocking"])
        self.exec_rpc("admin_import_roster", payload, success=False)

    def test_duplicate_conflicting_names(self):
        """ABHINAV J / CSC and Abinav J / ECA share same normalized email."""
        payload = [
            {"row_number": 1, "name": "ABHINAV J", "email": "4bhi.hh@gmail.com", "branch": "CSC"},
            {"row_number": 2, "name": "Abinav J",  "email": "4bhi.hh@gmail.com", "branch": "ECA"},
        ]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DUPLICATE_IN_FILE")
        self.assertEqual(res[1]["category"], "DUPLICATE_IN_FILE")

    def test_duplicate_conflicting_branches(self):
        payload = [
            {"row_number": 1, "name": "Alice", "email": "a@ex.com", "branch": "CSA"},
            {"row_number": 2, "name": "Alice", "email": "a@ex.com", "branch": "CSB"},
        ]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DUPLICATE_IN_FILE")
        self.assertEqual(res[1]["category"], "DUPLICATE_IN_FILE")

    def test_duplicate_email_capitalization_all_flagged(self):
        """ARCHITHACS@GMAIL.COM and archithacs@gmail.com are same normalized email."""
        payload = [
            {"row_number": 1, "name": "Architha", "email": "ARCHITHACS@GMAIL.COM", "branch": "ECA"},
            {"row_number": 2, "name": "Architha", "email": "archithacs@gmail.com", "branch": "ECA"},
        ]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DUPLICATE_IN_FILE")
        self.assertEqual(res[1]["category"], "DUPLICATE_IN_FILE")

    # ──────────────────────────────────────────────────────
    # Existing participant behavior
    # ──────────────────────────────────────────────────────

    def test_existing_unlinked_unchanged(self):
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Alice', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "UNCHANGED")
        result = self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(self.sql("SELECT name FROM public.participants WHERE registered_email = 'alice@ex.com'"), "Alice")
        self.assertEqual(self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'alice@ex.com'"), "MEC-999")

    def test_existing_unlinked_name_update(self):
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Alice', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "Alice Updated", "email": "alice@ex.com", "branch": "CS"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DETAILS_UPDATE")
        result = self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(self.sql("SELECT name FROM public.participants WHERE registered_email = 'alice@ex.com'"), "Alice Updated")
        self.assertEqual(self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'alice@ex.com'"), "MEC-999")

    def test_existing_unlinked_branch_update(self):
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Alice', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "EC"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DETAILS_UPDATE")
        self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(self.sql("SELECT branch FROM public.participants WHERE registered_email = 'alice@ex.com'"), "EC")

    def test_existing_unlinked_combined_update(self):
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-999', 'Old Name', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "New Name", "email": "alice@ex.com", "branch": "EC"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DETAILS_UPDATE")
        self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(self.sql("SELECT name FROM public.participants WHERE registered_email = 'alice@ex.com'"), "New Name")
        self.assertEqual(self.sql("SELECT branch FROM public.participants WHERE registered_email = 'alice@ex.com'"), "EC")

    def test_linked_participant_always_already_active(self):
        """TEST-001 is linked; any submitted details must not mutate it."""
        payload = [{"row_number": 1, "name": "Different Name", "email": "test001@mec.ac.in", "branch": "EE"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "ALREADY_ACTIVE")
        self.assertFalse(res[0]["is_blocking"])
        self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(self.sql("SELECT name FROM public.participants WHERE participant_code = 'TEST-001'"), "Test Participant")
        self.assertEqual(self.sql("SELECT auth_user_id FROM public.participants WHERE participant_code = 'TEST-001'"),
                         self.test001_user_id)

    # ──────────────────────────────────────────────────────
    # FIX 9: Direct TEST-001 preservation
    # ──────────────────────────────────────────────────────

    def test_test001_direct_preservation(self):
        """Roster import of unrelated participants must not affect TEST-001 at all."""
        before_id    = self.sql("SELECT id FROM public.participants WHERE participant_code = 'TEST-001'")
        before_uid   = self.sql("SELECT auth_user_id FROM public.participants WHERE participant_code = 'TEST-001'")
        before_name  = self.sql("SELECT name FROM public.participants WHERE participant_code = 'TEST-001'")
        before_email = self.sql("SELECT registered_email FROM public.participants WHERE participant_code = 'TEST-001'")

        payload = [{"row_number": i, "name": f"N{i}", "email": f"n{i}@ex.com", "branch": "CS"} for i in range(5)]
        self.exec_rpc("admin_import_roster", payload)

        after_id    = self.sql("SELECT id FROM public.participants WHERE participant_code = 'TEST-001'")
        after_uid   = self.sql("SELECT auth_user_id FROM public.participants WHERE participant_code = 'TEST-001'")
        after_name  = self.sql("SELECT name FROM public.participants WHERE participant_code = 'TEST-001'")
        after_email = self.sql("SELECT registered_email FROM public.participants WHERE participant_code = 'TEST-001'")
        after_code  = self.sql("SELECT participant_code FROM public.participants WHERE participant_code = 'TEST-001'")
        # branch may be NULL (predates roster)
        after_branch = self.sql("SELECT coalesce(branch, 'NULL') FROM public.participants WHERE participant_code = 'TEST-001'")

        self.assertEqual(before_id, after_id)
        self.assertEqual(before_uid, after_uid)
        self.assertEqual(before_name, after_name)
        self.assertEqual(before_email, after_email)
        self.assertEqual(after_code, "TEST-001")
        self.assertEqual(after_branch, "NULL")  # branch remains NULL

    # ──────────────────────────────────────────────────────
    # FIX 10: Code / ID / email stability
    # ──────────────────────────────────────────────────────

    def test_unlinked_details_update_preserves_code_and_email(self):
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-777', 'Alice', 'alice@ex.com', 'CS');"
        )
        payload = [{"row_number": 1, "name": "Alice New", "email": "alice@ex.com", "branch": "EC"}]
        self.exec_rpc("admin_import_roster", payload)
        code  = self.sql("SELECT participant_code FROM public.participants WHERE registered_email = 'alice@ex.com'")
        email = self.sql("SELECT registered_email FROM public.participants WHERE registered_email = 'alice@ex.com'")
        uid   = self.sql("SELECT auth_user_id FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(code, "MEC-777")
        self.assertEqual(email, "alice@ex.com")
        self.assertEqual(uid, "")  # empty string from psql for NULL

    def test_linked_participant_completely_immutable(self):
        link_uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(link_uid)}, 'bob@ex.com');")
        self.sql(
            f"INSERT INTO public.participants(participant_code, name, registered_email, branch, auth_user_id) "
            f"VALUES ('MEC-888', 'Bob', 'bob@ex.com', 'CS', {literal(link_uid)});"
        )
        before_id = self.sql("SELECT id FROM public.participants WHERE participant_code = 'MEC-888'")
        payload = [{"row_number": 1, "name": "Bob Changed", "email": "bob@ex.com", "branch": "EE"}]
        self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(self.sql("SELECT name   FROM public.participants WHERE participant_code = 'MEC-888'"), "Bob")
        self.assertEqual(self.sql("SELECT branch FROM public.participants WHERE participant_code = 'MEC-888'"), "CS")
        self.assertEqual(self.sql("SELECT auth_user_id FROM public.participants WHERE participant_code = 'MEC-888'"), link_uid)
        self.assertEqual(self.sql("SELECT id FROM public.participants WHERE participant_code = 'MEC-888'"), before_id)

    # ──────────────────────────────────────────────────────
    # FIX 7: State change between preview and import
    # ──────────────────────────────────────────────────────

    def test_state_change_between_preview_and_import(self):
        """Participant linked after preview; import must skip without modifying them."""
        # Start: unlinked participant
        p_uid = str(uuid.uuid4())
        self.sql(
            "INSERT INTO public.participants(participant_code, name, registered_email, branch) "
            "VALUES ('MEC-555', 'Old Name', 'change@ex.com', 'CS');"
        )
        # Preview sees DETAILS_UPDATE
        payload = [{"row_number": 1, "name": "New Name", "email": "change@ex.com", "branch": "EC"}]
        res = self.exec_rpc("admin_preview_roster", payload)
        self.assertEqual(res[0]["category"], "DETAILS_UPDATE")

        # Simulate participant being linked in between (state change)
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(p_uid)}, 'change@ex.com');")
        self.sql(
            f"UPDATE public.participants SET auth_user_id = {literal(p_uid)} "
            f"WHERE participant_code = 'MEC-555';"
        )

        # Import must independently detect the new state and skip
        result = self.exec_rpc("admin_import_roster", payload)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["updated"], 0)

        # Verify nothing changed
        self.assertEqual(self.sql("SELECT name   FROM public.participants WHERE participant_code = 'MEC-555'"), "Old Name")
        self.assertEqual(self.sql("SELECT branch FROM public.participants WHERE participant_code = 'MEC-555'"), "CS")
        self.assertEqual(self.sql("SELECT auth_user_id FROM public.participants WHERE participant_code = 'MEC-555'"), p_uid)

    # ──────────────────────────────────────────────────────
    # Re-import / idempotency
    # ──────────────────────────────────────────────────────

    def test_repeated_import_idempotency(self):
        payload = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload)
        self.exec_rpc("admin_import_roster", payload)
        count = self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'alice@ex.com'")
        self.assertEqual(count, "1")

    def test_omitted_participants_never_deleted(self):
        payload1 = [{"row_number": 1, "name": "Alice", "email": "alice@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload1)
        payload2 = [{"row_number": 1, "name": "Bob", "email": "bob@ex.com", "branch": "CS"}]
        self.exec_rpc("admin_import_roster", payload2)
        self.assertEqual(self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'alice@ex.com'"), "1")
        self.assertEqual(self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'bob@ex.com'"), "1")

    # ──────────────────────────────────────────────────────
    # Sequence uniqueness
    # ──────────────────────────────────────────────────────

    def test_sequence_generated_codes_unique(self):
        payload = [{"row_number": i, "name": f"N{i}", "email": f"e{i}@ex.com", "branch": "CS"} for i in range(1, 51)]
        self.exec_rpc("admin_import_roster", payload)
        codes = self.sql("SELECT count(DISTINCT participant_code) FROM public.participants WHERE participant_code LIKE 'MEC-%'")
        self.assertEqual(codes, "50")

    # ──────────────────────────────────────────────────────
    # Authorization / grants
    # ──────────────────────────────────────────────────────

    def test_unauthorized_non_admin(self):
        non_admin_id = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id, email) VALUES ({literal(non_admin_id)}, 'rando@ex.com');")
        query = (
            f"SET request.jwt.claim.sub = {literal(non_admin_id)}; SET ROLE authenticated; "
            f"SELECT public.admin_preview_roster('[{{\"row_number\":1,\"name\":\"X\",\"email\":\"x@ex.com\",\"branch\":\"CS\"}}]'::jsonb);"
        )
        self.sql(query, success=False)

    def test_anon_cannot_call_preview(self):
        self.sql("SET ROLE anon; SELECT public.admin_preview_roster('[]'::jsonb);", success=False)

    def test_anon_cannot_call_import(self):
        self.sql("SET ROLE anon; SELECT public.admin_import_roster('[]'::jsonb);", success=False)

    def test_public_cannot_directly_write_participants(self):
        """authenticated role must not have INSERT/UPDATE/DELETE on participants."""
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id,email) VALUES ({literal(uid)}, 'u@ex.com');")
        # Direct INSERT via authenticated role must fail
        query = (
            f"SET request.jwt.claim.sub = {literal(uid)}; SET ROLE authenticated; "
            f"INSERT INTO public.participants(participant_code, name, registered_email) "
            f"VALUES ('HACK-001', 'Hacker', 'hack@ex.com');"
        )
        self.sql(query, success=False)

    # ──────────────────────────────────────────────────────
    # Atomicity
    # ──────────────────────────────────────────────────────

    def test_atomic_rollback_on_bad_row(self):
        """Good rows followed by a bad row must roll back all insertions."""
        payload = [
            {"row_number": 1, "name": "Good", "email": "good@ex.com", "branch": "CS"},
            {"row_number": 2, "name": "Bad",  "email": "notanemail",  "branch": "CS"},
        ]
        self.exec_rpc("admin_import_roster", payload, success=False)
        count = self.sql("SELECT count(*) FROM public.participants WHERE registered_email = 'good@ex.com'")
        self.assertEqual(count, "0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
