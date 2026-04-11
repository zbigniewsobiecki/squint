/**
 * PR4/2: file-path-derived layer hints for the symbols-stage user prompt.
 *
 * Maps a source file path to a short architectural-layer label that the
 * LLM uses as additional context when annotating a symbol's purpose/domain.
 * This is NOT a leaky few-shot example — it's an axis-aligned hint about
 * WHERE in the project tree the symbol lives, with no instruction about
 * what tags to pick.
 *
 * Example: a class in `app/models/author.rb` with the layer hint
 * "Rails ActiveRecord model layer" is much less likely to drift to
 * `["user-management"]` because the layer hint anchors the symbol's
 * identity in the persistence layer.
 */

interface LayerRule {
  pattern: RegExp;
  label: string;
}

/**
 * Rules table evaluated in order; the first matching rule wins. Patterns
 * are anchored to the START of the file path (relative to the project root,
 * which is how `EnhancedSymbol.filePath` is stored). Order matters: more
 * specific rules (e.g. `app/controllers/api/`) come BEFORE more general
 * ones (`app/controllers/`).
 */
const RULES: LayerRule[] = [
  // ─── Rails / Ruby ────────────────────────────────────────────────────
  { pattern: /^app\/models\//, label: 'Rails ActiveRecord model layer' },
  { pattern: /^app\/controllers\/api\//, label: 'Rails API controller layer' },
  { pattern: /^app\/controllers\//, label: 'Rails controller layer' },
  { pattern: /^app\/services\//, label: 'Rails service object layer' },
  { pattern: /^app\/serializers\//, label: 'Rails serializer layer' },
  { pattern: /^app\/mailers\//, label: 'Rails mailer layer' },
  { pattern: /^app\/jobs\//, label: 'Rails background job layer' },
  { pattern: /^app\/policies\//, label: 'Rails authorization policy layer' },
  { pattern: /^app\/decorators\//, label: 'Rails view decorator layer' },
  { pattern: /^app\/helpers\//, label: 'Rails view helper layer' },
  { pattern: /^app\/channels\//, label: 'Rails ActionCable channel layer' },
  { pattern: /^app\/forms\//, label: 'Rails form object layer' },
  { pattern: /^app\/validators\//, label: 'Rails validator layer' },
  { pattern: /^app\/views\//, label: 'Rails view template layer' },
  { pattern: /^lib\//, label: 'Ruby/Rails library layer' },
  { pattern: /^config\//, label: 'Rails configuration layer' },
  { pattern: /^db\/migrate\//, label: 'Rails database migration layer' },

  // ─── TypeScript / Node ───────────────────────────────────────────────
  { pattern: /^src\/controllers\//, label: 'HTTP controller layer' },
  { pattern: /^src\/services\//, label: 'business service layer' },
  { pattern: /^src\/repositories\//, label: 'persistence repository layer' },
  { pattern: /^src\/middleware\//, label: 'HTTP middleware layer' },
  { pattern: /^src\/handlers\//, label: 'HTTP handler layer' },
  { pattern: /^src\/routes\//, label: 'HTTP route definition layer' },
  { pattern: /^src\/events\//, label: 'event/messaging layer' },
  { pattern: /^src\/types\//, label: 'shared type definition layer' },
  { pattern: /^src\/types\.ts$/, label: 'shared type definition layer' },
  { pattern: /^src\/db\//, label: 'database layer' },
  { pattern: /^src\/utils\//, label: 'utility layer' },
  { pattern: /^src\/lib\//, label: 'library layer' },
  { pattern: /^src\/framework\.ts$/, label: 'in-fixture HTTP framework' },

  // ─── Frontend / client ──────────────────────────────────────────────
  { pattern: /^client\//, label: 'frontend client layer' },
  { pattern: /^web\//, label: 'frontend web layer' },
  { pattern: /^ui\//, label: 'frontend UI layer' },

  // ─── Test files (skip — these get the layer of what they test) ──────
  // No explicit test rule; tests aren't typically annotated.
];

/**
 * Return the layer label for the given file path, or null if no rule
 * matches. Callers render this in the prompt as `Layer: <label>`.
 */
export function describeFileLayer(filePath: string): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(filePath)) return rule.label;
  }
  return null;
}
