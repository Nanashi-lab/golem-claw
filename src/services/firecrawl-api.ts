// Wraps Firecrawl search and scrape endpoints behind small typed helpers.
import type { Secret } from '@golemcloud/golem-ts-sdk';

export type FirecrawlSearchResult = {
  title: string;
  url: string;
  description: string;
};

export type FirecrawlPage = {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
};

export type FirecrawlSearchResponse = {
  ok: boolean;
  summary: string;
  results?: FirecrawlSearchResult[];
  creditsUsed?: number;
};

export type FirecrawlScrapeResponse = {
  ok: boolean;
  summary: string;
  page?: FirecrawlPage;
};

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';
const MAX_SEARCH_RESULTS = 5;
const MAX_SCRAPE_CHARS = 8000;

// Runs a web search and returns a compact summary plus the top result set.
export async function searchWeb(apiKey: Secret<string>, query: string): Promise<FirecrawlSearchResponse> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      summary: 'Search query is empty.',
    };
  }

  const data = await postFirecrawl(apiKey, '/search', {
    query: trimmed,
    limit: MAX_SEARCH_RESULTS,
    sources: [{ type: 'web' }],
    ignoreInvalidURLs: true,
    timeout: 60000,
  }) as {
    success?: boolean;
    data?: { web?: Array<{ title?: string; url?: string; description?: string }> };
    warning?: string;
    creditsUsed?: number;
  };

  const results = (data.data?.web ?? [])
    .filter((entry) => typeof entry.url === 'string' && entry.url.length > 0)
    .map((entry) => ({
      title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.url ?? 'Untitled',
      url: entry.url ?? '',
      description: typeof entry.description === 'string' ? entry.description : '',
    }));

  if (!data.success || results.length === 0) {
    return {
      ok: false,
      summary: data.warning ?? `No web search results found for ${trimmed}.`,
      creditsUsed: data.creditsUsed,
    };
  }

  return {
    ok: true,
    summary: `Found ${results.length} web result(s) for ${trimmed}.`,
    results,
    creditsUsed: data.creditsUsed,
  };
}

// Scrapes a single page and truncates markdown for prompt safety.
export async function scrapeWebPage(apiKey: Secret<string>, url: string): Promise<FirecrawlScrapeResponse> {
  const parsedUrl = parseHttpUrl(url);
  if (!parsedUrl) {
    return {
      ok: false,
      summary: 'Please provide a valid http or https URL to scrape.',
    };
  }

  const data = await postFirecrawl(apiKey, '/scrape', {
    url: parsedUrl,
    formats: [{ type: 'markdown' }],
    onlyMainContent: true,
    removeBase64Images: true,
    blockAds: true,
    timeout: 60000,
  }) as {
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: {
        title?: string | string[];
        description?: string | string[];
        sourceURL?: string;
        url?: string;
      };
    };
    error?: string;
  };

  const markdown = data.data?.markdown;
  if (!data.success || typeof markdown !== 'string' || markdown.trim().length === 0) {
    return {
      ok: false,
      summary: data.error ?? `Could not scrape ${parsedUrl}.`,
    };
  }

  const metadata = data.data?.metadata;
  const pageUrl = metadata?.url ?? metadata?.sourceURL ?? parsedUrl;
  const page = {
    url: pageUrl,
    title: firstString(metadata?.title),
    description: firstString(metadata?.description),
    markdown: truncate(markdown.trim(), MAX_SCRAPE_CHARS),
  };

  return {
    ok: true,
    summary: `Scraped ${page.title ?? page.url}. Content returned to the assistant${markdown.length > MAX_SCRAPE_CHARS ? ' truncated for chat context' : ''}.`,
    page,
  };
}

// Posts a typed JSON request to Firecrawl and raises clear HTTP errors.
async function postFirecrawl(apiKey: Secret<string>, path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${FIRECRAWL_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.get()}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

// Rejects non-http URLs before making an external scrape request.
function parseHttpUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

// Picks the first non-empty string from Firecrawl metadata variants.
function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry) => entry.trim().length > 0);
  }

  return value && value.trim().length > 0 ? value : undefined;
}

// Caps page content before it gets embedded in prompts or notes.
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}
