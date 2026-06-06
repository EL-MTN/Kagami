export type ServiceId = "kioku" | "kokoro" | "kizuna" | "kansoku" | "kao";
export type ServiceState = "ok" | "warn" | "down" | "unknown";
export type AttentionSeverity = "critical" | "warning" | "info";

export interface ServiceCard {
  id: ServiceId;
  name: string;
  kanji: string;
  role: string;
  href: string;
  state: ServiceState;
  summary: string;
  detail?: string;
  metric?: {
    label: string;
    value: string | number;
  };
  checkedAt: string;
}

export interface AttentionItem {
  id: string;
  service: ServiceId;
  severity: AttentionSeverity;
  title: string;
  detail?: string;
  href: string;
  detectedAt: string;
}

export interface CockpitData {
  checkedAt: string;
  services: ServiceCard[];
  attention: AttentionItem[];
}
