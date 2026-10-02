// Shared deterministic contract. Kept byte-identical in the canonical publisher
// as src/connection-lifecycle.ts; paired CI verifies the source hash.
export const CONNECTION_PROVIDERS = ["openai", "x", "threads", "linkedin", "instagram"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type ConnectionGuard = {
  provider: ConnectionProvider;
  generation: number;
  revision: number;
  state: "stored_not_verified" | "verified" | "disconnected" | "connecting" | "needs_reconnect";
  account_id: string | null;
  verified_at: string | null;
};
export type ConnectionSnapshot = {
  schema: "ocpf.connection-snapshot.v1";
  user_id: string;
  credentials: Record<string, unknown>;
  connections: ConnectionGuard[];
};
export type ConnectionRpc = (
  name: string,
  params: Record<string, unknown>,
  retrySafe: boolean,
) => Promise<unknown>;
export type ConnectionMutationKind =
  | "replace"
  | "disconnect"
  | "refresh"
  | "verify"
  | "failure"
  | "callback";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const account = /^[A-Za-z0-9:_-]{1,256}$/;
export const CREDENTIAL_FIELDS = [
  "openai_api_key",
  "threads_token",
  "instagram_token",
  "instagram_account_id",
  "facebook_page_id",
  "facebook_page_access_token",
  "linkedin_token",
  "linkedin_person_urn",
  "linkedin_refresh_token",
  "linkedin_client_id",
  "linkedin_client_secret",
  "meta_access_token",
  "x_client_id",
  "x_client_secret",
  "x_oauth2_access_token",
  "x_oauth2_refresh_token",
] as const;
export function connectionProvider(field: string): ConnectionProvider {
  if (!(CREDENTIAL_FIELDS as readonly string[]).includes(field))
    throw Error("connection_field_invalid");
  if (field.startsWith("x_")) return "x";
  if (field.startsWith("linkedin_")) return "linkedin";
  if (field === "threads_token") return "threads";
  if (field === "openai_api_key") return "openai";
  return "instagram";
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("connection_response_invalid");
  return value as Record<string, unknown>;
}
function counter(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value < Number.MAX_SAFE_INTEGER
  );
}
export function parseConnectionGuard(value: unknown): ConnectionGuard {
  const r = record(value);
  if (
    !CONNECTION_PROVIDERS.includes(r.provider as ConnectionProvider) ||
    !counter(r.generation, 1) ||
    !counter(r.revision, 0) ||
    !["stored_not_verified", "verified", "disconnected", "connecting", "needs_reconnect"].includes(
      String(r.state),
    ) ||
    !(r.account_id === null || (typeof r.account_id === "string" && account.test(r.account_id))) ||
    !(
      r.verified_at === null ||
      (typeof r.verified_at === "string" && Number.isFinite(Date.parse(r.verified_at)))
    ) ||
    (r.state === "verified" && (!r.account_id || !r.verified_at))
  )
    throw Error("connection_response_invalid");
  // Only fixed safe fields ever reach a browser; reject unknown data rather than
  // spreading an arbitrary provider/database response into status objects.
  return {
    provider: r.provider as ConnectionProvider,
    generation: r.generation,
    revision: r.revision,
    state: r.state as ConnectionGuard["state"],
    account_id: r.account_id as string | null,
    verified_at: r.verified_at as string | null,
  };
}
export async function captureConnections(
  rpc: ConnectionRpc,
  userId: string,
): Promise<ConnectionSnapshot> {
  if (!uuid.test(userId)) throw Error("connection_identity_required");
  const raw = record(await rpc("capture_connection_snapshot", { p_user_id: userId }, true));
  if (
    raw.schema !== "ocpf.connection-snapshot.v1" ||
    raw.user_id !== userId ||
    !Array.isArray(raw.connections) ||
    raw.connections.length !== CONNECTION_PROVIDERS.length
  )
    throw Error("connection_snapshot_invalid");
  const credentials = record(raw.credentials);
  if (credentials.user_id !== userId) throw Error("connection_snapshot_invalid");
  const connections = raw.connections.map(parseConnectionGuard);
  if (new Set(connections.map((c) => c.provider)).size !== CONNECTION_PROVIDERS.length)
    throw Error("connection_snapshot_invalid");
  return { schema: "ocpf.connection-snapshot.v1", user_id: userId, credentials, connections };
}
export async function mutateConnection(
  rpc: ConnectionRpc,
  userId: string,
  guard: ConnectionGuard,
  operationId: string,
  kind: ConnectionMutationKind,
  patch: Record<string, unknown>,
  accountId: string | null = null,
): Promise<ConnectionGuard> {
  parseConnectionGuard(guard);
  if (!uuid.test(userId) || !uuid.test(operationId)) throw Error("connection_identity_required");
  const expectedGeneration = guard.generation + (["replace", "disconnect"].includes(kind) ? 1 : 0);
  const value = record(
    await rpc(
      "mutate_connection",
      {
        p_user_id: userId,
        p_provider: guard.provider,
        p_generation: guard.generation,
        p_revision: guard.revision,
        p_operation_id: operationId,
        p_kind: kind,
        p_patch: patch,
        p_account_id: accountId,
      },
      true,
    ),
  );
  const next = parseConnectionGuard(value.connection);
  if (
    value.schema !== "ocpf.connection-mutation.v1" ||
    value.user_id !== userId ||
    value.operation_id !== operationId ||
    next.provider !== guard.provider ||
    next.generation !== expectedGeneration ||
    next.revision !== guard.revision + 1 ||
    (kind === "disconnect" && next.state !== "disconnected") ||
    (["callback", "verify"].includes(kind) &&
      (next.state !== "verified" || next.account_id !== accountId)) ||
    (kind === "refresh" &&
      (next.state !== "stored_not_verified" || next.account_id !== guard.account_id)) ||
    (kind === "replace" && (next.state !== "stored_not_verified" || next.account_id !== null)) ||
    (kind === "failure" && next.state !== "needs_reconnect")
  )
    throw Error("connection_mutation_unverified");
  return next;
}
export class ConnectionSession {
  private readonly guards = new Map<ConnectionProvider, ConnectionGuard>();
  private busy = new Set<ConnectionProvider>();
  private readonly rpc: ConnectionRpc;
  readonly snapshot: ConnectionSnapshot;
  constructor(rpc: ConnectionRpc, snapshot: ConnectionSnapshot) {
    this.rpc = rpc;
    this.snapshot = snapshot;
    for (const c of snapshot.connections) this.guards.set(c.provider, Object.freeze({ ...c }));
  }
  guard(provider: ConnectionProvider): ConnectionGuard {
    const result = this.guards.get(provider);
    if (!result) throw Error("connection_snapshot_invalid");
    return result;
  }
  async apply(
    provider: ConnectionProvider,
    kind: "refresh" | "verify" | "failure",
    patch: Record<string, unknown>,
    accountId: string | null = null,
  ): Promise<ConnectionGuard> {
    if (this.busy.has(provider)) throw Error("connection_local_mutation_in_progress");
    this.busy.add(provider);
    try {
      const next = await mutateConnection(
        this.rpc,
        this.snapshot.user_id,
        this.guard(provider),
        crypto.randomUUID(),
        kind,
        patch,
        accountId,
      );
      this.guards.set(provider, Object.freeze(next));
      return next;
    } finally {
      this.busy.delete(provider);
    }
  }
  assertAvailable(provider: ConnectionProvider): ConnectionGuard {
    const guard = this.guard(provider);
    if (["disconnected", "connecting"].includes(guard.state))
      throw Error("connection_not_available");
    return guard;
  }
}
