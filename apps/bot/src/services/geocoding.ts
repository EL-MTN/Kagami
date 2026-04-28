import { config, logger } from "@mashiro/shared";

interface GeocodeResult {
  placeName: string;
  formattedAddress: string;
  placeCategory: string;
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult | null> {
  const apiKey = config.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ status: res.status }, "Geocoding API returned non-OK status");
      return null;
    }

    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{
          long_name: string;
          types: string[];
        }>;
        types?: string[];
      }>;
    };

    if (data.status !== "OK" || !data.results?.length) {
      return null;
    }

    const first = data.results[0];
    const formattedAddress = first.formatted_address ?? `${lat}, ${lng}`;

    // Extract a place name from address components
    const poi = first.address_components?.find((c) =>
      c.types.some((t) => t === "point_of_interest" || t === "establishment"),
    );
    const neighborhood = first.address_components?.find((c) => c.types.includes("neighborhood"));
    const sublocality = first.address_components?.find((c) => c.types.includes("sublocality"));

    const placeName =
      poi?.long_name ?? neighborhood?.long_name ?? sublocality?.long_name ?? formattedAddress;

    // Derive a category from the result types
    const types = first.types ?? [];
    const placeCategory =
      types.find(
        (t) =>
          t !== "political" &&
          t !== "geocode" &&
          t !== "street_address" &&
          t !== "route" &&
          t !== "premise",
      ) ?? "place";

    return { placeName, formattedAddress, placeCategory };
  } catch (error) {
    logger.warn({ error, lat, lng }, "Reverse geocoding failed");
    return null;
  }
}
