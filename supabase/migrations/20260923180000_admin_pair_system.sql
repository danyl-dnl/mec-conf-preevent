-- Migration: 20260923180000_admin_pair_system.sql

CREATE TABLE public.pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.pair_members (
    pair_id UUID NOT NULL REFERENCES public.pairs(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES public.participants(id) ON DELETE RESTRICT,
    fragment_slot TEXT NOT NULL CHECK (fragment_slot IN ('A', 'B')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    PRIMARY KEY (pair_id, participant_id),
    UNIQUE (participant_id),
    UNIQUE (pair_id, fragment_slot)
);

CREATE SEQUENCE public.pair_code_seq;

ALTER TABLE public.pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pair_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pairs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pair_members FROM PUBLIC, anon, authenticated;

-- admin_create_pair
CREATE OR REPLACE FUNCTION public.admin_create_pair(
    participant_code_a text,
    participant_code_b text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_code_a text;
    v_code_b text;
    v_part_a_id uuid;
    v_part_b_id uuid;
    v_new_pair_id uuid;
    v_pair_code text;
    v_result jsonb;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    v_code_a := btrim(participant_code_a);
    v_code_b := btrim(participant_code_b);

    IF v_code_a = '' OR v_code_b = '' THEN
        RAISE EXCEPTION 'Participant codes cannot be empty';
    END IF;

    IF v_code_a = v_code_b THEN
        RAISE EXCEPTION 'Cannot pair a participant with themselves';
    END IF;

    SELECT id INTO v_part_a_id FROM public.participants WHERE participant_code = v_code_a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown participant code: %', v_code_a;
    END IF;

    SELECT id INTO v_part_b_id FROM public.participants WHERE participant_code = v_code_b;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown participant code: %', v_code_b;
    END IF;

    v_pair_code := 'PAIR-' || to_char(nextval('public.pair_code_seq'), 'FM000');

    INSERT INTO public.pairs (pair_code) VALUES (v_pair_code) RETURNING id INTO v_new_pair_id;

    BEGIN
        INSERT INTO public.pair_members (pair_id, participant_id, fragment_slot) 
        VALUES 
            (v_new_pair_id, v_part_a_id, 'A'),
            (v_new_pair_id, v_part_b_id, 'B');
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'One or both participants are already paired';
    END;

    SELECT jsonb_build_object(
        'success', true,
        'pair_code', v_pair_code,
        'member_a', (SELECT jsonb_build_object('participant_code', participant_code, 'name', name, 'branch', branch) FROM public.participants WHERE id = v_part_a_id),
        'member_b', (SELECT jsonb_build_object('participant_code', participant_code, 'name', name, 'branch', branch) FROM public.participants WHERE id = v_part_b_id)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_pair(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_pair(text, text) TO authenticated;

-- admin_list_pairs
CREATE OR REPLACE FUNCTION public.admin_list_pairs()
RETURNS TABLE (
    pair_code text,
    member_a_code text,
    member_a_name text,
    member_a_branch text,
    member_b_code text,
    member_b_name text,
    member_b_branch text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT 
        p.pair_code,
        pa.participant_code AS member_a_code,
        pa.name AS member_a_name,
        pa.branch AS member_a_branch,
        pb.participant_code AS member_b_code,
        pb.name AS member_b_name,
        pb.branch AS member_b_branch
    FROM public.pairs p
    JOIN public.pair_members pma ON pma.pair_id = p.id AND pma.fragment_slot = 'A'
    JOIN public.participants pa ON pa.id = pma.participant_id
    JOIN public.pair_members pmb ON pmb.pair_id = p.id AND pmb.fragment_slot = 'B'
    JOIN public.participants pb ON pb.id = pmb.participant_id
    WHERE public.is_admin()
    ORDER BY p.pair_code ASC;
$$;

REVOKE ALL ON FUNCTION public.admin_list_pairs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_pairs() TO authenticated;

-- admin_list_unpaired_participants
CREATE OR REPLACE FUNCTION public.admin_list_unpaired_participants()
RETURNS TABLE (
    participant_code text,
    name text,
    branch text,
    registered_email text,
    is_linked boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT 
        p.participant_code,
        p.name,
        p.branch,
        p.registered_email,
        (p.auth_user_id IS NOT NULL) AS is_linked
    FROM public.participants p
    LEFT JOIN public.pair_members pm ON pm.participant_id = p.id
    WHERE public.is_admin() AND pm.pair_id IS NULL
    ORDER BY p.participant_code ASC;
$$;

REVOKE ALL ON FUNCTION public.admin_list_unpaired_participants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_unpaired_participants() TO authenticated;
