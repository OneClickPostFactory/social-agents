# Controlled Threads relay

## Scope and authority

This path executes one explicitly approved owner Threads job through the existing
authenticated local Relay publisher. It does not enable general Threads or
Instagram publication, share the owner's account with other tenants, or replace
the normal product queue.

The hosted worker remains responsible for the tenant, original job, frozen queue
revision, account generation, approval hash and actual publication attempt. The
local relay owns provider authentication and compares the requested operation
with its independently configured target and approved text hash. Supabase
service credentials and the product's credential-decryption key remain in the
hosted worker; provider credentials remain local.

The exact target contains `jobId`, `userId`, `queueId`, `platform: "threads"`,
`accountId`, `generation`, `approvalHash` and `expiresAt`. New publishing authority
expires within 15 minutes. Both ends must receive the same target. A new expiry
does not clear the permanent dispatch fence for that job.

## Configuration

Use secret storage or a private service environment file. Never place values in
source control, command-line arguments, logs or public deployment descriptions.

| Runtime | Setting | Purpose |
| --- | --- | --- |
| Hosted and local | `CONTROLLED_PUBLISH` | Identical exact target JSON |
| Hosted and local | `THREADS_RELAY_TOKEN` | Dedicated random bearer, at least 32 characters |
| Hosted | `THREADS_RELAY_ENDPOINT` | Named HTTPS tunnel URL ending exactly in `/threads`; no query, credentials or fragment |
| Hosted | `CONTROLLED_PUBLISH_TOKEN` | Separate credential for the controlled `/tick` endpoint |
| Local | `OPENCLAW_GATEWAY_TOKEN` | Existing private gateway credential |
| Local | `THREADS_APPROVED_TEXT_SHA256` | SHA-256 of the exact approved UTF-8 draft |
| Local | `THREADS_RELAY_JOURNAL_DIR` | Canonical absolute persistent directory, permissions `0700` |
| Local | `THREADS_RELAY_PORT` | Optional loopback port; default `8789` |
| Local | `THREADS_RELAY_RECEIPTS_ONLY` | Set exactly `true` to restart with expired authority for recovery only |

The hosted controlled route also requires
`SUPABASE_WORKER_CANARY_REQUIRED=true`, the exact owner in
`CONNECTION_LIFECYCLE_CANARY_USER_IDS`,
`SUPABASE_WORKER_GENERATION_ENABLED=false`, and
`SUPABASE_PROVIDER_DISPATCH_ENABLED=false`. The temporary invocation overlay
permits only the specified operation. Ordinary traffic and Cron retain their
existing switches.

Run the local source entry point using the repository's supported Node version:

~~~sh
node --import tsx scripts/publish-controlled-threads.ts
~~~

The HTTP listener binds only to `127.0.0.1`. Route the named HTTPS tunnel to that
listener, never to the raw OpenClaw gateway. Do not expose the gateway port,
forward arbitrary gateway tools, or copy project-wide credentials to establish
connectivity. The route accepts only authenticated `POST /threads` requests.

The existing gateway must separately admit the intended account, campaign lane
and exact job opportunity under its live authorisation policy. The relay uses
the `oneclickpostfactory` runtime owner and lane. It does not renew unrelated
campaign grants or bypass quota, spacing or duplicate controls.

## Operation

1. Read the original queue item, job, connection generation and existing
   publication records. Preserve the original Publish now operation.
2. Verify local account identity and allocation, install the identical short
   target at both ends, and check the authenticated hosted readiness probe.
   Readiness performs account checks without creating a publication attempt.
3. Let the hosted worker claim and begin the existing operation through the
   normal database guards. Its sender receives the actual `attemptId` and
   `dispatchOperationId`; these are never fabricated by the relay.
4. The local relay rechecks account identity, then durably reserves the job
   before its single gateway publication invocation.
5. It validates the gateway activity against the session, account key, action,
   content fingerprint and idempotency key. It persists the observed external
   ID before independently inspecting the provider post.
6. Only exact post ID, approved text hash and author readback produce a
   confirmed receipt. The hosted worker validates the full scope and attempt
   identifiers before recording its normal publication outcome.

A gateway session includes the job, approval hash and actual attempt ID. The
gateway computes its own idempotency key; a top-level HTTP-envelope key is not
treated as proof of provider idempotency.

## Durable states and recovery

Journal records use permissions `0600`. File contents and directory entries are
synchronised before publication. Records contain operation metadata and hashes,
never gateway tokens, bearer secrets or full draft text.

| Journal state | Meaning | Permitted recovery |
| --- | --- | --- |
| No record | The relay has not reserved this job | An unexpired exact grant may authorise the first send |
| `reserved` | Dispatch may have started; its outcome is not yet established locally | Read the exact gateway activity session; require one matching verified success, then inspect that post |
| `accepted` | A validated external post ID is durably recorded | Recheck account identity and inspect that known post |
| `confirmed` | Exact provider readback succeeded | Return the same persisted receipt |

Recovery never invokes gateway publication. Missing, ambiguous, mismatched or
conflicting evidence leaves the operation fenced. A partial or corrupt record
also fails closed. Never delete a reservation, invent a replacement attempt or
requeue the original post merely because an HTTP response was lost.

The hosted sender automatically makes one receipt request after an ambiguous
publication response. Further explicit recovery uses the original recorded
target and actual attempt:

~~~ts
import { recoverThreadsRelayReceipt } from './src/threads-relay-client';

const externalPostId = await recoverThreadsRelayReceipt(
  originalTarget,
  relayEndpoint,
  relayBearer,
  recordedAttempt, // { attemptId, dispatchOperationId }
);
~~~

This helper skips readiness and never requests a send. It accepts an expired
publishing window because receipt recovery grants no new publishing authority.
Retain the original target, account binding and attempt values; do not change
them to make a failed check pass. Feed a recovered receipt through the existing
publication-ledger outcome/reconciliation path, preserving independent
verification and history uniqueness. Do not write an ad hoc published history
row or reset the job to pending.

The running local server continues to serve authenticated receipts after expiry.
For restart with an expired original target, use
`THREADS_RELAY_RECEIPTS_ONLY=true`; readiness and first publication remain
blocked. Keep the persistent journal and its canonical location across service
restarts and releases. Restoring an older journal or deleting it is not a valid
recovery procedure.

## Cancellation and release boundaries

The hosted queue revision, tenant and account-generation guards still apply
before dispatch. Cancellation or disconnection that wins that database boundary
must prevent a new provider operation. Once an authorised external request is
in flight, a later local cancellation cannot promise to undo it. Reconcile the
original attempt and external receipt; provider revocation or remote deletion
are separate actions.

The legacy general Threads and Instagram adapters remain disabled. A successful
controlled owner publication does not establish ordinary customer dispatch,
Instagram support, all-platform acceptance or paid-pilot readiness.

**Live acceptance remains pending until the original job has one externally
verified Threads post and the matching durable product receipt.** Record that
proof, exact source/deployment provenance and the remaining release gates in the
existing acceptance ledger.
