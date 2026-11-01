/**
 * DeepSeekHashV1 — Dafny twin of the port in dsweb/lib/pow.js.
 *
 * Bit-only mechanical port: every lane of Keccak-f[1600] is the same (lo, hi)
 * pair of 32-bit halves the JS keeps in two Uint32Arrays, so `~x` (a 32-bit
 * complement in JS) is `x ^ 0xFFFFFFFF` here and every shift, xor, and, or
 * happens on `bv32`, where wraparound is the type's own semantics — the port
 * invents no arithmetic the JS does not perform. Rotation is the one 64-bit
 * primitive (`Rot64`), mirroring the JS's fused `((x << k) | (y >>> (32-k)))`
 * with the half exchange when k >= 32; the destination-indexed rho+pi table
 * carries the values of the comment table at pow.js:105-110 verbatim.
 *
 * What the verifier proves is structural, not algebraic: shape contracts on
 * every method, bounds on every helper (rotation amounts < 64, lane indexes
 * < 25, block offset + rate <= input length), the well-formedness of the
 * rho+pi table itself, and that the pad byte and the 0x80 bit always land
 * inside the 136-byte final block. Equivalence with the source of truth is
 * established by the differential runner `scripts/verify-dafny.mjs` (the
 * official empty-string vector plus seeded random inputs) — this file's
 * specification IS the JS file, byte for bit.
 *
 * Build/run (the C# backend needs a dotnet SDK and the JS backend needs the
 * npm module bignumber.js, so the Java backend it is; its runtime jar ships
 * inside the Dafny distribution and the JDK lives in .cache):
 *   .cache/dafny/dafny/dafny build -t java verification/dafny/DeepSeekHashV1.dfy \
 *     -o .cache/dafnyout/DeepSeekHashV1
 *   java -jar .cache/dafnyout/DeepSeekHashV1.jar <hex input>
 */

const RATE: nat := 136

/* Shift amounts and masks (bv32, hoisted to consts: Dafny's statement-level
   if-conditions reject inline casts, and named constants read better anyway). */
const K0: bv32 := 0
const K1: bv32 := 1
const K8: bv32 := 8
const K16: bv32 := 16
const K24: bv32 := 24
const K32: bv32 := 32
const K64: bv32 := 64
const MASK8: bv32 := 0xFF
const NOT32: bv32 := 0xFFFFFFFF
const SH8: seq<bv32> := [0, 8, 16, 24]

/* Byte-level padding constants and the hex alphabet for the CLI face. */
const PAD6: bv8 := 0x06
const PAD80: bv8 := 0x80
const ZERO8: bv8 := 0
const HEXDIGITS: string := "0123456789abcdef"

/* Iota round constants, split into halves, indexed by round number.
   Round 0 is skipped entirely, so RC[0] is never applied — it is kept so the
   index still means "round r", exactly like the JS's arrays. */
const RC_LO: seq<bv32> := [
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008
]
const RC_HI: seq<bv32> := [
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000
]

/* rho + pi, destination-indexed: lane DSTS[i] receives rotl64(lane SRC[i],
   ROT[i]). The values are pow.js's comment table at 105-110, one entry per
   lane, in destination order. */
const DSTS: seq<nat> := [
  0, 1, 2, 3, 4,
  5, 6, 7, 8, 9,
  10, 11, 12, 13, 14,
  15, 16, 17, 18, 19,
  20, 21, 22, 23, 24
]
const SRCS: seq<nat> := [
  0, 6, 12, 18, 24,
  3, 9, 10, 16, 22,
  1, 7, 13, 19, 20,
  4, 5, 11, 17, 23,
  2, 8, 14, 15, 21
]
const ROT: seq<bv32> := [
  0, 44, 43, 21, 14,
  28, 20, 3, 45, 61,
  1, 6, 25, 8, 18,
  27, 36, 10, 15, 56,
  62, 55, 39, 41, 2
]
const ZERO25: seq<bv32> := [
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0
]

/* The facts every rotating loop leans on: table shapes and bounds. */
lemma TableWellFormed()
  ensures |DSTS| == 25 && |SRCS| == 25 && |ROT| == 25 && |ZERO25| == 25
  ensures forall i :: 0 <= i < 25 ==>
            0 <= DSTS[i] < 25 && 0 <= SRCS[i] < 25 && ROT[i] < K64
  ensures |RC_LO| == 24 && |RC_HI| == 24 && |SH8| == 4
  ensures forall i :: 0 <= i < 4 ==> SH8[i] < K32
{
}

/* rotl64 across a half-pair — the complete left-rotation the JS spells as its
   fused shift-or expressions, with half exchange for k >= 32. */
function Rot64(lo: bv32, hi: bv32, k: bv32): (bv32, bv32)
  requires k < K64
{
  if k == K0 then (lo, hi)
  else if k < K32 then
    ((lo << k) | (hi >> (K32 - k)), (hi << k) | (lo >> (K32 - k)))
  else if k == K32 then
    (hi, lo)
  else
    var s := k - K32;
    var r := K64 - k;
    ((hi << s) | (lo >> r), (lo << s) | (hi >> r))
}

/* One permutation restricted to rounds 1..23 — the twin of keccakF23. The
   theta wiring, the rho+pi table application, and the chi rows follow the
   same order the JS lists them in. */
method KeccakF23(stateLo: seq<bv32>, stateHi: seq<bv32>) returns (lo: seq<bv32>, hi: seq<bv32>)
  requires |stateLo| == 25 && |stateHi| == 25
  ensures |lo| == 25 && |hi| == 25
{
  var L := stateLo;
  var H := stateHi;
  TableWellFormed();
  var r := 1;
  while r < 24
    invariant 1 <= r <= 24
    invariant |L| == 25 && |H| == 25
    decreases 24 - r
  {
    /* theta: column parities c_j = a_j ^ a_(j+5) ^ ... ^ a_(j+20) */
    var cL: seq<bv32> := [];
    var cH: seq<bv32> := [];
    for i := 0 to 5
      invariant |cL| == i && |cH| == i
    {
      cL := cL + [L[i] ^ L[i + 5] ^ L[i + 10] ^ L[i + 15] ^ L[i + 20]];
      cH := cH + [H[i] ^ H[i + 5] ^ H[i + 10] ^ H[i + 15] ^ H[i + 20]];
    }
    /* d_j = c_(j+4 mod 5) ^ rotl64(c_(j+1 mod 5), 1) */
    var dL: seq<bv32> := [];
    var dH: seq<bv32> := [];
    for j := 0 to 5
      invariant |dL| == j && |dH| == j
    {
      var (pl, ph) := Rot64(cL[(j + 1) % 5], cH[(j + 1) % 5], K1);
      dL := dL + [cL[(j + 4) % 5] ^ pl];
      dH := dH + [cH[(j + 4) % 5] ^ ph];
    }
    /* spread d_j over the lanes r*5 + j */
    for i := 0 to 25
      invariant |L| == 25 && |H| == 25
    {
      var j := i % 5;
      L := L[i := L[i] ^ dL[j]];
      H := H[i := H[i] ^ dH[j]];
    }
    /* rho + pi into the destination-indexed b temporaries, chi's input */
    var bL := ZERO25;
    var bH := ZERO25;
    for i := 0 to 25
      invariant |bL| == 25 && |bH| == 25
    {
      var dst := DSTS[i];
      var src := SRCS[i];
      var rot := ROT[i];
      var (nl, nh) := Rot64(L[src], H[src], rot);
      bL := bL[dst := nl];
      bH := bH[dst := nh];
    }
    /* chi within each row of five */
    var newL: seq<bv32> := [];
    var newH: seq<bv32> := [];
    for i := 0 to 25
      invariant |newL| == i && |newH| == i
    {
      var row := (i / 5) * 5;
      var col := i % 5;
      newL := newL + [bL[i] ^ ((bL[row + ((col + 1) % 5)] ^ NOT32) & bL[row + ((col + 2) % 5)])];
      newH := newH + [bH[i] ^ ((bH[row + ((col + 1) % 5)] ^ NOT32) & bH[row + ((col + 2) % 5)])];
    }
    L := newL;
    H := newH;
    /* iota: round constant on lane 0 only */
    L := L[0 := L[0] ^ RC_LO[r]];
    H := H[0 := H[0] ^ RC_HI[r]];
    r := r + 1;
  }
  lo := L;
  hi := H;
}

/* Little-endian 32-bit read of four bytes (the JS's absorb cells). */
function LE32(bytes: seq<bv8>, p: nat): bv32
  requires p + 4 <= |bytes|
{
  (bytes[p] as bv32)
  | ((bytes[p + 1] as bv32) << K8)
  | ((bytes[p + 2] as bv32) << K16)
  | ((bytes[p + 3] as bv32) << K24)
}

/* XOR 136 bytes starting at `off` into the state's rate lanes, in place. */
method AbsorbBlock(stateLo: seq<bv32>, stateHi: seq<bv32>, bytes: seq<bv8>, off: nat)
  returns (lo: seq<bv32>, hi: seq<bv32>)
  requires |stateLo| == 25 && |stateHi| == 25
  requires off + RATE <= |bytes|
  ensures |lo| == 25 && |hi| == 25
{
  var L := stateLo;
  var H := stateHi;
  for i := 0 to 17
    invariant |L| == 25 && |H| == 25
    invariant off + i * 8 <= |bytes|
  {
    var p := off + i * 8;
    L := L[i := L[i] ^ LE32(bytes, p)];
    H := H[i := H[i] ^ LE32(bytes, p + 4)];
  }
  lo := L;
  hi := H;
}

/* The digest of `data` — the twin of deepseekHashV1. Callers get the 32 bytes
   of the four low lanes, little-endian, exactly like the JS's out array. */
method DeepSeekHashV1(data: seq<bv8>) returns (digest: seq<bv8>)
  ensures |digest| == 32
{
  TableWellFormed();
  var L := ZERO25;
  var H := ZERO25;
  var off: nat := 0;
  while off + RATE <= |data|
    invariant off <= |data|
    invariant |L| == 25 && |H| == 25
    decreases |data| - off
  {
    var l1, h1 := AbsorbBlock(L, H, data, off);
    var l2, h2 := KeccakF23(l1, h1);
    L := l2;
    H := h2;
    off := off + RATE;
  }
  /* The final block: the log tail, then 0x06 at data.length - off, then the
     0x80 bit at the block end. The tail never reaches RATE bytes (the while
     guard just failed), so the pad byte always lands inside the block. */
  var tail: seq<bv8> := data[off..];
  var fin: seq<bv8> := tail + [PAD6] + seq(RATE - 1 - |tail|, (i0) => ZERO8);
  fin := fin[RATE - 1 := fin[RATE - 1] | PAD80];
  assert |fin| == RATE;
  var l3, h3 := AbsorbBlock(L, H, fin, 0);
  var l4, h4 := KeccakF23(l3, h3);
  L := l4;
  H := h4;
  /* serialize lanes 0..3 little-endian */
  var out: seq<bv8> := [];
  for i := 0 to 4
    invariant |out| == 8 * i
  {
    for j := 0 to 8
      invariant |out| == 8 * i + j
    {
      var source := L;
      if j >= 4 {
        source := H;
      }
      var half := (if j < 4 then j else j - 4);
      var piece := (source[i] >> SH8[half]) & MASK8;
      out := out + [piece as bv8];
    }
  }
  digest := out;
}

/* Hex helpers for the command-line face, mirroring the JS's test harness:
   input arrives as one hex argument, the digest leaves as lowercase hex. */
function HexPairOf(b: bv8): (char, char)
{
  var n := b as nat;
  (HEXDIGITS[n / 16], HEXDIGITS[n % 16])
}

method ToHex(bytes: seq<bv8>) returns (hex: string)
  ensures |hex| == 2 * |bytes|
{
  var s: string := "";
  for i := 0 to |bytes|
    invariant |s| == 2 * i
  {
    var (c1, c2) := HexPairOf(bytes[i]);
    s := s + [c1, c2];
  }
  hex := s;
}

function HexVal(c: char): nat
{
  match c
  case '0' => 0 case '1' => 1 case '2' => 2 case '3' => 3 case '4' => 4
  case '5' => 5 case '6' => 6 case '7' => 7 case '8' => 8 case '9' => 9
  case 'a' => 10 case 'b' => 11 case 'c' => 12 case 'd' => 13
  case 'e' => 14 case 'f' => 15
  case _ => 16
}

method{:main} Main(args: seq<string>) {
  if |args| < 1 {
    print "usage: DeepSeekHashV1 <hex input>\n";
  } else {
    var hex := args[|args| - 1];
    if |hex| % 2 == 1 {
      print "invalid: odd hexadecimal length\n";
    } else {
      var bytes: seq<bv8> := [];
      var ok := true;
      var i := 0;
      while i < |hex| && ok
        invariant i % 2 == 0
      {
        var hv := HexVal(hex[i]);
        var lv := HexVal(hex[i + 1]);
        if hv < 16 && lv < 16 {
          var byte := (hv * 16 + lv) as bv8;
          bytes := bytes + [byte];
        } else {
          ok := false;
        }
        i := i + 2;
      }
      if ok {
        var digest := DeepSeekHashV1(bytes);
        var hexDigest := ToHex(digest);
        print hexDigest, "\n";
      } else {
        print "invalid hexadecimal\n";
      }
    }
  }
}
