# RaiFlow Architectural Review (Reconciled)

**Review Date:** 2026-03-30
**Review Board:** OpenRai Council (adam, bertil, caesar; david timed out)
**Documents Reconciled:** `architectural-review-0.md` (strategic vision, 291 lines) + previous `architectural-review.md` (implementation review, 311 lines)

---

## Executive Summary

The architectural vision in the **original review is strategically sound and must be preserved**. The implementation findings in the **second review are accurate but incomplete** — it failed to read the original strategic document and missed 7 critical gaps.

**Core Insight:** The second review treated the codebase as a standalone project. The original established it as one half of a dual-SDK ecosystem. The reconciliation reveals that **the SDK isn't just incomplete — it's architecturally misaligned** with the strategic vision.

---

## 1. What the Original Document Established (Strategic Doctrine)

### 1.1 The Frontier Dilemma is THE Architectural Constraint

Nano is state-based (block-lattice), not action-based (like EVM). Each block seals absolute state including the previous hash (frontier). Unexpected incoming transactions invalidate pre-computed outbound blocks. Modern Nano integration must manage local concurrency (Mutex/Queues) to sequence the frontier perfectly.

**This shapes the dual-SDK boundary:**
- `nano-core` MUST solve frontier management (mutex/queues) for wallet operations
- `raiflow-sdk` and RaiFlow's watcher/runtime operate in observe mode and do NOT need frontier management
- The second review's characterization of watcher's `NanoRpcClient` as "duplication" is **partially incorrect** — it's appropriate separation of concerns, but lacks transport fallback resilience

### 1.2 Symmetric DevEx is Non-Negotiable

Both SDKs must share:
- **Shared domain objects:** `NanoAmount`, `NanoAddress` — eradicate "Stringly-Typed Money"
- **Progressive disclosure:** `.initialize({ ... })` pattern with smart defaults
- **Zero mental whiplash:** Developer graduating from raiflow-sdk to nano-core finds identical syntax

**Currently violated:** The SDK's type shadowing bug is a direct violation of this contract.

### 1.3 WorkProvider.auto() is Mandatory for Production

Empirical browser hostility data proves naive work generation fails:
- **WebGPU "Throttle Cliff":** Browsers throttle GPU compute after 1-2s, dropping from 336 MH/s to 7.5 MH/s
- **WASM "Death Spiral":** Multi-threaded WASM in Safari takes longer than single-threaded due to scheduler intervention
- **WebGL:** Predictable ~15 MH/s baseline

JIT Environment Profiling via `WorkProvider.auto()` is architecturally necessary, not optional.

### 1.4 Multi-Language Strategy Requires DDD Validation Now

Tier 1: Rust, Go, Zig (performance & infrastructure)
Tier 2: Python, Java/JVM (enterprise & AI)

The DDD patterns (immutable value objects, explicit contracts) must be validated in the current TypeScript implementation to ensure cross-language portability.

---

## 2. What the Second Review Found (Implementation Reality)

### Confirmed Issues

| Issue | Severity | Location |
|-------|----------|----------|
| **SDK broken dependency** | Critical | `raiflow-sdk/package.json` — `file:../../../nano-core` link |
| **Type shadowing** | Critical | SDK defines `Invoice` with `status: string` instead of re-exporting `InvoiceStatus` |
| **Invalid enum value** | Bug | Mock returns `status: 'pending'` — doesn't exist in `InvoiceStatus` |
| **Missing fields** | Bug | SDK's `Invoice` missing `expectedAmountRaw`, `confirmedAmountRaw`, `currency` |
| **RFC stasis** | Process | All 3 RFCs are Draft despite implementation |
| **Observability gap** | Technical debt | Webhook delivery uses raw `console.log` |

### What the Second Review Misframed

**"RPC duplication is the #1 architectural debt"** — Overstated. The watcher observes; nano-core mutates. The transport is similar but the problem domain is different. The real debt is:
1. Watcher's single-URL RPC client lacks transport fallback
2. No shared contract for RPC transport between watcher and nano-core

---

## 3. Gaps Neither Document Addressed

### 3.1 The nano-core Existential Crisis

`@openrai/nano-core` exists OUTSIDE the RaiFlow monorepo at `../nano-core`. The `file:` dependency is:
- **Path fragile** — assumes specific directory structure
- **Unversioned** — no semver constraints
- **CI/CD hostile** — build agents may not have nano-core at that path
- **Publishing blocker** — published package would have missing dependency

**Resolution:** Either bring nano-core into the monorepo, publish to npm with versioned dependency, or temporarily implement `NanoAmount` locally.

### 3.2 The berrypay-cli Strategic Ambiguity

Document A positions berrypay as "SOTA for programmatic micro-payments." The codebase has `berrypay-cli` as a standalone CLI tool using `nanocurrency`, unrelated to the dual-SDK. Options:
1. **Seed for nano-core:** Extract wallet logic into nano-core
2. **Separate tool:** Maintain independently
3. **Legacy:** Deprecate once raiflow-sdk is functional

### 3.3 Watcher/Runtime vs nano-core Integration Path

The watcher should NOT adopt nano-core's full client (which includes frontier management and PoW — irrelevant for observe mode). Instead:
- Extract a minimal `NanoRpcTransport` interface from nano-core
- Watcher can optionally use it for transport fallback resilience
- Both share `@openrai/model` types as the contract layer

### 3.4 Anti-Pattern Mapping to Current Codebase

| Anti-Pattern (from Document A) | Current Violation |
|-------------------------------|-------------------|
| **Primitive Obsession** | `amountRaw: string`, `xnoToRaw()` hand-rolled in runtime |
| **Temporal Coupling** | Inconsistent initialization (constructor vs static factory) |
| **Opaque Dependencies** | Single RPC URL with no fallback, broken `file:` link |
| **Naive Work Generation** | No WorkProvider integration anywhere |

### 3.5 RFC Process is Undefined

No mechanism exists for advancing RFCs from Draft → Accepted → Final. This must be formalized before drafting new RFCs.

---

## 4. Revised Prioritization

### Why the Second Review's Order Was Wrong

The second review recommended: Phase 3 → Persistence → nano-core migration.

This fails because:
1. Phase 3 cannot be "completed" while SDK has broken dependency and type shadowing
2. Persistence is independent of Phase 3 and can proceed in parallel
3. nano-core migration scope is larger than estimated (WorkProvider, frontier management)

### Reconciled Priority Sequence

| Priority | Action | Timeline |
|----------|--------|----------|
| **P0** | Fix SDK broken `file:` dependency | This week |
| **P0** | Fix Invoice type shadowing — re-export from `@openrai/model` | This week |
| **P0** | Remove mock data from `InvoicesResource.create()` | This week |
| **P1** | Clarify nano-core location (monorepo vs npm) | Week 1 |
| **P1** | Clarify berrypay-cli role in dual-SDK strategy | Week 1 |
| **P1** | Advance RFCs 0001–0003 to Accepted | Week 1 |
| **P2** | Draft RFC 0007 (RFC Process) — before 0004-0006 | Week 1–2 |
| **P2** | Draft RFC 0004 (SDK Architecture) | Week 2–3 |
| **P2** | Implement real HTTP client in raiflow-sdk | Week 2–3 |
| **P3** | Draft RFC 0005 (nano-core Integration) — transport interface, NOT full client | Week 3–4 |
| **P3** | Draft RFC 0006 (Persistence) — SQLite first | Week 3–4 |
| **P4** | Implement SQLite store adapter | Week 4–6 |
| **P5** | Extract `NanoRpcTransport` interface from nano-core | Week 6+ |
| **P6** | Build nano-core with WorkProvider.auto() | Future |

### Key Changes from Second Review

1. **nano-core location is now P1** (was "medium-term") because SDK has hard dependency
2. **RFC process (0007) precedes RFCs 0004–0006** to prevent further drift
3. **Persistence can proceed in parallel** with SDK work (not sequential)
4. **nano-core migration redefined** as optional transport optimization, not structural requirement

---

## 5. Specific Corrections to Second Review

| Second Review Claim | Correction |
|---------------------|------------|
| "RPC duplication is the #1 architectural debt" | Overstated. Watcher observes, nano-core mutates. Real debt: no transport fallback, no shared contract. |
| "nano-core is early-stage, NOT used by watcher/runtime" | nano-core doesn't exist in the repo. The `file:` link is a forward reference. |
| "Phase 3 first. Developer experience is the current bottleneck." | Phase 3 is blocked by P0 items (broken dependency, type shadowing). |
| "nano-core provides NanoClient with same capabilities plus transport fallback" | nano-core provides significantly more: JIT Profiling, WebGPU/WebGL/WASM/CPU cascade, browser hostility mitigation. Treating it as "just RPC transport" undervalues its role. |
| Missing analysis of berrypay-cli | Document A positions berrypay as "SOTA." Strategic positioning must be clarified. |

---

## 6. Consensus

**All councillors agree:**
- Dual-SDK vision with Symmetric DevEx is architecturally correct
- Implementation is incomplete — SDK has critical bugs, nano-core location is unresolved
- RFC process must be formalized before new RFCs
- berrypay-cli role needs strategic positioning
- The watcher should NOT adopt nano-core's full client — extract a minimal transport interface instead

**Resolved disagreements:**
- **Watcher/nano-core relationship:** Not full adoption. Extract `NanoRpcTransport` interface for optional use.
- **Phase ordering:** P0 fixes first (broken SDK), then RFC formalization, then Phase 3 completion.
- **berrypay-cli:** Clarify role in RFC, don't deprecate prematurely.

---

## Bottom Line

The RaiFlow architecture is strategically sound but implementationally challenged. The dual-SDK vision from the original review must guide all decisions. The second review's findings are real but incomplete.

**Critical path:**
1. **Fix the broken SDK** — dependency, types, mock data
2. **Clarify the ecosystem** — nano-core location, berrypay-cli role
3. **Formalize the process** — RFC lifecycle before new RFCs
4. **Build properly** — real HTTP client after RFC 0004
5. **Decide on integration** — transport interface, not full adoption

**The foundation is solid. The execution must now match the vision.**
