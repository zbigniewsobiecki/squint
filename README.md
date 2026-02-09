# Squint — Codebase Understanding Tool

Squint is an AST + LLM driven tool for codebase analysis and visualization. It indexes TypeScript and JavaScript source code into an SQLite database, then provides tools to systematically annotate symbols and relationships with human-readable descriptions.

**Use case**: When an AI agent or human needs to understand a codebase, Squint provides a structured workflow: index the code, identify what needs understanding, annotate symbols with their purpose, and document relationships between components.

## Installation

```bash
pnpm install
pnpm run build
```

## Quick Start

**Full automated pipeline:**
```bash
# Index, annotate, detect modules and flows in one go
squint parse ./src -o index.db && \
squint llm annotate -a purpose -a domain -a role && \
squint llm modules && \
squint llm flows
```

**Manual workflow:**
```bash
# 1. Index your codebase
squint parse ./src

# 2. Check what needs understanding
squint symbols understood

# 3. Find symbols ready to annotate (no unmet dependencies)
squint symbols ready --aspect purpose

# 4. View the next symbol to understand with its source code
squint symbols next --aspect purpose

# 5. Annotate the symbol
squint symbols set purpose "Validates user credentials against the database" --name authenticate

# 6. Annotate relationships between symbols
squint relationships next
squint relationships set "delegates authentication to service layer" --from loginController --to authService
```

---

## Command Reference

### `squint parse` - Index a Codebase

Scans TypeScript/JavaScript files and builds an SQLite index of definitions, references, and symbol usages.

```bash
squint parse <directory> [-o <output.db>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output` | `index.db` | Output database file path |

**Examples:**
```bash
squint parse ./src
squint parse ./src -o my-project.db
```

---

### `squint symbols` - List and Filter Symbols

Lists all symbols (functions, classes, variables, etc.) in the index.

```bash
squint symbols [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `--kind` | Filter by kind: `function`, `class`, `variable`, `type`, `interface`, `enum` |
| `--file` | Filter to symbols in a specific file |
| `--has <key>` | Filter to symbols that have this metadata key |
| `--missing <key>` | Filter to symbols missing this metadata key |
| `--domain <name>` | Filter to symbols with this domain tag |
| `--pure <bool>` | Filter by purity (`true` or `false`) |
| `--domains` | List all unique domains in use |

**Examples:**
```bash
squint symbols                           # List all symbols
squint symbols --kind function           # Only functions
squint symbols --missing purpose         # Symbols without purpose annotation
squint symbols --has purpose --kind class  # Classes with purpose set
squint symbols --domain auth             # Symbols tagged with "auth" domain
squint symbols --domains                 # List all domain tags in use
```

---

### `squint symbols show` - Inspect a Symbol

Shows detailed information about a specific symbol including its source code, callsites, and metadata.

```bash
squint symbols show <name> [flags]
squint symbols show --id <id> [flags]
```

| Flag | Description |
|------|-------------|
| `--id` | Look up by definition ID |
| `-f, --file` | Disambiguate by file path |
| `-c, --context-lines` | Lines of context around callsites (default: 3) |
| `--json` | Output as JSON |

**Examples:**
```bash
squint symbols show parseFile
squint symbols show --id 42
squint symbols show MyClass --file src/models/
squint symbols show authenticate --json
```

---

### `squint symbols set` - Annotate a Symbol

Sets metadata (annotations) on a symbol.

```bash
squint symbols set <key> <value> --name <symbol>
squint symbols set <key> <value> --id <id>
```

| Flag | Description |
|------|-------------|
| `-n, --name` | Symbol name |
| `--id` | Definition ID |
| `-f, --file` | Disambiguate by file path |
| `--batch` | Read symbol-value pairs from stdin (JSON array) |
| `-i, --input-file` | Read batch input from file |
| `--json` | Output as JSON (batch mode) |

**Common metadata keys:**
- `purpose` - What the symbol does and why it exists
- `domain` - Business domains (JSON array: `'["auth", "user"]'`)
- `role` - Architectural role (e.g., "controller", "service", "repository")
- `pure` - Whether the function has side effects (`true` or `false`)

**Examples:**
```bash
# Set purpose
squint symbols set purpose "Parses TypeScript AST and extracts definitions" --name parseFile

# Set domain tags
squint symbols set domain '["auth", "security"]' --name validateToken

# Set architectural role
squint symbols set role "HTTP controller handling user requests" --name UserController

# Mark as pure (no side effects)
squint symbols set pure true --name calculateTotal

# Batch mode
echo '[{"name":"add","value":"Adds two numbers"},{"name":"sub","value":"Subtracts"}]' | \
  squint symbols set purpose --batch
```

---

### `squint symbols unset` - Remove Annotation

Removes a metadata key from a symbol.

```bash
squint symbols unset <key> --name <symbol>
squint symbols unset <key> --id <id>
```

---

### `squint symbols ready` - Find Symbols Ready to Understand

Lists symbols that are ready to annotate because all their dependencies already have the specified aspect annotated.

```bash
squint symbols ready --aspect <key> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | **(required)** The metadata key to check |
| `-l, --limit` | Maximum results (default: 20) |
| `-k, --kind` | Filter by symbol kind |
| `-f, --file` | Filter to symbols in path |
| `-v, --verbose` | Show dependency metadata inline |
| `--json` | Output as JSON |

**Examples:**
```bash
squint symbols ready --aspect purpose                    # What's ready to annotate?
squint symbols ready --aspect purpose --kind function    # Only functions
squint symbols ready --aspect purpose --file src/parser/ # Only in parser/
squint symbols ready --aspect purpose --verbose          # Show dependency info
```

---

### `squint symbols next` - View Next Symbol to Understand

Shows the next symbol ready to understand with its full source code. This is the primary command for the annotation workflow.

```bash
squint symbols next --aspect <key> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | **(required)** The metadata key to check |
| `-c, --count` | Number of symbols to show (default: 1) |
| `-m, --max-lines` | Max source lines to display (default: 50, 0 = unlimited) |
| `--json` | Output as JSON |

**Examples:**
```bash
squint symbols next --aspect purpose           # Show next symbol to annotate
squint symbols next --aspect purpose --count 3 # Show next 3 symbols
squint symbols next --aspect purpose --json    # JSON output for automation
```

---

### `squint symbols deps` - View Symbol Dependencies

Shows what other symbols a given symbol depends on, with their annotation status.

```bash
squint symbols deps <name> [flags]
squint symbols deps --id <id> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | Highlight status of specific aspect |
| `--json` | Output as JSON |

**Examples:**
```bash
squint symbols deps parseFile                    # What does parseFile depend on?
squint symbols deps parseFile --aspect purpose   # Show which deps have purpose set
```

---

### `squint symbols prereqs` - View Prerequisites

Shows unmet dependencies in topological order - what you need to understand first before understanding a target symbol.

```bash
squint symbols prereqs <name> --aspect <key>
```

**Examples:**
```bash
squint symbols prereqs IndexDatabase --aspect purpose
```

---

### `squint symbols understood` - Coverage Report

Shows understanding coverage statistics per aspect.

```bash
squint symbols understood [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | Show only specific aspect |
| `-k, --kind` | Filter by symbol kind |
| `-f, --file` | Filter to symbols in path |
| `--json` | Output as JSON |

**Examples:**
```bash
squint symbols understood                        # Overall coverage
squint symbols understood --kind function        # Function coverage only
squint symbols understood --file src/parser/     # Coverage for parser module
```

---

### `squint domains` - Manage Domain Tags

Domains are business/architectural tags that group related symbols (e.g., "auth", "payment", "user").

#### List Domains
```bash
squint domains                  # List registered domains with symbol counts
squint domains --unregistered   # Show domains in use but not registered
squint domains --json           # JSON output
```

#### Register a Domain
```bash
squint domains add <name> [--description "..."]
```

#### Rename a Domain
Renames in registry and updates all symbol metadata:
```bash
squint domains rename <old-name> <new-name>
```

#### Merge Domains
Merges source domain into target, updating all symbols:
```bash
squint domains merge <from-domain> <into-domain>
```

#### Remove a Domain
```bash
squint domains remove <name>          # Fails if symbols still use it
squint domains remove <name> --force  # Remove anyway
```

#### Sync Domains
Bulk-register all domains currently in use:
```bash
squint domains sync
```

---

### `squint relationships` - Manage Relationship Annotations

Relationships describe *why* one symbol calls/uses another.

#### List Relationships
```bash
squint relationships                    # List all annotated relationships
squint relationships --from Controller  # Filter by source symbol
squint relationships --to AuthService   # Filter by target symbol
squint relationships --count            # Just show count
squint relationships --json             # JSON output
```

#### View Next Relationship to Annotate
Shows unannotated relationships with rich context including both symbols' metadata, other relationships, and shared domains:

```bash
squint relationships next                    # Show next relationship to annotate
squint relationships next --count 5          # Show next 5
squint relationships next --from Controller  # Only from this symbol
squint relationships next --json             # JSON output for automation
```

#### Annotate a Relationship
```bash
squint relationships set "<semantic description>" --from <source> --to <target>
squint relationships set "<semantic description>" --from-id <id> --to-id <id>
```

**Examples:**
```bash
squint relationships set "delegates credential validation" --from loginController --to authService
squint relationships set "persists user data to PostgreSQL" --from-id 42 --to-id 15
```

#### Remove a Relationship Annotation
```bash
squint relationships unset --from <source> --to <target>
```

---

### `squint llm annotate` - Bulk Annotate Symbols with LLM

Uses an LLM to automatically annotate symbols with metadata like purpose, domain, and role. Processes symbols in batches, respecting the dependency order (leaves first).

```bash
squint llm annotate -a <aspect> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | **(required)** Metadata key to annotate (can repeat: `-a purpose -a domain`) |
| `-d, --database` | Path to database (default: `index.db`) |
| `-m, --model` | LLM model alias (default: `sonnet`) |
| `-b, --batch-size` | Symbols per LLM call (default: 5) |
| `--max-iterations` | Maximum iterations, 0 = unlimited (default: 0) |
| `-k, --kind` | Filter by symbol kind |
| `-f, --file` | Filter by file path pattern |
| `-x, --exclude` | Glob pattern to exclude (e.g., `**/*.test.ts`) |
| `--force` | Annotate even if dependencies aren't annotated |
| `--dry-run` | Parse LLM output but don't persist |
| `--json` | Output as JSON |

**Examples:**
```bash
# Annotate all symbols with purpose
squint llm annotate --aspect purpose

# Annotate multiple aspects at once
squint llm annotate --aspect purpose --aspect domain --aspect role

# Use a different model with larger batches
squint llm annotate --aspect purpose --model gpt4o --batch-size 10

# Only annotate functions, exclude tests
squint llm annotate --aspect purpose --kind function --exclude "**/*.test.ts"

# Preview without saving
squint llm annotate --aspect purpose --dry-run

# Limit iterations for incremental annotation
squint llm annotate --aspect purpose --max-iterations 5
```

**Workflow:**
The command processes symbols bottom-up (dependencies first), so annotations build on already-understood code. Use `--force` to skip dependency checking.

---

### `squint llm modules` - Detect Architectural Modules

Uses a two-phase LLM approach to create a hierarchical module structure:

**Phase 1: Module Tree Design**
The LLM analyzes the overall codebase structure (file paths, symbol patterns, domains) to design a hierarchical module tree with dot-notation paths like `project.backend.services.auth`.

**Phase 2: Symbol Assignment**
Symbols are assigned to leaf modules in batches. The LLM receives symbol metadata (name, kind, purpose, domain, file path) and assigns each to the most appropriate module.

```bash
squint llm modules [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `-b, --batch-size` | Symbols per assignment batch (default: 30) |
| `--dry-run` | Show detected modules without persisting |
| `--force` | Re-detect even if modules exist |
| `-m, --model` | LLM model for detection (default: sonnet) |
| `--json` | Output as JSON |

**Examples:**
```bash
# Detect modules with default settings
squint llm modules

# Dry run to preview detection
squint llm modules --dry-run

# Use faster model with larger batches
squint llm modules --model haiku --batch-size 50

# Re-detect and overwrite existing modules
squint llm modules --force
```

**Module Structure:**
Modules are organized hierarchically with dot-notation paths:
- `project` - Root module for the codebase
- `project.backend` - Backend subsystem
- `project.backend.services` - Service layer
- `project.backend.services.auth` - Authentication service (leaf with members)

**Web UI:**
The web UI (`squint web`) displays modules as an interactive tree with:
- Expandable/collapsible hierarchy
- Member counts at each level
- Click to view module members
- Visual tree lines showing parent-child relationships

---

### `squint llm flows` - Detect Execution Flows

Traces execution paths from entry points (controllers, routes, handlers) through the call graph to detect end-to-end flows. Optionally uses LLM to name and describe the flows.

```bash
squint llm flows [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `--min-steps` | Minimum steps for a valid flow (default: 2) |
| `--max-depth` | Maximum traversal depth (default: 15) |
| `--domain` | Only detect flows in a specific domain |
| `--from` | Start from a specific entry point (name pattern) |
| `--dry-run` | Show detected flows without persisting |
| `--force` | Re-detect even if flows exist |
| `--skip-llm` | Skip LLM naming (use auto-generated names) |
| `-m, --model` | LLM model for naming (default: sonnet) |
| `--json` | Output as JSON |

**Examples:**
```bash
# Detect all flows
squint llm flows

# Preview flows without persisting
squint llm flows --dry-run --skip-llm

# Only detect flows starting from sales controllers
squint llm flows --from sales --domain sales-management

# Limit traversal depth for simpler flows
squint llm flows --max-depth 5 --min-steps 3
```

**Entry Points:**
The command identifies entry points by:
- Symbols with `role=controller` metadata
- Names containing "Controller" or "Handler"
- Exported functions in `/routes/`, `/controllers/`, or `/handlers/` directories

**Output Example:**
```
Flow: CreateSale
  Domain: sales-management
  Entry: SalesController.create (controller)

  Steps:
    1. SalesController.create [controller]
    2. salesService.createSale [service]
    3. vehicleService.updateStatus [service]
    4. saleModel.insert [repository]
    5. vehicleModel.update [repository]

  Modules crossed: SalesAPI → SalesService → VehicleService → DataLayer
```

---

### `squint files` - Explore File Structure

#### List Files
```bash
squint files                # List all indexed files
squint files --stats        # Include import statistics
```

#### View File Imports
```bash
squint files imports <path>      # What does this file import?
squint files imported-by <path>  # What files import this file?
squint files orphans             # Find files with no incoming imports
```

---

### `squint modules` - View Detected Modules

Lists modules detected by `squint llm modules`. Modules are organized hierarchically with dot-notation paths (e.g., `project.backend.services.auth`) representing architectural boundaries.

```bash
squint modules [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `--tree` | Display modules as a hierarchical tree |
| `--json` | Output as JSON |

**Examples:**
```bash
squint modules                    # List all modules with paths
squint modules --tree             # Show as hierarchical tree
squint modules --json             # JSON output for automation
```

**Output (tree view):**
```
Module Tree (8 modules, 156 symbols assigned)

project
├── backend
│   ├── controllers (12 members) - HTTP request handlers
│   ├── services (28 members) - Business logic layer
│   │   ├── auth (8 members) - Authentication logic
│   │   └── user (10 members) - User management
│   └── repositories (18 members) - Data access layer
└── shared
    └── utils (14 members) - Common utilities

15 definitions not assigned to any module
```

**Output (flat list):**
```
Modules (8 total, 156 assigned)

Path                              Members  Description
────────────────────────────────────────────────────────────
project                           0        Root module
project.backend                   0        Backend application
project.backend.controllers       12       HTTP request handlers
project.backend.services          28       Business logic layer
project.backend.services.auth     8        Authentication logic
...
```

#### `squint modules show` - View Module Details

Shows detailed information about a specific module including all its members.

```bash
squint modules show <name> [flags]
```

**Examples:**
```bash
squint modules show auth                        # Show auth module details
squint modules show project.backend.services    # Show by full path
squint modules show services --json             # JSON output
```

**Output:**
```
Module: auth
Full Path: project.backend.services.auth
Description: Authentication and session management

Members (8):
  Name                  Kind          Location
  ───────────────────────────────────────────────────────
  validateToken         function      src/auth/validate.ts
  hashPassword          function      src/auth/hash.ts
  AuthService           class         src/auth/service.ts
  ...
```

---

### `squint flows` - View Detected Flows

Lists execution flows detected by `squint llm flows`. Flows trace request paths from entry points through the call graph.

```bash
squint flows [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `--domain` | Filter by domain |
| `--json` | Output as JSON |

**Examples:**
```bash
squint flows                    # List all flows with step counts
squint flows --domain user      # Only user-domain flows
squint flows --json             # JSON output for automation
```

**Output:**
```
Flows (5 total, 47 steps)

Name                Entry Point          Steps  Modules Crossed
────────────────────────────────────────────────────────────────
user-registration   handleRegister       8      auth, user, db
login               handleLogin          6      auth, session
checkout            processCheckout      12     cart, payment, inventory
```

#### `squint flows show` - View Flow Details

Shows detailed information about a specific flow including all its steps.

```bash
squint flows show <name> [flags]
```

**Examples:**
```bash
squint flows show user-registration        # Show flow details
squint flows show login --json             # JSON output
```

**Output:**
```
Flow: user-registration
Entry: handleRegister (function) - src/api/user.ts:45
Domain: user

Steps (8):
  #   Name                  Kind          Module          Layer
  ────────────────────────────────────────────────────────────────
  1   validateInput         function      user-api        controller
  2   hashPassword          function      auth            service
  3   createUser            function      user            service
  4   insertUser            function      database        repository
  ...
```

#### `squint flows trace` - Trace Execution Path

Traces the call graph from a specific entry point, showing reachable symbols as a tree. This is useful for ad-hoc exploration before flows are formally detected.

```bash
squint flows trace [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `-n, --name` | Symbol name to trace from |
| `--id` | Definition ID to trace from |
| `--depth` | Max traversal depth (default: 10) |
| `-f, --file` | Disambiguate by file path |
| `--json` | Output as JSON |

**Examples:**
```bash
squint flows trace --name handleRegister              # Trace from handleRegister
squint flows trace --id 42 --depth 5                  # Trace by ID, limit depth
squint flows trace --name processPayment --json       # JSON output
```

**Output:**
```
Trace from: handleRegister (src/api/user.ts:45)

handleRegister
    └── [1] validateInput (user-api) [controller]
    └── [1] hashPassword (auth) [service]
        └── [2] bcryptHash
    └── [1] createUser (user) [service]
        └── [2] insertUser (database) [repository]
        └── [2] sendWelcomeEmail (notifications)

12 nodes traced (max depth: 10)
```

---

### `squint hierarchy` - View Inheritance and Call Hierarchies

Shows class/interface inheritance trees or call hierarchies between symbols.

```bash
squint hierarchy [flags]
```

| Flag | Description |
|------|-------------|
| `-d, --database` | Path to database (default: `index.db`) |
| `--type` | Relationship type: `extends`, `implements`, `calls`, `imports`, `uses` (default: `extends`) |
| `--root` | Start from specific symbol (required for `calls` type) |
| `-f, --file` | Disambiguate root symbol by file path |
| `--depth` | Max depth for call/import hierarchies (default: 10) |
| `--json` | Output as JSON |

**Examples:**
```bash
# Class inheritance hierarchy
squint hierarchy                              # Show all extends relationships
squint hierarchy --type extends               # Same as above
squint hierarchy --type implements            # Show interface implementations

# Call hierarchy from a specific function
squint hierarchy --type calls --root main     # Show what main() calls
squint hierarchy --type calls --root IndexDatabase --depth 3

# Annotated relationships
squint hierarchy --type uses                  # Show uses relationships from annotations
```

**Output (extends):**
```
Class Hierarchy (extends)

BaseController (class)
├── UserController (class)
│   └── AdminController (class)
└── AuthController (class)

BaseService (class)
├── UserService (class)
└── AuthService (class)

(3 roots, 7 total nodes)
```

**Output (calls):**
```
Call Hierarchy from: main

main (function)
├── parseArgs (function)
├── loadConfig (function)
│   └── readFile (function)
└── startServer (function)
    ├── createRoutes (function)
    └── listen (function)

(6 nodes, max depth: 10)
```

---

### `squint browse` - Interactive Code Browser

Launches a web-based visualization of the codebase.

```bash
squint browse                 # Open browser at localhost:3000
squint browse -p 8080         # Use different port
squint browse --no-open       # Don't auto-open browser
```

---

## Understanding Workflow

The recommended process for systematically understanding a codebase:

### Phase 1: Index and Explore

```bash
# Index the codebase
squint parse ./src

# Get an overview
squint symbols                    # How many symbols?
squint symbols --kind function    # How many functions?
squint files --stats              # File structure

# Check current understanding coverage
squint symbols understood
```

### Phase 2: Annotate Symbols (Bottom-Up)

The tool enforces a bottom-up approach: you can only annotate a symbol once all its dependencies are annotated. This ensures you build understanding from foundational code upward.

**Option A: Automatic LLM annotation**
```bash
# Annotate all symbols with LLM (recommended for initial pass)
squint llm annotate --aspect purpose --aspect domain --aspect role

# Check coverage
squint symbols understood
```

**Option B: Manual annotation**
```bash
# Find symbols ready to annotate (leaves first)
squint symbols ready --aspect purpose

# View the next symbol with source code
squint symbols next --aspect purpose

# Annotate it
squint symbols set purpose "Computes SHA-256 hash of file content" --name computeHash

# Repeat until coverage is complete
squint symbols understood
```

### Phase 3: Organize with Domains

As patterns emerge, organize symbols into business domains:

```bash
# See what domains are in use
squint symbols --domains

# Register domains with descriptions
squint domains add auth "Authentication and authorization"
squint domains add user "User management and profiles"

# Tag symbols with domains
squint symbols set domain '["auth"]' --name validateToken
squint symbols set domain '["auth", "user"]' --name loginUser

# Query by domain
squint symbols --domain auth
```

### Phase 4: Annotate Relationships

Once symbols are understood, document why they interact:

```bash
# Find relationships needing annotation
squint relationships next

# The output shows:
# - Both symbols' metadata (purpose, domains, role)
# - Other relationships for context
# - Source code around the call site

# Annotate the relationship
squint relationships set "validates credentials before creating session" \
  --from loginController --to authService

# Track progress
squint relationships --count
```

### Phase 5: Detect Architecture (Modules & Flows)

Once symbols are annotated with purpose and domain, detect higher-level structures:

```bash
# Detect hierarchical module tree (two-phase LLM approach)
squint llm modules --dry-run               # Preview module tree
squint llm modules                          # Detect and persist

# View modules as tree
squint modules --tree

# Detect execution flows (request paths through the system)
squint llm flows --dry-run --skip-llm      # Preview
squint llm flows                           # Detect and persist

# View detected modules and flows via the web UI
squint web
# The Modules view shows an interactive tree
# API endpoints: /api/modules, /api/flows
```

### Phase 6: Ongoing Maintenance

As the codebase evolves, keep annotations current:

```bash
# Re-index to pick up changes
squint parse ./src

# Find new symbols needing annotation
squint symbols --missing purpose

# Check for orphan files (possibly dead code)
squint files orphans
```

---

## Batch Annotation

For automation or bulk updates, use batch mode:

```bash
# Create a JSON file with annotations
cat > annotations.json << 'EOF'
[
  {"name": "parseFile", "value": "Parses a TypeScript file into an AST"},
  {"name": "extractDefs", "value": "Extracts definitions from AST"},
  {"name": "buildIndex", "value": "Builds searchable index from definitions"}
]
EOF

# Apply all at once
squint symbols set purpose -i annotations.json
```

---

## Database Schema

The SQLite database contains:

| Table | Description |
|-------|-------------|
| `metadata` | Index metadata (version, timestamp, source directory) |
| `files` | Indexed files with content hash and modification time |
| `definitions` | All symbol definitions with position and export info |
| `imports` | File references (imports, requires, re-exports) |
| `symbols` | Imported symbols linked to their definitions |
| `usages` | Where each symbol is used in the codebase |
| `definition_metadata` | Key-value annotations on symbols |
| `relationship_annotations` | Semantic descriptions of symbol relationships |
| `domains` | Registered domain tags with descriptions |
| `modules` | Detected architectural modules with layer and subsystem |
| `module_members` | Mapping of definitions to modules with confidence scores |
| `flows` | Detected execution flows with entry points and domains |
| `flow_steps` | Ordered steps in each flow with module and layer info |

---

## Development

```bash
# Build
pnpm run build

# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Development mode (uses ts-node)
pnpm run dev ./src
```

## License

MIT
