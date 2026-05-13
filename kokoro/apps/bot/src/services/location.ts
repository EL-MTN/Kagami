import { config, logger, haversineMeters } from "@kokoro/shared";
import { storeLocation, getLatestLocation, getLocationVisitCount } from "@kokoro/db";
import { appendFactWithRetryQueue } from "@kokoro/memory";
import { reverseGeocode } from "./geocoding";

export interface LocationEvent {
  type: "arrival";
  placeName: string;
  placeCategory: string;
}

export async function processLocation(
  chatId: string,
  latitude: number,
  longitude: number,
  options: {
    accuracy?: number;
    heading?: number;
    isLive?: boolean;
  } = {},
): Promise<LocationEvent | null> {
  const last = await getLatestLocation(chatId);

  // Debounce live location updates that haven't moved enough
  if (options.isLive && last) {
    const distance = haversineMeters(latitude, longitude, last.latitude, last.longitude);
    if (distance < config.LOCATION_MOVEMENT_THRESHOLD_M) {
      logger.debug(
        { chatId, distance: Math.round(distance) },
        "Live location update below movement threshold, skipping",
      );
      return null;
    }
  }

  // Geocode (non-blocking on failure)
  const geo = await reverseGeocode(latitude, longitude);

  // Store to DB
  await storeLocation(chatId, latitude, longitude, {
    accuracy: options.accuracy,
    heading: options.heading,
    placeName: geo?.placeName,
    placeCategory: geo?.placeCategory,
    isLive: options.isLive,
  });

  // Detect arrival event (moved >500m from last known position)
  let event: LocationEvent | null = null;
  if (last) {
    const distance = haversineMeters(latitude, longitude, last.latitude, last.longitude);
    if (distance > 500) {
      event = {
        type: "arrival",
        placeName: geo?.placeName ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
        placeCategory: geo?.placeCategory ?? "place",
      };
      logger.info(
        { chatId, placeName: event.placeName, distance: Math.round(distance) },
        "Location arrival event detected",
      );
    }
  }

  // Place learning: after enough visits within the configured radius/window,
  // promote a fact into Kioku. Format is stable so md5-dedup catches re-saves; Kioku's
  // cosine gate (≥0.97) catches paraphrased near-duplicates.
  if (geo?.placeName) {
    void learnPlace(chatId, latitude, longitude, geo.placeName, geo.placeCategory ?? "place");
  }

  return event;
}

async function learnPlace(
  chatId: string,
  latitude: number,
  longitude: number,
  placeName: string,
  placeCategory: string,
): Promise<void> {
  try {
    const visitCount = await getLocationVisitCount(
      chatId,
      latitude,
      longitude,
      config.PLACE_LEARNING_RADIUS_M,
      config.PLACE_LEARNING_WINDOW_DAYS,
    );
    if (visitCount < config.PLACE_LEARNING_VISITS) return;

    const text = `User frequently visits ${placeName} (${placeCategory}).`;
    const result = await appendFactWithRetryQueue({ text, source_session: "location-learning" });
    if (result.status === "added") {
      logger.info(
        { chatId, placeName, visitCount, factId: result.id },
        "Stored place-learning fact",
      );
    } else if (result.status === "queued") {
      logger.warn(
        { chatId, placeName, visitCount, reason: result.reason },
        "Queued place-learning fact",
      );
    } else {
      logger.debug(
        { chatId, placeName, factId: result.id, similarity: result.similarity },
        "Place-learning fact already known",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "place learning failed";
    logger.warn({ err: reason, chatId, placeName }, "Place learning failed");
  }
}
