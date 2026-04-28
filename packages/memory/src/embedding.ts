import { cosineSimilarity } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config, logger } from "@mashiro/shared";

const google = createGoogleGenerativeAI({ apiKey: config.GOOGLE_API_KEY });
const embeddingModel = google.textEmbeddingModel(config.EMBEDDING_MODEL);

export async function generateEmbedding(text: string): Promise<number[]> {
  const { embeddings } = await embeddingModel.doEmbed({ values: [text] });
  logger.debug({ dimensions: embeddings[0].length }, "Generated embedding");
  return embeddings[0];
}

export { cosineSimilarity };
