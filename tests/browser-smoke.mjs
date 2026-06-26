import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const externalUrl = process.env.NOTATION_MVP_URL;
const localServer = externalUrl ? null : await startStaticServer(root);
const baseUrl = externalUrl ?? localServer.url;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  // Home shows the three feature entries.
  await assert.ok(await page.getByRole('button', { name: '唱谱模式' }).isVisible());
  await assert.ok(await page.getByRole('button', { name: '弹奏模式' }).isVisible());
  await assert.ok(await page.getByRole('button', { name: '声音校准' }).isVisible());

  // Sound-calibration closed loop: open screen, record calibration, return home.
  await page.getByRole('button', { name: '声音校准' }).click();
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__demoCalibrate());
  await page.getByRole('button', { name: /完成并返回/ }).click();
  await page.waitForTimeout(120);

  const afterCal = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(afterCal.screen, 'home');
  assert.equal(afterCal.calibration.sing, true, 'singing calibration should be recorded');
  assert.equal(afterCal.calibration.play, true, 'piano calibration should be recorded');

  // Enter the singing game and place notes via the fallback pad.
  await page.getByRole('button', { name: '唱谱模式' }).click();
  await page.waitForTimeout(120);
  await page.getByRole('button', { name: 'Do' }).click();
  await page.waitForTimeout(120);
  await page.evaluate(() => window.advanceTime?.(900));
  await page.getByRole('button', { name: 'Re' }).click();
  await page.waitForTimeout(120);

  const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(state.screen, 'game');
  assert.equal(state.mode, 'sing');
  assert.ok(state.placedNotes.length >= 1, 'at least one note should be placed on the staff');

  const canvasHasPixels = await page.evaluate(() => {
    const canvas = document.querySelector('#game-canvas');
    const context = canvas.getContext('2d');
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0 && (data[index - 1] > 12 || data[index - 2] > 12 || data[index - 3] > 12)) {
        return true;
      }
    }
    return false;
  });

  assert.equal(canvasHasPixels, true, 'canvas should render visible pixels');
  await page.screenshot({ path: '.logs/notation-mvp-smoke.png', fullPage: true });
} finally {
  await browser.close();
  if (localServer) {
    await new Promise((resolve) => localServer.server.close(resolve));
  }
}

async function startStaticServer(rootDir) {
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(rootDir, safePath === '/' ? 'index.html' : safePath);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': contentType(filePath) });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function contentType(filePath) {
  const types = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.png': 'image/png'
  };
  return types[extname(filePath)] ?? 'application/octet-stream';
}
