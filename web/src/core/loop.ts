/**
 * rAF loop with two separate measurements, because they answer different questions.
 *
 * `fps` is how often frames are being presented — which the environment can cap. Headless Chrome
 * presents at 30 Hz here whatever the app does, and a QA gate asserting fps was therefore measuring
 * the harness, not the app.
 *
 * `frameMs` is how long our own step + render call takes. That is the number the performance
 * budget is actually about, and it is the one that moves when a layer gets expensive.
 */
export function startLoop(
  step: (dtMs: number) => void,
  onSample: (fps: number, frameMs: number) => void,
) {
  let last = performance.now(), acc = 0, frames = 0, work = 0, raf = 0;
  const tick = (now: number) => {
    const dt = now - last; last = now;
    acc += dt; frames++;

    const t0 = performance.now();
    step(dt);
    work += performance.now() - t0;

    if (acc >= 500) {
      onSample(Math.round((frames * 1000) / acc), work / frames);
      acc = 0; frames = 0; work = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
