/**
 * CSV parser for LLM-generated flow output.
 *
 * Handles two output formats:
 * 1. Entry point classification (Phase 1)
 * 2. Flow construction with sub-flow references (Phase 2)
 */

import { extractCsvContent, parseRow, splitCsvLines } from './csv-utils.js';

// ============================================
// Entry Point Classification (Phase 1)
// ============================================

export type EntryPointClassification = 'top_level' | 'subflow_candidate' | 'internal';

export interface ClassifiedEntryPoint {
  id: number;
  classification: EntryPointClassification;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface EntryPointParseResult {
  entries: ClassifiedEntryPoint[];
  errors: string[];
}

/**
 * Parse entry point classification output.
 * Expected format:
 * ```csv
 * type,id,classification,confidence,reason
 * entry,42,top_level,high,"HTTP controller - receives external requests"
 * entry,87,subflow_candidate,medium,"Validation logic reused by multiple controllers"
 * ```
 */
export function parseEntryPointClassification(content: string): EntryPointParseResult {
  const entries: ClassifiedEntryPoint[] = [];
  const errors: string[] = [];

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { entries, errors };
  }

  // Validate header
  const header = parseRow(lines[0]);
  if (!header || header.length < 5) {
    errors.push(`Invalid header: expected "type,id,classification,confidence,reason", got "${lines[0]}"`);
    return { entries, errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed || parsed.length < 5) {
      errors.push(`Line ${i + 1}: Invalid row format`);
      continue;
    }

    const [type, idStr, classification, confidence, reason] = parsed;

    if (type !== 'entry') {
      continue; // Skip non-entry rows
    }

    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      errors.push(`Line ${i + 1}: Invalid ID "${idStr}"`);
      continue;
    }

    if (!isValidClassification(classification)) {
      errors.push(`Line ${i + 1}: Invalid classification "${classification}"`);
      continue;
    }

    if (!isValidConfidence(confidence)) {
      errors.push(`Line ${i + 1}: Invalid confidence "${confidence}"`);
      continue;
    }

    entries.push({
      id,
      classification,
      confidence,
      reason: reason.trim(),
    });
  }

  return { entries, errors };
}

function isValidClassification(s: string): s is EntryPointClassification {
  return s === 'top_level' || s === 'subflow_candidate' || s === 'internal';
}

function isValidConfidence(s: string): s is 'high' | 'medium' | 'low' {
  return s === 'high' || s === 'medium' || s === 'low';
}

// ============================================
// Flow Construction (Phase 2)
// ============================================

export interface ParsedFlowStep {
  type: 'definition' | 'subflow';
  order: number;
  id?: number; // Definition ID for 'definition' type
  flowName?: string; // Flow name for 'subflow' type
}

export interface ParsedFlow {
  id: number;
  name: string;
  description: string;
  domain: string | null;
  isComposite: boolean;
  steps: ParsedFlowStep[];
  subflowReasons: Map<number, string>; // stepOrder -> reason
}

export interface FlowParseResult {
  flows: ParsedFlow[];
  errors: string[];
}

/**
 * Parse flow construction output.
 * Expected format:
 * ```csv
 * type,flow_id,field,value
 * flow,1,name,"UserRegistration"
 * flow,1,description,"Handles new user signup"
 * flow,1,domain,"auth"
 * flow,1,is_composite,"true"
 * step,1,1,42
 * step,1,2,subflow:ValidateUser
 * step,1,3,89
 * subflow_reason,1,2,"Delegates input validation to reusable validation flow"
 * ```
 */
export function parseFlowConstruction(content: string): FlowParseResult {
  const errors: string[] = [];
  const flowsMap = new Map<number, ParsedFlow>();

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { flows: [], errors };
  }

  // Validate header
  const header = parseRow(lines[0]);
  if (!header || header.length < 4) {
    errors.push(`Invalid header: expected "type,flow_id,field,value", got "${lines[0]}"`);
    return { flows: [], errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed || parsed.length < 4) {
      errors.push(`Line ${i + 1}: Invalid row format`);
      continue;
    }

    const [type, flowIdStr, field, value] = parsed;
    const flowId = Number.parseInt(flowIdStr, 10);

    if (Number.isNaN(flowId)) {
      errors.push(`Line ${i + 1}: Invalid flow_id "${flowIdStr}"`);
      continue;
    }

    // Ensure flow exists in map
    if (!flowsMap.has(flowId)) {
      flowsMap.set(flowId, {
        id: flowId,
        name: '',
        description: '',
        domain: null,
        isComposite: false,
        steps: [],
        subflowReasons: new Map(),
      });
    }
    const flow = flowsMap.get(flowId)!;

    switch (type) {
      case 'flow':
        switch (field) {
          case 'name':
            flow.name = value.trim();
            break;
          case 'description':
            flow.description = value.trim();
            break;
          case 'domain':
            flow.domain = value.trim() || null;
            break;
          case 'is_composite':
            flow.isComposite = value.trim().toLowerCase() === 'true';
            break;
          default:
            errors.push(`Line ${i + 1}: Unknown flow field "${field}"`);
        }
        break;

      case 'step': {
        const stepOrder = Number.parseInt(field, 10);
        if (Number.isNaN(stepOrder)) {
          errors.push(`Line ${i + 1}: Invalid step order "${field}"`);
          continue;
        }

        const stepValue = value.trim();
        if (stepValue.startsWith('subflow:')) {
          const flowName = stepValue.slice(8).trim();
          flow.steps.push({
            type: 'subflow',
            order: stepOrder,
            flowName,
          });
          flow.isComposite = true;
        } else {
          const defId = Number.parseInt(stepValue, 10);
          if (Number.isNaN(defId)) {
            errors.push(`Line ${i + 1}: Invalid step definition ID "${stepValue}"`);
            continue;
          }
          flow.steps.push({
            type: 'definition',
            order: stepOrder,
            id: defId,
          });
        }
        break;
      }

      case 'subflow_reason': {
        const stepOrder = Number.parseInt(field, 10);
        if (Number.isNaN(stepOrder)) {
          errors.push(`Line ${i + 1}: Invalid step order for subflow_reason "${field}"`);
          continue;
        }
        flow.subflowReasons.set(stepOrder, value.trim());
        break;
      }

      default:
        errors.push(`Line ${i + 1}: Unknown row type "${type}"`);
    }
  }

  // Sort steps by order for each flow
  for (const flow of flowsMap.values()) {
    flow.steps.sort((a, b) => a.order - b.order);
  }

  return {
    flows: Array.from(flowsMap.values()).filter((f) => f.name !== ''),
    errors,
  };
}

// ============================================
// Gap Filling (Phase 3)
// ============================================

export interface GapFillSuggestion {
  type: 'new_flow' | 'add_to_existing' | 'new_subflow';
  symbolId: number;
  targetFlowId?: number; // For 'add_to_existing'
  reason: string;
}

export interface GapFillParseResult {
  suggestions: GapFillSuggestion[];
  errors: string[];
}

/**
 * Parse gap filling suggestions.
 * Expected format:
 * ```csv
 * type,symbol_id,target_flow_id,reason
 * new_flow,89,,"Payment validation should be a standalone flow"
 * add_to_existing,156,3,"Should be added to CreateSale flow as notification step"
 * new_subflow,42,,"Appears in multiple flows as common validation pattern"
 * ```
 */
export function parseGapFillSuggestions(content: string): GapFillParseResult {
  const suggestions: GapFillSuggestion[] = [];
  const errors: string[] = [];

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    return { suggestions, errors };
  }

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed || parsed.length < 4) {
      errors.push(`Line ${i + 1}: Invalid row format`);
      continue;
    }

    const [type, symbolIdStr, targetFlowIdStr, reason] = parsed;

    if (!isValidGapFillType(type)) {
      errors.push(`Line ${i + 1}: Invalid suggestion type "${type}"`);
      continue;
    }

    const symbolId = Number.parseInt(symbolIdStr, 10);
    if (Number.isNaN(symbolId)) {
      errors.push(`Line ${i + 1}: Invalid symbol_id "${symbolIdStr}"`);
      continue;
    }

    const targetFlowId = targetFlowIdStr ? Number.parseInt(targetFlowIdStr, 10) : undefined;
    if (type === 'add_to_existing' && (targetFlowId === undefined || Number.isNaN(targetFlowId))) {
      errors.push(`Line ${i + 1}: add_to_existing requires valid target_flow_id`);
      continue;
    }

    suggestions.push({
      type,
      symbolId,
      targetFlowId: targetFlowId && !Number.isNaN(targetFlowId) ? targetFlowId : undefined,
      reason: reason.trim(),
    });
  }

  return { suggestions, errors };
}

function isValidGapFillType(s: string): s is GapFillSuggestion['type'] {
  return s === 'new_flow' || s === 'add_to_existing' || s === 'new_subflow';
}
