import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from './gemini';

type FirecrawlSearchResult = {
  title: string;
  url: string;
  description: string;
};

type FirecrawlScrapeResult = {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
};

export type FirecrawlResult = {
  tool: 'webSearch' | 'webScrape';
  ok: boolean;
  summary: string;
  results?: FirecrawlSearchResult[];
  page?: FirecrawlScrapeResult;
  creditsUsed?: number;
};

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';
const MAX_SEARCH_RESULTS = 5;
const MAX_SCRAPE_CHARS = 8000;

@agent()
export class FirecrawlAgent extends BaseAgent {
  constructor(readonly botName: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async webSearch(query: string): Promise<FirecrawlResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return {
        tool: 'webSearch',
        ok: false,
        summary: 'Search query is empty.',
      };
    }

    const data = await this.postFirecrawl('/search', {
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
        tool: 'webSearch',
        ok: false,
        summary: data.warning ?? `No web search results found for ${trimmed}.`,
        creditsUsed: data.creditsUsed,
      };
    }

    return {
      tool: 'webSearch',
      ok: true,
      summary: `Found ${results.length} web result(s) for ${trimmed}.`,
      results,
      creditsUsed: data.creditsUsed,
    };
  }

  async webScrape(url: string): Promise<FirecrawlResult> {
    const parsedUrl = this.parseHttpUrl(url);
    if (!parsedUrl) {
      return {
        tool: 'webScrape',
        ok: false,
        summary: 'Please provide a valid http or https URL to scrape.',
      };
    }

    const data = await this.postFirecrawl('/scrape', {
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
        tool: 'webScrape',
        ok: false,
        summary: data.error ?? `Could not scrape ${parsedUrl}.`,
      };
    }

    const metadata = data.data?.metadata;
    const pageUrl = metadata?.url ?? metadata?.sourceURL ?? parsedUrl;
    const page = {
      url: pageUrl,
      title: this.firstString(metadata?.title),
      description: this.firstString(metadata?.description),
      markdown: this.truncate(markdown.trim(), MAX_SCRAPE_CHARS),
    };

    return {
      tool: 'webScrape',
      ok: true,
      summary: `Scraped ${page.title ?? page.url}. Content returned to the assistant${markdown.length > MAX_SCRAPE_CHARS ? ' truncated for chat context' : ''}.`,
      page,
    };
  }

  private async postFirecrawl(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${FIRECRAWL_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.value.firecrawlApiKey.get()}`,
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

  private parseHttpUrl(rawUrl: string): string | undefined {
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

  private firstString(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value.find((entry) => entry.trim().length > 0);
    }
    return value && value.trim().length > 0 ? value : undefined;
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  }
}
