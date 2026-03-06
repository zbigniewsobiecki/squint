import fs from 'node:fs';
import path from 'node:path';

/**
 * Install a pre-push git hook for squint sync.
 */
export function installGitHook(directory: string, dbPath: string): string {
  // Find .git directory
  let gitDir = directory;
  while (gitDir !== path.dirname(gitDir)) {
    if (fs.existsSync(path.join(gitDir, '.git'))) break;
    gitDir = path.dirname(gitDir);
  }

  const hookDir = path.join(gitDir, '.git', 'hooks');
  if (!fs.existsSync(hookDir)) {
    throw new Error(`No .git/hooks directory found. Is ${directory} inside a git repository?`);
  }

  const hookPath = path.join(hookDir, 'pre-push');
  const hookContent = `#!/bin/sh
# squint sync pre-push hook
squint sync ${directory} -d ${dbPath}
if [ $? -ne 0 ]; then
  echo "squint sync failed. Fix issues before pushing."
  exit 1
fi
`;

  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  return hookPath;
}
