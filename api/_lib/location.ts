// Fin — which market a person is in, read from where they say they live.
//
// Round 23, live: the market was fixed by the phone number's country code at
// the very first message (countryFromWaId), and the "Where are you based?"
// answer was only ever printed in the plan. A South African number with a
// salon in Kampala was asked for its price "for example R150" and whether it
// was registered with CIPC; a Ugandan number with a salon in Nairobi was
// asked about UGX and URSB. People move, use a relative's line, or keep a
// number from home. The phone prefix is now only the first guess, for the
// two questions before the location one; the location answer decides.
//
// Read in code, from fixed lists, never by a model: it is a lookup, and a
// wrong guess here puts every fee, registrar and tax answer in the wrong
// country. When the answer names no place on these lists, or places in two
// markets, the person is asked (engine/index.ts askMarket), never guessed for.
// A place outside the market is said to be so, honestly.
//
// Lists: each market's country names, provinces/regions/states, cities and
// the larger towns and suburbs people name. Left out on purpose: names
// shared across a border (Busia, Malaba, Namanga), two-letter towns (Ho, Wa),
// and words that are also ordinary English, a common first name or a
// surname (Delta, Rivers, Plateau, Springs, Karen, George, Kira, Alexandra,
// Newcastle, Owino), unless written with "State" or another word that makes
// them a place ("Kira town", "Owino market"). A new market adds its lists here.

/** In-market places, by market. Lower case, ASCII, words separated by one space. */
const PLACES: Record<string, string[]> = {
  ZA: [
    "south africa", "rsa", "mzansi",
    "gauteng", "western cape", "eastern cape", "northern cape", "kwazulu natal", "kzn", "limpopo", "mpumalanga", "free state",
    "johannesburg", "joburg", "jozi", "jhb", "cape town", "durban", "pretoria", "tshwane", "soweto", "sandton", "randburg", "midrand",
    "centurion", "roodepoort", "benoni", "boksburg", "germiston", "kempton park", "alberton", "vereeniging", "vanderbijlpark",
    "krugersdorp", "tembisa", "diepsloot", "katlehong", "thokoza", "vosloorus", "daveyton", "mamelodi", "soshanguve", "atteridgeville",
    "hillbrow", "braamfontein", "rosebank", "fourways", "bryanston", "khayelitsha", "mitchells plain", "gugulethu", "nyanga east",
    "bellville", "stellenbosch", "paarl", "somerset west", "umlazi", "kwamashu", "pinetown", "pietermaritzburg", "richards bay",
    "port elizabeth", "gqeberha", "east london", "mthatha", "bloemfontein", "welkom", "kimberley", "polokwane", "mbombela",
    "nelspruit", "rustenburg", "mahikeng", "mafikeng", "potchefstroom", "witbank", "emalahleni", "secunda", "knysna",
    "mossel bay", "upington", "thohoyandou", "tzaneen", "orange farm", "ekurhuleni", "brakpan", "sebokeng", "evaton",
    "ga rankuwa", "garankuwa", "mabopane", "winterveldt", "hammanskraal", "ivory park", "meadowlands", "diepkloof", "dobsonville",
    "protea glen", "lenasia", "eldorado park", "ennerdale", "kagiso", "mohlakeng", "bekkersdal", "chiawelo", "kwathema", "duduza",
    "tsakane", "ratanda", "sharpeville", "boipatong", "bophelong", "philippi", "mfuleni", "dunoon", "kraaifontein", "inanda",
    "ntuzuma", "chatsworth", "verulam", "tongaat", "mdantsane", "kwanobuhle", "zwide", "botshabelo", "thaba nchu", "seshego",
    "mankweng", "giyani", "kwamhlanga", "mamelodi east", "soshanguve south", "alexandra township", "mitchells plain",
  ],
};

/** Places outside the market: countries first, then cities people in the region often name. A second market moves its names from here into PLACES. */
const OUTSIDE: string[] = [
  "kenya", "nigeria", "ghana", "uganda", "nairobi", "mombasa", "kisumu", "nakuru", "eldoret", "lagos", "abuja", "kano", "ibadan", "port harcourt", "accra", "kumasi", "tamale", "kampala", "entebbe", "jinja", "mbarara", "gulu", "philippines", "manila", "cebu", "davao", "vietnam", "hanoi", "ho chi minh", "indonesia", "jakarta",
  "tanzania", "zambia", "zimbabwe", "rwanda", "burundi", "botswana", "namibia", "malawi", "mozambique", "ethiopia", "somalia",
  "south sudan", "sudan", "drc", "democratic republic of congo", "congo", "cameroon", "senegal", "ivory coast", "cote d ivoire",
  "cote divoire", "lesotho", "eswatini", "swaziland", "benin", "togo", "niger", "mali", "burkina faso", "sierra leone", "liberia", "guinea",
  "gambia", "egypt", "morocco", "tunisia", "algeria", "angola", "madagascar", "mauritius", "eritrea", "djibouti", "chad", "gabon",
  "uk", "united kingdom", "england", "scotland", "wales", "ireland", "usa", "united states", "america", "canada", "australia",
  "india", "pakistan", "uae", "united arab emirates", "qatar", "saudi arabia", "germany", "france", "netherlands", "china",
  "dar es salaam", "arusha", "mwanza", "dodoma", "zanzibar", "moshi", "lusaka", "ndola", "kitwe", "livingstone", "harare",
  "bulawayo", "kigali", "gaborone", "francistown", "windhoek", "lilongwe", "blantyre", "maputo", "addis ababa", "mogadishu",
  "kinshasa", "lubumbashi", "goma", "bujumbura", "juba", "khartoum", "douala", "yaounde", "dakar", "abidjan", "lome", "cotonou",
  "niamey", "bamako", "ouagadougou", "freetown", "monrovia", "conakry", "banjul", "cairo", "casablanca", "maseru", "mbabane",
  "manzini", "luanda", "london", "manchester", "birmingham", "new york", "toronto", "sydney", "dubai", "doha",
];

/** The names of the markets' own countries, for "named the country" (a firmer read than a town). */
const COUNTRY_NAMES: Record<string, string[]> = {
  ZA: ["south africa", "rsa", "mzansi"],
};

export interface MarketRead {
  /** The one market the place is in, or null when none is clear. */
  code: string | null;
  /** "country": the person named it; "place": a city, region or suburb only that market has. */
  by: "country" | "place" | null;
  /** A place outside the market, as found ("zambia", "lusaka"); only when nothing in a market was named. */
  outside: string | null;
  /** Places in two or more markets, or in a market and outside one: ask, never pick. */
  conflicting: boolean;
  /** The in-market names found, as normalised ("kampala", "uganda"). */
  places: string[];
}

/** Lower case, accents off, everything but letters and digits a single space. */
export function normalisePlace(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const has = (hay: string, name: string): boolean => ` ${hay} `.includes(` ${name} `);
/** Blanks out a matched place, so "east london" is not read again as London, nor "benin city" as Benin. */
const without = (hay: string, name: string): string => ` ${hay} `.split(` ${name} `).join("  ").trim();

/**
 * Reads where a business is. Longest names first within each list, and
 * in-market names are taken out of the text before places outside are
 * looked for. "SA" counts for South Africa only as written in capitals.
 */
export function marketFromLocation(text: string): MarketRead {
  let hay = normalisePlace(text);
  const codes = new Set<string>();
  const places: string[] = [];
  let byCountry = false;
  const longestFirst = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length);
  for (const [code, names] of Object.entries(PLACES)) {
    for (const name of longestFirst(names)) {
      if (!has(hay, name)) continue;
      codes.add(code);
      places.push(name);
      if (COUNTRY_NAMES[code]!.includes(name)) byCountry = true;
      hay = without(hay, name);
    }
  }
  if (/\bSA\b/.test(text || "")) {
    codes.add("ZA");
    byCountry = true;
  }
  const outside = longestFirst(OUTSIDE).find((name) => has(hay, name)) ?? null;
  if (codes.size === 1 && !outside) return { code: [...codes][0]!, by: byCountry ? "country" : "place", outside: null, conflicting: false, places };
  if (codes.size === 0 && outside) return { code: null, by: null, outside, conflicting: false, places };
  return { code: null, by: null, outside: null, conflicting: codes.size > 0, places };
}

/** "Uganda", "the Kenya", "South Africa." — a reply that is a market's country name and nothing else. */
export function justACountry(text: string): string | null {
  const t = normalisePlace(text).replace(/^(?:in |the |its |it s |we re in |im in )+/, "");
  return Object.entries(COUNTRY_NAMES).find(([, names]) => names.includes(t))?.[0] ?? null;
}

/** "Lusaka" → "Lusaka", for saying it back. */
export const placeName = (p: string): string => p.replace(/\b\p{L}/gu, (c) => c.toUpperCase()).replace(/\b(Uk|Usa|Uae|Drc)\b/g, (m) => m.toUpperCase());
