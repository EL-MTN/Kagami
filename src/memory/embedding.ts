import { cosineSimilarity } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

function getEmbeddingModel() {
  const google = createGoogleGenerativeAI({ apiKey: config.GOOGLE_API_KEY });
  return google.textEmbeddingModel(config.EMBEDDING_MODEL);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const model = getEmbeddingModel();
  const { embeddings } = await model.doEmbed({ values: [text] });
  logger.debug({ dimensions: embeddings[0].length }, "Generated embedding");
  return embeddings[0];
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = getEmbeddingModel();
  const { embeddings } = await model.doEmbed({ values: texts });
  logger.debug({ count: embeddings.length }, "Generated batch embeddings");
  return embeddings;
}

export { cosineSimilarity };
