export type CanonicalMetaPlatform = 'threads' | 'instagram';

export class LegacyMetaPublicationDisabledError extends Error {
  readonly code = 'legacy_meta_publication_disabled';
  readonly platform: CanonicalMetaPlatform;
  readonly canonicalWorker: string;

  constructor(platform: CanonicalMetaPlatform) {
    const canonicalWorker = platform === 'threads'
      ? '/home/oneclickwebsitedesignfactory/.openclaw/workspace/scripts/threads-outbox-runner.mjs'
      : '/home/oneclickwebsitedesignfactory/.openclaw/workspace/scripts/instagram-publisher-outbox-runner.mjs';
    super(
      `${platform} publication is disabled in the retired social-agent runtime; queue an approved payload for ${canonicalWorker}`,
    );
    this.name = 'LegacyMetaPublicationDisabledError';
    this.platform = platform;
    this.canonicalWorker = canonicalWorker;
  }
}

export function assertCanonicalMetaPublicationPath(
  platform: CanonicalMetaPlatform,
): never {
  throw new LegacyMetaPublicationDisabledError(platform);
}
