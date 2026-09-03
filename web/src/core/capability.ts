export interface Capability { webgl2: boolean; webgl: boolean; renderer: string; reducedMotion: boolean }

export function probe(): Capability {
  const c = document.createElement("canvas");
  const gl2 = c.getContext("webgl2");
  const gl = gl2 ?? c.getContext("webgl");
  let renderer = "unknown";
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  }
  return {
    webgl2: !!gl2, webgl: !!gl, renderer,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}
