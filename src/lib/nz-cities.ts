export interface NZCity {
  name: string;
  keywords: string[]; // all names / aliases for this city
  lat: number;
  lng: number;
}

// Coordinates for major NZ cities and towns
export const NZ_CITIES: NZCity[] = [
  // --- Northland ---
  { name: "Whangārei",     keywords: ["whangarei", "whangārei"],                                   lat: -35.7275, lng: 174.3166 },
  { name: "Kerikeri",      keywords: ["kerikeri"],                                                 lat: -35.2239, lng: 173.9486 },
  { name: "Kaitāia",       keywords: ["kaitaia", "kaitāia"],                                       lat: -35.1127, lng: 173.2667 },
  { name: "Dargaville",    keywords: ["dargaville"],                                               lat: -35.9350, lng: 173.8866 },

  // --- Auckland metro ---
  { name: "Auckland",      keywords: ["auckland", "tāmaki makaurau", "tamaki makaurau", "tāmaki", "tamaki"], lat: -36.8509, lng: 174.7645 },
  { name: "North Shore",   keywords: ["north shore", "takapuna", "devonport"],                     lat: -36.7908, lng: 174.7560 },
  { name: "Waitākere",     keywords: ["waitakere", "waitākere", "henderson", "west auckland"],     lat: -36.8882, lng: 174.6455 },
  { name: "Manukau",       keywords: ["manukau", "south auckland", "otara"],                       lat: -36.9931, lng: 174.8792 },
  { name: "Papakura",      keywords: ["papakura"],                                                 lat: -37.0645, lng: 174.9443 },
  { name: "Pukekohe",      keywords: ["pukekohe"],                                                 lat: -37.2021, lng: 174.9014 },

  // --- Waikato ---
  { name: "Hamilton",      keywords: ["hamilton", "kirikiriroa"],                                  lat: -37.7870, lng: 175.2793 },
  { name: "Cambridge",     keywords: ["cambridge", "kemureti"],                                    lat: -37.8879, lng: 175.4698 },
  { name: "Te Awamutu",    keywords: ["te awamutu"],                                               lat: -38.0109, lng: 175.3290 },
  { name: "Raglan",        keywords: ["raglan", "whāingaroa", "whaingaroa"],                       lat: -37.8004, lng: 174.8789 },
  { name: "Thames",        keywords: ["thames"],                                                   lat: -37.1394, lng: 175.5431 },
  { name: "Paeroa",        keywords: ["paeroa"],                                                   lat: -37.3779, lng: 175.6726 },
  { name: "Tokoroa",       keywords: ["tokoroa"],                                                  lat: -38.2265, lng: 175.8700 },

  // --- Bay of Plenty ---
  { name: "Tauranga",      keywords: ["tauranga"],                                                 lat: -37.6878, lng: 176.1651 },
  { name: "Mount Maunganui", keywords: ["mount maunganui", "mt maunganui", "the mount"],          lat: -37.6392, lng: 176.1892 },
  { name: "Rotorua",       keywords: ["rotorua"],                                                  lat: -38.1368, lng: 176.2497 },
  { name: "Whakatāne",     keywords: ["whakatane", "whakatāne"],                                   lat: -37.9527, lng: 176.9902 },
  { name: "Taupō",         keywords: ["taupo", "taupō", "tapuaeharuru"],                           lat: -38.6857, lng: 176.0702 },

  // --- Gisborne ---
  { name: "Gisborne",      keywords: ["gisborne", "tūranganui-a-kiwa", "turanganui-a-kiwa", "turanga", "tūranga"], lat: -38.6623, lng: 178.0176 },

  // --- Hawke's Bay ---
  { name: "Napier",        keywords: ["napier", "ahuriri"],                                        lat: -39.4928, lng: 176.9120 },
  { name: "Hastings",      keywords: ["hastings", "heretaunga"],                                   lat: -39.6383, lng: 176.8383 },
  { name: "Havelock North",keywords: ["havelock north"],                                           lat: -39.6640, lng: 176.8828 },
  { name: "Wairoa",        keywords: ["wairoa"],                                                   lat: -39.0362, lng: 177.4127 },

  // --- Taranaki ---
  { name: "New Plymouth",  keywords: ["new plymouth", "ngāmotu", "ngamotu"],                       lat: -39.0556, lng: 174.0752 },
  { name: "Inglewood",     keywords: ["inglewood"],                                                lat: -39.1447, lng: 174.1785 },
  { name: "Stratford",     keywords: ["stratford"],                                                lat: -39.3330, lng: 174.2836 },

  // --- Manawatū-Whanganui ---
  { name: "Palmerston North", keywords: ["palmerston north", "palmy", "te papaioea"],              lat: -40.3523, lng: 175.6082 },
  { name: "Feilding",      keywords: ["feilding"],                                                 lat: -40.2240, lng: 175.5656 },
  { name: "Levin",         keywords: ["levin", "taitoko"],                                         lat: -40.6218, lng: 175.2766 },
  { name: "Whanganui",     keywords: ["whanganui", "wanganui"],                                    lat: -39.9305, lng: 175.0501 },

  // --- Wellington region ---
  { name: "Wellington",    keywords: ["wellington", "pōneke", "poneke", "te whanganui-a-tara", "te whanganui a tara"], lat: -41.2866, lng: 174.7756 },
  { name: "Lower Hutt",    keywords: ["lower hutt", "hutt", "te awa kairangi", "hutt city"],       lat: -41.2127, lng: 174.9081 },
  { name: "Upper Hutt",    keywords: ["upper hutt", "te awa kairangi ki uta"],                     lat: -41.1243, lng: 175.0536 },
  { name: "Porirua",       keywords: ["porirua", "pōrirua"],                                       lat: -41.1340, lng: 174.8400 },
  { name: "Petone",        keywords: ["petone", "pētone"],                                         lat: -41.2274, lng: 174.8730 },
  { name: "Paraparaumu",   keywords: ["paraparaumu", "kapiti", "kāpiti", "kapiti coast"],          lat: -40.9140, lng: 175.0080 },
  { name: "Waikanae",      keywords: ["waikanae"],                                                 lat: -40.8760, lng: 175.0670 },
  { name: "Masterton",     keywords: ["masterton", "whakaoriori"],                                 lat: -40.9530, lng: 175.6570 },

  // --- Marlborough / Nelson ---
  { name: "Blenheim",      keywords: ["blenheim", "wairau"],                                       lat: -41.5134, lng: 173.9612 },
  { name: "Picton",        keywords: ["picton", "waitohi"],                                        lat: -41.2960, lng: 174.0020 },
  { name: "Nelson",        keywords: ["nelson", "whakatū", "whakatu"],                             lat: -41.2706, lng: 173.2840 },
  { name: "Richmond",      keywords: ["richmond"],                                                 lat: -41.3336, lng: 173.1742 },

  // --- West Coast ---
  { name: "Greymouth",     keywords: ["greymouth", "māwhera", "mawhera"],                          lat: -42.4500, lng: 171.2100 },
  { name: "Westport",      keywords: ["westport", "wētini", "wetini"],                             lat: -41.7514, lng: 171.5997 },

  // --- Canterbury ---
  { name: "Christchurch",  keywords: ["christchurch", "ōtautahi", "otautahi", "chch"],             lat: -43.5321, lng: 172.6362 },
  { name: "Rangiora",      keywords: ["rangiora"],                                                  lat: -43.3039, lng: 172.5944 },
  { name: "Kaikōura",      keywords: ["kaikoura", "kaikōura"],                                     lat: -42.4002, lng: 173.6817 },
  { name: "Ashburton",     keywords: ["ashburton", "hakatere"],                                    lat: -43.9014, lng: 171.7282 },
  { name: "Timaru",        keywords: ["timaru", "te tihi-o-maru"],                                 lat: -44.3960, lng: 171.2549 },

  // --- Otago ---
  { name: "Dunedin",       keywords: ["dunedin", "ōtepoti", "otepoti"],                            lat: -45.8788, lng: 170.5028 },
  { name: "Oamaru",        keywords: ["oamaru", "ōamaru"],                                         lat: -44.9933, lng: 171.0006 },
  { name: "Queenstown",    keywords: ["queenstown", "tāhuna", "tahuna"],                           lat: -45.0312, lng: 168.6626 },
  { name: "Wānaka",        keywords: ["wanaka", "wānaka"],                                         lat: -44.7024, lng: 169.1322 },
  { name: "Alexandra",     keywords: ["alexandra"],                                                lat: -45.2479, lng: 169.3722 },

  // --- Southland ---
  { name: "Invercargill",  keywords: ["invercargill", "waihōpai", "waihopai"],                     lat: -46.4132, lng: 168.3538 },
  { name: "Gore",          keywords: ["gore"],                                                     lat: -46.1015, lng: 168.9397 },
  { name: "Te Anau",       keywords: ["te anau", "te ana-au"],                                     lat: -45.4159, lng: 167.7197 },
];

/** Haversine distance between two points in km */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Find the best matching city for a location string */
export function getCityCoords(locationStr: string): { lat: number; lng: number; name: string } | null {
  const lower = locationStr.toLowerCase();
  for (const city of NZ_CITIES) {
    if (city.keywords.some((kw) => lower.includes(kw))) {
      return { lat: city.lat, lng: city.lng, name: city.name };
    }
  }
  return null;
}

/** Get all city keywords within radiusKm of a point */
export function getCityKeywordsWithinRadius(lat: number, lng: number, radiusKm: number): string[] {
  return NZ_CITIES.filter(
    (city) => distanceKm(lat, lng, city.lat, city.lng) <= radiusKm
  ).flatMap((city) => city.keywords);
}

/** Get city names (human readable) within radius for display */
export function getCityNamesWithinRadius(lat: number, lng: number, radiusKm: number): string[] {
  return NZ_CITIES
    .filter((city) => distanceKm(lat, lng, city.lat, city.lng) <= radiusKm)
    .map((city) => city.name);
}
