// Wraps Gemini text generation and the project's tool-calling convention.
import { Secret } from '@golemcloud/golem-ts-sdk';

export type TelegramConfig = {
  botToken: Secret<string>;
  geminiApiKey: Secret<string>;
  firecrawlApiKey: Secret<string>;
  weatherApiKey: Secret<string>;
  resendApiKey: Secret<string>;
  resendFromEmail: Secret<string>;
  webhookSecret: Secret<string>;
};

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_MODEL_SUPPORTS_NATIVE_FUNCTIONS = false;

// Distinguishes provider quota failures from ordinary Gemini request failures.
export function isGeminiQuotaError(error: unknown): boolean {
  return error instanceof Error && error.name === 'GeminiQuotaError';
}

// Creates a recognizable quota error that callers can special-case.
function createGeminiQuotaError(message: string): Error {
  const error = new Error(message);
  error.name = 'GeminiQuotaError';
  return error;
}

export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: 'STRING'; description: string }>;
    required?: string[];
  };
};

export type GeminiFunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

type GeminiPart = {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
};

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

// Sends a plain-text prompt and returns Gemini's text response.
export async function callGemini(apiKey: Secret<string>, prompt: string): Promise<string> {
  const data = await generateContent(apiKey, [{ role: 'user', parts: [{ text: prompt }] }]);
  return extractText(data);
}

// Returns either a direct reply or one structured tool call.
export async function callGeminiWithFunctions(
  apiKey: Secret<string>,
  prompt: string,
  functionDeclarations: GeminiFunctionDeclaration[]
): Promise<string | GeminiFunctionCall> {
  if (!GEMINI_MODEL_SUPPORTS_NATIVE_FUNCTIONS) {
    return callGeminiWithGeneratedToolJson(apiKey, prompt, functionDeclarations);
  }

  const data = await generateContent(
    apiKey,
    [{ role: 'user', parts: [{ text: prompt }] }],
    functionDeclarations
  );
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const functionCall = parts.find((part) => part.functionCall)?.functionCall;

  if (functionCall) {
    return {
      name: functionCall.name,
      args: functionCall.args ?? {},
    };
  }

  return extractText(data);
}

// Feeds a prior tool call and tool result back into Gemini for the final reply.
export async function callGeminiAfterFunction(
  apiKey: Secret<string>,
  prompt: string,
  functionCall: GeminiFunctionCall,
  functionResult: Record<string, unknown>,
  functionDeclarations: GeminiFunctionDeclaration[]
): Promise<string> {
  if (!GEMINI_MODEL_SUPPORTS_NATIVE_FUNCTIONS) {
    return callGemini(
      apiKey,
      [
        prompt,
        '',
        `Tool call: ${JSON.stringify(functionCall)}`,
        `Tool result: ${JSON.stringify(functionResult)}`,
        '',
        'Reply with plain text only. Use the tool result faithfully.',
      ].join('\n')
    );
  }

  const data = await generateContent(
    apiKey,
    [
      { role: 'user', parts: [{ text: prompt }] },
      { role: 'model', parts: [{ functionCall }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionCall.name,
              response: { result: functionResult },
            },
          },
        ],
      },
    ],
    functionDeclarations
  );

  return extractText(data);
}

// Emulates tool calling by asking Gemini to emit a tiny JSON envelope.
async function callGeminiWithGeneratedToolJson(
  apiKey: Secret<string>,
  prompt: string,
  functionDeclarations: GeminiFunctionDeclaration[]
): Promise<string | GeminiFunctionCall> {
  const toolInstructions = functionDeclarations.map((declaration) => {
    const properties = Object.entries(declaration.parameters.properties)
      .map(([name, schema]) => `${name}: ${schema.type.toLowerCase()} - ${schema.description}`)
      .join(', ');
    return `- ${declaration.name}: ${declaration.description} Args: { ${properties} }`;
  }).join('\n');

  const raw = await callGemini(
    apiKey,
    [
      prompt,
      '',
      'Decide whether to answer directly or call exactly one tool.',
      'Return JSON only in one of these forms:',
      '{"type":"reply","reply":"plain text reply"}',
      '{"type":"tool_call","tool":"toolName","args":{"argName":"value"}}',
      '',
      'Available tools:',
      toolInstructions,
    ].join('\n')
  );
  const parsed = parseJsonObject(raw);

  if (parsed?.type === 'tool_call' && typeof parsed.tool === 'string') {
    const allowed = functionDeclarations.some((declaration) => declaration.name === parsed.tool);
    if (allowed && typeof parsed.args === 'object' && parsed.args !== null) {
      return {
        name: parsed.tool,
        args: parsed.args as Record<string, unknown>,
      };
    }
  }

  if (parsed?.type === 'reply' && typeof parsed.reply === 'string') {
    return parsed.reply;
  }

  return raw;
}

// Pulls the first JSON object out of a raw Gemini reply when tool calling is emulated.
function parseJsonObject(rawText: string): Record<string, unknown> | undefined {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Calls the Gemini API directly with optional function declarations.
async function generateContent(
  apiKey: Secret<string>,
  contents: GeminiContent[],
  functionDeclarations?: GeminiFunctionDeclaration[]
): Promise<GeminiResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey.get()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents,
        tools: functionDeclarations && functionDeclarations.length > 0
          ? [{ functionDeclarations }]
          : undefined,
        generationConfig: {
          temperature: 0.2,
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw createGeminiQuotaError(`Gemini quota exhausted: ${body}`);
    }

    throw new Error(`Gemini request failed: ${response.status} ${body}`);
  }

  return (await response.json()) as GeminiResponse;
}

// Extracts concatenated text parts from the first Gemini candidate.
function extractText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (text.length === 0) {
    throw new Error('Gemini response did not include text');
  }

  return text;
}
