const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('admin database manager exposes protected inspect and migrate APIs', () => {
  const app = read('app.js');
  for (const route of ['/api/admin/database/overview', '/api/admin/database/check', '/api/admin/database/migrate', '/api/admin/database/tables/:table']) {
    assert.ok(app.includes(route), `missing route ${route}`);
  }
  assert.match(app, /app\.get\('\/api\/admin\/database\/overview', requireAuth, requireAdmin/);
  assert.match(app, /app\.post\('\/api\/admin\/database\/migrate', requireAuth, requireAdmin/);
  assert.doesNotMatch(app, /X-Requested-With/, 'schema update endpoint must work through ordinary reverse proxies');
  assert.doesNotMatch(app, /DROP TABLE|TRUNCATE TABLE/, 'database manager must not expose destructive schema actions');
});

test('database manager compares all schema tables and columns', () => {
  const app = read('app.js');
  assert.match(app, /buildSchemaManifest/);
  assert.match(app, /information_schema\.TABLES/);
  assert.match(app, /information_schema\.COLUMNS/);
  assert.match(app, /SEQ_IN_INDEX,COLUMN_NAME,SUB_PART/, 'index comparison must inspect ordered index columns');
  assert.match(app, /name: 'PRIMARY'/, 'primary keys must be compared');
  assert.match(app, /databaseMigrationPromise/, 'concurrent migrations must share one operation');
  assert.match(app, /ADD COLUMN/);
  assert.match(app, /CREATE TABLE IF NOT EXISTS/);
  assert.match(app, /createSql: match\[0\]/, 'missing-table migration must preserve the complete CREATE TABLE statement');
});

test('database manager UI is enabled and uses custom confirmation', () => {
  const shell = read('public/admin/index.html');
  const page = read('public/admin/pages/database.html');
  assert.match(shell, /data-page="database"/);
  assert.doesNotMatch(shell, /is-disabled[^>]*data-page="database"|data-page="database"[^>]*is-disabled/);
  assert.match(page, /\/api\/admin\/database\/overview/);
  assert.match(page, /\/api\/admin\/database\/check/);
  assert.match(page, /\/api\/admin\/database\/migrate/);
  assert.match(page, /showConfirm/);
  assert.match(page, /addEventListener\('click'/, 'table actions must not interpolate database names into JavaScript');
  assert.doesNotMatch(page, /onclick="viewTable/, 'database table names must not enter inline event handlers');
  assert.doesNotMatch(page, /\b(alert|confirm|prompt)\s*\(/);
});
