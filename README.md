# ATS - Codebase Understanding Tool

ATS (AST Tool Suite) is a CLI for building semantic understanding of TypeScript and JavaScript codebases. It indexes source code into an SQLite database, then provides tools to systematically annotate symbols and relationships with human-readable descriptions.

**Use case**: When an AI agent or human needs to understand a codebase, ATS provides a structured workflow: index the code, identify what needs understanding, annotate symbols with their purpose, and document relationships between components.

## Installation

```bash
pnpm install
pnpm run build
```

## Quick Start

```bash
# 1. Index your codebase
ats parse ./src

# 2. Check what needs understanding
ats symbols understood

# 3. Find symbols ready to annotate (no unmet dependencies)
ats symbols ready --aspect purpose

# 4. View the next symbol to understand with its source code
ats symbols next --aspect purpose

# 5. Annotate the symbol
ats symbols set purpose "Validates user credentials against the database" --name authenticate

# 6. Annotate relationships between symbols
ats relationships next
ats relationships set "delegates authentication to service layer" --from loginController --to authService
```

---

## Command Reference

### `ats parse` - Index a Codebase

Scans TypeScript/JavaScript files and builds an SQLite index of definitions, references, and symbol usages.

```bash
ats parse <directory> [-o <output.db>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output` | `index.db` | Output database file path |

**Examples:**
```bash
ats parse ./src
ats parse ./src -o my-project.db
```

---

### `ats symbols` - List and Filter Symbols

Lists all symbols (functions, classes, variables, etc.) in the index.

```bash
ats symbols [flags]
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
ats symbols                           # List all symbols
ats symbols --kind function           # Only functions
ats symbols --missing purpose         # Symbols without purpose annotation
ats symbols --has purpose --kind class  # Classes with purpose set
ats symbols --domain auth             # Symbols tagged with "auth" domain
ats symbols --domains                 # List all domain tags in use
```

---

### `ats symbols show` - Inspect a Symbol

Shows detailed information about a specific symbol including its source code, callsites, and metadata.

```bash
ats symbols show <name> [flags]
ats symbols show --id <id> [flags]
```

| Flag | Description |
|------|-------------|
| `--id` | Look up by definition ID |
| `-f, --file` | Disambiguate by file path |
| `-c, --context-lines` | Lines of context around callsites (default: 3) |
| `--json` | Output as JSON |

**Examples:**
```bash
ats symbols show parseFile
ats symbols show --id 42
ats symbols show MyClass --file src/models/
ats symbols show authenticate --json
```

---

### `ats symbols set` - Annotate a Symbol

Sets metadata (annotations) on a symbol.

```bash
ats symbols set <key> <value> --name <symbol>
ats symbols set <key> <value> --id <id>
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
ats symbols set purpose "Parses TypeScript AST and extracts definitions" --name parseFile

# Set domain tags
ats symbols set domain '["auth", "security"]' --name validateToken

# Set architectural role
ats symbols set role "HTTP controller handling user requests" --name UserController

# Mark as pure (no side effects)
ats symbols set pure true --name calculateTotal

# Batch mode
echo '[{"name":"add","value":"Adds two numbers"},{"name":"sub","value":"Subtracts"}]' | \
  ats symbols set purpose --batch
```

---

### `ats symbols unset` - Remove Annotation

Removes a metadata key from a symbol.

```bash
ats symbols unset <key> --name <symbol>
ats symbols unset <key> --id <id>
```

---

### `ats symbols ready` - Find Symbols Ready to Understand

Lists symbols that are ready to annotate because all their dependencies already have the specified aspect annotated.

```bash
ats symbols ready --aspect <key> [flags]
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
ats symbols ready --aspect purpose                    # What's ready to annotate?
ats symbols ready --aspect purpose --kind function    # Only functions
ats symbols ready --aspect purpose --file src/parser/ # Only in parser/
ats symbols ready --aspect purpose --verbose          # Show dependency info
```

---

### `ats symbols next` - View Next Symbol to Understand

Shows the next symbol ready to understand with its full source code. This is the primary command for the annotation workflow.

```bash
ats symbols next --aspect <key> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | **(required)** The metadata key to check |
| `-c, --count` | Number of symbols to show (default: 1) |
| `-m, --max-lines` | Max source lines to display (default: 50, 0 = unlimited) |
| `--json` | Output as JSON |

**Examples:**
```bash
ats symbols next --aspect purpose           # Show next symbol to annotate
ats symbols next --aspect purpose --count 3 # Show next 3 symbols
ats symbols next --aspect purpose --json    # JSON output for automation
```

---

### `ats symbols deps` - View Symbol Dependencies

Shows what other symbols a given symbol depends on, with their annotation status.

```bash
ats symbols deps <name> [flags]
ats symbols deps --id <id> [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | Highlight status of specific aspect |
| `--json` | Output as JSON |

**Examples:**
```bash
ats symbols deps parseFile                    # What does parseFile depend on?
ats symbols deps parseFile --aspect purpose   # Show which deps have purpose set
```

---

### `ats symbols prereqs` - View Prerequisites

Shows unmet dependencies in topological order - what you need to understand first before understanding a target symbol.

```bash
ats symbols prereqs <name> --aspect <key>
```

**Examples:**
```bash
ats symbols prereqs IndexDatabase --aspect purpose
```

---

### `ats symbols understood` - Coverage Report

Shows understanding coverage statistics per aspect.

```bash
ats symbols understood [flags]
```

| Flag | Description |
|------|-------------|
| `-a, --aspect` | Show only specific aspect |
| `-k, --kind` | Filter by symbol kind |
| `-f, --file` | Filter to symbols in path |
| `--json` | Output as JSON |

**Examples:**
```bash
ats symbols understood                        # Overall coverage
ats symbols understood --kind function        # Function coverage only
ats symbols understood --file src/parser/     # Coverage for parser module
```

---

### `ats domains` - Manage Domain Tags

Domains are business/architectural tags that group related symbols (e.g., "auth", "payment", "user").

#### List Domains
```bash
ats domains                  # List registered domains with symbol counts
ats domains --unregistered   # Show domains in use but not registered
ats domains --json           # JSON output
```

#### Register a Domain
```bash
ats domains add <name> [--description "..."]
```

#### Rename a Domain
Renames in registry and updates all symbol metadata:
```bash
ats domains rename <old-name> <new-name>
```

#### Merge Domains
Merges source domain into target, updating all symbols:
```bash
ats domains merge <from-domain> <into-domain>
```

#### Remove a Domain
```bash
ats domains remove <name>          # Fails if symbols still use it
ats domains remove <name> --force  # Remove anyway
```

#### Sync Domains
Bulk-register all domains currently in use:
```bash
ats domains sync
```

---

### `ats relationships` - Manage Relationship Annotations

Relationships describe *why* one symbol calls/uses another.

#### List Relationships
```bash
ats relationships                    # List all annotated relationships
ats relationships --from Controller  # Filter by source symbol
ats relationships --to AuthService   # Filter by target symbol
ats relationships --count            # Just show count
ats relationships --json             # JSON output
```

#### View Next Relationship to Annotate
Shows unannotated relationships with rich context including both symbols' metadata, other relationships, and shared domains:

```bash
ats relationships next                    # Show next relationship to annotate
ats relationships next --count 5          # Show next 5
ats relationships next --from Controller  # Only from this symbol
ats relationships next --json             # JSON output for automation
```

#### Annotate a Relationship
```bash
ats relationships set "<semantic description>" --from <source> --to <target>
ats relationships set "<semantic description>" --from-id <id> --to-id <id>
```

**Examples:**
```bash
ats relationships set "delegates credential validation" --from loginController --to authService
ats relationships set "persists user data to PostgreSQL" --from-id 42 --to-id 15
```

#### Remove a Relationship Annotation
```bash
ats relationships unset --from <source> --to <target>
```

---

### `ats files` - Explore File Structure

#### List Files
```bash
ats files                # List all indexed files
ats files --stats        # Include import statistics
```

#### View File Imports
```bash
ats files imports <path>      # What does this file import?
ats files imported-by <path>  # What files import this file?
ats files orphans             # Find files with no incoming imports
```

---

### `ats browse` - Interactive Code Browser

Launches a web-based visualization of the codebase.

```bash
ats browse                 # Open browser at localhost:3000
ats browse -p 8080         # Use different port
ats browse --no-open       # Don't auto-open browser
```

---

## Understanding Workflow

The recommended process for systematically understanding a codebase:

### Phase 1: Index and Explore

```bash
# Index the codebase
ats parse ./src

# Get an overview
ats symbols                    # How many symbols?
ats symbols --kind function    # How many functions?
ats files --stats              # File structure

# Check current understanding coverage
ats symbols understood
```

### Phase 2: Annotate Symbols (Bottom-Up)

The tool enforces a bottom-up approach: you can only annotate a symbol once all its dependencies are annotated. This ensures you build understanding from foundational code upward.

```bash
# Find symbols ready to annotate (leaves first)
ats symbols ready --aspect purpose

# View the next symbol with source code
ats symbols next --aspect purpose

# Annotate it
ats symbols set purpose "Computes SHA-256 hash of file content" --name computeHash

# Repeat until coverage is complete
ats symbols understood
```

### Phase 3: Organize with Domains

As patterns emerge, organize symbols into business domains:

```bash
# See what domains are in use
ats symbols --domains

# Register domains with descriptions
ats domains add auth "Authentication and authorization"
ats domains add user "User management and profiles"

# Tag symbols with domains
ats symbols set domain '["auth"]' --name validateToken
ats symbols set domain '["auth", "user"]' --name loginUser

# Query by domain
ats symbols --domain auth
```

### Phase 4: Annotate Relationships

Once symbols are understood, document why they interact:

```bash
# Find relationships needing annotation
ats relationships next

# The output shows:
# - Both symbols' metadata (purpose, domains, role)
# - Other relationships for context
# - Source code around the call site

# Annotate the relationship
ats relationships set "validates credentials before creating session" \
  --from loginController --to authService

# Track progress
ats relationships --count
```

### Phase 5: Ongoing Maintenance

As the codebase evolves, keep annotations current:

```bash
# Re-index to pick up changes
ats parse ./src

# Find new symbols needing annotation
ats symbols --missing purpose

# Check for orphan files (possibly dead code)
ats files orphans
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
ats symbols set purpose -i annotations.json
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
