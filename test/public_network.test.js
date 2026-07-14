const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicAddress, createPublicOnlyDispatcher } = require('../lib/public_network');

const blocked = [
  '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::',
  'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'
];

test('public-network classifier rejects private, mapped, shared and reserved addresses', () => {
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('connection dispatcher can be constructed and closed', async () => {
  const dispatcher = createPublicOnlyDispatcher();
  assert.ok(dispatcher);
  await dispatcher.close();
});
