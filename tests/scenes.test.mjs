import assert from "node:assert/strict";
import { test } from "node:test";
import { playScenes, applySceneEdits, compactScenes } from "../src/scenes.js";

const names = ["TesterA", "TesterB", "TesterC"];
const dialogue = "TesterA: Чайник чекає.\nTesterB: А розетка мовчить.\nTesterA: Вона хоча б не обіцяє.";
const head = "«Чайник»\nДійові особи:\nTesterA — чекає\nTesterB — слухає\n\n";
const tail = "\n\n(Новини: сусіди зітхали.)\n(Також у дворі галасували: TesterC.)\n\nМораль: Обіцянка не гріє.";
const draft = head + "(Сцена 1. Чайник. Розетка мовчить.)\n" + dialogue + "\nTesterB: Отак воно і є." + tail;
const edit = (text, scene = 1) => JSON.stringify({ edits: [{ scene, text }] });

test("editable scenes stop at their last replica and leave global remarks and moral outside", () => {
  const [scene] = playScenes(draft, names);
  assert.equal(scene.lines.length, 4);
  assert.equal(draft.slice(scene.end), tail);
  assert.equal(draft.slice(0, scene.start), head);
});

test("the editor can end on the earlier punchline, preserving the header and the entire tail", () => {
  const result = applySceneEdits(draft, edit(dialogue), names);
  assert.equal(result, head + "(Сцена 1. Чайник. Розетка мовчить.)\n\n" + dialogue + tail);
  assert.doesNotMatch(result, /Отак воно/);
});

test("repeating dialogue can be replaced without changing speakers", () => {
  const replacement = "TesterA: Чайник чекає.\nTesterB: Йому теж нарахують стаж очікування?\nTesterA: Лише пенсію в кіловатах.";
  assert.ok(applySceneEdits(draft, edit(replacement), names).includes(replacement));
});

test("an editor cannot add a speaker even when that member wrote elsewhere in the chat", () => {
  assert.equal(applySceneEdits(draft, edit(dialogue.replace("TesterB:", "TesterC:")), names), draft);
  assert.equal(applySceneEdits(draft, edit(dialogue + "\nInvented: Я тут."), names), draft);
});

test("a tail with numerical facts cannot be silently dropped or changed", () => {
  const factual = draft.replace("Отак воно і є.", "У мене 180 вольт.");
  for (const text of [dialogue, dialogue + "\nTesterB: У мене 165 вольт."])
    assert.equal(applySceneEdits(factual, edit(text), names), factual);
  assert.ok(applySceneEdits(factual, edit("TesterB: У мене 180 вольт.\n" + dialogue), names).includes("180 вольт"));
});

test("invalid, truncated and out-of-scope edits leave the original intact", () => {
  for (const response of ["", "НЕМАЄ", "null", '{"edits":[', '{"edits":[]}', edit(dialogue, 99),
    edit(dialogue + "\nМораль: Інша."), edit("(Сцена 7. Інша.)\n" + dialogue),
    edit(dialogue + "\nTesterA: " + "а".repeat(500)), edit("TesterA: Лише одна репліка.")])
    assert.equal(applySceneEdits(draft, response, names), draft);
});

test("a two-replica scene becomes one remark without losing either line or the next scene", () => {
  const short = "(Сцена 1. Робота. Чекають.)\nTesterA: Клієнт чекає.\nTesterB: Колеги теж.";
  const full = head + short + "\n\n(Сцена 2. Чайник.)\n" + dialogue + tail;
  const result = compactScenes(full, names);
  assert.ok(result.includes("(Робота. Чекають. TesterA: Клієнт чекає. TesterB: Колеги теж.)"));
  assert.ok(result.includes("(Сцена 1. Чайник.)"));
  assert.ok(result.startsWith(head));
  assert.ok(result.endsWith(tail));
  assert.equal(playScenes(result, names).length, 1);
});

test("valid dialogue, names with parentheses, tags, emoji and directions survive the structure check", () => {
  const cast = ["Tester (Nick)", "Frog 🐸 Name"];
  const text = "(Сцена 1. Двір.)\nTester (Nick) (спокійно): Добре.\nFrog 🐸 Name «тег»: Авжеж.\nTester (Nick): Ні.";
  assert.equal(playScenes(text, cast)[0].lines.length, 3);
  assert.equal(compactScenes(text, cast), text);
});

test("a monologue or scene with no dialogue also becomes a remark", () => {
  for (const body of ["TesterA: Раз.\nTesterA: Два.\nTesterA: Три.", "(Усі мовчать.)"]) {
    const result = compactScenes("(Сцена 1. Тиша.)\n" + body + tail, names);
    assert.doesNotMatch(result, /\(Сцена/);
    assert.ok(result.endsWith(tail));
  }
});
