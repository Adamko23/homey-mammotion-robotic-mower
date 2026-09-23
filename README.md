# Mammotion Homey App

Homey SDK v3 TypeScript app for Mammotion robotic lawn mowers. It provides account login, device pairing, cloud commands, zone discovery, live mower status, maintenance counters, Flow triggers, and Homey Timeline activity.

> This is an unofficial community integration and is not affiliated with or endorsed by Mammotion or Athom.

## Supported hardware

The app is developed and tested with:

- Mammotion LUBA 2 AWD 1000

Other LUBA and YUKA models discovered by the same Mammotion account may work, but should be treated as experimental until their command routing and telemetry have been verified.

## Requirements

- Homey Pro with Homey OS 5 or newer
- A Mammotion account that already owns or has access to the mower
- Internet access from Homey to Mammotion OAuth2, API, and MQTT services
- The mower online through its normal Wi-Fi or mobile connection

The recommended login uses Mammotion's signed `/oauth2/token` flow. The app key and secret are the public mobile-client credentials used by the upstream integration, not personal account credentials. They are supplied through the ignored local `env.json`; users still enter only their Mammotion e-mail address and password during Homey pairing. The encrypted legacy `/oauth/token` flow remains available as a fallback when the signed variables are not configured.

## Implemented controls

The mower driver exposes these Homey Flow actions:

- Start mowing
- Pause mowing
- Resume mowing
- Cancel mowing
- Return to dock
- Run saved task by ID

The device card shows direct command buttons for state-only job controls such as pause, resume, cancel, and dock. Each command has its own icon and Slovak/English label so the actions remain easy to distinguish on both mobile and web. Starting mowing needs parameters, so it is exposed as a Flow action with a form instead of a device-card button. The Flow path-order selector follows Mammotion's protocol values: `Border first` sends perimeter-first order and `Grid first` sends grid-first order.

## Status and history

The mower device displays the confirmed mower state, battery, charging state, mowing progress and zone, blade height, Wi-Fi signal, RTK quality and satellite count, cutter RPM, firmware, error code, and available maintenance counters. Status rows use purpose-specific icons instead of Homey's generic custom-capability placeholder. The app also records the last Homey command and the timestamp of the most recent mower report.

LUBA 2 route configuration includes its mowing tactics byte (`reserved[5] = 8`), and commands target the navigation controller. Version 1.3.6 accepts task-control acknowledgements and fresh mowing telemetry as start confirmation, in addition to route-progress events. A confirmed MQTT start can resolve an ambiguous cloud gateway timeout without retransmitting the start; explicit rejections and authentication errors remain errors. Concurrent starts for the same mower are blocked while a start is pending.

A start acknowledgement does not confirm blade rotation. The app queries cutter RPM and shows a separate last-cutter-report timestamp, but an empty cutter block is **not** a measured zero. Only explicitly supplied RPM values update the measurement. RPM is cleared on app startup or after three minutes without a measurement. The cutter mode field is a speed preset (standard/economic/performance), not an on/off indicator. `Task cutting height` shows the mower's reported route setting separately from `Reported blade height`; neither is independent physical confirmation of blade position or rotation.

Confirmed state transitions and accepted Homey commands are written to the device Timeline. Command entries explicitly distinguish a press in the Homey device controls from a Homey Flow action. This deliberately distinguishes a command accepted by Mammotion's cloud from a state later confirmed by the mower. Flow triggers are available for every state change, mowing start, pause, return to dock, and mowing end.

The app requests a fresh status every minute while the mower is in a safe operating mode. A status stream with no report for three minutes is shown as stale, but an idle mower is marked unavailable only when repeated cloud refreshes fail too. The MQTT connection refreshes its short-lived credentials, restores subscriptions, and requests a fresh report after reconnecting, so the status can recover after an internet or Wi-Fi outage without restarting the app.

Version 1.3.8 also renews authentication when Mammotion returns JSON `code: 401`
inside an otherwise successful HTTP response. Concurrent requests share the token
refresh, and each authentication-rejected request is retried at most once. Cloud
timeouts and mower rejections are not retried by this recovery. Refresh credentials
are retained when the server does not issue a replacement. This fixes a session
expiry path that could leave status unavailable until the mobile app caused new
reports; it does not hide actual offline or stale status.

Commands are sent through Mammotion's cloud MQTT RPC bridge using Mammotion protobuf messages modelled after PyMammotion and ioBroker's Mammotion adapter. The app does not use Aliyun/AEP bootstrap or Aliyun command fallback. Luba 2 commands are routed to the mower's navigation controller (`DEV_NAVIGATION`), while Luba 1 keeps the main-controller route. `Start mowing` requests Mammotion area names and hash IDs through the RPC bridge and exposes them as a Homey Flow autocomplete. The app maintains a JWT MQTT receive connection and refreshes its broker credentials when the connection drops.

### Starting an existing Mammotion task

Use `Run saved task by ID` to send the one-shot execution command for an existing task using its `planId` (not its displayed name). Zones, cutting height, speed, path order, and other mowing settings stay in the Mammotion task. Homey does not regenerate a route, edit the task, or enable its automatic schedule. The task's automatic schedule can therefore stay disabled while a Homey Flow decides when to run it. If you delete and recreate the task in Mammotion, update its ID in the Flow.

The action waits for confirmation for the selected plan, or fresh mowing telemetry when the mower was not already mowing. Version 1.3.7 correctly treats saved-plan acknowledgement `result = 1` as success; other task-control commands use `result = 0` instead. An unconfirmed response is not a safe reason to retry automatically: the mower may already be executing it. In a scheduled Flow, reserve any daily-run guard **before** the command. Creating, editing, or automatically listing saved tasks in Homey is not implemented yet. The command layout is covered by protocol tests; end-to-end execution still depends on the mower firmware and must be checked on the intended device.

This app uses unofficial Mammotion API behaviour and should be treated as experimental.

### Optional observed rain radar (1.3.9)

Enable **Rain radar (RainViewer)** in the mower's device settings. The app uses the
location configured in Homey, checks radar coverage, and samples that location's
pixel from RainViewer's observed radar frames. It does not use the hourly rain
forecast, humidity, a radius around the garden, or Mammotion's onboard rain sensor.
The default precipitation threshold is 15 dBZ; it is adjustable, not a precise
measurement of rainfall at ground level. The default dry interval is 120 minutes.

The mower shows radar state, an explanation, and the frame timestamp (UTC). Flow
cards **Radar detects precipitation at home**, **Radar allows mowing after the dry
interval**, and **Rain radar state changed** are available. A false rain condition
can also mean missing data: never invert that condition to authorize mowing. Use
the separate dry-interval condition for starting/resuming. The radar component
itself sends no mower commands; connect these conditions to the desired Flow.

For a daily mowing Flow, check once per minute between 11:00 and 17:00, claim a
daily-start flag before executing the saved task, and retain existing temperature
limits. On radar rain, pause and return to dock; resume the unfinished task only
after a continuous dry interval. At 17:00 perform the last eligible start/resume,
or cancel a rain-paused unfinished task if it still cannot resume. Do not cancel
an actively mowing task just because it is 17:00. Track manual mowing starts too,
so the daily flag also prevents a second automated task that day.

Radar polling runs in Homey, with a five-minute manifest cache and ten-minute
observed frames. Dry history persists across app restarts. Missing observations
do not count as dry minutes; a frame older than 20 minutes is unknown. Failed
checks block a new start/resume but must not be connected to a rain-stop action.
Existing fresh history avoids an unnecessary two-hour wait on every restart.

Radar is an estimate with spatial/temporal limitations: it can miss very local
rain, include echoes not reaching the ground, or lag behind current conditions.
The static coverage mask does not prove every underlying station is currently
operational. Dry radar also cannot measure lawn moisture, irrigation or dew.
This is best-effort automation, not a guaranteed garden rain detector.

Radar data and palette: [RainViewer](https://www.rainviewer.com/),
[API documentation](https://www.rainviewer.com/api/weather-maps-api.html).
For manual comparison open `https://www.rainviewer.com/map.html?loc=LAT,LON,10`
with your Homey latitude/longitude. No personal location is embedded in this repo.

## Local setup

1. Copy `env.example.json` to `env.json`.
2. Keep `CLIENT_ID` and `CLIENT_SECRET` as `unused`; they only silence generic `homey-oauth2app` defaults.
3. Set `MAMMOTION_AUTH_FLOW` to `signed_oauth2` and provide the current public Mammotion OAuth2 app key and secret used by the upstream integration.
4. Run `npm install`.
5. Run `npm run build`.
6. Run `homey app run`.

`env.json` is ignored by git because it is local runtime configuration.

## Installation from source

```sh
git clone https://github.com/Adamko23/homey-mammotion-robotic-mower.git
cd homey-mammotion-robotic-mower
npm install
cp env.example.json env.json
# Fill in the public Mammotion mobile-client OAuth2 values in env.json.
npm run build
npm run validate
homey app install
```

Never commit `env.json`, Homey userdata exports, account credentials, access tokens, or diagnostic logs.

## Privacy and limitations

Login, mower discovery, commands, and telemetry use Mammotion's cloud services. Account credentials are submitted only to Mammotion's authentication service through the Homey OAuth2 client. Homey stores the resulting OAuth2 session and device metadata in its local app storage.

Optional radar requires Homey's geolocation permission and is disabled by default.
When enabled, Homey downloads public map tiles from RainViewer. Tile coordinates
reveal the requested broad map area to that service; exact home coordinates are
used only locally to choose a pixel. Recent point observations are stored in the
device's local Homey storage. A manually opened location-specific map URL does
send its included coordinates to RainViewer. Radar does not send Mammotion account
credentials, device IDs, or mower telemetry to RainViewer.

The Mammotion API is unofficial. Authentication, MQTT topics, protobuf payloads, or command semantics can change without notice. A command accepted by the cloud is recorded separately from a mower state later confirmed by telemetry.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the main open-source dependencies used by the integration.
