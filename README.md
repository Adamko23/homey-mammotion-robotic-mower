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
- Run schedule by ID

The device card shows direct command buttons for state-only job controls such as pause, resume, cancel, and dock. Each command has its own icon and Slovak/English label so the actions remain easy to distinguish on both mobile and web. Starting mowing needs parameters, so it is exposed as a Flow action with a form instead of a device-card button. The Flow path-order selector follows Mammotion's protocol values: `Border first` sends perimeter-first order and `Grid first` sends grid-first order.

## Status and history

The mower device displays the confirmed mower state, battery, charging state, mowing progress and zone, blade height, Wi-Fi signal, RTK quality and satellite count, cutter RPM, firmware, error code, and available maintenance counters. Status rows use purpose-specific icons instead of Homey's generic custom-capability placeholder. The app also records the last Homey command and the timestamp of the most recent mower report.

Confirmed state transitions and accepted Homey commands are written to the device Timeline. Command entries explicitly distinguish a press in the Homey device controls from a Homey Flow action. This deliberately distinguishes a command accepted by Mammotion's cloud from a state later confirmed by the mower. Flow triggers are available for every state change, mowing start, pause, return to dock, and mowing end.

The app requests a fresh status every minute while the mower is in a safe operating mode. A status stream with no report for three minutes is shown as stale, but an idle mower is marked unavailable only when repeated cloud refreshes fail too. The MQTT connection refreshes its short-lived credentials, restores subscriptions, and requests a fresh report after reconnecting, so the status can recover after an internet or Wi-Fi outage without restarting the app.

Commands are sent through Mammotion's cloud MQTT RPC bridge using Mammotion protobuf messages modelled after PyMammotion and ioBroker's Mammotion adapter. The app does not use Aliyun/AEP bootstrap or Aliyun command fallback. Luba 2 commands are routed to the mower's navigation controller (`DEV_NAVIGATION`), while Luba 1 keeps the main-controller route. `Start mowing` requests Mammotion area names and hash IDs through the RPC bridge and exposes them as a Homey Flow autocomplete. The app maintains a JWT MQTT receive connection and refreshes its broker credentials when the connection drops.

`Run schedule by ID` currently starts an already existing Mammotion schedule by `planId`. Creating, editing, or automatically listing schedules is not implemented yet because it requires synchronizing mower plans and map zones from the device before sending `NavPlanJobSet` payloads.

This app uses unofficial Mammotion API behaviour and should be treated as experimental.

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

The Mammotion API is unofficial. Authentication, MQTT topics, protobuf payloads, or command semantics can change without notice. A command accepted by the cloud is recorded separately from a mower state later confirmed by telemetry.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the main open-source dependencies used by the integration.
