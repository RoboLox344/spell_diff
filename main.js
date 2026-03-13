import fs from "fs";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { fileURLToPath } from "url";
import HunspellModule from "./hunspell-1.7.2/hunspell.js";
import nspell from "nspell";

if (!isMainThread) {
    const { words, affPath, dicPath, workerId } = workerData;

    let mod, checker;

    try {
        parentPort.postMessage({ type: "log", workerId, msg: `initializing...` });

        mod = await HunspellModule();
        parentPort.postMessage({ type: "log", workerId, msg: `wasm loaded` });

        const aff = fs.readFileSync(affPath, "utf8");
        const dic = fs.readFileSync(dicPath, "utf8");
        parentPort.postMessage({ type: "log", workerId, msg: `dictionaries read` });

        mod.FS.writeFile("/ru.aff", aff);
        mod.FS.writeFile("/ru.dic", dic);

        const affPtr = mod.allocateUTF8("/ru.aff");
        const dicPtr = mod.allocateUTF8("/ru.dic");
        const handle = mod.ccall("Hunspell_create", "number", ["number", "number"], [affPtr, dicPtr]);
        parentPort.postMessage({ type: "log", workerId, msg: `hunspell created, handle: ${handle}` });

        checker = nspell(aff, dic);
        parentPort.postMessage({ type: "log", workerId, msg: `nspell ready, starting ${words.length} words` });

        function hunspellSpell(word) {
            const ptr = mod.allocateUTF8(word);
            const res = mod.ccall("Hunspell_spell", "number", ["number", "number"], [handle, ptr]);
            mod._free(ptr);
            return res === 1;
        }

        function getSuggestHunspell(word) {
            try {
                const ptr = mod.allocateUTF8(word);
                const listPtrPtr = mod._malloc(4);
                const count = mod.ccall(
                    "Hunspell_suggest",
                    "number",
                    ["number", "number", "number"],
                    [handle, listPtrPtr, ptr]
                );
                mod._free(ptr);

                const results = [];
                if (count > 0) {
                    const listPtr = mod.getValue(listPtrPtr, "i32");
                    for (let i = 0; i < Math.min(count, 5); i++) {
                        const strPtr = mod.getValue(listPtr + i * 4, "i32");
                        results.push(mod.UTF8ToString(strPtr));
                    }
                    mod.ccall("Hunspell_free_list", null, ["number", "number", "number"], [handle, listPtrPtr, count]);
                }
                mod._free(listPtrPtr);
                return results;
            } catch (e) {
                parentPort.postMessage({ type: "error", workerId, msg: `getSuggestHunspell(${word}): ${e.message}` });
                return [];
            }
        }

        const errors = [];
        const suggErrors = [];
        let match = 0;
        let processed = 0;

        for (const word of words) {
            try {
                const h = hunspellSpell(word);
                const n = checker.correct(word);

                if (h === n) {
                    match++;
                } else {
                    errors.push(`${word} | hunspell:${h} | nspell:${n}`);
                }

                if (!h && !n) {
                    // const hs = getSuggestHunspell(word);
                    // const ns = checker.suggest(word).slice(0, 5);
                    // if (JSON.stringify(hs) !== JSON.stringify(ns)) {
                    //     suggErrors.push(`${word}\nhunspell:${hs.join(", ")}\nnspell:${ns.join(", ")}\n`);
                    // }
                }
            } catch (e) {
                parentPort.postMessage({ type: "error", workerId, msg: `word(${word}): ${e.message}` });
            }

            processed++;
            if (processed % 500 === 0) {
                parentPort.postMessage({ type: "progress", workerId, processed, total: words.length });
            }
        }

        parentPort.postMessage({ type: "result", match, errors, suggErrors, count: words.length });

    } catch (e) {
        parentPort.postMessage({ type: "fatal", workerId, msg: e.message });
        process.exit(1);
    }

    process.exit(0);
}

console.log("start");

if (!fs.existsSync("./words/words.txt")) {
    console.error("Input file words/words.txt not found");
    process.exit(1);
}

if (!fs.existsSync("./stat")) {
    fs.mkdirSync("./stat", { recursive: true });
}

const words = fs.readFileSync("./words/words.txt", "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

console.log("words loaded:", words.length);

const CPU_COUNT = (await import("os")).default.cpus().length;
const WORKER_COUNT = Math.max(1, CPU_COUNT - 1);
console.log(`spawning ${WORKER_COUNT} workers for ${words.length} words`);

const chunkSize = Math.ceil(words.length / WORKER_COUNT);
const chunks = Array.from({ length: WORKER_COUNT }, (_, i) =>
    words.slice(i * chunkSize, (i + 1) * chunkSize)
);

const startTime = Date.now();
let totalMatch = 0;
let totalCount = 0;
const allErrors = [];
const allSuggErrors = [];
const progress = new Array(WORKER_COUNT).fill(0);

const thisFile = fileURLToPath(import.meta.url);

const results = await Promise.all(
    chunks.map(
        (chunk, i) =>
            new Promise((resolve, reject) => {
                const worker = new Worker(thisFile, {
                    workerData: {
                        words: chunk,
                        affPath: "./dic/ru_RU.aff",
                        dicPath: "./dic/ru_RU.dic",
                        workerId: i,
                    },
                });

                worker.on("message", (msg) => {
                    if (msg.type === "progress") {
                        progress[msg.workerId] = msg.processed;
                        const total = progress.reduce((a, b) => a + b, 0);
                        const pct = ((total / words.length) * 100).toFixed(1);
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        process.stdout.write(`\r[${elapsed}s] processed: ${total.toLocaleString()} / ${words.length.toLocaleString()} (${pct}%)   `);
                    } else if (msg.type === "log") {
                        console.log(`[worker ${msg.workerId}] ${msg.msg}`);
                    } else if (msg.type === "error") {
                        console.error(`\n[worker ${msg.workerId}] error: ${msg.msg}`);
                    } else if (msg.type === "fatal") {
                        console.error(`\n[worker ${msg.workerId}] FATAL: ${msg.msg}`);
                        reject(new Error(msg.msg));
                    } else if (msg.type === "result") {
                        resolve(msg);
                    }
                });

                worker.on("error", (err) => {
                    console.error(`\n[worker ${i}] uncaught error:`, err.message);
                    reject(err);
                });

                worker.on("exit", (code) => {
                    if (code !== 0) reject(new Error(`Worker ${i} exited with code ${code}`));
                });
            })
    )
);

console.log();

for (const r of results) {
    totalMatch += r.match;
    totalCount += r.count;
    allErrors.push(...r.errors);
    allSuggErrors.push(...r.suggErrors);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`done in ${elapsed}s`);

const percent = ((totalMatch / totalCount) * 100).toFixed(2);

fs.writeFileSync(
    "./stat/procbt_diff.txt",
    `total words: ${totalCount}\nmatch: ${totalMatch}\ndiff: ${totalCount - totalMatch}\nmatch percent: ${percent}%`
);
fs.writeFileSync("./stat/errors.txt", allErrors.join("\n"));
fs.writeFileSync("./stat/sugg_error.txt", allSuggErrors.join("\n"));

const html = `<html>
<head><meta charset="UTF-8"><title>Spellcheck diff</title>
<style>body{font-family:Arial;padding:40px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}</style>
</head>
<body>
<h2>Hunspell vs Nspell (${WORKER_COUNT} workers, ${elapsed}s)</h2>
<table>
<tr><th>Metric</th><th>Value</th></tr>
<tr><td>Total</td><td>${totalCount}</td></tr>
<tr><td>Match</td><td>${totalMatch}</td></tr>
<tr><td>Diff</td><td>${totalCount - totalMatch}</td></tr>
<tr><td>Percent</td><td>${percent}%</td></tr>
<tr><td>Suggest diff</td><td>${allSuggErrors.length}</td></tr>
<tr><td>Time</td><td>${elapsed}s</td></tr>
</table>
</body></html>`;

fs.writeFileSync("./stat/report.html", html);
console.log("done");