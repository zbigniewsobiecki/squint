# ATS - AST Parser CLI

A command-line tool that indexes TypeScript and JavaScript files into an SQLite database, extracting definitions, references, and symbol usages.

## Installation

```bash
pnpm install
pnpm run build
```

## Usage

```bash
# Index a directory
./bin/run.js ./src

# Specify output database
./bin/run.js ./src -o index.db
```

## What It Extracts

**Definitions:**
- Functions, classes, variables, constants
- Interfaces, types, enums
- Export status (named, default)

**References:**
- Import statements
- Dynamic imports (`import()`)
- CommonJS requires
- Re-exports (`export { } from`)
- Export all (`export * from`)

**Symbol Usages:**
- Tracks where each imported symbol is used
- Records usage context (call expression, member access, etc.)

## Database Schema

The output SQLite database contains:

| Table | Description |
|-------|-------------|
| `metadata` | Index metadata (version, timestamp, source directory) |
| `files` | Indexed files with content hash |
| `definitions` | All definitions with position and export info |
| `imports` | File references (imports, requires, re-exports) |
| `symbols` | Imported symbols linked to their definitions |
| `usages` | Where each symbol is used in the codebase |

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

## Project Structure

```
src/
├── commands/
│   └── parse.ts          # CLI command and indexing orchestration
├── db/
│   └── database.ts       # SQLite database operations
├── parser/
│   ├── ast-parser.ts     # Tree-sitter parsing
│   ├── definition-extractor.ts
│   └── reference-extractor.ts
└── utils/
    └── file-scanner.ts   # File discovery

test/
├── fixtures/             # Test fixture files
├── commands/             # Orchestration tests
├── db/                   # Database tests
└── parser/               # Parser tests
```

## License

MIT
