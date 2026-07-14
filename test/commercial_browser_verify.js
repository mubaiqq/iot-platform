const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const token = fs.readFileSync('/tmp/iot-owner-token', 'utf8').trim();
  const browser = await chromium.launch({ headless: true });
  const report = [];

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 }
  ]) {
    const context = await browser.newContext({ viewport });
    await context.addCookies([{ name: 'session_token', value: token, url: 'http://127.0.0.1:3000' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`page: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    for (const route of ['/user/pages/data_realtime.html', '/user/pages/data_history.html', '/user/device/32']) {
      errors.length = 0;
      await page.goto(`http://127.0.0.1:3000${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      report.push({
        viewport: viewport.name,
        route,
        title: await page.title(),
        horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        errors: [...errors]
      });
    }

    // Verify the custom history controls and chart shell. Device availability depends on fixture data.
    await page.goto('http://127.0.0.1:3000/user/pages/data_history.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const historyState = await page.evaluate(() => ({
      customSelects: document.querySelectorAll('.custom-select').length,
      nativeSelects: document.querySelectorAll('select').length,
      metricCards: document.querySelectorAll('.metric').length,
      chartCanvas: document.querySelectorAll('#chart canvas').length,
      emptyText: document.body.innerText.includes('暂无')
    }));
    report.push({ viewport: viewport.name, route: 'history-data-ui', ...historyState });

    await context.close();
  }

  // Admin shell: the owner token belongs to an administrator in this fixture.
  const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await admin.addCookies([{ name: 'session_token', value: token, url: 'http://127.0.0.1:3000' }]);
  const page = await admin.newPage();
  const adminErrors = [];
  page.on('pageerror', e => adminErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') adminErrors.push(m.text()); });
  await page.goto('http://127.0.0.1:3000/admin/', { waitUntil: 'networkidle' });
  const firmwareMenu = page.locator('[data-page="firmware"]');
  await firmwareMenu.click();
  await page.waitForTimeout(600);
  const frame = page.locator('.content-frame[data-id="firmware"]');
  report.push({
    viewport: 'desktop',
    route: 'admin-firmware',
    menuCount: await firmwareMenu.count(),
    frameCount: await frame.count(),
    errors: adminErrors
  });
  await admin.close();

  const failures = report.filter(r => r.horizontalOverflow || (r.errors && r.errors.length) || (r.route === 'history-data-ui' && (r.customSelects < 2 || r.nativeSelects !== 0)) || (r.route === 'admin-firmware' && (!r.menuCount || !r.frameCount)));
  console.log(JSON.stringify({ report, failures }, null, 2));
  await browser.close();
  if (failures.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });