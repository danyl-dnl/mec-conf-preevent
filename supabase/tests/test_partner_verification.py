"""Run: python3 supabase/tests/test_partner_verification.py

Creates a temporary isolated PostgreSQL cluster, applies all migrations in
order, and tests the participant verification layer.

Never connects to remote database. Sequence restarts each setUp via TRUNCATE.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
import json

ROOT        = Path(__file__).resolve().parents[2]
BASELINE    = ROOT / "supabase/migrations/20260922000000_create_participants.sql"
MIGRATION1  = ROOT / "supabase/migrations/20260923063000_secure_participant_account_linking.sql"
MIGRATION2  = ROOT / "supabase/migrations/20260923140000_create_admin_authorization.sql"
MIGRATION3  = ROOT / "supabase/migrations/20260923160000_admin_roster_import.sql"
MIGRATION4  = ROOT / "supabase/migrations/20260923170000_admin_list_participants.sql"
MIGRATION5  = ROOT / "supabase/migrations/20260923180000_admin_pair_system.sql"
MIGRATION6  = ROOT / "supabase/migrations/20260923190000_participant_verification.sql"

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


class VerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for command in ("initdb", "pg_ctl", "psql"):
            if shutil.which(command) is None:
                raise RuntimeError(f"Required PostgreSQL binary missing: {command}")
        cls.temp = tempfile.TemporaryDirectory(prefix="mec-verification-", dir="/tmp")
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
        cls.sql("BEGIN;\n" + MIGRATION6.read_text() + "\nCOMMIT;")

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
        self.sql(
            "TRUNCATE public.pairs CASCADE; "
            "TRUNCATE public.participants CASCADE; "
            "TRUNCATE public.admins CASCADE; "
            "TRUNCATE auth.users CASCADE;"
        )

    def q_json(self, query, uid=None):
        prefix = f"SET request.jwt.claim.sub = '{uid}'; SET ROLE authenticated; " if uid else ""
        out, _ = self.sql(prefix + "SELECT COALESCE(json_agg(t), '[]'::json) FROM (" + query + ") t")
        return json.loads(out) if out.strip() else []

    def q_one(self, query, uid=None):
        """Run a query that returns a single value and return the raw string output."""
        prefix = f"SET request.jwt.claim.sub = '{uid}'; SET ROLE authenticated; " if uid else ""
        out, _ = self.sql(prefix + query)
        return out.strip() if out.strip() else None

    def create_admin(self):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id) VALUES ('{uid}')")
        self.sql(f"INSERT INTO public.admins (auth_user_id) VALUES ('{uid}')")
        return uid

    def create_participant(self, pcode, name="Name", branch="CS"):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id) VALUES ('{uid}')")
        bval = f"'{branch}'" if branch else "NULL"
        self.sql(f"INSERT INTO public.participants (auth_user_id, participant_code, name, branch, registered_email) "
                 f"VALUES ('{uid}', '{pcode}', '{name}', {bval}, '{pcode}@a.com')")
        return uid

    def create_pair(self, admin_uid, code_a, code_b):
        self.sql(f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; "
                 f"SELECT public.admin_create_pair('{code_a}', '{code_b}')")

    # ─── Schema ──────────────────────────────────────────────────────────────

    def test_schema_new_columns_exist(self):
        out, _ = self.sql(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'pair_members' "
            "AND column_name IN ('wrong_attempts', 'verified_at', 'locked_at')"
        )
        for col in ("wrong_attempts", "verified_at", "locked_at"):
            self.assertIn(col, out)

    def test_schema_wrong_attempts_check_constraint(self):
        admin_uid = self.create_admin()
        self.create_participant("C1")
        self.create_participant("C2")
        self.create_pair(admin_uid, "C1", "C2")
        # Attempt direct update to 3 (violates CHECK)
        self.sql(
            "UPDATE public.pair_members SET wrong_attempts = 3 "
            "WHERE participant_id = (SELECT id FROM public.participants WHERE participant_code = 'C1')",
            success=False
        )

    # ─── Identity / Auth ─────────────────────────────────────────────────────

    def test_get_my_pair_state_requires_authenticated(self):
        self.sql("SET ROLE anon; SELECT public.get_my_pair_state()", success=False)

    def test_get_my_pair_state_no_linked_participant(self):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users (id) VALUES ('{uid}')")
        self.sql(f"SET request.jwt.claim.sub = '{uid}'; SET ROLE authenticated; "
                 f"SELECT public.get_my_pair_state()", success=False)

    def test_get_my_pair_state_not_paired(self):
        uid_a = self.create_participant("NP1")
        result = self.q_one(f"SELECT public.get_my_pair_state()", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "NOT_PAIRED")
        self.assertEqual(data["participant_code"], "NP1")
        self.assertNotIn("pair_id", data)
        self.assertNotIn("partner_code", data)

    def test_get_my_pair_state_paired(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("PA1")
        uid_b = self.create_participant("PA2")
        self.create_pair(admin_uid, "PA1", "PA2")
        result = self.q_one("SELECT public.get_my_pair_state()", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "PAIRED")
        self.assertEqual(data["participant_code"], "PA1")
        self.assertEqual(data["fragment_slot"], "A")
        self.assertEqual(data["wrong_attempts"], 0)
        self.assertEqual(data["attempts_remaining"], 2)
        self.assertFalse(data["is_locked"])
        self.assertFalse(data["self_verified"])
        self.assertFalse(data["partner_verified"])
        self.assertFalse(data["mutual_verified"])
        # Partner info must NOT be present
        for key in ("partner_code", "partner_name", "partner_email"):
            self.assertNotIn(key, data)

    # ─── Correct Verification ────────────────────────────────────────────────

    def test_correct_verification_a_verifies_b(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("V1")
        uid_b = self.create_participant("V2")
        self.create_pair(admin_uid, "V1", "V2")

        result = self.q_one("SELECT public.verify_my_partner('V2')", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "VERIFIED")
        self.assertTrue(data["self_verified"])
        self.assertFalse(data["partner_verified"])
        self.assertFalse(data["mutual_verified"])

        # wrong_attempts must remain 0
        out, _ = self.sql("SELECT wrong_attempts FROM public.pair_members WHERE participant_id = "
                          "(SELECT id FROM public.participants WHERE participant_code = 'V1')")
        self.assertEqual(out.strip(), "0")

    def test_correct_verification_mutual(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("M1")
        uid_b = self.create_participant("M2")
        self.create_pair(admin_uid, "M1", "M2")

        # A verifies B
        self.q_one("SELECT public.verify_my_partner('M2')", uid=uid_a)
        # B verifies A
        result = self.q_one("SELECT public.verify_my_partner('M1')", uid=uid_b)
        data = json.loads(result)
        self.assertEqual(data["status"], "VERIFIED")
        self.assertTrue(data["self_verified"])
        self.assertTrue(data["partner_verified"])
        self.assertTrue(data["mutual_verified"])

        # get_my_pair_state reflects mutual for both
        state_a = json.loads(self.q_one("SELECT public.get_my_pair_state()", uid=uid_a))
        self.assertTrue(state_a["mutual_verified"])
        state_b = json.loads(self.q_one("SELECT public.get_my_pair_state()", uid=uid_b))
        self.assertTrue(state_b["mutual_verified"])

    # ─── Wrong Attempts ──────────────────────────────────────────────────────

    def test_first_wrong_attempt(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("W1")
        uid_b = self.create_participant("W2")
        self.create_pair(admin_uid, "W1", "W2")

        result = self.q_one("SELECT public.verify_my_partner('WRONG-CODE')", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "INCORRECT")
        self.assertEqual(data["attempts_remaining"], 1)
        self.assertFalse(data["self_verified"])

        out, _ = self.sql("SELECT wrong_attempts FROM public.pair_members WHERE participant_id = "
                          "(SELECT id FROM public.participants WHERE participant_code = 'W1')")
        self.assertEqual(out.strip(), "1")

    def test_second_wrong_attempt_locks(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("L1")
        uid_b = self.create_participant("L2")
        self.create_pair(admin_uid, "L1", "L2")

        self.q_one("SELECT public.verify_my_partner('WRONG1')", uid=uid_a)
        result = self.q_one("SELECT public.verify_my_partner('WRONG2')", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "LOCKED")
        self.assertEqual(data["attempts_remaining"], 0)

        out, _ = self.sql("SELECT wrong_attempts, locked_at IS NOT NULL FROM public.pair_members "
                          "WHERE participant_id = (SELECT id FROM public.participants WHERE participant_code = 'L1')")
        parts = out.strip().split("|")
        self.assertEqual(parts[0].strip(), "2")
        self.assertEqual(parts[1].strip(), "t")

    def test_third_attempt_rejected_as_locked(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("LK1")
        uid_b = self.create_participant("LK2")
        self.create_pair(admin_uid, "LK1", "LK2")

        self.q_one("SELECT public.verify_my_partner('WRONG1')", uid=uid_a)
        self.q_one("SELECT public.verify_my_partner('WRONG2')", uid=uid_a)
        # Correct code after lock still rejected
        result = self.q_one("SELECT public.verify_my_partner('LK2')", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "LOCKED")
        self.assertEqual(data["attempts_remaining"], 0)

        # Counter must remain at 2
        out, _ = self.sql("SELECT wrong_attempts FROM public.pair_members WHERE participant_id = "
                          "(SELECT id FROM public.participants WHERE participant_code = 'LK1')")
        self.assertEqual(out.strip(), "2")

    # ─── Idempotency ─────────────────────────────────────────────────────────

    def test_already_verified_is_idempotent(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("ID1")
        uid_b = self.create_participant("ID2")
        self.create_pair(admin_uid, "ID1", "ID2")

        self.q_one("SELECT public.verify_my_partner('ID2')", uid=uid_a)
        # Call again
        result = self.q_one("SELECT public.verify_my_partner('ID2')", uid=uid_a)
        data = json.loads(result)
        self.assertEqual(data["status"], "VERIFIED")
        self.assertTrue(data["self_verified"])

        # wrong_attempts unchanged
        out, _ = self.sql("SELECT wrong_attempts FROM public.pair_members WHERE participant_id = "
                          "(SELECT id FROM public.participants WHERE participant_code = 'ID1')")
        self.assertEqual(out.strip(), "0")

    # ─── Privacy ─────────────────────────────────────────────────────────────

    def test_wrong_guess_reveals_nothing(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("PR1")
        uid_b = self.create_participant("PR2")
        self.create_pair(admin_uid, "PR1", "PR2")

        result = self.q_one("SELECT public.verify_my_partner('PR2-WRONG')", uid=uid_a)
        data = json.loads(result)
        # Must not reveal anything about guessed code or actual partner
        for key in ("partner_code", "partner_name", "correct_code", "actual_partner"):
            self.assertNotIn(key, data)
        self.assertEqual(data["status"], "INCORRECT")

    def test_wrong_guess_for_nonexistent_code_same_as_wrong(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("PR3")
        uid_b = self.create_participant("PR4")
        self.create_pair(admin_uid, "PR3", "PR4")

        result = self.q_one("SELECT public.verify_my_partner('FAKE-999')", uid=uid_a)
        data = json.loads(result)
        # Same INCORRECT — does not reveal whether FAKE-999 exists
        self.assertEqual(data["status"], "INCORRECT")

    # ─── Admin Reset ─────────────────────────────────────────────────────────

    def test_admin_reset_clears_state(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("AR1")
        uid_b = self.create_participant("AR2")
        self.create_pair(admin_uid, "AR1", "AR2")

        # Lock participant A
        self.q_one("SELECT public.verify_my_partner('WRONG1')", uid=uid_a)
        self.q_one("SELECT public.verify_my_partner('WRONG2')", uid=uid_a)

        # Admin resets A
        out, _ = self.sql(
            f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; "
            f"SELECT public.admin_reset_partner_verification('AR1')"
        )
        data = json.loads(out.strip())
        self.assertTrue(data["success"])
        self.assertEqual(data["participant_code"], "AR1")
        self.assertEqual(data["wrong_attempts"], 0)
        self.assertFalse(data["is_locked"])
        self.assertFalse(data["self_verified"])

        # A can now attempt again
        result2 = self.q_one("SELECT public.verify_my_partner('AR2')", uid=uid_a)
        data2 = json.loads(result2) if isinstance(result2, str) else result2
        self.assertEqual(data2["status"], "VERIFIED")

    def test_admin_reset_unpaired_checks_row_count(self):
        admin_uid = self.create_admin()
        self.create_participant("UNPAIRED")
        _, error = self.sql(
            f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; "
            "SELECT public.admin_reset_partner_verification('UNPAIRED')",
            success=False,
        )
        self.assertIn("is not in any pair", error)

    def test_admin_reset_does_not_affect_partner(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("RP1")
        uid_b = self.create_participant("RP2")
        self.create_pair(admin_uid, "RP1", "RP2")

        # B verifies A
        self.q_one("SELECT public.verify_my_partner('RP1')", uid=uid_b)

        # Admin resets A (not B)
        self.sql(
            f"SET request.jwt.claim.sub = '{admin_uid}'; SET ROLE authenticated; "
            f"SELECT public.admin_reset_partner_verification('RP1')"
        )

        # B should still be verified
        out, _ = self.sql("SELECT verified_at IS NOT NULL FROM public.pair_members WHERE participant_id = "
                          "(SELECT id FROM public.participants WHERE participant_code = 'RP2')")
        self.assertEqual(out.strip(), "t")

    def test_admin_reset_non_admin_rejected(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("RJ1")
        uid_b = self.create_participant("RJ2")
        self.create_pair(admin_uid, "RJ1", "RJ2")
        self.sql(
            f"SET request.jwt.claim.sub = '{uid_a}'; SET ROLE authenticated; "
            f"SELECT public.admin_reset_partner_verification('RJ2')",
            success=False
        )

    # ─── Security ────────────────────────────────────────────────────────────

    def test_verify_requires_authenticated(self):
        self.sql("SET ROLE anon; SELECT public.verify_my_partner('ANYTHING')", success=False)

    def test_direct_pair_members_update_denied(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("DU1")
        uid_b = self.create_participant("DU2")
        self.create_pair(admin_uid, "DU1", "DU2")
        self.sql(
            f"SET request.jwt.claim.sub = '{uid_a}'; SET ROLE authenticated; "
            f"UPDATE public.pair_members SET wrong_attempts = 0",
            success=False
        )

    def test_no_uuid_exposure_in_pair_state(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("UUID1")
        uid_b = self.create_participant("UUID2")
        self.create_pair(admin_uid, "UUID1", "UUID2")
        result = self.q_one("SELECT public.get_my_pair_state()", uid=uid_a)
        data = json.loads(result)
        for key in ("id", "pair_id", "participant_id", "auth_user_id"):
            self.assertNotIn(key, data)

    def test_wrong_attempts_cannot_exceed_2_via_constraint(self):
        admin_uid = self.create_admin()
        uid_a = self.create_participant("CE1")
        uid_b = self.create_participant("CE2")
        self.create_pair(admin_uid, "CE1", "CE2")
        self.sql(
            "UPDATE public.pair_members SET wrong_attempts = 3 "
            "WHERE participant_id = (SELECT id FROM public.participants WHERE participant_code = 'CE1')",
            success=False
        )


if __name__ == "__main__":
    unittest.main()
