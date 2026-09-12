# SNMP MIB Browser

A client-side web application for browsing and analyzing SNMP MIB files.

Load a pile of MIB files, get one merged OID tree. Everything runs in the
browser — no server, no upload, no account. Your MIBs stay in your own
browser's storage.

## Demo

🔗 **[https://shmuto.github.io/mib-browser/](https://shmuto.github.io/mib-browser/)**

## Features

- **Folder import** — drop a whole MIB directory, or pick one with **Select
  folder**, and every file inside it is read, subdirectories included; files
  that hold no MIB module are counted as skipped rather than reported as
  failures
- **Merged tree** — many MIB modules resolved into a single OID hierarchy,
  regardless of the order you load them in
- **Cross-module resolution** — `IMPORTS` clauses are followed, so a module can
  hang off a node defined in another file
- **Search** — by object name, OID or description text, filtering the tree to
  matches and their ancestors
- **Node details** — OID, `MODULE::object` notation, syntax, access, status,
  description, enumerated values — the object's own `SYNTAX INTEGER { ... }` or
  the `TEXTUAL-CONVENTION` it names — and a link back to the source file
- **Missing dependency reporting** — a module whose imports are not loaded is
  named along with the MIB it needs, and starts contributing as soon as you add
  it; a definition whose anchor no loaded file defines at all is reported
  against its file rather than quietly left out of the tree
- **Conflict detection** — two files declaring the same module differently are
  flagged with a field-by-field diff
- **Traps only** — a toggle that folds the tree down to the notification
  definitions (SMIv2 `NOTIFICATION-TYPE` and SMIv1 `TRAP-TYPE`) and the branches
  leading to them, expanded ready to read; combines with search
- **SMIv1 traps** — `TRAP-TYPE` definitions, which carry a specific-trap number
  instead of an OID, are placed under their `ENTERPRISE` node as
  `<enterprise>.0.<number>`, the mapping of RFC 3584; the varbinds a
  notification carries (`VARIABLES`, or SMIv2 `OBJECTS`) are listed in the
  details panel and link through to their definitions
- **Compact view** — folds single-child chains (`iso / org / dod / internet`)
  into one row
- **Handles large collections** — the tree view is virtualized, so expanding
  tens of thousands of nodes stays responsive

Supported constructs: `MODULE-IDENTITY`, `OBJECT-IDENTITY`, `OBJECT IDENTIFIER`,
`OBJECT-TYPE`, `NOTIFICATION-TYPE`, `TRAP-TYPE`, `TEXTUAL-CONVENTION`,
`OBJECT-GROUP`, `NOTIFICATION-GROUP`, `MODULE-COMPLIANCE`, including multi
sub-identifier assignments such as `::= { parent 3011 7124 3282 }` and modules
anchored at a root arc, `::= { iso(1) std(0) iso8802(8802) ... }`, as the IEEE
802.1 modules are.

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
public/          static assets: the icons, the link-preview image, a sample MIB
scripts/         source for the generated images in public/
```

## Icons and link previews

`public/favicon.svg` is the icon; `favicon.png` (96px) and `apple-touch-icon.png`
(180px) are renders of it for browsers that want a bitmap. `public/og-image.png`
is what Slack, Discord, Teams and the rest show when the link is pasted, through
the Open Graph tags in [`index.html`](./index.html).

Those tags carry absolute URLs — a relative one unfurls without an image — so
they name `https://shmuto.github.io/mib-browser/`. A fork that publishes
somewhere else wants its own address there.

To change the preview, edit [`scripts/og-image.html`](./scripts/og-image.html)
and render it back at exactly 1200x630:

```bash
npx playwright screenshot --viewport-size=1200,630 \
  scripts/og-image.html public/og-image.png
```

Slack caches an unfurl for a while; a changed image shows up sooner if the
message is posted with `?1` on the end of the URL.

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
