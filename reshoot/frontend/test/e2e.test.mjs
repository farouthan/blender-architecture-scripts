/**
 * End-to-end walk through the whole app in a real browser.
 *
 * Starts the Python server against a temporary data directory, serves the built
 * frontend from it, then drives all six steps: upload a photo, solve the
 * perspective, build and confirm the proxy, place a person, lock an angle, and
 * render it.  WebGL runs on SwiftShader, so this exercises the real three.js
 * scene, the real offscreen depth and normal passes, and the real upload.
 *
 *   npm run build && npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..', '..', 'backend');
const distDir = resolve(here, '..', 'dist');
const CHROME =
  process.env.RESHOOT_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.RESHOOT_E2E_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Wait for the progress strip to be genuinely gone.
 *
 * Checking the attribute alone races the start of a job, so this first gives
 * the step a moment to kick one off, then waits for the strip to stop being
 * visible.
 */
async function waitForIdle(page, timeoutMs) {
  await page.waitForTimeout(1200);
  await page
    .locator('.progress-strip')
    .waitFor({ state: 'hidden', timeout: timeoutMs });
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up`);
}

/** A synthetic room photo with strong perspective lines, built by the backend. */
async function makePhoto() {
  return new Promise((resolvePhoto, reject) => {
    const python = spawn(
      'python3',
      [
        '-c',
        [
          'import sys, base64',
          'sys.path.insert(0, ".")',
          'sys.path.insert(0, "tests")',
          'from synthetic import photo_bytes',
          'sys.stdout.write(base64.b64encode(photo_bytes()).decode())',
        ].join('\n'),
      ],
      { cwd: backendDir },
    );
    let out = '';
    let err = '';
    python.stdout.on('data', (d) => (out += d));
    python.stderr.on('data', (d) => (err += d));
    python.on('close', (code) =>
      code === 0 ? resolvePhoto(Buffer.from(out, 'base64')) : reject(new Error(err)),
    );
  });
}

test('the whole pipeline runs in a browser', async (t) => {
  if (!existsSync(distDir)) {
    t.skip('run `npm run build` first');
    return;
  }
  if (!existsSync(CHROME)) {
    t.skip(`no chromium at ${CHROME}; set RESHOOT_CHROME`);
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'reshoot-e2e-'));
  const server = spawn('python3', ['run.py', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: backendDir,
    env: { ...process.env, RESHOOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));

  let browser;
  try {
    await waitForServer(`${BASE}/api/health`);

    browser = await chromium.launch({
      executablePath: CHROME,
      args: [
        '--no-sandbox',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    assert.match(await page.textContent('.header-title h1'), /Step 1 of 6/);

    // --- Step 1: upload ---------------------------------------------------
    await page.setInputFiles('input[type=file]', {
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await makePhoto(),
    });
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 2'),
    );

    // --- Step 2: perspective ---------------------------------------------
    // The auto-detect job starts on entry; wait for it to settle.
    await waitForIdle(page, 90000);
    const readout = await page.textContent('.readout');
    assert.match(readout, /mm equivalent/, `solve readout was: ${readout}`);

    await page.click('button:has-text("Confirm perspective")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 3'),
    );

    // --- Step 3: proxy ----------------------------------------------------
    await waitForIdle(page, 120000);
    await page.waitForFunction(() => document.querySelectorAll('.object-chip').length > 0);
    const primitives = await page.locator('.object-chip').count();
    assert.ok(primitives >= 1, 'the proxy should contain at least the floor');

    await page.click('button:has-text("Confirm proxy")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 4'),
    );

    // --- Step 4: people ---------------------------------------------------
    await waitForIdle(page, 120000);
    // No detector is installed in this environment, so draw a box by hand.
    const overlay = await page.locator('canvas').first().boundingBox();
    assert.ok(overlay.height > 100, 'the photo frame should have laid out');
    await page.mouse.move(overlay.x + overlay.width * 0.42, overlay.y + overlay.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(overlay.x + overlay.width * 0.48, overlay.y + overlay.height * 0.86, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.object-chip')].some((n) =>
          n.textContent?.startsWith('Person'),
        ),
      { timeout: 30000 },
    );

    await page.click('button:has-text("Confirm people")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 5'),
    );

    // --- Step 5: navigate -------------------------------------------------
    await page.waitForSelector('.joypad.left');
    await page.waitForSelector('.joypad.right');
    const stage = await page.locator('.stage').boundingBox();
    // Drag across the middle of the scene to orbit, avoiding both sticks.
    await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.66, stage.y + stage.height * 0.35, {
      steps: 10,
    });
    await page.mouse.up();
    // Push the move stick so the camera actually leaves the original position.
    const pad = await page.locator('.joypad.left').boundingBox();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + 8, { steps: 5 });
    await new Promise((r) => setTimeout(r, 700));
    await page.mouse.up();

    const heading = await page.textContent('.stage-overlay .readout');
    assert.match(heading, /heading/);

    await page.click('button:has-text("Lock this angle")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 6'),
    );

    // --- Step 6: render ---------------------------------------------------
    await page.click('button:has-text("Render this angle")');
    await waitForIdle(page, 180000);
    await page.waitForSelector('.compare img');
    const note = await page.textContent('.controls .hint');
    assert.match(note, /proxy-reprojection/, `render note was: ${note}`);
    assert.equal(await page.locator('.result-grid .result-tile').count(), 4);

    // The result must be a real image, not a broken link.
    const resultOk = await page.evaluate(() => {
      const img = document.querySelector('.compare img');
      return img instanceof HTMLImageElement && img.naturalWidth > 0;
    });
    assert.ok(resultOk, 'the generated frame should have loaded');

    // --- back navigation keeps the confirmed work -------------------------
    await page.click('.step-chip:has-text("Perspective")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 2'),
    );
    assert.match(await page.textContent('.readout'), /mm equivalent/);

    await page.click('.step-chip:has-text("Proxy scene")');
    await page.waitForFunction(() =>
      document.querySelector('.header-title h1')?.textContent?.includes('Step 3'),
    );
    // Coming back must reuse the saved proxy rather than rebuilding it.
    assert.equal(await page.locator('.object-chip').count(), primitives);
    assert.ok(
      !(await page.locator('.progress-strip').isVisible()),
      'stepping back should not start a job',
    );

    assert.deepEqual(errors, [], 'the browser console should stay clean');
  } catch (error) {
    if (browser) {
      const [page] = browser.contexts().flatMap((context) => context.pages());
      const shot = join(tmpdir(), `reshoot-e2e-failure-${Date.now()}.png`);
      await page?.screenshot({ path: shot }).catch(() => undefined);
      console.error(`e2e failed; screenshot written to ${shot}`);
      console.error(serverLog.join(''));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (!server.killed) server.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
    if (process.env.RESHOOT_E2E_LOG) console.log(serverLog.join(''));
  }
});
