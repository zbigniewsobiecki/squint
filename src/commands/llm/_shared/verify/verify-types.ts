export type VerifySeverity = 'error' | 'warning' | 'info';

export interface VerificationIssue {
  definitionId?: number;
  definitionName?: string;
  filePath?: string;
  line?: number;
  severity: VerifySeverity;
  category: string;
  message: string;
  suggestion?: string;
  fixData?: {
    action:
      | 'set-pure-true'
      | 'set-pure-false'
      | 'change-relationship-type'
      | 'move-to-test-module'
      | 'remove-flow'
      | 'remove-ghost'
      | 'remove-interaction'
      | 'remove-inferred-to-module'
      | 'rebuild-symbols'
      | 'set-direction-uni'
      | 'null-entry-point'
      | 'reannotate-relationship'
      | 'annotate-missing-relationship'
      | 'reannotate-definition'
      | 'reannotate-mistagged-domain'
      | 'harmonize-domain'
      | 'purpose-role-mismatch';
    targetDefinitionId?: number;
    expectedType?: string;
    interactionId?: number;
    targetModuleId?: number;
    flowId?: number;
    ghostTable?: string;
    ghostRowId?: number;
    reason?: string;
  };
}

export interface CoverageCheckResult {
  passed: boolean;
  issues: VerificationIssue[];
  stats: {
    totalDefinitions: number;
    annotatedDefinitions: number;
    totalRelationships: number;
    annotatedRelationships: number;
    missingCount: number;
    structuralIssueCount: number;
  };
}

export interface ContentVerificationResult {
  issues: VerificationIssue[];
  stats: {
    checked: number;
    issuesFound: number;
    batchesProcessed: number;
  };
}

export interface VerifyReport {
  phase1: CoverageCheckResult;
  phase2?: ContentVerificationResult;
}
