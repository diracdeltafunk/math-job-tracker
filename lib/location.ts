const US_STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};

const US_COUNTRIES = new Set(["united states", "united states of america", "usa", "u.s.", "u.s.a."]);

export function normalizeLocation(value: unknown) {
  if (typeof value !== "string") return "";
  const pieces = value
    .replace(/\b\d{4,6}(?:-\d{4})?\b/g, "")
    .split(",")
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!pieces.length) return "";
  const country = pieces.at(-1)?.toLowerCase() ?? "";
  if (US_COUNTRIES.has(country)) pieces.pop();
  for (let index = 0; index < pieces.length; index += 1) {
    const state = Object.keys(US_STATES).find((name) => name.toLowerCase() === pieces[index].toLowerCase());
    if (state) pieces[index] = US_STATES[state];
  }
  return pieces.join(", ").replace(/,\s*,/g, ",").trim();
}
