CREATE TABLE public.participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    auth_user_id UUID UNIQUE
        REFERENCES auth.users(id),

    participant_code TEXT UNIQUE NOT NULL,

    name TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    registered_email TEXT
);

CREATE UNIQUE INDEX participants_registered_email_unique
ON public.participants (lower(trim(registered_email)));

ALTER TABLE public.participants
ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can read own profile"
ON public.participants
FOR SELECT
TO authenticated
USING (
    auth_user_id = (SELECT auth.uid())
);