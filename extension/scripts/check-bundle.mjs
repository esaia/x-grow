/**
 * Guards against the minifier collision that broke the dashboard.
 *
 * Vite 8's default (Oxc) minifier merged modules into one scope and gave two
 * different top-level bindings the same short name: React DOM's lane constant
 * `var Ke=256` and our KEY_FIELDS array both became `Ke`. React then does
 * `Ke <<= 1`, our array silently became a number, and Home died with
 * "Cannot read properties of undefined (reading 'filter')".
 *
 * Nothing in TypeScript can catch that — the source is fine, the build is not.
 * So this locates a few of our own top-level constants in the built output by
 * their contents, recovers the name the minifier gave each one, and fails if
 * that name is declared more than once in the same file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.output/chrome-mv3';

/**
 * Distinctive literals from our own module-level constants. Each must be
 * unique to one declaration, and must survive minification verbatim — string
 * contents do, identifiers do not.
 */
const PROBES = [
  { label: 'KEY_FIELDS (Home)', literal: 'Sample posts' },
  { label: 'DATE_RANGES (Inspiration)', literal: 'Any time' },
  { label: 'THRESHOLDS (Inspiration)', literal: '≥1.5x' },
  { label: 'CATEGORY_COLORS (meta)', literal: '#a970ff' },
  { label: 'STATUS_META (meta)', literal: 'Not going anywhere until' },
];

function jsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return jsFiles(path);

    return path.endsWith('.js') ? [path] : [];
  });
}

/** The identifier a literal was assigned to, e.g. `var Ke=[{key:"sample_..."`. */
function bindingFor(source, literal) {
  const at = source.indexOf(literal);

  if (at === -1) return null;

  // Walk back to the nearest `<kw> <name> =` that opens this declaration.
  const before = source.slice(Math.max(0, at - 400), at);
  const match = [...before.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)].pop();

  return match?.[1] ?? null;
}

let failed = false;
let checked = 0;

for (const file of jsFiles(ROOT)) {
  const source = readFileSync(file, 'utf8');

  for (const probe of PROBES) {
    const name = bindingFor(source, probe.literal);

    if (!name) continue;

    checked++;

    const declarations = [
      ...source.matchAll(
        new RegExp(`\\b(?:var|let|const)\\s+${name}\\s*=`, 'g'),
      ),
    ].length;

    if (declarations > 1) {
      failed = true;
      console.error(
        `\n✘ ${file}\n    ${probe.label} minified to "${name}", which is ` +
          `declared ${declarations}x in this file.\n    Another module's ` +
          `binding shares the name and will overwrite it at runtime.`,
      );
    }
  }
}

if (checked === 0) {
  console.error(
    '\n✘ Found none of the probe constants in the build. Either the build is ' +
      'missing, or these constants were renamed — update PROBES.\n',
  );
  process.exit(1);
}

if (failed) {
  console.error(
    '\nSwitch minifiers in wxt.config.ts rather than renaming anything in ' +
      'source; the source is not what is wrong.\n',
  );
  process.exit(1);
}

console.log(`✔ ${checked} module constants have unique names in the build.`);
