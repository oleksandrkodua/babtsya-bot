// Poll verdict logic, no Telegram: the Worker imports it, `node poll.js` runs the self-check.

export const QUESTION = "Сьогодні — зрада чи перемога?";
export const OPTIONS = ["Зрада", "Перемога"];

export const TITLES = {
  перемога: "Переможний тиждень (I'm tired of winning)",
  зрада: "Зрадний тиждень (сходіть в Roshen)",
  нічия: "Зраможний тиждень (і вашим, і нашим)",
};

// A tied day, 0:0 included, counts for nobody.
export function dayVerdict({ zrada, peremoga }) {
  return zrada > peremoga ? "зрада" : peremoga > zrada ? "перемога" : null;
}

// days: Mon–Sun results from stopPoll; a day with no poll is simply absent.
export function weekVerdict(days) {
  const won = { зрада: 0, перемога: 0 };
  for (const d of days) {
    const v = dayVerdict(d);
    if (v) won[v]++;
  }
  if (won.зрада + won.перемога === 0) return null; // no verdict days → no weekly post
  let winner = won.зрада > won.перемога ? "зрада" : won.перемога > won.зрада ? "перемога" : null;
  if (!winner) {
    const z = days.reduce((s, d) => s + d.zrada, 0);
    const p = days.reduce((s, d) => s + d.peremoga, 0);
    winner = z > p ? "зрада" : p > z ? "перемога" : "нічия";
  }
  return { winner, title: TITLES[winner], days: won };
}

if (import.meta.main) {
  const { strict: assert } = await import("node:assert");
  const d = (zrada, peremoga) => ({ zrada, peremoga });

  assert.equal(dayVerdict(d(5, 3)), "зрада");
  assert.equal(dayVerdict(d(3, 5)), "перемога");
  assert.equal(dayVerdict(d(4, 4)), null);
  assert.equal(dayVerdict(d(0, 0)), null);

  assert.equal(weekVerdict([d(1, 5), d(2, 6), d(0, 1), d(7, 1), d(4, 4)]).winner, "перемога");
  assert.equal(weekVerdict([d(9, 1), d(0, 2), d(3, 3)]).winner, "зрада"); // 1:1 days, votes 12:6
  assert.equal(weekVerdict([d(3, 1), d(1, 3), d(5, 5)]).winner, "нічия"); // 1:1 days, votes 9:9
  assert.equal(weekVerdict([d(2, 2), d(0, 0)]), null);
  assert.equal(weekVerdict([]), null);

  // Simulated week, as it would look in the group.
  const week = { Пн: d(3, 7), Вт: d(8, 2), Ср: d(0, 0), Чт: d(5, 5), Пт: d(1, 9), Сб: d(6, 4), Нд: d(2, 3) };
  for (const [day, r] of Object.entries(week)) console.log(`${day}: зрада ${r.zrada} — перемога ${r.peremoga} → ${dayVerdict(r) ?? "нічия, не рахується"}`);
  const v = weekVerdict(Object.values(week));
  console.log(`Днів: зрада ${v.days.зрада}, перемога ${v.days.перемога} → ${v.title}`);
  console.log("самоперевірка ок");
}
