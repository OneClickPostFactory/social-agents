import bannedPhrases from '../content-os/BANNED_PHRASES.json';
import config from '../config';

import * as cloudinary from './cloudinary';
import { requestJson } from './http-client';

import type {
  AngleCandidate,
  DraftBundle,
  DraftMetaMap,
  DraftQualityScores,
  PlatformDraftMeta,
  PlatformKey,
  QueueItem,
  RedditPost,
  SourceExtraction,
  SourceSummary,
} from './types';

interface OpenAIErrorResponse {
  error?: {
    message?: string;
  };
}

interface ChatCompletionResponse extends OpenAIErrorResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ImageGenerationResponse extends OpenAIErrorResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  output_format?: string;
}

interface DraftResponse {
  angle?: string;
  post?: string;
  scores?: Partial<DraftQualityScores>;
  banned_phrases_found?: string[];
}

interface ExtractionResponse {
  summary?: Partial<SourceSummary>;
  angles?: Array<Partial<AngleCandidate>>;
}

interface PlatformDraft {
  angle: string;
  post: string;
  scores: DraftQualityScores;
  bannedPhrasesFound: string[];
  learningNotes: string[];
}

interface DraftOptions {
  disableLearningMemory?: boolean;
  disableImageGeneration?: boolean;
  learningNotesByPlatform?: Partial<Record<PlatformKey, string[]>>;
}

interface GeneratedImageAsset {
  b64Json?: string;
  mimeType: string;
  url?: string;
}

type LocalStore = typeof import('./store');
let localStore: LocalStore | undefined;

function getLocalStore(): LocalStore {
  localStore ||= require('./store') as LocalStore;
  return localStore;
}

const MIN_SCORE = 4;

const PLATFORM_ORDER: PlatformKey[] = ['linkedin', 'threads', 'x', 'instagram', 'facebook'];

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  linkedin: 'LinkedIn',
  threads: 'Threads',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

const UNIVERSAL_SYSTEM_PROMPT = `You are converting source content into native posts for LinkedIn, Threads, X, Instagram, and Facebook.

Do not rewrite line by line.

Extract one sharp point and rebuild it as a native post.

Preserve:
- the real claim
- the real consequence
- one concrete example if useful

Do not preserve:
- the original structure
- Reddit framing
- documentation pacing
- generic CTA language

Rules for every platform:
- keep one core point only
- sound like someone who has actually built, debugged, deployed, maintained, or untangled the problem
- include one real consequence, tradeoff, or failure mode
- remove fluff, corporate phrasing, and broad motivational framing
- if the post sounds generic, make it more specific
- if the post sounds like documentation, compress it into one sharp distinction
- if the post has more than one idea, cut it down to one

Do not use phrases like:
${bannedPhrases.join('\n')}

Before finalizing, cut anything that sounds generic, abstract, overly polished, or transferable to any industry.
Keep only what feels observed, specific, and earned.
${config.CUSTOM_PROMPT ? `\nAdditional style: ${config.CUSTOM_PROMPT}` : ''}`;

const EXTRACTION_SYSTEM_PROMPT = `You turn one source into a reusable content bank.

Return JSON only.

Produce:
- one source summary
- two to five distinct, non-overlapping angles that could each become a separate future post

Each angle must be atomic enough to stand alone later.
Do not output paraphrases of the same idea.
Prefer angles with a concrete professional consequence.
If the source is weak, you may return fewer angles, but never pad with generic filler.`;

const PLATFORM_RULES: Record<PlatformKey, { maxTokens: number; rules: string }> = {
  linkedin: {
    maxTokens: 360,
    rules: `Platform: LinkedIn
- Goal: one practical professional lesson
- Tone: grounded, professional, specific, calm authority
- Structure: concrete observation, deeper issue, practical consequence, quiet ending
- Length: 120-220 words
- Open with a concrete observation, not a grand claim
- Avoid abstract thought-leadership voice, hype, and broad motivational framing
- Hashtags are optional; only use them if they add value and keep them minimal`,
  },
  threads: {
    maxTokens: 260,
    rules: `Platform: Threads
- Goal: one sharp conversational observation
- Tone: lightly conversational, sharp, human, compressed
- Structure: observation, correction, why it matters
- Length: 40-120 words and under 480 characters if possible
- No article-like exposition
- No heavy CTA
- No hashtags unless they are genuinely necessary, and keep them minimal
- First sentence must work on its own`,
  },
  x: {
    maxTokens: 220,
    rules: `Platform: X
- Goal: one sharp operational observation
- Tone: conversational, punchy, specific, human
- Structure: hook, insight, consequence
- Target length: under 270 characters
- Hard limit: 280 characters maximum
- Keep it to one core point only
- Do not mention Reddit, forums, or source provenance
- Hashtags are optional; use 0-2 only if they genuinely add value
- The first clause should make people stop scrolling`,
  },
  instagram: {
    maxTokens: 320,
    rules: `Platform: Instagram
- Goal: one save-worthy idea
- Tone: clear, memorable, visually legible
- Structure: hook, problem, deeper truth, why it matters, short landing line
- Caption must make sense even without slides
- Use short sentences and line breaks for readability
- Focus on one emotionally clear insight
- Avoid consultant language and long taxonomy explanations
- Keep hashtags minimal and relevant only if they add value`,
  },
  facebook: {
    maxTokens: 360,
    rules: `Platform: Facebook Group
- Goal: one practical lesson for a community audience
- Tone: grounded, readable, lightly conversational
- Structure: concrete observation, deeper issue, practical consequence, quiet ending
- Keep the lesson clear and useful
- Avoid hype, heavy CTA language, and consultant phrasing
- Keep one core idea only`,
  },
};

function getEnabledDraftPlatforms(): PlatformKey[] {
  return PLATFORM_ORDER.filter(platform => {
    switch (platform) {
      case 'linkedin':
        return config.ENABLE_LINKEDIN;
      case 'threads':
        return config.ENABLE_THREADS;
      case 'x':
        return config.ENABLE_X;
      case 'instagram':
        return config.ENABLE_INSTAGRAM;
      case 'facebook':
        return config.ENABLE_FACEBOOK;
    }
  });
}

function chatComplete(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 500,
  temperature = 0.8
): Promise<string> {
  const body = JSON.stringify({
    model: config.OPENAI_MODEL || 'gpt-4o',
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  return requestJson<ChatCompletionResponse>('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
    },
    body,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => {
    if (data.error) {
      throw new Error('OpenAI: ' + (data.error.message || 'Unknown error'));
    }
    return data.choices?.[0]?.message?.content?.trim() || '';
  });
}

function extractJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('Failed to parse JSON from model response');
  }
}

function clampScore(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(5, Math.round(value as number)));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return bannedPhrases.filter(phrase => lower.includes(phrase.toLowerCase()));
}

function normalizeSourceSummary(value: Partial<SourceSummary>, post: Pick<RedditPost, 'title' | 'selftext'>): SourceSummary {
  return {
    source_type: value.source_type || 'reddit_post',
    topic: value.topic || post.title.substring(0, 80),
    core_claim: value.core_claim || post.title,
    surface_problem: value.surface_problem || 'People focus on the visible surface issue.',
    deeper_problem: value.deeper_problem || 'The deeper issue is hidden in the workflow, control, or system design.',
    practical_consequence: value.practical_consequence || 'That makes the system harder to trust, debug, or scale.',
    specific_example: value.specific_example || post.selftext.substring(0, 180),
    best_line: value.best_line || '',
    audience_fit: value.audience_fit || 'builders',
    tone_source: value.tone_source || 'practical',
    cta_goal: value.cta_goal || 'none',
  };
}

function normalizeAngleCandidate(
  value: Partial<AngleCandidate>,
  summary: SourceSummary
): AngleCandidate {
  return {
    label: (value.label || 'lesson').trim() || 'lesson',
    thesis: (value.thesis || summary.core_claim).trim() || summary.core_claim,
    hook: (value.hook || summary.best_line || summary.core_claim).trim() || summary.core_claim,
    supportingPoints: dedupeStrings(value.supportingPoints || []).slice(0, 3),
    practicalConsequence: (value.practicalConsequence || summary.practical_consequence).trim()
      || summary.practical_consequence,
    specificExample: (value.specificExample || summary.specific_example || '').trim(),
    audienceFit: (value.audienceFit || summary.audience_fit || 'builders').trim() || 'builders',
    strength: clampScore(value.strength),
  };
}

function normalizeSourceExtraction(
  value: Partial<ExtractionResponse>,
  post: Pick<RedditPost, 'title' | 'selftext'>
): SourceExtraction {
  const summary = normalizeSourceSummary(value.summary || {}, post);
  const rawAngles = (value.angles || []).map(angle => normalizeAngleCandidate(angle, summary));
  const dedupedAngles = rawAngles.filter((angle, index, angles) => {
    const key = `${angle.label.toLowerCase()}|${angle.thesis.toLowerCase()}`;
    return angles.findIndex(candidate => (
      `${candidate.label.toLowerCase()}|${candidate.thesis.toLowerCase()}` === key
    )) === index;
  });

  const angles = dedupedAngles.length
    ? dedupedAngles.slice(0, 5)
    : [normalizeAngleCandidate({}, summary)];

  return { summary, angles };
}

function normalizeDraftResponse(
  defaultAngle: string,
  learningNotes: string[],
  value: DraftResponse
): PlatformDraft {
  return {
    angle: value.angle || defaultAngle,
    post: (value.post || '').trim(),
    scores: {
      specificity: clampScore(value.scores?.specificity),
      human_tone: clampScore(value.scores?.human_tone),
      platform_fit: clampScore(value.scores?.platform_fit),
      clarity: clampScore(value.scores?.clarity),
      practical_consequence: clampScore(value.scores?.practical_consequence),
      non_genericity: clampScore(value.scores?.non_genericity),
    },
    bannedPhrasesFound: dedupeStrings([
      ...(value.banned_phrases_found || []),
      ...findBannedPhrases(value.post || ''),
    ]),
    learningNotes,
  };
}

function getScoreIssues(scores: DraftQualityScores): string[] {
  const issues: string[] = [];
  if (scores.specificity < MIN_SCORE) issues.push(`specificity below ${MIN_SCORE}`);
  if (scores.human_tone < MIN_SCORE) issues.push(`human tone below ${MIN_SCORE}`);
  if (scores.platform_fit < MIN_SCORE) issues.push(`platform fit below ${MIN_SCORE}`);
  return issues;
}

function needsRevision(platform: PlatformKey, draft: PlatformDraft): string[] {
  const issues = getScoreIssues(draft.scores);
  if (!draft.post) {
    issues.push('empty draft');
  }
  if (draft.bannedPhrasesFound.length) {
    issues.push(`banned phrases found: ${draft.bannedPhrasesFound.join(', ')}`);
  }
  if (platform === 'threads' && draft.post.length > 500) {
    issues.push('Threads draft exceeds 500 characters');
  }
  if (platform === 'x' && draft.post.length > 270) {
    issues.push('X draft exceeds 270 characters');
  }
  return issues;
}

function formatSourceSummary(summary: SourceSummary): string {
  return [
    `topic: ${summary.topic}`,
    `core_claim: ${summary.core_claim}`,
    `surface_problem: ${summary.surface_problem}`,
    `deeper_problem: ${summary.deeper_problem}`,
    `practical_consequence: ${summary.practical_consequence}`,
    `specific_example: ${summary.specific_example || 'none'}`,
    `best_line: ${summary.best_line || 'none'}`,
    `audience_fit: ${summary.audience_fit}`,
    `tone_source: ${summary.tone_source}`,
    `cta_goal: ${summary.cta_goal}`,
  ].join('\n');
}

function formatAngle(angle: AngleCandidate): string {
  return [
    `label: ${angle.label}`,
    `thesis: ${angle.thesis}`,
    `hook: ${angle.hook}`,
    `practical_consequence: ${angle.practicalConsequence}`,
    `specific_example: ${angle.specificExample || 'none'}`,
    `audience_fit: ${angle.audienceFit}`,
    `supporting_points: ${angle.supportingPoints.length ? angle.supportingPoints.join(' | ') : 'none'}`,
  ].join('\n');
}

function chatCompleteJson<T>(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 500,
  temperature = 0.6
): Promise<T> {
  return chatComplete(systemPrompt, userPrompt, maxTokens, temperature)
    .then(raw => extractJson<T>(raw));
}

function getPlatformText(
  entry: {
    linkedin?: string;
    threads?: string;
    x?: string;
    instagram?: string;
    facebook?: string;
  },
  platform: PlatformKey
): string {
  switch (platform) {
    case 'linkedin':
      return entry.linkedin || '';
    case 'threads':
      return entry.threads || '';
    case 'x':
      return entry.x || '';
    case 'instagram':
      return entry.instagram || '';
    case 'facebook':
      return entry.facebook || '';
  }
}

function capPlatformPost(platform: PlatformKey, text: string): string {
  if (platform !== 'x' || text.length <= 280) {
    return text;
  }

  return text.slice(0, 277).trimEnd() + '...';
}

function getOpening(text: string, words = 10): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, words)
    .join(' ');
}

function getEngagementScore(engagement: Record<string, unknown> | undefined): number {
  if (!engagement) return 0;

  let total = 0;
  for (const [key, value] of Object.entries(engagement)) {
    if (key === 'polledAt' || typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }

    if (/comment|reply/i.test(key)) {
      total += value * 2;
    } else if (/share|repost/i.test(key)) {
      total += value * 2.5;
    } else if (/save|bookmark/i.test(key)) {
      total += value * 2;
    } else if (/click/i.test(key)) {
      total += value * 1.5;
    } else if (/like|reaction|heart/i.test(key)) {
      total += value;
    } else if (/impression|view|reach/i.test(key)) {
      total += value / 200;
    } else {
      total += value / 2;
    }
  }

  return Math.min(total, 20);
}

function getDraftQualityScore(meta: PlatformDraftMeta | undefined): number {
  if (!meta) return 0;

  const values = [
    meta.scores.specificity,
    meta.scores.human_tone,
    meta.scores.platform_fit,
    meta.scores.clarity,
    meta.scores.practical_consequence,
    meta.scores.non_genericity,
  ];

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getPlatformPerformanceScore(
  entry: {
    ids?: Partial<Record<PlatformKey, string>>;
    errors?: string[];
    engagement?: Record<string, unknown>;
    draftMeta?: DraftMetaMap;
  },
  platform: PlatformKey
): number {
  let score = getDraftQualityScore(entry.draftMeta?.[platform]);

  if (entry.ids?.[platform]) {
    score += 2;
  }

  const platformName = PLATFORM_LABELS[platform].toLowerCase();
  if (entry.errors?.some(error => error.toLowerCase().startsWith(platformName))) {
    score -= 2;
  }

  score += getEngagementScore(entry.engagement) / 4;
  return score;
}

function buildLearningNotes(platform: PlatformKey, angle: AngleCandidate): string[] {
  const store = getLocalStore();
  const history = store.getHistory()
    .filter(entry => getPlatformText(entry, platform).trim());
  const queueItems = Object.values(store.getQueue())
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter(item => getPlatformText(item, platform).trim());

  const winners = [...history]
    .sort((a, b) => getPlatformPerformanceScore(b, platform) - getPlatformPerformanceScore(a, platform))
    .filter(entry => getPlatformPerformanceScore(entry, platform) > 0)
    .slice(0, 2);

  const weak = [...history]
    .sort((a, b) => getPlatformPerformanceScore(a, platform) - getPlatformPerformanceScore(b, platform))
    .filter(entry => getPlatformPerformanceScore(entry, platform) < 3)
    .slice(0, 2);

  const recentOpenings = dedupeStrings([
    ...queueItems.map(item => getOpening(getPlatformText(item, platform), 8)),
    ...history.slice(0, 3).map(entry => getOpening(getPlatformText(entry, platform), 8)),
  ]).slice(0, 3);

  const recentAngleLabels = history
    .slice(0, 6)
    .map(entry => entry.angleLabel?.trim().toLowerCase())
    .filter((label): label is string => Boolean(label));

  const notes: string[] = [];

  if (winners.length) {
    notes.push(
      `Recent ${PLATFORM_LABELS[platform]} winners started like: ${
        winners.map(entry => `"${getOpening(getPlatformText(entry, platform), 9)}"`).join(', ')
      }.`
    );
  }

  if (recentOpenings.length) {
    notes.push(`Avoid reusing these recent openings too closely: ${recentOpenings.map(opening => `"${opening}"`).join(', ')}.`);
  }

  if (recentAngleLabels.filter(label => label === angle.label.toLowerCase()).length >= 2) {
    notes.push(`This angle label has been used a lot recently, so vary the framing and hook.`);
  }

  if (weak.length) {
    notes.push(
      `Avoid drifting toward weaker recent starts like ${
        weak.map(entry => `"${getOpening(getPlatformText(entry, platform), 8)}"`).join(', ')
      }.`
    );
  }

  return notes.slice(0, 3);
}

async function buildImagePrompt(
  source: Pick<RedditPost, 'title' | 'selftext'>,
  summary: SourceSummary,
  angle: AngleCandidate
): Promise<string> {
  const promptContext = [
    `Topic: ${summary.topic}`,
    `Core claim: ${summary.core_claim}`,
    `Angle thesis: ${angle.thesis}`,
    `Angle hook: ${angle.hook}`,
    `Practical consequence: ${angle.practicalConsequence}`,
    angle.specificExample ? `Specific example: ${angle.specificExample}` : '',
    `Original title: ${source.title}`,
  ]
    .filter(Boolean)
    .join('\n');

  const body = JSON.stringify({
    model: config.OPENAI_MODEL || 'gpt-4o',
    max_tokens: 150,
    temperature: 0.7,
    messages: [{
      role: 'system',
      content: `You write prompts for GPT Image Instagram generations.
You produce vivid, specific, photorealistic scene descriptions.
Never include text, words, logos, or letters in the image.
Never use generic concepts like "shield", "lock", "lightbulb" or "network diagram".
Always describe a real scene with real people, objects, environments or metaphors.`,
    }, {
      role: 'user',
      content: `Based on this content, write a specific GPT Image prompt for an Instagram post.

Content:
"""
${promptContext}
"""

Write ONE paragraph describing a vivid, photorealistic scene that visually represents the angle.
Be specific about lighting, environment, mood, colours, and perspective.
No text or words in the image. No generic tech icons.
Return ONLY the image prompt, nothing else.`,
    }],
  });

  return requestJson<ChatCompletionResponse>('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
    },
    body,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => {
    if (data.error) {
      throw new Error('OpenAI: ' + (data.error.message || 'Unknown error'));
    }
    return data.choices?.[0]?.message?.content?.trim() || source.title;
  });
}

async function generateImage(
  source: Pick<RedditPost, 'title' | 'selftext'>,
  summary: SourceSummary,
  angle: AngleCandidate
): Promise<{ imagePrompt: string; imageUrl: string }> {
  const imagePrompt = await buildImagePrompt(source, summary, angle);
  const image = await generateImageFromPrompt(imagePrompt);

  return {
    imagePrompt,
    imageUrl: await persistInstagramImage(image, imagePrompt, source.title),
  };
}

function imageMimeType(outputFormat: string | undefined): string {
  switch ((outputFormat || 'png').toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function imageGenerationBody(imagePrompt: string): Record<string, unknown> {
  const model = config.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const body: Record<string, unknown> = {
    model,
    prompt: imagePrompt,
    n: 1,
    size: '1024x1024',
  };

  if (model.startsWith('gpt-image') || model === 'chatgpt-image-latest') {
    body.quality = 'medium';
    body.output_format = 'png';
    body.background = 'auto';
  } else {
    body.response_format = 'b64_json';
    if (model === 'dall-e-3') {
      body.quality = 'standard';
      body.style = 'natural';
    }
  }

  return body;
}

async function generateImageFromPrompt(imagePrompt: string): Promise<GeneratedImageAsset> {
  const body = JSON.stringify(imageGenerationBody(imagePrompt));

  try {
    const { data } = await requestJson<ImageGenerationResponse>('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
      },
      body,
      timeoutMs: Math.max(config.HTTP_TIMEOUT_MS, 60000),
      retryCount: 1,
      retryDelayMs: 500,
    });

    if (data.error) {
      throw new Error('GPT Image generation failed: ' + (data.error.message || 'Unknown error'));
    }

    const image = data.data?.[0];
    if (image?.b64_json) {
      return {
        b64Json: image.b64_json,
        mimeType: imageMimeType(data.output_format),
      };
    }
    if (image?.url) {
      return {
        url: image.url,
        mimeType: imageMimeType(data.output_format),
      };
    }

    throw new Error('OpenAI image response did not include image data');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GPT Image generation failed: ${message}`);
  }
}

async function persistInstagramImage(
  image: GeneratedImageAsset,
  imagePrompt: string,
  publicIdHint?: string
): Promise<string> {
  if (image.url && cloudinary.isCloudinaryUrl(image.url)) {
    return image.url;
  }

  if (!cloudinary.isConfigured()) {
    throw new Error('cloudinary_not_configured_for_instagram_image_persistence');
  }

  if (image.b64Json) {
    return cloudinary.uploadImageAsset(
      `data:${image.mimeType};base64,${image.b64Json}`,
      publicIdHint || imagePrompt
    );
  }

  if (image.url) {
    return cloudinary.uploadRemoteImage(image.url, publicIdHint || imagePrompt);
  }

  throw new Error('generated_instagram_image_missing');
}

export async function refreshInstagramImage(item: QueueItem): Promise<QueueItem> {
  if (!item.imageUrl) {
    if (!item.imagePrompt?.trim()) {
      throw new Error('Cannot refresh Instagram image because imagePrompt is missing');
    }
    const image = await generateImageFromPrompt(item.imagePrompt);
    return {
      ...item,
      imageUrl: await persistInstagramImage(image, item.imagePrompt, item.title),
    };
  }

  if (cloudinary.isCloudinaryUrl(item.imageUrl)) {
    return item;
  }

  if (!cloudinary.isConfigured()) {
    throw new Error('cloudinary_not_configured_for_instagram_image_persistence');
  }

  try {
    return {
      ...item,
      imageUrl: await cloudinary.uploadRemoteImage(item.imageUrl, item.title),
    };
  } catch {
    // The original provider URL may already be expired; regenerate below from the stored prompt.
  }

  if (!item.imagePrompt?.trim()) {
    throw new Error('Cannot refresh Instagram image because imagePrompt is missing');
  }

  const image = await generateImageFromPrompt(item.imagePrompt);

  return {
    ...item,
    imageUrl: await persistInstagramImage(image, item.imagePrompt, item.title),
  };
}

export async function ensurePersistentInstagramImage(input: {
  imageUrl?: string | null;
  imagePrompt?: string | null;
  title?: string | null;
  text?: string | null;
}): Promise<{ imagePrompt: string; imageUrl: string }> {
  const imageUrl = input.imageUrl?.trim();
  const imagePrompt = input.imagePrompt?.trim();
  const title = input.title?.trim() || 'Instagram post';

  if (imageUrl && cloudinary.isCloudinaryUrl(imageUrl)) {
    return { imagePrompt: imagePrompt || '', imageUrl };
  }

  if (imageUrl && cloudinary.isConfigured()) {
    try {
      return {
        imagePrompt: imagePrompt || '',
        imageUrl: await cloudinary.uploadRemoteImage(imageUrl, title),
      };
    } catch {
      // Expired provider URLs are regenerated from the stored prompt or text below.
    }
  }

  if (imagePrompt) {
    const image = await generateImageFromPrompt(imagePrompt);
    return {
      imagePrompt,
      imageUrl: await persistInstagramImage(image, imagePrompt, title),
    };
  }

  return generateInstagramImageFromText(title, input.text || '');
}

export async function generateInstagramImageFromText(
  title: string,
  text: string
): Promise<{ imagePrompt: string; imageUrl: string }> {
  const imagePrompt = [
    'Photorealistic editorial image for an Instagram post.',
    'No text, words, logos, letters, UI screenshots, or generic tech icons.',
    `Post title: ${title || 'Untitled post'}.`,
    `Post content: ${text.substring(0, 700)}.`,
    'Show a concrete real-world scene with people, objects, environment, lighting, mood, and perspective.',
  ].join(' ');
  const image = await generateImageFromPrompt(imagePrompt);
  return {
    imagePrompt,
    imageUrl: await persistInstagramImage(image, imagePrompt, title || text.substring(0, 80)),
  };
}

async function draftForPlatform(
  platform: PlatformKey,
  source: Pick<RedditPost, 'title' | 'selftext'>,
  summary: SourceSummary,
  angle: AngleCandidate,
  options: DraftOptions = {}
): Promise<PlatformDraft> {
  const sourceText = [source.title, source.selftext].filter(Boolean).join('\n\n').substring(0, 900);
  const rule = PLATFORM_RULES[platform];
  const learningNotes = options.disableLearningMemory
    ? []
    : (options.learningNotesByPlatform?.[platform] || buildLearningNotes(platform, angle));

  const userPrompt = `Source summary:
${formatSourceSummary(summary)}

Selected angle:
${formatAngle(angle)}

Original source:
"""
${sourceText}
"""

${rule.rules}

Write from this exact angle only.
Do not blend in other unused angles from the same source.
Keep the post faithful to the selected angle's practical consequence.

${learningNotes.length ? `Memory signals:\n- ${learningNotes.join('\n- ')}\n` : ''}
Return JSON only in this shape:
{
  "angle": "",
  "post": "",
  "scores": {
    "specificity": 0,
    "human_tone": 0,
    "platform_fit": 0,
    "clarity": 0,
    "practical_consequence": 0,
    "non_genericity": 0
  },
  "banned_phrases_found": []
}`;

  let draft = normalizeDraftResponse(
    angle.label,
    learningNotes,
    await chatCompleteJson<DraftResponse>(UNIVERSAL_SYSTEM_PROMPT, userPrompt, rule.maxTokens, 0.7)
  );

  const issues = needsRevision(platform, draft);
  if (issues.length) {
    const revisionPrompt = `Revise this ${PLATFORM_LABELS[platform]} draft.

Problems to fix:
- ${issues.join('\n- ')}

Selected angle:
${formatAngle(angle)}

Source summary:
${formatSourceSummary(summary)}

Current draft:
"""
${draft.post}
"""

${learningNotes.length ? `Memory signals:\n- ${learningNotes.join('\n- ')}\n` : ''}
Return JSON only in the same shape:
{
  "angle": "",
  "post": "",
  "scores": {
    "specificity": 0,
    "human_tone": 0,
    "platform_fit": 0,
    "clarity": 0,
    "practical_consequence": 0,
    "non_genericity": 0
  },
  "banned_phrases_found": []
}`;

    draft = normalizeDraftResponse(
      angle.label,
      learningNotes,
      await chatCompleteJson<DraftResponse>(UNIVERSAL_SYSTEM_PROMPT, revisionPrompt, rule.maxTokens, 0.6)
    );
  }

  return {
    ...draft,
    post: capPlatformPost(platform, draft.post),
  };
}

export function getActiveDraftPlatforms(): PlatformKey[] {
  return getEnabledDraftPlatforms();
}

export async function extractSourceBank(post: RedditPost): Promise<SourceExtraction> {
  const source = [post.title, post.selftext].filter(Boolean).join('\n\n').substring(0, 2400);
  const userPrompt = `Return JSON only using this schema:
{
  "summary": {
    "source_type": "reddit_post",
    "topic": "",
    "core_claim": "",
    "surface_problem": "",
    "deeper_problem": "",
    "practical_consequence": "",
    "specific_example": "",
    "best_line": "",
    "audience_fit": "",
    "tone_source": "",
    "cta_goal": ""
  },
  "angles": [
    {
      "label": "",
      "thesis": "",
      "hook": "",
      "supportingPoints": [],
      "practicalConsequence": "",
      "specificExample": "",
      "audienceFit": "",
      "strength": 0
    }
  ]
}

Source content:
"""
${source}
"""`;

  const parsed = await chatCompleteJson<ExtractionResponse>(
    EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    900,
    0.4
  );

  return normalizeSourceExtraction(parsed, post);
}

export async function draftPlatforms(
  source: Pick<RedditPost, 'title' | 'selftext'>,
  summary: SourceSummary,
  angle: AngleCandidate,
  platforms: PlatformKey[],
  options: DraftOptions = {}
): Promise<DraftBundle> {
  const activePlatforms = [...new Set(platforms)];
  const transformed: DraftBundle = {
    linkedin: '',
    threads: '',
    x: '',
    instagram: '',
    facebook: '',
    imageUrl: '',
    draftMeta: {},
    draftedPlatforms: activePlatforms,
  };

  const draftEntries = await Promise.all(
    activePlatforms.map(platform => draftForPlatform(platform, source, summary, angle, options)
      .then(draft => ({ platform, draft })))
  );

  for (const { platform, draft } of draftEntries) {
    switch (platform) {
      case 'linkedin':
        transformed.linkedin = draft.post;
        break;
      case 'threads':
        transformed.threads = draft.post;
        break;
      case 'x':
        transformed.x = draft.post;
        break;
      case 'instagram':
        transformed.instagram = draft.post;
        break;
      case 'facebook':
        transformed.facebook = draft.post;
        break;
    }

    transformed.draftMeta[platform] = {
      angle: draft.angle,
      scores: draft.scores,
      bannedPhrasesFound: draft.bannedPhrasesFound,
      learningNotes: draft.learningNotes,
    };
  }

  if (activePlatforms.includes('instagram') && !options.disableImageGeneration) {
    const image = await generateImage(source, summary, angle);
    transformed.imageUrl = image.imageUrl;
    transformed.imagePrompt = image.imagePrompt;
  }

  return transformed;
}

export async function draftAngleContent(
  source: Pick<RedditPost, 'title' | 'selftext'>,
  summary: SourceSummary,
  angle: AngleCandidate
): Promise<DraftBundle> {
  return draftPlatforms(source, summary, angle, getEnabledDraftPlatforms());
}
