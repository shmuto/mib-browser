# Test Data

Synthetic MIB files for manually testing the browser and benchmarking performance.

> [!NOTE]
> Nothing in this directory is bundled into the production build. Only [`public/sample-mibs/SAMPLE-MIB.txt`](../public/sample-mibs/SAMPLE-MIB.txt) is deployed with the app.

All test data uses synthetic private enterprise numbers so it will not collide with real vendor MIBs loaded alongside it:
- **Fixtures (`mibs/`):** anchored under enterprise `99999` (`1.3.6.1.4.1.99999`)
- **Generated corpus (`generated/`):** anchored under enterprise `900000+`

---

## `mibs/` — Behavior Fixtures

Small, handwritten MIB modules that each target an edge case hard to trigger with a single well-formed MIB. Load the entire directory at once to exercise everything together, or load individual files to isolate a specific case.

| File | What it tests |
|---|---|
| `TEST-BASE-MIB.txt` | Root of the fixture set. Defines scalars with `DisplayString` / `Integer32` syntax and a `deprecated` object. |
| `TEST-EXTENSION-MIB.txt` | Imports an anchor from `TEST-BASE-MIB` and attaches a table. Load it *before* the base module to verify upload order independence. |
| `TEST-MULTI-SUBID-MIB.txt` | Multi-sub-identifier assignments that skip intermediate levels (`::= { parent 3011 7124 3282 }` and `::= { parent ieee(111) lan-man-stds(802) 1 }`), exercising tree traversal and breadcrumbs without intermediate nodes. |
| `TEST-MISSING-DEP-MIB.txt` | Imports from an intentionally absent `TEST-ABSENT-MIB`. Verifies that `Missing MIB dependencies: TEST-ABSENT-MIB` is reported while the rest of the tree remains usable. |
| `TEST-CONFLICT-A.txt` / `TEST-CONFLICT-B.txt` | Two files declaring `TEST-CONFLICT-MIB` with the same object names but differing `SYNTAX`, `MAX-ACCESS`, `STATUS`, and `DESCRIPTION`. Verifies conflict detection and diffing. |
| `TEST-TC-ONLY-MIB.txt` | Defines only `TEXTUAL-CONVENTION`s (like `IPV6-TC` / RFC 2465). Contributes 0 tree nodes, but must be accepted so other modules and the details panel can resolve its types. |
| `TEST-EMPTY-MODULE-MIB.txt` | A valid module whose body is entirely commented out (like standard `RFC-1212` distributions). Must upload cleanly with 0 nodes so bulk imports don't error. |
| `TEST-V1-TRAP-MIB.txt` | SMIv1 module (RFC 1155 / 1215) with `TRAP-TYPE` definitions mapped to `<enterprise>.0.<number>`, both with and without `VARIABLES`, plus an inline `SYNTAX INTEGER { ... }` enumeration (`v1TrapReason`). |
| `TEST-IEEE-ANCHOR-MIB.txt` | IEEE 802.1 style: named-number root arc (`::= { iso(1) std(0) iso8802(8802) ... }`), hyphenated names (`member-body`, `ieee-anchor-leaf`), and an example definition quoted inside a `DESCRIPTION` (like `IF-MIB`). |
| `TEST-ODD-HEADER-MIB.txt` | Module name separated from `DEFINITIONS IMPLICIT TAGS ::= BEGIN` by a comment on a preceding line. |

### Expected Results (All 11 Files Loaded)

**Diagnostics:**
- **1 conflict pair:** `TEST-CONFLICT-A.txt` ⇄ `TEST-CONFLICT-B.txt` (3 differing objects)
- **1 missing-dependency warning:** names `TEST-ABSENT-MIB`

**OID Resolution:**
- `deepLeaf` → `1.3.6.1.4.1.99999.3.3011.7124.3282.1`
- `namedLeaf` → `1.3.6.1.4.1.99999.3.111.802.1.1`
- `oddCounter` → `1.3.6.1.4.1.99998.1`
- `testIeeeAnchorMIB` → `1.0.8802.1.1.99999`
- `member-body` → `1.2`
- No `noTest` node exists (it appears only as prose inside a `DESCRIPTION`)

**Traps & Textual Conventions:**
- `v1CardRemoved` → `1.3.6.1.4.1.99999.5.0.1` and lists `v1TrapReason` under **Variables**.
- Both `v1CardRemoved` and `v1CardInserted` remain visible under the **Traps Only** filter.
- `v1TrapReason` displays `INTEGER` syntax with enumerated values `unknown`, `overheated`, and `unplugged`.
- `TestPortState` and `TestMacAddress` resolve as enumerated values in the details panel, even though `TEST-TC-ONLY-MIB` adds no tree rows.

> [!IMPORTANT]
> These expectations are automatically verified by [`tests/fixtures.test.ts`](../tests/fixtures.test.ts). Whenever you add a fixture here, add a corresponding assertion there so the documentation stays tested.

---

## `generate-large-corpus.mjs` — Performance Corpus Generator

The handwritten fixtures above are too small for performance profiling, and committing megabytes of synthetic MIBs would bloat the repository. Generate large corpora locally instead:

```bash
node test-data/generate-large-corpus.mjs                # 60 modules × 200 objects (~12k nodes, ~2 MB)
node test-data/generate-large-corpus.mjs 400 150        # 400 modules × 150 objects (~63k nodes, ~14 MB)
node test-data/generate-large-corpus.mjs 10 50 /tmp/mib # Custom output directory
```

### How It Works

- Writes `GEN-<n>-MIB.txt` files to `test-data/generated/` (git-ignored) by default.
- Each module depends only on `SNMPv2-SMI`, sits under its own enterprise number, and nests objects several levels deep—producing a wide merged tree similar to a real vendor MIB collection.
- Descriptions are padded to realistic lengths so search benchmarks reflect real-world cost.

### Testing Workflow

1. Drag the generated directory onto the drop zone (or select all files via the file dialog).
2. Exercise **Expand All**, scrolling, search, and node selection.
3. Reload with `?reset=true` in the URL to clear IndexedDB between benchmark runs.
