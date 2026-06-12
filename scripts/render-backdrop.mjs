// Renders the ride backdrop as static SVG markup and injects it into
// index.html between the ride-backdrop marker comments. Run directly to
// re-render from js/strava-data.js, or import from fetch-strava.mjs.
//
// Each ride is one full-width line: the distance axis is normalized per ride,
// heights share a real elevation scale, so a mountain day towers over a flat
// spin. Newest ride sits in front; older rides recede upward and fade. The
// fixed viewBox stretches to any viewport (preserveAspectRatio="none");
// non-scaling strokes keep the lines crisp. Animation, hover/focus chips,
// and theming are all CSS; js/ride-backdrop.js only adds tap-to-preview on
// touch devices.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VIEW_W = 1200;
const VIEW_H = 300;
const ROW_STEP = 26; // viewBox units each older ride recedes upward
const PEAK_FRACTION = 0.78; // tallest profile uses this much of the height
const FRONT_OPACITY = 0.4;
const BACK_OPACITY = 0.1;
// Average character width of the chip label, in em at the chip's font size
// (measured for Josefin Sans); used to estimate chip widths ahead of time.
const CHAR_EM = 0.44;

// Smoothing strength, overridable via renderBackdrop's second argument.
// A single pass keeps repeated climbs visible as a serrated ridge; a second
// pass averages them into a flat plateau.
const DEFAULTS = {
  plotPoints: 96, // samples per profile; fewer = broader sweeps
  smoothFraction: 0.02, // moving-average half-window as a fraction of the ride
  smoothPasses: 1,
};

// Ride titles follow a "Something w/ Name" convention; drop the names.
export function cleanName(name) {
  return name.split(" w/ ")[0].trim();
}

function rideStats(ride) {
  const miles = (ride.distance / 1609.34).toFixed(1);
  const feet = Math.round(ride.total_elevation_gain * 3.28084);
  return `${miles} mi · ${feet.toLocaleString("en-US")} ft`;
}

function rideDate(ride) {
  const date = new Date(ride.start_date_local);
  const opts = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-US", opts);
}

function escapeAttr(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function movingAverage(values, half) {
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (
      let j = Math.max(0, i - half);
      j <= Math.min(values.length - 1, i + half);
      j++
    ) {
      sum += values[j];
      count++;
    }
    return sum / count;
  });
}

// Returns plotPoints altitude values evenly spaced along the ride's
// distance, smoothed with passes of a wide moving average (real barometric
// data is noisy and rolling terrain reads as spikes).
function smoothed(ride, opts) {
  const dist = ride.streams.distance.data;
  const alt = ride.streams.altitude.data;
  const half = Math.max(2, Math.round(alt.length * opts.smoothFraction));
  let smooth = alt;
  for (let p = 0; p < opts.smoothPasses; p++) smooth = movingAverage(smooth, half);
  const total = dist[dist.length - 1];
  const out = [];
  let j = 0;
  for (let i = 0; i < opts.plotPoints; i++) {
    const d = (i / (opts.plotPoints - 1)) * total;
    while (j < dist.length - 2 && dist[j + 1] < d) j++;
    const span = dist[j + 1] - dist[j] || 1;
    const t = Math.min(1, Math.max(0, (d - dist[j]) / span));
    out.push(smooth[j] * (1 - t) + smooth[j + 1] * t);
  }
  return out;
}

// Catmull-Rom spline through the points, as cubic beziers, so the profile
// flows through samples instead of connecting them with straight segments.
function splinePath(pts) {
  const n = (v) => v.toFixed(1);
  let d = `M${n(pts[0][0])},${n(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${n(c1x)},${n(c1y)} ${n(c2x)},${n(c2y)} ${n(p2[0])},${n(p2[1])}`;
  }
  return d;
}

export function renderBackdrop(activities, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rides = [...activities].sort(
    (a, b) => new Date(a.start_date_local) - new Date(b.start_date_local),
  );
  const altitudes = rides.map((r) => smoothed(r, opts));
  const maxRelief = Math.max(
    ...altitudes.map((alt) => Math.max(...alt) - Math.min(...alt)),
  );
  const metersToUnits =
    (VIEW_H * PEAK_FRACTION - ROW_STEP * (rides.length - 1)) / maxRelief;

  const parts = [
    `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="none">`,
  ];
  const chipData = [];
  rides.forEach((ride, i) => {
    const depth = rides.length - 1 - i; // 0 = newest, in front
    const baseline = VIEW_H - depth * ROW_STEP;
    const altitude = altitudes[i];
    const minAlt = Math.min(...altitude);
    const points = altitude.map((alt, j) => [
      (j / (altitude.length - 1)) * VIEW_W,
      baseline - (alt - minAlt) * metersToUnits,
    ]);
    const profile = splinePath(points);
    const peak = points[altitude.indexOf(Math.max(...altitude))];
    const t = rides.length > 1 ? depth / (rides.length - 1) : 0;
    const opacity = FRONT_OPACITY + (BACK_OPACITY - FRONT_OPACITY) * t;
    const name = cleanName(ride.name);
    const stats = `${rideStats(ride)} · ${rideDate(ride)}`;
    chipData.push({
      name,
      stats,
      x: (peak[0] / VIEW_W) * 100,
      y: (peak[1] / VIEW_H) * 100,
      // Estimated label width (em at the chip's font size), for the clamp()
      // positioning fallback and the per-chip stacking breakpoint.
      labelEm: (name.length + stats.length + 3) * CHAR_EM,
    });

    // Filled silhouette in the page background color occludes the lines
    // behind it, creating the ridgeline depth effect.
    parts.push(
      `<path class="ride-fill" style="--i: ${i}" d="M0,${baseline} L${profile.slice(1)} L${VIEW_W},${baseline} Z"/>`,
      `<a href="https://www.strava.com/activities/${ride.id}" target="_blank" rel="noopener"`,
      `   aria-label="${escapeAttr(`${name} · ${stats}`)}, view on Strava" style="--i: ${i}">`,
      `<path class="ride-hit" d="${profile}"/>`,
      `<path class="ride-line" opacity="${opacity.toFixed(2)}" d="${profile}"/>`,
      `</a>`,
    );
  });
  parts.push(`</svg>`);

  // One invisible anchor point at each peak (preceding its chip in tree
  // order, as CSS anchor positioning requires) and one pre-rendered chip per
  // ride. Showing/hiding and positioning are entirely CSS; see the generated
  // <style> below and css/ride-backdrop.css.
  chipData.forEach((chip, i) => {
    parts.push(
      `<div class="ride-peak" style="left: ${chip.x.toFixed(2)}%; top: ${chip.y.toFixed(2)}%; anchor-name: --ride-peak-${i}"></div>`,
      `<div class="ride-chip" id="ride-chip-${i}" aria-hidden="true"`,
      `     style="--peak-x: ${chip.x.toFixed(2)}%; --peak-y: ${chip.y.toFixed(2)}%; --half-w: ${(chip.labelEm / 2).toFixed(1)}em; position-anchor: --ride-peak-${i}">`,
      `<span class="ride-chip-name">${escapeAttr(chip.name)}</span>` +
        `<span class="ride-chip-sep">·</span>` +
        `<span class="ride-chip-stats">${escapeAttr(chip.stats)}</span>`,
      `</div>`,
    );
  });

  // Per-ride rules: hover/focus on the nth line (or .active set by the
  // touch script) reveals the nth chip; below a per-chip breakpoint the
  // chip stacks title-over-stats and drops the separator.
  const rules = chipData.map((chip, i) => {
    // chip width (label + padding) at 0.85em font, plus side margins, in rem
    const stackBelowRem = (chip.labelEm + 1.2) * 0.85 + 1.5;
    return (
      `.ride-backdrop:has(svg a:nth-of-type(${i + 1}):hover) #ride-chip-${i},\n` +
      `.ride-backdrop:has(svg a:nth-of-type(${i + 1}):focus) #ride-chip-${i},\n` +
      `#ride-chip-${i}.active { opacity: 1; }\n` +
      `@media (max-width: ${stackBelowRem.toFixed(1)}rem) {\n` +
      `  #ride-chip-${i} { --stack: column; --sep-display: none; }\n` +
      `}`
    );
  });
  parts.push(`<style>`, rules.join("\n"), `</style>`);

  return [`<div class="ride-backdrop">`, ...parts, `</div>`].join("\n");
}

const START = "<!-- ride-backdrop:start -->";
const END = "<!-- ride-backdrop:end -->";

export function injectBackdrop(html, activities, options = {}) {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error("ride-backdrop markers not found in index.html");
  }
  return (
    html.slice(0, start + START.length) +
    "\n" +
    renderBackdrop(activities, options) +
    "\n" +
    html.slice(end)
  );
}

export function loadActivities(url) {
  const text = readFileSync(url, "utf8");
  return JSON.parse(text.slice(text.indexOf("= [") + 2).replace(/;\s*$/, ""));
}

export function updateIndexHtml(activities) {
  const indexUrl = new URL("../index.html", import.meta.url);
  writeFileSync(indexUrl, injectBackdrop(readFileSync(indexUrl, "utf8"), activities));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  updateIndexHtml(loadActivities(new URL("../js/strava-data.js", import.meta.url)));
  console.log("Re-rendered the ride backdrop into index.html");
}
