// Check that the version is stated once, and print a release's notes.
//
//   node scripts/check-release.mjs               package.json and VERSION in src/index.ts agree
//   node scripts/check-release.mjs v0.2.0        ...and the tag names that version, and CHANGELOG.md has its section
//   node scripts/check-release.mjs v0.2.0 --notes    print that section, for the GitHub Release
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function changelogSection(version) {
  const lines = read('CHANGELOG.md').split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

const version = JSON.parse(read('package.json')).version;
const source = read('src/index.ts').match(/^export const VERSION = '([^']+)'/m);
if (!source) fail('src/index.ts has no VERSION');
if (source[1] !== version) fail(`package.json says ${version}, src/index.ts says ${source[1]}`);

const [tag, flag] = process.argv.slice(2);
if (!tag) {
  console.log(`version ${version}`);
} else {
  if (tag !== `v${version}`) fail(`tag ${tag} does not match version ${version}`);
  const notes = changelogSection(version);
  if (!notes) fail(`CHANGELOG.md has no section for ${version}`);
  console.log(flag === '--notes' ? notes : `release ${tag} checks out`);
}
