# Squint: AI Agent Guide

Squint is a codebase intelligence tool. A `.squint.db` file already exists in this repository — it contains pre-indexed architecture data: modules, interactions, flows, features, symbols, and relationships.

**Always use `--json`** for structured output.

The database is auto-discovered by walking up from CWD. Override with `-d <path>` or `SQUINT_DB_PATH` env var.

## When to Use Squint vs Native Tools

**Use squint for:**
- Architecture questions — module structure, layer boundaries, interaction patterns
- Call graphs — "what calls X", "what does X depend on", dependency chains
- Feature/flow exploration — "how does feature Y work", user journeys, entry points
- Side-effect analysis — pure vs impure functions, I/O boundaries
- Cross-cutting concerns — which modules interact, shared dependencies, domain relationships

**Use native tools (Read, Grep, Glob) for:**
- Reading specific file contents, editing code, line-level details

**Pattern:** Use squint first to identify which files/symbols matter, then read those files directly.

## Getting Oriented

Start every session with these three commands:

```bash
# Big picture: stats, features, module tree, file list
squint overview --json

# Pipeline coverage: how complete is the index
squint stats --json

# Module hierarchy
squint modules list --tree --json
```

`overview` returns `{ sourceDirectory, stats, features, moduleTree, files }` — enough to understand the project's scope and structure at a glance.

## Top-Down Drill-Down Strategy

The core mental model: **features -> flows -> interactions -> modules -> symbols**

Start broad, follow cross-references to narrow focus:

1. **Features** — `squint features show <slug> --json`
   Returns: `flows[]`, `modulesInvolved[]`, `interactions[]`, `stats`

2. **Flows** — `squint flows show <slug> --json`
   Returns: `steps[]` (interaction IDs), `entryPoint` (symbol), `definitionSteps[]` (function-level call chain), `modulesInvolved[]`

3. **Interactions** — `squint interactions show <id> --json`
   Returns: `resolvedSymbols[]`, `relatedInteractions[]`, `flows[]`, `features[]`, module descriptions

4. **Modules** — `squint modules show <path> --json`
   Returns: `members[]`, `outgoingInteractions[]`, `incomingInteractions[]`, `flows[]`, `features[]`, `children[]`

5. **Symbols** — `squint symbols show <name> --json`
   Returns: `relationships[]`, `incomingRelationships[]`, `dependencies[]`, `dependents` (with count), `interactions{}`, `flows[]`, `sourceCode[]`, `callSites[]`, `metadata`

6. **Files** (aggregate view) — `squint symbols show --file <path> --json`
   Returns: `symbols[]`, `relationships{}`, `interactions{}`, `flows[]` — everything for all symbols in that file

Every `show` output contains cross-reference IDs/slugs. Follow them to drill deeper.

## Common Exploration Recipes

### "Where does X happen?"
```bash
squint symbols show <name> --json              # Find a specific symbol
squint symbols list --domain <domain> --json   # All symbols in a domain
squint symbols list --file <path> --json       # All symbols in a file
squint symbols list --kind function --json     # Filter by kind
```

### "What calls this function?"
```bash
squint symbols show <name> --json              # Check dependents.count and dependents.sample
squint hierarchy --type calls --root <name> --json   # Full call tree from a root
```

### "How does feature Y work?"
```bash
squint features show <slug> --json             # Get flows and modules involved
squint flows show <flow-slug> --json           # Ordered steps, entry point, definition trace
squint flows trace <symbol-name> --json        # Trace call graph from entry point
```

### "What does this file do?"
```bash
squint symbols show --file <path> --json       # All symbols, relationships, interactions
squint files show <path> --json                # Definitions, imports, imported-by
```

### "What are the side effects?"
```bash
squint symbols list --pure false --json        # All impure/side-effecting symbols
squint symbols list --pure true --json         # All pure functions
```

### "Which modules interact?"
```bash
squint interactions list --json                          # All interactions
squint interactions list --module <path> --json           # Filter by module
squint interactions list --pattern business --json        # Only business interactions
squint interactions list --pattern utility --json         # Only utility interactions
```

### "What depends on X?"
```bash
squint symbols deps <name> --json              # Dependencies with metadata status
squint symbols show <name> --json              # dependents field shows reverse deps
```

### "What's the class hierarchy?"
```bash
squint hierarchy --type extends --json         # Inheritance trees
squint hierarchy --type implements --json      # Interface implementations
```

### "What's incomplete or missing?"
```bash
squint gaps --json                             # Unannotated symbols, empty modules, gaps
squint gaps --type symbols --json              # Only unannotated symbols
squint gaps --type relationships --json        # Only unannotated relationships
```

### "What domains exist?"
```bash
squint domains list --json                     # All registered domains
squint domains show <name> --json              # Symbols, module distribution, relationships
```

## Quick Reference

### Orientation
| Command | Purpose |
|---------|---------|
| `squint overview --json` | Stats, features, module tree, files |
| `squint stats --json` | Pipeline coverage and counts |
| `squint modules list --tree --json` | Module hierarchy |
| `squint features list --json` | All features with flow counts |
| `squint domains list --json` | All semantic domains |

### Drill-Down (show commands)
| Command | Purpose |
|---------|---------|
| `squint features show <slug> --json` | Feature detail with flows and modules |
| `squint flows show <slug> --json` | Flow steps, entry point, call chain |
| `squint interactions show <id> --json` | Interaction with resolved symbols |
| `squint modules show <path> --json` | Module members and connections |
| `squint symbols show <name> --json` | Full symbol detail with source |
| `squint symbols show --file <path> --json` | Aggregate file view |
| `squint files show <path> --json` | File imports and definitions |
| `squint relationships show --from <id> --to <id> --json` | Relationship detail |
| `squint domains show <name> --json` | Domain symbols and relationships |

### Search & Filter
| Flag | Available on | Values |
|------|-------------|--------|
| `--kind` | `symbols list` | function, class, method, variable, module, type, interface, enum |
| `--file` | `symbols list`, `symbols show` | File path |
| `--domain` | `symbols list` | Domain name |
| `--pure` | `symbols list` | true, false |
| `--pattern` | `interactions list` | business, utility |
| `--module` | `interactions list` | Module path |
| `--stakeholder` | `flows list` | user, admin, system, developer, external |
| `--tier` | `flows list` | 0 (atomic), 1 (operation), 2 (journey) |
| `--source` | `interactions list` | ast, llm-inferred |

### Tracing
| Command | Purpose |
|---------|---------|
| `squint flows trace <symbol> --json` | Call graph from a symbol |
| `squint hierarchy --type calls --root <name> --json` | Call hierarchy tree |
| `squint hierarchy --type extends --json` | Class inheritance tree |
| `squint hierarchy --type implements --json` | Interface implementation tree |

### Diagnostics
| Command | Purpose |
|---------|---------|
| `squint gaps --json` | All gaps (unannotated, empty, unassigned) |
| `squint gaps --type symbols --json` | Unannotated symbols only |
| `squint files orphans --json` | Files with no incoming imports |

## Tips

- **Identifiers**: Commands accept slugs, names, or numeric IDs interchangeably.
- **Disambiguate**: If a symbol name is ambiguous, add `--file <path>` to narrow it.
- **Module paths**: Use dot-notation (e.g., `project.api.controllers`).
- **Cross-references**: Every `show` output contains IDs and slugs — follow them to drill deeper.
- **Read-only**: Only use exploration commands. Do not run `generate`, `annotate`, `set`, `create`, `delete`, `ingest`, `parse`, or `sync` unless explicitly asked.
- **Full documentation**: See README.md for complete command reference and JSON schemas.
