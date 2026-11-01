---- MODULE PaceGate ----
(***************************************************************************)
(* The shared pace gate: NProc DSH processes, one pace.json.               *)
(*                                                                         *)
(* Time units: 1 unit = 1000 ms. `interval` is drawn in units, endpoints    *)
(* of the real [3,15] band only — bounds are the claim, not the histogram. *)
(*                                                                         *)
(* Real code (dsweb/lib/pace.js) modeled here:                            *)
(*   wait(): for(;;){ refresh(); waitMs(); if 0 break; sleep(remaining) }  *)
(*           then note().                                                  *)
(*   refresh() adopts the disk record only when it is newer;              *)
(*   note() writes lastSentAt=now, interval=draw.                          *)
(* fs reads and writes are separate atomic steps in the model, so the      *)
(* read-write window between one process's refresh and its note is what    *)
(* TLC can and will exploit — exactly the window the implementation has.   *)
(*                                                                         *)
(* Abstraction note: adopting an OLDER disk record than in-memory is      *)
(* impossible in the model because `last` only grows (FileMonotonic      *)
(* guarded by the actions). Under that fact, "always read the file now"  *)
(* and "adopt only if newer" coincide.                                    *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Procs
VARIABLES wall, last, interval, phase, dl, sends, draws

NoRecord == -1
SendInterval == {3, 15}
MaxSendsPer == 2    (* test-mode cap: each process sends at most 2 turns; *)
                    (* later turns replay the same pattern                *)

Min(S) == CHOOSE x \in S : \A y \in S : x <= y

Init ==
  /\ wall = 0
  /\ last = NoRecord
  /\ interval = 3
  /\ phase = [p \in Procs |-> "fresh"]
  /\ dl = [p \in Procs |-> 0]
  /\ sends = [p \in Procs |-> <<>>]
  /\ draws = [p \in Procs |-> <<>>]

(* refresh() + waitMs(): one atomic read of the shared file. Gate clear  *)
(* (no record yet, or already waited out) -> "open"; else "sleeping".    *)
Recheck(p) ==
  /\ phase[p] = "fresh"
  /\ IF last = NoRecord \/ wall >= last + interval
       THEN /\ phase' = [phase EXCEPT ![p] = "open"]
            /\ dl' = dl
       ELSE /\ phase' = [phase EXCEPT ![p] = "sleeping"]
            /\ dl' = [dl EXCEPT ![p] = last + interval]
  /\ UNCHANGED <<wall, last, interval, sends, draws>>

SleepDone(p) ==
  /\ phase[p] = "sleeping"
  /\ wall >= dl[p]
  (* the real loop re-enters refresh() after sleep: no direct send here *)
  /\ phase' = [phase EXCEPT ![p] = "fresh"]
  /\ UNCHANGED <<wall, last, interval, dl, sends, draws>>

(* note(): one atomic write.                                             *)
Note(p) ==
  /\ phase[p] = "open"
  /\ Len(sends[p]) < MaxSendsPer
  /\ last' = wall
  /\ interval' \in SendInterval
  /\ sends' = [sends EXCEPT ![p] = Append(@, wall)]
  /\ draws' = [draws EXCEPT ![p] = Append(@, interval')]
  /\ phase' = [phase EXCEPT ![p] = "sent"]
  /\ UNCHANGED <<wall, dl>>

(* a completed turn lets the host decide the next one: wait() starts     *)
(* over with a refresh cycle, the record from this send now on disk.     *)
BeginTurn(p) ==
  /\ phase[p] = "sent"
  /\ Len(sends[p]) < MaxSendsPer   (* spaces the model, not the protocol *)
  /\ phase' = [phase EXCEPT ![p] = "fresh"]
  /\ UNCHANGED <<wall, last, interval, dl, sends, draws>>

(* wall jumps only to the earliest wake of a sleeping process.           *)
Tock ==
  /\ \E p \in Procs : phase[p] = "sleeping" /\ dl[p] > wall
  /\ wall' = Min({dl[p] : p \in {p \in Procs : phase[p] = "sleeping" /\ dl[p] > wall}})
  /\ UNCHANGED <<last, interval, phase, dl, sends, draws>>

Next ==
  \/ \E p \in Procs : Recheck(p) \/ Note(p) \/ SleepDone(p) \/ BeginTurn(p)
  \/ Tock

Spec == Init /\ [][Next]_<<wall, last, interval, phase, dl, sends, draws>>

(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypesOK ==
  /\ wall \in Nat
  /\ last \in {NoRecord} \cup Nat
  /\ interval \in SendInterval
  /\ \A p \in Procs : phase[p] \in {"fresh", "sleeping", "open", "sent"}

(* mirror of the code's write bound: interval of a note is in range      *)
IntervalValid == interval \in SendInterval

(* one process: consecutive sends are spaced by the interval it drew.    *)
(* Single-proc only: the shared record means another process's fresh note *)
(* can lawfully open this process's gate earlier than its own draw owed   *)
(* (the disk holds ONE pair), so under two processes this is not a claim. *)
GapSingle ==
  \A p \in Procs :
    \A i \in 1..Len(sends[p]) - 1 :
      sends[p][i + 1] - sends[p][i] >= draws[p][i]

(* paired with the two-process config this is EXPECTED to be violated:   *)
(* two fresh boots both pass the gate at wall 0 (first turns are         *)
(* immediate), and two post-crash wakes can both refresh a stale record  *)
(* before either notes. The trace is the report; TLC stops at the first  *)
(* violating step, which is the trace we want to read.                   *)
DistinctSlots ==
  \A p1 \in Procs : \A p2 \in Procs :
    \A s1 \in 1..Len(sends[p1]) : \A s2 \in 1..Len(sends[p2]) :
      (p1 # p2) => sends[p1][s1] # sends[p2][s2]
====
