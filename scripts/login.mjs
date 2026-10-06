import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

async function loginAndSaveCookies() {
  console.log("Opening browser for you to log in...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Navigating to Threads...");
  await page.goto("https://www.threads.net/login");

  console.log("Please log in using the browser window.");
  console.log("Waiting for successful login (will detect when you reach the home page)...");

  // Wait until URL changes to the main feed, meaning login successful
  await page.waitForURL("https://www.threads.net/", { timeout: 0 });
  
  console.log("Login detected! Saving cookies...");
  const cookies = await context.cookies();
  
  await writeFile("cookies.json", JSON.stringify(cookies, null, 2));
  
  console.log("✓ Cookies saved successfully to cookies.json");
  console.log("\n--------------------------------------------------");
  console.log("IMPORTANT: Copy the entire content of cookies.json");
  console.log("and paste it into your THREADS_COOKIE secret on Github!");
  console.log("--------------------------------------------------\n");

  await browser.close();
}

loginAndSaveCookies().catch(e => {
  console.error(e);
  process.exit(1);
});
