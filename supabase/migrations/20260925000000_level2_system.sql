-- Migration: 20260925000000_level2_system.sql

CREATE TABLE public.level2_questions (
    id INT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL
);

INSERT INTO public.level2_questions (id, question, answer) VALUES
(1, 'What number comes next? 1, 11, 21, 1211, 111221, ?', '312211'),
(2, 'You have 9 identical-looking coins, but exactly one is heavier. Using a balance scale, what is the minimum number of weighings needed to guarantee finding the heavier coin?', '2'),
(3, 'An island is populated by two types of people: Knights (who always tell the truth) and Knaves (who always lie). You meet a group of 10 locals standing in a circle. Each person makes the exact same statement: "The person to my immediate right is a Knave." What is the exact total number of Knights in this circle?', '5'),
(4, 'A logistics warehouse stores five types of cargo containers, each named after a natural element: Fire, Water, Earth, Air, and Metal. The security protocols dictate that the Fire container can only be opened when the Air container is open. The Earth container cannot be open if the Metal container is open. Currently, the Metal container is open, the Water container is closed, and the Air container is closed. Which single container is it logically impossible to open right now? (The answer you enter should be an integer. So sum up the numbers corresponding to each letter of the word and enter the sum as the answer.)', '38'),
(5, 'There are 100 switches, all initially OFF. You make 100 passes. On pass 1, you toggle every switch. On pass 2, every second switch. On pass 3, every third switch, and so on. After all 100 passes, how many switches are ON?', '10'),
(6, 'What is the next number in the sequence: 2, 4, 6, 30, 32, 34, 36, 40, 42, 44, 46, 50, 52, 54, 56, 60, 62, 64, 66, ?', '2000'),
(7, 'What is the only common English word that contains three consecutive pairs of double letters? (The answer you enter should be an integer. So sum up the numbers corresponding to each letter of the word and enter the sum as the answer.)', '103'),
(8, 'Find the smallest positive number that leaves a remainder of 1 when divided by 2, 2 when divided by 3, 3 when divided by 4, 4 when divided by 5, and 5 when divided by 6.', '59'),
(9, 'A single-elimination tennis tournament starts with exactly 32 players. A player is permanently knocked out the moment they lose a single match. How many total matches must be played across the entire tournament to determine the lone undefeated champion?', '31'),
(10, 'Five people - A, B, C, D and E - are standing in a line. A is somewhere to the left of B. C is immediately to the right of D. E is not at either end. If D is in position 2, what position must C occupy?', '3');

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
    
    SELECT pm.fragment_slot INTO v_fragment_slot FROM public.pair_members pm WHERE pm.participant_id = v_participant_id;
    SELECT p.* INTO v_pair_row FROM public.pairs p JOIN public.pair_members pm ON pm.pair_id = p.id
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
