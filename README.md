# SNMP MIB Browser

A client-side web application for browsing and analyzing SNMP MIB files.

Load a pile of MIB files, get one merged OID tree. Everything runs in the
browser — no server, no upload, no account. Your MIBs stay in your own
browser's storage.

## Demo

🔗 **[https://shmuto.github.io/mib-browser/](https://shmuto.github.io/mib-browser/)**

## Features

- **Merged tree** — many MIB modules resolved into a single OID hierarchy,
  regardless of the order you load them in
- **Cross-module resolution** — `IMPORTS` clauses are followed, so a module can
  hang off a node defined in another file
- **Search** — by object name, OID or description text, filtering the tree to
  matches and their ancestors
- **Node details** — OID, `MODULE::object` notation, syntax, access, status,
  description, enumerated values from `TEXTUAL-CONVENTION`, and a link back to
  the source file
- **Missing dependency reporting** — a module whose imports are not loaded is
  named along with the MIB it needs, and starts contributing as soon as you add
  it
- **Conflict detection** — two files declaring the same module differently are
  flagged with a field-by-field diff
- **Traps only** — a toggle that folds the tree down to the `NOTIFICATION-TYPE`
  definitions (traps and informs) and the branches leading to them, expanded
  ready to read; combines with search
- **Compact view** — folds single-child chains (`iso / org / dod / internet`)
  into one row
- **Handles large collections** — the tree view is virtualized, so expanding
  tens of thousands of nodes stays responsive

Supported constructs: `MODULE-IDENTITY`, `OBJECT-IDENTITY`, `OBJECT IDENTIFIER`,
`OBJECT-TYPE`, `NOTIFICATION-TYPE`, `TEXTUAL-CONVENTION`, `OBJECT-GROUP`,
`NOTIFICATION-GROUP`, `MODULE-COMPLIANCE`, including multi sub-identifier
assignments such as `::= { parent 3011 7124 3282 }`.

## Development

```bash
bun install
bun run dev        # dev server
bun test           # unit tests
bun run typecheck  # tsc --noEmit
bun run build      # typecheck + production build into dist/
```

Tests live in [`tests/`](./tests) and cover the parser, the tree builder and the
OID helpers — including a regression case for every real-world MIB shape that
has tripped the parser up. They run on every pull request. `tests/fixtures.test.ts`
holds the files in [`test-data/mibs`](./test-data) to the behaviour their README
describes, so a new fixture wants an expectation there too.

Try it with the fixtures in [`test-data/`](./test-data/README.md), or with
`public/sample-mibs/SAMPLE-MIB.txt`.

If stored data ever stops the app from starting, load it with **`?reset=true`**
to clear the browser database.

## Project layout

```
src/
  components/    UI. MibTreeView + TreeNode render the tree
  hooks/         useMibStorage - stored MIBs, merged tree, rebuild cycle
  lib/           parsing, tree building, OID helpers, IndexedDB access
  types/         shared type definitions
docs/            architecture and internals
tests/           unit tests (bun test)
test-data/       MIB fixtures and a generator for large corpora
public/          static assets, including a sample MIB
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE_EN.md](./docs/ARCHITECTURE_EN.md) | How the app fits together: module map, data flow, state ownership, rendering, persistence |
| [docs/MIB_TREE_CONSTRUCTION_EN.md](./docs/MIB_TREE_CONSTRUCTION_EN.md) | The parser and the 3-pass tree builder in detail |
| [docs/PERFORMANCE_EN.md](./docs/PERFORMANCE_EN.md) | Where the time goes, what has been optimized, and how to measure |
| [docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md](./docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md) | Design proposal for replacing the full rebuild with incremental updates |
| [test-data/README.md](./test-data/README.md) | The test fixtures and the corpus generator |

## License

MIT License
