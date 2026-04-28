import { config, logger, haversineMeters } from "@mashiro/shared";
import { storeLocation, getLatestLocation, getLocationVisitCount } from "@mashiro/db";
import * as engine from "@mashiro/memory";
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

  // Place learning: if visited 3+ times in 30 days, store a fact
  if (geo?.placeName) {
    try {
      const visitCount = await getLocationVisitCount(chatId, latitude, longitude, 200, 30);
      if (visitCount >= 3) {
        const factContent = `He frequently visits ${geo.placeName} (${geo.placeCategory})`;
        // Check for duplicate facts before storing
        const existing = await engine.recall(factContent, {
          type: "fact",
          limit: 1,
          minScore: 0.85,
        });
        if (existing.length === 0) {
          await engine.remember(factContent, "fact", "location-learning", {
            chatId,
            importance: 4,
          });
          logger.info(
            { chatId, placeName: geo.placeName, visitCount },
            "Stored place learning fact",
          );
        }
      }
    } catch (error) {
      logger.warn({ error, chatId }, "Place learning failed");
    }
  }

  return event;
}
