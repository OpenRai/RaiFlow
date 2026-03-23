# Monorepo layout

```text
apps/site          - public docs site
packages/model     - canonical schemas
packages/watcher   - chain observation
packages/runtime   - payment runtime
packages/sdk-js    - JS/TS SDK
packages/webhook   - webhook helpers
examples/          - reference integrations
rfcs/              - design records
```

The first public package surface should stay small.  
The runtime should absorb complexity so application developers do not have to.
