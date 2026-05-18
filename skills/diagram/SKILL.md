---
name: diagram
description: 'Generate a causal loop diagram from audio, video, or text. Use when: user runs /diagram, or @mentions the bot asking for a diagram, causal analysis, or systems thinking visualization.'
---

# Diagram Generation

## When to Use
- User runs `/diagram` with audio attachment or URL
- User @mentions bot and tool selection picks `diagram`
- CLI `npx guildbot diagram`

## Procedure
1. If input is audio/video URL: call `transcribe_audio` tool to produce VTT transcript
2. Parse transcript into sentence chunks
3. Call `extract_causal_relationships` tool with text + optional user prompt
4. Call `export_kumu_json` tool with nodes + relationships
5. Call `export_mermaid_diagram` tool with nodes + relationships
6. Return kumu.json + diagram.png to user

## Tools Used
- `transcribe_audio` — download + whisper transcription
- `extract_causal_relationships` — LLM-powered causal extraction (Qwen3.6, structured JSON)
- `export_kumu_json` — deterministic Kumu format export
- `export_mermaid_diagram` — deterministic Mermaid render via mmdc

## Output
- `kumu.json` — Kumu-compatible graph (`{elements, connections}`)
- `diagram.png` — rendered Mermaid flowchart with color-coded nodes
