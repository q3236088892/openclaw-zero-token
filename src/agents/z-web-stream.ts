import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
} from "@mariozechner/pi-ai";
import {
  ZWebClientBrowser,
  type ZWebClientOptions,
} from "../providers/z-web-client-browser.js";
import { stripForWebProvider } from "./prompt-sanitize.js";

const conversationMap = new Map<string, string>();

export function createZWebStreamFn(cookieOrJson: string): StreamFn {
  let options: ZWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = typeof parsed === "string" ? { cookie: parsed, userAgent: "Mozilla/5.0" } : parsed;
  } catch {
    options = { cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new ZWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        const conversationId = conversationMap.get(sessionKey);

        const messages = context.messages || [];
        const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");

        let prompt = "";
        if (lastUserMessage) {
          if (typeof lastUserMessage.content === "string") {
            prompt = lastUserMessage.content;
          } else if (Array.isArray(lastUserMessage.content)) {
            prompt = (lastUserMessage.content as TextContent[])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
          }
        }

        if (!prompt) {
          throw new Error("No message found to send to ChatGLM API");
        }

        const cleanPrompt = stripForWebProvider(prompt);
        if (!cleanPrompt) {
          throw new Error("No message content to send after stripping metadata");
        }

        console.log(`[ZWebStream] Starting run for session: ${sessionKey}`);
        console.log(`[ZWebStream] Conversation ID: ${conversationId || "new"}`);
        console.log(`[ZWebStream] Prompt length: ${prompt.length} -> ${cleanPrompt.length} after stripping`);

        const responseStream = await client.chatCompletions({
          conversationId,
          message: cleanPrompt,
          model: model.id,
          signal: streamOptions?.signal,
        });

        if (!responseStream) {
          throw new Error("ChatGLM API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let accumulatedContent = "";
        let buffer = "";

        const contentParts: TextContent[] = [];
        let contentIndex = 0;
        let lastExtractedText = "";

        const createPartial = (): AssistantMessage => ({
          role: "assistant",
          content: [...contentParts],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });

        // Extract text from ChatGLM response parts
        // Format: parts[].content[] where content items have {type: "text", text: "..."}
        // Returns the full text for this chunk (need to calculate delta ourselves)
        const extractTextFromParts = (parts: unknown[]): string => {
          if (!Array.isArray(parts)) return "";
          for (const part of parts) {
            if (!part || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            const content = p.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c && typeof c === "object") {
                  const cc = c as Record<string, unknown>;
                  if (cc.type === "text" && typeof cc.text === "string") {
                    return cc.text;
                  }
                }
              }
            }
          }
          return "";
        };

        const processLine = (line: string) => {
          if (!line || !line.trim()) return;

          let dataStr = line.trim();
          // ChatGLM SSE: "data: {...}" lines
          if (dataStr.startsWith("data:")) {
            dataStr = dataStr.slice(5).trim();
          }
          if (!dataStr) return;

          try {
            const data = JSON.parse(dataStr);

            // ChatGLM returns conversation_id in response
            if (data.conversation_id) {
              conversationMap.set(sessionKey, data.conversation_id);
            }

            // Check for error status
            if (data.status === "error" || data.last_error?.message) {
              const errMsg = data.last_error?.message || data.message || "Unknown error";
              console.log(`[ZWebStream] API error: ${errMsg}`);
              return;
            }

            // Skip status "init" - means still processing
            if (data.status === "init") {
              return;
            }

            // Extract text from parts - the new format has parts[].content[]
            let delta = "";
            if (data.parts && Array.isArray(data.parts)) {
              delta = extractTextFromParts(data.parts);
            }

            // Fallback to legacy format
            if (!delta) {
              delta = data.text || "";
            }

            if (delta && delta !== lastExtractedText) {
              // Calculate the incremental part (each SSE has full accumulated text)
              const newDelta = delta.substring(lastExtractedText.length);
              lastExtractedText = delta;

              if (newDelta) {
                if (contentParts.length === 0) {
                  contentParts[contentIndex] = { type: "text", text: "" };
                  stream.push({ type: "text_start", contentIndex, partial: createPartial() });
                }

                const actualDelta = newDelta;
                contentParts[contentIndex].text += actualDelta;
                accumulatedContent += actualDelta;

                stream.push({
                  type: "text_delta",
                  contentIndex,
                  delta: actualDelta,
                  partial: createPartial(),
                });
              }
            }
          } catch {
            // Ignore parse errors
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        console.log(`[ZWebStream] Stream completed. Content length: ${accumulatedContent.length}`);

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: contentParts.length > 0 ? contentParts : [{ type: "text", text: accumulatedContent }],
          stopReason: "stop",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };

        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as any);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
