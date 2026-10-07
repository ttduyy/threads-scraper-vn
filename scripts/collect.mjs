import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAX_LOG_CHARS = 100000;

console.log(`Starting Threads Dynamic Trending Scraper`);

function normalizeKeyword(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/^[\s"'`]+|[\s"'`]+$/g, "").trim();
}

function isHexColor(value) {
  const v = normalizeKeyword(value).replace(/^#/, "");
  return /^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v);
}

function isLikelyTopic(value) {
  const keyword = normalizeKeyword(value);
  if (!keyword || keyword.length < 2 || keyword.length > 80) return false;
  if (!/[A-Za-z]/.test(keyword)) return false;
  if (isHexColor(keyword)) return false;
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
    "trending",
    "selfxss",
    "permissions-policy",
    "document",
    "html",
    "javascript",
    "console"
  ];

  return !blocked.some((item) => lower === item || lower.includes(item));
}

function addTopic(list, value) {
  const keyword = normalizeKeyword(value);
  if (!keyword || !isLikelyTopic(keyword)) return;
  if (!list.includes(keyword)) list.push(keyword);
}

function walkObjectForTopics(value, topics) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) walkObjectForTopics(item, topics);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const keyLower = String(key).toLowerCase();
    const shouldCheckKey = [
      "query",
      "keyword",
      "name",
      "title",
      "text",
      "label",
      "topic",
      "topic_name",
      "hashtag",
      "term",
      "search_term",
      "trending"
    ].includes(keyLower) || keyLower.includes("trending") || keyLower.includes("topic") || keyLower.includes("search");

    if (typeof item === "string" && shouldCheckKey) {
      addTopic(topics, item);
    } else if (typeof item === "string" && /trending|topic|search|hashtag|keyword/i.test(item)) {
      addTopic(topics, item);
    }

    walkObjectForTopics(item, topics);
  }
}

function extractFromJsonPayload(payload, topics) {
  try {
    walkObjectForTopics(payload, topics);
  } catch (e) {
    // ignore malformed structures
  }
}

function extractKeywordsFromHtml(html) {
  const topics = [];

  const jsonBlocks = [
    ...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi),
    ...html.matchAll(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)
  ];

  for (const [, scriptBody] of jsonBlocks) {
    if (!scriptBody) continue;
    try {
      const parsed = JSON.parse(scriptBody);
      extractFromJsonPayload(parsed, topics);
    } catch {
      // ignore non-JSON script blocks
    }
  }

  return [...new Set(topics)].filter((word) => word && word.length > 1).slice(0, 15);
}

async function getTrendingKeywords(browser) {
  console.log("Navigating to https://www.threads.net/search to extract Trending topics...");

  const storageBase64 = process.env.THREADS_STORAGE_STATE_BASE64;
  const storagePath = "auth/threads-session.json";
  const contextOptions = {
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    locale: "vi-VN"
  };

  if (storageBase64) {
    console.log("Found THREADS_STORAGE_STATE_BASE64; creating temporary browser session state...");
    await mkdir("auth", { recursive: true });
    const decoded = Buffer.from(storageBase64, "base64").toString("utf8");
    await writeFile(storagePath, decoded, "utf8");
    contextOptions.storageState = storagePath;
  }

  const context = await browser.newContext(contextOptions);

  const rawCookie = process.env.THREADS_COOKIE;
  if (!contextOptions.storageState && rawCookie) {
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
  page.on("console", (msg) => {
    try {
      console.log(`[page:${msg.type()}] ${msg.text()}`);
    } catch {
      console.log(`[page:console] <unserializable message>`);
    }
  });

  const trendingKeywords = [];
  const debugPayloads = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/graphql") || response.status() !== 200) return;

    try {
      const text = await response.text();
      const chunks = text.split("\n").map((p) => p.trim()).filter(Boolean);
      for (const chunk of chunks) {
        try {
          const data = JSON.parse(chunk);
          const dataText = JSON.stringify(data);

          if (!/trending|topic|search/i.test(dataText)) continue;
          debugPayloads.push({ url, snippet: dataText.slice(0, 2000) });
          extractFromJsonPayload(data, trendingKeywords);
        } catch {
          // ignore malformed JSON fragments
        }
      }
    } catch {
      // ignore response parse errors
    }
  });

  try {
    await page.goto("https://www.threads.net/search", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(5000);

    const html = await page.content();
    const truncatedHtml = html.length > MAX_LOG_CHARS ? html.slice(0, MAX_LOG_CHARS) + `\n... (truncated ${html.length - MAX_LOG_CHARS} chars)` : html;

    console.log("===DEBUG HTML START===");
    console.log(truncatedHtml);
    console.log("===DEBUG HTML END===");

    console.log("===DEBUG GRAPHQL PAYLOADS START===");
    const payloadString = JSON.stringify(debugPayloads, null, 2);
    const truncatedPayload = payloadString.length > MAX_LOG_CHARS ? payloadString.slice(0, MAX_LOG_CHARS) + `\n... (truncated ${payloadString.length - MAX_LOG_CHARS} chars)` : payloadString;
    console.log(truncatedPayload || "(none)");
    console.log("===DEBUG GRAPHQL PAYLOADS END===");

    const htmlKeywords = extractKeywordsFromHtml(html);
    for (const item of htmlKeywords) addTopic(trendingKeywords, item);

    const unique = [...new Set(trendingKeywords)]
      .filter((keyword) => isLikelyTopic(keyword))
      .slice(0, 15);

    console.log(`Extracted keywords: ${unique.join(", ") || "(none)"}`);
    return unique;
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

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
