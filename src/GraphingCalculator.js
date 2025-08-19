import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Parser } from "expr-eval";

// Capacitor (iOS native behaviors)
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Clipboard } from "@capacitor/clipboard";
import { StatusBar, Style } from "@capacitor/status-bar";

/**
 * Graphos — Desmos-like Graphing Calculator (React + Tailwind)
 * Additions in this version:
 * - Auto-analysis: x-intercepts, y-intercepts, local min/max, intersections (explicit curves)
 * - Markers on canvas + Analysis sidebar list (click to center)
 * - Tap canvas to drop a label; long-press to copy coords
 * - Everything else preserved (parametric, polar, implicit, inequalities, sliders, menu, export/share, responsive canvas, iOS safe areas)
 */

const casRef = { current: null };

// ------- Stats (jStat) lazy loader -------
const statsRef = { current: null };
async function ensureStats() {
  if (statsRef.current) return statsRef.current;
  const mod = await import(/* webpackChunkName: "stats" */ 'jstat');
  const jStat = mod.jStat || mod.default || mod; // different builds expose differently
  statsRef.current = jStat;
  return jStat;
}

async function ensureCAS() {
  if (casRef.current) return casRef.current;
  // Load core + modules on demand (code-split)
  const nerdamer = (await import(/* webpackChunkName: "cas" */ 'nerdamer')).default || (await import('nerdamer'));
  await import('nerdamer/Algebra');
  await import('nerdamer/Calculus');
  await import('nerdamer/Solve');
  casRef.current = nerdamer;
  return nerdamer;
}

const COLORS = [
  "#22c55e", "#3b82f6", "#ef4444", "#a855f7", "#f59e0b",
  "#10b981", "#06b6d4", "#f43f5e", "#8b5cf6", "#14b8a6",
];

const isNative = Capacitor?.isNativePlatform?.() ?? false;
const isFlutter = typeof window !== "undefined" && !!window.flutter_inappwebview;
async function flutterCall(name, ...args) {
  try {
    if (isFlutter && window.flutter_inappwebview?.callHandler) {
      return await window.flutter_inappwebview.callHandler(name, ...args);
    }
  } catch { }
}

// ---------------- Theme ----------------
const useTheme = () => {
  const [dark, setDark] = useState(() => localStorage.getItem("gc-theme") === "dark");
  useEffect(() => {
    localStorage.setItem("gc-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return { dark, setDark };
};

// ---------------- Parser helpers ----------------
function compileExpr(src) {
  const parser = new Parser({ allowMemberAccess: false });

  // constants
  parser.consts.pi = Math.PI;
  parser.consts.e = Math.E;
  parser.consts.tau = 2 * Math.PI;
  parser.consts.phi = (1 + Math.sqrt(5)) / 2;

  // ln alias
  parser.functions.ln = Math.log;

  // functions
  const f = parser.functions;

  // trig complements
  f.sec = (x) => 1 / Math.cos(x);
  f.csc = (x) => 1 / Math.sin(x);
  f.cot = (x) => 1 / Math.tan(x);
  // hyperbolic + complements
  f.sinh = Math.sinh; f.cosh = Math.cosh; f.tanh = Math.tanh;
  f.asinh = Math.asinh; f.acosh = Math.acosh; f.atanh = Math.atanh;
  f.sech = (x) => 1 / Math.cosh(x);
  f.csch = (x) => 1 / Math.sinh(x);
  f.coth = (x) => 1 / Math.tanh(x);

  // degrees helpers
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  f.rad = (x) => x * D2R; f.deg = (x) => x * R2D;
  f.sind = (x) => Math.sin(x * D2R); f.cosd = (x) => Math.cos(x * D2R); f.tand = (x) => Math.tan(x * D2R);
  f.asind = (x) => Math.asin(x) * R2D; f.acosd = (x) => Math.acos(x) * R2D; f.atand = (x) => Math.atan(x) * R2D;

  // logs
  f.log10 = Math.log10 ? Math.log10 : (x) => Math.log(x) / Math.LN10;
  f.log2 = Math.log2 ? Math.log2 : (x) => Math.log(x) / Math.LN2;
  f.logb = (x, b) => Math.log(x) / Math.log(b);

  // utilities
  f.clamp = (x, a, b) => Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b));
  f.lerp = (a, b, t) => a + (b - a) * t;
  f.heaviside = (x) => (x > 0 ? 1 : x < 0 ? 0 : 0.5);
  f.step = f.heaviside;
  f.sgn = (x) => Math.sign(x);

  // combinatorics
  const factorial = (n) => { if (n < 0 || !Number.isFinite(n) || Math.floor(n) !== n) return NaN; let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
  f.fact = factorial; f.factorial = factorial;
  f.nCr = (n, r) => factorial(n) / (factorial(r) * factorial(n - r));
  f.nPr = (n, r) => factorial(n) / factorial(n - r);

  // piecewise(cond1,val1,cond2,val2,...,default)
  f.piecewise = (...args) => { if (args.length < 3) return NaN; for (let i = 0; i < args.length - 1; i += 2) { if (args[i]) return args[i + 1]; } return args[args.length - 1]; };

  return parser.parse(src);
}

const RESERVED = new Set([
  "x", "y", "t", "theta", "ans", "pi", "e", "tau", "phi",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "abs", "log", "ln", "exp", "sqrt", "random",
  "min", "max", "round", "floor", "ceil", "trunc", "sign", "sgn", "if", "mod", "pow",
  "sec", "csc", "cot", "sech", "csch", "coth",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "sind", "cosd", "tand", "asind", "acosd", "atand", "deg", "rad",
  "log10", "log2", "logb",
  "piecewise", "clamp", "lerp", "heaviside", "step",
  "fact", "factorial", "nCr", "nPr"
]);
function detectParams(src) {
  const ids = /[A-Za-z_][A-Za-z0-9_]*/g; const out = new Set(); let m;
  while ((m = ids.exec(src))) { const name = m[0]; if (!RESERVED.has(name)) out.add(name); }
  return [...out];
}

// ---------------- Transforms & Grid ----------------
function makeTransform({ xMin, xMax, yMin, yMax, width, height }) {
  const xScale = width / (xMax - xMin);
  const yScale = height / (yMax - yMin);
  return {
    xScale, yScale,
    xToPx: (x) => (x - xMin) * xScale,
    yToPx: (y) => height - (y - yMin) * yScale,
    pxToX: (px) => px / xScale + xMin,
    pxToY: (py) => (height - py) / yScale + yMin,
  };
}
function niceStep(range) {
  const rough = range / 10; const p = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-12))));
  const r = rough / p; if (r >= 5) return 5 * p; if (r >= 2) return 2 * p; return 1 * p;
}
function drawGrid(ctx, t, view, w, h, dark) {
  const xMajor = niceStep(view.xMax - view.xMin), yMajor = niceStep(view.yMax - view.yMin);
  const xMinor = xMajor / 5, yMinor = yMajor / 5;
  // minor
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = dark ? "#151b22" : "#f5f7fb";
  for (let x = Math.ceil(view.xMin / xMinor) * xMinor; x <= view.xMax; x += xMinor) { const px = t.xToPx(x); ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke(); }
  for (let y = Math.ceil(view.yMin / yMinor) * yMinor; y <= view.yMax; y += yMinor) { const py = t.yToPx(y); ctx.beginPath(); ctx.moveTo(0, py + 0.5); ctx.lineTo(w, py + 0.5); ctx.stroke(); }
  ctx.restore();
  // major
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = dark ? "#1f2630" : "#e7ebf0";
  for (let x = Math.ceil(view.xMin / xMajor) * xMajor; x <= view.xMax; x += xMajor) { const px = t.xToPx(x); ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke(); }
  for (let y = Math.ceil(view.yMin / yMajor) * yMajor; y <= view.yMax; y += yMajor) { const py = t.yToPx(y); ctx.beginPath(); ctx.moveTo(0, py + 0.5); ctx.lineTo(w, py + 0.5); ctx.stroke(); }
  ctx.restore();
  // axes
  ctx.save(); ctx.strokeStyle = dark ? "#5c6b7a" : "#9aa4b2"; ctx.lineWidth = 1.25;
  if (view.xMin <= 0 && view.xMax >= 0) { const px = Math.round(t.xToPx(0)) + 0.5; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); }
  if (view.yMin <= 0 && view.yMax >= 0) { const py = Math.round(t.yToPx(0)) + 0.5; ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke(); }
  ctx.restore();
  // labels
  ctx.save(); ctx.fillStyle = dark ? "#93a1b3" : "#6b7280"; ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
  for (let x = Math.ceil(view.xMin / xMajor) * xMajor; x <= view.xMax; x += xMajor) { const px = t.xToPx(x); const py = t.yToPx(0); ctx.fillText(Number(x.toFixed(2)).toString(), px + 4, Math.min(h - 4, Math.max(12, py - 6))); }
  for (let y = Math.ceil(view.yMin / yMajor) * yMajor; y <= view.yMax; y += yMajor) { const py = t.yToPx(y); const px = t.xToPx(0); ctx.fillText(Number(y.toFixed(2)).toString(), Math.min(w - 28, Math.max(4, px + 6)), py - 4); }
  ctx.restore();
}

// ---------------- Renderers ----------------
function plotFunction(ctx, t, view, fn, color, lw, w, h, pxStep, domain) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
  const dx = Math.max(pxStep, 0.5) / t.xScale;
  const xStart = domain?.use ? Math.max(view.xMin, domain.min) : view.xMin;
  const xEnd = domain?.use ? Math.min(view.xMax, domain.max) : view.xMax;
  let move = true;
  for (let x = xStart; x <= xEnd; x += dx) {
    let y; try { y = fn(x); } catch { y = NaN; }
    if (!Number.isFinite(y)) { move = true; continue; }
    const px = t.xToPx(x), py = t.yToPx(y);
    if (py < -1e6 || py > h + 1e6) { move = true; continue; }
    if (move) { ctx.moveTo(px, py); move = false; } else ctx.lineTo(px, py);
  }
  ctx.stroke(); ctx.restore();
}
function drawImplicit(ctx, t, view, F, color, lw, w, h, gridX, dashed = false) {
  const cols = Math.max(10, Math.floor(gridX));
  const rows = Math.max(10, Math.floor(cols * (h / w)));
  const dx = (view.xMax - view.xMin) / cols, dy = (view.yMax - view.yMin) / rows;
  const evalF = (x, y) => { try { const v = F(x, y); return Number.isFinite(v) ? v : NaN; } catch { return NaN; } };
  const interp = (x1, y1, f1, x2, y2, f2) => { const a = (f1 - f2) === 0 ? 0.5 : f1 / (f1 - f2); const x = x1 + a * (x2 - x1); const y = y1 + a * (y2 - y1); return { x: t.xToPx(x), y: t.yToPx(y) }; };
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dashed ? [6, 6] : []); ctx.beginPath();
  for (let j = 0; j < rows; j++) {
    const y0 = view.yMin + j * dy, y1 = y0 + dy;
    for (let i = 0; i < cols; i++) {
      const x0 = view.xMin + i * dx, x1 = x0 + dx;
      const f00 = evalF(x0, y0), f10 = evalF(x1, y0), f11 = evalF(x1, y1), f01 = evalF(x0, y1);
      if ([f00, f10, f11, f01].some(v => Number.isNaN(v))) continue;
      const s = (a, b) => a * b <= 0, pts = [];
      if (s(f00, f10)) pts.push(interp(x0, y0, f00, x1, y0, f10));
      if (s(f10, f11)) pts.push(interp(x1, y0, f10, x1, y1, f11));
      if (s(f11, f01)) pts.push(interp(x1, y1, f11, x0, y1, f01));
      if (s(f01, f00)) pts.push(interp(x0, y1, f01, x0, y0, f00));
      if (pts.length === 2) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); }
      else if (pts.length === 4) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.moveTo(pts[2].x, pts[2].y); ctx.lineTo(pts[3].x, pts[3].y); }
    }
  }
  ctx.stroke(); ctx.restore();
}
function fillIneq(ctx, t, view, F, op, color, w, h, gridX) {
  const cols = Math.max(20, Math.floor(gridX));
  const rows = Math.max(20, Math.floor(cols * (h / w)));
  const dx = (view.xMax - view.xMin) / cols, dy = (view.yMax - view.yMin) / rows;
  const cond = (v) => (op === "le" || op === "lt") ? (v <= 0) : (v >= 0);
  ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = color;
  for (let j = 0; j < rows; j++) {
    const y0 = view.yMin + j * dy, y1 = y0 + dy;
    for (let i = 0; i < cols; i++) {
      const x0 = view.xMin + i * dx, x1 = x0 + dx;
      let v; try { v = F((x0 + x1) / 2, (y0 + y1) / 2); } catch { v = NaN; }
      if (!Number.isFinite(v) || !cond(v)) continue;
      const rx = Math.min(t.xToPx(x0), t.xToPx(x1)), ry = Math.min(t.yToPx(y0), t.yToPx(y1));
      const rw = Math.abs(t.xToPx(x1) - t.xToPx(x0)) + 1, rh = Math.abs(t.yToPx(y1) - t.yToPx(y0)) + 1;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  ctx.restore();
}
function fillDoubleIneq(ctx, t, view, F1, op1, F2, op2, color, w, h, gridX) {
  const cols = Math.max(24, Math.floor(gridX));
  const rows = Math.max(24, Math.floor(cols * (h / w)));
  const dx = (view.xMax - view.xMin) / cols, dy = (view.yMax - view.yMin) / rows;
  const c1 = (v) => (op1 === "le" || op1 === "lt") ? (v <= 0) : (v >= 0);
  const c2 = (v) => (op2 === "le" || op2 === "lt") ? (v <= 0) : (v >= 0);
  ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = color;
  for (let j = 0; j < rows; j++) {
    const y0 = view.yMin + j * dy, y1 = y0 + dy;
    for (let i = 0; i < cols; i++) {
      const x0 = view.xMin + i * dx, x1 = x0 + dx;
      let v1, v2; try { const xc = (x0 + x1) / 2, yc = (y0 + y1) / 2; v1 = F1(xc, yc); v2 = F2(xc, yc); } catch { v1 = NaN; v2 = NaN; }
      if (!Number.isFinite(v1) || !Number.isFinite(v2) || !(c1(v1) && c2(v2))) continue;
      const rx = Math.min(t.xToPx(x0), t.xToPx(x1)), ry = Math.min(t.yToPx(y0), t.yToPx(y1));
      const rw = Math.abs(t.xToPx(x1) - t.xToPx(x0)) + 1, rh = Math.abs(t.yToPx(y1) - t.yToPx(y0)) + 1;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  ctx.restore();
}
function drawParametric(ctx, t, view, fx, fy, color, lw, w, h, tmin, tmax, samples) {
  const N = Math.max(100, samples | 0); ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
  let move = true;
  for (let i = 0; i <= N; i++) {
    const tt = tmin + (i / N) * (tmax - tmin);
    let x, y; try { x = fx(tt); y = fy(tt); } catch { x = NaN; y = NaN; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { move = true; continue; }
    const px = t.xToPx(x), py = t.yToPx(y); if (move) { ctx.moveTo(px, py); move = false; } else ctx.lineTo(px, py);
  }
  ctx.stroke(); ctx.restore();
}

function drawDiscretePMF(ctx, t, view, pmf, color, lw = 2) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  const kMin = Math.ceil(view.xMin), kMax = Math.floor(view.xMax);
  for (let k = kMin; k <= kMax; k++) {
    const p = pmf(k); if (!Number.isFinite(p) || p <= 0) continue;
    const x = t.xToPx(k), y0 = t.yToPx(0), y1 = t.yToPx(p);
    ctx.beginPath(); ctx.moveTo(x + 0.5, y0); ctx.lineTo(x + 0.5, y1); ctx.stroke();
  }
  ctx.restore();
}

function drawDiscreteCDF(ctx, t, view, cdf, color, lw = 2) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  const kMin = Math.ceil(view.xMin), kMax = Math.floor(view.xMax);
  let prevPx = null, prevPy = null;
  for (let k = kMin; k <= kMax; k++) {
    const Fk = cdf(k);
    const px = t.xToPx(k), py = t.yToPx(Fk);
    if (prevPx == null) { prevPx = px; prevPy = py; continue; }
    ctx.beginPath(); ctx.moveTo(prevPx, prevPy); ctx.lineTo(px, prevPy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, prevPy); ctx.lineTo(px, py); ctx.stroke();
    prevPx = px; prevPy = py;
  }
  ctx.restore();
}


function drawPolar(ctx, t, view, fr, color, lw, w, h, thmin, thmax, samples) {
  const N = Math.max(180, samples | 0); ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
  let move = true;
  for (let i = 0; i <= N; i++) {
    const th = thmin + (i / N) * (thmax - thmin);
    let r; try { r = fr(th); } catch { r = NaN; }
    if (!Number.isFinite(r)) { move = true; continue; }
    const x = r * Math.cos(th), y = r * Math.sin(th), px = t.xToPx(x), py = t.yToPx(y);
    if (move) { ctx.moveTo(px, py); move = false; } else ctx.lineTo(px, py);
  }
  ctx.stroke(); ctx.restore();
}

// ---------------- Component ----------------
export default function GraphingCalculator() {
  const { dark, setDark } = useTheme();

  // iOS StatusBar / safe-area behavior
  useEffect(() => {
    if (isNative) {
      StatusBar.setOverlaysWebView({ overlay: false }).catch(() => { });
      StatusBar.setStyle({ style: dark ? Style.Light : Style.Dark }).catch(() => { });
    }
  }, [dark]);

  const canvasRef = useRef(null);
  const hoverRef = useRef({ x: null, y: null });

  // Responsive canvas
  const graphBoxRef = useRef(null);
  const [size, setSize] = useState({ width: 600, height: 380 });
  useLayoutEffect(() => {
    const el = graphBoxRef.current; if (!el) return;
    const update = (w) => {
      const width = Math.max(280, Math.round(w));
      const height = Math.max(260, Math.round(width * 0.62));
      setSize({ width, height });
    };
    update(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect?.width || el.getBoundingClientRect().width;
        update(w);
      });
      ro.observe(el); return () => ro.disconnect();
    } else {
      const onResize = () => update(el.getBoundingClientRect().width);
      window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize);
    }
  }, []);

  // Distributions UI state
  const [dist, setDist] = useState('normal'); // 'normal' | 't' | 'chisq' | 'binom' | 'poisson'
  const [dParams, setDParams] = useState({
    mu: 0, sigma: 1,  // normal
    nu: 10,           // t (dof)
    k: 4,             // chisq (dof)
    n: 10, p: 0.5,    // binomial
    lam: 4            // poisson (lambda)
  });
  const [statX, setStatX] = useState(0);        // x or k for pdf/cdf
  const [statProb, setStatProb] = useState(0.95); // p for quantile
  const [sampleSize, setSampleSize] = useState(5);

  // Plotted distributions (drawn on canvas)
  const [statPlots, setStatPlots] = useState([]); // {id,type:'pdf'|'cdf'|'pmf', dist, params, fn, color}


  const [casVar, setCasVar] = useState('x');      // for single-variable solve
  const [casVars, setCasVars] = useState('x,y');  // for systems
  const [view, setView] = useState({ xMin: -10, xMax: 10, yMin: -6, yMax: 6 });
  const viewRef = useRef(view); useEffect(() => { viewRef.current = view; }, [view]);
  const [pxStep, setPxStep] = useState(2);
  const [graphTitle, setGraphTitle] = useState("Untitled Graph");
  const [exprInput, setExprInput] = useState("a*sin(b*x)");
  const [presetOpen, setPresetOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [focusedId, setFocusedId] = useState(null);

  // Tap labels
  const [labels, setLabels] = useState([]); // {id,x,y,text}
  const addLabel = (x, y) => {
    setLabels((arr) => [...arr, { id: Date.now() + Math.random(), x, y, text: `(${x.toFixed(3)}, ${y.toFixed(3)})` }]);
  };

  // Menu
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    const onDocClick = (e) => {
      if (!menuOpen) return;
      const btn = menuBtnRef.current, menu = menuRef.current;
      if (btn && btn.contains(e.target)) return;
      if (menu && menu.contains(e.target)) return;
      setMenuOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const [expressions, setExpressions] = useState([
    { id: 1, src: "sin(x)", color: COLORS[0], visible: true, lineWidth: 2, params: {}, domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: "" }
  ]);

  // -------- compile lines --------
  const compiled = useMemo(() => {
    const norm = (op) => (op === "≤" || op === "<=") ? "le" : (op === "≥" || op === ">=") ? "ge" : (op === "<") ? "lt" : "gt";
    const findOp = (s, ops) => { for (const op of ops) { const i = s.indexOf(op); if (i !== -1) return { op, i }; } return null; };

    let ans = 0; const out = [];

    for (const raw of expressions) {
      const e = { ...raw };
      const names = detectParams(e.src || "");
      const baseParams = Object.fromEntries(names.map(n => [n, 1]));
      const params = { ...baseParams, ...(e.params || {}) };
      const src0 = (e.src || "").trim();
      const src = src0.replace(/θ/g, "theta");

      const hasX = /\bx\b/.test(src), hasY = /\by\b/.test(src);
      const hasT = /\bt\b/.test(src), hasTh = /\btheta\b/.test(src);
      const hasEq = src.includes("="), hasIneq = ["<=", ">=", "<", ">", "≤", "≥"].some(op => src.includes(op));

      // y = ...
      const mY = src.match(/^\s*y\s*=\s*(.+)$/i);
      if (mY) {
        try {
          const ast = compileExpr(mY[1]);
          const fn = (x) => ast.evaluate({ ...params, ans, x });
          out.push({ ...e, kind: "explicit", fn, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "explicit", fn: null, params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // polar r = f(theta)
      const mR = src.match(/\br\s*=\s*([^,;]+)/i);
      if (mR && hasTh) {
        try {
          const ar = compileExpr(mR[1]); let thmin = 0, thmax = 2 * Math.PI;
          const mRange = src.match(/theta\s*(?:in|=)\s*\[\s*([^,\]]+)\s*,\s*([^\]]+)\s*\]/i);
          if (mRange) {
            try { thmin = compileExpr(mRange[1]).evaluate({ ...params, ans }); } catch { }
            try { thmax = compileExpr(mRange[2]).evaluate({ ...params, ans }); } catch { }
          }
          const fr = (theta) => ar.evaluate({ ...params, ans, theta });
          out.push({ ...e, kind: "polar", fr, thmin, thmax, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "polar", fr: null, thmin: 0, thmax: 2 * Math.PI, params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // parametric x(t), y(t)
      if (src.includes("x=") && src.includes("y=") && /\bt\b/.test(src)) {
        try {
          const parts = src.replace(/;/g, ",").split(",").map(s => s.trim());
          let xPart = null, yPart = null, tmin = -10, tmax = 10;
          for (const p of parts) {
            if (p.startsWith("x=")) xPart = p.slice(2);
            else if (p.startsWith("y=")) yPart = p.slice(2);
            else if (/^t\s*=\s*\[/.test(p)) {
              const lb = p.indexOf("["), rb = p.indexOf("]");
              if (lb !== -1 && rb !== -1 && rb > lb) {
                const [a, b] = (p.slice(lb + 1, rb)).split(/\s*,\s*/);
                try { tmin = compileExpr(a).evaluate({ ...params, ans }); } catch { }
                try { tmax = compileExpr(b).evaluate({ ...params, ans }); } catch { }
              }
            }
          }
          if (xPart && yPart) {
            const ax = compileExpr(xPart), ay = compileExpr(yPart);
            const fx = (t) => ax.evaluate({ ...params, ans, t });
            const fy = (t) => ay.evaluate({ ...params, ans, t });
            out.push({ ...e, kind: "parametric", fx, fy, tmin, tmax, params, paramNames: names, error: "" });
            continue;
          }
        } catch (err) {
          out.push({ ...e, kind: "parametric", fx: null, fy: null, tmin: -10, tmax: 10, params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // double inequality A op1 B op2 C
      const mDouble = src.match(/^(.*?)(<=|>=|<|>|≤|≥)(.*?)(<=|>=|<|>|≤|≥)(.*)$/);
      if (mDouble) {
        try {
          const A = compileExpr(mDouble[1]), B = compileExpr(mDouble[3]), C = compileExpr(mDouble[5]);
          const op1 = norm(mDouble[2]), op2 = norm(mDouble[4]);
          const F1 = (x, y) => A.evaluate({ ...params, ans, x, y }) - B.evaluate({ ...params, ans, x, y });
          const F2 = (x, y) => B.evaluate({ ...params, ans, x, y }) - C.evaluate({ ...params, ans, x, y });
          out.push({ ...e, kind: "double-ineq", F1, op1, F2, op2, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "double-ineq", F1: null, F2: null, op1: "le", op2: "le", params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // single inequality
      const ops = ["<=", ">=", "<", ">", "≤", "≥"]; const cmp = ops.map(o => ({ o, i: src.indexOf(o) })).filter(x => x.i !== -1).sort((a, b) => a.i - b.i)[0];
      if (cmp) {
        try {
          const L = compileExpr(src.slice(0, cmp.i)), R = compileExpr(src.slice(cmp.i + cmp.o.length));
          const op = cmp.o === "≤" || cmp.o === "<=" ? "le" : cmp.o === "≥" || cmp.o === ">=" ? "ge" : cmp.o === "<" ? "lt" : "gt";
          const F = (x, y) => L.evaluate({ ...params, ans, x, y }) - R.evaluate({ ...params, ans, x, y });
          out.push({ ...e, kind: "inequality", F, op, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "inequality", F: null, op: "le", params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // implicit equality with x & y present
      if (hasEq && hasX && hasY) {
        const parts = src.split("="); if (parts.length !== 2) { out.push({ ...e, kind: "implicit", F: null, params, paramNames: names, error: "Only one '=' allowed" }); continue; }
        try {
          const L = compileExpr(parts[0]), R = compileExpr(parts[1]);
          const F = (x, y) => L.evaluate({ ...params, ans, x, y }) - R.evaluate({ ...params, ans, x, y });
          out.push({ ...e, kind: "implicit", F, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "implicit", F: null, params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // calculator line
      if (!hasX && !hasY && !hasT && !hasTh && !hasEq) {
        try {
          const ast = compileExpr(src);
          const value = ast.evaluate({ ...params, ans });
          const finite = Number.isFinite(value) ? value : NaN;
          if (Number.isFinite(finite)) ans = finite;
          out.push({ ...e, kind: "scalar", value: finite, params, paramNames: names, error: "" });
          continue;
        } catch (err) {
          out.push({ ...e, kind: "scalar", value: NaN, params, paramNames: names, error: err?.message || "Parse error" });
          continue;
        }
      }

      // explicit fallback
      try {
        const ast = compileExpr(src);
        const fn = (x) => ast.evaluate({ ...params, ans, x });
        out.push({ ...e, kind: "explicit", fn, params, paramNames: names, error: "" });
      } catch (err) {
        out.push({ ...e, kind: "explicit", fn: null, params, paramNames: names, error: err?.message || "Parse error" });
      }
    }
    return out;
  }, [expressions]);

  // -------- draw --------
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const { width, height } = size;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + "px"; canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = dark ? "#0b0f14" : "#ffffff"; ctx.fillRect(0, 0, width, height);
    const t = makeTransform({ ...view, width, height });

    drawGrid(ctx, t, view, width, height, dark);

    const px = pxStep;
    for (const e of compiled) {
      if (!e.visible || e.error) continue;
      if (e.kind === "double-ineq" && e.F1 && e.F2) {
        const gridX = Math.max(60, Math.round(size.width / (6 * px)));
        fillDoubleIneq(ctx, t, view, e.F1, e.op1, e.F2, e.op2, e.color, width, height, gridX);
        drawImplicit(ctx, t, view, e.F1, e.color, 2, width, height, gridX, (e.op1 === "lt" || e.op1 === "gt"));
        drawImplicit(ctx, t, view, e.F2, e.color, 2, width, height, gridX, (e.op2 === "lt" || e.op2 === "gt"));
      } else if (e.kind === "inequality" && e.F) {
        const gridX = Math.max(60, Math.round(size.width / (6 * px)));
        fillIneq(ctx, t, view, e.F, e.op, e.color, width, height, gridX);
        drawImplicit(ctx, t, view, e.F, e.color, 2, width, height, gridX, (e.op === "lt" || e.op === "gt"));
      } else if (e.kind === "implicit" && e.F) {
        const gridX = Math.max(60, Math.round(size.width / (6 * px)));
        drawImplicit(ctx, t, view, e.F, e.color, 2, width, height, gridX, false);
      } else if (e.kind === "parametric" && e.fx && e.fy) {
        const N = Math.max(300, Math.round(size.width / px * 1.5));
        drawParametric(ctx, t, view, e.fx, e.fy, e.color, 2, width, height, e.tmin, e.tmax, N);
      } else if (e.kind === "polar" && e.fr) {
        const N = Math.max(360, Math.round(size.width / px * 2));
        drawPolar(ctx, t, view, e.fr, e.color, 2, width, height, e.thmin, e.thmax, N);
      } else if (e.kind === "explicit" && e.fn) {
        plotFunction(ctx, t, view, e.fn, e.color, 2, width, height, px, e.domain);
      }
    }

    // --- Statistics plots ---
    for (const sp of statPlots) {
      if (!sp) continue;
      const { type, dist, fn, color, params } = sp;

      if (!isDiscreteDist(dist)) {
        // continuous: reuse plotFunction
        if (typeof fn === 'function') {
          plotFunction(ctx, t, view, fn, color, 2, width, height, pxStep, null);
        }
      } else {
        const jStat = statsRef.current; // loaded once addStatPlot was used
        if (!jStat) continue;

        if (dist === 'binom') {
          const n = params.n | 0, p = Math.min(1, Math.max(0, params.p));
          if (type === 'pmf' || type === 'pdf') {
            const pmf = (k) => jStat.binomial.pdf(k, n, p);
            drawDiscretePMF(ctx, t, view, pmf, color, 2);
          } else if (type === 'cdf') {
            const cdf = (k) => jStat.binomial.cdf(k, n, p);
            drawDiscreteCDF(ctx, t, view, cdf, color, 2);
          }
        }
        if (dist === 'poisson') {
          const lam = Math.max(0, params.lam);
          if (type === 'pmf' || type === 'pdf') {
            const pmf = (k) => jStat.poisson.pdf(k, lam);
            drawDiscretePMF(ctx, t, view, pmf, color, 2);
          } else if (type === 'cdf') {
            const cdf = (k) => jStat.poisson.cdf(k, lam);
            drawDiscreteCDF(ctx, t, view, cdf, color, 2);
          }
        }
      }
    }

    // Draw analysis markers
    for (const p of analysis.allPoints) {
      const pxp = t.xToPx(p.x), pyp = t.yToPx(p.y);
      if (pxp < -4 || pxp > width + 4 || pyp < -4 || pyp > height + 4) continue;
      ctx.save();
      ctx.fillStyle = p.color || (dark ? "#e5e7eb" : "#111827");
      ctx.strokeStyle = dark ? "#0b0f14" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pxp, pyp, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // Draw user labels
    for (const L of labels) {
      const pxp = t.xToPx(L.x), pyp = t.yToPx(L.y);
      ctx.save();
      // stem
      ctx.strokeStyle = dark ? "#94a3b8" : "#64748b";
      ctx.beginPath(); ctx.moveTo(pxp, pyp); ctx.lineTo(pxp + 10, pyp - 10); ctx.stroke();
      // dot
      ctx.fillStyle = dark ? "#e2e8f0" : "#111827";
      ctx.beginPath(); ctx.arc(pxp, pyp, 3, 0, Math.PI * 2); ctx.fill();
      // label bubble
      const txt = L.text; ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
      const tw = ctx.measureText(txt).width + 10, th = 18;
      ctx.fillStyle = dark ? "rgba(30,41,59,0.9)" : "rgba(255,255,255,0.95)";
      ctx.strokeStyle = dark ? "#0f172a" : "#e5e7eb";
      ctx.lineWidth = 1;
      const bx = pxp + 12, by = pyp - 24;
      ctx.beginPath(); ctx.roundRect?.(bx, by, tw, th, 6);
      if (!ctx.roundRect) { ctx.rect(bx, by, tw, th); }
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = dark ? "#e2e8f0" : "#111827";
      ctx.fillText(txt, bx + 5, by + 12.5);
      ctx.restore();
    }

    // Crosshair
    const hx = hoverRef.current.x, hy = hoverRef.current.y;
    if (hx != null && hy != null) {
      ctx.save(); ctx.strokeStyle = dark ? "#475569" : "#94a3b8"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx + 0.5, 0); ctx.lineTo(hx + 0.5, height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, hy + 0.5); ctx.lineTo(width, hy + 0.5); ctx.stroke();
      ctx.restore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, view, size, dark, pxStep, labels, statPlots]);

  // -------- interactions (pan/zoom/hover + tap/long-press) --------
  // Find nearest label to a canvas pixel point
  const findNearestLabelPx = (px, py) => {
    if (!labels.length) return null;
    const t = makeTransform({ ...viewRef.current, width: size.width, height: size.height });
    let best = null, bestD2 = Infinity;
    for (const L of labels) {
      const lx = t.xToPx(L.x), ly = t.yToPx(L.y);
      const d2 = (lx - px) * (lx - px) + (ly - py) * (ly - py);
      if (d2 < bestD2) { bestD2 = d2; best = L; }
    }
    // within ~18px radius
    return bestD2 <= 18 * 18 ? best : null;
  };
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    let dragging = false; let last = { x: 0, y: 0 };
    let pressTimer = null; let downAt = 0; let downPos = { x: 0, y: 0 }; let moved = false;

    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

    const onPointerDown = (e) => {
      dragging = true; setIsDragging(true); moved = false;
      last = { x: e.clientX, y: e.clientY }; downPos = last; downAt = Date.now();
      try { canvas.setPointerCapture(e.pointerId); } catch { }

      // schedule long-press copy (+ drop label)
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      pressTimer = setTimeout(() => {
        const t = makeTransform({ ...viewRef.current, width: size.width, height: size.height });
        const x = t.pxToX(px), y = t.pxToY(py);
        copyText(`(${x.toFixed(6)}, ${y.toFixed(6)})`);
        addLabel(x, y);
        clearPress();
      }, 650);
    };

    const onPointerUp = (e) => {
      const dt = Date.now() - downAt;
      const dxm = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;

      if (!moved && dt < 300) {
        // short tap: remove nearest label if close, else add new label
        const near = findNearestLabelPx(px, py);
        if (near) {
          setLabels(ls => ls.filter(l => l.id !== near.id));
        } else {
          const t = makeTransform({ ...viewRef.current, width: size.width, height: size.height });
          const x = t.pxToX(px), y = t.pxToY(py);
          addLabel(x, y);
        }
      }

      dragging = false; setIsDragging(false); clearPress();
      try { canvas.releasePointerCapture(e.pointerId); } catch { }
    };

    const onPointerMove = (e) => {
      const r = canvas.getBoundingClientRect(); hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!dragging) return;
      const dxPx = e.clientX - last.x, dyPx = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
      if (Math.hypot(dxPx, dyPx) > 5) moved = true;
      if (pressTimer && moved) clearPress();
      const v = viewRef.current; const t = makeTransform({ ...v, width: size.width, height: size.height });
      const dx = -dxPx / t.xScale, dy = dyPx / t.yScale;
      setView(prev => ({ ...prev, xMin: prev.xMin + dx, xMax: prev.xMax + dx, yMin: prev.yMin + dy, yMax: prev.yMax + dy }));
    };

    const onWheel = (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const v = viewRef.current; const t = makeTransform({ ...v, width: size.width, height: size.height });
      const x = t.pxToX(mx), y = t.pxToY(my); const z = e.deltaY < 0 ? 0.9 : 1.1; zoomAround(x, y, z);
    };

    const onLeave = () => { hoverRef.current = { x: null, y: null }; clearPress(); };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [size, labels]); // include labels so we see newest ones


  // -------- shareable URL (load/save) --------
  const encodeState = (obj) => { try { const json = JSON.stringify(obj); return btoa(unescape(encodeURIComponent(json))); } catch { return ""; } };
  const decodeState = (b64) => { try { const json = decodeURIComponent(escape(atob(b64))); return JSON.parse(json); } catch { return null; } };

  useEffect(() => {
    const m = (window.location.hash || "").match(/#g=([^&]+)/);
    if (m && m[1]) {
      const data = decodeState(m[1]);
      if (data && data.v && data.e) {
        try {
          setView((v) => ({ ...v, ...data.v }));
          setExpressions(Array.isArray(data.e) ? data.e.map((x, i) => ({
            id: Date.now() + i,
            visible: true,
            lineWidth: 2,
            params: {},
            domain: { use: false, min: -10, max: 10 },
            includeIntersect: true,
            color: COLORS[i % COLORS.length],
            ...x
          })) : []);
          if (typeof data.q === "number") setPxStep(data.q);
          if (typeof data.t === "string") setGraphTitle(data.t);
          if (typeof data.dark === "boolean") setDark(data.dark);
        } catch { }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRef = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(saveRef.current);
    saveRef.current = requestAnimationFrame(() => {
      const eMin = expressions.map(({ src, color, visible, params, domain, includeIntersect }) => ({ src, color, visible, params, domain, includeIntersect }));
      const payload = { v: view, e: eMin, q: pxStep, t: graphTitle, dark };
      const hash = "#g=" + encodeState(payload);
      if (window.history && window.history.replaceState) window.history.replaceState(null, "", hash);
      else window.location.hash = hash;
    });
    return () => cancelAnimationFrame(saveRef.current);
  }, [expressions, view, pxStep, graphTitle, dark]);

  // -------- helpers --------
  const resetView = () => setView({ xMin: -10, xMax: 10, yMin: -6, yMax: 6 });
  const centerOn = (x, y) => {
    setView(v => {
      const w = v.xMax - v.xMin, h = v.yMax - v.yMin;
      return { xMin: x - w / 2, xMax: x + w / 2, yMin: y - h / 2, yMax: y + h / 2 };
    });
  };

  // export PNG — Flutter → Capacitor → Web
  const exportPNG = async () => {
    const c = canvasRef.current; if (!c) return;
    const dataUrl = c.toDataURL("image/png"); const base64 = dataUrl.split(",")[1];
    if (isFlutter) { await flutterCall("savePng", base64, `graph-${Date.now()}.png`); return; }
    if (isNative) {
      try {
        const filename = `graph-${Date.now()}.png`;
        await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Documents });
        const fileUrl = `capacitor://localhost/_capacitor_file_/Documents/${filename}`;
        await Share.share({ title: "Graph image", text: "Graph exported from Graphos", url: fileUrl, dialogTitle: "Share graph" });
        return;
      } catch { }
    }
    const a = document.createElement("a"); a.download = "graph.png"; a.href = dataUrl; a.click();
  };

  async function computePdfAtX() {
    const jStat = await ensureStats();
    const { mu, sigma, nu, k, n, p, lam } = dParams;
    const x = statX;
    let val;
    switch (dist) {
      case 'normal': val = jStat.normal.pdf(x, mu, sigma); break;
      case 't': val = jStat.studentt.pdf(x, nu); break;
      case 'chisq': val = jStat.chisquare.pdf(x, k); break;
      case 'binom': val = jStat.binomial.pdf(Math.round(x), n, p); break;
      case 'poisson': val = jStat.poisson.pdf(Math.round(x), lam); break;
    }
    setExpressions(arr => [...arr, {
      id: Date.now(),
      src: `PDF_${dist}(${JSON.stringify({ ...dParams })})@x=${x} = ${val}`,
      color: nextColor(arr.length), visible: true, lineWidth: 2, params: {},
      domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
    }]);
  }

  async function computeCdfAtX() {
    const jStat = await ensureStats();
    const { mu, sigma, nu, k, n, p, lam } = dParams;
    const x = statX;
    let val;
    switch (dist) {
      case 'normal': val = jStat.normal.cdf(x, mu, sigma); break;
      case 't': val = jStat.studentt.cdf(x, nu); break;
      case 'chisq': val = jStat.chisquare.cdf(x, k); break;
      case 'binom': val = jStat.binomial.cdf(Math.floor(x), n, p); break;
      case 'poisson': val = jStat.poisson.cdf(Math.floor(x), lam); break;
    }
    setExpressions(arr => [...arr, {
      id: Date.now() + 1,
      src: `CDF_${dist}(${JSON.stringify({ ...dParams })})@x=${x} = ${val}`,
      color: nextColor(arr.length), visible: true, lineWidth: 2, params: {},
      domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
    }]);
  }

  async function computeQuantile() {
    const jStat = await ensureStats();
    const { mu, sigma, nu, k, n, p, lam } = dParams;
    const q = statProb;
    let x;
    switch (dist) {
      case 'normal': x = jStat.normal.inv(q, mu, sigma); break;
      case 't': x = jStat.studentt.inv(q, nu); break;
      case 'chisq': x = jStat.chisquare.inv(q, k); break;
      case 'binom': x = jStat.binomial.inv(q, n, p); break;
      case 'poisson': x = jStat.poisson.inv(q, lam); break;
    }
    setExpressions(arr => [...arr, {
      id: Date.now() + 2,
      src: `quantile_${dist}(p=${q}) = ${x}`,
      color: nextColor(arr.length), visible: true, lineWidth: 2, params: {},
      domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
    }]);
  }

  async function sampleDistribution() {
    const jStat = await ensureStats();
    const { mu, sigma, nu, k, n, p, lam } = dParams;
    const N = Math.max(1, Math.min(1000, Math.round(sampleSize)));
    const out = [];
    switch (dist) {
      case 'normal': for (let i = 0; i < N; i++) out.push(jStat.normal.sample(mu, sigma)); break;
      case 't': for (let i = 0; i < N; i++) out.push(jStat.studentt.sample(nu)); break;
      case 'chisq': for (let i = 0; i < N; i++) out.push(jStat.chisquare.sample(k)); break;
      case 'binom': for (let i = 0; i < N; i++) out.push(jStat.binomial.sample(n, p)); break;
      case 'poisson': for (let i = 0; i < N; i++) out.push(jStat.poisson.sample(lam)); break;
    }
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const varc = out.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (out.length - 1 || 1);
    setExpressions(arr => [...arr, {
      id: Date.now() + 3,
      src: `sample_${dist}(N=${N}) mean=${mean.toFixed(5)} sd=${Math.sqrt(varc).toFixed(5)} :: ${JSON.stringify(out.slice(0, 50))}${out.length > 50 ? '…' : ''}`,
      color: nextColor(arr.length), visible: true, lineWidth: 2, params: {},
      domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
    }]);
  }

  async function addStatPlot(kind /* 'pdf'|'cdf'|'pmf' */) {
    const jStat = await ensureStats();
    const params = { ...dParams };
    const id = Date.now() + Math.random();
    const color = nextColor(statPlots.length);

    let fn = null;
    if (kind === 'pdf') {
      if (dist === 'normal') fn = (x) => jStat.normal.pdf(x, params.mu, params.sigma);
      if (dist === 't') fn = (x) => jStat.studentt.pdf(x, params.nu);
      if (dist === 'chisq') fn = (x) => jStat.chisquare.pdf(x, params.k);
      if (dist === 'binom') fn = null; // discrete handled separately
      if (dist === 'poisson') fn = null;
    } else if (kind === 'cdf') {
      if (dist === 'normal') fn = (x) => jStat.normal.cdf(x, params.mu, params.sigma);
      if (dist === 't') fn = (x) => jStat.studentt.cdf(x, params.nu);
      if (dist === 'chisq') fn = (x) => jStat.chisquare.cdf(x, params.k);
      if (dist === 'binom') fn = null;
      if (dist === 'poisson') fn = null;
    } else if (kind === 'pmf') {
      fn = null; // discrete only
    }

    setStatPlots(arr => [...arr, { id, type: kind, dist, params, fn, color }]);
  }
  function removeStatPlot(id) { setStatPlots(arr => arr.filter(p => p.id !== id)); }


  const zoomAround = (x, y, zoom) => {
    setView(v => {
      const newW = (v.xMax - v.xMin) * zoom, newH = (v.yMax - v.yMin) * zoom;
      return {
        xMin: x - (x - v.xMin) * (newW / (v.xMax - v.xMin)),
        xMax: x + (v.xMax - x) * (newW / (v.xMax - v.xMin)),
        yMin: y - (y - v.yMin) * (newH / (v.yMax - v.yMin)),
        yMax: y + (v.yMax - y) * (newH / (v.yMax - v.yMin)),
      };
    });
  };
  const zoomCenter = (f) => { const cx = (view.xMin + view.xMax) / 2, cy = (view.yMin + view.yMax) / 2; zoomAround(cx, cy, f); };
  const fitToData = () => {
    const funcs = compiled.filter(e => e.visible && e.kind === "explicit" && e.fn && !e.error);
    if (!funcs.length) return;
    const samples = 800, xMin = view.xMin, xMax = view.xMax, step = (xMax - xMin) / samples;
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i <= samples; i++) {
      const x = xMin + i * step;
      for (const e of funcs) { const y = e.fn(x); if (!Number.isFinite(y)) continue; yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
    const pad = (yMax - yMin) * 0.1 || 1; setView(v => ({ ...v, yMin: yMin - pad, yMax: yMax + pad }));
  };
  const formatNumber = (v) => { if (!Number.isFinite(v)) return "undefined"; const a = Math.abs(v); if (a !== 0 && (a < 1e-6 || a >= 1e6)) return v.toExponential(6); let s = v.toFixed(10); s = s.replace(/\.0+$/, ""); s = s.replace(/(\.\d*?)0+$/, "$1"); return s; };
  // Pick the expression we operate on (focused line; fallback to first non-scalar)
  const getTargetExpr = () => {
    const focused = expressions.find(e => e.id === focusedId);
    if (focused && focused.src?.trim()) return focused;
    const firstGraph = expressions.find(e => e.kind !== 'scalar' && e.src?.trim());
    return firstGraph || expressions[0];
  };

  // Safely update or insert result
  const writeCASResult = (originalId, newSrc) => {
    if (!originalId) {
      // no focused line: add as a new expression
      setExpressions(arr => [...arr, {
        id: Date.now(),
        src: newSrc,
        color: COLORS[arr.length % COLORS.length],
        visible: true, lineWidth: 2, params: {},
        domain: { use: false, min: -10, max: 10 },
        includeIntersect: true, error: ""
      }]);
    } else {
      // replace the focused line content
      updateExpr(originalId, { src: newSrc });
    }
  };

  function addStarsForImplicitMul(s) {
    // very light-touch: number followed by variable, or )(
    return s
      .replace(/(\d)([A-Za-z(])/g, "$1*$2")
      .replace(/([A-Za-z\)])(\()/g, "$1*$2")
      .replace(/(\))([A-Za-z0-9])/g, "$1*$2");
  }


  // Wrap common CAS transforms that take a single expression
  async function casTransform(fnName, raw) {
    const CAS = await ensureCAS();
    const safe = addStarsForImplicitMul(raw);
    const cmd = `${fnName}(${safe})`;
    try {
      const out = CAS(cmd);
      return out.text ? out.text() : out.toString();
    } catch (err) {
      console.warn("CAS error:", err);
      throw new Error(err?.message || "CAS failed");
    }
  }


  // Solve f(x)=0 or explicit equation for a variable
  async function casSolveSingle(raw, variable = 'x') {
    const CAS = await ensureCAS();
    let eq;
    if (raw.includes('=')) {
      const [L, R] = raw.split('=');
      const Ls = addStarsForImplicitMul(L);
      const Rs = addStarsForImplicitMul(R);
      eq = `${Ls}=${Rs}`;
    } else {
      const safe = addStarsForImplicitMul(raw);
      eq = `(${safe})=0`;
    }
    try {
      const r = CAS.solve(eq, variable);
      const s = r.text ? r.text() : r.toString();
      return `solutions(${variable}) = ${s}`;
    } catch {
      const r2 = CAS.solveEquations([eq], [variable]);
      return `solutions(${variable}) = ${Array.isArray(r2) ? JSON.stringify(r2) : String(r2)}`;
    }
  }


  // Solve a system: pass array of strings with '=' and a var list like ['x','y']
  async function casSolveSystem(eqs, vars) {
    const CAS = await ensureCAS();
    const cleaned = eqs.map((e) => {
      if (e.includes('=')) {
        const [L, R] = e.split('=');
        return `${addStarsForImplicitMul(L)}=${addStarsForImplicitMul(R)}`;
      }
      // Treat as f(...)=0 if user forgot '='
      return `${addStarsForImplicitMul(e)}=0`;
    });
    const res = CAS.solveEquations(cleaned, vars);
    return Array.isArray(res) ? JSON.stringify(res) : (res?.text?.() ?? String(res));
  }

  const isDiscreteDist = (d) => d === 'binom' || d === 'poisson';
  const nextColor = (i) => COLORS[i % COLORS.length];


  const copyText = async (txt) => {
    if (isFlutter) { await flutterCall("copy", txt); return; }
    if (isNative) { try { await Clipboard.write({ string: txt }); return; } catch { } }
    try { await navigator.clipboard.writeText(txt); } catch { }
  };

  // -------- Presets --------
  const addExpression = (src) => {
    const text = (src ?? exprInput).trim(); if (!text) return;
    setExpressions(arr => [...arr, {
      id: Date.now(), src: text, color: COLORS[arr.length % COLORS.length],
      visible: true, lineWidth: 2, params: {}, domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
    }]);
    setExprInput("");
  };
  const updateExpr = (id, patch) => setExpressions(arr => arr.map(e => e.id === id ? { ...e, ...patch } : e));
  const updateParam = (id, name, value) => setExpressions(arr => arr.map(e => e.id === id ? { ...e, params: { ...(e.params || {}), [name]: value } } : e));
  const removeExpr = (id) => setExpressions(arr => arr.filter(e => e.id !== id));

  const presets = [
    "sin(x)", "cos(x)", "x^2", "x^3 - 2x", "a*sin(b*x)", "exp(x)", "abs(x)", "log(x)",
    "x^2 + y^2 <= 4", "y > 2*x + 1",
    "x=cos(t), y=sin(t), t=[0, 2*pi]",
    "r = 1 + 0.5*cos(theta), theta=[0, 2*pi]",
    "1 <= x^2 + y^2 <= 4",
    "2+3*4", "sqrt(2)", "a+b"
  ];

  const ToolbarBtn = ({ onClick, title, children }) => (
    <button title={title} onClick={onClick} className="w-9 h-9 rounded-md border border-gray-200 dark:border-slate-700 bg-white/90 dark:bg-slate-900/90 hover:bg-gray-50 dark:hover:bg-slate-800 text-sm flex items-center justify-center shadow-sm">
      {children}
    </button>
  );

  const shareGraph = async () => {
    const url = window.location.origin + window.location.pathname + window.location.hash;
    if (isFlutter) { await flutterCall("shareLink", url); return; }
    if (isNative) { try { await Share.share({ title: "Share graph", text: "Open this graph:", url, dialogTitle: "Share graph" }); return; } catch { } }
    try { await navigator.clipboard.writeText(url); alert("Link copied to clipboard"); }
    catch { window.prompt("Copy link:", url); }
  };

  // ===================== Auto Analysis =====================
  // numeric helpers
  const bisectRoot = (f, a, b, ya, yb, iters = 32) => {
    if (!Number.isFinite(ya)) ya = f(a);
    if (!Number.isFinite(yb)) yb = f(b);
    if (!Number.isFinite(ya) || !Number.isFinite(yb) || ya * yb > 0) return null;
    let lo = a, hi = b, flo = ya, fhi = yb;
    for (let i = 0; i < iters; i++) {
      const mid = 0.5 * (lo + hi); const fm = f(mid);
      if (!Number.isFinite(fm)) return null;
      if (flo === 0) return lo; if (fhi === 0) return hi; if (fm === 0) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return 0.5 * (lo + hi);
  };
  const goldenExtremum = (f, a, b, mode = "min", iters = 48) => {
    // minimize f for mode="min", minimize -f for "max"
    const g = mode === "max" ? (x) => -f(x) : f;
    const phi = (Math.sqrt(5) - 1) / 2; // ~0.618
    let c = b - phi * (b - a);
    let d = a + phi * (b - a);
    let fc = g(c), fd = g(d);
    for (let i = 0; i < iters; i++) {
      if (fc > fd) { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = g(d); }
      else { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = g(c); }
    }
    const x = 0.5 * (a + b); const y = f(x);
    return Number.isFinite(y) ? { x, y } : null;
  };

  const analysis = useMemo(() => {
    const result = { xIntercepts: [], yIntercepts: [], extrema: [], intersections: [], allPoints: [] };
    const explicits = compiled.filter(e => e.visible && e.kind === "explicit" && e.fn && !e.error);
    if (explicits.length === 0) return result;

    const width = size.width;
    const N = Math.max(400, Math.round(width / pxStep * 1.5));
    const mapKey = (x, y) => `${Math.round(x * 1e6)}:${Math.round(y * 1e6)}`;
    const seen = new Set();

    // precompute sampling grid and per-curve samples
    const xStartView = view.xMin, xEndView = view.xMax;
    const grid = new Array(N + 1).fill(0).map((_, i) => xStartView + (i / N) * (xEndView - xStartView));

    const samplesById = new Map();
    for (const e of explicits) {
      const xs = [], ys = [];
      const xmin = e.domain?.use ? Math.max(view.xMin, e.domain.min) : view.xMin;
      const xmax = e.domain?.use ? Math.min(view.xMax, e.domain.max) : view.xMax;
      for (let i = 0; i <= N; i++) {
        const x = grid[i];
        if (x < xmin || x > xmax) { xs.push(x); ys.push(NaN); continue; }
        let y; try { y = e.fn(x); } catch { y = NaN; }
        ys.push(Number.isFinite(y) ? y : NaN); xs.push(x);
      }
      samplesById.set(e.id, { xs, ys, color: e.color, expr: e });
    }

    // per-curve: roots (x-intercepts), y-intercepts, extrema
    for (const e of explicits) {
      const { xs, ys } = samplesById.get(e.id);
      // x-intercepts
      for (let i = 1; i < xs.length; i++) {
        const y0 = ys[i - 1], y1 = ys[i]; const a = xs[i - 1], b = xs[i];
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
        if (y0 === 0 || y1 === 0 || y0 * y1 < 0) {
          const xr = bisectRoot((x) => e.fn(x), a, b, y0, y1);
          if (xr != null) {
            const key = mapKey(xr, 0);
            if (!seen.has(key)) {
              seen.add(key);
              result.xIntercepts.push({ type: "x-int", x: xr, y: 0, color: e.color, exprId: e.id });
            }
          }
        }
      }
      // y-intercept (x=0 in domain)
      if (view.xMin <= 0 && view.xMax >= 0) {
        const x = 0;
        const inDomain = !(e.domain?.use) || (x >= e.domain.min && x <= e.domain.max);
        if (inDomain) {
          let y; try { y = e.fn(0); } catch { y = NaN; }
          if (Number.isFinite(y)) {
            const key = mapKey(0, y);
            if (!seen.has(key)) {
              seen.add(key);
              result.yIntercepts.push({ type: "y-int", x: 0, y, color: e.color, exprId: e.id });
            }
          }
        }
      }
      // extrema via discrete peaks + golden refinement
      for (let i = 1; i < xs.length - 1; i++) {
        const y0 = ys[i - 1], y1 = ys[i], y2 = ys[i + 1];
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(y2)) continue;
        const a = xs[i - 1], b = xs[i + 1];
        if (y1 > y0 && y1 > y2) {
          const pt = goldenExtremum((x) => e.fn(x), a, b, "max");
          if (pt) {
            const key = mapKey(pt.x, pt.y);
            if (!seen.has(key)) { seen.add(key); result.extrema.push({ type: "max", ...pt, color: e.color, exprId: e.id }); }
          }
        } else if (y1 < y0 && y1 < y2) {
          const pt = goldenExtremum((x) => e.fn(x), a, b, "min");
          if (pt) {
            const key = mapKey(pt.x, pt.y);
            if (!seen.has(key)) { seen.add(key); result.extrema.push({ type: "min", ...pt, color: e.color, exprId: e.id }); }
          }
        }
      }
    }

    // intersections between curves that opted in
    const interCurves = explicits.filter(e => e.includeIntersect !== false);
    for (let i = 0; i < interCurves.length; i++) {
      for (let j = i + 1; j < interCurves.length; j++) {
        const A = interCurves[i], B = interCurves[j];
        const f = (x) => { let v = A.fn(x) - B.fn(x); return Number.isFinite(v) ? v : NaN; };
        for (let k = 1; k < grid.length; k++) {
          const a = grid[k - 1], b = grid[k];
          let ya, yb; try { ya = f(a); } catch { ya = NaN; }
          try { yb = f(b); } catch { yb = NaN; }
          if (!Number.isFinite(ya) || !Number.isFinite(yb) || ya * yb > 0) continue;
          const x = bisectRoot(f, a, b, ya, yb);
          if (x == null) continue;
          let y; try { y = A.fn(x); } catch { y = NaN; }
          if (!Number.isFinite(y)) continue;
          const key = mapKey(x, y);
          if (!seen.has(key)) {
            seen.add(key);
            // blend color a bit for intersections
            result.intersections.push({ type: "intersect", x, y, color: A.color, exprId: A.id, exprId2: B.id });
          }
        }
      }
    }

    // aggregate for drawing
    result.allPoints = [
      ...result.xIntercepts,
      ...result.yIntercepts,
      ...result.extrema,
      ...result.intersections,
    ];
    return result;
  }, [compiled, view, size.width, pxStep]);

  // ---------------- UI ----------------
  return (
    <div className="safe-edges w-full min-h-screen overflow-x-hidden bg-white dark:bg-[#0b0f14] text-gray-900 dark:text-slate-200">
      {/* Top bar with single Menu */}
      <div className="sticky top-0 z-10 bg-[#2b2f33] text-white border-b border-black/20">
        <div className="max-w-7xl mx-auto px-4 h-12 flex items-center gap-3 relative">
          <div className="font-semibold tracking-wide">
            graph<span className="text-emerald-400">os</span>
          </div>

          <input
            className="ml-3 flex-1 max-w-sm bg-transparent border border-white/10 rounded px-2 py-1 text-sm placeholder-white/60"
            value={graphTitle}
            onChange={(e) => setGraphTitle(e.target.value)}
          />

          {/* Single Menu button */}
          <button
            ref={menuBtnRef}
            onClick={() => setMenuOpen((v) => !v)}
            className="ml-auto px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-sm"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            Menu ▾
          </button>

          {/* Dropdown */}
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute right-4 top-12 w-52 rounded-lg border border-white/10 bg-[#1f2327] shadow-lg overflow-hidden"
              role="menu"
            >
              <button
                onClick={() => { setPresetOpen((v) => !v); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Presets
              </button>
              <button
                onClick={() => { resetView(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Reset View
              </button>
              <button
                onClick={() => { fitToData(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Fit to Data
              </button>
              <button
                onClick={() => { setStatPlots([]); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Clear Stat Plots
              </button>
              <button
                onClick={() => { setLabels([]); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Clear Labels
              </button>
              <button
                onClick={async () => { await exportPNG(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Export PNG
              </button>
              <button
                onClick={async () => { await shareGraph(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                Share Link
              </button>
              <button
                onClick={() => { setDark(!dark); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-white/10 text-sm"
                role="menuitem"
              >
                {dark ? "Switch to Light" : "Switch to Dark"}
              </button>
            </div>
          )}
        </div>

        {/* Presets tray toggled by the menu */}
        {presetOpen && (
          <div className="bg-[#2b2f33] border-t border-black/20">
            <div className="max-w-7xl mx-auto px-4 py-2 flex flex-wrap gap-2">
              {presets.map((p) => (
                <button key={p} onClick={() => addExpression(p)} className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-white/90 text-sm">
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto grid grid-cols-12 gap-4 p-4">
        {/* Sidebar */}
        <div className="col-span-12 md:col-span-4 space-y-3">
          <div className="rounded-2xl border border-gray-200 dark:border-slate-700 overflow-hidden shadow-sm">
            {/* Add bar */}
            <div className="px-3 py-3 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 flex items-center gap-2">
              <button onClick={() => addExpression("")} className="px-3 py-2 rounded-md bg-gray-200/70 dark:bg-slate-800 hover:bg-gray-200">＋</button>
              <input
                className="flex-1 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Type expression (graphs & calculator): e.g. x^2 + y^2 <= 1 • 2+3*4 • a+b"
                value={exprInput}
                onChange={(e) => setExprInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addExpression(); }}
              />
              <button onClick={() => addExpression()} className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">Add</button>
            </div>

            {/* List */}
            <div className="max-h-[540px] overflow-y-auto">
              {compiled.map((e, idx) => (
                <div key={e.id} className="relative group border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
                  {/* left gutter + active bar */}
                  <div className="absolute inset-y-0 left-0 w-8 bg-gray-50 dark:bg-slate-900/40" />
                  <div className={`absolute inset-y-0 left-0 w-1 transition-colors ${focusedId === e.id ? "bg-blue-500" : "bg-transparent"}`} />
                  <div className="absolute left-0 w-8 text-center text-[11px] leading-[36px] text-slate-400 select-none">{idx + 1}</div>

                  <div className="pl-8 pr-10 py-2">
                    <div className="relative">
                      <input
                        className={`w-full rounded-md border px-2 py-1 text-sm bg-white dark:bg-slate-900 ${e.error ? "border-rose-400" : "border-transparent focus:border-indigo-400"} focus:outline-none`}
                        value={e.src}
                        onChange={(ev) => updateExpr(e.id, { src: ev.target.value })}
                        onFocus={() => setFocusedId(e.id)}
                        onBlur={() => setFocusedId(null)}
                        placeholder="Type an expression…"
                      />
                      {/* right: result + delete */}
                      <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-2 pr-1">
                        {e.kind === "scalar" && (
                          <>
                            <span className="text-xs text-slate-500">=</span>
                            <span className="px-2 py-0.5 rounded border text-xs font-mono bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700">
                              {formatNumber(e.value)}
                            </span>
                            <button className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800" onClick={() => copyText(String(e.value))}>Copy</button>
                          </>
                        )}
                        <button onClick={() => removeExpr(e.id)} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity opacity-0 group-hover:opacity-100" title="Delete">✕</button>
                      </div>
                    </div>

                    {/* tools row — HIDDEN for calculator lines */}
                    {e.kind !== "scalar" && (
                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        <button
                          onClick={() => updateExpr(e.id, { visible: !e.visible })}
                          className={`px-2 py-0.5 rounded border text-[11px] ${e.visible ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-gray-100 dark:bg-slate-800 border-gray-300 dark:border-slate-700 text-gray-600"}`}
                        >
                          {e.visible ? "Visible" : "Hidden"}
                        </button>
                        <div className="flex items-center gap-1">
                          {COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => updateExpr(e.id, { color: c })}
                              className="w-4 h-4 rounded-full border border-black/10 dark:border-white/10"
                              style={{ background: c, outline: e.color === c ? "2px solid #111827" : "none" }}
                              title={c}
                            />
                          ))}
                        </div>
                        {e.kind === "explicit" && (
                          <label className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300">
                            <input
                              type="checkbox"
                              checked={e.includeIntersect !== false}
                              onChange={(ev) => updateExpr(e.id, { includeIntersect: ev.target.checked })}
                            />
                            ∩ Intersections
                          </label>
                        )}
                      </div>
                    )}

                    {/* domain (graphs only) */}
                    {e.kind !== "scalar" && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={e.domain?.use || false}
                            onChange={(ev) => updateExpr(e.id, { domain: { ...(e.domain || {}), use: ev.target.checked } })}
                          />
                          Restrict x ∈ [
                        </label>
                        <input
                          type="number"
                          className="w-20 px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          value={e.domain?.min ?? -10}
                          onChange={(ev) => updateExpr(e.id, { domain: { ...(e.domain || {}), min: Number(ev.target.value), use: true } })}
                        />
                        <span>,</span>
                        <input
                          type="number"
                          className="w-20 px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          value={e.domain?.max ?? 10}
                          onChange={(ev) => updateExpr(e.id, { domain: { ...(e.domain || {}), max: Number(ev.target.value), use: true } })}
                        />
                        <span>]</span>
                      </div>
                    )}

                    {/* sliders */}
                    {e.paramNames && e.paramNames.length > 0 && (
                      <div className="mt-3 grid grid-cols-1 gap-2">
                        {e.paramNames.map((name) => (
                          <div key={name} className="flex items-center gap-2 text-xs">
                            <div className="w-6 text-right font-medium">{name}</div>
                            <input type="range" min={-10} max={10} step={0.1} value={Number(e.params?.[name] ?? 1)} onChange={(ev) => updateParam(e.id, name, Number(ev.target.value))} className="flex-1" />
                            <input type="number" value={Number(e.params?.[name] ?? 1)} onChange={(ev) => updateParam(e.id, name, Number(ev.target.value))} className="w-20 px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {compiled.length === 0 && (<div className="p-6 text-sm text-gray-500 dark:text-slate-400">No expressions yet. Add one above or use presets.</div>)}
            </div>
          </div>

          {/* Quality */}
          <div className="rounded-2xl border border-gray-200 dark:border-slate-700 p-3 shadow-sm">
            <div className="text-sm font-medium mb-2">Quality</div>
            <div className="text-xs text-gray-500 mb-1">Sampling step (pixels between samples). Lower = smoother, slower.</div>
            <div className="flex items-center gap-3">
              <input type="range" min={1} max={6} step={0.5} value={pxStep} onChange={(e) => setPxStep(Number(e.target.value))} className="flex-1" />
              <div className="w-10 text-sm text-right">{pxStep}</div>
            </div>
          </div>

          {/* Statistics (Distributions) */}
          <div className="rounded-2xl border border-gray-200 dark:border-slate-700 p-3 shadow-sm">
            <div className="text-sm font-semibold mb-2">Statistics — Distributions</div>

            {/* Distribution select */}
            <div className="flex items-center gap-2 mb-2">
              <label className="text-xs">Distribution</label>
              <select
                className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                value={dist}
                onChange={(e) => setDist(e.target.value)}
              >
                <option value="normal">Normal(μ,σ)</option>
                <option value="t">Student t(ν)</option>
                <option value="chisq">Chi-square(k)</option>
                <option value="binom">Binomial(n,p)</option>
                <option value="poisson">Poisson(λ)</option>
              </select>
            </div>

            {/* Parameters */}
            <div className="grid grid-cols-2 gap-2 mb-2 text-xs">
              {dist === 'normal' && (
                <>
                  <label className="col-span-1">μ
                    <input type="number" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                      value={dParams.mu} onChange={(e) => setDParams({ ...dParams, mu: +e.target.value })} />
                  </label>
                  <label className="col-span-1">σ
                    <input type="number" step="0.01" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                      value={dParams.sigma} onChange={(e) => setDParams({ ...dParams, sigma: Math.max(1e-6, +e.target.value) })} />
                  </label>
                </>
              )}
              {dist === 't' && (
                <label className="col-span-2">ν (dof)
                  <input type="number" min="1" step="1" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                    value={dParams.nu} onChange={(e) => setDParams({ ...dParams, nu: Math.max(1, (+e.target.value | 0)) })} />
                </label>
              )}
              {dist === 'chisq' && (
                <label className="col-span-2">k (dof)
                  <input type="number" min="1" step="1" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                    value={dParams.k} onChange={(e) => setDParams({ ...dParams, k: Math.max(1, (+e.target.value | 0)) })} />
                </label>
              )}
              {dist === 'binom' && (
                <>
                  <label className="col-span-1">n
                    <input type="number" min="0" step="1" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                      value={dParams.n} onChange={(e) => setDParams({ ...dParams, n: Math.max(0, (+e.target.value | 0)) })} />
                  </label>
                  <label className="col-span-1">p
                    <input type="number" min="0" max="1" step="0.01" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                      value={dParams.p} onChange={(e) => setDParams({ ...dParams, p: Math.min(1, Math.max(0, +e.target.value)) })} />
                  </label>
                </>
              )}
              {dist === 'poisson' && (
                <label className="col-span-2">λ
                  <input type="number" min="0" step="0.01" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                    value={dParams.lam} onChange={(e) => setDParams({ ...dParams, lam: Math.max(0, +e.target.value) })} />
                </label>
              )}
            </div>

            {/* x & p */}
            <div className="grid grid-cols-3 gap-2 mb-2 text-xs">
              <label className="col-span-2">x / k
                <input type="number" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                  value={statX} onChange={(e) => setStatX(+e.target.value)} />
              </label>
              <label className="col-span-1">p
                <input type="number" min="0" max="1" step="0.001" className="w-full mt-1 px-2 py-1 rounded border dark:border-slate-700"
                  value={statProb} onChange={(e) => setStatProb(Math.min(1, Math.max(0, +e.target.value)))} />
              </label>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 mb-2">
              <button onClick={computePdfAtX} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">PDF/PMF@x</button>
              <button onClick={computeCdfAtX} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">CDF@x</button>
              <button onClick={computeQuantile} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">Quantile p</button>
            </div>

            {/* Sampling */}
            <div className="flex items-center gap-2 mb-2 text-xs">
              <label>Samples</label>
              <input type="number" min="1" max="1000" step="1"
                className="w-20 px-2 py-1 rounded border dark:border-slate-700"
                value={sampleSize} onChange={(e) => setSampleSize(+e.target.value)} />
              <button onClick={sampleDistribution} className="ml-auto px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">
                Draw
              </button>
            </div>

            {/* Plot buttons */}
            <div className="flex flex-wrap gap-2 mb-2">
              {isDiscreteDist(dist) ? (
                <>
                  <button onClick={() => addStatPlot('pmf')} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">Plot PMF</button>
                  <button onClick={() => addStatPlot('cdf')} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">Plot CDF</button>
                </>
              ) : (
                <>
                  <button onClick={() => addStatPlot('pdf')} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">Plot PDF</button>
                  <button onClick={() => addStatPlot('cdf')} className="px-2.5 py-1 rounded border text-xs hover:bg-gray-50 dark:hover:bg-slate-800">Plot CDF</button>
                </>
              )}
            </div>

            {/* Plotted list */}
            {statPlots.length > 0 && (
              <div className="border-t border-gray-200 dark:border-slate-700 pt-2 mt-2">
                <div className="text-xs font-medium mb-1">Plotted</div>
                <div className="space-y-1">
                  {statPlots.map((sp) => (
                    <div key={sp.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: sp.color }} />
                        <span>{sp.dist} {sp.type.toUpperCase()}</span>
                      </div>
                      <button onClick={() => removeStatPlot(sp.id)} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Algebra (CAS) */}
          <div className="rounded-2xl border border-gray-200 dark:border-slate-700 p-3 shadow-sm">
            <div className="text-sm font-semibold mb-2">Algebra (symbolic)</div>
            <div className="text-[12px] text-slate-500 dark:text-slate-300 mb-2">
              Operates on the <span className="font-medium">focused</span> expression (click in a line to focus).
              If nothing is focused, result is added as a new line.
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
              <button
                className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  const target = getTargetExpr(); if (!target?.src) return;
                  try { const out = await casTransform('simplify', target.src); writeCASResult(target?.id, out); }
                  catch (e) { alert(e.message); }
                }}
              >Simplify</button>

              <button
                className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  const target = getTargetExpr(); if (!target?.src) return;
                  try { const out = await casTransform('expand', target.src); writeCASResult(target?.id, out); }
                  catch (e) { alert(e.message); }
                }}
              >Expand</button>

              <button
                className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  const target = getTargetExpr(); if (!target?.src) return;
                  try { const out = await casTransform('factor', target.src); writeCASResult(target?.id, out); }
                  catch (e) { alert(e.message); }
                }}
              >Factor</button>

              <button
                className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  const target = getTargetExpr(); if (!target?.src) return;
                  try { const out = await casTransform('apart', target.src); writeCASResult(target?.id, out); }
                  catch (e) { alert(e.message); }
                }}
                title="Partial fractions"
              >Partial Fractions</button>
            </div>

            {/* Solve single equation */}
            <div className="flex items-center gap-2 mb-2">
              <label className="text-xs text-slate-600 dark:text-slate-300">Solve for</label>
              <input
                className="w-16 px-2 py-1 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                value={casVar} onChange={(e) => setCasVar(e.target.value.trim() || 'x')}
              />
              <button
                className="ml-auto px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  const target = getTargetExpr(); if (!target?.src) return;
                  try {
                    const out = await casSolveSingle(target.src, casVar || 'x');
                    // append result as a calculator line (doesn't change the original equation)
                    setExpressions(arr => [...arr, {
                      id: Date.now() + 1, src: out, color: COLORS[arr.length % COLORS.length],
                      visible: true, lineWidth: 2, params: {}, domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
                    }]);
                  } catch (e) { alert(e.message); }
                }}
              >Solve</button>
            </div>

            {/* Solve system from selected visible equations */}
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
              System: uses all <span className="font-medium">visible</span> lines that contain “=” (in the list above).
            </div>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                value={casVars} onChange={(e) => setCasVars(e.target.value)}
                placeholder="Variables (comma-separated), e.g. x,y"
              />
              <button
                className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-700 text-xs hover:bg-gray-50 dark:hover:bg-slate-800"
                onClick={async () => {
                  try {
                    const eqs = expressions
                      .filter(e => e.visible && typeof e.src === 'string' && e.src.includes('='))
                      .map(e => e.src.trim());
                    if (eqs.length === 0) { alert("No visible equations with '=' found."); return; }
                    const vars = casVars.split(',').map(s => s.trim()).filter(Boolean);
                    if (vars.length === 0) { alert("Enter variables, e.g. x,y"); return; }
                    const out = await casSolveSystem(eqs, vars);
                    setExpressions(arr => [...arr, {
                      id: Date.now() + 2, src: `system solutions ${JSON.stringify(vars)} = ${out}`,
                      color: COLORS[arr.length % COLORS.length],
                      visible: true, lineWidth: 2, params: {}, domain: { use: false, min: -10, max: 10 }, includeIntersect: true, error: ""
                    }]);
                  } catch (e) { alert(e.message); }
                }}
              >Solve System</button>
            </div>
          </div>


          {/* Analysis Panel */}
          <div className="rounded-2xl border border-gray-200 dark:border-slate-700 p-3 shadow-sm">
            <div className="text-sm font-semibold mb-2">Analysis</div>

            {/* x-intercepts */}
            <div className="mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-300">x-intercepts ({analysis.xIntercepts.length})</div>
              <div className="mt-1 space-y-1">
                {analysis.xIntercepts.map((p, i) => (
                  <button key={`xi-${i}`} onClick={() => centerOn(p.x, p.y)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                    x = {formatNumber(p.x)}
                  </button>
                ))}
                {analysis.xIntercepts.length === 0 && <div className="text-xs text-slate-400">none</div>}
              </div>
            </div>

            {/* y-intercepts */}
            <div className="mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-300">y-intercepts ({analysis.yIntercepts.length})</div>
              <div className="mt-1 space-y-1">
                {analysis.yIntercepts.map((p, i) => (
                  <button key={`yi-${i}`} onClick={() => centerOn(p.x, p.y)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                    y = {formatNumber(p.y)}
                  </button>
                ))}
                {analysis.yIntercepts.length === 0 && <div className="text-xs text-slate-400">none</div>}
              </div>
            </div>

            {/* extrema */}
            <div className="mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-300">local min/max ({analysis.extrema.length})</div>
              <div className="mt-1 space-y-1">
                {analysis.extrema.map((p, i) => (
                  <button key={`ext-${i}`} onClick={() => centerOn(p.x, p.y)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                    {p.type} at ({formatNumber(p.x)}, {formatNumber(p.y)})
                  </button>
                ))}
                {analysis.extrema.length === 0 && <div className="text-xs text-slate-400">none</div>}
              </div>
            </div>

            {/* intersections */}
            <div className="">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-300">intersections ({analysis.intersections.length})</div>
              <div className="mt-1 space-y-1">
                {analysis.intersections.map((p, i) => (
                  <button key={`isect-${i}`} onClick={() => centerOn(p.x, p.y)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                    ({formatNumber(p.x)}, {formatNumber(p.y)})
                  </button>
                ))}
                {analysis.intersections.length === 0 && <div className="text-xs text-slate-400">none</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Graph */}
        <div className="col-span-12 md:col-span-8">
          <div
            ref={graphBoxRef}
            className="rounded-2xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden bg-white dark:bg-slate-900 relative"
          >
            <div className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 text-xs text-gray-600 dark:text-slate-300 flex items-center justify-between">
              <div>Viewport: x[{view.xMin.toFixed(2)}, {view.xMax.toFixed(2)}], y[{view.yMin.toFixed(2)}, {view.yMax.toFixed(2)}]</div>
              <div className="font-mono">
                {hoverRef.current.x != null && hoverRef.current.y != null ? (() => {
                  const t = makeTransform({ ...view, width: size.width, height: size.height });
                  const x = t.pxToX(hoverRef.current.x), y = t.pxToY(hoverRef.current.y);
                  return `x: ${x.toFixed(3)}, y: ${y.toFixed(3)}`;
                })() : ""}
              </div>
            </div>
            <canvas
              ref={canvasRef}
              className={`block select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
              style={{ width: size.width, height: size.height, touchAction: "none" }}
            />
            <div className="absolute top-3 right-3 flex flex-col gap-2">
              <ToolbarBtn title="Zoom in" onClick={() => zoomCenter(0.9)}>＋</ToolbarBtn>
              <ToolbarBtn title="Zoom out" onClick={() => zoomCenter(1.1)}>－</ToolbarBtn>
              <ToolbarBtn title="Home" onClick={resetView}>🏠</ToolbarBtn>
              <ToolbarBtn title="Fit to data" onClick={fitToData}>↔︎</ToolbarBtn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
