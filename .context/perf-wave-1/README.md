# Performance wave 1 — bounded, fork-only

Base: `467ff6737f741375a9a78eafd2818634d908eb99`. AI-assisted investigation. No automatic upstream posts or production branch modifications.

## Work and acceptance

| Lane | Candidate | Gate |
| --- | --- | --- |
| Correctness #5451 | Existing first-whitespace offset fix, credit goodguyben | Repeat 1 pass/4 fail -> 5 pass/0 fail on this base; adjacent managed/unmanaged tests; verify and unit runner |
| Quote allocation | Use the existing mapless folding core for query text; keep the transcript offset map | Differential outputs across 512 generated cases; Unicode/near/oversize controls; native adjacent tests; alternating measurements |
| Numeric telemetry | Iterate regex matches lazily instead of collecting the whole match array | Same first-200-unique claims, masking, order and warnings; dense and duplicate-heavy controls |
| Combined | Both performance edits only | Repeat semantic and timing probes to catch interactions; do not combine with the correctness fix yet |

The numeric change does not make the whole operation bounded to 200 matches: masking scans the body and duplicates can require a full scan. The quote change is not a global cache and never removes the transcript's source map.

## Decision questions (drafts, not upstream comments)

1. Would reusing `normForGrounding` for the query side be preferable to maintaining an unused offset array, provided the existing transcript map and all returned repair spans stay identical?
2. Is the numeric telemetry contract specifically the first 200 distinct normalized claims? The experiment preserves that behavior, including duplicate-heavy scans, rather than silently sampling only the first 200 matches.
3. Before increasing synthesis concurrency, should the gate require unchanged interactive latency, source-scoped writer ownership, cancellation and shared provider budgets? The existing inline drain intentionally forces PGLite serial; this wave does not change that.

## Process

Explore alternatives -> challenge semantic/ownership assumptions -> differential native checks -> ABBA measurements -> inspect controls -> focused upstream question/patch. Each matrix candidate runs in its own checkout; failures do not cancel siblings. There is no speedup claim until raw measurements are inspected, and microbenchmarks cannot establish an end-to-end win. Keep unsuccessful approaches and confounders in the evidence.

References: `src/core/cycle/synthesize-verify.ts`, `docs/architecture/key-files/core-cycle.md`, `CONTRIBUTING.md`, https://bun.sh/docs/project/benchmarking .
