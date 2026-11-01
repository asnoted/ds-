# verification/

Self-invented protocol logic checked by a model checker and a proof assistant,
plus the run tooling. All tools are bootstrapped into `.cache/` (gitignored);
nothing is installed on the host and no node dependency is added.

## What is here

| file | models | checks |
|---|---|---|
| `tla/PaceGate.tla` | `dsweb/lib/pace.js` — two DSH hosts sharing the one `pace.json` gate (`refresh()` adopts the newest record, `note()` writes one — modeled as an atomic read/write pair per process) | gate spacing per process; the same-instant race two hosts can hit |
| `tla/SessionMap.tla` | `dsweb/lib/web-model.js:495-664` + `dsweb/lib/session-map.js` — one process's turn: pending → (rebuild: create+bind) → send → commit, with explicit crash-and-restart over the send/commit split windows, and the forget path for a failed fresh turn | the digest net's contracts against the shipped and the fixed binding; the at-least-once window the shortcut comment documents |
| `tla/*.cfg` | TLC configs | green = invariants that must hold; red = monitors expected to be violated, whose printed trace documents the finding |
| `dafny/DeepSeekHashV1.dfy` | `dsweb/lib/pow.js` `keccakF23`/`absorbBlock`/`deepseekHashV1` — bit-only mechanical port (lanes are the same `bv32` half-pairs, `~x` is `x ^ 0xFFFFFFFF`, the one 64-bit rotation is `Rot64`, the rho+pi table is the JS comment table verbatim) | structural proofs only: shape contracts, index/amount bounds, table well-formedness, pad placement; equivalence with the JS is the differential runner's job, not a dafny theorem |

Abstractions are declared in each module's header: digest equality instead of
the hash, protocol-constant, setParent out of the prefix logic, cross-process
map writers out of the one-process model.

## Run

```sh
node scripts/verify-tla.mjs     # five TLC configs
node scripts/verify-dafny.mjs   # verify + build the twin, then differential-test it against pow.js
```

`verify-tla.mjs` bootstraps a JDK and `tla2tools.jar` under `.cache/` on first
run, then runs the five configs and exits 0 only when green configurations hold
and red configurations violate as expected. Red-run state traces print on
stdout.

`verify-dafny.mjs` verifies and builds the `.dfy` via Dafny's Java backend
(C# needs a dotnet SDK, the JS backend output needs the npm module
bignumber.js; the JDK is already in `.cache` and `DafnyRuntime.jar` ships
inside the Dafny zip), then runs the jar over the official empty-string
vector plus boundary and seeded-random inputs and compares every digest with
`deepseekHashV1Hex` from `pow.js`.

tla2tools note: v1.7.4 runs fine on aarch64 as long as a module is
standard-shaped (`---- MODULE name ----` header and a trailing `====`
footer). A bare `MODULE` head drives the parser into an error-recovery NPE —
the repro file in tlaplus#1392 is bare-headed too, which is what made it look
like an architecture bug.

## Results

All five config verdicts as of the current commit; the monitor traces quoted
here hold in the run output (_state database removed; rerun to replay_).

| run | verdict | facts |
|---|---|---|
| `PaceGate-green` | no error | 18 states, depth 9 — one host's gate spacing holds under the own-write model |
| `PaceGate-slot` | `DistinctSlots` violated | 31 generated / 28 distinct, depth 5 — the trace is the same-instant two-fresh-boots race both hosts keep the first slot (documented provider-side race, paced out in practice) |
| `SessionMap-fix` | no error | 8226 generated / 1339 distinct, depth 21 — `TypesOK`, `KeyClaim`, `PlainContinueSend` hold with bind storing the bind-time log and cursor 0, under mid-turn reword-off and explicit crash windows |
| `SessionMap-bug` | `PlainContinueSend` violated | 680 generated / 227 distinct, depth 8 — bind→send→crash leaves the disk entry `{cursor 0, digest([])}`; a reworded log then passes pending as "same as at bind" and the whole new log arrives as a delta on a generation already holding the old prompt's send (the shipped finding the bind fix removes) |
| `SessionMap-dup` | `NeverDup` violated | 135 generated / 51 distinct, depth 6 — crash between a continue-send and its commit re-delivers the same delta after restart (the at-least-once shortcut at `session-map.js:153`; an upstream turn id would close it; not claimed fixed) |

The Dafny twin verifies with 14 obligations and 0 errors, and the differential
runner reports 60/60 digests equal to `pow.js`, including the official
empty-string vector
`e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3`.
