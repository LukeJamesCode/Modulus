# modulus-abilitytest

Scripted ability tests for the Modulus agent pipeline, run with `modulus abilitytest`.

Each test boots a throwaway in-process orchestrator (temp SQLite, a scripted FakeLLM, its
own tool set — no Telegram, no Ollama, no network), drives a user message through the **real**
dispatch loop, and scores what the pipeline did against an expectation: which tool it
dispatched, whether it escalated to the operator agent, and what the final reply said.

Because the model is a deterministic `FakeLLM`, the run is reproducible and fast, so it runs
in CI as a regression gate: a change to the tool-dispatch loop, escalation routing, or the
reply path that breaks the pipeline flips an ability test to fail.

## Usage

```sh
modulus abilitytest                 # standard tier
modulus abilitytest --tier smoke    # the fast subset (also what CI runs)
modulus abilitytest --tier full     # every catalog entry
modulus abilitytest --filter delegate   # only tests whose id/ability matches
modulus abilitytest --out report.md     # where to write the markdown report
modulus abilitytest --fails         # re-run only what failed in the last report
```

Tiers are cumulative: `smoke ⊆ standard ⊆ full`. The report is written to
`~/.modulus/ability-test-<timestamp>.md`; `--fails` re-reads the latest one and re-runs only
the rows that failed or errored.

## The catalog

Each entry in `catalog.ts` is self-contained — a message, the tools available that turn, a
round-by-round model script (`{ tool }` or `{ text }`), and an expectation
(`toolsInvoked` / `toolsNotInvoked` / `replyIncludes`). It covers four dimensions:

- **tool-selection** — the model picks a tool and the pipeline dispatches it.
- **delegation** — long-horizon work routes to `escalate_to_agent`; a trivial question does not.
- **e2e** — a real task runs a tool and the reply confirms the result.
- **chat** — plain conversation, no tool fires.

To add a test, append to `CATALOG`; `catalog.test.ts` enforces the invariants (unique id,
script ends in text, expectations reference declared tools).

## Scope

This is the **deterministic subset**. It validates pipeline *wiring* — "when the model emits
tool call X, the orchestrator runs X and returns the right end-state" — not the small model's
live judgement. The live scorecard (real Ollama on the Pi profile vs. Power Mode, measuring
whether the actual model selects/delegates correctly) is the planned follow-on; it reuses this
catalog's expectations against a real `LLM` instead of the FakeLLM.
