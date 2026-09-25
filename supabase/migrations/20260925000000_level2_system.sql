-- Migration: 20260925000000_level2_system.sql

CREATE TABLE public.level2_questions (
    id INT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL
);

INSERT INTO public.level2_questions (id, question, answer) VALUES
(1, 'What does HTML stand for?', 'hypertext markup language'),
(2, 'What year was JavaScript created?', '1995'),
(3, 'Which company developed React?', 'facebook'),
(4, 'What does CSS stand for?', 'cascading style sheets'),
(5, 'What is the most popular version control system?', 'git'),
(6, 'What does API stand for?', 'application programming interface'),
(7, 'Which protocol is used to secure web traffic?', 'https'),
(8, 'What is the time complexity of binary search?', 'o(log n)'),
(9, 'What does SQL stand for?', 'structured query language'),
(10, 'Who is known as the father of computer science?', 'alan turing');

ALTER TABLE public.pairs
ADD COLUMN level2_started_at TIMESTAMPTZ,
ADD COLUMN level2_completed_at TIMESTAMPTZ,
ADD COLUMN level2_question_order INT[],
ADD COLUMN level2_current_index INT DEFAULT 0;

-- get_my_level2_state
CREATE OR REPLACE FUNCTION public.get_my_level2_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_participant_id uuid;
    v_pair_id uuid;
    v_fragment_slot text;
    v_pair public.pairs%ROWTYPE;
    v_question text;
    result jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT id INTO v_participant_id FROM public.participants WHERE auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    
    SELECT pair_id, fragment_slot INTO v_pair_id, v_fragment_slot FROM public.pair_members WHERE participant_id = v_participant_id;
    IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status', 'NOT_PAIRED'); END IF;
    
    SELECT * INTO v_pair FROM public.pairs WHERE id = v_pair_id;
    IF v_pair.level2_started_at IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'NOT_STARTED');
    END IF;
    
    IF v_pair.level2_current_index >= 10 THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'COMPLETED',
            'started_at', v_pair.level2_started_at,
            'completed_at', v_pair.level2_completed_at,
            'completion_time_seconds', EXTRACT(EPOCH FROM (v_pair.level2_completed_at - v_pair.level2_started_at))
        );
    END IF;
    
    -- Active game
    SELECT question INTO v_question FROM public.level2_questions WHERE id = v_pair.level2_question_order[v_pair.level2_current_index + 1];
    
    result := pg_catalog.jsonb_build_object(
        'status', 'PLAYING',
        'current_index', v_pair.level2_current_index,
        'my_slot', v_fragment_slot
    );
    
    -- Index 0 is A, 1 is B, 2 is A, 3 is B...
    IF (v_pair.level2_current_index % 2 = 0 AND v_fragment_slot = 'A') OR 
       (v_pair.level2_current_index % 2 = 1 AND v_fragment_slot = 'B') THEN
        result := result || pg_catalog.jsonb_build_object('is_my_turn', true, 'question', v_question);
    ELSE
        result := result || pg_catalog.jsonb_build_object('is_my_turn', false);
    END IF;
    
    RETURN result;
END;
$$;

-- start_level2
CREATE OR REPLACE FUNCTION public.start_level2()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_participant_id uuid;
    v_pair_row public.pairs%ROWTYPE;
    v_order INT[];
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT id INTO v_participant_id FROM public.participants WHERE auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    
    SELECT p.* INTO v_pair_row FROM public.pairs p JOIN public.pair_members pm ON pm.pair_id = p.id
        WHERE pm.participant_id = v_participant_id FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not paired'; END IF;
    
    IF v_pair_row.level2_started_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'ALREADY_STARTED');
    END IF;
    
    -- Generate random array 1 to 10
    SELECT array_agg(id ORDER BY random()) INTO v_order FROM (SELECT generate_series(1,10) as id) as t;
    
    UPDATE public.pairs SET level2_started_at = pg_catalog.now(), level2_question_order = v_order, level2_current_index = 0
    WHERE id = v_pair_row.id;
    
    RETURN pg_catalog.jsonb_build_object('status', 'STARTED');
END;
$$;

-- submit_level2_answer
CREATE OR REPLACE FUNCTION public.submit_level2_answer(answer_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_participant_id uuid;
    v_fragment_slot text;
    v_pair_row public.pairs%ROWTYPE;
    v_expected_answer text;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT id INTO v_participant_id FROM public.participants WHERE auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    
    SELECT p.*, pm.fragment_slot INTO v_pair_row, v_fragment_slot FROM public.pairs p JOIN public.pair_members pm ON pm.pair_id = p.id
        WHERE pm.participant_id = v_participant_id FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not paired'; END IF;
    
    IF v_pair_row.level2_started_at IS NULL THEN RAISE EXCEPTION 'Level 2 not started'; END IF;
    IF v_pair_row.level2_current_index >= 10 THEN RAISE EXCEPTION 'Level 2 already completed'; END IF;
    
    IF (v_pair_row.level2_current_index % 2 = 0 AND v_fragment_slot <> 'A') OR 
       (v_pair_row.level2_current_index % 2 = 1 AND v_fragment_slot <> 'B') THEN
        RAISE EXCEPTION 'Not your turn';
    END IF;
    
    SELECT answer INTO v_expected_answer FROM public.level2_questions WHERE id = v_pair_row.level2_question_order[v_pair_row.level2_current_index + 1];
    
    IF pg_catalog.lower(pg_catalog.btrim(answer_text)) <> pg_catalog.lower(pg_catalog.btrim(v_expected_answer)) THEN
        RETURN pg_catalog.jsonb_build_object('status', 'INCORRECT');
    END IF;
    
    v_pair_row.level2_current_index := v_pair_row.level2_current_index + 1;
    
    IF v_pair_row.level2_current_index >= 10 THEN
        UPDATE public.pairs SET level2_current_index = 10, level2_completed_at = pg_catalog.now() WHERE id = v_pair_row.id;
        RETURN pg_catalog.jsonb_build_object('status', 'CORRECT', 'completed', true);
    ELSE
        UPDATE public.pairs SET level2_current_index = v_pair_row.level2_current_index WHERE id = v_pair_row.id;
        RETURN pg_catalog.jsonb_build_object('status', 'CORRECT', 'completed', false);
    END IF;
END;
$$;

-- admin_list_level2_progress
CREATE OR REPLACE FUNCTION public.admin_list_level2_progress()
RETURNS TABLE (
    pair_code text,
    level2_started_at timestamptz,
    level2_completed_at timestamptz,
    level2_current_index int,
    completion_time_seconds double precision
) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT 
        pair_code,
        level2_started_at,
        level2_completed_at,
        level2_current_index,
        EXTRACT(EPOCH FROM (level2_completed_at - level2_started_at)) as completion_time_seconds
    FROM public.pairs
    WHERE level2_started_at IS NOT NULL
    ORDER BY completion_time_seconds ASC NULLS LAST, level2_current_index DESC;
$$;

REVOKE ALL ON FUNCTION public.get_my_level2_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_level2_state() TO authenticated;
REVOKE ALL ON FUNCTION public.start_level2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_level2() TO authenticated;
REVOKE ALL ON FUNCTION public.submit_level2_answer(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_level2_answer(text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_list_level2_progress() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_level2_progress() TO authenticated;

ALTER TABLE public.level2_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.level2_questions FROM PUBLIC, anon, authenticated;
