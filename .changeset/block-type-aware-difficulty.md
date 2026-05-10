---
"@openrai/rpc": minor
---

feat(rpc): cache both send and receive difficulty thresholds, expose invalidateDifficultyCache

BREAKING CHANGE: `getActiveDifficulty()` now returns `{ send: string; receive: string }` instead of `string`. Update callers to use `.send` or `.receive` fields. `workGenerate()` now accepts an optional `blockType: 'send' | 'receive'` parameter to select the appropriate difficulty threshold.
