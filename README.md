# Squint

AST + LLM driven codebase analysis and visualization.

[![npm version](https://img.shields.io/npm/v/%40zbigniewsobiecki%2Fsquint)](https://www.npmjs.com/package/@zbigniewsobiecki/squint)
[![CI](https://github.com/zbigniewsobiecki/squint/actions/workflows/ci.yml/badge.svg)](https://github.com/zbigniewsobiecki/squint/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Squint indexes TypeScript and JavaScript source code into an SQLite database, then provides 80+ commands to systematically annotate symbols and relationships with human-readable descriptions — manually or via LLM. It detects architectural modules, cross-module interactions, user journey flows, and product-level features.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Command Reference](#command-reference)
  - [Top-Level Commands](#top-level-commands)
  - [symbols](#symbols)
  - [relationships](#relationships)
  - [domains](#domains)
  - [modules](#modules)
  - [interactions](#interactions)
  - [flows](#flows)
  - [features](#features)
  - [files](#files)
  - [hierarchy](#hierarchy)
  - [process-groups](#process-groups)
- [AI Agent Usage](#ai-agent-usage)
  - [Exploration Strategy](#exploration-strategy)
  - [Show Command JSON Schemas](#show-command-json-schemas)
  - [Example Drill-Down Session](#example-drill-down-session)
- [Understanding Workflow](#understanding-workflow)
- [Database Schema](#database-schema)
- [Development](#development)
- [License](#license)

---

## Installation

### End users

```bash
# Global install
npm install -g @zbigniewsobiecki/squint

# Or run directly
npx @zbigniewsobiecki/squint --help
```

### Contributors

```bash
git clone https://github.com/zbigniewsobiecki/squint.git
cd squint
pnpm install
pnpm run build
```

---

## Quick Start

**Full automated pipeline** (parse, annotate, verify, generate modules/interactions/flows/features):

```bash
squint ingest ./src
```

**Manual step-by-step:**

```bash
# 1. Index your codebase
squint parse ./src

# 2. Check what needs understanding
squint symbols understood

# 3. Annotate symbols with LLM
squint symbols annotate -a purpose -a domain -a role

# 4. Generate architectural modules
squint modules generate

# 5. Detect cross-module interactions
squint interactions generate

# 6. Trace user journey flows
squint flows generate

# 7. Group flows into product features
squint features generate

# 8. Get a compact overview
squint overview
```

---

## Command Reference

### Command Summary

| Namespace | Commands |
|-----------|----------|
| **Top-level** | `parse`, `ingest`, `browse`, `overview`, `stats`, `gaps` |
| **symbols** | `list`, `show`, `set`, `unset`, `annotate`, `verify`, `ready`, `next`, `deps`, `prereqs`, `understood` |
| **relationships** | `list`, `show`, `set`, `unset`, `annotate`, `verify`, `next` |
| **domains** | `list`, `show`, `create`, `update`, `delete`, `sync`, `rename`, `merge` |
| **modules** | `list`, `show`, `create`, `update`, `delete`, `assign`, `unassign`, `generate`, `verify`, `prune` |
| **interactions** | `list`, `show`, `create`, `update`, `delete`, `generate`, `validate`, `verify` |
| **flows** | `list`, `show`, `create`, `update`, `delete`, `add-step`, `remove-step`, `trace`, `generate`, `verify` |
| **features** | `list`, `show`, `create`, `update`, `delete`, `assign`, `unassign`, `generate` |
| **files** | `list`, `show`, `imports`, `imported-by`, `orphans` |
| **hierarchy** | *(default: inheritance tree)* |
| **process-groups** | `list` |

All commands accept `-d, --database <path>` (default: `<directory>/.squint.db`) and most accept `--json` for machine-readable output.

---

### Top-Level Commands

#### `squint parse` — Index a Codebase

Scans TypeScript/JavaScript files and builds an SQLite index of definitions, references, and symbol usages.

```bash
squint parse <directory> [-o <output.db>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output` | `.squint.db` | Output database file path |

#### `squint ingest` — Full Analysis Pipeline

Runs the complete pipeline in sequence: parse, annotate symbols, verify symbols, annotate relationships, verify relationships, generate modules, verify modules, generate interactions, verify interactions, generate flows, verify flows, and generate features.

```bash
squint ingest <directory> [flags]
```

| Flag | Description |
|------|-------------|
| `--from <stage>` | Resume from a specific stage |
| `--force` | Re-run stages even if data exists |
| `--dry-run` | Don't persist LLM results |
| `-m, --model` | LLM model alias |

#### `squint browse` — Interactive Code Browser

Launches a web-based visualization of the indexed codebase.

```bash
squint browse [-p <port>] [--no-open]
```

#### `squint overview` — Compact Codebase Overview

Shows a complete codebase overview: stats, features, module tree, and file tree.

```bash
squint overview [flags]
```

#### `squint stats` — Database Statistics

Shows aggregate statistics and pipeline progress: parsed counts, annotation coverage, module assignment, interactions, flows, and features.

```bash
squint stats [--json]
```

#### `squint gaps` — Find Incomplete Entities

Lists unannotated symbols, unannotated relationships, empty modules, and unassigned symbols.

```bash
squint gaps [flags]
```

| Flag | Description |
|------|-------------|
| `-t, --type` | Gap type: `symbols`, `relationships`, `modules`, `unassigned` (default: all) |
| `--limit` | Max items per section (default: 20) |
| `--kind` | Filter symbols by kind |

---

### symbols

Manage symbol definitions (functions, classes, variables, types, interfaces, enums).

#### `squint symbols list`

Lists all symbols in the index. This is the default when running `squint symbols`.

```bash
squint symbols [flags]
```

| Flag | Description |
|------|-------------|
| `--kind` | Filter by kind: `function`, `class`, `variable`, `type`, `interface`, `enum` |
| `--file` | Filter to symbols in a specific file |
| `--has <key>` | Filter to symbols that have this metadata key |
| `--missing <key>` | Filter to symbols missing this metadata key |
| `--domain <name>` | Filter to symbols with this domain tag |
| `--pure <bool>` | Filter by purity |
| `--domains` | List all unique domains in use |

#### `squint symbols show`

Shows detailed information about a symbol including source code, callsites, and metadata.

```bash
squint symbols show <name> [--id <id>] [-f <file>] [-c <context-lines>] [--json]
```

#### `squint symbols set`

Sets metadata (annotations) on a symbol.

```bash
squint symbols set <key> <value> --name <symbol>
squint symbols set <key> <value> --id <id>
```

Common metadata keys: `purpose`, `domain` (JSON array), `role`, `pure`.

Supports `--batch` (stdin) and `-i, --input-file` for bulk annotation.

#### `squint symbols unset`

Removes a metadata key from a symbol.

```bash
squint symbols unset <key> --name <symbol>
```

#### `squint symbols annotate`

Uses an LLM to automatically annotate symbols in dependency order (leaves first).

```bash
squint symbols annotate -a <aspect> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | **(required, repeatable)** Metadata key to annotate |
| `-m, --model` | LLM model alias |
| `-b, --batch-size` | Symbols per LLM call (default: 5) |
| `--max-iterations` | Max iterations, 0 = unlimited |
| `-k, --kind` | Filter by symbol kind |
| `-f, --file` | Filter by file path pattern |
| `-x, --exclude` | Glob pattern to exclude |
| `--force` | Annotate even if dependencies aren't annotated |
| `--dry-run` | Parse LLM output but don't persist |

```bash
squint symbols annotate -a purpose -a domain -a role
squint symbols annotate -a purpose --kind function --exclude "**/*.test.ts"
```

#### `squint symbols verify`

Verifies existing symbol annotations using LLM and flags incorrect ones.

```bash
squint symbols verify [flags]
```

#### `squint symbols ready`

Lists symbols ready to annotate — all their dependencies already have the specified aspect.

```bash
squint symbols ready --aspect <key> [-l <limit>] [-k <kind>] [-f <file>] [-v]
```

#### `squint symbols next`

Shows the next symbol ready to understand with its full source code.

```bash
squint symbols next --aspect <key> [-c <count>] [-m <max-lines>] [--json]
```

#### `squint symbols deps`

Shows what other symbols a given symbol depends on, with annotation status.

```bash
squint symbols deps <name> [-a <aspect>] [--json]
```

#### `squint symbols prereqs`

Shows unmet dependencies in topological order — what to understand before a target symbol.

```bash
squint symbols prereqs <name> --aspect <key>
```

#### `squint symbols understood`

Shows understanding coverage statistics per aspect.

```bash
squint symbols understood [-a <aspect>] [-k <kind>] [-f <file>] [--json]
```

---

### relationships

Manage semantic annotations on call/use edges between symbols.

#### `squint relationships list`

Lists all annotated relationships. Default when running `squint relationships`.

```bash
squint relationships [--from <symbol>] [--to <symbol>] [--count] [--json]
```

#### `squint relationships show`

Shows detail for a relationship between two definitions.

```bash
squint relationships show --from <symbol> --to <symbol>
```

#### `squint relationships set`

Sets a semantic annotation on a relationship.

```bash
squint relationships set "<description>" --from <source> --to <target>
squint relationships set "<description>" --from-id <id> --to-id <id>
```

#### `squint relationships unset`

Removes a relationship annotation.

```bash
squint relationships unset --from <source> --to <target>
```

#### `squint relationships annotate`

Uses an LLM to annotate relationships between symbols.

```bash
squint relationships annotate [flags]
```

#### `squint relationships verify`

Verifies existing relationship annotations using LLM.

```bash
squint relationships verify [flags]
```

#### `squint relationships next`

Shows the next unannotated relationship with context (both symbols' metadata, other relationships, source code).

```bash
squint relationships next [--count <n>] [--from <symbol>] [--json]
```

---

### domains

Manage business/architectural domain tags that group related symbols.

#### `squint domains list`

Lists registered domains with symbol counts. Default when running `squint domains`.

```bash
squint domains [--unregistered] [--json]
```

#### `squint domains show`

Shows domain details including assigned symbols.

```bash
squint domains show <name>
```

#### `squint domains create`

Registers a new domain.

```bash
squint domains create <name> [--description "..."]
```

#### `squint domains update`

Updates a domain description.

```bash
squint domains update <name> --description "..."
```

#### `squint domains delete`

Removes a domain from the registry.

```bash
squint domains delete <name> [--force]
```

#### `squint domains sync`

Bulk-registers all domains currently in use by symbols.

```bash
squint domains sync
```

#### `squint domains rename`

Renames a domain in the registry and updates all symbol metadata.

```bash
squint domains rename <old-name> <new-name>
```

#### `squint domains merge`

Merges the source domain into the target, updating all symbols.

```bash
squint domains merge <from-domain> <into-domain>
```

---

### modules

Manage architectural module hierarchy. Modules use dot-notation paths (e.g., `project.backend.services.auth`).

#### `squint modules list`

Lists all modules with member counts. Default when running `squint modules`.

```bash
squint modules [--tree] [--json]
```

#### `squint modules show`

Shows module details including all members.

```bash
squint modules show <name> [--json]
```

#### `squint modules create`

Creates a new module under a parent.

```bash
squint modules create <name> [flags]
```

#### `squint modules update`

Updates a module name or description.

```bash
squint modules update <name> [flags]
```

#### `squint modules delete`

Deletes a module.

```bash
squint modules delete <name>
```

#### `squint modules assign`

Assigns a symbol to a module.

```bash
squint modules assign --module <module> --name <symbol>
```

#### `squint modules unassign`

Removes a symbol from its module.

```bash
squint modules unassign --name <symbol>
```

#### `squint modules generate`

Uses a two-phase LLM approach to create a hierarchical module tree and assign symbols.

```bash
squint modules generate [flags]
```

| Flag | Description |
|------|-------------|
| `-b, --batch-size` | Symbols per assignment batch (default: 30) |
| `--dry-run` | Show detected modules without persisting |
| `--force` | Re-detect even if modules exist |
| `-m, --model` | LLM model alias |

#### `squint modules verify`

Verifies existing module assignments using LLM.

```bash
squint modules verify [flags]
```

#### `squint modules prune`

Removes empty leaf modules.

```bash
squint modules prune
```

---

### interactions

Manage module-to-module interaction edges derived from the call graph.

#### `squint interactions list`

Lists all detected module interactions. Default when running `squint interactions`.

```bash
squint interactions [--json]
```

#### `squint interactions show`

Shows details for a specific interaction.

```bash
squint interactions show <id> [--json]
```

#### `squint interactions create`

Creates a new module interaction.

```bash
squint interactions create [flags]
```

#### `squint interactions update`

Updates an interaction.

```bash
squint interactions update <id> [flags]
```

#### `squint interactions delete`

Deletes an interaction.

```bash
squint interactions delete <id>
```

#### `squint interactions generate`

Detects module interactions from the call graph and generates semantics using LLM.

```bash
squint interactions generate [--force] [--dry-run] [-m <model>] [--json]
```

#### `squint interactions validate`

Validates LLM-inferred interactions using deterministic checks against the call graph.

```bash
squint interactions validate [flags]
```

#### `squint interactions verify`

Verifies existing interactions using LLM.

```bash
squint interactions verify [flags]
```

---

### flows

Manage user journey flows that trace paths through module interactions.

#### `squint flows list`

Lists all detected flows. Default when running `squint flows`.

```bash
squint flows [--domain <domain>] [--json]
```

#### `squint flows show`

Shows flow details with interaction steps.

```bash
squint flows show <name> [--json]
```

#### `squint flows create`

Creates a new flow.

```bash
squint flows create <name> [flags]
```

#### `squint flows update`

Updates a flow.

```bash
squint flows update <name> [flags]
```

#### `squint flows delete`

Deletes a flow.

```bash
squint flows delete <name>
```

#### `squint flows add-step`

Adds an interaction step to a flow.

```bash
squint flows add-step --flow <flow> --interaction <interaction-id> [--step-order <n>]
```

#### `squint flows remove-step`

Removes a step from a flow.

```bash
squint flows remove-step --flow <flow> --step-order <n>
```

#### `squint flows trace`

Traces the call graph from a symbol, showing reachable symbols as a tree.

```bash
squint flows trace --name <symbol> [--depth <n>] [--json]
```

#### `squint flows generate`

Detects user journey flows from entry points and traces through interactions.

```bash
squint flows generate [flags]
```

| Flag | Description |
|------|-------------|
| `--min-steps` | Minimum steps for a valid flow (default: 2) |
| `--max-depth` | Maximum traversal depth (default: 15) |
| `--domain` | Only detect flows in a specific domain |
| `--from` | Start from a specific entry point |
| `--dry-run` | Show detected flows without persisting |
| `--force` | Re-detect even if flows exist |
| `--skip-llm` | Skip LLM naming |
| `-m, --model` | LLM model alias |

#### `squint flows verify`

Verifies existing flows using LLM.

```bash
squint flows verify [flags]
```

---

### features

Manage product-level feature groupings of flows.

#### `squint features list`

Lists all features with flow counts. Default when running `squint features`.

```bash
squint features [--json]
```

#### `squint features show`

Shows feature details with associated flows.

```bash
squint features show <name> [--json]
```

#### `squint features create`

Creates a new feature.

```bash
squint features create <name> [flags]
```

#### `squint features update`

Updates a feature.

```bash
squint features update <name> [flags]
```

#### `squint features delete`

Deletes a feature.

```bash
squint features delete <name>
```

#### `squint features assign`

Assigns a flow to a feature.

```bash
squint features assign --feature <feature> --flow <flow>
```

#### `squint features unassign`

Removes a flow from a feature.

```bash
squint features unassign --feature <feature> --flow <flow>
```

#### `squint features generate`

Groups flows into product-level features using LLM.

```bash
squint features generate [--force] [--dry-run] [-m <model>] [--json]
```

---

### files

Explore the indexed file structure.

#### `squint files list`

Lists all indexed files. Default when running `squint files`.

```bash
squint files [--stats]
```

#### `squint files show`

Shows file details including definitions and imports.

```bash
squint files show <path>
```

#### `squint files imports`

Lists files imported by a specific file.

```bash
squint files imports <path>
```

#### `squint files imported-by`

Lists files that import a specific file.

```bash
squint files imported-by <path>
```

#### `squint files orphans`

Finds files with no incoming imports.

```bash
squint files orphans
```

---

### hierarchy

Shows class/interface inheritance trees or call hierarchies.

```bash
squint hierarchy [flags]
```

| Flag | Description |
|------|-------------|
| `--type` | Relationship type: `extends`, `implements`, `calls`, `imports`, `uses` (default: `extends`) |
| `--root` | Start from a specific symbol |
| `--depth` | Max depth (default: 10) |

```bash
squint hierarchy                                # All extends relationships
squint hierarchy --type calls --root main       # Call hierarchy from main()
squint hierarchy --type implements              # Interface implementations
```

---

### process-groups

#### `squint process-groups list`

Lists process groups (connected components in the import graph).

```bash
squint process-groups
```

---

## AI Agent Usage

Squint is designed for both human and AI-driven codebase exploration. Every `show` and `list` command supports the `--json` flag, which produces structured JSON output suitable for programmatic consumption by AI agents, scripts, and tooling.

### Exploration Strategy

The recommended approach is a **top-down drill-down**: start with the highest-level overview and progressively narrow focus into specific entities.

1. **Start with overview**: `squint overview --json` returns aggregate stats, the features list, the module tree, and the file tree. This gives the big picture.
2. **Drill into features**: `squint features show <slug> --json` returns enriched flows (with `stepCount`, `stakeholder`, `entryPath`), modules involved, interactions, and stats.
3. **Drill into flows**: `squint flows show <slug> --json` returns features, an entry point (with definition details and metadata), ordered interaction steps, modules involved, and the definition trace (function-level call chain).
4. **Drill into interactions**: `squint interactions show <id> --json` returns module descriptions, resolved symbols (matched to definitions), related interactions from the same source module, flows using this interaction, and features.
5. **Drill into modules**: `squint modules show <path> --json` returns parent, children, outgoing/incoming interactions, flows, features, and all member symbols.
6. **Drill into symbols**: `squint symbols show <name> --json` returns module, outgoing/incoming relationships, dependencies, dependents (with count), flows, source code, and call sites.
7. **Drill into files**: `squint files show <path> --json` returns definitions (enriched with module and metadata), imports, imported-by, and relationships.
8. **Drill into relationships**: `squint relationships show --from <id> --to <id> --json` returns metadata for both symbols, module context, the module interaction, and flows.
9. **Drill into domains**: `squint domains show <name> --json` returns symbols, module distribution, and intra-domain relationships.

### Show Command JSON Schemas

Each `show` command returns a JSON object. The schemas below document the top-level keys and their types.

#### `squint features show <id-or-slug> --json`

```json
{
  "id": 1,
  "name": "Authentication",
  "slug": "authentication",
  "description": "...",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "flows": [
    { "id": 1, "name": "UserLoginFlow", "slug": "user-login", "description": "...", "stakeholder": "user", "entryPath": "POST /api/login", "stepCount": 3 }
  ],
  "modulesInvolved": [
    { "id": 2, "name": "Controllers", "fullPath": "project.api.controllers" }
  ],
  "interactions": [
    { "id": 1, "fromModulePath": "project.api.controllers", "toModulePath": "project.services", "pattern": "business", "semantic": "..." }
  ],
  "stats": { "flowCount": 2, "byStakeholder": { "user": 2 } }
}
```

#### `squint flows show <identifier> --json`

```json
{
  "id": 1, "name": "UserLoginFlow", "slug": "user-login",
  "stakeholder": "user", "entryPath": "POST /api/login", "description": "...",
  "steps": [
    { "stepOrder": 1, "interaction": { "id": 1, "fromModulePath": "...", "toModulePath": "...", "pattern": "business", "semantic": "..." } }
  ],
  "features": [{ "id": 1, "name": "Authentication", "slug": "authentication" }],
  "entryPoint": { "id": 10, "name": "handleLogin", "kind": "function", "filePath": "src/controller.ts", "line": 5, "metadata": { "purpose": "..." } },
  "modulesInvolved": [{ "id": 2, "name": "Controllers", "fullPath": "project.api.controllers" }],
  "definitionSteps": [
    { "stepOrder": 1, "fromDefinitionName": "handleLogin", "toDefinitionName": "authenticate", "fromFilePath": "...", "toFilePath": "..." }
  ]
}
```

#### `squint interactions show <id> --json`

```json
{
  "interaction": { "id": 1, "fromModuleId": 2, "toModuleId": 3, "fromModulePath": "...", "toModulePath": "...", "direction": "uni", "pattern": "business", "semantic": "...", "weight": 5, "symbols": ["createUser"] },
  "fromModuleDescription": "Request handlers",
  "toModuleDescription": "Business logic",
  "resolvedSymbols": [{ "name": "createUser", "kind": "function", "filePath": "...", "line": 10 }],
  "relatedInteractions": [{ "id": 2, "toModulePath": "...", "pattern": "...", "semantic": "...", "weight": 1 }],
  "flows": [{ "id": 1, "name": "UserLoginFlow", "slug": "user-login" }],
  "features": [{ "id": 1, "name": "Authentication", "slug": "authentication" }]
}
```

#### `squint modules show <name> --json`

```json
{
  "id": 2, "name": "Controllers", "fullPath": "project.api.controllers", "description": "...", "depth": 2,
  "parent": { "id": 1, "name": "API", "fullPath": "project.api" },
  "children": [{ "id": 5, "name": "Auth", "fullPath": "project.api.controllers.auth", "description": "..." }],
  "outgoingInteractions": [{ "id": 1, "toModulePath": "...", "pattern": "business", "semantic": "...", "weight": 5 }],
  "incomingInteractions": [{ "id": 3, "fromModulePath": "...", "pattern": "...", "semantic": "...", "weight": 2 }],
  "flows": [{ "id": 1, "name": "UserLoginFlow", "slug": "user-login", "stakeholder": "user" }],
  "features": [{ "id": 1, "name": "Authentication", "slug": "authentication" }],
  "members": [{ "id": 10, "name": "handleLogin", "kind": "function", "filePath": "...", "line": 5 }]
}
```

#### `squint symbols show <name> --json`

```json
{
  "id": 10, "name": "handleLogin", "kind": "function", "filePath": "...", "line": 5, "endLine": 15, "isExported": true,
  "metadata": { "purpose": "...", "domain": "[\"auth\"]", "role": "controller" },
  "module": { "id": 2, "name": "Controllers", "fullPath": "project.api.controllers" },
  "relationships": [{ "toDefinitionId": 20, "toName": "authenticate", "toKind": "function", "relationshipType": "calls", "semantic": "...", "toFilePath": "...", "toLine": 10 }],
  "incomingRelationships": [{ "fromDefinitionId": 5, "fromName": "router", "fromKind": "variable", "relationshipType": "calls", "semantic": "...", "fromFilePath": "...", "fromLine": 3 }],
  "dependencies": [{ "id": 20, "name": "authenticate", "kind": "function", "filePath": "...", "line": 10 }],
  "dependents": { "count": 3, "sample": [{ "id": 5, "name": "router", "kind": "variable", "filePath": "...", "line": 3 }] },
  "flows": [{ "id": 1, "name": "UserLoginFlow", "slug": "user-login", "stakeholder": "user" }],
  "sourceCode": ["export async function handleLogin(req) {", "  ..."],
  "callSites": [{ "filePath": "...", "line": 20, "containingFunction": "router", "contextLines": ["..."], "contextStartLine": 18 }]
}
```

#### `squint files show <path> --json`

```json
{
  "file": { "id": 1, "path": "...", "language": "typescript", "sizeBytes": 1234 },
  "definitions": [
    { "id": 10, "name": "handleLogin", "kind": "function", "isExported": true, "line": 5, "endLine": 15, "module": { "id": 2, "name": "Controllers", "fullPath": "..." }, "metadata": { "purpose": "..." } }
  ],
  "imports": [{ "source": "./service", "toFilePath": "src/service.ts", "isExternal": false, "isTypeOnly": false }],
  "importedBy": [{ "id": 2, "path": "src/router.ts", "line": 1 }],
  "relationships": [{ "fromName": "handleLogin", "toName": "authenticate", "toFilePath": "...", "toLine": 10, "relationshipType": "calls", "semantic": "..." }]
}
```

#### `squint relationships show --from <id> --to <id> --json`

```json
{
  "relationship": { "id": 1, "fromDefinitionId": 10, "toDefinitionId": 20, "relationshipType": "calls", "semantic": "delegates authentication" },
  "from": { "id": 10, "name": "handleLogin", "kind": "function", "filePath": "...", "line": 5 },
  "to": { "id": 20, "name": "authenticate", "kind": "function", "filePath": "...", "line": 10 },
  "fromMetadata": { "purpose": "...", "domain": "[\"auth\"]" },
  "toMetadata": { "purpose": "..." },
  "fromModule": { "id": 2, "name": "Controllers", "fullPath": "project.api.controllers" },
  "toModule": { "id": 3, "name": "Services", "fullPath": "project.services" },
  "interaction": { "id": 1, "pattern": "business", "weight": 5, "semantic": "..." },
  "flows": [{ "id": 1, "name": "UserLoginFlow", "slug": "user-login" }]
}
```

#### `squint domains show <name> --json`

```json
{
  "domain": { "name": "auth", "description": "Authentication and authorization", "createdAt": "..." },
  "symbols": [{ "id": 10, "name": "handleLogin", "kind": "function", "filePath": "...", "line": 5, "purpose": "..." }],
  "moduleDistribution": [{ "id": 2, "name": "Controllers", "fullPath": "project.api.controllers", "count": 3 }],
  "intraDomainRelationships": [{ "fromName": "handleLogin", "toName": "authenticate", "relationshipType": "calls", "semantic": "..." }]
}
```

### Example Drill-Down Session

The following shows a concrete example of how an AI agent would explore a codebase using the top-down approach:

```bash
# 1. Get the big picture
squint overview --json

# 2. Explore the "Authentication" feature
squint features show authentication --json
# -> See 2 flows, 3 modules involved, 2 interactions

# 3. Drill into the registration flow
squint flows show user-registration --json
# -> See entry point handleRegister(), 2 interaction steps, definition trace

# 4. Understand the controller-to-service interaction
squint interactions show 1 --json
# -> See resolved symbols, module descriptions, related interactions

# 5. Examine the controller module's role
squint modules show project.api.controllers --json
# -> See 3 members, outgoing interactions, flows, features

# 6. Deep-dive into a specific symbol
squint symbols show handleRegister --json
# -> See module, relationships, dependencies, dependents, flows, source code
```

---

## Understanding Workflow

### Phase 1: Index and Explore

```bash
squint parse ./src
squint stats
squint symbols understood
```

### Phase 2: Annotate Symbols

**Automatic (LLM):**

```bash
squint symbols annotate -a purpose -a domain -a role
squint symbols verify
squint symbols understood
```

**Manual:**

```bash
squint symbols ready --aspect purpose
squint symbols next --aspect purpose
squint symbols set purpose "Validates user credentials" --name authenticate
```

### Phase 3: Annotate Relationships

```bash
squint relationships annotate
squint relationships verify
```

### Phase 4: Organize Domains

```bash
squint symbols --domains
squint domains create auth --description "Authentication and authorization"
squint symbols set domain '["auth"]' --name validateToken
```

### Phase 5: Detect Modules

```bash
squint modules generate
squint modules verify
squint modules --tree
```

### Phase 6: Detect Interactions

```bash
squint interactions generate
squint interactions validate
squint interactions verify
```

### Phase 7: Trace Flows

```bash
squint flows generate
squint flows verify
squint flows
```

### Phase 8: Group Features

```bash
squint features generate
squint features
```

### Phase 9: Overview

```bash
squint overview
squint browse
```

**Or run the entire pipeline at once:**

```bash
squint ingest ./src
```

---

## Database Schema

The SQLite database contains:

| Table | Description |
|-------|-------------|
| `metadata` | Index metadata (version, timestamp, source directory) |
| `files` | Indexed files with content hash and modification time |
| `definitions` | All symbol definitions with position and export info |
| `imports` | File import/export relationships |
| `symbols` | Imported symbols linked to their definitions |
| `usages` | Where each symbol is used in the codebase |
| `definition_metadata` | Key-value annotations on symbols |
| `relationship_annotations` | Semantic descriptions of symbol relationships |
| `domains` | Registered domain tags with descriptions |
| `modules` | Hierarchical module tree (parent, slug, path, description) |
| `module_members` | Symbol-to-module assignments |
| `interactions` | Module-to-module edges (direction, weight, pattern, semantic) |
| `flows` | User journey flows with entry points and stakeholders |
| `flow_steps` | Ordered interaction steps within flows |
| `flow_definition_steps` | Ordered definition-level call edges within flows |
| `features` | Product-level feature groupings |
| `feature_flows` | Flow-to-feature associations |

---

## Development

```bash
pnpm install
pnpm run build         # Build server + UI
pnpm run build:server  # Build server only
pnpm test              # Run tests
pnpm run test:watch    # Watch mode
pnpm run test:coverage # Coverage report
pnpm run typecheck     # Type checking
pnpm run lint          # Biome linter
pnpm run lint:fix      # Auto-fix lint issues
pnpm run format        # Format with Biome
pnpm run dev ./src     # Development mode (ts-node)
```

This project uses [conventional commits](https://www.conventionalcommits.org/). All commit messages are validated by commitlint. Releases are automated via semantic-release on merge to `main`.

## License

MIT
