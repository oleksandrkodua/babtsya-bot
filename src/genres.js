const GENRES = { court: "суд", detective: "детектив", fairy: "казка", ordinary: "звичайна" };

// Only our prefix on a successfully published plan drives the one-edition break.
export const storedGenre = (plan = "") => plan?.match(/^\[genre=(court|detective|fairy|ordinary)\]\n/)?.[1] || "ordinary";
export const genrePlan = (plan, genre) => `[genre=${genre}]\n${plan}`;

export function parseGenre(text, plan) {
  const ordinary = { genre: "ordinary", topic: "" };
  try {
    const { genre, topic } = JSON.parse(text);
    if (!Object.hasOwn(GENRES, genre) || genre === "ordinary" || typeof topic !== "string") return ordinary;
    const titles = [...plan.matchAll(/^\s*\d+\.\s+([^\n]+)$/gm)].map((m) => m[1].trim());
    return titles.includes(topic) ? { genre, topic } : ordinary;
  } catch { return ordinary; }
}

export const genreHint = ({ genre, topic }) => `ЖАНР ВИПУСКУ: ${GENRES[genre]}\n${topic ? `ГОЛОВНА ІСТОРІЯ ЖАНРУ: ${topic}\n` : ""}`;
