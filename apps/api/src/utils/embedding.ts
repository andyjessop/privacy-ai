import { mistral } from "@ai-sdk/mistral";
import { embed } from "ai";

export async function mistralEmbed(text: string): Promise<number[]> {
    const { embedding } = await embed({
        model: mistral.embedding("mistral-embed"),
        value: text,
    });
    return embedding;
}
