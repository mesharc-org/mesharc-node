// The package is ESM; the CommonJS build lives under dist/cjs and needs its
// own package.json to be read as CommonJS.
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
