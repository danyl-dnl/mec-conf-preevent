UPDATE public.pairs 
SET level2_started_at = NULL, 
    level2_completed_at = NULL, 
    level2_current_index = 0, 
    level2_question_order = NULL
WHERE level2_started_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.start_level2()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_participant_id uuid;
    v_pair_row public.pairs%ROWTYPE;
    v_order INT[];
BEGIN
    IF pg_catalog.now() < '2026-09-25 19:45:00+05:30'::timestamptz THEN
        RAISE EXCEPTION 'Level 2 starts at exactly 7:45 PM';
    END IF;

    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT id INTO v_participant_id FROM public.participants WHERE auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    
    SELECT p.* INTO v_pair_row FROM public.pairs p JOIN public.pair_members pm ON pm.pair_id = p.id
        WHERE pm.participant_id = v_participant_id FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not paired'; END IF;
    
    IF v_pair_row.completed_at IS NULL THEN
        RAISE EXCEPTION 'Level 1 must be completed before starting Level 2';
    END IF;
    
    IF v_pair_row.level2_started_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'ALREADY_STARTED');
    END IF;
    
    SELECT array_agg(id ORDER BY random()) INTO v_order FROM (SELECT generate_series(1,10) as id) as t;
    UPDATE public.pairs SET level2_started_at = pg_catalog.now(), level2_question_order = v_order, level2_current_index = 0
    WHERE id = v_pair_row.id;
    RETURN pg_catalog.jsonb_build_object('status', 'STARTED');
END;
$$;
