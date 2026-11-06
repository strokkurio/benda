// Node side of the Angular adapter, loaded by the Benda bridge and `benda dev` (contract: core src/adapter.mjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheck } from './check.mjs';
import { createImpact } from './impact.mjs';
import { createInsert } from './insert.mjs';
import { createInventory } from './inventory.mjs';
import { createLineage } from './lineage.mjs';
import { createSourceIndex } from './source-index.mjs';

export function createAdapter({ workspace, stateDir, api }) {
  const sources = createSourceIndex(workspace, stateDir);
  return {
    name: 'angular',
    browserModule: fileURLToPath(new URL('./browser.js', import.meta.url)),
    enrichItem: sources.enrichItem,
    lineage: createLineage({ workspace, api, findComponent: sources.findComponent }),
    check: createCheck({ workspace, stateDir }),
    impact: createImpact({ workspace, stateDir }),
    insert: createInsert({ workspace }),
    ...createInventory({ workspace, stateDir }),

    /** `ng serve` for every application in angular.json, or only the requested ones. */
    devServers(requested = []) {
      const angular = JSON.parse(readFileSync(join(workspace, 'angular.json'), 'utf8'));
      const ngBin = createRequire(join(workspace, 'package.json')).resolve('@angular/cli/bin/ng.js');
      return Object.entries(angular.projects)
        .filter(([name, p]) => p.projectType === 'application' && (requested.length === 0 || requested.includes(name)))
        .map(([name]) => ({ label: name, args: [ngBin, 'serve', name] }));
    },
  };
}
