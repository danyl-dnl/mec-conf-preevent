-- supabase/migrations/20260923170000_admin_list_participants.sql

-- Revoke all default execute permissions on the function to be safe
-- We'll do this after creation, but dropping first if exists ensures clean state
DROP FUNCTION IF EXISTS public.admin_list_participants();

CREATE OR REPLACE FUNCTION public.admin_list_participants()
RETURNS TABLE (
    participant_code text,
    name text,
    branch text,
    registered_email text,
    is_linked boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Authorize using the existing is_admin helper
    IF public.is_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    RETURN QUERY
    SELECT 
        p.participant_code,
        p.name,
        p.branch,
        p.registered_email,
        (p.auth_user_id IS NOT NULL) AS is_linked
    FROM public.participants p
    ORDER BY p.participant_code ASC;
END;
$$;

-- Secure the function permissions
ALTER FUNCTION public.admin_list_participants() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_list_participants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_participants() FROM anon;

GRANT EXECUTE ON FUNCTION public.admin_list_participants() TO authenticated;
-- service_role gets execute by default as postgres owner/superuser, but we can explicitly grant if needed.
