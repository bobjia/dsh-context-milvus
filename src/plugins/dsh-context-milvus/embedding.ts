/**
 * Embedding API client.
 *
 * Calls an OpenAI-compatible embedding API to convert text chunks into vectors.
 * Also supports Ollama's embedding API format transparently.
 * Configurable endpoint, model, and API key.
 */

import type { EmbeddingConfig } from './types.js'

export class EmbeddingClient {
  private readonly config: EmbeddingConfig

  constructor(config: EmbeddingConfig) {
    this.config = config
  }

  /**
   * Generate embeddings for an array of text strings.
   *
   * @param texts - Array of text strings to embed
   * @returns Array of embedding vectors (each is a number[])
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        input: texts,
        model: this.config.model,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `Embedding API error: ${response.status} ${response.statusText} — ${errorText}`,
      )
    }

    const body = await response.json() as any

    // Handle Ollama /api/embed response format: { model, embeddings: [[...], ...] }
    if (body.embeddings && Array.isArray(body.embeddings)) {
      return body.embeddings as number[][]
    }

    // Handle OpenAI-compatible response format: { data: [{ embedding: number[] }] }
    if (body.data && Array.isArray(body.data)) {
      return body.data.map((item: any) => item.embedding)
    }

    // Handle direct array response
    if (Array.isArray(body)) {
      return body
    }

    throw new Error(`Unexpected embedding API response format: ${JSON.stringify(body).slice(0, 200)}`)
  }
}