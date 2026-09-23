-- Pair-wide completion. Reservations and photo metadata remain server-only.
ALTER TABLE public.pairs
    ADD COLUMN photo_url text,
    ADD COLUMN photo_public_id text UNIQUE,
    ADD COLUMN completed_at timestamptz,
    ADD COLUMN photo_upload_token uuid,
    ADD COLUMN photo_upload_started_at timestamptz,
    ADD CONSTRAINT pair_completion_consistent CHECK (
        (completed_at IS NULL AND photo_url IS NULL AND photo_public_id IS NULL)
        OR (completed_at IS NOT NULL AND photo_url IS NOT NULL AND photo_public_id IS NOT NULL
            AND solved_at IS NOT NULL AND puzzle_id IS NOT NULL)
    ),
    ADD CONSTRAINT pair_upload_reservation_consistent CHECK (
        (photo_upload_token IS NULL) = (photo_upload_started_at IS NULL)
    );
REVOKE ALL ON TABLE public.pairs FROM PUBLIC, anon, authenticated;

-- actor_user_id comes exclusively from a server-validated Auth user, never the request body.
CREATE FUNCTION public.begin_pair_photo_upload(actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pair_row public.pairs%ROWTYPE; mutual boolean; reservation uuid;
BEGIN
    SELECT p.* INTO pair_row FROM public.pairs p
    JOIN public.pair_members m ON m.pair_id = p.id
    JOIN public.participants participant ON participant.id = m.participant_id
    WHERE participant.auth_user_id = actor_user_id FOR UPDATE OF p;
    IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status', 'NOT_ELIGIBLE'); END IF;
    IF pair_row.completed_at IS NOT NULL OR pair_row.photo_url IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'ALREADY_COMPLETED');
    END IF;
    PERFORM m.participant_id FROM public.pair_members m WHERE m.pair_id = pair_row.id ORDER BY m.participant_id FOR SHARE;
    SELECT pg_catalog.count(*) = 2 AND pg_catalog.bool_and(m.verified_at IS NOT NULL)
        INTO mutual FROM public.pair_members m WHERE m.pair_id = pair_row.id;
    IF pair_row.puzzle_id IS NULL OR pair_row.solved_at IS NULL OR NOT mutual THEN
        RETURN pg_catalog.jsonb_build_object('status', 'NOT_ELIGIBLE');
    END IF;
    IF pair_row.photo_upload_token IS NOT NULL
       AND pair_row.photo_upload_started_at > pg_catalog.now() - interval '5 minutes' THEN
        RETURN pg_catalog.jsonb_build_object('status', 'UPLOAD_IN_PROGRESS');
    END IF;
    reservation := pg_catalog.gen_random_uuid();
    UPDATE public.pairs SET photo_upload_token = reservation, photo_upload_started_at = pg_catalog.now()
        WHERE id = pair_row.id;
    -- Fixed public ID + Cloudinary overwrite=false keeps retries to a single asset.
    RETURN pg_catalog.jsonb_build_object('status', 'RESERVED', 'upload_token', reservation,
        'photo_public_id', 'mec-level1/' || pair_row.id::text);
END;
$$;

CREATE FUNCTION public.finalize_pair_photo_upload(actor_user_id uuid, upload_token uuid, photo_url text, photo_public_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pair_row public.pairs%ROWTYPE; mutual boolean;
BEGIN
    SELECT p.* INTO pair_row FROM public.pairs p
    JOIN public.pair_members m ON m.pair_id = p.id
    JOIN public.participants participant ON participant.id = m.participant_id
    WHERE participant.auth_user_id = actor_user_id FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload not authorized'; END IF;
    IF photo_public_id IS NULL OR photo_public_id <> 'mec-level1/' || pair_row.id::text
       OR photo_url IS NULL OR pg_catalog.length(photo_url) > 2048
       OR photo_url !~ '^https://res[.]cloudinary[.]com/[a-zA-Z0-9_-]+/image/upload/' THEN
        RAISE EXCEPTION 'Invalid photo metadata';
    END IF;
    IF pair_row.completed_at IS NOT NULL THEN
        IF pair_row.photo_public_id <> photo_public_id OR pair_row.photo_url <> photo_url THEN
            RAISE EXCEPTION 'Pair already completed';
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'COMPLETED', 'completed_at', pair_row.completed_at);
    END IF;
    IF upload_token IS NULL OR pair_row.photo_upload_token IS DISTINCT FROM upload_token THEN
        RAISE EXCEPTION 'Upload not authorized';
    END IF;
    PERFORM m.participant_id FROM public.pair_members m WHERE m.pair_id = pair_row.id ORDER BY m.participant_id FOR SHARE;
    SELECT pg_catalog.count(*) = 2 AND pg_catalog.bool_and(m.verified_at IS NOT NULL)
        INTO mutual FROM public.pair_members m WHERE m.pair_id = pair_row.id;
    IF pair_row.puzzle_id IS NULL OR pair_row.solved_at IS NULL OR NOT mutual THEN
        RAISE EXCEPTION 'Pair is not ready for completion';
    END IF;
    UPDATE public.pairs p SET photo_url = finalize_pair_photo_upload.photo_url,
        photo_public_id = finalize_pair_photo_upload.photo_public_id, completed_at = pg_catalog.now(),
        photo_upload_token = NULL, photo_upload_started_at = NULL
        WHERE p.id = pair_row.id RETURNING p.completed_at INTO pair_row.completed_at;
    RETURN pg_catalog.jsonb_build_object('status', 'COMPLETED', 'completed_at', pair_row.completed_at);
END;
$$;

CREATE FUNCTION public.release_pair_photo_upload(actor_user_id uuid, upload_token uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    UPDATE public.pairs p SET photo_upload_token = NULL, photo_upload_started_at = NULL
    WHERE p.photo_upload_token = release_pair_photo_upload.upload_token AND p.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM public.pair_members m JOIN public.participants participant ON participant.id = m.participant_id
          WHERE m.pair_id = p.id AND participant.auth_user_id = actor_user_id);
$$;

CREATE FUNCTION public.admin_level1_progress()
RETURNS TABLE (
    pair_code text, member_a_code text, member_a_name text, member_b_code text, member_b_name text,
    puzzle_code text, a_verified boolean, b_verified boolean, mutual_verified boolean,
    a_locked boolean, b_locked boolean, solved boolean, photo_uploaded boolean, completed boolean, completed_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
    RETURN QUERY SELECT p.pair_code, pa.participant_code, pa.name, pb.participant_code, pb.name, puzzle.puzzle_code,
        a.verified_at IS NOT NULL, b.verified_at IS NOT NULL,
        a.verified_at IS NOT NULL AND b.verified_at IS NOT NULL,
        a.locked_at IS NOT NULL OR COALESCE(a.wrong_attempts, 0) >= 2,
        b.locked_at IS NOT NULL OR COALESCE(b.wrong_attempts, 0) >= 2,
        p.solved_at IS NOT NULL, p.photo_url IS NOT NULL, p.completed_at IS NOT NULL, p.completed_at
    FROM public.pairs p
    LEFT JOIN public.pair_members a ON a.pair_id = p.id AND a.fragment_slot = 'A'
    LEFT JOIN public.participants pa ON pa.id = a.participant_id
    LEFT JOIN public.pair_members b ON b.pair_id = p.id AND b.fragment_slot = 'B'
    LEFT JOIN public.participants pb ON pb.id = b.participant_id
    LEFT JOIN public.puzzles puzzle ON puzzle.id = p.puzzle_id
    ORDER BY p.pair_code;
END;
$$;

ALTER FUNCTION public.begin_pair_photo_upload(uuid) OWNER TO postgres;
ALTER FUNCTION public.finalize_pair_photo_upload(uuid, uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.release_pair_photo_upload(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_level1_progress() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_pair_photo_upload(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_pair_photo_upload(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_pair_photo_upload(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_level1_progress() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_pair_photo_upload(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_pair_photo_upload(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_pair_photo_upload(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_level1_progress() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_level1_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    participant public.participants%ROWTYPE;
    state record;
    result jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT * INTO participant FROM public.participants p WHERE p.auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    result := pg_catalog.jsonb_build_object('participant_code', participant.participant_code, 'name', participant.name,
        'photo_uploaded', false, 'completed', false, 'completed_at', NULL);
    SELECT pm.fragment_slot, pair.puzzle_id, pair.solved_at, pair.photo_url, pair.completed_at,
        CASE pm.fragment_slot WHEN 'A' THEN puzzle.grid_a ELSE puzzle.grid_b END AS assigned_grid,
        (SELECT pg_catalog.count(*) = 2 AND pg_catalog.bool_and(m.verified_at IS NOT NULL)
         FROM public.pair_members m WHERE m.pair_id = pair.id) AS mutual_verified
    INTO state FROM public.pair_members pm
    JOIN public.pairs pair ON pair.id = pm.pair_id
    LEFT JOIN public.puzzles puzzle ON puzzle.id = pair.puzzle_id
    WHERE pm.participant_id = participant.id;
    IF NOT FOUND THEN RETURN result || pg_catalog.jsonb_build_object('status', 'NOT_PAIRED'); END IF;
    result := result || pg_catalog.jsonb_build_object('fragment_slot', state.fragment_slot,
        'mutual_verified', state.mutual_verified, 'solved', state.solved_at IS NOT NULL,
        'photo_uploaded', state.photo_url IS NOT NULL, 'completed', state.completed_at IS NOT NULL, 'completed_at', state.completed_at);
    IF state.puzzle_id IS NULL THEN RETURN result || pg_catalog.jsonb_build_object('status', 'NO_PUZZLE'); END IF;
    result := result || pg_catalog.jsonb_build_object('assigned_grid', state.assigned_grid,
        'status', CASE WHEN state.completed_at IS NOT NULL THEN 'COMPLETED'
                       WHEN state.solved_at IS NOT NULL THEN 'SOLVED'
                       WHEN state.mutual_verified THEN 'READY_TO_SOLVE' ELSE 'FIND_PARTNER' END);
    IF state.solved_at IS NOT NULL THEN
        result := result || pg_catalog.jsonb_build_object('solved_at', state.solved_at);
    END IF;
    RETURN result;
END;
$$;

ALTER FUNCTION public.get_my_level1_state() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_my_level1_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_level1_state() TO authenticated;
