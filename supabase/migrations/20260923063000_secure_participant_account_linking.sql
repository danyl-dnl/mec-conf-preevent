-- Only approved roster rows may be linked. Never replay the initial baseline.
-- The migration runner executes this file and its history record atomically.

DO $preflight$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.participants
        WHERE registered_email IS NULL
           OR registered_email ~ '^[[:space:]]*$'
    ) THEN
        RAISE EXCEPTION 'Participant roster contains missing or blank registered_email values';
    END IF;
END;
$preflight$;

ALTER TABLE public.participants
    ALTER COLUMN registered_email SET NOT NULL,
    ADD CONSTRAINT participants_registered_email_nonblank
        CHECK (registered_email !~ '^[[:space:]]*$');

CREATE FUNCTION public.link_current_participant()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    caller_id uuid := auth.uid();
    confirmed_email text;
    google_email text;
    google_count bigint;
    google_verified boolean;
    participant_id uuid;
    linked_user_id uuid;
BEGIN
    IF caller_id IS NULL THEN
        RETURN 'LINKING_DENIED';
    END IF;

    SELECT pg_catalog.lower(pg_catalog.btrim(u.email))
    INTO confirmed_email
    FROM auth.users AS u
    WHERE u.id = caller_id
      AND u.is_anonymous IS FALSE
      AND u.email_confirmed_at IS NOT NULL;

    IF confirmed_email IS NULL OR confirmed_email ~ '^[[:space:]]*$' THEN
        RETURN 'LINKING_DENIED';
    END IF;

    -- Provider identity data is managed by Auth; user metadata is not trusted.
    -- Count all Google identities, including unverified ones: ambiguity denies.
    SELECT pg_catalog.count(*),
           pg_catalog.max(pg_catalog.lower(pg_catalog.btrim(i.identity_data ->> 'email'))),
           pg_catalog.bool_and(
               pg_catalog.jsonb_typeof(i.identity_data -> 'email') = 'string'
               AND (i.identity_data -> 'email_verified') = 'true'::jsonb
           )
    INTO google_count, google_email, google_verified
    FROM auth.identities AS i
    WHERE i.user_id = caller_id AND i.provider = 'google';

    IF google_count <> 1
       OR google_verified IS DISTINCT FROM TRUE
       OR google_email IS NULL
       OR google_email IS DISTINCT FROM confirmed_email THEN
        RETURN 'LINKING_DENIED';
    END IF;

    -- Serialize claims on the same roster row. The UNIQUE auth_user_id
    -- constraint also prevents races that would link one user to two rows.
    SELECT p.id, p.auth_user_id
    INTO participant_id, linked_user_id
    FROM public.participants AS p
    WHERE pg_catalog.lower(pg_catalog.btrim(p.registered_email)) = google_email
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'NOT_REGISTERED';
    END IF;

    IF linked_user_id = caller_id THEN
        RETURN 'ALREADY_LINKED';
    END IF;

    IF linked_user_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.participants AS p WHERE p.auth_user_id = caller_id
    ) THEN
        RETURN 'LINKING_DENIED';
    END IF;

    BEGIN
        UPDATE public.participants
        SET auth_user_id = caller_id
        WHERE id = participant_id AND auth_user_id IS NULL;
    EXCEPTION WHEN unique_violation THEN
        -- This block rolls back its update; never expose constraint/row details.
        RETURN 'LINKING_DENIED';
    END;

    RETURN 'LINKED';
END;
$function$;

-- Pin privileged ownership, not a browser-accessible role.
ALTER FUNCTION public.link_current_participant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_current_participant()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_current_participant() TO authenticated;

-- RLS remains the existing own-profile SELECT policy; no UPDATE policy.
REVOKE ALL ON TABLE public.participants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.participants TO authenticated;
