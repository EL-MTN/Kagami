# Location Awareness

Mashiro can receive and process Telegram location shares, giving her ambient awareness of where the user is. The feature is opt-in via `LOCATION_ENABLED`.

## Architecture

```
Telegram location share
    │
    ├─ message:location (one-time share)
    │   ├─ normalizeLocation(ctx) → IncomingMessage with location field
    │   ├─ processLocation() → geocode + store + event detection
    │   ├─ handleMessage() → full AI pipeline (Mashiro can react)
    │   └─ If arrival event → triggerLocationProactive()
    │
    └─ edited_message:location (live location update)
        ├─ normalizeLocationEdit(ctx) → IncomingMessage with location field
        ├─ processLocation() → debounce + geocode + silent store
        └─ If arrival event → triggerLocationProactive()
```

## Data Flow

### Processing Pipeline (`apps/bot/src/services/location.ts`)

1. **Debounce**: For live location updates, check distance from last stored point. Skip if < `LOCATION_MOVEMENT_THRESHOLD_M` (default: 100m).
2. **Geocode**: Call Google Maps Geocoding API to resolve place name and category. Non-blocking on failure.
3. **Store**: Write to `LocationHistory` collection in MongoDB.
4. **Event detection**: If moved >500m from last known position → `arrival` event.
5. **Place learning**: If the same area is visited often enough within the configured radius/window, append a fact via `appendFactWithRetryQueue()` from `@kokoro/memory`. Kioku handles dedup/idempotency on its side, and Kokoro queues the write if Kioku is down.

### Geocoding Service (`apps/bot/src/services/geocoding.ts`)

- `reverseGeocode(lat, lng)` → `{ placeName, formattedAddress, placeCategory } | null`
  - Calls Google Maps Geocoding API
  - Extracts place name from POI, neighborhood, or sublocality
  - Returns null on error (non-blocking)

`haversineMeters(lat1, lng1, lat2, lng2) → number` lives in `@kokoro/shared` (`packages/shared/src/geo.ts`) so non-bot consumers can import it without pulling the bot tree.

## Storage

### LocationHistory Model (`packages/db/src/models/location-history.ts`)

| Field           | Type    | Description                        |
| --------------- | ------- | ---------------------------------- |
| `chatId`        | String  | Telegram chat ID                   |
| `latitude`      | Number  | GPS latitude                       |
| `longitude`     | Number  | GPS longitude                      |
| `accuracy`      | Number? | Horizontal accuracy in meters      |
| `heading`       | Number? | Direction of travel in degrees     |
| `placeName`     | String? | Resolved place name from geocoding |
| `placeCategory` | String? | Place type (e.g., "grocery_store") |
| `isLive`        | Boolean | Whether from live location sharing |
| `timestamp`     | Date    | When the location was recorded     |

**Indexes**:

- `{ chatId: 1, timestamp: -1 }` — efficient per-chat queries
- TTL index on `timestamp` — auto-delete after 90 days

**Helper functions**:

- `storeLocation(chatId, lat, lng, options)` → create a location record
- `getLatestLocation(chatId)` → most recent location for a chat
- `getRecentLocations(chatId, limit, maxAgeHours)` → recent location history
- `getLocationVisitCount(chatId, lat, lng, radiusM, withinDays)` → count visits to an area
- `cleanupOldLocations(olderThanDays)` → manual cleanup (safety net alongside TTL)

## Context Assembly

Location context is injected into the system prompt when:

1. `LOCATION_ENABLED` is `true`
2. A location exists for the chat
3. The location is within `LOCATION_CONTEXT_MAX_AGE_H` (default: 12 hours)

Format in system prompt:

```
## Location
Last known: Whole Foods (grocery_store), 20 minutes ago
(live location sharing is active)
```

Injected into both `assembleSystemPrompt()` (conversations) and `assembleProactiveSystemPrompt()` (proactive messages).

## Proactive Integration

When a location event (arrival) is detected, `triggerLocationProactive(chatId)` reschedules the proactive timer to fire in `LOCATION_PROACTIVE_DELAY_MS` (default: 20 minutes) + 0-5 minute jitter. This lets Mashiro naturally comment on location changes.

## Configuration

| Variable                        | Type    | Default   | Purpose                                                    |
| ------------------------------- | ------- | --------- | ---------------------------------------------------------- |
| `LOCATION_ENABLED`              | boolean | `false`   | Feature gate — all location handling is skipped when false |
| `GOOGLE_MAPS_API_KEY`           | string  | —         | Google Maps Geocoding API key (required when enabled)      |
| `LOCATION_MOVEMENT_THRESHOLD_M` | number  | `100`     | Min meters moved before storing a live location update     |
| `LOCATION_PROACTIVE_DELAY_MS`   | number  | `1200000` | Delay before location-triggered proactive message (20min)  |
| `LOCATION_CONTEXT_MAX_AGE_H`    | number  | `12`      | Max age for location data to appear in LLM context         |
| `PLACE_LEARNING_VISITS`         | integer | `3`       | Visits required before a place is learned into Kioku       |
| `PLACE_LEARNING_RADIUS_M`       | number  | `200`     | Radius used when counting repeat visits to the same place  |
| `PLACE_LEARNING_WINDOW_DAYS`    | integer | `30`      | Lookback window for repeat-visit place learning            |

**Validation**: `LOCATION_ENABLED=true` requires `GOOGLE_MAPS_API_KEY` to be set.

## Cost

- **Google Maps Geocoding API**: ~$5 per 1,000 requests. One-time location shares cost 1 request each. Live location updates are debounced by movement threshold, so cost depends on user movement patterns.
- **Memory engine**: Place learning calls `appendFactWithRetryQueue()` (Kioku), which uses the embedding API. Only triggered after the configured repeat-visit threshold, so minimal cost.

## Files

**New**:

- `packages/db/src/models/location-history.ts` — MongoDB model + helpers
- `apps/bot/src/services/geocoding.ts` — Google Maps reverse geocoding
- `apps/bot/src/services/location.ts` — Location processing pipeline

**Modified**:

- `packages/shared/src/config.ts` — location config vars + validation
- `packages/shared/src/types.ts` — `location` field on `IncomingMessage`
- `packages/db/src/index.ts` — LocationHistory exports
- `apps/bot/src/platform/telegram/adapter.ts` — `normalizeLocation`, `normalizeLocationEdit`
- `apps/bot/src/platform/telegram/bot.ts` — location handlers
- `apps/bot/src/ai/context-assembler.ts` — `assembleLocationContext`, chatId threading
- `apps/bot/src/ai/generate.ts` — pass chatId to `assembleSystemPrompt`
- `apps/bot/src/scheduler/proactive.ts` — `triggerLocationProactive`, location cleanup
