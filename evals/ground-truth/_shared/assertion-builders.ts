import {
  type GroundTruthDefinitionMetadata,
  type GroundTruthRelationship,
  type MetadataAssertion,
  type RelationshipType,
  defKey,
} from '../../harness/types.js';

/**
 * PR4: assertion builders for the property-based metadata GT.
 *
 * These wrap the common patterns so migrated GT files stay one-line per
 * entry. The builders deliberately enforce paired any-of/none-of for
 * `domain` (so the LLM has to be both relevant AND not-wrong) and a
 * non-empty floor (so an empty array doesn't pass vacuously).
 *
 * Authoring philosophy:
 *   - tag-any-of concepts are CONCEPTS, not exact tags. Use 'book' to
 *     match 'book-catalog', 'books', 'bookstore', etc.
 *   - tag-none-of catches the failure modes the LLM keeps producing.
 *     Pair every any-of with a none-of so over-broad LLM tags fail.
 *   - For purpose, pair string-contains anyOf (required topic) with
 *     string-forbid (banned topics).
 *
 * SUBSTRING TRAP — verb stems vs gerunds:
 *   The matcher does case-insensitive substring containment, NOT
 *   word-form-aware matching. The naive needle 'create' will NOT match
 *   the LLM's "creating" because the trailing 'e' diverges from the 'i'.
 *   Same trap for 'update'/'updating', 'delete'/'deleting',
 *   'complete'/'completing', 'serialize'/'serializing'.
 *
 *   Workarounds:
 *   1. Use the verb stem: 'creat' matches both 'create' and 'creating'.
 *   2. Pair the verb with broad nouns: ['create', 'manage', 'operation']
 *      — even if 'create' misses a gerund, the noun still hits.
 *   3. Include both forms explicitly: ['create', 'creating'].
 */

interface AssertedDomainOptions {
  /** At least one of these substrings must appear in the produced tags. */
  anyOf: string[];
  /** None of these substrings may appear. Defaults to empty (no ban). */
  noneOf?: string[];
  /** Minimum tag count. Default 1 (non-empty). */
  min?: number;
}

/**
 * Build a `domain` aspect entry that asserts:
 *   1. tag count >= min (default 1)
 *   2. at least one of `anyOf` substrings appears in the tags
 *   3. none of `noneOf` substrings appear in the tags
 */
export function assertedDomain(file: string, name: string, opts: AssertedDomainOptions): GroundTruthDefinitionMetadata {
  const assertions: MetadataAssertion[] = [
    { kind: 'tag-floor', label: 'has tags', min: opts.min ?? 1 },
    { kind: 'tag-any-of', label: `tags about ${opts.anyOf.join('/')}`, anyOf: opts.anyOf },
  ];
  if (opts.noneOf && opts.noneOf.length > 0) {
    assertions.push({
      kind: 'tag-none-of',
      label: `tags not about ${opts.noneOf.join('/')}`,
      noneOf: opts.noneOf,
    });
  }
  return {
    defKey: defKey(file, name),
    key: 'domain',
    assertions,
  };
}

interface AssertedPurposeOptions {
  /** ALL of these substrings must appear in the produced purpose. */
  mentions?: string[];
  /** At least one of these substrings must appear (or operator). */
  anyOf?: string[];
  /** None of these substrings may appear (banned topics). */
  forbids?: string[];
}

/**
 * Build a `purpose` aspect entry that asserts:
 *   1. ALL `mentions` substrings appear (and-required)
 *   2. at least one `anyOf` substring appears (or-required)
 *   3. NONE of `forbids` substrings appear
 */
export function assertedPurpose(
  file: string,
  name: string,
  opts: AssertedPurposeOptions
): GroundTruthDefinitionMetadata {
  const assertions: MetadataAssertion[] = [];
  if (opts.mentions && opts.mentions.length > 0) {
    assertions.push({
      kind: 'string-contains',
      label: `mentions ${opts.mentions.join('/')}`,
      substrings: opts.mentions,
    });
  }
  if (opts.anyOf && opts.anyOf.length > 0) {
    assertions.push({
      kind: 'string-contains',
      label: `mentions any of ${opts.anyOf.join('/')}`,
      anyOf: opts.anyOf,
    });
  }
  if (opts.forbids && opts.forbids.length > 0) {
    assertions.push({
      kind: 'string-forbid',
      label: `does not mention ${opts.forbids.join('/')}`,
      substrings: opts.forbids,
    });
  }
  return {
    defKey: defKey(file, name),
    key: 'purpose',
    assertions,
  };
}

interface AssertedRelationshipOptions {
  /** ALL of these substrings must appear in the produced semantic. */
  mentions?: string[];
  /** At least one of these substrings must appear. */
  anyOf?: string[];
  /** None of these substrings may appear. */
  forbids?: string[];
}

/**
 * Build a `relationships` entry that asserts the semantic field has
 * specific properties. Mirrors `assertedPurpose` but for inter-symbol
 * relationships (extends/uses/implements).
 */
export function assertedRelationship(
  fromFile: string,
  fromName: string,
  toFile: string,
  toName: string,
  relationshipType: RelationshipType,
  opts: AssertedRelationshipOptions
): GroundTruthRelationship {
  const assertions: MetadataAssertion[] = [];
  if (opts.mentions && opts.mentions.length > 0) {
    assertions.push({
      kind: 'string-contains',
      label: `mentions ${opts.mentions.join('/')}`,
      substrings: opts.mentions,
    });
  }
  if (opts.anyOf && opts.anyOf.length > 0) {
    assertions.push({
      kind: 'string-contains',
      label: `mentions any of ${opts.anyOf.join('/')}`,
      anyOf: opts.anyOf,
    });
  }
  if (opts.forbids && opts.forbids.length > 0) {
    assertions.push({
      kind: 'string-forbid',
      label: `does not mention ${opts.forbids.join('/')}`,
      substrings: opts.forbids,
    });
  }
  return {
    fromDef: defKey(fromFile, fromName),
    toDef: defKey(toFile, toName),
    relationshipType,
    assertions,
  };
}

/**
 * Build an `exactValue` entry for booleans like `pure: 'true'/'false'`.
 * Just a wrapper for clarity in migrated files — no new behavior.
 */
export function exactPure(file: string, name: string, isPure: boolean): GroundTruthDefinitionMetadata {
  return {
    defKey: defKey(file, name),
    key: 'pure',
    exactValue: isPure ? 'true' : 'false',
  };
}
