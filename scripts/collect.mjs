// hottam-threads-data collector
// 6h cron — 19 카테고리 검색 → playwright DOM scrape → JSON commit
// Meta keyword_search 가 dev mode 에서 빈 결과 반환 → threads.net 공개 검색 페이지 직접 scrape 로 전환 (2026-05-01)

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { KEYWORD_PRESETS, PRESET_NAMES } from "./keywords.mjs";

// 환경변수 PRESETS="A,B,C" 로 override, 없으면 전체.
const ARG_PRESETS = process.env.PRESETS?.split(",").map(s => s.trim()).filter(Boolean);
const SELECTED = ARG_PRESETS?.length ? ARG_PRESETS : PRESET_NAMES;
const PER_KEYWORD = Number(process.env.PER_KEYWORD || "10");
const ENRICH = process.env.ENRICH === "1";  // 좋아요/댓글 정확 메트릭 — 시간 많이 듦, 기본 OFF
const MAX_ENRICH_PER_CAT = Number(process.env.MAX_ENRICH_PER_CAT || "10");
const ENRICH_CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || "3");
const SEARCH_DELAY_MS = Number(process.env.SEARCH_DELAY_MS || "2000");  // 키워드 간 간격

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

console.log(`Collecting ${SELECTED.length} categories: ${SELECTED.join(", ")}`);
console.log(`PER_KEYWORD=${PER_KEYWORD}, ENRICH=${ENRICH}, SEARCH_DELAY_MS=${SEARCH_DELAY_MS}`);

// ==================== threads.net 검색 페이지 직접 scrape ====================
async function searchKeyword(browser, keyword, type = "TOP", limit = 10) {
  const sortParam = type === "RECENT" ? "&sort_type=recent" : "";
  const url = `https://www.threads.net/search?q=${encodeURIComponent(keyword)}&serp_type=default${sortParam}`;
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
        // 프로필 사진 vs 첨부 이미지 분리
        const allImgs = Array.from(container?.querySelectorAll('img') || []);
        let profilePic = null;
        const mediaImages = [];
        for (const img of allImgs) {
          const src = img.src || img.getAttribute('data-src') || '';
          if (!src) continue;
          const isNotMedia =
            /\/t51\.\d+-19\//.test(src) ||
            /profile_pic/.test(src) ||
            /_s150x150/.test(src) || /_s320x320/.test(src) ||
            /\/rsrc\.php\//.test(src) ||
            /static\.cdninstagram\.com\/rsrc/.test(src) ||
            /static\.threads\.(net|com)/.test(src);
          if (isNotMedia && !profilePic && /\/t51\.\d+-19\//.test(src)) profilePic = src;
          else if (!isNotMedia) mediaImages.push(src);
        }
        const videos = Array.from(container?.querySelectorAll('video') || []);
        out.push({
          id: code, username,
          permalink: href.split('?')[0],
          text,
          has_image: mediaImages.length > 0,
          has_video: videos.length > 0,
          thumbnail_url: profilePic,
          media_images: mediaImages.slice(0, 4),
          video_url: videos[0]?.src || null,
          video_poster: videos[0]?.poster || null,
        });
      }
      return out;
    });
    return posts.slice(0, limit);
  } finally {
    await page.close();
  }
}

// ==================== Enrich (옵션) — 게시물 페이지 SSR 메트릭 추출 ====================
function findMetrics(obj, target) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { for (const v of obj) findMetrics(v, target); return; }
  const pickInt = (v) => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string") { const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.floor(n); }
    return null;
  };
  const like = pickInt(obj.like_count) ?? pickInt(obj.likes);
  if (like !== null && like > target.like) target.like = like;
  const reply = pickInt(obj.reply_count) ?? pickInt(obj.comment_count) ?? pickInt(obj.replies);
  if (reply !== null && reply > target.reply) target.reply = reply;
  const repost = pickInt(obj.repost_count) ?? pickInt(obj.reposts);
  if (repost !== null && repost > target.repost) target.repost = repost;
  const quote = pickInt(obj.quote_count) ?? pickInt(obj.quotes);
  if (quote !== null && quote > target.quote) target.quote = quote;
  const view = pickInt(obj.view_count) ?? pickInt(obj.video_view_count) ?? pickInt(obj.views);
  if (view !== null && view > target.view) target.view = view;
  for (const v of Object.values(obj)) findMetrics(v, target);
}

async function enrichOne(browser, post) {
  const page = await browser.newPage({ userAgent: MOBILE_UA });
  try {
    await page.goto(post.permalink, { waitUntil: "networkidle", timeout: 20000 });
    const blobs = await page.$$eval("script[data-sjs]", (els) => els.map(el => el.textContent || ""));
    const target = { like: 0, reply: 0, repost: 0, quote: 0, view: 0 };
    for (const blob of blobs) {
      if (!blob) continue;
      try { findMetrics(JSON.parse(blob), target); } catch {}
    }
    return {
      id: post.id,
      like_count: target.like, reply_count: target.reply, repost_count: target.repost,
      quote_count: target.quote, view_count: target.view,
      fetched_at: Date.now(), source: "scraped",
    };
  } catch (e) {
    return {
      id: post.id, like_count: 0, reply_count: 0, repost_count: 0, quote_count: 0, view_count: 0,
      fetched_at: Date.now(), source: "failed", _err: String(e).slice(0, 200),
    };
  } finally {
    await page.close();
  }
}

async function enrichBatch(browser, posts, concurrency = 3) {
  const out = [];
  for (let i = 0; i < posts.length; i += concurrency) {
    const slice = posts.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(p => enrichOne(browser, p)));
    out.push(...results);
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== Per-category collect ====================
async function collectCategory(browser, presetName) {
  const keywords = KEYWORD_PRESETS[presetName];
  if (!keywords) { console.warn(`unknown preset: ${presetName}`); return null; }
  const seen = new Set();
  const all = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    try {
      const posts = await searchKeyword(browser, kw, "TOP", PER_KEYWORD);
      let added = 0;
      for (const p of posts) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        all.push({ ...p, _keyword: kw });
        added++;
      }
      console.log(`    '${kw}' → ${posts.length} found, ${added} new`);
    } catch (e) {
      console.warn(`    keyword '${kw}' failed: ${e.message}`);
    }
    if (i < keywords.length - 1) await sleep(SEARCH_DELAY_MS);
  }
  console.log(`  [${presetName}] ${all.length} unique posts collected`);

  let enriched = all;
  let summary = { total: all.length, enriched: 0, failed: 0 };
  if (ENRICH) {
    const enrichable = all.filter(p => p.permalink).slice(0, MAX_ENRICH_PER_CAT);
    const metrics = await enrichBatch(browser, enrichable, ENRICH_CONCURRENCY);
    const byId = Object.fromEntries(metrics.map(m => [m.id, m]));
    enriched = all.map(p => byId[p.id] ? { ...p, _metrics: byId[p.id] } : p);
    summary = {
      total: enriched.length,
      enriched: metrics.filter(m => m.source === "scraped").length,
      failed: metrics.filter(m => m.source === "failed").length,
    };
  }
  return {
    preset: presetName,
    keywords,
    fetchedAt: new Date().toISOString(),
    items: enriched,
    summary,
  };
}

// ==================== Main ====================
async function main() {
  const browser = await chromium.launch({ headless: true });
  const indexPayload = { generatedAt: new Date().toISOString(), categories: [] };
  for (const presetName of SELECTED) {
    console.log(`\n→ ${presetName}`);
    try {
      const result = await collectCategory(browser, presetName);
      if (!result) continue;
      const slug = encodeURIComponent(presetName).replace(/%/g, "_");
      const path = `data/trending/${slug}.json`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(result, null, 2), "utf8");
      console.log(`  → wrote ${path} (${result.items.length} items, ${result.summary.enriched} enriched)`);
      indexPayload.categories.push({
        preset: presetName,
        slug,
        path,
        ...result.summary,
        fetchedAt: result.fetchedAt,
      });
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      indexPayload.categories.push({ preset: presetName, error: e.message });
    }
  }
  await mkdir("data", { recursive: true });
  await writeFile("data/index.json", JSON.stringify(indexPayload, null, 2), "utf8");
  console.log(`\n✓ wrote data/index.json (${indexPayload.categories.length} categories)`);
  await browser.close();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
