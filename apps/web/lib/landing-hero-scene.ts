import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { readHeroColors, type HeroColors } from "./hero-colors";

// The landing hero: the brand mark (four tally strokes, one strike) as lit
// boxes that drift slowly and lean toward the pointer. Geometry follows
// components/tally-mark.tsx in its 16-unit space. Only named three exports are
// imported so the lazy chunk stays small (light intensities are in three's physical units, so ~pi for full diffuse); this module is only ever loaded
// through a dynamic import() from components/landing/tally-hero.tsx.

export interface HeroHandle {
  /** re-read the tokens after a theme change */
  refreshColors(): void;
  dispose(): void;
}

const STROKE_XS = [3, 6, 9, 12];
const STRIKE = { from: [1.2, 12.8], to: [14.8, 3.4] } as const;

export function mountHeroScene(host: HTMLElement): HeroHandle | null {
  const colors0 = readHeroColors(host);
  if (!colors0) return null;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null; // no WebGL: the static mark stays
  }
  const gl = renderer.getContext();
  if (!gl) {
    renderer.dispose();
    return null;
  }

  const scene = new Scene();
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(0, 0, 30);
  scene.add(new AmbientLight(undefined, 2.0));
  const sun = new DirectionalLight(undefined, 1.4);
  sun.position.set(-8, 12, 20);
  scene.add(sun);

  const strokeMat = new MeshLambertMaterial({ color: new Color(colors0.stroke) });
  const strikeMat = new MeshLambertMaterial({ color: new Color(colors0.strike) });
  const mark = new Group();
  const geoms: BoxGeometry[] = [];
  const box = (w: number, h: number, d: number) => {
    const g = new BoxGeometry(w, h, d);
    geoms.push(g);
    return g;
  };
  for (const x of STROKE_XS) {
    const m = new Mesh(box(1.6, 12, 1.6), strokeMat);
    m.position.set(x - 8, 0, 0);
    mark.add(m);
  }
  const dx = STRIKE.to[0] - STRIKE.from[0];
  const dy = STRIKE.from[1] - STRIKE.to[1]; // svg y points down
  const strike = new Mesh(box(Math.hypot(dx, dy) + 1.6, 2.2, 2.2), strikeMat);
  strike.rotation.z = Math.atan2(dy, dx);
  strike.position.set((STRIKE.from[0] + STRIKE.to[0]) / 2 - 8, 8 - (STRIKE.from[1] + STRIKE.to[1]) / 2, 2.4);
  mark.add(strike);
  scene.add(mark);

  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  host.appendChild(canvas);

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    const half = 10;
    const aspect = width / height;
    camera.left = -half * Math.max(1, aspect);
    camera.right = half * Math.max(1, aspect);
    camera.top = half / Math.min(1, aspect);
    camera.bottom = -half / Math.min(1, aspect);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // pointer lean, eased; idle drift keeps it alive without anyone touching it
  let tx = 0;
  let ty = 0;
  const onMove = (e: PointerEvent) => {
    tx = (e.clientX / window.innerWidth - 0.5) * 2;
    ty = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  let raf = 0;
  let visible = true;
  let tabShown = !document.hidden;
  const t0 = performance.now();
  const frame = (now: number) => {
    raf = 0;
    const t = (now - t0) / 1000;
    mark.rotation.y += (tx * 0.35 + Math.sin(t * 0.35) * 0.18 - mark.rotation.y) * 0.06;
    mark.rotation.x += (ty * 0.2 + Math.cos(t * 0.27) * 0.06 - mark.rotation.x) * 0.06;
    renderer.render(scene, camera);
    if (visible && tabShown) raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!raf && visible && tabShown) raf = requestAnimationFrame(frame);
  };
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    kick();
  });
  io.observe(host);
  const onVis = () => {
    tabShown = !document.hidden;
    kick();
  };
  document.addEventListener("visibilitychange", onVis);
  kick();

  return {
    refreshColors() {
      const c: HeroColors | null = readHeroColors(host);
      if (!c) return;
      strokeMat.color.setHex(c.stroke);
      strikeMat.color.setHex(c.strike);
      kick();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      for (const g of geoms) g.dispose();
      strokeMat.dispose();
      strikeMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss(); // release the GL context now, not at GC (HMR and back-navigation remount)
      canvas.remove();
    },
  };
}
