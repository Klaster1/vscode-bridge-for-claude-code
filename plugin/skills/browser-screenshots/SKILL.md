---
name: browser-screenshots
description: Use when taking screenshots of a page in VS Code's integrated browser through the vscode-tools MCP server, to check how a page looks, to save shots to files, or to capture a section or an element at 2x for a report or a before/after comparison. Covers screenshot_page against run_playwright_code, the viewport size, the 1024×768 limit of a page that is not on screen, the environment and timeout of run_playwright_code, and a 2x capture.
---

# Screenshots of an integrated-browser page

The vscode-tools MCP server drives VS Code's integrated browser. Every browser tool takes a page
ID. `shared_browser_pages` lists the pages the user shared with you, and `open_browser_page`
returns the ID of a page it opens.

## Pick the tool

- **To look at a page yourself,** call `screenshot_page`. It returns the viewport, or one element
  by `ref` (from `read_page`) or by `selector`. The image comes back to you, not to a file.
- **To read text or find an element,** call `read_page`. Its snapshot is cheaper than an image and
  gives the `ref` values that the click and type tools take.
- **To save a file, set the size or capture at 2x,** call `run_playwright_code`.

## run_playwright_code

- The code gets a `page` object, a Playwright `Page`. It has no `require`, `import` or `fs`.
  `page.screenshot({ path })` writes a file, so give an absolute path.
- Reach the DOM through `page.evaluate(() => …)`. The code itself can't read `document` or
  `window`.
- The value the code returns comes back as the tool result. Return JSON text for structured data.
- A call stops after 5 seconds unless you pass `timeoutMs`. A call that runs longer returns a
  `deferredResultId`; pass it back to wait for the result.

## The viewport

- Set the size before a shot: `await page.setViewportSize({ width: 1280, height: 800 })`.
- **A page that is not on screen paints at 1024×768 only.** A larger viewport then comes out cut
  off, with a grey band. Keep the viewport at 1024×768 or less, or ask the user to bring the page's
  editor tab to the front.
- A page in a background tab also stalls its animations, such as a panel that expands. Take shots
  that depend on an animation while the page is on screen.

## A 2x capture

The page renders at device pixel ratio 1. `page.screenshot` resets a ratio set through the
DevTools protocol (`Emulation.setDeviceMetricsOverride`). For a sharp shot, zoom the page instead:

1. Move the mouse to the page edge with `page.mouse.move(2, 2)`, so no hover style shows.
2. Hide fixed and sticky overlays, such as a header or a footer, that would cover the section.
3. Set `zoom: 2` on `<html>`. Wait about a second for the layout.
4. Measure the section with `getBoundingClientRect()`. It stays in unzoomed CSS pixels, while
   `innerHeight` is in zoomed pixels, so the usable viewport height is `innerHeight / 2`.
5. Call `page.screenshot` with `clip` set to the rect times 2. Clamp `y` to 0 or more: a top of
   -0.2 px throws "Clipped area is either empty or outside".
6. A section taller than the viewport takes several shots: scroll, measure, clip, repeat. Stack
   the parts afterwards, for example with
   `ffmpeg -i part-0.png -i part-1.png -filter_complex vstack=inputs=2 section.png`.
7. Remove the zoom and show the overlays again.

```js
await page.mouse.move(2, 2);
await page.evaluate(() => { document.documentElement.style.zoom = '2' });
await page.waitForTimeout(1000);
const r = await page.evaluate(() => {
  const b = document.querySelector('#settings').getBoundingClientRect(); // The section to capture.
  return { x: b.left, y: b.top, w: b.width, h: Math.min(b.height, innerHeight / 2 - b.top) };
});
await page.screenshot({ path: '/absolute/path/settings.png', clip: { x: r.x * 2, y: Math.max(0, r.y * 2), width: r.w * 2, height: r.h * 2 } });
await page.evaluate(() => { document.documentElement.style.zoom = '' });
```

Element-level CSS `zoom` breaks the crop box of `locator.screenshot`, so zoom `<html>` only.

## Check the file

Check each file before you use it: read the image, and check its size with
`ffprobe -v error -show_entries stream=width,height <file>`. A 2x shot is twice the CSS size of
the section, within 2 pixels.
