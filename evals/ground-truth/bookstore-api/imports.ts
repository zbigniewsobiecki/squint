import type { GroundTruthImport } from '../../harness/types.js';

/**
 * Ground truth for the `imports` table after parsing the bookstore-api fixture.
 *
 * Rails uses Zeitwerk autoloading — there are NO explicit require/require_relative
 * statements in a standard Rails app. Squint's Ruby reference extractor only
 * detects: require, require_relative, include, extend, prepend.
 *
 * This fixture has no explicit cross-file import statements. All cross-file
 * dependencies are implicit via Zeitwerk constant resolution (e.g.
 * `User.authenticate` in a controller implicitly loads app/models/user.rb).
 *
 * This is correct and intentional — it tests whether squint's LLM stages
 * (relationships, interactions) can compensate for sparser parse-time import
 * signals in Ruby/Rails codebases.
 */
export const imports: GroundTruthImport[] = [];
