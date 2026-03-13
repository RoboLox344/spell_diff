import fs from "fs";
import path from "path";

const sources = [
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ru/ru_50k.txt",
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/ru/ru_50k.txt"
];

async function loadWords() {
    const set = new Set();

    for (const url of sources) {
        const res = await fetch(url);
        const text = await res.text();

        const words = text
            .split("\n")
            .map(line => line.split(" ")[0])
            .map(w => w.trim().toLowerCase())
            .filter(w => /^[а-яё]{3,}$/.test(w));

        for (const w of words) set.add(w);
    }

    return [...set];
}

const letters = "абвгдеёжзийклмнопрстуфхцчшщьыъэюя";

function rand(max) {
    return Math.floor(Math.random() * max);
}

function randLetter() {
    return letters[rand(letters.length)];
}

function typo(word) {
    const i = rand(word.length);

    return [
        word.slice(0, i) + word.slice(i + 1),
        word.slice(0, i) + randLetter() + word.slice(i + 1),
        word.slice(0, i) + randLetter() + word.slice(i),
        i < word.length - 1
            ? word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
            : word
    ];
}

const baseWords = await loadWords();

console.log("loaded words:", baseWords.length);

const result = new Set();

while (result.size < 1_000_000) {
    const word = baseWords[rand(baseWords.length)];

    for (const e of typo(word)) {
        if (e.length > 2) result.add(e);
        if (result.size >= 1_000_000) break;
    }
}

const dir = "./words";
const file = path.join(dir, "words.txt");

if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(file, [...result].join("\n"));

console.log("generated:", result.size);