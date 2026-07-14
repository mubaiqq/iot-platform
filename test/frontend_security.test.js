const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const llmPages = [
  'public/admin/pages/llm_settings.html',
  'public/user/pages/llm_custom.html'
];

test('device log escapes every API/log/AI value and preserves multiline text', () => {
  const src = read('public/user/pages/device_log.html');
  assert.match(src, /function esc\s*\(/);
  assert.match(src, /white-space\s*:\s*pre-wrap/);
  for (const rawInterpolation of [
    '${shortContent}', '${e.message}', '${result.reason', '${log.device_name',
    '${log.prompt_content', '${result.ai_response', '${log.ai_response'
  ]) assert.ok(!src.includes(rawInterpolation), `unsafe device-log interpolation: ${rawInterpolation}`);
});

test('sensor detail escapes all device and sensor values', () => {
  const src = read('public/user/pages/device_detail.html');
  assert.match(src, /const name\s*=\s*esc\(d\.device_name/);
  assert.match(src, /const code\s*=\s*esc\(d\.device_code/);
  assert.match(src, /esc\(val\(sd\[f\.key\]\)\)/);
  assert.match(src, /esc\(d\.firmware_version/);
  assert.doesNotMatch(src, /<p>'\+msg\+'<\/p>/);
  assert.doesNotMatch(src, /\bprompt\s*\(/);
});

test('LLM pages render untrusted configs with escaping and data-id delegation', () => {
  for (const file of llmPages) {
    const src = read(file);
    assert.match(src, /function esc\s*\(/, `${file} missing esc`);
    assert.match(src, /data-id=/, `${file} missing data-id actions`);
    assert.match(src, /closest\('\[data-action\]'/, `${file} missing delegated actions`);
    assert.doesNotMatch(src, /onclick=['"](?:editConfig|testSaved|setDefault|deleteConfig)/, `${file} interpolates action handlers`);
    assert.doesNotMatch(src, /onclick=['"]selectModel/, `${file} interpolates model handler`);
    assert.doesNotMatch(src, /JSON\.stringify\(c\).*editConfig/, `${file} puts config JSON in HTML`);
    assert.doesNotMatch(src, /editKey'\)\.value\s*=\s*c\.api_key/, `${file} unnecessarily copies key into DOM`);
    assert.match(src, /has_api_key|masked/, `${file} does not support masked future API responses`);
    assert.doesNotMatch(src, /\bconfirm\s*\(/, `${file} uses native confirm`);
  }
});

test('weather results use escaped values, delegated city selection, and stale-request guards', () => {
  const src = read('public/admin/pages/weather_settings.html');
  assert.match(src, /function esc\s*\(/);
  assert.match(src, /data-location-id=/);
  assert.match(src, /closest\('\[data-location-id\]'/);
  assert.doesNotMatch(src, /onclick=['"]selectCity/);
  assert.match(src, /searchSeq/);
  assert.match(src, /weatherSeq/);
  assert.match(src, /encodeURIComponent\(locationId\)/);
  for (const value of ['todayText', 'n.temp', 'n.feelsLike', 'n.windDir', 'd.textDay', 'd.date']) {
    assert.ok(src.includes(`esc(${value}`), `weather does not escape ${value}`);
  }
});

test('security logout-all uses custom confirmation and dedicated endpoint', () => {
  const src = read('public/user/pages/security.html');
  assert.match(src, /showConfirm\s*\(/);
  assert.match(src, /\/api\/account\/logout-all/);
  assert.doesNotMatch(src, /\bconfirm\s*\(/);
  assert.match(src, /if\s*\(!res\.ok|if\s*\(!data\.success/);
});

test('audited MQTT pages no longer use native confirmation', () => {
  for (const file of ['public/user/pages/mqtt_test.html', 'public/user/pages/mqtt_test2.html']) {
    assert.doesNotMatch(read(file), /\bconfirm\s*\(/, file);
    assert.match(read(file), /showConfirm\s*\(/, file);
  }
});

test('touched forms keep 16px controls on mobile to avoid zoom and stay consistent', () => {
  for (const file of [...llmPages, 'public/admin/pages/weather_settings.html', 'public/user/pages/security.html', 'public/user/pages/device_detail.html']) {
    const src = read(file);
    assert.match(src, /@media\s*\(max-width:[^)]+\)[\s\S]*input[\s\S]*font-size\s*:\s*16px/, `${file} lacks mobile 16px form controls`);
  }
});
