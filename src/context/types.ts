export interface ImageGenerationRequest {
  prompt: string;
  referenceImages?: string[];
  aspectRatio?: string;
  resolution?: string;
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}
