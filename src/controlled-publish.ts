export interface ControlledPublish {
  jobId: string;
  userId: string;
  queueId: string;
  approvalHash: string;
  accountId: string;
  generation: number;
  expiresAt: number;
}

export function parseControlledPublish(raw: string): ControlledPublish {
  const t = JSON.parse(raw);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!t || ![t.jobId, t.userId, t.queueId].every(v => typeof v === 'string' && uuid.test(v))
    || typeof t.approvalHash !== 'string' || !/^[a-f0-9]{64}$/.test(t.approvalHash) || typeof t.accountId !== 'string'
    || !/^[0-9]{1,32}$/.test(t.accountId) || !Number.isSafeInteger(t.generation) || t.generation < 1
    || !Number.isSafeInteger(t.expiresAt) || t.expiresAt <= Date.now() || t.expiresAt > Date.now() + 900_000) {
    throw Error('controlled_publish_invalid_or_expired');
  }
  return t;
}
