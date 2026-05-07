# Social Content OS

## Core Rule

Do not rewrite source content line by line.

Instead:

- Extract the strongest insight from the source.
- Rebuild it for the target platform.
- Preserve the truth, not the source structure.

Always preserve:

- the core claim
- the deeper problem
- one practical consequence
- one strong concrete example when useful

Never preserve by default:

- the original structure
- the original pacing
- the original CTA
- platform habits from another platform

## Universal Writing Standard

Every platform draft should:

- keep one core point only
- sound like someone who has actually built, debugged, deployed, or observed the problem in real work
- include one real consequence, tradeoff, or failure mode
- avoid documentation tone unless the platform truly needs it
- avoid generic CTA language
- avoid corporate polish

If a draft sounds generic, make it more specific.

If a draft sounds like documentation, compress it into one sharp distinction.

If a draft carries more than one idea, cut it down to one.

## Source Extraction Requirement

Do not draft until the source can produce:

- `core_claim`
- `deeper_problem`
- `practical_consequence`

Use this schema:

```json
{
  "source_type": "reddit_post | comment_thread | docs_note | build_log | screenshot | draft",
  "topic": "short topic label",
  "core_claim": "one-sentence claim",
  "surface_problem": "what people think the issue is",
  "deeper_problem": "what the issue actually is",
  "practical_consequence": "what breaks, slows down, or gets riskier",
  "specific_example": "one concrete example",
  "best_line": "one strong reusable line if any",
  "audience_fit": "builders | founders | operators | mixed",
  "tone_source": "mentor | contrarian | practical | technical",
  "cta_goal": "conversation | profile curiosity | click | dm | none"
}
```

## Platform Intent

- Threads: conversational intelligence, fast insight, typed-sounding observation
- Instagram: save-worthy clarity, visual legibility, strong hook, one clean insight
- LinkedIn: practical professional lesson, quiet authority, work-real framing
- Facebook Group: community-readable explanation with one practical lesson
