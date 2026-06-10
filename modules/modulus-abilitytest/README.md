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
modulus abilitytest --live          # score the catalog against the REAL model(s)
```

Tiers are cumulative: `smoke ⊆ standard ⊆ full`. The report is written to
`~/.modulus/ability-test-<timestamp>.md`; `--fails` re-reads the latest one and re-runs only
the rows that failed or errored.

## Live scorecard (`--live`)

`--fails` and the default run use the deterministic `FakeLLM`. `--live` instead drives the
**real** configured model(s) through the same catalog — so it measures the small model's
actual tool-selection and delegation judgement, not just pipeline wiring. It builds up to two
profiles from your config: `local:<chat model>` (the Ollama small model, the Pi profile) and,
when an OpenAI-compatible endpoint is configured in `modulus-openai`, `power:<alias:model>`
(Power Mode). The catalog's per-round `script` is ignored in this mode — the real model
decides.

A live run touches the real `~/.modulus/modulus.db`, so it **refuses if a daemon is running**
(`modulus stop` first) to avoid contending over the SQLite writer and the heavy-model slot. It
needs Ollama up, is operator-run, and never runs in CI. Output goes to
`~/.modulus/ability-live-<timestamp>.md` (a distinct prefix so `--fails` never picks a live
scorecard up as the last failure set) and leads with a **scorecard**: per-dimension pass rates
with one column per profile, so the Pi profile and Power Mode sit side by side.

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

The default run is the **deterministic subset**. It validates pipeline *wiring* — "when the
model emits tool call X, the orchestrator runs X and returns the right end-state" — not the
small model's live judgement, and that is what runs in CI. To measure whether the actual model
selects/delegates correctly, use `--live` (above): it reuses this same catalog's expectations
against a real `LLM` instead of the FakeLLM.
