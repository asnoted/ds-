---- MODULE SessionMap ----
(***************************************************************************)
(* The session map's commit/pending protocol, one DSH process.             *)
(*                                                                         *)
(* Model of the turn in lib/web-model.js:495-664 against                   *)
(* session-map.js: pending decision -> (rebuild: create+bind) -> send ->   *)
(* commit; plus the forget path for a fresh session that produced nothing. *)
(* The send and the commit are separate steps — exactly the crash window   *)
(* the shortcut comment at session-map.js:153 documents. The in-flight     *)
(* lock serializes one process's turns, so the only interleaving inside a  *)
(* turn is Reword (a user edit between steps).                             *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - digest() is collision-free, so a stored digest is modeled as the     *)
(*    stored sequence plus its length; the pending match is plain prefix   *)
(*    equality against the current log.                                    *)
(*  - FixOn = 0 is the shipped code: bind stores digest([]) and cursor 0,  *)
(*    which the empty prefix makes match ANY rewritten log.                *)
(*    FixOn = 1 is the candidate fix: bind stores digest(messages), i.e.   *)
(*    the bind-time log, so a log rewritten during the crash window can no *)
(*    longer pose as "same as at bind".                                    *)
(*  - protocol is constant here; the version-mismatch rebuild is pinned by *)
(*    the invariant suite against the real file instead.                   *)
(*  - setParent (the web-tip drift check, the other shortcut) does not      *)
(*    participate in the prefix logic and is out of this model.            *)
(*  - Cross-process: two hosts sharing the file are whole-copy writers, so *)
(*    one host's save() erases the other's entries; every such loss lands  *)
(*    on rebuild=true and a fresh web session. That case is out of this    *)
(*    one-process model by design.                                         *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS Msgs, FixOn

VARIABLES
  log,            \* the DSH message log the next step replays
  rounds,         \* turns started so far (bounds the state space)
  bound,          \* a web session is bound
  gen,            \* generation counter: one bind = one web session
  claimC,         \* how many log messages the map claims the web saw
  claimSeq,       \* the sequence bound to that claim (equality oracle)
  webSeq,         \* what the CURRENT generation's web session received
  sentTo,         \* highest log index ever delivered to this generation
  dupSeen,        \* monitor: a delta redelivered to the same generation
  turnSent,       \* this turn's completion request already went out
  turnSeq,        \* the message array captured at this turn's pending()
  turnRebuild,    \* the decision pending() made for this turn
  turnGen,        \* the generation this turn sends into
  lastSendSeq,    \* the payload of the most recent completed send
  lastSendCont,   \* ...and whether it was a continue-send (delta)
  lastSendGen     \* ...and the generation it went into (0 = none yet)

\* Two messages keep the state space small; more adds states, not insight.
LogSpace == UNION { [1..i -> Msgs] : i \in 0..2 }
MaxRounds == 4
MaxGens == 2

Max(x, y) == IF x >= y THEN x ELSE y

(* pending()'s match, as an equality oracle:
 * cursor within the log, and the stored digest is the digest of the prefix. *)
MatchLog(seq, cursor, storedSeq) ==
  /\ cursor <= Len(seq)
  /\ SubSeq(seq, 1, cursor) = storedSeq

PrefixUpToSeqSafe(showing, kept) ==
  /\ Len(kept) <= Len(showing)
  /\ SubSeq(showing, 1, Len(kept)) = kept

SubSeqOf(sub, super) ==
  Len(sub) = 0
  \/ \E f \in [1..Len(sub) -> 1..Len(super)] :
    /\ \A i \in 1..Len(sub) : super[f[i]] = sub[i]
    /\ \A i \in 1..Len(sub) : \A j \in 1..Len(sub) : i < j => f[i] < f[j]

Init ==
  /\ log = <<>>
  /\ rounds = 0
  /\ bound = FALSE
  /\ gen = 0
  /\ claimC = 0
  /\ claimSeq = <<>>
  /\ webSeq = <<>>
  /\ sentTo = 0
  /\ dupSeen = FALSE
  /\ turnSent = FALSE
  /\ turnSeq = <<>>
  /\ turnRebuild = FALSE
  /\ turnGen = 0
  /\ lastSendSeq = <<>>
  /\ lastSendCont = FALSE
  /\ lastSendGen = 0

(***************************************************************************)
(* Reword: compaction or an edit replaces the log outright. Possible only  *)
(* in the between-turn gaps: while a turn runs it holds the in-flight      *)
(* lock (web-model.js:497) from pending through commit, and the DSH log    *)
(* is this one process's own, so nothing rewrites it under a live turn.    *)
(***************************************************************************)
Reword ==
  /\ turnSeq = <<>>    \* no turn captured, none in flight
  /\ log' \in LogSpace
  /\ UNCHANGED <<rounds, bound, gen, claimC, claimSeq, webSeq, sentTo, dupSeen,
                 turnSent, turnSeq, turnRebuild, turnGen, lastSendSeq, lastSendCont,
                 lastSendGen>>

(***************************************************************************)
(* TurnStart: pending() runs against the disk entry. A rebuild with an     *)
(* empty log is no turn at all (the real code returns before creating:     *)
(* promptFor of an empty fresh is empty). Same for a continue with an      *)
(* empty delta (the real code finishes early — its prompt is empty).       *)
(***************************************************************************)
TurnStartRebuild ==
  /\ rounds < MaxRounds
  /\ gen < MaxGens
  /\ log # <<>>
  /\ \/ ~bound
     \/ ~MatchLog(log, claimC, claimSeq)
  /\ \/ turnSeq = <<>>    \* no turn in flight
     \/ turnSent          \* the previous turn completed its send step
  /\ /\ turnSeq' = log
     /\ turnRebuild' = TRUE
     /\ turnGen' = gen + 1
     /\ bound' = TRUE
     /\ gen' = gen + 1
     /\ claimC' = 0
     /\ claimSeq' = IF FixOn = 1 THEN log ELSE <<>>
     /\ webSeq' = <<>>
     /\ sentTo' = 0
     /\ dupSeen' = dupSeen
     /\ turnSent' = FALSE
     /\ lastSendSeq' = lastSendSeq
     /\ lastSendCont' = lastSendCont
     /\ lastSendGen' = lastSendGen
     /\ rounds' = rounds + 1
  /\ UNCHANGED <<log>>

TurnStartContinue ==
  /\ rounds < MaxRounds
  /\ bound
  /\ MatchLog(log, claimC, claimSeq)
  /\ claimC < Len(log)
  /\ \* no in-flight turn may be abandoned silently
     \/ turnSeq = <<>>
     \/ turnSent
  /\ /\ turnSeq' = log
     /\ turnRebuild' = FALSE
     /\ turnGen' = gen
     /\ turnSent' = FALSE
     /\ dupSeen' = dupSeen
     /\ lastSendSeq' = lastSendSeq
     /\ lastSendCont' = lastSendCont
     /\ lastSendGen' = lastSendGen
     /\ rounds' = rounds + 1
  /\ UNCHANGED <<log, bound, gen, claimC, claimSeq, webSeq, sentTo>>

(***************************************************************************)
(* TurnSend: the completion request leaves. A rebuild is the full prompt   *)
(* into the fresh session; a continue is the delta after the claimed       *)
(* prefix onto the existing session.                                       *)
(***************************************************************************)
TurnSendRebuild ==
  /\ turnSeq # <<>>
  /\ turnRebuild
  /\ ~turnSent
  /\ turnGen = gen
  /\ /\ turnSent' = TRUE
     /\ webSeq' = turnSeq
     /\ sentTo' = Len(turnSeq)
     /\ lastSendSeq' = turnSeq
     /\ lastSendCont' = FALSE
     /\ lastSendGen' = turnGen
  /\ UNCHANGED <<log, rounds, bound, gen, claimC, claimSeq, dupSeen,
                 turnSeq, turnRebuild, turnGen>>

TurnSendContinue ==
  /\ turnSeq # <<>>
  /\ ~turnRebuild
  /\ ~turnSent
  /\ MatchLog(turnSeq, claimC, claimSeq)        \* decision still holds
  /\ claimC < Len(turnSeq)                      \* nonempty delta
  /\ /\ turnSent' = TRUE
     /\ webSeq' = webSeq \o SubSeq(turnSeq, claimC + 1, Len(turnSeq))
     /\ sentTo' = Max(sentTo, Len(turnSeq))
     /\ lastSendSeq' = turnSeq
     /\ lastSendCont' = TRUE
     /\ lastSendGen' = turnGen
     /\ \* overlap monitor: newFrom = claimC + 1 <= sentTo means the delta's
        \* head was already delivered - content redelivered, at-least-once
        dupSeen' = (dupSeen \/ (claimC < sentTo))
  /\ UNCHANGED <<log, rounds, bound, gen, claimC, claimSeq,
                 turnSeq, turnRebuild, turnGen>>

TurnCommit ==
  /\ turnSent
  /\ claimC' = Len(turnSeq)
  /\ claimSeq' = turnSeq
  /\ UNCHANGED <<log, rounds, bound, gen, webSeq, sentTo, dupSeen,
                 turnSent, turnSeq, turnRebuild, turnGen,
                 lastSendSeq, lastSendCont, lastSendGen>>

(***************************************************************************)
(* A brand-new session that produced nothing is forgotten (the catch in    *)
(* web-model.js:656-661). Only before the send: once anything streamed the *)
(* branch is kept — post-send aborts simply never commit, which the model  *)
(* reaches by not taking TurnCommit.                                       *)
(***************************************************************************)
TurnAbortFresh ==
  /\ turnRebuild
  /\ ~turnSent
  /\ turnSeq # <<>>
  /\ /\ bound' = FALSE
     /\ claimC' = 0
     /\ claimSeq' = <<>>
     /\ turnRebuild' = FALSE
     /\ turnSeq' = <<>>
     /\ turnGen' = 0
     /\ turnSent' = FALSE
  /\ UNCHANGED <<log, rounds, gen, webSeq, sentTo, dupSeen, lastSendSeq, lastSendCont,
                 lastSendGen>>

(***************************************************************************)
(* Crash: the host dies after the completion request went out, before     *)
(* commit. The restarted process remembers nothing in flight - the lock   *)
(* dies with it - while the disk entry keeps bind's shape (FixOn=0:       *)
(* {cursor 0, digest([])} which any rewritten log still matches; FixOn=1: *)
(* {cursor 0, digest(bind log)} which only the bind log matches) and      *)
(* webSeq keeps what already reached the session. Unsent turns restart    *)
(* through the real catches instead: TurnAbortFresh for a fresh that      *)
(* produced nothing, and an unsent continue leaves nothing durable        *)
(* behind, so the model skips it.                                         *)
(***************************************************************************)
Crash ==
  /\ turnSent
  /\ /\ turnSeq' = <<>>
     /\ turnSent' = FALSE
     /\ turnRebuild' = FALSE
     /\ turnGen' = 0
  /\ UNCHANGED <<log, rounds, bound, gen, claimC, claimSeq, webSeq, sentTo, dupSeen,
                 lastSendSeq, lastSendCont, lastSendGen>>

Next ==
  \/ Reword
  \/ TurnStartRebuild
  \/ TurnStartContinue
  \/ TurnSendRebuild
  \/ TurnSendContinue
  \/ TurnCommit
  \/ TurnAbortFresh
  \/ Crash

Spec ==
  Init /\ [][Next]_<<log, rounds, bound, gen, claimC, claimSeq, webSeq, sentTo,
                      dupSeen, turnSent, turnSeq, turnRebuild, turnGen,
                      lastSendSeq, lastSendCont, lastSendGen>>

(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypesOK ==
  /\ log \in LogSpace
  /\ turnSeq \in LogSpace
  /\ rounds \in 0..MaxRounds
  /\ gen \in 0..MaxGens
  /\ turnGen \in 0..MaxGens
  /\ claimC \in 0..2
  /\ sentTo \in 0..2
  /\ bound \in BOOLEAN
  /\ turnRebuild \in BOOLEAN
  /\ turnSent \in BOOLEAN
  /\ dupSeen \in BOOLEAN
  /\ lastSendCont \in BOOLEAN
  /\ lastSendGen \in 0..MaxGens
  /\ (Len(claimSeq) = claimC) \/ (FixOn = 1 /\ claimC = 0)
  /\ Len(lastSendSeq) <= 2

(* The map's claim binds only once committed: whenever the entry asserts  *)
(* "web saw claimSeq" (the cursor counts the whole stored sequence), that *)
(* sequence really is inside what this generation received. At bind time  *)
(* the fix stores the bind log with cursor 0 - a promise, not yet a claim.*)
KeyClaim == (claimC # Len(claimSeq)) \/ SubSeqOf(claimSeq, webSeq)

(* Every continue-send either restarts from a COMMITTED cursor (claimC>0:  *)
(* the at-least-once window between commits, where content drift and      *)
(* redelivery are the documented shortcut at session-map.js:153, not a    *)
(* bind bug), or - bind window, claimC=0 - lands on a session whose       *)
(* received content STARTS with the send's exact payload. The bind fix    *)
(* makes the claimC=0 case honest: matching requires the bind log itself, *)
(* so a rewritten log can only reach a rebuild, never this delta.         *)
PlainContinueSend ==
  \/ claimC > 0
  \/ lastSendGen # gen
  \/ ~lastSendCont
  \/ PrefixUpToSeqSafe(webSeq, lastSendSeq)

(* Monitor for the SHORTCUT at session-map.js:153: a message delivered     *)
(* twice to one generation. Expected-violated in monitor configs.          *)
NeverDup == ~dupSeen
====
