# Secret management

## Where secrets live

- In `.env` (gitignored), read **server-side only**. Never commit `.env`.
- `ANTHROPIC_API_KEY` is constructed into the Anthropic client lazily inside
  `src/lib/ai/claude.ts` and nowhere else.

## Rules

- **Never prefix a secret with `NEXT_PUBLIC_`.** Only `NEXT_PUBLIC_`-prefixed vars
  reach the browser bundle. The only public var here is `NEXT_PUBLIC_APP_URL`.
- **Never log secrets** or full prompts/outputs that could contain them.
- **Never pass secrets into the sandbox** — it runs untrusted code with no network;
  generated code must never receive the API key or env.
- **Never hardcode** a key, token, or password in source or tests. Session signing
  uses a server secret via Node crypto (`session.ts`); keep it out of the client
  and out of logs.
- Rotate a leaked key immediately and purge it from history.

## Checking exposure

```bash
# nothing secret should be NEXT_PUBLIC_ except the app URL:
grep -rn "NEXT_PUBLIC_" src | grep -vi "APP_URL"
# no literal keys committed:
grep -rn "sk-ant" src .env.example 2>/dev/null   # should be empty
```

## Session & password secrets

- Passwords: scrypt hashes in `salt:hash` form (`src/lib/auth/password.ts`) — never
  plaintext.
- Sessions: HMAC-signed httpOnly cookies (`session.ts`), with an edge-compatible
  verify twin (`edge.ts`) for middleware. The signing key is a server secret.

## Production

Use the platform's secret store (env vars injected at runtime), not a committed
file. See [../operations/environment-variables.md](../operations/environment-variables.md)
and [../operations/deployment.md](../operations/deployment.md).
