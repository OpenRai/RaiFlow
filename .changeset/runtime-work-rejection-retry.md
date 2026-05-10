---
"@openrai/runtime": minor
---

feat(runtime): retry-once on work rejection, blockType-aware work generation, 422 for insufficient work

- SendOrchestrator now fetches dynamic difficulty and passes it to work generation
- On "Block work is less than threshold" error: invalidates difficulty cache, refetches, regenerates work, and retries once
- POST /work now accepts optional `blockType: 'receive'` to use receive difficulty
- POST /blocks returns HTTP 422 with `insufficient_work` code when work is rejected
