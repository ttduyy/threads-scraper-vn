import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const PER_KEYWORD = Number(process.env.PER_KEYWORD || "10");
const SEARCH_DELAY_MS = Number(process.env.SEARCH_DELAY_MS || "2000");

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

console.log(`Starting Threads Dynamic Trending Scraper`);

// ==================== 1. Get Trending Keywords from /search ====================
async function getTrendingKeywords(browser) {
  console.log("Navigating to https://www.threads.net/search to extract Trending topics...");
  const page = await browser.newPage({ userAgent: MOBILE_UA, viewport: { width: 390, height: 844 } });
  try {
    await page.goto("https://www.threads.net/search", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(3000);
    
    // Scroll a bit
    try { await page.evaluate(() => window.scrollBy(0, 800)); } catch {}
    await page.waitForTimeout(1000);
    
    // Extract keywords
    const keywords = await page.evaluate(() => {
      // Look for search links
      const links = Array.from(document.querySelectorAll('a[href*="/search?q="]'));
      let kws = links.map(a => {
        const url = new URL(a.href, "https://www.threads.net");
        return url.searchParams.get("q");
      }).filter(Boolean);
      
      // If no search links, fallback to extracting text from common span elements
      if (kws.length === 0) {
        kws = Array.from(document.querySelectorAll('span[dir="auto"], div[dir="auto"]'))
          .map(el => el.innerText.trim())
          .filter(t => t.length > 2 && t.length < 40 && !t.includes("Follow") && !t.includes("Search"));
      }
      
      // Unique
      return [...new Set(kws)].slice(0, 10); // Take top 10 trends
    });
    
    console.log(`Extracted keywords: ${keywords.join(", ")}`);
    return keywords.length > 0 ? keywords : ["Tin nóng", "Giải trí", "Âm nhạc", "Thể thao"]; // fallback
  } catch (e) {
    console.error("Failed to extract trending keywords", e);
    return ["Tin nóng", "Giải trí", "Âm nhạc", "Thể thao"]; // fallback
  } finally {
    await page.close();
  }
}

// ==================== 2. Search Keyword and scrape posts ====================
async function searchKeyword(browser, keyword, limit = 10) {
  const url = `https://www.threads.net/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
  const page = await browser.newPage({ userAgent: MOBILE_UA, viewport: { width: 390, height: 844 } });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    try { await page.waitForSelector('a[href*="/post/"]', { timeout: 5000 }); } catch {}
    try { await page.evaluate(() => window.scrollBy(0, 800)); } catch {}
    await page.waitForTimeout(800);
    
    const posts = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('a[href*="/post/"]');
      for (const a of anchors) {
        const href = a.href;
        const m = href.match(/threads\.(?:net|com)\/(@[^\/]+)\/post\/([A-Za-z0-9_-]+)/);
        if (!m) continue;
        const username = m[1], code = m[2];
        if (seen.has(code)) continue;
        seen.add(code);
        let card = a;
        for (let i = 0; i < 8 && card; i++) {
          if (card.matches && card.matches('div[role="article"], article, div[data-pressable-container]')) break;
          card = card.parentElement;
        }
        const container = card || a.parentElement;
        const text = ((container && container.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 800);
        
        // Count rough metrics from DOM if available (like "100 replies", etc)
        // Usually Threads DOM doesn't show metrics easily in search, but we default to 0
        
        out.push({
          id: code, 
          username,
          permalink: href.split('?')[0],
          text,
          like_count: 0,
          reply_count: 0,
          repost_count: 0,
        });
      }
      return out;
    });
    return posts.slice(0, limit);
  } finally {
    await page.close();
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== Main ====================
async function main() {
  const browser = await chromium.launch({ headless: true });
  
  // 1. Get dynamic keywords
  const keywords = await getTrendingKeywords(browser);
  
  const allPosts = [];
  const seenPosts = new Set();
  
  // 2. Scrape each keyword
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    console.log(`\n→ Searching: ${kw}`);
    try {
      const posts = await searchKeyword(browser, kw, PER_KEYWORD);
      let added = 0;
      for (const p of posts) {
        if (!seenPosts.has(p.id)) {
          seenPosts.add(p.id);
          allPosts.push({ ...p, _keyword: kw });
          added++;
        }
      }
      console.log(`  Found ${posts.length} posts, ${added} new.`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
    if (i < keywords.length - 1) await sleep(SEARCH_DELAY_MS);
  }
  
  // 3. Save to a single file
  const result = {
    fetchedAt: new Date().toISOString(),
    keywords: keywords,
    total_posts: allPosts.length,
    items: allPosts
  };
  
  // Create an index.json with path to the file so TramSong can fetch it easily
  const indexPayload = {
    generatedAt: new Date().toISOString(),
    categories: [
      {
        preset: "Trending Now",
        path: "data/trending/threads_now.json",
        total: allPosts.length,
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
