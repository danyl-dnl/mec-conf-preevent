# Pair photo upload setup

The `upload-pair-photo` Supabase Edge Function authenticates the bearer token with
Supabase Auth, then uses service-only database RPCs to reserve and finalize the
pair's photo. The browser sends one `photo` file and no identity arguments.

## Required organizer configuration

Cloudinary secrets were not configured during implementation. Create a private
file **outside the repository**, at `$HOME/.config/mec-conf/cloudinary.env`, with
these three environment variable names and your actual Cloudinary values:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Use `NAME=value` format, one variable per line. Do not use `VITE_` variables or
paste credentials into React, source control, browser consoles, or chat.

```sh
mkdir -p "$HOME/.config/mec-conf"
(umask 077; touch "$HOME/.config/mec-conf/cloudinary.env")
chmod 600 "$HOME/.config/mec-conf/cloudinary.env"
${EDITOR:-nano} "$HOME/.config/mec-conf/cloudinary.env"
npx supabase secrets set --project-ref qztxlwakdrvisaqawqzb --env-file "$HOME/.config/mec-conf/cloudinary.env"
```

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` to deployed functions automatically. Never copy the
service-role key into the frontend. Updating secrets does not require a function
redeploy. To redeploy code when needed:

```sh
npx supabase functions deploy upload-pair-photo --project-ref qztxlwakdrvisaqawqzb --use-api
```

`verify_jwt = false` in `supabase/config.toml` is intentional: the handler verifies
the token online using `/auth/v1/user` before any reservation or upload. This also
supports asymmetric Supabase user JWTs.

## Final live check after configuration

Using an authorized pair with mutual verification and a solved puzzle, upload a
real partner photo under 5 MB. Confirm that both accounts show `LEVEL 1 COMPLETE`
after refresh and that the admin table shows Uploaded / Complete. No production
participants, pairs, or puzzles were created or modified for implementation tests.
A real Cloudinary upload has not been tested while credentials are missing.

## Retry and concurrency behavior

Only service-role calls can reserve/finalize/release uploads. Reservations expire
after five minutes. A fixed per-pair Cloudinary public ID and signed
`overwrite=false` prevent concurrent or uncertain retries from creating a second
asset. If Cloudinary accepted a photo but database finalization failed, a retry
reuses the existing asset rather than replacing it. The first accepted photo wins.
A timeout may require waiting five minutes before retrying. There is no replacement
or photo deletion UI in this MVP.

Requests are bounded to 5 MB plus multipart overhead. MIME and file signatures are
checked; Cloudinary's image decoder validates and converts supported images to JPEG.
Completion is committed only after a successful upload response and a fresh check
of solved/mutually verified pair state. An organizer reset never clears solved or
completed state.

References: [Supabase secrets](https://supabase.com/docs/guides/functions/secrets),
[Cloudinary upload API](https://cloudinary.com/documentation/image_upload_api_reference),
[Cloudinary signatures](https://cloudinary.com/documentation/authentication_signatures).
