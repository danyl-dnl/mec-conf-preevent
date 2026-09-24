-- Migration: Admin Team Management (Add / List / Remove Admins)
BEGIN;

-- 1. Create public.admin_whitelist table
CREATE TABLE IF NOT EXISTS public.admin_whitelist (
    email TEXT PRIMARY KEY,
    added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_whitelist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_whitelist FROM PUBLIC, anon, authenticated;

-- Seed existing admins into whitelist
INSERT INTO public.admin_whitelist (email, added_by, created_at)
SELECT lower(u.email), a.auth_user_id, a.created_at
FROM public.admins a
JOIN auth.users u ON a.auth_user_id = u.id
WHERE u.email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- 2. Update is_admin() to check both public.admins and admin_whitelist
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admins
        WHERE auth_user_id = auth.uid()
    ) OR EXISTS (
        SELECT 1
        FROM auth.users u
        JOIN public.admin_whitelist w ON lower(w.email) = lower(u.email)
        WHERE u.id = auth.uid()
    );
$$;
ALTER FUNCTION public.is_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;

-- 3. Update check_admin_status() to auto-promote whitelisted users upon login
CREATE OR REPLACE FUNCTION public.check_admin_status()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    user_email text;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN 'NOT_ADMIN';
    END IF;

    -- If user is in admin_whitelist, ensure their auth_user_id is in public.admins
    SELECT email INTO user_email FROM auth.users WHERE id = auth.uid();
    IF user_email IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.admin_whitelist WHERE lower(email) = lower(user_email)
    ) THEN
        INSERT INTO public.admins (auth_user_id) VALUES (auth.uid())
        ON CONFLICT (auth_user_id) DO NOTHING;
        RETURN 'IS_ADMIN';
    END IF;

    IF public.is_admin() THEN
        RETURN 'IS_ADMIN';
    END IF;

    RETURN 'NOT_ADMIN';
END;
$$;
ALTER FUNCTION public.check_admin_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_admin_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_admin_status() TO authenticated;

-- 4. admin_list_admins()
CREATE OR REPLACE FUNCTION public.admin_list_admins()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    result jsonb;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO result
    FROM (
        WITH all_admin_emails AS (
            SELECT lower(email) AS email, created_at FROM public.admin_whitelist
            UNION
            SELECT lower(u.email) AS email, a.created_at
            FROM public.admins a
            JOIN auth.users u ON a.auth_user_id = u.id
            WHERE u.email IS NOT NULL
        )
        SELECT
            e.email,
            e.created_at,
            CASE
                WHEN a.auth_user_id IS NOT NULL THEN 'ACTIVE'
                ELSE 'PENDING_LOGIN'
            END AS status,
            (u.id IS NOT NULL AND u.id = auth.uid()) AS is_current_user,
            u.last_sign_in_at
        FROM all_admin_emails e
        LEFT JOIN auth.users u ON lower(u.email) = e.email
        LEFT JOIN public.admins a ON a.auth_user_id = u.id
        ORDER BY e.created_at ASC
    ) t;

    RETURN result;
END;
$$;
ALTER FUNCTION public.admin_list_admins() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_list_admins() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_admins() TO authenticated;

-- 5. admin_add_admin(target_email text)
CREATE OR REPLACE FUNCTION public.admin_add_admin(target_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    normalized_email text;
    found_user_id uuid;
    admin_status text;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    normalized_email := lower(trim(target_email));

    IF normalized_email IS NULL OR normalized_email = '' THEN
        RAISE EXCEPTION 'Email cannot be empty';
    END IF;

    IF normalized_email NOT LIKE '%_@__%.__%' THEN
        RAISE EXCEPTION 'Invalid email address format';
    END IF;

    -- Add to whitelist
    INSERT INTO public.admin_whitelist (email, added_by, created_at)
    VALUES (normalized_email, auth.uid(), now())
    ON CONFLICT (email) DO NOTHING;

    -- Check if user already exists in auth.users
    SELECT id INTO found_user_id FROM auth.users WHERE lower(email) = normalized_email LIMIT 1;
    IF found_user_id IS NOT NULL THEN
        INSERT INTO public.admins (auth_user_id)
        VALUES (found_user_id)
        ON CONFLICT (auth_user_id) DO NOTHING;
        admin_status := 'ACTIVE';
    ELSE
        admin_status := 'PENDING_LOGIN';
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'email', normalized_email,
        'status', admin_status
    );
END;
$$;
ALTER FUNCTION public.admin_add_admin(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_add_admin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_admin(text) TO authenticated;

-- 6. admin_remove_admin(target_email text)
CREATE OR REPLACE FUNCTION public.admin_remove_admin(target_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    normalized_email text;
    target_user_id uuid;
    caller_email text;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    normalized_email := lower(trim(target_email));

    SELECT email INTO caller_email FROM auth.users WHERE id = auth.uid();
    IF lower(caller_email) = normalized_email THEN
        RAISE EXCEPTION 'You cannot remove your own admin access';
    END IF;

    DELETE FROM public.admin_whitelist WHERE lower(email) = normalized_email;

    SELECT id INTO target_user_id FROM auth.users WHERE lower(email) = normalized_email LIMIT 1;
    IF target_user_id IS NOT NULL THEN
        DELETE FROM public.admins WHERE auth_user_id = target_user_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'email', normalized_email);
END;
$$;
ALTER FUNCTION public.admin_remove_admin(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_remove_admin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_admin(text) TO authenticated;

COMMIT;
