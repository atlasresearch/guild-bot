# CLD System Prompt Reference

Reference material for the causal loop diagram extraction process.
See `tools/extract-causal-relationships/system-prompt.md` for the active LLM system prompt.

## Node Types

- **driver**: A variable that primarily causes change in other variables
- **obstacle**: A variable that inhibits or blocks progress
- **actor**: A person, group, or entity that influences the system
- **other**: Variables that don't fit the above categories

## Relationship Polarity

- **positive**: When the subject increases, the object increases (same direction)
- **negative**: When the subject increases, the object decreases (opposite direction)
