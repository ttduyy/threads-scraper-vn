import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

console.log(`Starting Threads Dynamic Trending Scraper`);

async function getTrendingKeywords(browser) {
  console.log("Navigating to https://www.threads.net/search to extract Trending topics...");
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    locale: 'vi-VN'
  });

  const rawCookie = process.env.THREADS_COOKIE;
  if (rawCookie) {
    console.log("Found THREADS_COOKIE, injecting into context...");
    try {
      const parsedCookies = JSON.parse(rawCookie);
      await context.addCookies(parsedCookies);
    } catch (e) {
      console.log("Failed to parse THREADS_COOKIE as JSON, trying as raw string...");
      // Hỗ trợ truyền sessionid trực tiếp (rất phổ biến)
      if (rawCookie.includes("=")) {
        const parts = rawCookie.split(";").map(p => p.trim()).filter(Boolean);
        const cookies = parts.map(p => {
          const [name, ...val] = p.split("=");
          return { name, value: val.join("="), domain: ".threads.net", path: "/" };
        });
        await context.addCookies(cookies);
      } else {
        await context.addCookies([{ name: "sessionid", value: rawCookie, domain: ".threads.net", path: "/" }]);
      }
    }
  }

  const page = await context.newPage();
  
  let trendingKeywords = [];
  let debugPayloads = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/graphql') && response.status() === 200) {
      try {
        const text = await response.text();
        const parts = text.split('\n');
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const data = JSON.parse(part);
            const strData = JSON.stringify(data);
            
            if (strData.includes("trending") || strData.includes("Barcelona")) {
               debugPayloads.push(data);
            }
            
            if (strData.includes("trending_topic") || strData.includes("BarcelonaSearchTrendingTopicsSectionQuery")) {
               console.log("Found trending topic payload in network request!");
               const matches = [...strData.matchAll(/"query":"([^"]+)"/g)];
               if (matches.length > 0) {
                 for (const match of matches) {
                   const kw = match[1];
                   if (kw && kw.length > 2 && !trendingKeywords.includes(kw)) {
                     trendingKeywords.push(kw);
                   }
                 }
               }
               // Try an alternative match just in case
               const matches2 = [...strData.matchAll(/"keyword":"([^"]+)"/g)];
               for (const match of matches2) {
                 const kw = match[1];
                 if (kw && kw.length > 2 && !trendingKeywords.includes(kw)) {
                   trendingKeywords.push(kw);
                 }
               }
            }
          } catch(e) {}
        }
      } catch (e) {}
    }
  });

  try {
    await page.goto("https://www.threads.net/search", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(5000); 
    
    const html = await page.content();
    await writeFile("debug.html", html, "utf8");
    await writeFile("debug.json", JSON.stringify(debugPayloads, null, 2), "utf8");
    
    if (trendingKeywords.length === 0) {
      console.log("Network interception found nothing, checking preloaded HTML state...");
      const matches = [...html.matchAll(/"query":"([^"]+)"/g)];
      for (const match of matches) {
        const kw = match[1];
        if (kw && kw.length > 2 && kw.length < 50 && !trendingKeywords.includes(kw) && !kw.includes("{")) {
           trendingKeywords.push(kw);
        }
      }
    }
    
    const unique = [...new Set(trendingKeywords)].filter(k => 
      !k.includes("Follow") && !k.includes("Search") && !k.includes("Threads") && !k.includes("Terms") && !k.includes("Policy")
    ).slice(0, 15);
    
    console.log(`Extracted keywords: ${unique.join(", ")}`);
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
    keywords: keywords,
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

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
