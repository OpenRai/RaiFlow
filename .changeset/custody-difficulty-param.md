---
"@openrai/custody": patch
---

fix(custody): pass difficulty to workProvider.generate instead of hardcoding minimum

The `generateWork(hash, difficulty?)` method now accepts an optional difficulty parameter and forwards it to the work provider instead of hardcoding `fffffff800000000`.
