export type SlotId = 's1' | 's2' | 's3' | 's4';
export type PlatformKey = 'threads' | 'x' | 'instagram' | 'linkedin' | 'facebook';
export type SourceStatus = 'banked' | 'exhausted';
export type AngleStatus = 'ready' | 'queued' | 'published' | 'discarded';

export interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  url: string;
  score: number;
  comments: number;
  subreddit: string;
  author: string;
  created: number;
}

export interface SourceSummary {
  source_type: string;
  topic: string;
  core_claim: string;
  surface_problem: string;
  deeper_problem: string;
  practical_consequence: string;
  specific_example: string;
  best_line: string;
  audience_fit: string;
  tone_source: string;
  cta_goal: string;
}

export interface AngleCandidate {
  label: string;
  thesis: string;
  hook: string;
  supportingPoints: string[];
  practicalConsequence: string;
  specificExample: string;
  audienceFit: string;
  strength: number;
}

export interface SourceExtraction {
  summary: SourceSummary;
  angles: AngleCandidate[];
}

export interface DraftQualityScores {
  specificity: number;
  human_tone: number;
  platform_fit: number;
  clarity: number;
  practical_consequence: number;
  non_genericity: number;
}

export interface PlatformDraftMeta {
  angle: string;
  scores: DraftQualityScores;
  bannedPhrasesFound: string[];
  learningNotes?: string[];
}

export type DraftMetaMap = Partial<Record<PlatformKey, PlatformDraftMeta>>;

export interface TransformedContent {
  threads: string;
  x: string;
  instagram: string;
  linkedin: string;
  facebook: string;
  imageUrl: string;
}

export interface DraftBundle extends TransformedContent {
  draftMeta: DraftMetaMap;
  draftedPlatforms: PlatformKey[];
  imagePrompt?: string;
}

export interface PlatformIds {
  threads?: string;
  x?: string;
  instagram?: string;
  linkedin?: string;
  facebook?: string;
}

export interface PublishErrors {
  threads?: string;
  x?: string;
  instagram?: string;
  linkedin?: string;
  facebook?: string;
}

export interface QueueItem extends TransformedContent {
  redditId: string;
  title: string;
  sourceHash?: string;
  angleId?: string;
  angleLabel?: string;
  angleThesis?: string;
  draftMeta?: DraftMetaMap;
  draftedPlatforms?: PlatformKey[];
  imagePrompt?: string;
  ids?: PlatformIds;
  publishErrors?: PublishErrors;
  lastPublishAttemptAt?: string;
}

export interface HistoryEntry extends TransformedContent {
  slot: string;
  title: string;
  postedAt: string;
  redditId?: string;
  sourceHash?: string;
  angleId?: string;
  angleLabel?: string;
  angleThesis?: string;
  draftMeta?: DraftMetaMap;
  draftedPlatforms?: PlatformKey[];
  imagePrompt?: string;
  ids?: PlatformIds;
  errors?: string[];
  engagement?: Record<string, unknown> & { polledAt?: string };
}

export interface SourceRecord {
  redditId: string;
  title: string;
  selftext: string;
  url: string;
  subreddit: string;
  author: string;
  created: number;
  contentHash: string;
  status: SourceStatus;
  summary?: SourceSummary;
  angleIds: string[];
  lastSeenAt: string;
  extractedAt?: string;
  exhaustedAt?: string;
  lastQueuedAt?: string;
  lastPublishedAt?: string;
}

export interface AngleRecord {
  id: string;
  redditId: string;
  sourceHash: string;
  sourceCreated: number;
  sourceTitle: string;
  label: string;
  thesis: string;
  hook: string;
  supportingPoints: string[];
  practicalConsequence: string;
  specificExample: string;
  audienceFit: string;
  strength: number;
  status: AngleStatus;
  createdAt: string;
  queuedAt?: string;
  publishedAt?: string;
  discardedAt?: string;
  lastQueuedSlot?: SlotId;
  lastError?: string;
}

export interface QueueState {
  s1: QueueItem | null;
  s2: QueueItem | null;
  s3: QueueItem | null;
  s4: QueueItem | null;
}

export interface Slot {
  id: SlotId;
  label: string;
  cron?: string;
  desc?: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PublishResult {
  nextItem: QueueItem;
  ids: PlatformIds;
  errors: string[];
  pendingPlatforms: PlatformKey[];
  activePlatforms: PlatformKey[];
  skippedPlatforms: PlatformKey[];
  completed: boolean;
}

export interface PlatformPublishState {
  publishBlockedUntil?: string;
  publishBlockedReason?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

export type PlatformPublishStateMap = Partial<Record<PlatformKey, PlatformPublishState>>;

export interface MemoryStats {
  sources: {
    total: number;
    banked: number;
    exhausted: number;
  };
  angles: {
    total: number;
    ready: number;
    queued: number;
    published: number;
    discarded: number;
  };
  legacyUsedIds: number;
}

export interface FillQueueStats {
  fetched: number;
  filled: number;
  reusedAngles: number;
  extractedSources: number;
  exhaustedSources: number;
  skippedExhausted: number;
  skippedReserved: number;
}
