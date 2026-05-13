export type PublishPlatform = 'threads' | 'instagram' | 'linkedin' | 'x' | 'facebook';

export interface PlatformPublishErrorOptions {
  platform: PublishPlatform;
  stage: string;
  code: string;
  userMessage: string;
  nextAction: string;
  authMode?: string;
  status?: number;
  contentType?: string | null;
  providerCode?: string | number | null;
  bodySnippet?: string | null;
}

export class PlatformPublishError extends Error {
  readonly platform: PublishPlatform;
  readonly stage: string;
  readonly code: string;
  readonly userMessage: string;
  readonly nextAction: string;
  readonly authMode?: string;
  readonly status?: number;
  readonly contentType?: string | null;
  readonly providerCode?: string | number | null;
  readonly bodySnippet?: string | null;

  constructor(options: PlatformPublishErrorOptions) {
    super(options.userMessage);
    this.name = 'PlatformPublishError';
    this.platform = options.platform;
    this.stage = options.stage;
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.nextAction = options.nextAction;
    this.authMode = options.authMode;
    this.status = options.status;
    this.contentType = options.contentType;
    this.providerCode = options.providerCode;
    this.bodySnippet = options.bodySnippet;
  }
}

export function isPlatformPublishError(value: unknown): value is PlatformPublishError {
  return value instanceof PlatformPublishError;
}

export function safeBodySnippet(value: unknown, limit = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text
    .replace(/access_token=[^&\s"]+/gi, 'access_token=[redacted]')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .slice(0, limit);
}

export function platformErrorContext(error: PlatformPublishError): Record<string, unknown> {
  return {
    platform: error.platform,
    stage: error.stage,
    auth_mode: error.authMode ?? null,
    http_status: error.status ?? null,
    normalized_error_code: error.code,
    provider_error_code: error.providerCode ?? null,
    content_type: error.contentType ?? null,
    body_snippet: error.bodySnippet ?? null,
    user_message: error.userMessage,
    next_action: error.nextAction,
  };
}
