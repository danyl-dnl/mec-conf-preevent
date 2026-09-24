-- Add automatic allocation without changing existing pairing or participant RPCs.
BEGIN;
CREATE TABLE public.level1_puzzle_bank (
  puzzle_id uuid PRIMARY KEY REFERENCES public.puzzles(id) ON DELETE CASCADE,
  assigned_pair_id uuid UNIQUE REFERENCES public.pairs(id) ON DELETE RESTRICT
);
ALTER TABLE public.level1_puzzle_bank ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.level1_puzzle_bank FROM PUBLIC, anon, authenticated;

-- Enforce a bank puzzle's reservation even when the existing manual assignment
-- RPC is used. Previously assigned bank puzzles are never silently reused.
CREATE FUNCTION public.reserve_level1_bank_puzzle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE reservation public.level1_puzzle_bank%ROWTYPE;
BEGIN
  IF NEW.puzzle_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO reservation FROM public.level1_puzzle_bank WHERE puzzle_id=NEW.puzzle_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (reservation.assigned_pair_id IS NOT NULL AND reservation.assigned_pair_id <> NEW.id)
     OR EXISTS (SELECT 1 FROM public.pairs p WHERE p.puzzle_id=NEW.puzzle_id AND p.id<>NEW.id) THEN
    RAISE EXCEPTION 'This bank puzzle is already reserved for another pair';
  END IF;
  UPDATE public.level1_puzzle_bank SET assigned_pair_id=NEW.id WHERE puzzle_id=NEW.puzzle_id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.reserve_level1_bank_puzzle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reserve_level1_bank_puzzle() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER reserve_level1_bank_puzzle AFTER INSERT OR UPDATE OF puzzle_id ON public.pairs
FOR EACH ROW EXECUTE FUNCTION public.reserve_level1_bank_puzzle();

-- Internal allocator. Reservation rows are locked so concurrent organizers cannot
-- automatically allocate the same puzzle. Reservations remain consumed even if
-- an organizer subsequently assigns a different puzzle manually.
CREATE FUNCTION public.allocate_level1_bank_puzzle(target_pair_code text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE pair_row public.pairs%ROWTYPE; selected_id uuid; selected_code text;
BEGIN
  SELECT * INTO STRICT pair_row FROM public.pairs WHERE pair_code = target_pair_code FOR UPDATE;
  IF pair_row.puzzle_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('pair_code', pair_row.pair_code, 'assigned', false);
  END IF;
  SELECT bank.puzzle_id, puzzle.puzzle_code INTO selected_id, selected_code
  FROM public.level1_puzzle_bank bank JOIN public.puzzles puzzle ON puzzle.id=bank.puzzle_id
  WHERE bank.assigned_pair_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.pairs existing WHERE existing.puzzle_id=bank.puzzle_id)
  ORDER BY puzzle.puzzle_code
  LIMIT 1 FOR UPDATE OF bank SKIP LOCKED;
  IF selected_id IS NULL THEN
    RAISE EXCEPTION 'No unused puzzle available. Add puzzles to the bank before creating more pairs.';
  END IF;
  UPDATE public.level1_puzzle_bank SET assigned_pair_id=pair_row.id WHERE puzzle_id=selected_id;
  PERFORM public.admin_assign_puzzle_to_pair(pair_row.pair_code, selected_code);
  RETURN pg_catalog.jsonb_build_object('pair_code', pair_row.pair_code, 'assigned', true);
END;
$$;
ALTER FUNCTION public.allocate_level1_bank_puzzle(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.allocate_level1_bank_puzzle(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.admin_create_bank_puzzle(puzzle_code text, grid_a jsonb, grid_b jsonb, correct_answer text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
  -- Serialize keyword uniqueness checks for concurrent organizer saves.
  PERFORM pg_catalog.pg_advisory_xact_lock(9242026, 1);
  IF EXISTS (SELECT 1 FROM public.level1_puzzle_bank b JOIN public.puzzles p ON p.id=b.puzzle_id
             WHERE lower(btrim(p.correct_answer))=lower(btrim(admin_create_bank_puzzle.correct_answer))) THEN
    RAISE EXCEPTION 'This keyword already exists in the puzzle bank';
  END IF;
  result := public.admin_create_puzzle(puzzle_code, grid_a, grid_b, correct_answer);
  INSERT INTO public.level1_puzzle_bank(puzzle_id) SELECT id FROM public.puzzles p WHERE p.puzzle_code=result->>'puzzle_code';
  RETURN result;
END;
$$;
ALTER FUNCTION public.admin_create_bank_puzzle(text,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_bank_puzzle(text,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_bank_puzzle(text,jsonb,jsonb,text) TO authenticated;

CREATE FUNCTION public.admin_create_pair_with_puzzle(participant_code_a text, participant_code_b text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
  result := public.admin_create_pair(participant_code_a, participant_code_b);
  PERFORM public.allocate_level1_bank_puzzle(result->>'pair_code');
  RETURN result;
END;
$$;

CREATE FUNCTION public.admin_assign_pending_puzzles()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pair_code text; result jsonb; assigned integer := 0;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
  FOR pair_code IN SELECT p.pair_code FROM public.pairs p WHERE p.puzzle_id IS NULL ORDER BY p.pair_code LOOP
    result := public.allocate_level1_bank_puzzle(pair_code);
    IF (result->>'assigned')::boolean THEN assigned := assigned + 1; END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('assigned', assigned);
END;
$$;

CREATE FUNCTION public.admin_puzzle_bank_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'total', (SELECT count(*) FROM public.level1_puzzle_bank),
    'available', (SELECT count(*) FROM public.level1_puzzle_bank b WHERE b.assigned_pair_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.pairs p WHERE p.puzzle_id=b.puzzle_id)),
    'pending_pairs', (SELECT count(*) FROM public.pairs WHERE puzzle_id IS NULL));
END;
$$;
ALTER FUNCTION public.admin_create_pair_with_puzzle(text,text) OWNER TO postgres;
ALTER FUNCTION public.admin_assign_pending_puzzles() OWNER TO postgres;
ALTER FUNCTION public.admin_puzzle_bank_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_create_pair_with_puzzle(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_assign_pending_puzzles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_puzzle_bank_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_pair_with_puzzle(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_pending_puzzles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_puzzle_bank_status() TO authenticated;
COMMIT;
