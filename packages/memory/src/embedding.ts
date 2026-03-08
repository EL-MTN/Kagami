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

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embeddingModel.doEmbed({ values: texts });
  logger.debug({ count: embeddings.length }, "Generated batch embeddings");
  return embeddings;
}

export { cosineSimilarity };
