// Fetches your recent rides from the Strava API and regenerates
// js/strava-data.js in the shape the ride backdrop consumes.
//
// First run (does the OAuth dance in your browser):
//   node scripts/fetch-strava.mjs --client-id=12345 --client-secret=abc...
//
// Later runs (no browser needed; the refresh token is printed on first run):
//   node scripts/fetch-strava.mjs --client-id=12345 --client-secret=abc... --refresh-token=xyz...
//
// Credentials can also be passed as STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET /
// STRAVA_REFRESH_TOKEN environment variables.

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { cleanName, updateIndexHtml } from "./render-backdrop.mjs";

const PORT = 8723;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const MAX_POINTS = 150; // downsample streams so the SVG stays light

// Flat rides don't make interesting profiles. Keep a ride if it clears
// either bar: total climbing, or relief (the elevation band it traverses) —
// relief is what gives the rendered line its height, and a big-hill ride can
// have modest total gain.
const MIN_GAIN_METERS = 2000 * 0.3048; // 2,000 ft of climbing
const MIN_RELIEF_METERS = 1000 * 0.3048; // 1,000 ft top-to-bottom

function arg(name, envName) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : process.env[envName];
}

const clientId = arg("client-id", "STRAVA_CLIENT_ID");
const clientSecret = arg("client-secret", "STRAVA_CLIENT_SECRET");
let refreshToken = arg("refresh-token", "STRAVA_REFRESH_TOKEN");
// --count/--out fetch a deeper history into a separate file (e.g. for
// previewing how the backdrop evolves) without touching the site data.
const rideCount = Number(arg("count", "STRAVA_RIDE_COUNT")) || 5;
const outPath = arg("out", "STRAVA_OUT");

if (!clientId || !clientSecret) {
  console.error(
    "Usage: node scripts/fetch-strava.mjs --client-id=... --client-secret=... [--refresh-token=...] [--count=N] [--out=FILE]",
  );
  process.exit(1);
}

// Waits for Strava to redirect back to localhost with ?code=...
function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        code
          ? "<p>Authorized — you can close this tab and return to the terminal.</p>"
          : `<p>Authorization failed: ${error}</p>`,
      );
      server.close();
      code ? resolve(code) : reject(new Error(`OAuth error: ${error}`));
    });
    server.listen(PORT, () => {
      const authUrl =
        "https://www.strava.com/oauth/authorize" +
        `?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        "&response_type=code&scope=activity:read_all";
      console.log(`\nOpen this URL to authorize (waiting on port ${PORT}):\n\n  ${authUrl}\n`);
      if (process.platform === "darwin") execFile("open", [authUrl]);
    });
  });
}

async function tokenRequest(params) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function api(path, accessToken) {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function downsample(data, n) {
  if (data.length <= n) return data;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(data[Math.round((i / (n - 1)) * (data.length - 1))]);
  }
  return out;
}

let tokens;
if (refreshToken) {
  tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    // Don't print the token itself: in CI the log is public.
    console.warn(
      "Strava rotated the refresh token; the stored one will stop working. " +
        "Re-run locally without --refresh-token to authorize again.",
    );
  }
} else {
  const code = await waitForOAuthCode();
  tokens = await tokenRequest({ grant_type: "authorization_code", code });
  console.log(
    `\nAuthorized. For future runs without the browser, pass:\n  --refresh-token=${tokens.refresh_token}\n`,
  );
}

const recent = await api("/athlete/activities?per_page=200", tokens.access_token);
// Outdoor rides only: VirtualRide (Peloton/Zwift) also contains "Ride".
const candidates = recent.filter(
  (a) =>
    (a.type === "Ride" || a.sport_type === "Ride" || a.sport_type === "GravelRide" ||
      a.sport_type === "MountainBikeRide") &&
    a.sport_type !== "VirtualRide" &&
    !a.trainer,
);

// Relief requires the altitude stream, so the gain/relief filter happens
// after fetching streams; keep going until enough rides qualify.
const activities = [];
for (const ride of candidates) {
  if (activities.length >= rideCount) break;
  console.log(`Fetching streams: ${ride.name} (${(ride.distance / 1000).toFixed(1)} km)`);
  const streams = await api(
    `/activities/${ride.id}/streams?keys=distance,altitude&key_by_type=true`,
    tokens.access_token,
  );
  const altitude = streams.altitude?.data;
  const relief = altitude ? Math.max(...altitude) - Math.min(...altitude) : 0;
  if (!altitude || !streams.distance || relief === 0) {
    console.warn(`  skipping ${ride.name}: no usable altitude stream (indoor ride?)`);
    continue;
  }
  if (ride.total_elevation_gain < MIN_GAIN_METERS && relief < MIN_RELIEF_METERS) {
    console.log(`  skipping ${ride.name}: too flat (${Math.round(ride.total_elevation_gain * 3.28084)} ft gain, ${Math.round(relief * 3.28084)} ft relief)`);
    continue;
  }
  activities.push({
    id: ride.id,
    // Titles follow a "Something w/ Name" convention; keep names private.
    name: cleanName(ride.name),
    type: ride.type,
    sport_type: ride.sport_type,
    start_date_local: ride.start_date_local,
    distance: ride.distance,
    moving_time: ride.moving_time,
    total_elevation_gain: ride.total_elevation_gain,
    streams: {
      distance: {
        data: downsample(streams.distance.data, MAX_POINTS),
        series_type: "distance",
        resolution: "low",
      },
      altitude: {
        data: downsample(streams.altitude.data, MAX_POINTS),
        series_type: "distance",
        resolution: "low",
      },
    },
  });
}

if (activities.length === 0) {
  console.error(
    "No rides in your 200 most recent activities cleared the gain/relief bar.",
  );
  process.exit(1);
}

// No timestamp in the output: the weekly CI job should only commit when the
// rides themselves changed.
const out = `// Recent ride data from the Strava API, generated by scripts/fetch-strava.mjs.
const STRAVA_ACTIVITIES = ${JSON.stringify(activities, null, 2)};
`;
if (outPath) {
  writeFileSync(outPath, out);
  console.log(`\nWrote ${outPath} with ${activities.length} rides (site data untouched).`);
} else {
  writeFileSync(new URL("../js/strava-data.js", import.meta.url), out);
  updateIndexHtml(activities);
  console.log(
    `\nWrote js/strava-data.js with ${activities.length} rides and re-rendered index.html.`,
  );
}
