// Direct insertion of a catalog component (Components tab): the snippet lands at the right place of the template,
// the imports follow, and an ambiguous place writes nothing.
// Run: node --test packages/angular/test/ (needs TypeScript: from this repo, or BENDA_TEST_TYPESCRIPT=<package dir>).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

function typescriptDir() {
  if (process.env.BENDA_TEST_TYPESCRIPT) return process.env.BENDA_TEST_TYPESCRIPT;
  try {
    return dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  } catch {
    return null;
  }
}

const CARD_TS = `import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-card',
  imports: [RouterLink],
  templateUrl: './card.html',
})
export class Card {}
`;
const CARD_HTML = `<section class="card">
  <h2 class="title">Orders</h2>
  <p>One</p>
  <p>Two</p>
  <img src="logo.png">
</section>
`;
const INLINE_TS = `import { Component } from '@angular/core';

@Component({
  selector: 'app-inline',
  template: \`
    <div class="box">Hi</div>
  \`,
})
export class Inline {}
`;

const BUTTON = { name: 'Button', snippet: '<acme-button>Save</acme-button>', import: { name: 'AcmeButton', from: '@acme/ds' } };
const item = (owner, file, element) => ({ owner: { name: owner }, source: { file }, element });

const ts = typescriptDir();
const skip = ts ? false : 'TypeScript not found – install it in this repo or set BENDA_TEST_TYPESCRIPT';
let workspace;
let insert;
const read = (file) => readFileSync(join(workspace, file), 'utf8');

before(async () => {
  if (!ts) return;
  workspace = mkdtempSync(join(tmpdir(), 'benda-insert-'));
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}');
  mkdirSync(join(workspace, 'node_modules'));
  symlinkSync(ts, join(workspace, 'node_modules', 'typescript'), 'dir');
  const { createInsert } = await import('../src/insert.mjs');
  insert = createInsert({ workspace });
});

function reset() {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src/card.ts'), CARD_TS);
  writeFileSync(join(workspace, 'src/card.html'), CARD_HTML);
  writeFileSync(join(workspace, 'src/inline.ts'), INLINE_TS);
}

beforeEach(() => ts && reset());

after(() => workspace && rmSync(workspace, { recursive: true, force: true }));

test('after an element: snippet below it, class in imports, import statement added', { skip }, () => {
  const result = insert({ item: item('Card', 'src/card.ts', { tag: 'h2', classes: ['title'] }), position: 'after', component: BUTTON });
  assert.deepEqual(result, { file: 'src/card.html', line: 3, files: ['src/card.ts', 'src/card.html'] });
  assert.match(read('src/card.html'), /<h2 class="title">Orders<\/h2>\n {2}<acme-button>Save<\/acme-button>\n {2}<p>One/);
  assert.match(read('src/card.ts'), /imports: \[RouterLink, AcmeButton\]/);
  assert.match(read('src/card.ts'), /import \{ RouterLink \} from '@angular\/router';\nimport \{ AcmeButton \} from '@acme\/ds';/);
});

test('inside an element: last child, one level deeper', { skip }, () => {
  insert({ item: item('Card', 'src/card.ts', { tag: 'section', classes: ['card'] }), position: 'inside', component: BUTTON });
  assert.match(read('src/card.html'), /<img src="logo.png">\n {2}<acme-button>Save<\/acme-button>\n<\/section>/);
});

test('the own text tells two equal elements apart, a tie writes nothing', { skip }, () => {
  insert({ item: item('Card', 'src/card.ts', { tag: 'p', classes: [], ownText: 'Two' }), position: 'before', component: BUTTON });
  assert.match(read('src/card.html'), /<p>One<\/p>\n {2}<acme-button>Save<\/acme-button>\n {2}<p>Two/);
  reset();
  assert.throws(
    () => insert({ item: item('Card', 'src/card.ts', { tag: 'p', classes: [] }), position: 'after', component: BUTTON }),
    (err) => err.status === 409 && /2 <p> elements/.test(err.message),
  );
  assert.equal(read('src/card.html'), CARD_HTML);
  assert.equal(read('src/card.ts'), CARD_TS);
});

test('a void element takes nothing inside', { skip }, () => {
  assert.throws(() => insert({ item: item('Card', 'src/card.ts', { tag: 'img', classes: [], attributes: { src: 'logo.png' } }), position: 'inside', component: BUTTON }), /cannot contain/);
});

test('a web component without import gets the custom elements schema, in an inline template', { skip }, () => {
  const result = insert({
    item: item('Inline', 'src/inline.ts', { tag: 'div', classes: ['box'] }),
    position: 'before',
    component: { name: 'Badge', snippet: '<acme-badge></acme-badge>' },
  });
  const text = read('src/inline.ts');
  assert.match(text, /import \{ Component, CUSTOM_ELEMENTS_SCHEMA \} from '@angular\/core';/);
  assert.match(text, /schemas: \[CUSTOM_ELEMENTS_SCHEMA\],\n {2}selector: 'app-inline'/);
  assert.match(text, /\n {4}<acme-badge><\/acme-badge>\n {4}<div class="box">Hi<\/div>/);
  assert.equal(text.split('\n')[result.line - 1].trim(), '<acme-badge></acme-badge>');
});

test('markup with bindings goes to the agent: the fields it reads do not exist yet', { skip }, () => {
  const table = { name: 'Table', snippet: '<acme-table [rows]="rows"></acme-table>', import: { name: 'AcmeTable', from: '@acme/ds' } };
  assert.throws(
    () => insert({ item: item('Card', 'src/card.ts', { tag: 'h2', classes: ['title'] }), position: 'after', component: table }),
    (err) => err.status === 409 && /binds to fields/.test(err.message),
  );
  assert.equal(read('src/card.html'), CARD_HTML);
  assert.equal(read('src/card.ts'), CARD_TS);
});
