import asyncio
import argparse
import json
import os
from pathlib import Path
import re

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[2]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--width', type=int, default=1280)
    parser.add_argument('--height', type=int, default=800)
    args = parser.parse_args()
    state_path = Path(os.environ.get('FISH_COMPETITION_STATE', str(Path(os.environ['APPDATA']) / 'fish-controller' / 'competition.json')))
    records = json.loads(state_path.read_text(encoding='utf-8-sig')).get('records', [])
    html = (ROOT / 'controller/frontend/public/competition/referee_interface.html').read_text(encoding='utf-8-sig')
    html = re.sub(r'<script src="competition-adapter[^>]*></script>', '', html)
    errors = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel='msedge', headless=True)
        try:
            page = await browser.new_page(viewport={'width': args.width, 'height': args.height})
            page.on('pageerror', lambda error: errors.append(str(error)))

            async def route_request(route):
                path = route.request.url.split('127.0.0.1:8091', 1)[-1]
                if path == '/replay-probe':
                    await route.fulfill(status=200, content_type='text/html', body=html)
                elif path.startswith('/api/vision/recordings/files/'):
                    response = await route.fetch(url='http://127.0.0.1:8091' + path.removeprefix('/api/vision'))
                    await route.fulfill(response=response)
                elif path.startswith('/replay-transport.js'):
                    await route.fulfill(status=200, content_type='application/javascript', body=(ROOT / 'controller/frontend/public/competition/replay-transport.js').read_text(encoding='utf-8-sig'))
                else:
                    await route.continue_()

            await page.route('**/*', route_request)
            await page.goto('http://127.0.0.1:8091/replay-probe')
            await page.evaluate('records => { window.applyCompetitionRecords(records); show("records"); }', records)
            for record in records:
                await page.evaluate('id => { historySelected = id; renderHistoryDetail(); }', record['id'])
                try:
                    await page.wait_for_function('document.getElementById("replayVideo").readyState >= 2', timeout=15000)
                    controls_visible = await page.evaluate('''() => {
                      const visible = id => {
                        const element = document.getElementById(id);
                        const rect = element.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight || rect.right > innerWidth) return false;
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        return hit === element || element.contains(hit);
                      };
                      return {play: visible('replayPlay'), download: visible('replayDownload'), seek: visible('replaySeek')};
                    }''')
                    print(json.dumps({'viewport': vars(args), 'controlsVisible': controls_visible}, ensure_ascii=False), flush=True)
                    await page.locator('#replayPlay').click()
                    await page.wait_for_function('document.getElementById("replayVideo").currentTime > 0.5', timeout=10000)
                    metrics = await page.evaluate('() => { const video = document.getElementById("replayVideo"); return {currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight, error: video.error?.code, status: document.getElementById("videoFileName").textContent}; }')
                    print(json.dumps({'record': record['id'], 'playback': metrics, 'pageErrors': errors}, ensure_ascii=False), flush=True)
                    if not all(controls_visible.values()):
                        raise RuntimeError('Replay controls are outside the visible workspace')
                    await page.evaluate('document.getElementById("replayVideo").pause()')
                except Exception as error:
                    print(json.dumps({'record': record['id'], 'failure': type(error).__name__, 'pageErrors': errors}, ensure_ascii=False), flush=True)
                    raise
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
