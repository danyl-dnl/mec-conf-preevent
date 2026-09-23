-- Level 1: private complementary grids and pair-scoped answer validation.
CREATE FUNCTION public.level1_grid_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
    row_value jsonb;
    cell_value jsonb;
    width integer;
BEGIN
    IF value IS NULL OR pg_catalog.jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
    IF pg_catalog.jsonb_array_length(value) NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
    FOR row_value IN SELECT pg_catalog.jsonb_array_elements(value) LOOP
        IF pg_catalog.jsonb_typeof(row_value) <> 'array' THEN RETURN false; END IF;
        IF width IS NULL THEN width := pg_catalog.jsonb_array_length(row_value); END IF;
        IF width NOT BETWEEN 1 AND 10 OR pg_catalog.jsonb_array_length(row_value) <> width THEN RETURN false; END IF;
        FOR cell_value IN SELECT pg_catalog.jsonb_array_elements(row_value) LOOP
            IF pg_catalog.jsonb_typeof(cell_value) <> 'string'
               OR pg_catalog.length(cell_value #>> '{}') > 128 THEN RETURN false; END IF;
        END LOOP;
    END LOOP;
    RETURN true;
END;
$$;
ALTER FUNCTION public.level1_grid_valid(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.level1_grid_valid(jsonb) FROM PUBLIC, anon, authenticated;

CREATE TABLE public.puzzles (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    puzzle_code text UNIQUE NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(puzzle_code)) BETWEEN 1 AND 128),
    grid_a jsonb NOT NULL CHECK (public.level1_grid_valid(grid_a)),
    grid_b jsonb NOT NULL CHECK (public.level1_grid_valid(grid_b)),
    correct_answer text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(correct_answer)) BETWEEN 1 AND 1024),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CHECK (pg_catalog.jsonb_array_length(grid_a) = pg_catalog.jsonb_array_length(grid_b)
       AND pg_catalog.jsonb_array_length(grid_a -> 0) = pg_catalog.jsonb_array_length(grid_b -> 0))
);
ALTER TABLE public.puzzles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.puzzles FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pairs
    ADD COLUMN puzzle_id uuid REFERENCES public.puzzles(id) ON DELETE RESTRICT,
    ADD COLUMN solved_at timestamptz,
    ADD CONSTRAINT solved_requires_puzzle CHECK (solved_at IS NULL OR puzzle_id IS NOT NULL);

CREATE FUNCTION public.admin_create_puzzle(puzzle_code text, grid_a jsonb, grid_b jsonb, correct_answer text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE code text := pg_catalog.btrim(puzzle_code);
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
    IF code IS NULL OR pg_catalog.length(code) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid puzzle code'; END IF;
    IF NOT public.level1_grid_valid(grid_a) OR NOT public.level1_grid_valid(grid_b) THEN
        RAISE EXCEPTION 'Grids must be rectangular string arrays of 1 to 10 rows and columns; cells may contain up to 128 characters';
    END IF;
    IF pg_catalog.jsonb_array_length(grid_a) <> pg_catalog.jsonb_array_length(grid_b)
       OR pg_catalog.jsonb_array_length(grid_a -> 0) <> pg_catalog.jsonb_array_length(grid_b -> 0) THEN
        RAISE EXCEPTION 'Grid dimensions must match';
    END IF;
    IF correct_answer IS NULL OR pg_catalog.length(pg_catalog.btrim(correct_answer)) NOT BETWEEN 1 AND 1024 THEN
        RAISE EXCEPTION 'Invalid answer';
    END IF;
    INSERT INTO public.puzzles (puzzle_code, grid_a, grid_b, correct_answer)
        VALUES (code, grid_a, grid_b, correct_answer);
    RETURN pg_catalog.jsonb_build_object('puzzle_code', code);
END;
$$;

CREATE FUNCTION public.admin_list_puzzles()
RETURNS TABLE (puzzle_code text, grid_rows integer, grid_columns integer, assigned_pair_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
    RETURN QUERY SELECT p.puzzle_code, pg_catalog.jsonb_array_length(p.grid_a),
        pg_catalog.jsonb_array_length(p.grid_a -> 0),
        (SELECT pg_catalog.count(*) FROM public.pairs pair WHERE pair.puzzle_id = p.id)
        FROM public.puzzles p ORDER BY p.puzzle_code;
END;
$$;

CREATE FUNCTION public.admin_assign_puzzle_to_pair(target_pair_code text, target_puzzle_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pair_row public.pairs%ROWTYPE; puzzle_row public.puzzles%ROWTYPE;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
    SELECT * INTO pair_row FROM public.pairs p WHERE p.pair_code = pg_catalog.btrim(target_pair_code) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pair not found'; END IF;
    SELECT * INTO puzzle_row FROM public.puzzles p WHERE p.puzzle_code = pg_catalog.btrim(target_puzzle_code);
    IF NOT FOUND THEN RAISE EXCEPTION 'Puzzle not found'; END IF;
    IF pair_row.puzzle_id IS DISTINCT FROM puzzle_row.id THEN
        IF pair_row.solved_at IS NOT NULL THEN RAISE EXCEPTION 'Solved pair cannot be reassigned'; END IF;
        UPDATE public.pairs SET puzzle_id = puzzle_row.id WHERE id = pair_row.id;
    END IF;
    RETURN pg_catalog.jsonb_build_object('pair_code', pair_row.pair_code, 'puzzle_code', puzzle_row.puzzle_code);
END;
$$;

CREATE FUNCTION public.get_my_level1_state()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    participant public.participants%ROWTYPE;
    state record;
    result jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT * INTO participant FROM public.participants p WHERE p.auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    result := pg_catalog.jsonb_build_object('participant_code', participant.participant_code, 'name', participant.name);
    SELECT pm.fragment_slot, pair.puzzle_id, pair.solved_at,
        CASE pm.fragment_slot WHEN 'A' THEN puzzle.grid_a ELSE puzzle.grid_b END AS assigned_grid,
        (SELECT pg_catalog.count(*) = 2 AND pg_catalog.bool_and(m.verified_at IS NOT NULL)
         FROM public.pair_members m WHERE m.pair_id = pair.id) AS mutual_verified
    INTO state FROM public.pair_members pm
    JOIN public.pairs pair ON pair.id = pm.pair_id
    LEFT JOIN public.puzzles puzzle ON puzzle.id = pair.puzzle_id
    WHERE pm.participant_id = participant.id;
    IF NOT FOUND THEN RETURN result || pg_catalog.jsonb_build_object('status', 'NOT_PAIRED'); END IF;
    result := result || pg_catalog.jsonb_build_object('fragment_slot', state.fragment_slot,
        'mutual_verified', state.mutual_verified, 'solved', state.solved_at IS NOT NULL);
    IF state.puzzle_id IS NULL THEN RETURN result || pg_catalog.jsonb_build_object('status', 'NO_PUZZLE'); END IF;
    result := result || pg_catalog.jsonb_build_object('assigned_grid', state.assigned_grid,
        'status', CASE WHEN state.solved_at IS NOT NULL THEN 'SOLVED'
                       WHEN state.mutual_verified THEN 'READY_TO_SOLVE' ELSE 'FIND_PARTNER' END);
    IF state.solved_at IS NOT NULL THEN
        result := result || pg_catalog.jsonb_build_object('solved_at', state.solved_at);
    END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION public.submit_level1_answer(answer text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_participant_id uuid;
    pair_row public.pairs%ROWTYPE;
    expected_answer text;
    mutual boolean;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT p.id INTO v_participant_id FROM public.participants p WHERE p.auth_user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'No linked participant'; END IF;
    -- Serialize solving and assignment on the same pair.
    SELECT p.* INTO pair_row FROM public.pairs p JOIN public.pair_members pm ON pm.pair_id = p.id
        WHERE pm.participant_id = v_participant_id FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not paired'; END IF;
    IF pair_row.puzzle_id IS NULL THEN RAISE EXCEPTION 'No puzzle assigned'; END IF;
    -- Keep verification stable through the answer update, including organizer resets.
    PERFORM m.participant_id FROM public.pair_members m WHERE m.pair_id = pair_row.id ORDER BY m.participant_id FOR SHARE;
    SELECT pg_catalog.count(*) = 2 AND pg_catalog.bool_and(m.verified_at IS NOT NULL)
        INTO mutual FROM public.pair_members m WHERE m.pair_id = pair_row.id;
    IF NOT mutual THEN RAISE EXCEPTION 'Mutual verification required'; END IF;
    IF pair_row.solved_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'SOLVED', 'solved_at', pair_row.solved_at);
    END IF;
    IF answer IS NULL OR pg_catalog.length(pg_catalog.btrim(answer)) NOT BETWEEN 1 AND 1024 THEN
        RAISE EXCEPTION 'Answer must contain 1 to 1024 characters';
    END IF;
    SELECT p.correct_answer INTO expected_answer FROM public.puzzles p WHERE p.id = pair_row.puzzle_id;
    IF pg_catalog.lower(pg_catalog.btrim(answer)) <> pg_catalog.lower(pg_catalog.btrim(expected_answer)) THEN
        RETURN pg_catalog.jsonb_build_object('status', 'INCORRECT');
    END IF;
    UPDATE public.pairs SET solved_at = pg_catalog.now() WHERE id = pair_row.id AND solved_at IS NULL
        RETURNING solved_at INTO pair_row.solved_at;
    RETURN pg_catalog.jsonb_build_object('status', 'SOLVED', 'solved_at', pair_row.solved_at);
END;
$$;

ALTER FUNCTION public.admin_create_puzzle(text, jsonb, jsonb, text) OWNER TO postgres;
ALTER FUNCTION public.admin_list_puzzles() OWNER TO postgres;
ALTER FUNCTION public.admin_assign_puzzle_to_pair(text, text) OWNER TO postgres;
ALTER FUNCTION public.get_my_level1_state() OWNER TO postgres;
ALTER FUNCTION public.submit_level1_answer(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_puzzle(text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_list_puzzles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_assign_puzzle_to_pair(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_level1_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_level1_answer(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_puzzle(text, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_puzzles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_puzzle_to_pair(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_level1_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_level1_answer(text) TO authenticated;
