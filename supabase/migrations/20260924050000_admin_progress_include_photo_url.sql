-- Migration: include photo_url in admin_level1_progress
BEGIN;

DROP FUNCTION IF EXISTS public.admin_level1_progress();

CREATE FUNCTION public.admin_level1_progress()
RETURNS TABLE (
    pair_code text,
    member_a_code text,
    member_a_name text,
    member_b_code text,
    member_b_name text,
    puzzle_code text,
    a_verified boolean,
    b_verified boolean,
    mutual_verified boolean,
    a_locked boolean,
    b_locked boolean,
    solved boolean,
    photo_uploaded boolean,
    completed boolean,
    completed_at timestamptz,
    photo_url text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
    RETURN QUERY SELECT
        p.pair_code,
        pa.participant_code,
        pa.name,
        pb.participant_code,
        pb.name,
        puzzle.puzzle_code,
        a.verified_at IS NOT NULL,
        b.verified_at IS NOT NULL,
        a.verified_at IS NOT NULL AND b.verified_at IS NOT NULL,
        a.locked_at IS NOT NULL OR COALESCE(a.wrong_attempts, 0) >= 2,
        b.locked_at IS NOT NULL OR COALESCE(b.wrong_attempts, 0) >= 2,
        p.solved_at IS NOT NULL,
        p.photo_url IS NOT NULL,
        p.completed_at IS NOT NULL,
        p.completed_at,
        p.photo_url
    FROM public.pairs p
    LEFT JOIN public.pair_members a ON a.pair_id = p.id AND a.fragment_slot = 'A'
    LEFT JOIN public.participants pa ON pa.id = a.participant_id
    LEFT JOIN public.pair_members b ON b.pair_id = p.id AND b.fragment_slot = 'B'
    LEFT JOIN public.participants pb ON pb.id = b.participant_id
    LEFT JOIN public.puzzles puzzle ON puzzle.id = p.puzzle_id
    ORDER BY p.pair_code;
END;
$$;

ALTER FUNCTION public.admin_level1_progress() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_level1_progress() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_level1_progress() TO authenticated;

COMMIT;
