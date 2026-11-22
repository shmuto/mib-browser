# SNMP MIB Browser

**English** | [日本語](./README.ja.md)

A client-side web application for browsing and analyzing SNMP MIB files.

Load any collection of MIB files to inspect them as a single, merged OID tree. Everything runs locally in your browser—no server, no remote uploads, and no account required.

🔗 **Live Demo:** [https://shmuto.github.io/mib-browser/](https://shmuto.github.io/mib-browser/)

---

## Features

- **Folder & multi-file import:** Drop a directory or select files to load MIBs recursively regardless of order.
- **Merged OID tree:** Resolves `IMPORTS` across modules into one unified hierarchy, including SMIv1 `TRAP-TYPE` definitions.
- **Search & filtering:** Search by object name, OID, or description, toggle **Traps only** (`NOTIFICATION-TYPE` / `TRAP-TYPE`), or switch to **Compact view** to collapse single-child chains.
- **Node details:** Inspect OIDs, `MODULE::object` notation, syntax, enumerated values (`INTEGER` / `TEXTUAL-CONVENTION`), notification varbinds, descriptions, and source files.
- **Diagnostics:** Reports missing `IMPORTS` dependencies, unplaced definitions, and field-by-field diffs for conflicting module definitions.
- **Handles large collections:** Virtualized tree rendering keeps tens of thousands of nodes responsive.

**Supported SMI constructs:** `MODULE-IDENTITY`, `OBJECT-IDENTITY`, `OBJECT IDENTIFIER`, `OBJECT-TYPE`, `TEXTUAL-CONVENTION`, `NOTIFICATION-TYPE`, `TRAP-TYPE`, `OBJECT-GROUP`, `NOTIFICATION-GROUP`, `MODULE-COMPLIANCE`, multi sub-identifier assignments, and root-arc anchors (e.g., IEEE 802.1).

---

## Development

```bash
bun install
bun run dev        # Start the dev server
bun test           # Run unit tests
bun run typecheck  # Typecheck with tsc --noEmit
bun run build      # Typecheck and build for production into dist/
```

> [!TIP]
> If corrupted browser data ever prevents the app from starting, open it with **`?reset=true`** in the URL to clear IndexedDB.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE_EN.md](./docs/ARCHITECTURE_EN.md) | Module map, data flow, state ownership, rendering, and persistence |
| [docs/MIB_TREE_CONSTRUCTION_EN.md](./docs/MIB_TREE_CONSTRUCTION_EN.md) | MIB parsing, 3-pass tree builder, and conflict detection |
| [docs/PERFORMANCE_EN.md](./docs/PERFORMANCE_EN.md) | Benchmarks, optimizations, invariants, and profiling |
| [docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md](./docs/INCREMENTAL_UPDATE_PROPOSAL_EN.md) | Reassessment and deferred proposal for incremental tree updates |
| [test-data/README.md](./test-data/README.md) | Test fixtures and large-corpus generator |

---

## License

MIT License
