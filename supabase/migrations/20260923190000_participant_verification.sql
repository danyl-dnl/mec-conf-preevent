-- Migration: 20260923190000_participant_verification.sql
--
-- Adds verification state columns to pair_members and creates:
--   public.get_my_pair_state()          -- participant-facing
--   public.verify_my_partner(text)      -- participant-facing
--   public.admin_reset_partner_verification(text) -- admin-facing

-- ── Schema additions ─────────────────────────────────────────────────────────

ALTER TABLE public.pair_members
    ADD COLUMN wrong_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (wrong_attempts >= 0 AND wrong_attempts <= 2),
    ADD COLUMN verified_at   TIMESTAMPTZ NULL,
    ADD COLUMN locked_at     TIMESTAMPTZ NULL;

-- ── get_my_pair_state() ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_pair_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid           uuid;
    v_part_id       uuid;
    v_part_code     text;
    v_part_name     text;
    v_pair_id       uuid;
    v_fragment_slot text;
    v_wrong         integer;
    v_verified_at   timestamptz;
    v_locked_at     timestamptz;
    v_partner_verified boolean;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Resolve caller to participant via secure link
    SELECT id, participant_code, name
    INTO v_part_id, v_part_code, v_part_name
    FROM public.participants
    WHERE auth_user_id = v_uid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No participant record linked to this account';
    END IF;

    -- Check pair membership
    SELECT pm.pair_id, pm.fragment_slot, pm.wrong_attempts, pm.verified_at, pm.locked_at
    INTO v_pair_id, v_fragment_slot, v_wrong, v_verified_at, v_locked_at
    FROM public.pair_members pm
    WHERE pm.participant_id = v_part_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status',           'NOT_PAIRED',
            'participant_code', v_part_code,
            'name',             v_part_name
        );
    END IF;

    -- Check if partner has verified
    SELECT (pm.verified_at IS NOT NULL)
    INTO v_partner_verified
    FROM public.pair_members pm
    WHERE pm.pair_id = v_pair_id
      AND pm.participant_id <> v_part_id;

    IF NOT FOUND THEN
        v_partner_verified := false;
    END IF;

    RETURN jsonb_build_object(
        'status',             'PAIRED',
        'participant_code',   v_part_code,
        'name',               v_part_name,
        'fragment_slot',      v_fragment_slot,
        'wrong_attempts',     v_wrong,
        'attempts_remaining', GREATEST(0, 2 - v_wrong),
        'is_locked',          (v_locked_at IS NOT NULL),
        'self_verified',      (v_verified_at IS NOT NULL),
        'partner_verified',   v_partner_verified,
        'mutual_verified',    ((v_verified_at IS NOT NULL) AND v_partner_verified)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_pair_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_pair_state() TO authenticated;

-- ── verify_my_partner(text) ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verify_my_partner(partner_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid              uuid;
    v_part_id          uuid;
    v_pair_id          uuid;
    v_wrong            integer;
    v_verified_at      timestamptz;
    v_locked_at        timestamptz;
    v_actual_partner_id uuid;
    v_actual_partner_code text;
    v_guessed_id       uuid;
    v_new_wrong        integer;
    v_partner_verified boolean;
    v_attempted_code   text;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    v_attempted_code := btrim(partner_code);
    IF v_attempted_code = '' THEN
        RAISE EXCEPTION 'Partner code cannot be blank';
    END IF;

    -- Resolve caller
    SELECT id INTO v_part_id
    FROM public.participants
    WHERE auth_user_id = v_uid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No participant record linked to this account';
    END IF;

    -- Lock the caller's pair_members row for atomic update
    SELECT pm.pair_id, pm.wrong_attempts, pm.verified_at, pm.locked_at
    INTO v_pair_id, v_wrong, v_verified_at, v_locked_at
    FROM public.pair_members pm
    WHERE pm.participant_id = v_part_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'You are not currently in a pair';
    END IF;

    -- Idempotent: already verified
    IF v_verified_at IS NOT NULL THEN
        -- Check partner verification for accurate mutual state
        SELECT (pm.verified_at IS NOT NULL)
        INTO v_partner_verified
        FROM public.pair_members pm
        WHERE pm.pair_id = v_pair_id AND pm.participant_id <> v_part_id;

        RETURN jsonb_build_object(
            'status',           'VERIFIED',
            'self_verified',    true,
            'partner_verified', COALESCE(v_partner_verified, false),
            'mutual_verified',  COALESCE(v_partner_verified, false),
            'attempts_remaining', GREATEST(0, 2 - v_wrong)
        );
    END IF;

    -- Locked
    IF v_locked_at IS NOT NULL OR v_wrong >= 2 THEN
        RETURN jsonb_build_object(
            'status',           'LOCKED',
            'self_verified',    false,
            'attempts_remaining', 0
        );
    END IF;

    -- Resolve actual assigned partner (server-side, not from browser)
    SELECT pm.participant_id
    INTO v_actual_partner_id
    FROM public.pair_members pm
    WHERE pm.pair_id = v_pair_id
      AND pm.participant_id <> v_part_id;

    SELECT participant_code INTO v_actual_partner_code
    FROM public.participants
    WHERE id = v_actual_partner_id;

    -- Compare: attempt correct?
    IF v_attempted_code = v_actual_partner_code THEN
        -- Correct verification
        UPDATE public.pair_members
        SET verified_at = now()
        WHERE participant_id = v_part_id;

        -- Check partner
        SELECT (pm.verified_at IS NOT NULL)
        INTO v_partner_verified
        FROM public.pair_members pm
        WHERE pm.pair_id = v_pair_id AND pm.participant_id <> v_part_id;

        RETURN jsonb_build_object(
            'status',           'VERIFIED',
            'self_verified',    true,
            'partner_verified', COALESCE(v_partner_verified, false),
            'mutual_verified',  COALESCE(v_partner_verified, false),
            'attempts_remaining', GREATEST(0, 2 - v_wrong)
        );
    ELSE
        -- Wrong guess — do NOT reveal anything about guessed code
        v_new_wrong := v_wrong + 1;

        IF v_new_wrong >= 2 THEN
            UPDATE public.pair_members
            SET wrong_attempts = v_new_wrong,
                locked_at = now()
            WHERE participant_id = v_part_id;

            RETURN jsonb_build_object(
                'status',           'LOCKED',
                'self_verified',    false,
                'attempts_remaining', 0
            );
        ELSE
            UPDATE public.pair_members
            SET wrong_attempts = v_new_wrong
            WHERE participant_id = v_part_id;

            RETURN jsonb_build_object(
                'status',           'INCORRECT',
                'self_verified',    false,
                'attempts_remaining', GREATEST(0, 2 - v_new_wrong)
            );
        END IF;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_my_partner(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_my_partner(text) TO authenticated;

-- ── admin_reset_partner_verification(text) ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_reset_partner_verification(participant_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_part_id   uuid;
    v_part_code text;
    v_row_count integer;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    v_part_code := btrim(participant_code);
    IF v_part_code = '' THEN
        RAISE EXCEPTION 'Participant code cannot be blank';
    END IF;

    SELECT id INTO v_part_id
    FROM public.participants
    WHERE public.participants.participant_code = v_part_code;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown participant code: %', v_part_code;
    END IF;

    UPDATE public.pair_members
    SET wrong_attempts = 0,
        verified_at    = NULL,
        locked_at      = NULL
    WHERE participant_id = v_part_id;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 0 THEN
        RAISE EXCEPTION 'Participant % is not in any pair', v_part_code;
    END IF;

    RETURN jsonb_build_object(
        'success',          true,
        'participant_code', v_part_code,
        'wrong_attempts',   0,
        'is_locked',        false,
        'self_verified',    false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reset_partner_verification(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_partner_verification(text) TO authenticated;
