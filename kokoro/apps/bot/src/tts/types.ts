export interface TtsRequest {
  text: string;
}

export interface GeneratedAudio {
  buffer: Buffer;
  mediaType: string;
  durationSeconds?: number;
}
