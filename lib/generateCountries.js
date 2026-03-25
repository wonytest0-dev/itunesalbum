const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const URL = "https://kworb.net/charts/index_a.html";

function toFlagCode(slug) {
  if (!slug) return "";

  const upper = slug.toUpperCase();

  if (upper === "UK") return "GB";
  if (upper === "WW") return "";

  return upper;
}

async function generateCountries() {
  const res = await axios.get(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const $ = cheerio.load(res.data);

  const countries = [];
  const countryMap = {};

  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;

    const name = $(tds[0]).text().replace(/\s+/g, " ").trim();
    const link = $(tds[1]).find("a").attr("href");

    if (!name || !link) return;

    if (!link.includes("/charts/aitunes/")) return;

    const match = link.match(/\/charts\/aitunes\/([a-z]+)\.html/i);
    if (!match) return;

    const slug = match[1].toLowerCase();

    if (!countries.some((item) => item.slug === slug && item.name === name)) {
      countries.push({
        slug,
        name
      });
    }

    countryMap[name] = {
      name,
      code: toFlagCode(slug)
    };
  });

  countries.sort((a, b) => a.name.localeCompare(b.name));
  const sortedCountryMap = Object.fromEntries(
    Object.entries(countryMap).sort((a, b) => a[0].localeCompare(b[0]))
  );

  fs.writeFileSync(
    "./lib/countries.json",
    JSON.stringify(countries, null, 2),
    "utf-8"
  );

  fs.writeFileSync(
    "./lib/country.json",
    JSON.stringify(sortedCountryMap, null, 2),
    "utf-8"
  );

  console.log(`✅ Generated countries.json (${countries.length} entries)`);
  console.log(`✅ Generated country.json (${Object.keys(sortedCountryMap).length} entries)`);
}

generateCountries().catch((err) => {
  console.error("❌ Failed to generate country files:", err.message);
});