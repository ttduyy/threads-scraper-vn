import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAX_LOG_CHARS = 100000; // truncate large HTML/JSON in logs

console.log(`Starting Threads Dynamic Trending Scraper`);

function normalizeKeyword(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^[\s"'`]+|[\s"'`]+$/g, "").trim();
}

function isLikelyKeyword(value) {
  const keyword = normalizeKeyword(value);
  if (!keyword || keyword.length < 2 || keyword.length > 80) return false;
  if (!/[A-Za-z]/.test(keyword)) return false;
  if (/https?:\/\//i.test(keyword) || /<\/?[a-z][\s\S]*>/i.test(keyword)) return false;

  const lower = keyword.toLowerCase();
  const blocked = [
    "search",
    "follow",
    "terms",
    "policy",
    "threads",
    "instagram",
    "login",
    "signup",
    "account",
    "privacy",
    "help",
    "about",
    "trending topics",
    "trending"
  ];

  return !blocked.some((item) => lower === item || lower.includes(item));
}

function addKeyword(list, value) {
  const keyword = normalizeKeyword(value);
  if (!isLikelyKeyword(keyword)) return;

  if (!list.includes(keyword)) {
    list.push(keyword);
  }
}

function collectKeywordsFromText(text, list) {
  if (!text || typeof text !== "string") return;

  const keyPatterns = [
    /"(?:query|keyword|name|title|label|text)"\s*:\s*"([^"\\]{2,80})"/gi,
    /'(?:query|keyword|name|title|label|text)'\s*:\s*'([^'\\]{2,80})'/gi,
    /(?:^|[\s\p{P}])#([A-Za-z0-9_]{2,40})(?=$|[\s\p{P}])/gu,
    /(?:^|[\s\p{P}])([A-Za-z][A-Za-z0-9_\-\s]{2,40})(?=$|[\s\p{P}])/g
  ];

  for (const pattern of keyPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1] || match[0];
      addKeyword(list, candidate);
    }
  }
}

function collectKeywordsFromObject(obj, list) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) collectKeywordsFromObject(item, list);
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      if (["query", "keyword", "name", "title", "text", "label", "hashtag"].includes(key.toLowerCase())) {
        addKeyword(list, value);
      }

      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("trending") || lowerKey.includes("topic") || lowerKey.includes("hashtag") || lowerKey.includes("search")) {
        addKeyword(list, value);
      }

      if (value.includes("trending") || value.includes("topic") || value.includes("hashtag") || value.includes("search")) {
        collectKeywordsFromText(value, list);
      }
    } else if (value && typeof value === "object") {
      collectKeywordsFromObject(value, list);
    }
  }
}

function extractKeywordsFromHtml(html) {
  const keywords = [];

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, scriptBody] of scripts) {
    if (!scriptBody) continue;

    if (scriptBody.includes("trending") || scriptBody.includes("topic") || scriptBody.includes("hashtag") || scriptBody.includes("search")) {
      collectKeywordsFromText(scriptBody, keywords);
    }

    try {
      const parsed = JSON.parse(scriptBody);
      collectKeywordsFromObject(parsed, keywords);
    } catch {
      // ignore non-JSON script blocks
    }
  }

  const jsonScripts = [...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, scriptBody] of jsonScripts) {
    try {
      const parsed = JSON.parse(scriptBody);
      collectKeywordsFromObject(parsed, keywords);
    } catch {
      // ignore invalid JSON
    }
  }

  const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData && nextData[1]) {
    try {
      const parsed = JSON.parse(nextData[1]);
      collectKeywordsFromObject(parsed, keywords);
    } catch {
      // ignore invalid JSON
    }
  }

  return [...new Set(keywords)]
    .filter((word) => word && word.length > 1)
    .slice(0, 15);
}

async function getTrendingKeywords(browser) {
  console.log("Navigating to https://www.threads.net/search to extract Trending topics...");
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    locale: "vi-VN"
  });

  const rawCookie = process.env.THREADS_COOKIE;
  if (rawCookie) {
    console.log("Found THREADS_COOKIE, injecting into context...");
    try {
      const parsedCookies = JSON.parse(rawCookie);
      await context.addCookies(parsedCookies);
    } catch (e) {
      console.log("Failed to parse THREADS_COOKIE as JSON, trying as raw string...");
      const parts = rawCookie
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);

      const cookies = [];
      for (const part of parts) {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) continue;
        const name = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();
        if (!name) continue;
        cookies.push({ name, value, domain: ".threads.net", path: "/" });
      }

      if (cookies.length > 0) {
        await context.addCookies(cookies);
      } else {
        await context.addCookies([{ name: "sessionid", value: rawCookie, domain: ".threads.net", path: "/" }]);
      }
    }
  }

  const page = await context.newPage();
  // Forward browser console messages to CI logs so we can see runtime client errors
  page.on("console", (msg) => {
    try {
      console.log(`[page:${msg.type()}] ${msg.text()}`);
    } catch (err) {
      console.log(`[page:console] <unserializable console message>`);
    }
  });

  let trendingKeywords = [];
  let debugPayloads = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/api/graphql") && response.status() === 200) {
      try {
        const text = await response.text();
        const parts = text.split("\n");
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const data = JSON.parse(part);
            const strData = JSON.stringify(data);

            if (strData.includes("trending") || strData.includes("Barcelona")) {
              debugPayloads.push({ url, snippet: strData.slice(0, 2000) }); // keep small snippet only
            }

            if (strData.includes("trending_topic") || strData.includes("BarcelonaSearchTrendingTopicsSectionQuery")) {
              console.log("Found trending topic payload in network request!");
              collectKeywordsFromObject(data, trendingKeywords);
            }
          } catch (e) {
            // ignore malformed JSON fragments
          }
        }
      } catch (e) {
        // ignore response parsing issues
      }
    }
  });

  try {
    await page.goto("https://www.threads.net/search", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(5000);

    const html = await page.content();

    // Print truncated HTML and network payloads to CI logs (no files, no secrets)
    const truncatedHtml = typeof html === 'string' && html.length > MAX_LOG_CHARS ? html.slice(0, MAX_LOG_CHARS) + `\n... (truncated ${html.length - MAX_LOG_CHARS} chars)` : html;

    console.log('===DEBUG HTML START===');
    console.log(truncatedHtml);
    console.log('===DEBUG HTML END===');

    console.log('===DEBUG NETWORK PAYLOADS START===');
    try {
      const payloadString = JSON.stringify(debugPayloads, null, 2);
      const truncatedPayload = payloadString.length > MAX_LOG_CHARS ? payloadString.slice(0, MAX_LOG_CHARS) + `\n... (truncated ${payloadString.length - MAX_LOG_CHARS} chars)` : payloadString;
      console.log(truncatedPayload || '(none)');
    } catch (e) {
      console.log('(unable to stringify debug payloads)');
    }
    console.log('===DEBUG NETWORK PAYLOADS END===');

    // Print cookies metadata only (NO cookie values)
    try {
      const ctxCookies = await context.cookies();
      const cookiesMeta = ctxCookies.map(c => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }));
      console.log('===COOKIE METADATA START===');
      console.log(JSON.stringify(cookiesMeta, null, 2));
      console.log('===COOKIE METADATA END===');
    } catch (e) {
      console.log('Unable to read cookies metadata');
    }

    const htmlKeywords = extractKeywordsFromHtml(html);
    for (const item of htmlKeywords) {
      addKeyword(trendingKeywords, item);
    }

    const unique = [...new Set(trendingKeywords)]
      .filter((keyword) => isLikelyKeyword(keyword))
      .slice(0, 15);

    console.log(`Extracted keywords: ${unique.join(", ") || "(none)"}`);
    return unique.length > 0 ? unique : [];
  } catch (e) {
    console.error("Failed to extract trending keywords", e);
    return [];
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  const keywords = await getTrendingKeywords(browser);

  const result = {
    fetchedAt: new Date().toISOString(),
    keywords,
    total_posts: 0,
    items: []
  };

  const indexPayload = {
    generatedAt: new Date().toISOString(),
    categories: [
      {
        preset: "Trending Now",
        path: "data/trending/threads_now.json",
        total: keywords.length,
        fetchedAt: result.fetchedAt
      }
    ]
  };

  await mkdir("data/trending", { recursive: true });
  await writeFile("data/trending/threads_now.json", JSON.stringify(result, null, 2), "utf8");
  await writeFile("data/index.json", JSON.stringify(indexPayload, null, 2), "utf8");

  console.log(`\n✓ wrote data/index.json and data/trending/threads_now.json`);
  await browser.close();
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
