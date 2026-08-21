# Test data

MIB files for exercising the browser by hand. Nothing here is shipped with the
build — `public/sample-mibs/SAMPLE-MIB.txt` is the file that gets deployed.

All of it is synthetic. The fixtures are anchored under the private enterprise
number `99999` (`1.3.6.1.4.1.99999`) and the generated corpus under `900000+`,
so neither collides with a real vendor MIB you might load alongside them.

## `mibs/` — behaviour fixtures

Small handwritten modules, each aimed at one thing that is awkward to trigger
with a single well-formed MIB. Load the whole directory at once for the full
picture, or individual files to isolate a case.

| File | What it covers |
|---|---|
| `TEST-BASE-MIB.txt` | The root of the fixture set. Scalars with `DisplayString` / `Integer32` syntax and a `deprecated` object. |
| `TEST-EXTENSION-MIB.txt` | Imports an anchor node from `TEST-BASE-MIB` and hangs a table off it. Load it *before* the base module to confirm upload order does not matter. |
| `TEST-MULTI-SUBID-MIB.txt` | OID assignments that skip levels — `::= { parent 3011 7124 3282 }` and the named-number form `::= { parent ieee(111) lan-man-stds(802) 1 }`. The skipped sub-identifiers have no node of their own, which the tree walk and the breadcrumb both have to handle. |
| `TEST-MISSING-DEP-MIB.txt` | Imports from `TEST-ABSENT-MIB`, which is deliberately not supplied. Should report `Missing MIB dependencies: TEST-ABSENT-MIB` against the file and leave the rest of the tree usable. |
| `TEST-CONFLICT-A.txt` / `TEST-CONFLICT-B.txt` | Two files declaring the same module name (`TEST-CONFLICT-MIB`) with the same object names but different `SYNTAX`, `MAX-ACCESS`, `STATUS` and `DESCRIPTION`. Loading both raises the conflict panel. |
| `TEST-TC-ONLY-MIB.txt` | A module defining nothing but `TEXTUAL-CONVENTION`s, as `IPV6-TC` (RFC 2465) does. It contributes no nodes to the tree, but must still be accepted on upload: other modules import its types, and the details panel resolves `SYNTAX` against it. |
| `TEST-EMPTY-MODULE-MIB.txt` | A module whose body is entirely commented out, as RFC-1212 is shipped in most MIB collections. It is a valid module that defines nothing: uploading it must succeed and contribute 0 nodes, so a bulk upload of a standard MIB directory does not report errors for files like this. |
| `TEST-ODD-HEADER-MIB.txt` | Module name, then a comment, then `DEFINITIONS IMPLICIT TAGS ::= BEGIN` on a later line. Real MIBs are laid out this way, and the module name has to be found across the comment. |

Expected results once all nine are loaded:

- 1 conflict pair (`TEST-CONFLICT-A.txt` ⇄ `TEST-CONFLICT-B.txt`, 3 differing objects)
- 1 missing-dependency warning naming `TEST-ABSENT-MIB`
- `deepLeaf` resolves to `1.3.6.1.4.1.99999.3.3011.7124.3282.1`
- `namedLeaf` resolves to `1.3.6.1.4.1.99999.3.111.802.1.1`
- `oddCounter` resolves to `1.3.6.1.4.1.99998.1`
- `TestPortState` and `TestMacAddress` are offered as enumerated values in the
  details panel, though `TEST-TC-ONLY-MIB` adds no rows to the tree

## `generate-large-corpus.mjs` — volume for performance work

The fixtures above are far too small to show anything about performance, and
committing a few megabytes of near-identical generated MIBs would only bloat
the repository. Generate them instead:

```bash
node test-data/generate-large-corpus.mjs                # 60 modules x 200 objects (~12k nodes, ~2 MB)
node test-data/generate-large-corpus.mjs 400 150        # ~63k nodes, ~14 MB
node test-data/generate-large-corpus.mjs 10 50 /tmp/mib # custom output directory
```

Output goes to `test-data/generated/` (git-ignored) as `GEN-<n>-MIB.txt`. Each
module is self-contained apart from `SNMPv2-SMI`, sits under its own enterprise
number, and nests its objects a few levels deep, so the modules merge into one
wide tree the way a vendor MIB collection does. Descriptions are padded to a
realistic length so that searching costs what it would on real data.

Drag the directory onto the drop zone, or select all the files in the file
dialog, then exercise Expand All, scrolling, search and node selection.

Use `?reset=true` on the URL to clear IndexedDB between runs.
