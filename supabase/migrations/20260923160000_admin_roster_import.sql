-- Roster Management backend logic
-- Creates participants.branch, participant_code sequence, and import/preview RPCs.

-- 1. Schema Updates
ALTER TABLE public.participants ADD COLUMN branch TEXT;

CREATE SEQUENCE public.participant_code_seq;

-- Dynamically initialize sequence based on existing MEC-NNN codes.
-- Only inspects codes strictly matching 'MEC-' followed by one or more digits.
DO $$
DECLARE
    max_val bigint;
BEGIN
    SELECT pg_catalog.max(
        pg_catalog.regexp_replace(participant_code, '^MEC-([0-9]+)$', '\1')::bigint
    )
    INTO max_val
    FROM public.participants
    WHERE participant_code ~ '^MEC-[0-9]+$';

    IF max_val IS NOT NULL THEN
        -- setval with is_called=true: next nextval() yields max_val + 1
        PERFORM pg_catalog.setval('public.participant_code_seq', max_val, true);
    ELSE
        -- setval with is_called=false: next nextval() yields 1
        PERFORM pg_catalog.setval('public.participant_code_seq', 1, false);
    END IF;
END;
$$;

-- 2. Preview Roster RPC
CREATE OR REPLACE FUNCTION public.admin_preview_roster(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    row jsonb;
    v_row_num int;
    v_name text;
    v_email text;
    v_branch text;
    v_norm_email text;
    v_category text;
    v_is_blocking boolean;
    v_is_suspicious boolean;
    db_row record;
    payload_emails text[] := '{}';
    is_duplicate_in_file boolean;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'array' THEN
        RAISE EXCEPTION 'Payload must be a JSON array';
    END IF;

    IF pg_catalog.jsonb_array_length(payload) < 1 OR pg_catalog.jsonb_array_length(payload) > 200 THEN
        RAISE EXCEPTION 'Payload must contain 1-200 rows';
    END IF;

    -- Pre-validation loop for payload duplicates
    FOR row IN SELECT * FROM pg_catalog.jsonb_array_elements(payload)
    LOOP
        IF pg_catalog.jsonb_typeof(row) <> 'object' THEN
            RAISE EXCEPTION 'Payload array elements must be objects';
        END IF;
        
        IF pg_catalog.jsonb_typeof(row->'email') = 'string' THEN
            v_email := pg_catalog.btrim(row->>'email');
            IF v_email IS NOT NULL AND v_email !~ '^[[:space:]]*$' THEN
                payload_emails := pg_catalog.array_append(payload_emails, pg_catalog.lower(v_email));
            END IF;
        END IF;
    END LOOP;

    -- Process each row
    FOR row IN SELECT * FROM pg_catalog.jsonb_array_elements(payload)
    LOOP
        v_category := 'NEW';
        v_is_blocking := false;
        v_is_suspicious := false;
        
        -- Safe row_number validation
        IF pg_catalog.jsonb_typeof(row->'row_number') <> 'number' THEN
            v_category := 'CONFLICT';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', -1, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;
        v_row_num := (row->>'row_number')::int;

        IF pg_catalog.jsonb_typeof(row->'name') <> 'string' OR
           pg_catalog.jsonb_typeof(row->'email') <> 'string' OR
           pg_catalog.jsonb_typeof(row->'branch') <> 'string' THEN
            v_category := 'MISSING_REQUIRED_FIELD';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;

        v_name := pg_catalog.btrim(row->>'name');
        v_email := pg_catalog.btrim(row->>'email');
        v_branch := pg_catalog.btrim(row->>'branch');

        -- Blank Check
        IF v_name ~ '^[[:space:]]*$' OR v_email ~ '^[[:space:]]*$' OR v_branch ~ '^[[:space:]]*$' THEN
            v_category := 'MISSING_REQUIRED_FIELD';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;
        
        -- Control character check (ASCII < 32 except space)
        -- We just reject if it matches \x00-\x1F
        IF v_name ~ '[\x00-\x1F]' OR v_email ~ '[\x00-\x1F]' OR v_branch ~ '[\x00-\x1F]' THEN
            v_category := 'CONFLICT';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;

        IF pg_catalog.length(v_name) > 100 OR pg_catalog.length(v_branch) > 50 OR pg_catalog.length(v_email) > 255 THEN
            v_category := 'CONFLICT';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;

        v_norm_email := pg_catalog.lower(v_email);

        -- Check duplicate in file
        SELECT count(*) > 1 INTO is_duplicate_in_file FROM pg_catalog.unnest(payload_emails) e WHERE e = v_norm_email;
        IF is_duplicate_in_file THEN
            v_category := 'DUPLICATE_IN_FILE';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;

        -- Basic Email Validation
        IF v_norm_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
            v_category := 'INVALID_EMAIL';
            v_is_blocking := true;
            result := result || pg_catalog.jsonb_build_object('row_number', v_row_num, 'category', v_category, 'is_blocking', v_is_blocking);
            CONTINUE;
        END IF;

        -- Suspicious Email flag
        IF v_norm_email ~ '@(gmail\.con|gmal\.com|yahoo\.cmo)$' THEN
            v_is_suspicious := true;
        END IF;

        -- Check DB
        SELECT * INTO db_row FROM public.participants WHERE pg_catalog.lower(pg_catalog.btrim(registered_email)) = v_norm_email;

        IF FOUND THEN
            IF db_row.auth_user_id IS NOT NULL THEN
                v_category := 'ALREADY_ACTIVE';
            ELSE
                IF db_row.name = v_name AND db_row.branch = v_branch THEN
                    v_category := 'UNCHANGED';
                ELSE
                    v_category := 'DETAILS_UPDATE';
                END IF;
            END IF;
        END IF;

        result := result || pg_catalog.jsonb_build_object(
            'row_number', v_row_num, 
            'category', v_category, 
            'is_blocking', v_is_blocking,
            'is_suspicious_email', v_is_suspicious,
            'csv_name', v_name,
            'db_name', db_row.name,
            'csv_branch', v_branch,
            'db_branch', db_row.branch
        );
    END LOOP;

    RETURN result;
END;
$$;

ALTER FUNCTION public.admin_preview_roster(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_preview_roster(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_preview_roster(jsonb) TO authenticated;

-- 3. Import Roster RPC
CREATE OR REPLACE FUNCTION public.admin_import_roster(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    row jsonb;
    v_name text;
    v_email text;
    v_branch text;
    v_norm_email text;
    v_imported int := 0;
    v_updated int := 0;
    v_skipped int := 0;
    db_row record;
    payload_emails text[] := '{}';
    is_duplicate_in_file boolean;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'array' THEN
        RAISE EXCEPTION 'Payload must be a JSON array';
    END IF;

    IF pg_catalog.jsonb_array_length(payload) < 1 OR pg_catalog.jsonb_array_length(payload) > 200 THEN
        RAISE EXCEPTION 'Payload must contain 1-200 rows';
    END IF;

    -- Collect all normalized emails to enforce payload duplicate rule
    FOR row IN SELECT * FROM pg_catalog.jsonb_array_elements(payload)
    LOOP
        IF pg_catalog.jsonb_typeof(row) <> 'object' THEN
            RAISE EXCEPTION 'Payload array elements must be objects';
        END IF;
        
        IF pg_catalog.jsonb_typeof(row->'row_number') <> 'number' THEN
            RAISE EXCEPTION 'Missing or invalid row_number';
        END IF;

        IF pg_catalog.jsonb_typeof(row->'name') <> 'string' OR
           pg_catalog.jsonb_typeof(row->'email') <> 'string' OR
           pg_catalog.jsonb_typeof(row->'branch') <> 'string' THEN
            RAISE EXCEPTION 'Missing required string fields';
        END IF;

        v_email := pg_catalog.btrim(row->>'email');
        v_name := pg_catalog.btrim(row->>'name');
        v_branch := pg_catalog.btrim(row->>'branch');

        IF v_name ~ '^[[:space:]]*$' OR v_email ~ '^[[:space:]]*$' OR v_branch ~ '^[[:space:]]*$' THEN
            RAISE EXCEPTION 'Missing required field';
        END IF;

        IF v_name ~ '[\x00-\x1F]' OR v_email ~ '[\x00-\x1F]' OR v_branch ~ '[\x00-\x1F]' THEN
            RAISE EXCEPTION 'Control characters not allowed';
        END IF;

        IF pg_catalog.length(v_name) > 100 OR pg_catalog.length(v_branch) > 50 OR pg_catalog.length(v_email) > 255 THEN
            RAISE EXCEPTION 'Field length limit exceeded';
        END IF;

        v_norm_email := pg_catalog.lower(v_email);

        IF v_norm_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
            RAISE EXCEPTION 'Invalid email format: %', v_norm_email;
        END IF;

        payload_emails := pg_catalog.array_append(payload_emails, v_norm_email);
    END LOOP;

    -- Duplicate check in payload
    FOR row IN SELECT * FROM pg_catalog.jsonb_array_elements(payload)
    LOOP
        v_email := pg_catalog.btrim(row->>'email');
        v_norm_email := pg_catalog.lower(v_email);
        SELECT count(*) > 1 INTO is_duplicate_in_file FROM pg_catalog.unnest(payload_emails) e WHERE e = v_norm_email;
        IF is_duplicate_in_file THEN
            RAISE EXCEPTION 'Duplicate email in payload: %', v_norm_email;
        END IF;
    END LOOP;

    -- Execute import
    FOR row IN SELECT * FROM pg_catalog.jsonb_array_elements(payload)
    LOOP
        v_name := pg_catalog.btrim(row->>'name');
        v_email := pg_catalog.btrim(row->>'email');
        v_branch := pg_catalog.btrim(row->>'branch');
        v_norm_email := pg_catalog.lower(v_email);

        SELECT * INTO db_row FROM public.participants WHERE pg_catalog.lower(pg_catalog.btrim(registered_email)) = v_norm_email FOR UPDATE;

        IF FOUND THEN
            IF db_row.auth_user_id IS NOT NULL THEN
                v_skipped := v_skipped + 1;
            ELSE
                IF db_row.name <> v_name OR (db_row.branch IS DISTINCT FROM v_branch) THEN
                    -- Only update if still unlinked (protection during race)
                    UPDATE public.participants SET name = v_name, branch = v_branch WHERE id = db_row.id AND auth_user_id IS NULL;
                    v_updated := v_updated + 1;
                ELSE
                    v_skipped := v_skipped + 1;
                END IF;
            END IF;
        ELSE
            -- Insert new participant
            INSERT INTO public.participants (participant_code, name, registered_email, branch)
            VALUES ('MEC-' || pg_catalog.to_char(pg_catalog.nextval('public.participant_code_seq'), 'FM000'), v_name, v_norm_email, v_branch);
            v_imported := v_imported + 1;
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object('success', true, 'imported', v_imported, 'updated', v_updated, 'skipped', v_skipped);
END;
$$;

ALTER FUNCTION public.admin_import_roster(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_import_roster(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_roster(jsonb) TO authenticated;
