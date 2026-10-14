---
name: browser-recordings
description: Use when recording a video of a flow in VS Code's integrated browser through the vscode-tools MCP server's run_playwright_code, such as a demo, a bug reproduction or proof that a change works. Covers page.screencast at the page's size, chapter titles, action and overlay marks, keeping the page painting, and checking the file.
---

# Videos of an integrated-browser page

Record with Playwright's screencast through `run_playwright_code`. Each call gets the same `page`,
so start the recording in one call, run each step in its own call, and stop it in the last one.
The browser-screenshots skill covers the tool's environment and its 5-second default timeout.

## Before you record

- **Keep the page on screen.** Chromium stops painting a page whose editor tab is in the
  background or whose window is covered. The video then comes out about one second long. Ask the
  user to keep the page's editor tab visible for the recording.
- **Check that it paints.** Count `requestAnimationFrame` calls over one second:

  ```js
  return await page.evaluate(() => new Promise(done => {
    let frames = 0;
    const tick = () => { frames++; requestAnimationFrame(tick) };
    requestAnimationFrame(tick);
    setTimeout(() => done(frames), 1000);
  }));
  ```

  A page that paints gives dozens of frames. A page that is not on screen gives 0 or close to it.
- **Set the viewport.** A page that is not on screen paints at 1024×768 only, so a wider viewport
  comes out cut off. `page.setViewportSize` sets it.
- **Start in a fresh tab after an experiment.** A mark from an earlier call that was never
  disposed stays on the page and shows in every later clip.

## Record

1. Start at the page's size: its `innerWidth` and `innerHeight`, rounded down to even numbers.
   Without `size`, Playwright records a fixed 800×600 frame and scales the page down into it, so
   the text is unreadable:

   ```js
   const { w, h } = await page.evaluate(() => ({ w: innerWidth - (innerWidth % 2), h: innerHeight - (innerHeight % 2) }));
   await page.screencast.start({ path: '/absolute/path/flow.webm', size: { width: w, height: h } });
   await page.screencast.showActions();
   ```

   `showActions` shows the cursor and a title for each action, such as a click.
2. Before each step, name it: `await page.screencast.showChapter('Save the settings')`. A chapter
   shows for 2 seconds; `{ description, duration }` add a second line and change the time.
3. Mark what the viewer should look at with `page.screencast.showOverlay(html)`. It draws on the
   recording, not in the app, and returns a disposable. Dispose each mark before the next step.

   ```js
   const box = await page.getByRole('row', { name: 'db1' }).boundingBox();
   const mark = await page.screencast.showOverlay(
     `<div style="position:fixed;left:${box.x - 6}px;top:${box.y - 6}px;width:${box.width + 12}px;height:${box.height + 12}px;border:3px solid #2da44e;border-radius:6px"></div>` +
     `<div style="position:fixed;left:${box.x - 6}px;top:${box.y + box.height + 12}px;background:#2da44e;color:#fff;font:600 15px system-ui;padding:4px 10px;border-radius:4px">One row: the copy is gone</div>`);
   await page.waitForTimeout(2000);
   await mark.dispose();
   ```

   A label says what to see: "One row: the copy is gone", not "the row". Use green for the
   expected result and red for a problem. Mark only what stays on screen while the mark does. A
   message that closes on its own leaves an empty frame; put that result in the chapter instead.
4. Stop: `await page.screencast.stop()`. It writes the file.

Keep a clip to one flow. When the app waits minutes for a backend, stop the clip and start a new
one after the wait.

## Check the file

Before you share a video, check its size and length with
`ffprobe -v error -show_entries stream=width,height:format=duration <file>`. Look at a frame
from the middle: `ffmpeg -v error -ss <seconds> -i <file> -frames:v 1 frame.png`, then read the
image. A clip of about one second means the page stopped painting.
