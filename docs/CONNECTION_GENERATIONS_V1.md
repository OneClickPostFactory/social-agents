# M3.4: paired connection ownership, default off

This publisher is paired with the app/schema repository's new additive
`connection-generations-v1` contract, migration `20261001154000`.
`CONNECTION_LIFECYCLE_ENABLED` must be exactly `true`; default is false. Do not
activate one consumer before the other consumer and schema are accepted.

The trusted runtime loads encrypted credentials and provider generation/revision
in one atomic database snapshot. Each tenant execution owns an AsyncLocalStorage
session; callbacks never consult another tenant's mutable connection guard. Refresh
and verification writes compare the captured owner, generation and credential
revision and the database's ciphertext fingerprint. A lost reply can replay only
the identical operation/ciphertext, not construct a different refresh intent.
Replacing or disconnecting advances the owner generation; a late callback or
refresh cannot restore that session. Raw service-role writes to adopted credential
groups are refused. Administrative break-glass changes are detected by fingerprint
comparison and require new verification; this is not a claim of defeating DB owners.

The existing X callback is implemented in the web repository with PKCE, one-use
state and generation-bound commit. LinkedIn read verification uses its supported
userinfo endpoint and checks the saved member URN. This proves an account identifier,
not a person's real-world identity or publishing permission. Required provider
scopes and actual owner account acceptance remain release gates.

Queue destination bindings cover the saved draft/schedule hash, provider account
and generation. Unbound new work fails before creating an intent; the owner can
verify and review the destination in the app. The database also rechecks the
binding at begin-dispatch, preventing a disconnect that wins that boundary from
being ignored. Already-dispatched/unknown attempts retain their exact receipts
and cannot be reassigned or blindly resent. An external request already authorised
and in flight cannot be withdrawn by a later local disconnect; provider revocation
and remote deletion are separate operations, not promises made by this change.

The pure `connection-lifecycle.ts` and `connection-http.ts` files are copied from
the app's shared contract and compared byte-for-byte in private paired CI. No
private app source or production data is copied to this public repository.
Native paired tests use explicit synthetic accounts, actual PostgreSQL and
intercepted external transport, never paid model requests or live posts.

Existing retired Threads/Instagram publishers remain disabled, Facebook remains
paused, and generation/publishing switches are not changed. Managed OpenAI
credentials do not fall back to a global key after the owner clears their key.
The later M4 budget/content and M5 provider acceptance work are separate.

Sources checked 1 October 2026:
- OAuth security: https://www.rfc-editor.org/rfc/rfc9700.html
- PostgreSQL row locking: https://www.postgresql.org/docs/17/explicit-locking.html
- X PKCE and refresh permissions: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- LinkedIn account endpoint/scopes: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
