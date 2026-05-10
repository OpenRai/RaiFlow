---
"@openrai/raiflow-sdk": minor
---

feat(raiflow-sdk): add blockType parameter to WorkResource.generate()

The `generate(hash, difficulty?, blockType?)` method now accepts an optional `blockType: 'send' | 'receive'` to generate work at the appropriate network threshold.
