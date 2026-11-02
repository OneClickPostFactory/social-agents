export type RolloutControlledJobKind =
  | 'fetch_sources'
  | 'refresh_queue'
  | 'publish_now'
  | 'publish_all'
  | 'skip_slot'
  | 'release_slot';

export interface RolloutPolicy {
  canaryRequired: boolean;
  canaryUserIds: ReadonlySet<string>;
  generationEnabled: boolean;
  providerDispatchEnabled: boolean;
}

const GENERATION_JOB_KINDS = new Set<RolloutControlledJobKind>([
  'fetch_sources',
  'refresh_queue',
]);

const PUBLICATION_JOB_KINDS = new Set<RolloutControlledJobKind>([
  'publish_now',
  'publish_all',
]);

const OPERATOR_JOB_KINDS: RolloutControlledJobKind[] = [
  'skip_slot',
  'release_slot',
];

export function allowedCanaryUserIds(policy: RolloutPolicy): string[] | undefined {
  if (!policy.canaryRequired) return undefined;
  return [...policy.canaryUserIds]
    .map(userId => userId.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

export function canaryAllowsUser(policy: Pick<RolloutPolicy, 'canaryRequired' | 'canaryUserIds'>, userId: string): boolean {
  if (!policy.canaryRequired) return true;
  const normalized = userId.trim().toLowerCase();
  return [...policy.canaryUserIds].some(
    allowed => allowed.trim().toLowerCase() === normalized
  );
}

export function runnableJobKinds(policy: RolloutPolicy): RolloutControlledJobKind[] {
  return [
    ...(policy.generationEnabled ? [...GENERATION_JOB_KINDS] : []),
    ...(policy.providerDispatchEnabled ? [...PUBLICATION_JOB_KINDS] : []),
    ...OPERATOR_JOB_KINDS,
  ];
}

export function rolloutBlockCode(
  policy: RolloutPolicy,
  userId: string,
  kind: RolloutControlledJobKind
): string | undefined {
  if (!canaryAllowsUser(policy, userId)) return 'rollout_canary_tenant_blocked';
  if (GENERATION_JOB_KINDS.has(kind) && !policy.generationEnabled) {
    return 'rollout_generation_disabled';
  }
  if (PUBLICATION_JOB_KINDS.has(kind) && !policy.providerDispatchEnabled) {
    return 'rollout_provider_dispatch_disabled';
  }
  return undefined;
}
