BEGIN;
CREATE OR REPLACE FUNCTION public.admin_delete_participants(participant_codes text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  requested integer;
  found_count integer;
  deleted integer;
  pair_ids uuid[];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Permission denied'; END IF;
  requested := pg_catalog.cardinality(participant_codes);
  IF participant_codes IS NULL OR requested NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Select between 1 and 1000 participants';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(participant_codes) c WHERE c IS NULL OR pg_catalog.btrim(c)='')
    OR (SELECT count(DISTINCT c) FROM pg_catalog.unnest(participant_codes) c) <> requested THEN
    RAISE EXCEPTION 'Invalid or duplicate participant codes';
  END IF;

  -- Serialize deletion with account linking and other operations
  PERFORM p.id FROM public.participants p WHERE p.participant_code=ANY(participant_codes)
    ORDER BY p.id FOR UPDATE;
  GET DIAGNOSTICS found_count = ROW_COUNT;
  IF found_count <> requested THEN RAISE EXCEPTION 'Roster changed. Refresh before deleting'; END IF;

  -- Find any pairs containing any of the participants to delete
  SELECT array_agg(DISTINCT pm.pair_id) INTO pair_ids
  FROM public.pair_members pm
  JOIN public.participants p ON p.id = pm.participant_id
  WHERE p.participant_code = ANY(participant_codes);

  IF pair_ids IS NOT NULL AND pg_catalog.cardinality(pair_ids) > 0 THEN
    -- Clear puzzle reservation in level1_puzzle_bank so the puzzle is freed for future pairs
    UPDATE public.level1_puzzle_bank
    SET assigned_pair_id = NULL
    WHERE assigned_pair_id = ANY(pair_ids);

    -- Delete pairs (cascades to pair_members)
    DELETE FROM public.pairs WHERE id = ANY(pair_ids);
  END IF;

  -- Delete participants
  DELETE FROM public.participants WHERE participant_code=ANY(participant_codes);
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object('deleted', deleted);
END;
$$;
ALTER FUNCTION public.admin_delete_participants(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_delete_participants(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_participants(text[]) TO authenticated;
COMMIT;
