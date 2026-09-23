-- Admin authorization foundation.
-- Creates: public.admins table, public.is_admin() helper,
--          public.check_admin_status() front-end RPC.
--
-- No admin rows are inserted here.
-- Bootstrap: INSERT into public.admins via Supabase Dashboard SQL editor
--            after this migration is applied, using the admin's auth.uid().

-- ---------------------------------------------------------------------------
-- 1. admins table
-- ---------------------------------------------------------------------------

CREATE TABLE public.admins (
    auth_user_id UUID PRIMARY KEY
                 REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — lock down all direct API access
-- ---------------------------------------------------------------------------

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

-- No RLS policies are created for anon or authenticated.
-- Direct table access is completely forbidden via REVOKE below.
-- The only path in is through SECURITY DEFINER functions (postgres role).

REVOKE ALL ON TABLE public.admins FROM PUBLIC, anon, authenticated;

-- service_role (BYPASSRLS) retains full access for Dashboard/server operations.

-- ---------------------------------------------------------------------------
-- 3. is_admin() — internal helper, NOT directly callable by clients
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM   public.admins
        WHERE  auth_user_id = auth.uid()
    );
$$;

-- Pin ownership to postgres so no user role can replace or alter this function.
ALTER FUNCTION public.is_admin() OWNER TO postgres;

-- Revoke EXECUTE from everyone including PUBLIC (which covers authenticated/anon).
-- SECURITY DEFINER functions owned by postgres can still call is_admin() internally
-- because they execute with the definer's (postgres) privileges, not the caller's.
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. check_admin_status() — the only client-callable admin check
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.check_admin_status()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Unauthenticated callers have no session; auth.uid() returns NULL.
    -- We rely on the GRANT below preventing anon from calling this at all,
    -- but we also guard explicitly to be safe.
    IF auth.uid() IS NULL THEN
        RETURN 'NOT_ADMIN';
    END IF;

    IF public.is_admin() THEN
        RETURN 'IS_ADMIN';
    END IF;

    RETURN 'NOT_ADMIN';
END;
$$;

ALTER FUNCTION public.check_admin_status() OWNER TO postgres;

-- anon and PUBLIC must NOT execute this function.
REVOKE ALL ON FUNCTION public.check_admin_status() FROM PUBLIC, anon, authenticated;

-- Re-grant only to authenticated.
GRANT EXECUTE ON FUNCTION public.check_admin_status() TO authenticated;
