import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('generated report concept chips open their own explanations', () => {
  execFileSync(
    process.execPath,
    ['code/verify-report-interactions.js', '--all'],
    { cwd: new URL('..', import.meta.url), stdio: 'inherit' },
  );
});
