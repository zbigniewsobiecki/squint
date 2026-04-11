# Squint Evaluation Harness

End-to-end evaluation of the squint ingestion pipeline against hand-authored ground truth.

## How it works

1. **Fixture**: a small, real, runnable TypeScript repo at `evals/fixtures/<name>/`
2. **Ground truth**: typed declarative records at `evals/ground-truth/<name>/` describing what squint *should* produce
3. **Harness**: shared code at `evals/harness/` that builds, runs, compares, and reports
4. **Eval test**: `evals/<name>.eval.ts` — a Vitest test that wires it all together
5. **Baseline**: a committed scoreboard at `evals/baselines/<name>.json` tracking progress per stage

## Running

```bash
# Run all evals (costs LLM credits!)
npm run eval

# Run a specific eval
npm run eval -- todo-api.eval.ts

# Run a specific stage's tests within an eval
npm run eval -- todo-api.eval.ts -t "parse stage"

# Watch mode for harness development
npm run eval:watch
```

## Cost guardrails

- All LLM calls are scoped per-stage via `--from-stage`/`--to-stage` — never the full pipeline accidentally
- Per-run cost budget enforced via `EVAL_COST_BUDGET_USD` (default `0.50`)
- Prose-judge results cached at `evals/results/.judge-cache.json` (gitignored)

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `EVAL_JUDGE_MODEL` | `openrouter:anthropic/claude-haiku-4` | LLM used to score prose similarity |
| `EVAL_COST_BUDGET_USD` | `0.50` | Hard fail if a single run exceeds this |
| `EVAL_RUNS_PER_STAGE` | `1` | Re-run LLM stages N times to detect non-determinism |
| `EVAL_KEEP_ALL` | unset | Keep all historical results instead of rotating |

## Iteration plan

The harness is built up one pipeline stage at a time. Each iteration adds exactly one
LLM stage on top of a known-passing base, so when iteration N fails the bug is in stage N.

See `/home/zbigniew/.claude/plans/validated-sprouting-mochi.md` for the full plan.

| Iter | Stages | Cost/run |
|---|---|---|
| 1 | parse | $0 |
| 2 | + symbols | ~$0.05 |
| 3 | + relationships | ~$0.10 |
| 4 | + modules | ~$0.15 |
| 5 | + contracts | ~$0.20 |
| 6 | + interactions | ~$0.25 |
| 7 | + flows | ~$0.30 |
| 8 | + features | ~$0.35 |
