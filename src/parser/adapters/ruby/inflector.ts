import pluralize from 'pluralize';

/**
 * English singular/plural inflection helpers for Ruby/Rails parsing.
 *
 * Wraps the `pluralize` npm package (which already handles common irregular
 * plurals: people↔person, children↔child, octopi↔octopus, etc.) and adds the
 * snake_case → CamelCase conversion needed to map ActiveRecord association
 * symbols (`:books`, `:order_items`) to their target class names (`Book`,
 * `OrderItem`).
 *
 * Scope: English regular and common irregular plurals only. Locale-specific
 * inflection rules are out of scope. The Ruby parser only ever sees user-
 * authored ActiveRecord association names — these are virtually always English.
 */

/**
 * Return the singular form of an English word.
 * Idempotent on already-singular input.
 *
 * Examples:
 *   singularize('books')         → 'book'
 *   singularize('order_items')   → 'order_item'
 *   singularize('addresses')     → 'address'
 *   singularize('people')        → 'person'
 *   singularize('book')          → 'book'
 */
export function singularize(word: string): string {
  return pluralize.singular(word);
}

/**
 * Convert a snake_case (or namespaced) name into CamelCase per Rails convention.
 * Handles both `/` and `::` as namespace separators in the input; output always
 * uses `::`.
 *
 * Examples:
 *   camelize('book')                → 'Book'
 *   camelize('order_item')          → 'OrderItem'
 *   camelize('user_account')        → 'UserAccount'
 *   camelize('catalog/author')      → 'Catalog::Author'
 *   camelize('catalog::author')     → 'Catalog::Author'
 *   camelize('admin/user_account')  → 'Admin::UserAccount'
 */
export function camelize(snakeOrSlashed: string): string {
  // Normalize slash-namespace input to colon-namespace.
  const normalized = snakeOrSlashed.replace(/\//g, '::');
  // Split into namespace segments, camelize each segment independently.
  return normalized
    .split('::')
    .map((segment) =>
      segment
        .split('_')
        .map((token) => (token.length === 0 ? '' : token[0].toUpperCase() + token.slice(1)))
        .join('')
    )
    .join('::');
}

/**
 * Resolve an ActiveRecord association name to its target class name.
 *
 * For plural-style associations (`has_many`, `has_and_belongs_to_many`) the
 * symbol name is singularized first; for singular-style (`belongs_to`,
 * `has_one`) it's already singular by Rails convention so we just camelize.
 *
 * Examples:
 *   inferAssociationClass('books',       'has_many')                  → 'Book'
 *   inferAssociationClass('order_items', 'has_many')                  → 'OrderItem'
 *   inferAssociationClass('user',        'belongs_to')                → 'User'
 *   inferAssociationClass('profile',     'has_one')                   → 'Profile'
 *   inferAssociationClass('tags',        'has_and_belongs_to_many')   → 'Tag'
 *   inferAssociationClass('people',      'has_many')                  → 'Person'
 */
export type AssociationKind = 'has_many' | 'has_one' | 'belongs_to' | 'has_and_belongs_to_many';

export function inferAssociationClass(symbolName: string, kind: AssociationKind): string {
  const isPluralKind = kind === 'has_many' || kind === 'has_and_belongs_to_many';
  const root = isPluralKind ? singularize(symbolName) : symbolName;
  return camelize(root);
}
