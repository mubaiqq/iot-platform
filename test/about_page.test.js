const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('admin About menu is enabled and opens the implemented page', () => {
  const index = read('public/admin/index.html');
  const aboutItem = index.match(/<div class="nav-item[^"]*"[^>]*data-page="about"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(aboutItem, 'About menu item missing');
  assert.doesNotMatch(aboutItem, /is-disabled|data-disabled|aria-disabled|开发中/);
  assert.match(read('public/admin/admin.js'), /about:'\/admin\/pages\/about\.html'/);
});

test('About page provides overview, progress, release log and official project links', () => {
  const page = read('public/admin/pages/about.html');
  for (const section of ['项目说明', '开发进度', '更新日志', '项目链接']) assert.match(page, new RegExp(section));
  assert.match(page, /v1\.2\.4/);
  assert.match(page, /https:\/\/github\.com\/mubaiqq\/iot-platform/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /@media\s*\(max-width:\s*720px\)/);
  assert.doesNotMatch(page, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(page, /<div class="placeholder/);
});
