---
name: meeting-review
description: 'Summarise a recording into insights, action items, decisions, and open questions. Use when: user runs /record review, or @mentions bot asking for meeting summary, digest, or action items from a transcript.'
---

# Meeting Review

## When to Use
- User runs `/record review` with optional recording ID and prompt
- User @mentions bot and tool selection picks `meeting_summarise`

## Procedure
1. Resolve recording: by ID from command arg, or latest recording for channel
2. Read VTT transcript, strip timing/markup into plain lines
3. Call `generate_meeting_digest` tool with transcript lines + optional user prompt
4. Format output into markdown sections: Insights, Action Items, Decisions, Open Questions
5. Return formatted digest (inline or as `.txt` attachment if >2000 chars)

## Tools Used
- `get_recording_transcript` — resolve and read VTT file
- `generate_meeting_digest` — LLM-powered structured extraction (Qwen3.6, structured JSON)

## Output
Markdown with four sections:
- **Insights** — durable findings with evidence spans
- **Action Items** — tasks with owner, due date, status
- **Decisions** — resolved choices with rationale
- **Open Questions** — unresolved items with owner
