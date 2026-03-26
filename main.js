require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const COUNTRY = require("./lib/country.json");
const { fetchAllCountries, findChartRanksCustom } = require("./lib/scraper");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");


const app = express();
app.use(express.json());


const token = process.env.BOT_TOKEN;


if (!token) {
  console.error("BOT_TOKEN is not set in .env");
  process.exit(1);
}


// ✅ WEBHOOK MODE
const bot = new TelegramBot(token);


// 🔥 AUTO SET WEBHOOK (WAJIB DI RENDER)
bot.setWebHook(`${process.env.RENDER_EXTERNAL_URL}/bot${token}`);


// ✅ SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);


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


  if (!data) return { name: countryName, flag: "" };


  if (countryName === "Worldwide") {
    return { name: data.name || countryName, flag: "🌐" };
  }


  const flag = String(data.code || "")
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
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


  if (loadingPromise) return loadingPromise;


  loadingPromise = (async () => {
    try {
      log("🚀 Fetching all countries...");
      const data = await fetchAllCountries(10);


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
    return `🎵 ${query}\n\nNo results found.`;
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


  mainRegions.sort((a, b) => a.rank - b.rank);
  otherRegions.sort((a, b) => a.rank - b.rank);


  const bestMatch = results[0];
  const rank1Count = results.filter((x) => x.rank === 1).length;


  const lines = [
    `🎵 ${bestMatch.title}`,
    `👤 ${bestMatch.artist}`,
    "",
    `#1 in ${rank1Count} countries`,
    `Found in ${results.length} countries`,
    "",
  ];


  if (mainRegions.length) {
    lines.push("🌍 Main Regions");
    for (const item of mainRegions) {
      const meta = getCountryMeta(item.countryName);
      lines.push(`${meta.name} ${meta.flag} — #${item.rank}`);
    }
    lines.push("");
  }


  if (otherRegions.length) {
    lines.push("🏁 Other Regions (#1)");
    for (const item of otherRegions) {
      const meta = getCountryMeta(item.countryName);
      lines.push(`${meta.name} ${meta.flag} — #${item.rank}`);
    }
  }


  return lines.join("\n");
}


function parseQuery(input) {
  const parts = input.split(" - ").map((x) => x.trim());
  if (parts.length !== 2) return null;
  return { title: parts[0], artist: parts[1], raw: input };
}


// ✅ FIXED GWR TRACKING
async function checkAndSaveNumberOne(title, artist, results) {
  const newOnes = [];

  for (const item of results) {
    if (item.rank !== 1) continue;

    try {
      const { data } = await supabase
        .from("songs")
        .select("*")
        .eq("title", title)
        .eq("artist", artist)
        .eq("country", item.countryName);

      if (!data || data.length === 0) {
        newOnes.push(item.countryName);

        await supabase.from("songs").insert([
          {
            title,
            artist,
            country: item.countryName,
          },
        ]);
      }
    } catch (err) {
      console.error("Supabase error:", err.message);
    }
  }

  // 🔥 TOTAL LIFETIME
  const { data: totalData } = await supabase
    .from("songs")
    .select("country")
    .eq("title", title)
    .eq("artist", artist);

  const totalCountries = new Set(
    (totalData || []).map((x) => x.country)
  ).size;

  return { newOnes, totalCountries };
}


bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "Send:\nTitle - Artist\n\nExample:\nShape of You - Ed Sheeran"
  );
});


bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();


  if (!text || text.startsWith("/")) return;


  const parsed = parseQuery(text);


  if (!parsed) {
    return bot.sendMessage(chatId, "Use format:\nTitle - Artist");
  }


  try {
    const loading = await bot.sendMessage(chatId, "⏳ Searching...");


    const data = await getChartData();


    const results = findChartRanksCustom(data, parsed, {
      extendedTopRegions: EXTENDED_TOP_REGIONS,
      defaultTopLimit: 1,
      extendedTopLimit: 100,
      firstOnly: true,
    });


    const { newOnes, totalCountries } = await checkAndSaveNumberOne(
      parsed.title,
      parsed.artist,
      results
    );


    let message = formatResults(parsed.raw, results);

    // 🔥 TOTAL LIFETIME
    message += `\n\n🌍 Total #1 (lifetime): ${totalCountries} countries`;

    // 🔥 NEW LIST
    if (newOnes.length) {
      message += `\n\n🚨 NEW #1:\n${newOnes.join("\n")}`;
    }


    await bot.deleteMessage(chatId, loading.message_id);
    await bot.sendMessage(chatId, message);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error occurred.");
  }
});


// ✅ WEBHOOK ROUTE
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});


// ✅ PORT
const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log("🚀 Bot running on port", PORT);
});
