/** rAF loop with a rolling FPS estimate. FPS is a budget gate, so it is measured, not vibed. */
export function startLoop(step: (dtMs: number) => void, onFps: (fps: number) => void) {
  let last = performance.now(), acc = 0, frames = 0, raf = 0;
  const tick = (now: number) => {
    const dt = now - last; last = now;
    acc += dt; frames++;
    if (acc >= 500) { onFps(Math.round((frames * 1000) / acc)); acc = 0; frames = 0; }
    step(dt);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
