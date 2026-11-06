// Static analysis against a small workspace that holds the cases the analysis once got wrong: a store over two APIs,
// a local named like a signal, a store behind a barrel, a constant as validator limit, a repeated selector, a root
// project from `ng new`, path aliases from an extended tsconfig and a loop variable used twice.
// Run: node --test packages/angular/test/ (needs TypeScript: from this repo, or BENDA_TEST_TYPESCRIPT=<package dir>).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

function typescriptDir() {
  if (process.env.BENDA_TEST_TYPESCRIPT) return process.env.BENDA_TEST_TYPESCRIPT;
  try {
    return dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  } catch {
    return null;
  }
}

const json = (value) => JSON.stringify(value, null, 2);
const spec = (title, paths, schemas = {}) => json({ openapi: '3.0.3', info: { title, version: '1.0.0' }, paths, components: { schemas } });

const FILES = {
  'package.json': json({ name: 'fixture' }),
  'angular.json': json({
    projects: {
      'my-app': { root: '', sourceRoot: 'src', projectType: 'application', prefix: 'app' },
      b: { root: 'projects/b', sourceRoot: 'projects/b/src', projectType: 'application', prefix: 'b' },
    },
  }),
  'tsconfig.json': json({ extends: './tsconfig.base.json' }),
  'tsconfig.base.json': json({
    compilerOptions: { paths: { '@shared/*': ['libs/shared/src/*'], '@shared/api': ['libs/shared/src/api/index.ts'] } },
  }),
  'libs/shared/src/util.ts': 'export const util = 1;\n',
  'libs/shared/src/api/index.ts': 'export const api = 1;\n',
  // billing's output is a shared constant, spread into the project's own object
  'orval.config.js': `const billingOutput = { mode: 'single', target: './gen/billing/billing.service.ts' };
module.exports = {
  crm: { input: './api/crm/1.0.0.json', output: { target: './gen/crm/crm.service.ts', override: { angular: {} } } },
  billing: { input: './api/billing/1.0.0.json', output: { ...billingOutput, clean: true } },
};
`,
  'api/crm/1.0.0.json': spec(
    'CRM',
    {
      '/customers': {
        get: { operationId: 'listCustomers', responses: { 200: { description: 'ok' } } },
        post: {
          operationId: 'createCustomer',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerInput' } } } },
          responses: { 201: { description: 'created' } },
        },
      },
    },
    {
      CustomerInput: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', maxLength: 120 }, email: { type: 'string', maxLength: 80 } },
      },
    },
  ),
  'api/billing/1.0.0.json': spec('Billing', {
    '/invoices': { get: { operationId: 'listInvoices', responses: { 200: { description: 'ok' } } } },
  }),
  'gen/crm/crm.service.ts': `export class CrmService {
  listCustomers(filter?: unknown): any { return null; }
  createCustomer(input: unknown): any { return null; }
}
`,
  'gen/billing/billing.service.ts': 'export class BillingService {\n  listInvoices(): any { return null; }\n}\n',
  // the billing call comes first, the CRM calls must still be found in the CRM spec
  'src/app/customers/data-access/customer-store.ts': `import { Injectable, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { BillingService } from '../../../../gen/billing/billing.service';
import { CrmService } from '../../../../gen/crm/crm.service';
import { toCustomerInput } from './customer.mapper';

@Injectable({ providedIn: 'root' })
export class CustomerStore {
  private readonly billing = inject(BillingService);
  private readonly api = inject(CrmService);
  readonly filter = signal('');
  readonly invoices = rxResource({ stream: () => this.billing.listInvoices() });

  async loadAll() {
    const filter = this.filter();
    return firstValueFrom(this.api.listCustomers(filter));
  }

  async create(draft) {
    await firstValueFrom(this.api.createCustomer(toCustomerInput(draft)));
  }
}
`,
  'src/app/customers/data-access/customer.mapper.ts': 'export const toCustomerInput = (draft) => ({ name: draft.name, email: draft.email });\n',
  'src/app/customers/data-access/index.ts': "export * from './customer-store';\n",
  'src/app/customers/customer-form.ts': `import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CustomerStore } from './data-access';

const NAME_MAX = 120;

@Component({
  selector: 'app-customer-form',
  imports: [ReactiveFormsModule],
  template: \`<form [formGroup]="form" (ngSubmit)="save()"><input formControlName="name" /><input formControlName="email" /></form>\`,
})
export class CustomerForm {
  private readonly store = inject(CustomerStore);
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(NAME_MAX)]],
    email: ['', [Validators.maxLength(50)]],
  });

  save() {
    this.store.create(this.form.getRawValue());
  }
}
`,
  // AG Grid rows that wrap the model: the column paths start with `customer.`
  'src/app/customers/customer-grid.ts': `import { Component, computed, inject } from '@angular/core';
import { CustomerStore } from './data-access';

@Component({ selector: 'app-customer-grid', template: '<ag-grid-angular [rowData]="rows()" [columnDefs]="columns" />' })
export class CustomerGrid {
  private readonly store = inject(CustomerStore);
  readonly rows = computed(() => [{ customer: this.store.filter() }]);
  readonly columns = [{ field: 'customer.name', headerName: 'Name' }];
}
`,
  'src/app/header.ts':"import { Component } from '@angular/core';\n\n@Component({ selector: 'app-header', template: '<h1>A</h1>' })\nexport class AHeader {}\n",
  'projects/b/src/app/header.ts': "import { Component } from '@angular/core';\n\n@Component({ selector: 'app-header', template: '<h1>B</h1>' })\nexport class BHeader {}\n",
};

const ts = typescriptDir();
let workspace;
let adapter;
let ast;

before(async () => {
  if (!ts) return;
  workspace = mkdtempSync(join(tmpdir(), 'benda-analysis-'));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), text);
  }
  mkdirSync(join(workspace, 'node_modules'));
  symlinkSync(ts, join(workspace, 'node_modules', 'typescript'), 'dir');
  // the core reads its workspace once, on import
  process.env.BENDA_WORKSPACE = workspace;
  const api = await import('../../core/src/api-index.mjs');
  const { createAdapter } = await import('../src/adapter.mjs');
  adapter = createAdapter({ workspace, stateDir: join(workspace, '.benda'), api });
  ast = await import('../src/ast.mjs');
});

after(() => workspace && rmSync(workspace, { recursive: true, force: true }));

const skip = ts ? false : 'TypeScript not found – install it in this repo or set BENDA_TEST_TYPESCRIPT';

test('the check analyses a store over two APIs with a local named like its signal', { skip }, () => {
  const { findings } = adapter.check();
  const relevant = findings.filter((f) => f.file.includes('customer'));
  assert.deepEqual(relevant.filter((f) => f.rule === 'analysis-failed'), [], 'no stack overflow on `const filter = this.filter()`');
  assert.deepEqual(relevant.filter((f) => f.rule === 'operation-unknown'), [], 'each call looked up in its own spec');
});

test('a constant validator limit is not a mismatch, a real one still is', { skip }, () => {
  const messages = adapter.check().findings.filter((f) => f.rule === 'form-validation').map((f) => f.message);
  assert.ok(!messages.some((m) => m.includes('NAME_MAX') || m.includes('form.name: maxLength')), messages.join('\n'));
  assert.ok(messages.some((m) => m.includes('email') && m.includes('maxLength')), `email 50 vs 80 is reported:\n${messages.join('\n')}`);
});

test('the inventory relates the form to the store behind the barrel and reads a GET as a read', { skip }, () => {
  const { items } = adapter.inventory();
  const store = items.find((i) => i.name === 'CustomerStore');
  const form = items.find((i) => i.name === 'CustomerForm');
  assert.ok(form.relations.some((r) => r.type === 'injects' && r.target === store.id), 'injects through index.ts');
  const listing = store.relations.find((r) => r.label?.endsWith('/customers') && r.label.startsWith('GET'));
  assert.equal(listing?.type, 'reads', 'GET outside a resource is a read');
});

test('files of the root project from `ng new` belong to it, by feature folder', { skip }, () => {
  const form = adapter.inventory().items.find((i) => i.name === 'CustomerForm');
  assert.equal(form.project, 'my-app');
  assert.equal(form.group, 'customers');
});

test('a repeated selector resolves to the component with the class name', { skip }, () => {
  const fileOf = (name) => adapter.enrichItem({ owner: { name, selector: 'app-header' }, element: {} }).source.file;
  assert.equal(fileOf('AHeader'), 'src/app/header.ts');
  assert.equal(fileOf('BHeader'), 'projects/b/src/app/header.ts');
});

test('a loop variable used in two loops belongs to its own loop', { skip }, async () => {
  const { scanTemplate, templateBindings } = await import('../src/template.mjs');
  const template = '@for (c of store.customers(); track c.id) {\n  {{ c.name }}\n}\n@for (c of store.orders(); track c.id) {\n  {{ c.total }}\n}';
  const sources = { stores: new Map([['store', { store: 'Store', signals: ['customers', 'orders'] }]]), derived: new Map() };
  const onLine5 = templateBindings(scanTemplate(template), sources).filter((b) => b.line === 5).map((b) => `${b.storeSignal}.${b.field}`);
  assert.deepEqual(onLine5, ['orders.total']);
});

test('path aliases follow `extends` and prefer the exact match over the wildcard', { skip }, () => {
  const from = join(workspace, 'src/app/header.ts');
  assert.equal(ast.resolveModule(from, '@shared/util'), join(workspace, 'libs/shared/src/util.ts'));
  assert.equal(ast.resolveModule(from, '@shared/api'), join(workspace, 'libs/shared/src/api/index.ts'));
  assert.equal(ast.resolveModule(from, '@angular/core'), null);
});

test('an AG Grid cell maps its col-id to the model field and the column binding', { skip }, () => {
  const item = { componentChain: ['app-customer-grid', 'ag-grid-angular'], element: { attributes: { 'col-id': 'customer.name' } } };
  const { field, binding } = adapter.lineage(adapter.enrichItem(item));
  assert.equal(field, 'name');
  assert.deepEqual([binding?.storeSignal, binding?.field], ['filter', 'customer.name']);
});

test('an orval output from a shared constant is found, a nested own output stays its own', { skip }, async () => {
  const { detectGenerators } = await import('../../core/src/api-index.mjs');
  const outputs = Object.fromEntries(detectGenerators().map((g) => [g.input, g.output]));
  assert.equal(outputs['api/crm/1.0.0.json'], 'gen/crm/crm.service.ts');
  assert.equal(outputs['api/billing/1.0.0.json'], 'gen/billing/billing.service.ts');
});
