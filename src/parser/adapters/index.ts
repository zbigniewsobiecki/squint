/**
 * Language adapters for Squint
 *
 * This module exports language-specific adapters that implement the LanguageAdapter interface.
 * Each adapter encapsulates the parsing and extraction logic for a specific programming language.
 *
 * Currently available adapters:
 * - TypeScript/JavaScript: Handles .ts, .tsx, .js, .jsx files
 * - (Ruby adapter planned for future)
 */

// Import to trigger auto-registration
import './typescript-adapter.js';

export { TypeScriptAdapter } from './typescript-adapter.js';
