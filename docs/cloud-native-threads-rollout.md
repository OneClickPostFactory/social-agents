# Cloud-native Threads controlled publishing

This change is **disabled by default**. It does not authorise general provider dispatch, alter production credentials or publish content by itself.

## Existing mechanism

The verified owner job used a Cloudflare controlled tick with a local authenticated Threads relay. The worker has tenant-encrypted credentials (`user_credentials.threads_token_enc`) and scoped token persistence, but its controlled Threads send previously required the relay endpoint.

## New gated mechanism

For an exact approved controlled job, `THREADS_CLOUD_NATIVE_ENABLED=true` selects direct Threads Graph API transport. The worker still requires the existing canary tenant, generation-disabled and provider-dispatch-disabled base settings, an exact controlled target, the durable publication attempt and account verification. It uses the decrypted tenant token only inside the tenant runtime. Expired credentials are renewed through existing scoped token persistence, which encrypts the rotated token in the tenant credential row. It verifies the account, creates a text container, publishes and independently reads back the returned post ID. Errors after the publish request remain uncertain; the publication ledger must reconcile rather than automatically resend.

## Release gates

1. Confirm the exact tenant's existing encrypted Threads token is present, decryptable and represents the intended Threads account. Do not copy a local plaintext token into Git, logs or Worker vars.
2. Verify tenant token refresh and rotation in a non-publishing controlled check, including token expiry and account mismatch. Confirm the encrypted row updates under the correct tenant.
3. Complete concurrent-admission and crash/restart tests against the durable publication ledger, including an accepted provider publish with lost response. The direct API does not provide a provider-side idempotency key, so uncertain outcomes must never be blindly replayed.
4. Test a single newly approved job, with explicit owner approval, against the real Threads API. Read back the provider ID and compare the exact ledger intent/attempt/history; do not reuse the completed historical post.
5. Promote the verified worker only after independent CI and production readiness. Leave general generation and dispatch disabled. Retire the local relay only after a cloud-native live proof and restart recovery.

The source-revision migration is separate and must not be pulled into this release accidentally.
