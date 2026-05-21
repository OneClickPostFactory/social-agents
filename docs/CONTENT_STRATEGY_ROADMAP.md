# Content Strategy Roadmap

This note is durable product context for future LLM and human sessions working on OneClickPostFactory drafting quality. Read it before changing angle extraction, platform drafting prompts, Settings copy, or public claims about content intelligence.

## 1. Current Release: Content Strategy Profile v1

The current release is Content Strategy Profile v1. It gives each tenant an optional strategy profile that can guide angle extraction and platform drafting.

The profile can describe the user's primary audience, business offer, positioning, content pillars, voice traits, preferred words, avoided words, safe proof assets, CTA style, taboo claims, category context, and default content goal.

This helps the drafting system choose angles and write drafts that are less generic and more aligned with the user's stated strategy. It gives the model better context before generating, especially around audience fit, proof-led positioning, safe claims, and avoided language.

This is not learning yet. The system does not infer voice from edits, learn from rejected drafts, learn from engagement, or build durable adaptive memory from user behavior. It uses the profile the user explicitly provides.

This is enough for public beta because it gives users predictable control without pretending the product is already an autonomous content strategist. The current product should be positioned as source-to-queue automation with optional content strategy context and publish proof.

## 2. Product Boundary

These boundaries are part of the current product contract:

- Do not claim the app learns user voice yet.
- Do not claim autonomous content strategist yet.
- Do not claim performance-based optimization yet.
- Do not add edit/rejection learning without explicit approval.
- Do not add performance learning without explicit approval.
- Do not add named strategist, editor, or agent personalities without explicit approval.
- Do not imply OpenClaw-style agent identity exists in the SaaS drafting path.

## 3. Current Content Flow

The current content pipeline is:

```text
source post
-> source record
-> angle extraction
-> platform-specific draft
-> queue item
-> scheduled publish
-> publish history/proof
```

The drafting system must preserve these rules:

- Source truth wins.
- Do not invent proof.
- Do not invent fake metrics.
- Do not invent customer counts, client names, revenue, growth, or guarantees.
- Do not make guaranteed growth claims.
- Do not position the product as AI magic.
- Do not force a source post into a strategy profile if the source does not support it.

## 4. What Content Strategy Profile v1 Provides

Content Strategy Profile v1 provides optional user-supplied context:

- Primary audience
- Offer
- Positioning
- Content pillars
- Voice traits
- Words to use
- Words to avoid
- Safe proof assets
- CTA style
- Taboo claims
- Category or competitor context
- Default content goal

The profile can influence angle selection and drafting. It must not override source truth, platform limits, banned phrase checks, or proof guardrails.

## 5. What It Does Not Do Yet

Content Strategy Profile v1 does not provide:

- Durable voice memory
- Edit/rejection learning
- Performance learning
- Automatic brand learning
- Named strategist/editor agents
- OpenClaw-style agent identity system
- Autonomous content strategy decisions
- Claims that the product learns the user's voice

## 6. Future Release: Draft Feedback Memory

Draft Feedback Memory is a future release only.

It could include:

- Approved, rejected, and edited draft signals
- User-supplied reasons for rejection
- Original vs edited draft comparison
- User tone preferences
- Recurring corrections
- "Do not use this angle again" signals

Do not build this until the current profile-based drafting is proven with real users and real source posts. The next learning layer should be based on explicit user feedback before it tries to infer preferences from weak signals.

## 7. Later Release: Performance-Informed Content Agent

Performance-informed content intelligence is a later release only.

It could include:

- Publish performance
- Platform response
- Angle-level results
- CTA results
- Cautious recommendations

Do not blindly optimize for likes, reach, or vanity metrics. Performance data is noisy, platform-dependent, and often misleading without the user's business context. Any future performance layer should explain uncertainty and remain subordinate to user strategy and source truth.

## 8. Why We Are Deferring Learning

Learning is deferred because:

- Learning from too little data can damage quality.
- Performance can be noisy and platform-specific.
- User edits are more reliable than raw engagement.
- Strategy profile should come before adaptive learning.
- Public beta needs predictable output first.
- Users should understand what the system is doing before it starts adapting.

The current release should prove that source-to-queue automation plus an explicit strategy profile can produce useful drafts. Adaptive learning can come later.

## 9. Current Public Copy Rules

Allowed public copy:

- Source-to-queue automation
- Platform-specific drafts
- Content strategy profile
- Scheduled queue
- Publish proof
- External post IDs
- Automation that shows its work

Avoid public copy:

- Learns your voice
- Autonomous content strategist
- Guaranteed growth
- Viral
- 10x
- Set and forget forever
- AI magic
- Performance optimization unless proven

## 10. Recommended Next Step

The next practical step is to use the product with real users and real source posts, then review 10 to 20 generated drafts before adding learning features.

Review should check:

- Whether drafts preserve source truth
- Whether profile context improves specificity
- Whether CTAs are useful without being aggressive
- Whether proof assets are used safely
- Whether platform-specific drafts feel native
- Whether users can explain what they would edit

Only after this review should the product consider Draft Feedback Memory.
