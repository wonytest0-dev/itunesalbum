require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const COUNTRY = require("./lib/country.json");
const { fetchAllCountries, findChartRanksCustom } = require("./lib/scraper");

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN is not set in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

let cachedChartData = null;
let cacheTime = 0;
let loadingPromise = null;

const CACHE_TTL = 60 * 60 * 1000;

const EXTENDED_TOP_REGIONS = new Set([
  "Germany",
  "Brazil",
  "United States",
  "United Kingdom",
  "Canada",
  "France",
  "Australia",
  "Japan",
]);

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

function getCountryMeta(countryName) {
  const data = COUNTRY[countryName];

  if (!data) {
    return { name: countryName, flag: "" };
  }

  if (countryName === "Worldwide") {
    return { name: data.name || countryName, flag: "🌐" };
  }

  const flag = String(data.code || "")
    .toUpperCase()
    .split("")
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");

  return {
    name: data.name || countryName,
    flag,
  };
}

async function getChartData() {
  const now = Date.now();

  if (cachedChartData && now - cacheTime < CACHE_TTL) {
    log("⚡ Using cached chart data");
    return cachedChartData;
  }

  if (loadingPromise) {
    log("⏳ Waiting for the current fetch process...");
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      log("🚀 Starting fetch for all countries...");
      const start = Date.now();

      const data = await fetchAllCountries(10);

      const success = data.filter((x) => x.success).length;
      const failed = data.length - success;

      log(`✅ Fetch completed | success: ${success} | failed: ${failed}`);
      log(`⏱ Duration: ${(Date.now() - start) / 1000}s`);

      cachedChartData = data;
      cacheTime = Date.now();

      return data;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

function formatResults(query, results) {
  if (!results.length) {
    return `🎵 ${query}\n\nNo results found for the selected country filters.`;
  }

  const mainRegions = [];
  const otherRegions = [];

  for (const item of results) {
    if (EXTENDED_TOP_REGIONS.has(item.countryName)) {
      mainRegions.push(item);
    } else {
      otherRegions.push(item);
    }
  }

  mainRegions.sort((a, b) => a.rank - b.rank || a.countryName.localeCompare(b.countryName));
  otherRegions.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.countryName.localeCompare(b.countryName);
  });

  const bestMatch = results[0];
  const rank1Count = results.filter((item) => item.rank === 1).length;
  const totalCount = results.length;

  const lines = [
    `🎵 Title: ${bestMatch.title || query}`,
    `👤 Artist: ${bestMatch.artist || "-"}`,
    "",
    `#1 in ${rank1Count} countr${rank1Count === 1 ? "y" : "ies"}`,
    `Found in ${totalCount} countr${totalCount === 1 ? "y" : "ies"}`,
    ""
  ];

  if (mainRegions.length) {
    lines.push("🌍 Main Regions (Top 100)");
    for (const item of mainRegions) {
      const meta = getCountryMeta(item.countryName);
      const label = meta.flag ? `${meta.name} ${meta.flag}` : meta.name;
      lines.push(`${label} — #${item.rank}`);
    }
    lines.push("");
  }

  if (otherRegions.length) {
    lines.push("🏁 Other Regions (#1 only)");
    for (const item of otherRegions) {
      const meta = getCountryMeta(item.countryName);
      const label = meta.flag ? `${meta.name} ${meta.flag}` : meta.name;
      lines.push(`${label} — #${item.rank}`);
    }
  }

  return lines.join("\n").trim();
}

function splitMessage(text, maxLength = 3500) {
  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  log(`👤 User started bot: ${chatId}`);

  const text = [
    "Hello, send a song title or artist name directly.",
    "",
    "Active filters:",
    "- regular countries: #1 only",
    "- Germany, Brazil, United States, United Kingdom, Canada, France, Australia, Japan: Top 100",
  ].join("\n");

  await bot.sendMessage(chatId, text);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!text || text.startsWith("/")) return;

  log(`🔍 Query from ${chatId}: "${text}"`);

  try {
    const progressMessage = await bot.sendMessage(
      chatId,
      "⏳ Please wait, searching chart data..."
    );

    const allChartData = await getChartData();

    log("🔎 Starting title/artist filtering...");
    const startSearch = Date.now();
    const results = findChartRanksCustom(allChartData, text, {
      extendedTopRegions: EXTENDED_TOP_REGIONS,
      defaultTopLimit: 1,
      extendedTopLimit: 100,
      exact: false,
      firstOnly: true,
    });

    log(
      `✅ Filter completed | found: ${results.length} countries | duration: ${
        Date.now() - startSearch
      }ms`
    );

    const message = formatResults(text, results);
    const chunks = splitMessage(message);

    try {
      await bot.deleteMessage(chatId, String(progressMessage.message_id));
    } catch (_) {}

    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (error) {
    console.error("❌ Error:", error);

    await bot.sendMessage(
      chatId,
      `An error occurred while searching the chart data.\n${error.message}`
    );
  }
});

log("🤖 Telegram bot is running...");